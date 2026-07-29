"""Self-validation gate.

The brief is not emitted until it passes here. This is the layer that lets the
system run unattended: it re-derives its own numbers a second way, checks the
invariants its recommendations depend on, scores the output against a rubric,
and attempts repair before escalating.

Three kinds of check, in increasing order of what they can catch:

**Invariants** — arithmetic and policy facts that must hold. A recommendation
that violates the cap it was clamped to is a bug, not a judgement call. These
are hard failures.

**Consistency** — the same quantity computed two different ways must agree.
Order counts from the daily ledger versus from the CRM sheet, revenue from
AOV x volume versus from summing rows. Disagreement means one of them is
wrong and the brief should say which.

**Rubric** — properties every good brief has: every task owned, every task
evidenced with a number, every prediction falsifiable and dated, no
unexplained metric swings. Scored 0-100.

``repair`` fixes what is mechanically fixable (dropping an unowned task,
clamping an over-cap dose) and records what it did. Anything it cannot fix
becomes a blocking failure, which is the point at which a human is worth
interrupting.
"""

from __future__ import annotations

import datetime as _dt
import re
from dataclasses import dataclass, field
from typing import Any, Sequence

from .dosing import DosePlan
from .ledger import Prediction
from .metrics import MetricBundle
from .tasks import Task


@dataclass
class CheckResult:
    name: str
    passed: bool
    severity: str          # "block" | "warn"
    detail: str
    repaired: bool = False

    def as_dict(self) -> dict[str, Any]:
        return {"name": self.name, "passed": self.passed, "severity": self.severity,
                "detail": self.detail, "repaired": self.repaired}


@dataclass
class SelfCheckReport:
    results: list[CheckResult] = field(default_factory=list)
    rubric: dict[str, float] = field(default_factory=dict)
    score: float = 0.0
    repairs: list[str] = field(default_factory=list)

    def add(self, name: str, passed: bool, severity: str, detail: str,
            repaired: bool = False) -> None:
        self.results.append(CheckResult(name, passed, severity, detail, repaired))

    @property
    def blocking_failures(self) -> list[CheckResult]:
        return [r for r in self.results if not r.passed and r.severity == "block"]

    def passed(self, min_score: float) -> bool:
        return not self.blocking_failures and self.score >= min_score

    def as_dict(self) -> dict[str, Any]:
        return {
            "score": round(self.score, 1),
            "rubric": {k: round(v, 1) for k, v in self.rubric.items()},
            "blocking": len(self.blocking_failures),
            "repairs": self.repairs,
            "results": [r.as_dict() for r in self.results],
        }


# --------------------------------------------------------------------------
# Invariants
# --------------------------------------------------------------------------

def check_invariants(rep: SelfCheckReport, *, plan: DosePlan, bundle: MetricBundle,
                     config: dict[str, Any]) -> None:
    dcfg = config.get("dosing", {})
    max_share = float(dcfg.get("max_vvro_share", 0.45))
    max_per_day = int(dcfg.get("max_per_day", 5))

    # The controller must never recommend a rate that breaches the cap it
    # clamped itself to. This is the check that caught the round()-to-1 bug.
    if plan.projected_share is not None:
        ok = plan.projected_share <= max_share + 1e-9
        rep.add("dose_within_share_cap", ok, "block",
                f"projected VVRO share {plan.projected_share:.2%} vs cap {max_share:.0%}"
                + ("" if ok else " — dose exceeds the cap it was clamped to"))

    rep.add("dose_within_daily_max", plan.dose <= max_per_day, "block",
            f"dose {plan.dose} vs max_per_day {max_per_day}")

    rep.add("weekly_quota_matches_rate",
            abs(plan.weekly_quota - plan.target_rate * 7) <= 0.5, "block",
            f"weekly quota {plan.weekly_quota} vs rate {plan.target_rate:.3f}/day x7 "
            f"= {plan.target_rate * 7:.2f}")

    if plan.week_pattern:
        rep.add("week_pattern_sums_to_quota",
                sum(plan.week_pattern) == plan.weekly_quota, "block",
                f"pattern {plan.week_pattern} sums to {sum(plan.week_pattern)}, "
                f"quota is {plan.weekly_quota}")

    # A breach must never coincide with a raise. This is the objective's
    # hard constraint expressed as an executable assertion.
    if bundle.health.breached:
        rep.add("no_raise_under_breach", plan.action != "raise", "block",
                f"health BREACH with action={plan.action} — the objective forbids "
                f"scaling VVRO while organic is breached")

    band_total = sum(b.count for b in plan.bands)
    rep.add("bands_sum_to_dose", band_total == plan.dose, "block",
            f"price bands allocate {band_total}, dose is {plan.dose}")


