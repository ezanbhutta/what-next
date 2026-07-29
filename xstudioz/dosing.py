"""VVRO dosing controller.

VVRO = self-placed / inorganic orders. Placing them is the fastest way to move
order count, and the fastest way to wreck the thing that produces order count.
This module decides how many to place tomorrow, at what prices, from which
countries — as a *constrained* controller rather than a growth dial.

The governing rule, from ``config/profile.yml``:

    maximise monthly revenue SUBJECT TO organic order flow recovering.

So the controller never raises the dose while organic flow is breached, no
matter how far behind the revenue target is. Organic flow is the asset; VVRO
is leverage against it.

Two caps bind independently:

``share cap``
    VVRO must stay under ``max_vvro_share`` of total orders. Because the cap
    is on the *share*, the absolute VVRO ceiling is a function of organic
    volume:  ``vvro_max = organic * s / (1 - s)``. Organic falling therefore
    lowers the VVRO ceiling — the leverage shrinks exactly when it is most
    tempting to pull.

``health gate``
    If the organic constraint is breached, the dose is cut by ``step_down``
    and held there through a cooldown, regardless of the share cap.
"""

from __future__ import annotations

import datetime as _dt
import hashlib
from dataclasses import dataclass, field
from typing import Any, Sequence

from .metrics import OrganicHealth

# --------------------------------------------------------------------------
# Deterministic allocation
# --------------------------------------------------------------------------

def largest_remainder(weights: Sequence[float], total: int) -> list[int]:
    """Apportion ``total`` integer units across ``weights``.

    Largest-remainder (Hare quota) so the realised mix tracks the target mix
    even at small daily counts, where naive rounding would send every order to
    the heaviest bucket.
    """
    if total <= 0 or not weights:
        return [0] * len(weights)
    s = sum(weights)
    if s <= 0:
        return [0] * len(weights)
    exact = [w / s * total for w in weights]
    base = [int(x) for x in exact]
    remainder = total - sum(base)
    order = sorted(range(len(weights)), key=lambda i: -(exact[i] - base[i]))
    for i in range(remainder):
        base[order[i % len(order)]] += 1
    return base


def spread_week(quota: int, seed: str) -> list[int]:
    """Spread a weekly VVRO quota across 7 days.

    When the share cap allows less than one order per day, "place 1 every day"
    is the wrong answer — it silently exceeds the cap. The honest instruction
    is a weekly quota placed on specific days, with the rest of the week at
    zero.

    The chosen days rotate week to week (seeded, so still reproducible),
    because a fixed cadence — every Monday, say — is exactly the regularity
    that makes inorganic volume legible from the outside.
    """
    days = [0] * 7
    if quota <= 0:
        return days
    if quota >= 7:
        base, extra = divmod(quota, 7)
        days = [base] * 7
        start = _rotation(seed, 7)
        for i in range(extra):
            days[(start + i) % 7] += 1
        return days
    # Spread `quota` days as evenly as possible around the week.
    start = _rotation(seed, 7)
    picks = {(start + round(i * 7 / quota)) % 7 for i in range(quota)}
    i = 0
    while len(picks) < quota and i < 7:
        picks.add((start + i) % 7)
        i += 1
    for d in picks:
        days[d] = 1
    return days


def _rotation(seed: str, n: int) -> int:
    """Stable pseudo-rotation so allocations vary day to day without RNG.

    Determinism matters: the same date must always produce the same plan, or
    the engine cannot be tested and the team cannot reconcile what it was told
    yesterday.
    """
    if n <= 0:
        return 0
    h = hashlib.sha256(seed.encode()).hexdigest()
    return int(h[:8], 16) % n


# --------------------------------------------------------------------------
# Result types
# --------------------------------------------------------------------------

@dataclass
class BandPlan:
    lo: float
    hi: float
    count: int

    def label(self) -> str:
        return f"${self.lo:.0f}-${self.hi:.0f}"


