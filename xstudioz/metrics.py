"""Metric computation.

Every function here is pure: canonical records in, numbers out. No I/O, no
config lookups, no side effects. That is what makes the metric layer testable
against golden fixtures and what lets the self-check recompute a number two
different ways and compare.
"""

from __future__ import annotations

import datetime as _dt
import math
import statistics as _st
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from typing import Any, Iterable, Sequence

from . import contracts as C

# --------------------------------------------------------------------------
# Small statistics helpers
# --------------------------------------------------------------------------

def mean(xs: Sequence[float]) -> float:
    xs = [x for x in xs if x is not None]
    return _st.mean(xs) if xs else 0.0


def moving_average(series: Sequence[float], window: int) -> list[float]:
    """Trailing moving average; positions before a full window are None-free
    by using the partial window, so short histories still produce a value."""
    out: list[float] = []
    for i in range(len(series)):
        lo = max(0, i - window + 1)
        chunk = series[lo:i + 1]
        out.append(sum(chunk) / len(chunk))
    return out


def linear_slope(ys: Sequence[float]) -> float:
    """Least-squares slope per step. Used for trend direction, not forecasting."""
    n = len(ys)
    if n < 2:
        return 0.0
    xs = list(range(n))
    mx, my = mean(xs), mean(ys)
    denom = sum((x - mx) ** 2 for x in xs)
    if denom == 0:
        return 0.0
    return sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / denom


def wilson_lower_bound(successes: int, n: int, z: float = 1.96) -> float:
    """Conservative lower bound on a rate.

    Used everywhere a rate is compared across people or segments, so that a
    CSR with 3 wins from 4 leads does not outrank one with 40 from 120.
    """
    if n == 0:
        return 0.0
    p = successes / n
    d = 1 + z * z / n
    centre = p + z * z / (2 * n)
    margin = z * math.sqrt((p * (1 - p) + z * z / (4 * n)) / n)
    return max(0.0, (centre - margin) / d)


def two_proportion_z(s1: int, n1: int, s2: int, n2: int) -> float:
    """Z statistic for the difference of two rates. |z| > 1.96 ~ p < 0.05."""
    if n1 == 0 or n2 == 0:
        return 0.0
    p1, p2 = s1 / n1, s2 / n2
    p = (s1 + s2) / (n1 + n2)
    se = math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2))
    return (p1 - p2) / se if se > 0 else 0.0


def pct_change(new: float, old: float) -> float | None:
    if old == 0:
        return None
    return (new - old) / abs(old)


# --------------------------------------------------------------------------
# Flow metrics — the daily Organic/VVRO ledger
# --------------------------------------------------------------------------

@dataclass
class FlowWindow:
    """Order flow for one profile over a contiguous date range."""
    profile: str
    start: _dt.date
    end: _dt.date
    days: int
    organic: float
    vvro: float
    revenue: float

    @property
    def total(self) -> float:
        return self.organic + self.vvro

    @property
    def organic_per_day(self) -> float:
        return self.organic / self.days if self.days else 0.0

    @property
    def vvro_per_day(self) -> float:
        return self.vvro / self.days if self.days else 0.0

    @property
    def total_per_day(self) -> float:
        return self.total / self.days if self.days else 0.0

    @property
    def vvro_share(self) -> float:
        return self.vvro / self.total if self.total else 0.0


def flow_series(rows: Iterable[C.DailyFlow], profile: str
                ) -> tuple[list[_dt.date], list[float], list[float]]:
    """Dense daily series for a profile: every calendar day in range appears,
    zero-filled. Sparse ledgers otherwise make moving averages meaningless."""
    byday: dict[_dt.date, tuple[float, float]] = {}
    for r in rows:
        if r.profile != profile:
            continue
        o, v = byday.get(r.date, (0.0, 0.0))
        byday[r.date] = (o + r.organic_orders, v + r.vvro_orders)
    if not byday:
        return [], [], []
    lo, hi = min(byday), max(byday)
    dates, org, vv = [], [], []
    d = lo
    while d <= hi:
        o, v = byday.get(d, (0.0, 0.0))
        dates.append(d)
        org.append(o)
        vv.append(v)
        d += _dt.timedelta(days=1)
    return dates, org, vv


