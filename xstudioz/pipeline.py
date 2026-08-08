"""End-to-end daily run.

One function, ``run_daily``, takes raw source text and produces the brief plus
every artefact needed to audit it. It is deliberately pure with respect to the
network: fetching is the caller's job (a Claude Routine, a cron job, or a
test), so the whole pipeline can be replayed offline against saved snapshots.
"""

from __future__ import annotations

import datetime as _dt
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Sequence

import yaml

from . import contracts as C
from . import feeds as _feeds
from . import (dosing, forecast, ingest, ledger as L, metrics, recovery,
               report, phase as _phase, roles as _roles, selfcheck, snapshot,
               tasks)


@dataclass
class RunArtifacts:
    today: _dt.date
    bundle: metrics.MetricBundle
    plan: dosing.DosePlan
    tasks: list[tasks.Task]
    predictions: list[L.Prediction]
    resolved: list[L.Prediction]
    check: selfcheck.SelfCheckReport
    brief_markdown: str
    ingest_stats: dict[str, Any]
    validation: dict[str, Any]
    emitted: bool
    revenue_projection: dict[str, Any] = field(default_factory=dict)
    gap: dict[str, Any] = field(default_factory=dict)
    phase: Any = None
    boards: Any = None
    edge: Any = field(default_factory=list)
    recovery: Any = None
    #: The analysis window in force, so a renderer can state the period every
    #: rate covers instead of leaving it implied.
    window: dict[str, Any] = field(default_factory=dict)
    #: WHERE THE DATA CAME IN AND HOW OLD IT WAS.
    #:
    #: This existed only as a `[snapshot]` line on stderr, which is read by
    #: whoever is watching the terminal and by nobody afterwards. A run on a
    #: three-day-old snapshot therefore produced a brief that was, on the page,
    #: indistinguishable from one built on live data: same layout, same
    #: confidence, same date in the masthead. That is how a scheduled run can
    #: fail every morning for a week without anybody noticing.
    #:
    #: Recorded here it reaches the run JSON, the brief, the dashboard and the
    #: self-check, so the question "is this actually today's data" has an
    #: answer on the page rather than in a log nobody kept.
    intake: dict[str, Any] = field(default_factory=dict)
    #: Every input this system runs on, and whether it is current. See
    #: xstudioz/feeds.py for why stale and unreachable stay distinct.
    feeds: list[dict[str, Any]] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "today": self.today.isoformat(),
            "emitted": self.emitted,
            "metrics": self.bundle.as_dict(),
            "dose_plan": self.plan.as_dict(),
            "tasks": [t.as_dict() for t in self.tasks],
            "predictions": [p.as_dict() for p in self.predictions],
            "resolved": [p.as_dict() for p in self.resolved],
            "selfcheck": self.check.as_dict(),
            "phase": self.phase.as_dict() if self.phase else None,
            "boards": [b.as_dict() for b in (self.boards or [])],
            "edge": self.edge,
            "ingest": self.ingest_stats,
            "validation": self.validation,
            "revenue_projection": self.revenue_projection,
            "gap": self.gap,
            "recovery": self.recovery.as_dict() if self.recovery else None,
            "window": self.window,
            "intake": self.intake,
            "feeds": self.feeds,
        }


