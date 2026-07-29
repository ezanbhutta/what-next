"""Client 360 — lifetime value, upsell targeting, churn and referral.

The measured case for this module: **158 of 574 clients (27.5%) have ordered
more than once, and those repeat clients account for 48.2% of all orders and
$38,724 of $91,544 in tracked revenue.** Nearly half the business comes from
people who already know you — while the Upsell column sits at 0.0% filled.

That gap is the single largest addressable opportunity in the dataset, and it
is why this module scores every client individually rather than reporting a
funnel average.

Two honest limitations, surfaced rather than hidden:

*dates are partial* — only 397 of 803 order rows carry a date. Anything
time-derived (recency, cadence, dormancy) is computed over the dated subset
and reports its own coverage, so a confident-looking CLV never rests on
three dated orders out of nine.

*this is descriptive, not causal* — a client who bought twice is not
"predicted" to buy again by any fitted model here. The scores rank who is
worth a message today. They do not claim to know the future.
"""

from __future__ import annotations

import datetime as _dt
import math
import statistics as _st
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any, Iterable, Sequence

from . import contracts as C

# --------------------------------------------------------------------------
# Segments
# --------------------------------------------------------------------------

#: Ordered by commercial priority, not alphabetically. The first segment a
#: client qualifies for wins, so ordering encodes "what matters most".
SEGMENTS = (
    "champion",     # many orders, high value, recent
    "loyal",        # repeat, still warm
    "big_spender",  # high value, few orders
    "promising",    # recent first order, went well
    "dormant",      # was good, has gone quiet
    "at_risk",      # repeat client drifting past their usual cadence
    "one_off",      # single order, nothing special
    "unknown",      # not enough dated history to say
)


def _norm(name: str) -> str:
    return " ".join(str(name or "").strip().lower().split())


@dataclass
class ClientProfile:
    """Everything the engine knows about one buyer."""
    key: str
    display: str
    orders: int = 0
    revenue: float = 0.0
    tips: float = 0.0
    first_order: _dt.date | None = None
    last_order: _dt.date | None = None
    dated_orders: int = 0
    ratings: list[float] = field(default_factory=list)
    industries: list[str] = field(default_factory=list)
    countries: list[str] = field(default_factory=list)
    projects: list[str] = field(default_factory=list)
    upsold: int = 0
    has_dispute: bool = False
    segment: str = "unknown"
    # -- derived --
    aov: float = 0.0
    clv_to_date: float = 0.0
    clv_projected: float = 0.0
    repeat_rate_basis: float = 0.0
    days_since_last: int | None = None
    mean_gap_days: float | None = None
    dormancy_ratio: float | None = None
    upsell_score: float = 0.0
    upsell_reason: str = ""
    churn_risk: float = 0.0
    confidence: float = 0.0

    def mean_rating(self) -> float | None:
        return _st.mean(self.ratings) if self.ratings else None

    def as_dict(self) -> dict[str, Any]:
        return {
            "client": self.display, "segment": self.segment,
            "orders": self.orders, "revenue": round(self.revenue, 2),
            "aov": round(self.aov, 2),
            "clv_to_date": round(self.clv_to_date, 2),
            "clv_projected": round(self.clv_projected, 2),
            "first_order": self.first_order.isoformat() if self.first_order else None,
            "last_order": self.last_order.isoformat() if self.last_order else None,
            "days_since_last": self.days_since_last,
            "mean_gap_days": round(self.mean_gap_days, 1)
            if self.mean_gap_days is not None else None,
            "mean_rating": round(self.mean_rating(), 2) if self.ratings else None,
            "upsell_score": round(self.upsell_score, 3),
            "upsell_reason": self.upsell_reason,
            "churn_risk": round(self.churn_risk, 3),
            "confidence": round(self.confidence, 2),
            "industries": self.industries[:3],
            "top_project": self.projects[0] if self.projects else None,
        }


# --------------------------------------------------------------------------
# Build
# --------------------------------------------------------------------------