def flow_window(rows: Iterable[C.DailyFlow], profile: str,
                start: _dt.date, end: _dt.date) -> FlowWindow:
    sel = [r for r in rows if r.profile == profile and start <= r.date <= end]
    days = (end - start).days + 1
    return FlowWindow(
        profile=profile, start=start, end=end, days=max(days, 1),
        organic=sum(r.organic_orders for r in sel),
        vvro=sum(r.vvro_orders for r in sel),
        revenue=sum(r.total_revenue for r in sel),
    )


@dataclass
class OrganicHealth:
    """The constraint metric. Everything the dosing controller does hangs off
    this, so it reports its inputs, not just its verdict."""
    profile: str
    as_of: _dt.date
    ma7_now: float
    ma7_prior: float
    delta_pct: float | None
    slope_14d: float
    vvro_share_7d: float
    total_per_day_7d: float
    breached: bool
    tolerance: float
    index: float = 0.0
    components: dict[str, float] = field(default_factory=dict)
    #: Organic rate before vs after VVRO began. The short 7d-vs-14d window is
    #: responsive but noisy; on sparse counts it can read flat while a real
    #: structural decline is underway. Both are checked, and either can breach.
    structural_delta_pct: float | None = None
    structural_pre: float | None = None
    structural_post: float | None = None
    breach_reasons: list[str] = field(default_factory=list)

    def verdict(self) -> str:
        if self.breached:
            return "BREACH"
        if (self.delta_pct is not None and self.delta_pct < 0) or \
           (self.structural_delta_pct is not None and self.structural_delta_pct < 0):
            return "SOFTENING"
        return "HEALTHY"


def organic_health(rows: Iterable[C.DailyFlow], profile: str, as_of: _dt.date,
                   lookback_days: int = 14, tolerance: float = -0.05,
                   max_vvro_share: float = 0.45,
                   vvro_start: _dt.date | None = None) -> OrganicHealth:
    """Compute the organic-flow constraint.

    Two independent tests, either of which breaches:

    *rolling* — the 7-day moving average of organic orders against the same
    average ``lookback_days`` ago. Responsive, but on counts this sparse
    (< 1 order/day) it can read exactly flat while flow is genuinely eroding.

    *structural* — the organic rate since ``vvro_start`` against the rate
    before it. Slower to react, but it is the test that actually answers
    "is the VVRO programme costing us organic reach?"
    """
    dates, org, vv = flow_series(rows, profile)
    if not dates:
        return OrganicHealth(profile, as_of, 0, 0, None, 0, 0, 0, False, tolerance)

    ma7 = moving_average(org, 7)
    # Index of as_of (or the last day at/before it).
    idx = max((i for i, d in enumerate(dates) if d <= as_of), default=len(dates) - 1)
    prior_idx = max(idx - lookback_days, 0)
    ma7_now, ma7_prior = ma7[idx], ma7[prior_idx]
    delta = pct_change(ma7_now, ma7_prior)

    lo14 = max(0, idx - 13)
    slope = linear_slope(org[lo14:idx + 1])

    lo7 = max(0, idx - 6)
    o7, v7 = sum(org[lo7:idx + 1]), sum(vv[lo7:idx + 1])
    n7 = (idx - lo7) + 1
    share7 = v7 / (o7 + v7) if (o7 + v7) else 0.0

    # --- structural test: organic rate before vs since VVRO began ---------
    s_pre = s_post = s_delta = None
    if vvro_start is None:
        first_vvro = next((d for d, v in zip(dates, vv) if v > 0), None)
        vvro_start = first_vvro
    if vvro_start and dates[0] < vvro_start <= dates[idx]:
        pre_i = [i for i, d in enumerate(dates) if d < vvro_start]
        post_i = [i for i, d in enumerate(dates) if vvro_start <= d <= dates[idx]]
        if pre_i and post_i:
            s_pre = sum(org[i] for i in pre_i) / len(pre_i)
            s_post = sum(org[i] for i in post_i) / len(post_i)
            s_delta = pct_change(s_post, s_pre)

    breach_reasons: list[str] = []
    if delta is not None and delta < tolerance:
        breach_reasons.append(
            f"rolling: 7d MA {delta:+.1%} vs {lookback_days}d ago "
            f"({ma7_prior:.2f} -> {ma7_now:.2f}/day)")
    if s_delta is not None and s_delta < tolerance:
        breach_reasons.append(
            f"structural: organic {s_delta:+.1%} since VVRO began {vvro_start} "
            f"({s_pre:.2f} -> {s_post:.2f}/day)")
    breached = bool(breach_reasons)

    # Composite 0-100 index. Deliberately simple and inspectable; the
    # components are reported so a low score is always explainable.
    worst_trend = min([d for d in (delta, s_delta) if d is not None], default=0.0)
    comp = {
        "trend": max(0.0, min(1.0, 0.5 + worst_trend * 2)),
        "slope": max(0.0, min(1.0, 0.5 + slope * 5)),
        "vvro_dilution": max(0.0, min(1.0, 1 - (share7 / max_vvro_share) * 0.5))
        if max_vvro_share else 1.0,
        "volume": max(0.0, min(1.0, ma7_now / 1.5)),
    }
    weights = {"trend": 0.40, "slope": 0.20, "vvro_dilution": 0.20, "volume": 0.20}
    index = 100 * sum(comp[k] * weights[k] for k in comp)

    return OrganicHealth(
        profile=profile, as_of=as_of, ma7_now=ma7_now, ma7_prior=ma7_prior,
        delta_pct=delta, slope_14d=slope, vvro_share_7d=share7,
        total_per_day_7d=(o7 + v7) / max(n7, 1),
        breached=breached, tolerance=tolerance,
        index=round(index, 1), components={k: round(v, 3) for k, v in comp.items()},
        structural_delta_pct=s_delta, structural_pre=s_pre, structural_post=s_post,
        breach_reasons=breach_reasons,
    )


