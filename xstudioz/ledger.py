"""Prediction ledger — the mechanism that makes the system self-improving.

A system that only ever emits advice cannot get better, because nothing it
says is ever wrong in a way it can detect. So every forecast the engine makes
is written down here with:

* a **resolvable metric key** — a path into the daily metric bundle,
* a **point estimate and an 80% interval**,
* a **resolution date**, and
* the **basis** it reasoned from.

On each run the ledger resolves everything now due by reading the actual value
out of that day's metrics, scores it, and folds the result into a calibration
profile. The calibration then widens or narrows future intervals per metric,
so the engine's stated confidence converges on its real hit rate instead of
staying whatever it felt like on day one.

Nothing here is model-driven. Resolution is a lookup and an arithmetic
comparison, which is what makes the score trustworthy.
"""

from __future__ import annotations

import datetime as _dt
import json
import math
import statistics as _st
import uuid
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Iterable, Sequence

# --------------------------------------------------------------------------
# Records
# --------------------------------------------------------------------------

CONFIDENCE_LEVELS = {"low": 0.55, "medium": 0.70, "high": 0.85}


@dataclass
class Prediction:
    id: str
    created_on: str            # ISO date
    resolve_on: str            # ISO date
    metric: str                # dotted path into MetricBundle.as_dict()
    statement: str             # human-readable, falsifiable
    point: float
    lo: float
    hi: float
    confidence: str            # low | medium | high
    basis: str
    horizon_days: int
    profile: str = "X Studioz"
    status: str = "open"       # open | resolved | expired | unresolvable
    actual: float | None = None
    abs_error: float | None = None
    pct_error: float | None = None
    within_interval: bool | None = None
    resolved_on: str | None = None
    note: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def new_prediction(
    *, created_on: _dt.date, horizon_days: int, metric: str, statement: str,
    point: float, lo: float, hi: float, confidence: str, basis: str,
    profile: str = "X Studioz",
) -> Prediction:
    if confidence not in CONFIDENCE_LEVELS:
        raise ValueError(f"confidence must be one of {sorted(CONFIDENCE_LEVELS)}")
    if not (lo <= point <= hi):
        raise ValueError(f"point {point} must lie inside [{lo}, {hi}]")
    return Prediction(
        id=uuid.uuid5(uuid.NAMESPACE_URL,
                      f"{profile}:{created_on}:{metric}:{horizon_days}").hex[:12],
        created_on=created_on.isoformat(),
        resolve_on=(created_on + _dt.timedelta(days=horizon_days)).isoformat(),
        metric=metric, statement=statement, point=float(point),
        lo=float(lo), hi=float(hi), confidence=confidence, basis=basis,
        horizon_days=horizon_days, profile=profile,
    )


# --------------------------------------------------------------------------
# Metric resolution
# --------------------------------------------------------------------------

def resolve_path(bundle: dict[str, Any], path: str) -> float | None:
    """Read a dotted path out of a metric bundle.

    Supports list indexing (``funnel.by_csr.0.conv``) so segment-level
    predictions are resolvable too.
    """
    cur: Any = bundle
    for part in path.split("."):
        if cur is None:
            return None
        if isinstance(cur, list):
            try:
                cur = cur[int(part)]
            except (ValueError, IndexError):
                return None
        elif isinstance(cur, dict):
            if part not in cur:
                return None
            cur = cur[part]
        else:
            return None
    if isinstance(cur, bool):
        return float(cur)
    return float(cur) if isinstance(cur, (int, float)) else None


# --------------------------------------------------------------------------
# Ledger
# --------------------------------------------------------------------------

@dataclass
class Calibration:
    """Per-metric record of how wrong the engine has been."""
    by_metric: dict[str, dict[str, float]] = field(default_factory=dict)
    by_confidence: dict[str, dict[str, float]] = field(default_factory=dict)
    overall_coverage: float | None = None
    n_resolved: int = 0

    def interval_multiplier(self, metric: str, confidence: str) -> float:
        """How much to widen (>1) or narrow (<1) the next interval.

        Driven by realised coverage against the nominal level. Clamped to
        [0.6, 2.5] so one bad streak cannot make the engine useless, and
        returns 1.0 until there is enough history to mean anything.
        """
        rec = self.by_metric.get(metric)
        if not rec or rec.get("n", 0) < 5:
            return 1.0
        target = CONFIDENCE_LEVELS.get(confidence, 0.8)
        coverage = rec.get("coverage", target)
        if coverage >= target:
            # Over-covering: intervals are wider than they need to be.
            return max(0.6, 1.0 - (coverage - target))
        return min(2.5, 1.0 + (target - coverage) * 2.0)

    def bias(self, metric: str) -> float:
        """Mean signed relative error. Positive = the engine over-predicts."""
        return self.by_metric.get(metric, {}).get("bias", 0.0)

    def as_dict(self) -> dict[str, Any]:
        return {
            "by_metric": self.by_metric,
            "by_confidence": self.by_confidence,
            "overall_coverage": self.overall_coverage,
            "n_resolved": self.n_resolved,
        }