def load_config(root: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    profile = yaml.safe_load((root / "config" / "profile.yml").read_text())
    sources = yaml.safe_load((root / "config" / "sources.yml").read_text())
    return profile, sources


def run_daily(
    *,
    root: Path,
    today: _dt.date,
    orders_text: str = "",
    inquiries_text: str = "",
    tracker_rows: Sequence[dict[str, Any]] | None = None,
    gig: dict[str, Any] | None = None,
    snap: "snapshot.Snapshot | None" = None,
    intake: dict[str, Any] | None = None,
    write: bool = True,
) -> RunArtifacts:
    config, sources = load_config(root)
    profile_name = config["profile"]["name"]

    # ---- ingest ----------------------------------------------------------
    # A snapshot is the clean path: real tab names, real headers, no markdown
    # parsing, no connector dependency. The markdown-export path is kept as a
    # fallback so a morning where the endpoint is down still produces a brief.
    # The caller knows which path it chose; the snapshot knows when it was
    # generated. Neither alone is the whole answer, so they are merged and the
    # derived half always wins, because it cannot be stale by accident.
    intake_note: dict[str, Any] = dict(intake or {})
    parts = []
    if snap is not None:
        age_h = None
        try:
            age_h = round(snap.age_hours(), 1)
        except Exception:
            age_h = None
        intake_note.update({
            "path": intake_note.get("path") or "snapshot",
            "generated_at": snap.generated_at.isoformat(),
            "generated_by": snap.generated_by,
            "age_hours": age_h,
            "tables": len(snap.tables),
            "warnings": list(snap.warnings or []),
        })
        parts.append(ingest.ingest_snapshot(snap))
        if snap.gig and not gig:
            gig = dict(snap.gig)
    else:
        # The markdown path cannot tell one profile's tab from another's and the
        # exporter truncates, so a brief built on it is flagged at the source
        # rather than left to look like any other morning.
        intake_note.setdefault("path", "markdown")
        intake_note.setdefault("age_hours", None)
        intake_note.setdefault(
            "caveat",
            "markdown export: tab names are absent so profiles cannot be "
            "separated, and the export truncates. Treat every count as "
            "covering more than this profile.")
        if orders_text:
            parts.append(ingest.ingest_orders_workbook(orders_text))
        if inquiries_text:
            parts.append(ingest.ingest_inquiries_workbook(inquiries_text))
    if tracker_rows:
        parts.append(ingest.ingest_tracker_rows(list(tracker_rows)))
    data = ingest.merge(*parts) if parts else ingest.IngestResult()

    # ---- scope to this profile -------------------------------------------
    # Both workbooks keep one TAB per seller profile. Without this filter the
    # engine pools all eleven and reports portfolio AOV, conversion and review
    # capture as if they were X Studioz's.
    scoped_orders = [o for o in data.orders if o.profile == profile_name]
    scoped_leads = [l for l in data.leads if l.profile == profile_name]
    unattributed = sum(1 for o in data.orders if o.profile is None)
    if scoped_orders:
        data.orders = scoped_orders
        data.leads = scoped_leads
    # If nothing matched, the tab names changed shape. Keep everything rather
    # than emitting an empty brief, and let schema_drift say so.

    # ---- analysis window --------------------------------------------------
    # Rates, trends and averages are measured from config's window start; rows
    # before it belong to a different era and would drag every average toward
    # a period the team is no longer running.
    #
    # `recovery` deliberately keeps the unwindowed rows. Its whole job is to
    # surface money that has been sitting still the longest, so filtering by
    # order date would remove exactly the orders it exists to find. That
    # exemption is declared in config, not assumed here.
    win = config.get("analysis_window") or {}
    win_start = win.get("start")
    if win_start and not isinstance(win_start, _dt.date):
        win_start = _dt.date.fromisoformat(str(win_start))

    def _since(rows, attr):
        if not win_start:
            return list(rows)
        return [r for r in rows
                if getattr(r, attr, None) and getattr(r, attr) >= win_start]

    all_orders, all_leads = data.orders, data.leads
    w_orders = _since(data.orders, "order_date")
    w_leads = _since(data.leads, "date")
    w_impressions = _since(data.impressions, "date")

    # ---- validate --------------------------------------------------------
    vrep = C.ValidationReport()
    vrep.merge(C.validate_orders(data.orders, today))
    vrep.merge(C.validate_leads(data.leads, today))
    vrep.merge(C.validate_flow(data.flow))

    # ---- metrics ---------------------------------------------------------
    obj = config["objective"]["subject_to"][0]
    dcfg = config["dosing"]
    vvro_start = None
    bl = config.get("baseline", {}).get("flow", {})
    if bl.get("vvro_start_date"):
        v = bl["vvro_start_date"]
        vvro_start = v if isinstance(v, _dt.date) else _dt.date.fromisoformat(str(v))

    gig = gig or config.get("baseline", {}).get("gig", {})
    if gig.get("stars") and not gig.get("rating"):
        gig["rating"] = metrics.rating_from_histogram(gig["stars"])

    bundle = metrics.MetricBundle(
        as_of=today,
        profile=profile_name,
        # Unwindowed by design — see analysis_window.exempt.health. The
        # structural test needs the pre-change baseline to compare against,
        # and flow_7d/flow_28d bound themselves by date anyway.
        health=metrics.organic_health(
            data.flow, profile_name, today,
            lookback_days=int(obj.get("lookback_days", 14)),
            tolerance=float(obj.get("tolerance", -0.05)),
            max_vvro_share=float(dcfg.get("max_vvro_share", 0.45)),
            vvro_start=vvro_start),
        flow_7d=metrics.flow_window_to(data.flow, profile_name, 7, today),
        flow_28d=metrics.flow_window_to(data.flow, profile_name, 28, today),
        funnel=metrics.funnel_metrics(
            w_leads,
            min_sample=int((win.get("min_sample") or {}).get("conversion", 0)),
            max_interval_width=float(
                (win.get("max_interval_width") or {}).get("conversion", 0.0))),
        econ=metrics.economics(w_orders),
        gig=gig,
        decomposition=metrics.decompose_funnel(w_impressions, today),
        disputes=metrics.dispute_metrics(data.disputes, len(w_orders), today),
    )

    # ---- recovery --------------------------------------------------------
    # Money already committed or quoted that is not moving. Computed live
    # from the same rows the team maintains, never from config.
    #
    # Note the unwindowed lists: this is the exemption declared in
    # `analysis_window.exempt`. The oldest open order was placed in November
    # and is the most recoverable item on the page, so the window that makes
    # every rate current would, applied here, hide the whole point.
    recov = recovery.compute(all_orders, all_leads, today, profile_name)

    # ---- figures that are unknown, not zero ------------------------------
    #
    # An open order whose Order Amount cell is empty used to print as "$0" on
    # the brief and the dashboard, beside real amounts, in the same typeface.
    # Nothing about it looked wrong and a reader had no way to tell "worth
    # nothing" from "nobody wrote down what it is worth" — and only the second
    # is somebody's job today.
    #
    # It is MISSING everywhere now, and it lands on /errors as a row with a
    # name, because the fix is not in this repo: somebody has to open the sheet
    # and type the number.
    for o in recov.open_book.unpriced:
        vrep.add(
            "warn", "data", "order_amount_missing",
            f"{o.client} — open {o.age_days} days on \"{o.project or 'no project named'}\" "
            f"with an empty Order Amount. Every money figure that includes this "
            f"order is a floor, not a total.",
            ref=f"{o.client}|{o.order_date.isoformat()}")

    # A WINDOW THAT SLID BACKWARDS HAS TO SAY SO.
    #
    # flow_7d and flow_28d anchor on the last day the ledger reports rather
    # than on the run date, so the run and the constraint metric describe the
    # same days instead of two windows one day apart wearing the same label.
    # The price of that is a ledger which stops moving slides the window
    # backwards without changing anything on the page, so the drift is a
    # violation past the one day that is normal.
    lag = bundle.flow_7d.lag_days
    if lag >= 2:
        vrep.add(
            "warn", "flow", "flow_ledger_behind",
            f"The order ledger's newest day is "
            f"{bundle.flow_7d.end.isoformat()}, {lag} days before this run. "
            f"Every flow figure describes the 7 days to "
            f"{bundle.flow_7d.end.isoformat()}, not to {today.isoformat()}. "
            f"One day behind is Fiverr publishing at midday; {lag} is somebody "
            f"having stopped filling the sheet in.",
            ref=f"flow_7d {bundle.flow_7d.start.isoformat()}..{bundle.flow_7d.end.isoformat()}")

    # ---- dosing ----------------------------------------------------------
    state_path = root / "data" / "state" / "controller.json"
    state = json.loads(state_path.read_text()) if state_path.exists() else {}
    cooldown = (_dt.date.fromisoformat(state["cooldown_until"])
                if state.get("cooldown_until") else None)

    current_vvro = bundle.flow_7d.vvro / 7 if bundle.flow_7d.days else 0.0
    # A TARGET THAT IS NOT CONFIGURED IS NOT A TARGET OF ZERO.
    #
    # `config.targets` has no `monthly_revenue` key and never has. This lookup
    # missed, `t30` defaulted to 0, every projection cleared it, and the brief
    # printed "On track against the 30-day target." — against a target nobody
    # had set. It is the most confident sentence on the page and it was the
    # least grounded.
    targets = config.get("targets", {}).get("monthly_revenue", {})
    t30 = targets.get("t30")
    has_target = t30 is not None and float(t30) > 0
    aov = bundle.econ.aov or 137.0
    proj = forecast.revenue_projection(bundle, current_vvro, days=30)
    gap = forecast.gap_analysis(proj["projected_revenue"], float(t30 or 0),
                                aov, proj["total_rate"], days=30)
    if not has_target:
        # Overwrite the verdict rather than leave a computed one standing. The
        # arithmetic is fine; it is the CLAIM that is unsupported.
        gap["status"] = "no_target"
        gap["target"] = None
        vrep.add(
            "warn", "config", "revenue_target_missing",
            "No 30-day revenue target is configured (config/profile.yml, "
            "targets.monthly_revenue.t30), so nothing can say whether the "
            "month is on track. The brief said \"On track against the 30-day "
            "target\" for as long as this has been missing, because a target "
            "of zero is cleared by any revenue at all.",
            ref="config/profile.yml targets.monthly_revenue")

    dosing_on = bool(config.get("dosing", {}).get("enabled", True))
    plan = dosing.decide(
        date=today, profile=profile_name, health=bundle.health,
        current_vvro_per_day=current_vvro, config=config,
        orders_in_queue=gig.get("orders_in_queue"),
        revenue_gap=gap.get("gap") or None,
        cooldown_until=cooldown)

    if not dosing_on:
        plan = dosing.disabled_plan(today, profile_name)
    # Recompute the projection at the *recommended* rate, not the current one.
    #
    # THIS IS THE ONE THAT REACHES THE BRIEF, so the missing-target override has
    # to be applied here too. It was applied only to the first computation
    # above, and this line then overwrote it with a fresh "on_track" — the run
    # JSON kept saying on_track while the violation beside it said no target
    # existed. Two computations of one figure, and the second one wins silently.
    proj = forecast.revenue_projection(bundle, plan.target_rate, days=30)
    gap = forecast.gap_analysis(proj["projected_revenue"], float(t30 or 0),
                                aov, proj["total_rate"], days=30)
    if not has_target:
        gap["status"] = "no_target"
        gap["target"] = None

    # ---- ledger ----------------------------------------------------------
    led = L.Ledger(root / "data" / "state" / "predictions.jsonl")
    resolved = led.resolve_due(today, bundle.as_dict())
    cal = led.calibrate()
    preds = forecast.make_predictions(bundle, data.flow, cal, today, profile_name)

    # ---- tasks -----------------------------------------------------------
    missing = sources.get("expected_but_missing", [])
    task_list = tasks.generate(
        bundle=bundle, plan=plan, active=data.active, orders=data.orders,
        disputes=data.disputes,
        violations=vrep.data_issues, automation_errors=data.automation_errors,
        missing_sources=missing, today=today, config=config, recovery=recov,
        max_tasks=int(config["selfcheck"].get("max_tasks", 12)))

    # ---- phase gate ------------------------------------------------------
    imp_ma = None
    if data.impressions:
        recent = [i for i in data.impressions
                  if today - _dt.timedelta(days=6) <= i.date <= today]
        if recent:
            imp_ma = sum(i.impressions for i in recent) / 7
    if imp_ma is None:
        # No impressions sheet yet. Fall back to whatever the gig capture
        # carries, so the gate reports a real reading rather than "unmeasured"
        # when the number is in fact known.
        imp_ma = gig.get("impressions_7d_ma")
    cancels = sum(1 for d in data.disputes
                  if d.dispute_type == "cancelled"
                  and d.date and (today - d.date).days <= 30)
    state = _phase.evaluate(
        config, today,
        success_score=gig.get("success_score"),
        impressions_7d_ma=imp_ma,
        cancellations_since_phase_start=cancels)

    # ---- self-check ------------------------------------------------------
    dated = [d for d in
             [max((f.date for f in data.flow), default=None),
              max((o.order_date for o in data.orders if o.order_date), default=None)]
             if d]
    if snap is not None:
        dated.append(snap.generated_at.date())
    latest = max(dated) if dated else None
    crm_window = sum(1 for o in data.orders
                     if o.order_date and today - _dt.timedelta(days=27) <= o.order_date <= today)

    check, task_list, preds = selfcheck.run(
        bundle=bundle, plan=plan, tasks=task_list, predictions=preds,
        config=config, today=today, latest_data=latest,
        unmapped_rate=data.unmapped_rate, unmapped=dict(data.unmapped_columns),
        retired_tables=dict(data.retired_tables_skipped),
        retired_rows=dict(data.retired_rows_skipped),
        ledger_orders=bundle.flow_28d.total, crm_orders=crm_window,
        window_rows_before=len(all_orders), window_rows_after=len(w_orders),
        window_start=win_start,
        state=state)

    min_score = float(config["selfcheck"].get("min_rubric_score", 70))
    emitted = check.passed(min_score)

    brief = report.render_markdown(
        today=today, bundle=bundle, plan=plan, tasks=task_list,
        predictions=preds, resolved=resolved, ledger=led, check=check,
        config=config, revenue_projection=proj, gap=gap, missing_sources=missing,
        recovery=recov, intake=intake_note,
        feeds=_feeds.collect(root, intake_note))

    art = RunArtifacts(
        phase=state,
        today=today, bundle=bundle, plan=plan, tasks=task_list,
        predictions=preds, resolved=resolved, check=check,
        brief_markdown=brief, ingest_stats=data.stats(),
        validation=vrep.summary(), emitted=emitted,
        revenue_projection=proj, gap=gap,
        boards=_roles.route(config, task_list), edge=_roles.edge(config),
        recovery=recov,
        intake=intake_note,
        feeds=_feeds.collect(root, intake_note),
        window={"start": win_start.isoformat() if win_start else None,
                "label": win.get("label") or "",
                "orders_in_window": len(w_orders),
                "orders_all_time": len(all_orders),
                "exempt": sorted((win.get("exempt") or {}).keys())})

    # ---- persist ---------------------------------------------------------
    if write:
        for p in preds:
            led.add(p)
        led.save()
        state_path.parent.mkdir(parents=True, exist_ok=True)
        state_path.write_text(json.dumps({
            "cooldown_until": plan.cooldown_until.isoformat() if plan.cooldown_until else None,
            "last_dose": plan.dose,
            "last_weekly_quota": plan.weekly_quota,
            "last_run": today.isoformat(),
        }, indent=2))
        ingest.write_normalized(data, root / "data" / "normalized")
        (root / "data" / "state" / "calibration.json").write_text(
            json.dumps(cal.as_dict(), indent=2))

        rdir = root / "reports"
        rdir.mkdir(parents=True, exist_ok=True)
        (rdir / f"{today.isoformat()}-brief.md").write_text(brief, encoding="utf-8")
        (rdir / f"{today.isoformat()}-run.json").write_text(
            json.dumps(art.as_dict(), indent=2, default=str), encoding="utf-8")
        (rdir / "latest.md").write_text(brief, encoding="utf-8")

    return art