# --------------------------------------------------------------------------
# Funnel metrics
# --------------------------------------------------------------------------

@dataclass
class SegmentStat:
    key: str
    n: int
    placed: int
    value: float

    @property
    def conv(self) -> float:
        return self.placed / self.n if self.n else 0.0

    @property
    def conv_lb(self) -> float:
        """Wilson lower bound — the number to rank on."""
        return wilson_lower_bound(self.placed, self.n)

    @property
    def value_per_lead(self) -> float:
        return self.value / self.n if self.n else 0.0

    def as_dict(self) -> dict[str, Any]:
        return {
            "key": self.key, "n": self.n, "placed": self.placed,
            "conv": round(self.conv, 4), "conv_lb": round(self.conv_lb, 4),
            "value": round(self.value, 2),
            "value_per_lead": round(self.value_per_lead, 2),
        }


def segment(leads: Iterable[C.Lead], keyfn, min_n: int = 1) -> list[SegmentStat]:
    agg: dict[str, list[float]] = defaultdict(lambda: [0, 0, 0.0])
    for l in leads:
        k = keyfn(l)
        if not k:
            continue
        agg[k][0] += 1
        if l.converted():
            agg[k][1] += 1
            agg[k][2] += (l.quoted or 0.0)
    out = [SegmentStat(k, int(n), int(p), v) for k, (n, p, v) in agg.items() if n >= min_n]
    return sorted(out, key=lambda s: -s.conv_lb)


@dataclass
class FunnelMetrics:
    inquiries: int
    placed: int
    conversion: float
    quoted_mean: float
    quoted_median: float
    pipeline_value: float
    by_csr: list[SegmentStat]
    by_shift: list[SegmentStat]
    by_country: list[SegmentStat]
    by_followup_depth: list[SegmentStat]
    upsell_lift: dict[str, Any]

    def as_dict(self) -> dict[str, Any]:
        return {
            "inquiries": self.inquiries, "placed": self.placed,
            "conversion": round(self.conversion, 4),
            "quoted_mean": round(self.quoted_mean, 2),
            "quoted_median": round(self.quoted_median, 2),
            "pipeline_value": round(self.pipeline_value, 2),
            "by_csr": [s.as_dict() for s in self.by_csr],
            "by_shift": [s.as_dict() for s in self.by_shift],
            "by_country": [s.as_dict() for s in self.by_country],
            "by_followup_depth": [s.as_dict() for s in self.by_followup_depth],
            "upsell_lift": self.upsell_lift,
        }