class Ledger:
    """Append-only JSONL store of predictions plus derived calibration."""

    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.predictions: list[Prediction] = []
        if self.path.exists():
            for line in self.path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line:
                    self.predictions.append(Prediction(**json.loads(line)))

    # -- persistence -------------------------------------------------------
    def save(self) -> None:
        with self.path.open("w", encoding="utf-8") as fh:
            for p in self.predictions:
                fh.write(json.dumps(p.as_dict(), ensure_ascii=False) + "\n")

    def add(self, pred: Prediction) -> Prediction:
        """Add a prediction, replacing any same-id open one (idempotent reruns)."""
        self.predictions = [p for p in self.predictions
                            if not (p.id == pred.id and p.status == "open")]
        self.predictions.append(pred)
        return pred

    # -- queries -----------------------------------------------------------
    def open_predictions(self) -> list[Prediction]:
        return [p for p in self.predictions if p.status == "open"]

    def due(self, today: _dt.date) -> list[Prediction]:
        return [p for p in self.open_predictions()
                if _dt.date.fromisoformat(p.resolve_on) <= today]

    def resolved(self) -> list[Prediction]:
        return [p for p in self.predictions if p.status == "resolved"]

    # -- resolution --------------------------------------------------------
    def resolve_due(self, today: _dt.date, bundle: dict[str, Any],
                    grace_days: int = 7) -> list[Prediction]:
        """Score every prediction now due against today's actuals.

        A prediction whose metric path no longer resolves is marked
        ``unresolvable`` rather than quietly dropped — a metric key that
        stopped existing is itself a defect worth surfacing.
        """
        scored: list[Prediction] = []
        for p in self.due(today):
            actual = resolve_path(bundle, p.metric)
            if actual is None:
                overdue = (today - _dt.date.fromisoformat(p.resolve_on)).days
                if overdue > grace_days:
                    p.status = "unresolvable"
                    p.resolved_on = today.isoformat()
                    p.note = (f"metric path {p.metric!r} did not resolve within "
                              f"{grace_days}d of due date")
                    scored.append(p)
                continue
            p.actual = actual
            p.abs_error = abs(actual - p.point)
            p.pct_error = ((actual - p.point) / abs(p.point)) if p.point else None
            p.within_interval = p.lo <= actual <= p.hi
            p.status = "resolved"
            p.resolved_on = today.isoformat()
            scored.append(p)
        return scored

    # -- calibration -------------------------------------------------------
    def calibrate(self, min_n: int = 3) -> Calibration:
        cal = Calibration()
        res = self.resolved()
        cal.n_resolved = len(res)
        if not res:
            return cal

        by_m: dict[str, list[Prediction]] = {}
        by_c: dict[str, list[Prediction]] = {}
        for p in res:
            by_m.setdefault(p.metric, []).append(p)
            by_c.setdefault(p.confidence, []).append(p)

        for metric, ps in by_m.items():
            hits = [p for p in ps if p.within_interval]
            errs = [p.pct_error for p in ps if p.pct_error is not None]
            cal.by_metric[metric] = {
                "n": len(ps),
                "coverage": round(len(hits) / len(ps), 4),
                "mape": round(_st.mean([abs(e) for e in errs]), 4) if errs else 0.0,
                "bias": round(_st.mean(errs), 4) if errs else 0.0,
                "enough_data": len(ps) >= min_n,
            }
        for conf, ps in by_c.items():
            hits = [p for p in ps if p.within_interval]
            cal.by_confidence[conf] = {
                "n": len(ps),
                "nominal": CONFIDENCE_LEVELS.get(conf, 0.0),
                "realised": round(len(hits) / len(ps), 4),
            }
        cov = [1 if p.within_interval else 0 for p in res]
        cal.overall_coverage = round(sum(cov) / len(cov), 4)
        return cal

    def scorecard(self) -> dict[str, Any]:
        res = self.resolved()
        unres = [p for p in self.predictions if p.status == "unresolvable"]
        errs = [abs(p.pct_error) for p in res if p.pct_error is not None]
        return {
            "total": len(self.predictions),
            "open": len(self.open_predictions()),
            "resolved": len(res),
            "unresolvable": len(unres),
            "coverage": round(sum(1 for p in res if p.within_interval) / len(res), 4)
            if res else None,
            "mape": round(_st.mean(errs), 4) if errs else None,
            "median_abs_pct_error": round(_st.median(errs), 4) if errs else None,
        }


# --------------------------------------------------------------------------
# Interval construction
# --------------------------------------------------------------------------

def poisson_interval(rate: float, days: int, z: float = 1.28) -> tuple[float, float]:
    """80% interval for a count over ``days`` at ``rate`` per day.

    Order arrivals are counts of independent-ish events, so a Poisson spread
    (sd = sqrt(mean)) is a far better default than a fixed percentage band —
    it correctly widens in relative terms as volume falls, which is exactly
    the regime this profile is in.
    """
    mean = max(rate * days, 0.0)
    sd = math.sqrt(mean) if mean > 0 else 0.0
    return max(0.0, mean - z * sd), mean + z * sd


def build_interval(point: float, metric: str, confidence: str,
                   cal: Calibration, base_width: float = 0.25) -> tuple[float, float]:
    """Symmetric relative interval, widened or narrowed by past calibration."""
    mult = cal.interval_multiplier(metric, confidence)
    width = base_width * mult
    b = cal.bias(metric)
    # Shift the centre against a persistent bias, but only partially — a full
    # correction would chase noise.
    centre = point * (1 - 0.5 * b) if b else point
    return max(0.0, centre * (1 - width)), centre * (1 + width)