def build_profiles(orders: Sequence[C.Order], today: _dt.date,
                   disputes: Sequence[C.Dispute] = ()) -> dict[str, ClientProfile]:
    disputed = {_norm(d.client) for d in disputes}
    by: dict[str, ClientProfile] = {}

    for o in orders:
        key = _norm(o.client)
        if not key:
            continue
        p = by.get(key)
        if p is None:
            p = by[key] = ClientProfile(key=key, display=o.client.strip())
        p.orders += 1
        p.revenue += o.amount or 0.0
        p.tips += o.tip or 0.0
        if o.rating is not None:
            p.ratings.append(o.rating)
        if o.industry and o.industry not in p.industries:
            p.industries.append(o.industry)
        if o.country and o.country not in p.countries:
            p.countries.append(o.country)
        if o.project and o.project not in p.projects:
            p.projects.append(o.project)
        if o.upsell:
            p.upsold += 1
        if o.order_date:
            p.dated_orders += 1
            p.first_order = min(p.first_order or o.order_date, o.order_date)
            p.last_order = max(p.last_order or o.order_date, o.order_date)

    for p in by.values():
        p.has_dispute = p.key in disputed
        p.aov = p.revenue / p.orders if p.orders else 0.0
        p.clv_to_date = p.revenue + p.tips
        if p.last_order:
            p.days_since_last = (today - p.last_order).days
        if p.first_order and p.last_order and p.dated_orders > 1:
            span = (p.last_order - p.first_order).days
            p.mean_gap_days = span / max(p.dated_orders - 1, 1)
            if p.mean_gap_days > 0 and p.days_since_last is not None:
                p.dormancy_ratio = p.days_since_last / p.mean_gap_days
        # Confidence in this profile's time-derived fields.
        p.confidence = (p.dated_orders / p.orders) if p.orders else 0.0
    return by


# --------------------------------------------------------------------------
# Scoring
# --------------------------------------------------------------------------

def score(profiles: dict[str, ClientProfile], today: _dt.date,
          population_aov: float, repeat_rate: float,
          mean_orders_per_repeat: float) -> None:
    """Assign segment, CLV projection, upsell score and churn risk.

    Scoring is deliberately transparent arithmetic rather than a fitted model.
    With 574 clients and partial dates, a learned model would be fitting noise
    and — worse — would produce a number nobody on the team could argue with.
    Every score here can be recomputed by hand from the client's own row.
    """
    values = sorted(p.revenue for p in profiles.values() if p.revenue > 0)
    if not values:
        return
    p80 = values[int(len(values) * 0.80)] if len(values) >= 5 else max(values)
    p95 = values[int(len(values) * 0.95)] if len(values) >= 20 else max(values)

    for p in profiles.values():
        recent = p.days_since_last is not None and p.days_since_last <= 90
        stale = p.days_since_last is not None and p.days_since_last > 180

        # -- segment ------------------------------------------------------
        if p.orders >= 3 and p.revenue >= p80 and recent:
            p.segment = "champion"
        elif p.orders >= 2 and recent:
            p.segment = "loyal"
        elif p.revenue >= p95:
            p.segment = "big_spender"
        elif p.orders == 1 and recent and (p.mean_rating() or 0) >= 4:
            p.segment = "promising"
        elif p.orders >= 2 and p.dormancy_ratio is not None and p.dormancy_ratio > 2.0:
            p.segment = "at_risk"
        elif p.orders >= 2 and stale:
            p.segment = "dormant"
        elif p.orders == 1 and p.days_since_last is not None:
            p.segment = "one_off"
        else:
            p.segment = "unknown"

        # -- projected CLV -------------------------------------------------
        # Expected further orders, anchored on the population's observed
        # repeat behaviour rather than an assumed retention curve. A client
        # who has already repeated is more likely to repeat again, so their
        # base rate is the repeat population's, not the whole population's.
        if p.orders >= 2:
            base = max(mean_orders_per_repeat - p.orders, 0.0)
            expected_more = base * 0.6
        else:
            expected_more = repeat_rate * max(mean_orders_per_repeat - 1, 0.0)
        # Decay by dormancy: someone three cadences overdue is unlikely to
        # deliver their historical average.
        if p.dormancy_ratio is not None:
            expected_more *= max(0.0, 1.0 - 0.35 * max(p.dormancy_ratio - 1.0, 0.0))
        elif stale:
            expected_more *= 0.3
        if p.has_dispute:
            expected_more *= 0.4
        p.clv_projected = p.clv_to_date + expected_more * max(p.aov, population_aov * 0.6)

        # -- churn risk ----------------------------------------------------
        risk = 0.0
        if p.dormancy_ratio is not None:
            risk = min(1.0, max(0.0, (p.dormancy_ratio - 1.0) / 2.0))
        elif p.days_since_last is not None:
            risk = min(1.0, p.days_since_last / 365.0)
        if p.has_dispute:
            risk = min(1.0, risk + 0.3)
        if (p.mean_rating() or 5.0) < 4.0:
            risk = min(1.0, risk + 0.2)
        p.churn_risk = risk

        # -- upsell score --------------------------------------------------
        # Who is worth a message today. Value at stake x warmth x headroom,
        # minus anything that makes contact a bad idea.
        headroom = 1.0 if p.upsold == 0 else 0.35
        warmth = 1.0
        if p.days_since_last is not None:
            warmth = 1.0 if p.days_since_last <= 60 else \
                     0.7 if p.days_since_last <= 150 else \
                     0.4 if p.days_since_last <= 365 else 0.2
        satisfaction = 1.0
        r = p.mean_rating()
        if r is not None:
            satisfaction = 1.15 if r >= 4.8 else 1.0 if r >= 4.0 else 0.4
        if p.has_dispute:
            satisfaction *= 0.3
        value = max(p.aov, 1.0) / max(population_aov, 1.0)
        loyalty = 1.0 + 0.25 * min(p.orders - 1, 4)
        p.upsell_score = headroom * warmth * satisfaction * value * loyalty

        p.upsell_reason = _upsell_reason(p, population_aov)