def funnel_metrics(leads: Sequence[C.Lead], min_segment_n: int = 15) -> FunnelMetrics:
    considered = [l for l in leads if l.status in ("placed", "not_placed")]
    placed = [l for l in considered if l.converted()]
    quotes = [l.quoted for l in placed if l.quoted]

    up_yes = [l for l in leads if l.upsell_attempted is True]
    up_no = [l for l in leads if l.upsell_attempted is False]
    y_s, y_n = sum(1 for l in up_yes if l.converted()), len(up_yes)
    n_s, n_n = sum(1 for l in up_no if l.converted()), len(up_no)
    z = two_proportion_z(y_s, y_n, n_s, n_n)
    upsell_lift = {
        "with_upsell": {"n": y_n, "placed": y_s, "conv": round(y_s / y_n, 4) if y_n else 0},
        "without_upsell": {"n": n_n, "placed": n_s, "conv": round(n_s / n_n, 4) if n_n else 0},
        "relative_lift": round(((y_s / y_n) / (n_s / n_n) - 1), 4) if y_n and n_n and n_s else None,
        "z": round(z, 2),
        "significant": abs(z) > 1.96,
        "caveat": ("Observational, not randomised: CSRs likely attempt upsells on "
                   "warmer leads, so part of this gap is selection, not causation. "
                   "Run the randomised test in playbooks/upsell.md before trusting "
                   "the full effect size."),
    }

    return FunnelMetrics(
        inquiries=len(considered),
        placed=len(placed),
        conversion=len(placed) / len(considered) if considered else 0.0,
        quoted_mean=mean(quotes),
        quoted_median=_st.median(quotes) if quotes else 0.0,
        pipeline_value=sum(quotes),
        by_csr=segment(considered, lambda l: l.csr, min_segment_n),
        by_shift=segment(considered, lambda l: l.shift, min_segment_n),
        by_country=segment(considered, lambda l: l.country, min_segment_n),
        by_followup_depth=segment(considered, lambda l: f"F{l.followup_depth()}", 1),
        upsell_lift=upsell_lift,
    )


# --------------------------------------------------------------------------
# Economics
# --------------------------------------------------------------------------

@dataclass
class Economics:
    n_orders: int
    n_priced: int
    revenue: float
    aov: float
    median: float
    q1: float
    q3: float
    tip_rate: float
    tip_total: float
    upsell_rate: float
    upsell_denominator: int
    review_capture_rate: float
    review_denominator: int
    mean_rating: float | None
    by_type: dict[str, dict[str, float]]
    by_designer: list[dict[str, Any]]
    by_industry: list[dict[str, Any]]

    def as_dict(self) -> dict[str, Any]:
        return {
            "n_orders": self.n_orders, "n_priced": self.n_priced,
            "revenue": round(self.revenue, 2), "aov": round(self.aov, 2),
            "median": round(self.median, 2), "q1": round(self.q1, 2), "q3": round(self.q3, 2),
            "tip_rate": round(self.tip_rate, 4), "tip_total": round(self.tip_total, 2),
            "upsell_rate": round(self.upsell_rate, 4),
            "upsell_denominator": self.upsell_denominator,
            "review_capture_rate": round(self.review_capture_rate, 4),
            "review_denominator": self.review_denominator,
            "mean_rating": round(self.mean_rating, 3) if self.mean_rating else None,
            "by_type": self.by_type,
            "by_designer": self.by_designer,
            "by_industry": self.by_industry,
        }