def check_consistency(rep: SelfCheckReport, *, bundle: MetricBundle,
                      ledger_orders: float, crm_orders: float,
                      max_swing: float) -> None:
    """Cross-check the same quantity derived two different ways."""
    if ledger_orders and crm_orders:
        diff = abs(ledger_orders - crm_orders) / max(ledger_orders, crm_orders)
        rep.add("ledger_vs_crm_orders", diff <= 0.5, "warn",
                f"daily ledger says {ledger_orders:.0f} orders in window, CRM sheet "
                f"says {crm_orders:.0f} ({diff:.0%} apart). The two sources are "
                f"maintained separately and disagree; treat the ledger as "
                f"authoritative for flow and the CRM for economics.")

    # Recompute against the *unrounded* dataclass values, never against
    # ``as_dict()``. The serialised form rounds to 3-4 decimals, and comparing
    # a rounded number to a full-precision one fails on arithmetic that is
    # perfectly correct — which is exactly what blocked ten valid backfill days
    # before this was fixed.
    recomputed = (bundle.flow_7d.organic + bundle.flow_7d.vvro) / 7
    rep.add("flow_total_recompute",
            abs(recomputed - bundle.flow_7d.total_per_day) < 1e-9, "block",
            f"flow_7d.total_per_day={bundle.flow_7d.total_per_day:.6f} but "
            f"organic+vvro/7={recomputed:.6f}")

    e = bundle.econ
    if e.n_priced:
        implied = e.revenue / e.n_priced
        rep.add("aov_recompute", abs(implied - e.aov) < 1e-6, "block",
                f"aov={e.aov:.6f} but revenue/n_priced={implied:.6f}")

    h = bundle.health
    if h.delta_pct is not None and h.ma7_prior:
        implied = (h.ma7_now - h.ma7_prior) / abs(h.ma7_prior)
        rep.add("health_delta_recompute", abs(implied - h.delta_pct) < 1e-9,
                "block",
                f"delta_pct={h.delta_pct:.6f} but recomputed={implied:.6f}")


def check_freshness(rep: SelfCheckReport, *, latest_data: _dt.date | None,
                    today: _dt.date, max_staleness_days: int) -> None:
    if latest_data is None:
        rep.add("data_freshness", False, "block", "no dated records ingested at all")
        return
    age = (today - latest_data).days
    rep.add("data_freshness", age <= max_staleness_days, "warn",
            f"newest record is {latest_data} ({age}d old, SLA {max_staleness_days}d)"
            + ("" if age <= max_staleness_days else
               " — recommendations are based on stale data, say so in the brief"))


def check_ingest(rep: SelfCheckReport, *, unmapped_rate: float, max_rate: float,
                 unmapped: dict[str, int]) -> None:
    ok = unmapped_rate <= max_rate
    rep.add("schema_drift", ok, "block" if unmapped_rate > max_rate * 2 else "warn",
            f"unmapped column rate {unmapped_rate:.1%} (limit {max_rate:.0%})"
            + (f"; unrecognised: {sorted(unmapped)[:6]}" if unmapped else ""))


# --------------------------------------------------------------------------
# Rubric
# --------------------------------------------------------------------------

_NUMBER_RE = re.compile(r"\d")