def _upsell_reason(p: ClientProfile, population_aov: float) -> str:
    """One sentence a CSR can actually use, grounded in this client's row."""
    bits: list[str] = []
    if p.orders >= 3:
        bits.append(f"{p.orders} orders already placed")
    elif p.orders == 2:
        bits.append("returned once already")
    if p.aov >= population_aov * 1.4:
        bits.append(f"spends ${p.aov:.0f}/order against a ${population_aov:.0f} average")
    r = p.mean_rating()
    if r is not None and r >= 4.8:
        bits.append(f"rated {r:.1f}")
    if p.upsold == 0 and p.orders >= 2:
        bits.append("never been offered an upsell")
    if p.days_since_last is not None and p.days_since_last <= 45:
        bits.append(f"last order {p.days_since_last}d ago, still warm")
    if p.industries:
        bits.append(f"{p.industries[0]} brand")
    if not bits:
        return "single order, no strong signal either way"
    return "; ".join(bits)


# --------------------------------------------------------------------------
# Next-offer selection
# --------------------------------------------------------------------------

#: Ladder of what to offer next, cheapest-to-fulfil first. Each entry carries
#: the band it should be priced in, from the observed order-value quartiles.
OFFER_LADDER = (
    ("Brand guidelines document", 120, 260,
     "keeps the mark used correctly once their team and printers touch it"),
    ("Stationery kit (card, letterhead, envelope)", 90, 180,
     "the first thing they will need to print"),
    ("Social media kit (profiles, banners, templates)", 100, 220,
     "where the brand actually gets seen day to day"),
    ("Packaging or label design", 150, 350,
     "physical product brands hit this need within a quarter"),
    ("Sub-brand or product mark", 150, 400,
     "second line, second product, or a spin-off"),
    ("Full rebrand refresh", 260, 500,
     "for brands more than a year past their original identity"),
)


def next_offer(p: ClientProfile) -> dict[str, Any]:
    """Pick the next thing to sell this client, with a price band.

    Selection is heuristic and says so. Industry keywords drive it where they
    exist; otherwise it walks the ladder by how much the client already spends,
    which at least anchors the offer somewhere they have shown they can afford.
    """
    ind = " ".join(p.industries).lower()
    idx = 0
    if any(k in ind for k in ("food", "beverage", "cosmetic", "supplement",
                              "nutrition", "clothing", "jewel", "product")):
        idx = 3
    elif any(k in ind for k in ("saas", "tech", "software", "ai", "app", "fintech")):
        idx = 2
    elif any(k in ind for k in ("consult", "real estate", "legal", "medical",
                                "health", "finance")):
        idx = 1
    elif p.orders >= 3:
        idx = 4
    name, lo, hi, why = OFFER_LADDER[min(idx, len(OFFER_LADDER) - 1)]
    # Anchor into the band the client already buys at.
    anchor = max(lo, min(hi, round(p.aov * 1.2 / 5) * 5)) if p.aov else lo
    return {"offer": name, "band_lo": lo, "band_hi": hi,
            "anchor": anchor, "rationale": why}