#: Values that appear in the designer column but are not people. Ranking these
#: as top performers produced a task telling the CEO to route premium briefs to
#: "Provided by Client", which is a placeholder for "the buyer supplied the art".
NON_DESIGNER_VALUES = frozenset({
    "provided by client", "client provided", "no branding", "none", "n/a", "na",
    "not assigned", "unassigned", "tbd", "-", "no designer", "self", "client",
})


def is_real_designer(name: str | None) -> bool:
    return bool(name) and name.strip().lower() not in NON_DESIGNER_VALUES


def economics(orders: Sequence[C.Order], min_designer_n: int = 5) -> Economics:
    priced = [o for o in orders if o.amount and o.amount > 0]
    amounts = sorted(o.amount for o in priced)
    tips = [o.tip for o in orders if o.tip and o.tip > 0]
    # Only orders whose source tab actually had a review column can be
    # "missing a review"; the rest simply never had the field.
    reviewable = [o for o in orders if o.rating_tracked]
    upsellable = [o for o in orders if o.upsell_tracked]
    rated = [o for o in reviewable if o.rating is not None]

    by_type: dict[str, dict[str, float]] = {}
    for t in (C.ORDER_TYPE_ORGANIC, C.ORDER_TYPE_VVRO, C.ORDER_TYPE_UNKNOWN):
        sel = [o for o in priced if o.order_type == t]
        by_type[t] = {
            "n": len(sel),
            "revenue": round(sum(o.amount for o in sel), 2),
            "aov": round(mean([o.amount for o in sel]), 2),
        }

    dagg: dict[str, list[float]] = defaultdict(list)
    for o in priced:
        if is_real_designer(o.logo_designer):
            dagg[o.logo_designer].append(o.amount)
    by_designer = sorted(
        ({"name": k, "n": len(v), "aov": round(mean(v), 2), "revenue": round(sum(v), 2)}
         for k, v in dagg.items() if len(v) >= min_designer_n),
        key=lambda d: -d["aov"])

    iagg: dict[str, list[float]] = defaultdict(list)
    for o in priced:
        if o.industry:
            iagg[o.industry].append(o.amount)
    by_industry = sorted(
        ({"name": k, "n": len(v), "aov": round(mean(v), 2), "revenue": round(sum(v), 2)}
         for k, v in iagg.items()),
        key=lambda d: -d["revenue"])[:20]

    q = _st.quantiles(amounts, n=4) if len(amounts) >= 4 else [0, 0, 0]
    return Economics(
        n_orders=len(orders),
        n_priced=len(priced),
        revenue=sum(amounts),
        aov=mean(amounts),
        median=_st.median(amounts) if amounts else 0.0,
        q1=q[0], q3=q[2],
        tip_rate=len(tips) / len(orders) if orders else 0.0,
        tip_total=sum(tips),
        upsell_rate=(sum(1 for o in upsellable if o.upsell) / len(upsellable)
                     if upsellable else 0.0),
        upsell_denominator=len(upsellable),
        review_capture_rate=len(rated) / len(reviewable) if reviewable else 0.0,
        review_denominator=len(reviewable),
        mean_rating=mean([o.rating for o in rated]) if rated else None,
        by_type=by_type,
        by_designer=by_designer,
        by_industry=by_industry,
    )


# --------------------------------------------------------------------------
# Reach vs conversion
# --------------------------------------------------------------------------