@dataclass
class DosePlan:
    date: _dt.date
    profile: str
    dose: int                        # orders to place on THIS date
    weekly_quota: int                # orders for the 7 days starting on `date`
    target_rate: float               # continuous per-day rate after all clamps
    previous_dose: float
    action: str                      # cut | hold | raise | freeze
    binding_constraint: str
    reasons: list[str] = field(default_factory=list)
    bands: list[BandPlan] = field(default_factory=list)
    countries: list[tuple[str, int]] = field(default_factory=list)
    ceiling_from_share: float = 0.0
    projected_share: float | None = None
    cooldown_until: _dt.date | None = None
    expected_revenue: float = 0.0
    week_pattern: list[int] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "date": self.date.isoformat(),
            "profile": self.profile,
            "dose": self.dose,
            "weekly_quota": self.weekly_quota,
            "target_rate": round(self.target_rate, 3),
            "previous_dose": round(self.previous_dose, 3),
            "action": self.action,
            "binding_constraint": self.binding_constraint,
            "reasons": self.reasons,
            "bands": [{"range": b.label(), "lo": b.lo, "hi": b.hi, "count": b.count}
                      for b in self.bands],
            "countries": [{"country": c, "count": n} for c, n in self.countries],
            "ceiling_from_share": round(self.ceiling_from_share, 3),
            "projected_share": round(self.projected_share, 4)
            if self.projected_share is not None else None,
            "cooldown_until": self.cooldown_until.isoformat() if self.cooldown_until else None,
            "expected_revenue": round(self.expected_revenue, 2),
            "week_pattern": self.week_pattern,
        }

    def summary_line(self) -> str:
        if self.dose == 0:
            return (f"Place **0 VVRO orders today** — quota is "
                    f"**{self.weekly_quota}/week**, and today is a rest day "
                    f"({self.binding_constraint}).")
        band_txt = ", ".join(f"{b.count}x {b.label()}" for b in self.bands if b.count)
        return (f"Place **{self.dose} VVRO order{'s' if self.dose != 1 else ''} today** "
                f"({band_txt}) — quota **{self.weekly_quota}/week**.")


# --------------------------------------------------------------------------
# Controller
# --------------------------------------------------------------------------

def share_ceiling(organic_per_day: float, max_share: float) -> float:
    """Max VVRO per day that keeps VVRO share at or below ``max_share``.

    From ``v / (o + v) <= s``  =>  ``v <= o * s / (1 - s)``.
    """
    if max_share <= 0:
        return 0.0
    if max_share >= 1:
        return float("inf")
    return organic_per_day * max_share / (1 - max_share)