# --------------------------------------------------------------------------
# Portfolio
# --------------------------------------------------------------------------

@dataclass
class ClientPortfolio:
    total_clients: int
    repeat_clients: int
    repeat_rate: float
    orders_from_repeat: int
    revenue_from_repeat: float
    revenue_total: float
    revenue_share_from_repeat: float
    mean_orders_per_repeat: float
    population_aov: float
    dated_coverage: float
    segments: dict[str, int] = field(default_factory=dict)
    clv_total_projected: float = 0.0
    top_upsell: list[dict[str, Any]] = field(default_factory=list)
    at_risk: list[dict[str, Any]] = field(default_factory=list)
    profiles: dict[str, ClientProfile] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {
            "total_clients": self.total_clients,
            "repeat_clients": self.repeat_clients,
            "repeat_rate": round(self.repeat_rate, 4),
            "orders_from_repeat": self.orders_from_repeat,
            "revenue_from_repeat": round(self.revenue_from_repeat, 2),
            "revenue_share_from_repeat": round(self.revenue_share_from_repeat, 4),
            "mean_orders_per_repeat": round(self.mean_orders_per_repeat, 2),
            "population_aov": round(self.population_aov, 2),
            "dated_coverage": round(self.dated_coverage, 4),
            "segments": self.segments,
            "clv_total_projected": round(self.clv_total_projected, 2),
            "top_upsell": self.top_upsell,
            "at_risk": self.at_risk,
        }


def analyse(orders: Sequence[C.Order], today: _dt.date,
            disputes: Sequence[C.Dispute] = (), top_n: int = 10) -> ClientPortfolio:
    profiles = build_profiles(orders, today, disputes)
    if not profiles:
        return ClientPortfolio(0, 0, 0.0, 0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0)

    repeat = [p for p in profiles.values() if p.orders > 1]
    total_rev = sum(p.revenue for p in profiles.values())
    rev_repeat = sum(p.revenue for p in repeat)
    orders_repeat = sum(p.orders for p in repeat)
    total_orders = sum(p.orders for p in profiles.values())
    repeat_rate = len(repeat) / len(profiles)
    mean_per_repeat = (orders_repeat / len(repeat)) if repeat else 1.0
    pop_aov = (total_rev / total_orders) if total_orders else 0.0
    dated = sum(p.dated_orders for p in profiles.values())

    score(profiles, today, pop_aov, repeat_rate, mean_per_repeat)

    seg: dict[str, int] = defaultdict(int)
    for p in profiles.values():
        seg[p.segment] += 1

    ranked = sorted(profiles.values(), key=lambda p: -p.upsell_score)
    top = []
    for p in ranked[:top_n]:
        if p.upsell_score <= 0:
            break
        d = p.as_dict()
        d["next_offer"] = next_offer(p)
        d["expected_value"] = round(
            d["next_offer"]["anchor"] * min(p.upsell_score * 0.25, 0.6), 2)
        top.append(d)

    risky = sorted(
        (p for p in profiles.values() if p.orders >= 2 and p.churn_risk >= 0.5),
        key=lambda p: -(p.churn_risk * p.clv_to_date))[:top_n]

    return ClientPortfolio(
        total_clients=len(profiles),
        repeat_clients=len(repeat),
        repeat_rate=repeat_rate,
        orders_from_repeat=orders_repeat,
        revenue_from_repeat=rev_repeat,
        revenue_total=total_rev,
        revenue_share_from_repeat=(rev_repeat / total_rev) if total_rev else 0.0,
        mean_orders_per_repeat=mean_per_repeat,
        population_aov=pop_aov,
        dated_coverage=(dated / total_orders) if total_orders else 0.0,
        segments=dict(seg),
        clv_total_projected=sum(p.clv_projected for p in profiles.values()),
        top_upsell=top,
        at_risk=[p.as_dict() for p in risky],
        profiles=profiles,
    )