@dataclass
class FunnelDecomposition:
    """Why organic order flow moved.

    Orders decompose multiplicatively:

        orders = impressions x CTR x order_rate

    So a fall in orders has exactly three possible sources, and they need
    opposite responses:

    *impressions down* — a **ranking** problem. The gig is being shown less.
        Fixes are review velocity, on-time delivery, response time, and
        cutting whatever is suppressing the success score.
    *CTR down* — a **listing** problem. People see it and do not click.
        Fixes are thumbnail, title, price point, badge.
    *order_rate down* — a **page or handling** problem. People click and do
        not buy. Fixes are gig copy, packages, response speed, CSR quality.

    Without impressions data all three are indistinguishable, which is why
    the engine nags for this source every single day until it exists.
    """
    have_data: bool
    days: int = 0
    impressions_now: float = 0.0
    impressions_prior: float = 0.0
    ctr_now: float | None = None
    ctr_prior: float | None = None
    order_rate_now: float | None = None
    order_rate_prior: float | None = None
    orders_now: float = 0.0
    orders_prior: float = 0.0
    #: Share of the total log-change in orders attributable to each factor.
    attribution: dict[str, float] = field(default_factory=dict)
    verdict: str = "no_data"
    explanation: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "have_data": self.have_data, "days": self.days,
            "impressions_now": self.impressions_now,
            "impressions_prior": self.impressions_prior,
            "ctr_now": self.ctr_now, "ctr_prior": self.ctr_prior,
            "order_rate_now": self.order_rate_now,
            "order_rate_prior": self.order_rate_prior,
            "orders_now": self.orders_now, "orders_prior": self.orders_prior,
            "attribution": self.attribution,
            "verdict": self.verdict, "explanation": self.explanation,
        }


def decompose_funnel(impressions: Sequence[C.Impression], as_of: _dt.date,
                     window: int = 14) -> FunnelDecomposition:
    """Attribute a change in orders to reach, CTR or closing rate.

    Uses a log decomposition, which is exact for a product: since
    ``log(orders) = log(impr) + log(ctr) + log(rate)``, the change in each
    log term is that factor's additive contribution. Shares are then reported
    against the total absolute movement, so they read as "X% of the swing".
    """
    if not impressions:
        return FunnelDecomposition(
            have_data=False,
            explanation=("No impression data. A fall in organic orders cannot be "
                         "attributed to reach, click-through or closing rate — "
                         "and those three need opposite responses. This is the "
                         "single most valuable missing input."))

    cur_lo = as_of - _dt.timedelta(days=window - 1)
    pri_hi = cur_lo - _dt.timedelta(days=1)
    pri_lo = pri_hi - _dt.timedelta(days=window - 1)

    def agg(lo: _dt.date, hi: _dt.date) -> tuple[float, float, float]:
        sel = [i for i in impressions if lo <= i.date <= hi]
        return (sum(i.impressions for i in sel),
                sum(i.clicks for i in sel),
                sum(i.orders for i in sel))

    i_now, c_now, o_now = agg(cur_lo, as_of)
    i_pri, c_pri, o_pri = agg(pri_lo, pri_hi)

    if not (i_now and i_pri and o_now and o_pri and c_now and c_pri):
        # Distinguish "the sheet has no rows" from "the sheet stops months
        # ago". Both leave the windows empty, but only one is fixed by
        # creating a sheet — the other is fixed by updating it, and saying
        # "no impression data" when 43,000 impressions are sitting in the file
        # would send someone to solve the wrong problem.
        latest = max(i.date for i in impressions)
        gap = (as_of - latest).days
        if gap > window:
            return FunnelDecomposition(
                have_data=True, days=window,
                verdict="stale",
                explanation=(
                    f"Impression data exists but stops at {latest}, {gap} days "
                    f"before today. The last {window * 2} days carry no rows, so "
                    f"the current decline cannot be attributed to reach, "
                    f"click-through or closing rate. Update the impressions sheet "
                    f"to the present and this becomes answerable immediately — "
                    f"the engine already reads it."))
        return FunnelDecomposition(
            have_data=True, days=window,
            impressions_now=i_now, impressions_prior=i_pri,
            orders_now=o_now, orders_prior=o_pri,
            verdict="insufficient",
            explanation=(f"Impression data exists but the two {window}-day windows "
                         f"are not both complete (impressions {i_pri:.0f} -> "
                         f"{i_now:.0f}, orders {o_pri:.0f} -> {o_now:.0f}). "
                         f"Need {window * 2} consecutive days to attribute a change."))

    ctr_now, ctr_pri = c_now / i_now, c_pri / i_pri
    rate_now, rate_pri = o_now / c_now, o_pri / c_pri

    d_impr = math.log(i_now / i_pri)
    d_ctr = math.log(ctr_now / ctr_pri)
    d_rate = math.log(rate_now / rate_pri)
    total_abs = abs(d_impr) + abs(d_ctr) + abs(d_rate)
    attribution = {
        "impressions": round(d_impr / total_abs, 4) if total_abs else 0.0,
        "ctr": round(d_ctr / total_abs, 4) if total_abs else 0.0,
        "order_rate": round(d_rate / total_abs, 4) if total_abs else 0.0,
    }

    dominant = max(attribution, key=lambda k: abs(attribution[k]))
    labels = {
        "impressions": ("reach", "ranking",
                        "review velocity, on-time delivery, response time"),
        "ctr": ("click-through", "listing",
                "thumbnail, title, price point, badge"),
        "order_rate": ("closing rate", "gig page and handling",
                       "gig copy, packages, response speed, CSR quality"),
    }
    what, kind, fixes = labels[dominant]
    direction = "fell" if attribution[dominant] < 0 else "rose"
    orders_change = (o_now - o_pri) / o_pri

    return FunnelDecomposition(
        have_data=True, days=window,
        impressions_now=i_now, impressions_prior=i_pri,
        ctr_now=ctr_now, ctr_prior=ctr_pri,
        order_rate_now=rate_now, order_rate_prior=rate_pri,
        orders_now=o_now, orders_prior=o_pri,
        attribution=attribution, verdict=dominant,
        explanation=(
            f"Orders moved {orders_change:+.1%} over {window} days "
            f"({o_pri:.0f} -> {o_now:.0f}). "
            f"{abs(attribution[dominant]):.0%} of that swing is {what}, which "
            f"{direction}: impressions {i_pri:,.0f} -> {i_now:,.0f}, "
            f"CTR {ctr_pri:.2%} -> {ctr_now:.2%}, "
            f"close rate {rate_pri:.1%} -> {rate_now:.1%}. "
            f"That makes this a {kind} problem — work on {fixes}."))