def decide(
    *,
    date: _dt.date,
    profile: str,
    health: OrganicHealth,
    current_vvro_per_day: float,
    config: dict[str, Any],
    orders_in_queue: int | None = None,
    revenue_gap: float | None = None,
    cooldown_until: _dt.date | None = None,
) -> DosePlan:
    """Decide tomorrow's VVRO dose.

    ``revenue_gap`` is dollars behind the monthly target; it can only ever
    justify raising the dose when every constraint already permits it.
    """
    dcfg = config.get("dosing", {})
    ocfg = config.get("objective", {})
    min_d = int(dcfg.get("min_per_day", 0))
    max_d = int(dcfg.get("max_per_day", 5))
    max_share = float(dcfg.get("max_vvro_share", 0.45))
    step_up = int(dcfg.get("step_up", 1))
    step_down = int(dcfg.get("step_down", 2))
    cooldown_days = int(dcfg.get("cooldown_after_breach_days", 3))

    queue_cap = None
    for c in ocfg.get("subject_to", []):
        if c.get("id") == "queue_capacity":
            queue_cap = c.get("max")

    reasons: list[str] = []
    ceiling = share_ceiling(health.ma7_now, max_share)
    candidate = current_vvro_per_day
    action = "hold"
    binding = "none"

    # -- 1. Health gate. Highest precedence: the constraint is hard. --------
    in_cooldown = cooldown_until is not None and date <= cooldown_until
    if health.breached:
        candidate = max(min_d, current_vvro_per_day - step_down)
        action = "cut"
        binding = "organic_health_breach"
        detail = "; ".join(health.breach_reasons) or "organic constraint breached"
        reasons.append(
            f"Organic constraint breached — {detail}. The objective makes organic "
            f"recovery a hard constraint, so the dose is cut by {step_down}/day and "
            f"revenue upside is ignored until flow recovers.")
        cooldown_until = date + _dt.timedelta(days=cooldown_days)
    elif in_cooldown:
        candidate = min(current_vvro_per_day, max(min_d, current_vvro_per_day))
        action = "hold"
        binding = "cooldown"
        reasons.append(
            f"Post-breach cooldown until {cooldown_until}. Holding the dose flat so the "
            f"organic response to the last cut is observable — raising now would confound "
            f"the measurement.")

    # -- 2. Share cap. Binds even when health is fine. ---------------------
    if candidate > ceiling:
        reasons.append(
            f"VVRO share cap {max_share:.0%} allows only {ceiling:.2f} VVRO/day at the "
            f"current organic rate of {health.ma7_now:.2f}/day "
            f"(v <= o*s/(1-s)). Current pace is {current_vvro_per_day:.2f}/day, "
            f"a {health.vvro_share_7d:.0%} share. Cutting to the cap.")
        candidate = ceiling
        if action != "cut":
            action = "cut"
        binding = "vvro_share_cap" if binding in ("none", "cooldown") else binding

    # -- 3. Queue capacity. Soft, but delivery quality feeds rating. -------
    if queue_cap is not None and orders_in_queue is not None and orders_in_queue >= queue_cap:
        reasons.append(
            f"{orders_in_queue} orders already in queue (soft cap {queue_cap}). Adding "
            f"volume now risks late deliveries, and on-time delivery feeds the same "
            f"success score this whole plan is trying to protect.")
        candidate = min(candidate, min_d)
        action = "freeze"
        binding = "queue_capacity"

    # -- 4. Only now may revenue pressure raise the dose. ------------------
    if (action == "hold" and not health.breached and not in_cooldown
            and revenue_gap is not None and revenue_gap > 0):
        headroom = min(ceiling, float(max_d))
        if candidate < headroom:
            candidate = min(headroom, current_vvro_per_day + step_up)
            action = "raise"
            binding = "revenue_gap"
            reasons.append(
                f"Organic healthy (index {health.index:.0f}/100) and ${revenue_gap:,.0f} "
                f"behind the monthly target, so the dose steps up by {step_up}/day, "
                f"still inside the {max_share:.0%} share cap.")
        else:
            binding = "vvro_share_cap"
            reasons.append(
                f"${revenue_gap:,.0f} behind target, but the dose is already at its "
                f"ceiling. Close the gap through AOV and conversion, not volume.")

    # -- Quantisation ------------------------------------------------------
    # `candidate` is a continuous rate. Rounding it to a whole number of
    # orders per day would overshoot the very cap it was just clamped to:
    # a ceiling of 0.58/day rounds to 1/day, which is a 58% share against a
    # 45% cap. So the rate is converted to a weekly quota and spread across
    # named days, with the rest of the week at zero.
    target_rate = max(float(min_d), min(candidate, float(max_d)))
    weekly_quota = int(round(target_rate * 7))
    # Rounding the weekly quota *up* can breach the very ceiling the rate was
    # clamped to: a 0.818/day ceiling gives round(5.73) = 6, and 6/7 = 0.857.
    # Step down until the realised rate is inside the cap, then restate the
    # rate from the quota so the two can never disagree.
    while weekly_quota > 0 and weekly_quota / 7 > ceiling + 1e-9:
        weekly_quota -= 1
    target_rate = weekly_quota / 7
    week_seed = f"{profile}:{date.isocalendar()[0]}-W{date.isocalendar()[1]}"
    pattern = spread_week(weekly_quota, week_seed)
    dose = pattern[date.weekday()]

    if not reasons:
        reasons.append(
            f"Organic stable ({health.delta_pct:+.1%}) and share "
            f"{health.vvro_share_7d:.0%} within the {max_share:.0%} cap. "
            f"Holding at {weekly_quota}/week.")

    # -- Allocation --------------------------------------------------------
    bands_cfg = dcfg.get("price_bands", [])
    counts = largest_remainder([b.get("weight", 0) for b in bands_cfg], dose)
    if dose and bands_cfg:
        # Rotate which band absorbs the remainder so a small daily dose does
        # not always land in the same price bucket.
        rot = _rotation(f"{profile}:{date.isoformat()}", len(bands_cfg))
        counts = counts[-rot:] + counts[:-rot] if rot else counts
    bands = [BandPlan(float(b["min"]), float(b["max"]), c)
             for b, c in zip(bands_cfg, counts)]

    cmix = dcfg.get("country_mix", {})
    cnames = list(cmix.keys())
    ccounts = largest_remainder([cmix[k] for k in cnames], dose)
    if dose and cnames:
        rot = _rotation(f"{profile}:{date.isoformat()}:c", len(cnames))
        ccounts = ccounts[-rot:] + ccounts[:-rot] if rot else ccounts
    countries = [(c, n) for c, n in zip(cnames, ccounts) if n]

    expected_rev = sum(b.count * (b.lo + b.hi) / 2 for b in bands)
    # Projected share is evaluated at the *sustained* weekly rate, not today's
    # integer count, because the cap is a property of the rate.
    rate = weekly_quota / 7
    denom = health.ma7_now + rate
    projected = (rate / denom) if denom > 0 else None

    return DosePlan(
        date=date, profile=profile, dose=dose,
        weekly_quota=weekly_quota, target_rate=target_rate,
        previous_dose=current_vvro_per_day, action=action,
        binding_constraint=binding, reasons=reasons, bands=bands,
        countries=countries, ceiling_from_share=ceiling,
        projected_share=projected, cooldown_until=cooldown_until,
        expected_revenue=expected_rev, week_pattern=pattern,
    )


