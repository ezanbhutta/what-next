"""Forecasting.

Deliberately simple models. With ~50 days of daily flow history and under one
order per day, anything fancier would be fitting noise — and worse, it would
be unauditable. Every forecast here can be recomputed by hand from numbers
printed in the brief, which is what lets a wrong call be traced to a wrong
assumption rather than to "the model said so".

All forecasts flow through :mod:`xstudioz.ledger`, so their accuracy is
measured and their intervals are recalibrated from realised coverage.
"""

from __future__ import annotations

import datetime as _dt
from typing import Any, Sequence

from . import ledger as L
from .metrics import MetricBundle, moving_average, linear_slope, flow_series
from . import contracts as C


def _damped_rate(series: Sequence[float], window: int = 14, damping: float = 0.5
                 ) -> float:
    """Level plus a damped trend.

    The damping matters: an undamped slope on a 14-day window of sparse counts
    happily forecasts negative orders, or doubles the rate off two good days.
    Halving the trend keeps direction without letting it run away.
    """
    if not series:
        return 0.0
    recent = series[-window:]
    level = sum(recent) / len(recent)
    slope = linear_slope(recent)
    projected = level + damping * slope * (len(recent) / 2)
    return max(0.0, projected)


def make_predictions(bundle: MetricBundle, flow: Sequence[C.DailyFlow],
                     cal: L.Calibration, today: _dt.date,
                     profile: str = "X Studioz") -> list[L.Prediction]:
    """Emit the day's falsifiable forecasts."""
    d = bundle.as_dict()
    preds: list[L.Prediction] = []
    _, org, vv = flow_series(flow, profile)

    # --- 7-day organic order count ---------------------------------------
    org_rate = _damped_rate(org)
    lo, hi = L.poisson_interval(org_rate, 7)
    point = org_rate * 7
    preds.append(L.new_prediction(
        created_on=today, horizon_days=7,
        metric="flow_7d.organic",
        statement=(f"Organic orders over the 7 days to "
                   f"{(today + _dt.timedelta(days=7)):%d %b} will be "
                   f"{point:.1f} (80% CI {lo:.1f}-{hi:.1f})."),
        point=point, lo=lo, hi=hi,
        confidence="medium",
        basis=(f"14d damped organic rate {org_rate:.3f}/day; Poisson spread. "
               f"Health {bundle.health.verdict()} (index {bundle.health.index})."),
        profile=profile))

    # --- 14-day organic health index -------------------------------------
    idx_point = bundle.health.index
    # Under a breach the only lever the engine still recommends is signal
    # repair — review capture, response time, on-time delivery. Forecasting a
    # recovery is therefore a forecast *about those tasks*, and it is stated
    # that way so a miss indicts the tasks rather than a vague "the algorithm".
    if bundle.health.breached:
        idx_point = min(100.0, bundle.health.index + 8)
        basis = ("Breach with the signal-repair tasks in force; if review "
                 "capture, response time and on-time delivery are the binding "
                 "inputs, the index should recover ~8 points in 14 days. If it "
                 "does not, those tasks are not the constraint and the "
                 "diagnosis needs to change.")
        conf = "low"
    else:
        basis = "No breach; index expected to hold near its current level."
        conf = "medium"
    ilo, ihi = L.build_interval(idx_point, "health.index", conf, cal, base_width=0.22)
    preds.append(L.new_prediction(
        created_on=today, horizon_days=14,
        metric="health.index",
        statement=(f"Organic health index in 14 days will be {idx_point:.0f} "
                   f"(80% CI {ilo:.0f}-{ihi:.0f})."),
        point=idx_point, lo=ilo, hi=ihi, confidence=conf, basis=basis,
        profile=profile))

    # --- 7-day total order rate ------------------------------------------
    tot_rate = _damped_rate([o + v for o, v in zip(org, vv)])
    tlo, thi = L.poisson_interval(tot_rate, 7)
    preds.append(L.new_prediction(
        created_on=today, horizon_days=7,
        metric="flow_7d.total_per_day",
        statement=(f"Total orders/day averaged over the next 7 days will be "
                   f"{tot_rate:.2f} (80% CI {tlo/7:.2f}-{thi/7:.2f})."),
        point=tot_rate, lo=tlo / 7, hi=thi / 7, confidence="medium",
        basis=f"14d damped total rate; current 7d actual {d['flow_7d']['total_per_day']}.",
        profile=profile))

    # --- 30-day AOV -------------------------------------------------------
    aov = d["economics"]["aov"]
    alo, ahi = L.build_interval(aov, "economics.aov", "high", cal, base_width=0.12)
    preds.append(L.new_prediction(
        created_on=today, horizon_days=30,
        metric="economics.aov",
        statement=f"Blended AOV in 30 days will be ${aov:.0f} (80% CI ${alo:.0f}-${ahi:.0f}).",
        point=aov, lo=alo, hi=ahi, confidence="high",
        basis=(f"Lifetime AOV across {d['economics']['n_priced']} priced orders. "
               f"Moves only if the upsell programme lands."),
        profile=profile))

    # --- 7-day inquiry conversion ----------------------------------------
    conv = d["funnel"]["conversion"]
    clo, chi = L.build_interval(conv, "funnel.conversion", "high", cal, base_width=0.15)
    preds.append(L.new_prediction(
        created_on=today, horizon_days=7,
        metric="funnel.conversion",
        statement=(f"Inquiry->order conversion in 7 days will be {conv:.1%} "
                   f"(80% CI {clo:.1%}-{chi:.1%})."),
        point=conv, lo=clo, hi=chi, confidence="high",
        basis=f"Lifetime conversion over {d['funnel']['inquiries']} scored inquiries.",
        profile=profile))

    return preds


def revenue_projection(bundle: MetricBundle, dose_rate: float,
                       days: int = 30) -> dict[str, Any]:
    """Project revenue and show the gap to target, decomposed.

    The decomposition is the point: it says whether the gap closes through
    volume or through AOV, which is what decides where the team spends the day.
    """
    d = bundle.as_dict()
    aov = d["economics"]["aov"] or 0.0
    organic_rate = bundle.health.ma7_now
    total_rate = organic_rate + dose_rate
    return {
        "days": days,
        "organic_rate": round(organic_rate, 3),
        "directed_rate": round(dose_rate, 3),
        "total_rate": round(total_rate, 3),
        "projected_orders": round(total_rate * days, 1),
        "aov": round(aov, 2),
        "projected_revenue": round(total_rate * days * aov, 2),
        "note": ("Assumes AOV holds. Volume is capped by organic flow, which "
                 "this engine cannot raise on demand, so the only lever that "
                 "moves this number materially inside 30 days is AOV."),
    }


def gap_analysis(projected_revenue: float, target: float, aov: float,
                 total_rate: float, days: int = 30) -> dict[str, Any]:
    """Split the shortfall into the volume and AOV routes to closing it."""
    gap = target - projected_revenue
    if gap <= 0:
        return {"gap": 0.0, "status": "on_track"}
    orders_needed = gap / aov if aov else 0.0
    aov_needed = (target / (total_rate * days)) if total_rate * days else 0.0
    return {
        "gap": round(gap, 2),
        "status": "behind",
        "route_volume": {
            "extra_orders": round(orders_needed, 1),
            "extra_per_day": round(orders_needed / days, 2),
            "feasible_organically": orders_needed / days < 0.5,
        },
        "route_aov": {
            "required_aov": round(aov_needed, 2),
            "uplift_vs_current": round(aov_needed / aov - 1, 4) if aov else None,
        },
    }
