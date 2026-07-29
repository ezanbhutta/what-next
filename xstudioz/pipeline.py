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
from . import dosing, forecast, ingest, ledger as L, metrics, report, selfcheck, tasks


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
            "ingest": self.ingest_stats,
            "validation": self.validation,
            "revenue_projection": self.revenue_projection,
            "gap": self.gap,
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
    write: bool = True,
) -> RunArtifacts:
    config, sources = load_config(root)
    profile_name = config["profile"]["name"]

    # ---- ingest ----------------------------------------------------------
    parts = []
    if orders_text:
        parts.append(ingest.ingest_orders_workbook(orders_text))
    if inquiries_text:
        parts.append(ingest.ingest_inquiries_workbook(inquiries_text))
    if tracker_rows:
        parts.append(ingest.ingest_tracker_rows(list(tracker_rows)))
    data = ingest.merge(*parts) if parts else ingest.IngestResult()

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
        health=metrics.organic_health(
            data.flow, profile_name, today,
            lookback_days=int(obj.get("lookback_days", 14)),
            tolerance=float(obj.get("tolerance", -0.05)),
            max_vvro_share=float(dcfg.get("max_vvro_share", 0.45)),
            vvro_start=vvro_start),
        flow_7d=metrics.flow_window(data.flow, profile_name,
                                    today - _dt.timedelta(days=6), today),
        flow_28d=metrics.flow_window(data.flow, profile_name,
                                     today - _dt.timedelta(days=27), today),
        funnel=metrics.funnel_metrics(data.leads),
        econ=metrics.economics(data.orders),
        gig=gig,
    )

    # ---- dosing ----------------------------------------------------------
    state_path = root / "data" / "state" / "controller.json"
    state = json.loads(state_path.read_text()) if state_path.exists() else {}
    cooldown = (_dt.date.fromisoformat(state["cooldown_until"])
                if state.get("cooldown_until") else None)

    current_vvro = bundle.flow_7d.vvro / 7 if bundle.flow_7d.days else 0.0
    targets = config.get("targets", {}).get("monthly_revenue", {})
    aov = bundle.econ.aov or 137.0
    proj = forecast.revenue_projection(bundle, current_vvro, days=30)
    gap = forecast.gap_analysis(proj["projected_revenue"], float(targets.get("t30", 0)),
                                aov, proj["total_rate"], days=30)

    plan = dosing.decide(
        date=today, profile=profile_name, health=bundle.health,
        current_vvro_per_day=current_vvro, config=config,
        orders_in_queue=gig.get("orders_in_queue"),
        revenue_gap=gap.get("gap") or None,
        cooldown_until=cooldown)

    # Recompute the projection at the *recommended* rate, not the current one.
    proj = forecast.revenue_projection(bundle, plan.target_rate, days=30)
    gap = forecast.gap_analysis(proj["projected_revenue"], float(targets.get("t30", 0)),
                                aov, proj["total_rate"], days=30)

    # ---- ledger ----------------------------------------------------------
    led = L.Ledger(root / "data" / "state" / "predictions.jsonl")
    resolved = led.resolve_due(today, bundle.as_dict())
    cal = led.calibrate()
    preds = forecast.make_predictions(bundle, data.flow, cal, today, profile_name)

    # ---- tasks -----------------------------------------------------------
    missing = sources.get("expected_but_missing", [])
    task_list = tasks.generate(
        bundle=bundle, plan=plan, active=data.active, orders=data.orders,
        violations=vrep.data_issues, automation_errors=data.automation_errors,
        missing_sources=missing, today=today,
        max_tasks=int(config["selfcheck"].get("max_tasks", 12)))

    # ---- self-check ------------------------------------------------------
    dated = [d for d in
             [max((f.date for f in data.flow), default=None),
              max((o.order_date for o in data.orders if o.order_date), default=None)]
             if d]
    latest = max(dated) if dated else None
    crm_window = sum(1 for o in data.orders
                     if o.order_date and today - _dt.timedelta(days=27) <= o.order_date <= today)

    check, task_list, preds = selfcheck.run(
        bundle=bundle, plan=plan, tasks=task_list, predictions=preds,
        config=config, today=today, latest_data=latest,
        unmapped_rate=data.unmapped_rate, unmapped=dict(data.unmapped_columns),
        ledger_orders=bundle.flow_28d.total, crm_orders=crm_window)

    min_score = float(config["selfcheck"].get("min_rubric_score", 70))
    emitted = check.passed(min_score)

    brief = report.render_markdown(
        today=today, bundle=bundle, plan=plan, tasks=task_list,
        predictions=preds, resolved=resolved, ledger=led, check=check,
        config=config, revenue_projection=proj, gap=gap, missing_sources=missing)

    art = RunArtifacts(
        today=today, bundle=bundle, plan=plan, tasks=task_list,
        predictions=preds, resolved=resolved, check=check,
        brief_markdown=brief, ingest_stats=data.stats(),
        validation=vrep.summary(), emitted=emitted,
        revenue_projection=proj, gap=gap)

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