def weekly_schedule(plan: DosePlan, config: dict[str, Any], days: int = 7
                    ) -> list[dict[str, Any]]:
    """Expand the weekly quota into named days with price bands.

    The quota is defined per ISO week, so a forward window of ``days`` can
    straddle two weeks and will not generally sum to ``weekly_quota``. Each
    entry therefore carries its ISO week, and the caller gets per-week totals
    so "4/week" can be reconciled against what is actually listed.

    Every entry after today is provisional: the controller re-decides each
    morning from fresh data, so this is a staffing aid, not a commitment.
    """
    bands_cfg = config.get("dosing", {}).get("price_bands", [])
    weights = [b.get("weight", 0) for b in bands_cfg]
    out: list[dict[str, Any]] = []
    for i in range(days):
        d = plan.date + _dt.timedelta(days=i)
        iso_y, iso_w, _ = d.isocalendar()
        seed = f"{plan.profile}:{iso_y}-W{iso_w}"
        pattern = spread_week(plan.weekly_quota, seed)
        n = pattern[d.weekday()]
        counts = largest_remainder(weights, n)
        if n and bands_cfg:
            rot = _rotation(f"{plan.profile}:{d.isoformat()}", len(bands_cfg))
            counts = counts[-rot:] + counts[:-rot] if rot else counts
        out.append({
            "date": d.isoformat(),
            "weekday": d.strftime("%a"),
            "iso_week": f"{iso_y}-W{iso_w:02d}",
            "dose": n,
            "bands": [{"range": f"${b['min']:.0f}-${b['max']:.0f}", "count": c}
                      for b, c in zip(bands_cfg, counts) if c],
            "provisional": i > 0,
        })
    return out


def week_totals(schedule: list[dict[str, Any]]) -> dict[str, int]:
    """Per-ISO-week order counts implied by a schedule window."""
    totals: dict[str, int] = {}
    for e in schedule:
        totals[e["iso_week"]] = totals.get(e["iso_week"], 0) + e["dose"]
    return totals