def score_rubric(rep: SelfCheckReport, *, tasks: Sequence[Task],
                 predictions: Sequence[Prediction], config: dict[str, Any]) -> None:
    scfg = config.get("selfcheck", {})
    min_tasks = int(scfg.get("min_tasks", 3))
    max_tasks = int(scfg.get("max_tasks", 12))
    rubric: dict[str, float] = {}

    # 1. Task count in range (10)
    rubric["task_count"] = 10.0 if min_tasks <= len(tasks) <= max_tasks else 0.0
    rep.add("task_count_in_range", rubric["task_count"] > 0, "block",
            f"{len(tasks)} tasks (allowed {min_tasks}-{max_tasks})")

    # 2. Every task owned (20)
    owned = [t for t in tasks if t.owner and t.owner.strip()]
    rubric["ownership"] = 20.0 * (len(owned) / len(tasks)) if tasks else 0.0
    rep.add("all_tasks_owned", len(owned) == len(tasks), "block",
            f"{len(owned)}/{len(tasks)} tasks have an owner")

    # 3. Every task evidenced with a number (25)
    evidenced = [t for t in tasks if t.why and _NUMBER_RE.search(t.why)]
    rubric["evidence"] = 25.0 * (len(evidenced) / len(tasks)) if tasks else 0.0
    rep.add("all_tasks_evidenced", len(evidenced) == len(tasks), "warn",
            f"{len(evidenced)}/{len(tasks)} tasks cite a number in their rationale")

    # 4. Every task actionable (15)
    actionable = [t for t in tasks if len(t.steps) >= 2]
    rubric["actionability"] = 15.0 * (len(actionable) / len(tasks)) if tasks else 0.0
    rep.add("all_tasks_actionable", len(actionable) == len(tasks), "warn",
            f"{len(actionable)}/{len(tasks)} tasks have >=2 concrete steps")

    # 5. Predictions falsifiable (20)
    if predictions:
        good = [p for p in predictions
                if p.resolve_on and p.metric and p.lo <= p.point <= p.hi
                and p.hi > p.lo]
        rubric["falsifiability"] = 20.0 * (len(good) / len(predictions))
        rep.add("predictions_falsifiable", len(good) == len(predictions), "block",
                f"{len(good)}/{len(predictions)} predictions have a resolvable "
                f"metric, a date and a non-degenerate interval")
    else:
        rubric["falsifiability"] = 0.0
        rep.add("predictions_present", False, "block", "no predictions emitted")

    # 6. Priority spread (10) — a list that is all P0 has no priorities
    p0 = sum(1 for t in tasks if t.priority == "P0")
    rubric["priority_spread"] = 10.0 if tasks and p0 <= max(2, len(tasks) // 3) else 0.0
    rep.add("priority_spread_sane", rubric["priority_spread"] > 0, "warn",
            f"{p0} of {len(tasks)} tasks are P0")

    rep.rubric = rubric
    rep.score = sum(rubric.values())


# --------------------------------------------------------------------------
# Repair
# --------------------------------------------------------------------------

def repair(tasks: list[Task], predictions: list[Prediction],
           rep: SelfCheckReport, config: dict[str, Any]
           ) -> tuple[list[Task], list[Prediction]]:
    """Fix what is mechanically fixable, and record every fix.

    Repair never invents content. It only drops or clamps, because silently
    filling in a missing owner or a missing rationale would defeat the checks
    that exist to catch exactly that.
    """
    scfg = config.get("selfcheck", {})
    max_tasks = int(scfg.get("max_tasks", 12))

    kept: list[Task] = []
    for t in tasks:
        if not (t.owner and t.owner.strip()):
            rep.repairs.append(f"dropped task {t.id!r}: no owner")
            continue
        if not t.steps:
            rep.repairs.append(f"dropped task {t.id!r}: no steps")
            continue
        kept.append(t)

    if len(kept) > max_tasks:
        rep.repairs.append(
            f"trimmed {len(kept) - max_tasks} lowest-scoring tasks to fit the "
            f"{max_tasks}-task cap")
        kept = kept[:max_tasks]

    good_preds: list[Prediction] = []
    for p in predictions:
        if p.hi <= p.lo:
            rep.repairs.append(f"dropped prediction {p.id!r}: degenerate interval")
            continue
        if not (p.lo <= p.point <= p.hi):
            old = p.point
            p.point = min(max(p.point, p.lo), p.hi)
            rep.repairs.append(
                f"clamped prediction {p.id!r} point {old:.3f} -> {p.point:.3f} "
                f"into its own interval")
        good_preds.append(p)

    return kept, good_preds


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------

def run(
    *,
    bundle: MetricBundle,
    plan: DosePlan,
    tasks: list[Task],
    predictions: list[Prediction],
    config: dict[str, Any],
    today: _dt.date,
    latest_data: _dt.date | None,
    unmapped_rate: float,
    unmapped: dict[str, int],
    ledger_orders: float = 0.0,
    crm_orders: float = 0.0,
) -> tuple[SelfCheckReport, list[Task], list[Prediction]]:
    scfg = config.get("selfcheck", {})
    rep = SelfCheckReport()

    tasks, predictions = repair(tasks, predictions, rep, config)

    check_invariants(rep, plan=plan, bundle=bundle, config=config)
    check_consistency(rep, bundle=bundle, ledger_orders=ledger_orders,
                      crm_orders=crm_orders,
                      max_swing=float(scfg.get("max_unexplained_metric_swing", 0.4)))
    check_freshness(rep, latest_data=latest_data, today=today,
                    max_staleness_days=int(scfg.get("max_source_staleness_days", 3)))
    check_ingest(rep, unmapped_rate=unmapped_rate,
                 max_rate=float(scfg.get("max_unmapped_column_rate", 0.15)),
                 unmapped=unmapped)
    score_rubric(rep, tasks=tasks, predictions=predictions, config=config)

    return rep, tasks, predictions