# --------------------------------------------------------------------------
# Disputes
# --------------------------------------------------------------------------

@dataclass
class DisputeMetrics:
    have_data: bool
    total: int = 0
    open_count: int = 0
    open_exposure: float = 0.0
    refunded_total: float = 0.0
    refund_rate: float | None = None
    mean_days_to_resolve: float | None = None
    by_cause: list[dict[str, Any]] = field(default_factory=list)
    by_type: dict[str, int] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {
            "have_data": self.have_data, "total": self.total,
            "open_count": self.open_count,
            "open_exposure": round(self.open_exposure, 2),
            "refunded_total": round(self.refunded_total, 2),
            "refund_rate": round(self.refund_rate, 4)
            if self.refund_rate is not None else None,
            "mean_days_to_resolve": round(self.mean_days_to_resolve, 1)
            if self.mean_days_to_resolve is not None else None,
            "by_cause": self.by_cause, "by_type": self.by_type,
        }


def dispute_metrics(disputes: Sequence[C.Dispute], total_orders: int,
                    today: _dt.date) -> DisputeMetrics:
    if not disputes:
        return DisputeMetrics(have_data=False)
    open_ = [d for d in disputes if d.is_open()]
    resolved = [d for d in disputes if not d.is_open()]
    durations = [d.days_open(today) for d in resolved]
    durations = [x for x in durations if x is not None]

    causes: dict[str, list[float]] = defaultdict(list)
    for d in disputes:
        causes[d.root_cause].append(d.amount or 0.0)
    by_cause = sorted(
        ({"cause": k, "n": len(v), "value": round(sum(v), 2)}
         for k, v in causes.items()),
        key=lambda x: -x["n"])

    return DisputeMetrics(
        have_data=True,
        total=len(disputes),
        open_count=len(open_),
        open_exposure=sum(d.exposure() for d in open_),
        refunded_total=sum(d.refunded or 0.0 for d in disputes),
        refund_rate=(len(disputes) / total_orders) if total_orders else None,
        mean_days_to_resolve=mean(durations) if durations else None,
        by_cause=by_cause,
        by_type=dict(Counter(d.dispute_type for d in disputes)),
    )


# --------------------------------------------------------------------------
# Gig / public rank signals
# --------------------------------------------------------------------------

def rating_from_histogram(stars: dict[int, int]) -> float:
    total = sum(stars.values())
    if not total:
        return 0.0
    return sum(int(k) * v for k, v in stars.items()) / total


def reviews_to_move_rating(stars: dict[int, int], target: float,
                           new_star: int = 5) -> int | None:
    """How many further ``new_star`` reviews are needed to reach ``target``.

    Returns None when the target is unreachable by adding reviews of that
    grade (i.e. the target already exceeds ``new_star``).
    """
    total = sum(stars.values())
    points = sum(int(k) * v for k, v in stars.items())
    if total and points / total >= target:
        return 0
    if new_star <= target:
        return None
    n = 0
    while n < 100_000:
        n += 1
        if (points + new_star * n) / (total + n) >= target:
            return n
    return None


def rating_damage(stars: dict[int, int], bad_star: int = 1, count: int = 1) -> float:
    """Rating drop from ``count`` further reviews at ``bad_star``.

    This is what makes a single dispute expensive, and it is the number that
    justifies spending money to save a bad order.
    """
    before = rating_from_histogram(stars)
    after_total = sum(stars.values()) + count
    after_points = sum(int(k) * v for k, v in stars.items()) + bad_star * count
    return before - (after_points / after_total)


# --------------------------------------------------------------------------
# Bundle
# --------------------------------------------------------------------------

@dataclass
class MetricBundle:
    as_of: _dt.date
    profile: str
    health: OrganicHealth
    flow_7d: FlowWindow
    flow_28d: FlowWindow
    funnel: FunnelMetrics
    econ: Economics
    gig: dict[str, Any] = field(default_factory=dict)
    decomposition: FunnelDecomposition | None = None
    disputes: DisputeMetrics | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "as_of": self.as_of.isoformat(),
            "profile": self.profile,
            "health": {
                "verdict": self.health.verdict(),
                "index": self.health.index,
                "ma7_now": round(self.health.ma7_now, 3),
                "ma7_prior": round(self.health.ma7_prior, 3),
                "delta_pct": round(self.health.delta_pct, 4) if self.health.delta_pct is not None else None,
                "slope_14d": round(self.health.slope_14d, 4),
                "vvro_share_7d": round(self.health.vvro_share_7d, 4),
                "total_per_day_7d": round(self.health.total_per_day_7d, 3),
                "breached": self.health.breached,
                "components": self.health.components,
            },
            "flow_7d": {
                "organic": self.flow_7d.organic, "vvro": self.flow_7d.vvro,
                "total_per_day": round(self.flow_7d.total_per_day, 3),
                "vvro_share": round(self.flow_7d.vvro_share, 4),
            },
            "flow_28d": {
                "organic": self.flow_28d.organic, "vvro": self.flow_28d.vvro,
                "total_per_day": round(self.flow_28d.total_per_day, 3),
                "vvro_share": round(self.flow_28d.vvro_share, 4),
            },
            "funnel": self.funnel.as_dict(),
            "economics": self.econ.as_dict(),
            "gig": self.gig,
            "decomposition": (self.decomposition.as_dict()
                              if self.decomposition else {"have_data": False}),
            "disputes": (self.disputes.as_dict()
                         if self.disputes else {"have_data": False}),
        }


def compute(orders: Sequence[C.Order], leads: Sequence[C.Lead],
            flow: Sequence[C.DailyFlow], profile: str, as_of: _dt.date,
            lookback_days: int = 14, tolerance: float = -0.05,
            max_vvro_share: float = 0.45,
            gig: dict[str, Any] | None = None) -> MetricBundle:
    return MetricBundle(
        as_of=as_of,
        profile=profile,
        health=organic_health(flow, profile, as_of, lookback_days, tolerance, max_vvro_share),
        flow_7d=flow_window(flow, profile, as_of - _dt.timedelta(days=6), as_of),
        flow_28d=flow_window(flow, profile, as_of - _dt.timedelta(days=27), as_of),
        funnel=funnel_metrics(leads),
        econ=economics(orders),
        gig=gig or {},
    )
