"""Daily task generation.

Turns metrics into assignable work. Every task carries four things, and the
self-check rejects the brief if any is missing:

``why``
    The evidence, with numbers. Not "improve conversion" but "Evening shift
    converts 22.0% against Morning's 38.5% over n=777".
``owner``
    A named person or role. Unowned tasks do not get done.
``steps``
    What to actually do, concretely enough to hand to a CSR.
``impact``
    Estimated dollars, so the list can be ranked rather than merely listed.

Rules are ordered by expected value, not by category, so the top of the list
is the highest-leverage thing available today regardless of which subsystem
noticed it.
"""

from __future__ import annotations

import datetime as _dt
import re
from dataclasses import dataclass, field
from collections import Counter
from typing import Any, Iterable, Sequence

from . import contracts as C
from .metrics import MetricBundle, rating_damage
from .dosing import DosePlan

# --------------------------------------------------------------------------
# Task model
# --------------------------------------------------------------------------

PRIORITIES = ("P0", "P1", "P2", "P3")

#: Past this many days of silence an order is not stalled, it is finished.
DEAD_AFTER_DAYS = 30


@dataclass
class Task:
    id: str
    title: str
    category: str
    owner: str
    why: str
    steps: list[str]
    impact_usd: float
    confidence: float          # 0-1, how sure the impact estimate is
    effort_hours: float
    priority: str = "P2"
    #: 2 = irreversible or time-critical today, 1 = this week, 0 = anytime.
    #: Expected value alone ranks a large slow-burn improvement above a live
    #: refund threat, which is the wrong call: the improvement is still there
    #: tomorrow and the refund is not.
    urgency: int = 0
    playbook: str | None = None
    refs: list[str] = field(default_factory=list)
    due: str | None = None

    @property
    def score(self) -> float:
        """Expected value per hour of effort."""
        return (self.impact_usd * self.confidence) / max(self.effort_hours, 0.25)

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id, "title": self.title, "category": self.category,
            "owner": self.owner, "why": self.why, "steps": self.steps,
            "impact_usd": round(self.impact_usd, 2), "confidence": self.confidence,
            "effort_hours": self.effort_hours, "priority": self.priority,
            "urgency": self.urgency,
            "playbook": self.playbook, "refs": self.refs, "due": self.due,
            "score": round(self.score, 1),
        }


def _prioritise(tasks: list[Task]) -> list[Task]:
    # Rank on expected value first to assign priority bands...
    tasks.sort(key=lambda t: -t.score)
    for i, t in enumerate(tasks):
        if t.priority == "P0":
            continue
        t.priority = "P0" if i == 0 else "P1" if i < 3 else "P2" if i < 7 else "P3"
    # ...then order within each band by urgency, so time-critical work leads.
    tasks.sort(key=lambda t: (PRIORITIES.index(t.priority), -t.urgency, -t.score))
    return tasks


# --------------------------------------------------------------------------
# Signal detection on free text
# --------------------------------------------------------------------------

_REFUND_RE = re.compile(r"\b(refund|dispute|cancel|charge ?back|money back|report)\b", re.I)
_FRUSTRATION_RE = re.compile(
    r"\b(difficult|hard to please|frustrat|unhappy|angry|not satisfied|"
    r"disappoint|too simple|rejected|unresponsive|went quiet|no reply|stalled)\b", re.I)
_WARM_RE = re.compile(
    r"\b(cooperative|friendly|satisfied|happy|approved|great|constructive|"
    r"long.?term|future project|recommend|returning client)\b", re.I)


def risk_signals(order: C.ActiveOrder) -> dict[str, bool]:
    blob = " ".join(filter(None, [order.buyer_mood, order.handoff_notes,
                                  order.summary, order.latest_sent]))
    return {
        "refund_risk": bool(_REFUND_RE.search(blob)),
        "frustration": bool(_FRUSTRATION_RE.search(blob)),
        "warm": bool(_WARM_RE.search(blob)),
    }


# --------------------------------------------------------------------------
# Rules
# --------------------------------------------------------------------------

def _active_order_rules(active: Sequence[C.ActiveOrder], today: _dt.date,
                        gig: dict[str, Any], aov: float) -> list[Task]:
    tasks: list[Task] = []
    stars = gig.get("stars") or {}

    for o in active:
        sig = risk_signals(o)
        stale = o.days_since_update(today)
        status = (o.status or "").lower()
        ref = o.provenance.ref()

        # -- Refund threat on a live order: the single most expensive event --
        if sig["refund_risk"] and status not in ("dead", "completed", "delivered"):
            damage = rating_damage(stars, bad_star=1, count=1) if stars else 0.0
            # A 1-star review costs far more than the order: it drags the
            # public rating that every future buyer sorts on.
            tasks.append(Task(
                id=f"rescue-{o.order_no}",
                title=f"Rescue at-risk order #{o.order_no} — {o.client}",
                category="dispute_rescue",
                owner="Ezan (escalate to CEO if refund is formally requested)",
                why=(f"Buyer has raised refund/dispute language and the order is "
                     f"{status or 'open'}. A single 1-star review would move the "
                     f"public rating by {damage:.4f} "
                     f"({gig.get('rating', 0):.3f} -> {gig.get('rating', 0) - damage:.3f}) "
                     f"across {gig.get('reviews_total', 0):,} reviews, and that rating "
                     f"is what every future buyer sorts on. The order is worth ~${aov:.0f}; "
                     f"the rating damage is worth far more."),
                steps=[
                    "Read the full order history before replying — do not reintroduce "
                    "any concept the buyer already rejected.",
                    "Reply within 2 hours. Acknowledge the specific frustration in their "
                    "own words; do not defend the work.",
                    "Offer a concrete choice: (a) one senior designer takes a fresh "
                    "direction at no cost, or (b) a clean partial refund and a mutual "
                    "cancellation with no review.",
                    "If they choose (a), name the designer and give a fixed date.",
                    "If they choose (b), process it same day — a fast clean exit is "
                    "cheaper than a slow 1-star.",
                ],
                impact_usd=max(aov * 3, 400),
                confidence=0.7, effort_hours=1.5, priority="P0", urgency=2,
                playbook="playbooks/dispute_rescue.md", refs=[ref],
                due=today.isoformat(),
            ))
            continue

        # -- Long-dead: stop chasing, free the slot --------------------------
        # A "revive" task on a five-month-silent order is not a revival, it is
        # a CSR spending goodwill on a ghost. Past `dead_after_days` the right
        # move is to close the record so the pipeline reflects reality.
        if (status in ("rev sent", "rev_sent", "on hold")
                and stale is not None and stale > DEAD_AFTER_DAYS):
            tasks.append(Task(
                id=f"close-{o.order_no}",
                title=f"Close out order #{o.order_no} — {o.client} ({stale}d silent)",
                category="pipeline_hygiene",
                owner="Assigned CSR",
                why=(f"Status '{o.status}' with no movement for {stale} days — over "
                     f"{DEAD_AFTER_DAYS//30} months. This is not a stalled order, it is "
                     f"an open record that inflates the pipeline and hides the real "
                     f"active count. Chasing it costs goodwill and returns nothing."),
                steps=[
                    "Send one final short message leaving the door open, with no ask.",
                    "Mark the order Dead in the tracker today.",
                    "Do not follow up again. If they return, they return warm.",
                ],
                impact_usd=30, confidence=0.8, effort_hours=0.1,
                playbook="playbooks/order_revival.md", refs=[ref]))
            continue

        # -- Stalled but still live: revision sent, buyer silent -------------
        if (status in ("rev sent", "rev_sent", "on hold")
                and stale is not None and 3 <= stale <= DEAD_AFTER_DAYS):
            tasks.append(Task(
                id=f"revive-{o.order_no}",
                title=f"Revive stalled order #{o.order_no} — {o.client} ({stale}d silent)",
                category="order_revival",
                owner="Assigned CSR",
                why=(f"Status '{o.status}' with no update for {stale} days. In this "
                     f"dataset, orders that go quiet after a revision are the ones that "
                     f"end up Dead — and a Dead order still occupies a delivery slot and "
                     f"produces no review."),
                steps=[
                    "Send a single short message that gives the buyer an easy yes: "
                    "restate the last thing sent in one line, then ask one closed question.",
                    "Do not send a third follow-up. In the inquiry data, third "
                    "follow-ups converted 0 of 19 — they burn CSR time and goodwill.",
                    "If no reply in 48h, move to On Hold and stop chasing.",
                ],
                impact_usd=aov * 0.4, confidence=0.45, effort_hours=0.25, urgency=1,
                playbook="playbooks/order_revival.md", refs=[ref],
            ))

        # -- Approved but not delivered: closest revenue to bank ------------
        if status == "approved":
            tasks.append(Task(
                id=f"deliver-{o.order_no}",
                title=f"Close out approved order #{o.order_no} — {o.client}",
                category="delivery",
                owner="Delivery lead",
                why=("Concept is approved, so the creative risk is gone and the only "
                     "thing between this and banked revenue plus a review is asset "
                     "prep. This is the cheapest revenue on the board."),
                steps=[
                    "Ship the full final package today: vectors, all formats, "
                    "variations, fonts, colour values.",
                    "Deliver via the order (not chat) so it counts toward on-time "
                    "delivery.",
                    "Attach the review request from playbooks/review_capture.md — "
                    "only 12.7% of completed orders currently have a review recorded.",
                ],
                impact_usd=aov * 0.9, confidence=0.8, effort_hours=1.0, urgency=1,
                playbook="playbooks/review_capture.md", refs=[ref],
            ))

        # -- Warm and finished: upsell window --------------------------------
        if sig["warm"] and status in ("approved", "completed", "delivered", "dead"):
            tasks.append(Task(
                id=f"upsell-{o.order_no}",
                title=f"Upsell {o.client} (order #{o.order_no})",
                category="upsell",
                owner="Salman (highest value-per-lead at $53)",
                why=("Buyer left on warm terms, which is the only reliable upsell "
                     "signal in this dataset. Inquiries where an upsell was attempted "
                     "converted 54.3% against 30.8% without. Upsell is recorded on "
                     "0.2% of orders today, so this is close to untouched revenue."),
                steps=[
                    "Lead with what they already have, not with a price.",
                    "Offer the next tier that fits their brand stage: brand guidelines, "
                    "social kit, stationery, or a sub-brand.",
                    "Anchor at the $151-$260 band — it is the top quartile of your "
                    "order book and it lands with buyers who already trust you.",
                    "Log the attempt in the Upsell column either way. The column is "
                    "empty today, which is why this lever cannot be measured.",
                ],
                impact_usd=180, confidence=0.35, effort_hours=0.4,
                playbook="playbooks/upsell.md", refs=[ref],
            ))
    return tasks


def _dosing_rule(plan: DosePlan, health_verdict: str) -> Task:
    breach = plan.binding_constraint == "organic_health_breach"
    return Task(
        id=f"vvro-{plan.date.isoformat()}",
        title=(f"VVRO: {plan.weekly_quota}/week "
               f"({plan.dose} today) — {plan.action.upper()}"),
        category="vvro_dosing",
        owner="CEO / order placement",
        why=(" ".join(plan.reasons) + " "
             + f"Quota {plan.weekly_quota}/week ({plan.target_rate:.2f}/day); "
               f"share cap allows {plan.ceiling_from_share:.2f}/day.").strip(),
        steps=[
            plan.summary_line(),
            ("Countries to spread across: "
             + ", ".join(f"{c} x{n}" for c, n in plan.countries)) if plan.countries
            else "No placements today.",
            (f"At this quota the VVRO share settles at {plan.projected_share:.0%}, "
             f"against a cap of {plan.ceiling_from_share:.2f} VVRO/day at the "
             f"current organic rate.")
            if plan.projected_share is not None else "",
            "Do not place on a fixed weekday pattern — the schedule rotates weekly "
            "for a reason.",
            "Log every placement in the daily ledger with its real amount. Revenue "
            "columns are currently all zero, which blinds the whole controller.",
        ],
        impact_usd=plan.expected_revenue * 7,
        confidence=0.6 if not breach else 0.8,
        effort_hours=0.5,
        priority="P0" if breach else "P1",
        urgency=1,
        playbook="playbooks/vvro_dosing.md",
    )


def _funnel_rules(bundle: MetricBundle) -> list[Task]:
    tasks: list[Task] = []
    f = bundle.funnel
    aov = bundle.econ.aov or 137.0

    # -- Shift reallocation ------------------------------------------------
    shifts = {s.key: s for s in f.by_shift}
    morning, evening = shifts.get("Morning"), shifts.get("Evening")
    if morning and evening and morning.n >= 30 and evening.n >= 30:
        delta = morning.conv - evening.conv
        if delta > 0.08:
            recoverable = evening.n * delta
            tasks.append(Task(
                id="shift-realloc",
                title="Move CSR coverage toward the Morning shift",
                category="staffing",
                owner="CEO",
                why=(f"Morning converts {morning.conv:.1%} (n={morning.n}) against "
                     f"Evening's {evening.conv:.1%} (n={evening.n}). At equal lead "
                     f"volume that gap is worth ~{recoverable:.0f} extra orders "
                     f"(~${recoverable * aov:,.0f}) across the Evening book."),
                steps=[
                    "Move your strongest closer onto Morning, where the leads actually "
                    "convert.",
                    "Check whether Evening's gap is lead quality or handling: compare "
                    "country mix between shifts before reassigning blame.",
                    "If Evening leads are structurally worse, cut Evening staffing "
                    "rather than trying to fix conversion.",
                ],
                impact_usd=recoverable * aov * 0.25,
                confidence=0.55, effort_hours=2.0,
                playbook="playbooks/staffing.md"))

    # -- Country triage ----------------------------------------------------
    good = [s for s in f.by_country if s.n >= 20 and s.conv_lb > 0.30]
    poor = [s for s in f.by_country if s.n >= 20 and s.conv < 0.15]
    if good and poor:
        wasted = sum(s.n for s in poor)
        tasks.append(Task(
            id="lead-triage",
            title="Triage inbound leads by country before spending CSR time",
            category="funnel",
            owner="All CSRs",
            why=(f"{', '.join(s.key for s in good[:4])} convert at "
                 f"{', '.join(f'{s.conv:.0%}' for s in good[:4])}. "
                 f"{', '.join(s.key for s in poor[:3])} convert at "
                 f"{', '.join(f'{s.conv:.0%}' for s in poor[:3])} across "
                 f"{wasted} leads. Equal effort on both is the single largest "
                 f"misallocation of CSR hours in the data."),
            steps=[
                "Tier 1 (full custom quote + meeting offer): "
                + ", ".join(s.key for s in good[:5]),
                "Tier 2 (standard reply, one follow-up max): everyone else.",
                "Tier 3 (template reply, no follow-up): "
                + ", ".join(s.key for s in poor[:4]),
                "Never spend a meeting slot on a Tier 3 lead.",
            ],
            impact_usd=wasted * 0.10 * aov,
            confidence=0.6, effort_hours=1.0,
            playbook="playbooks/lead_triage.md"))

    # -- Follow-up discipline ----------------------------------------------
    # The inquiry sheet shows third follow-ups converting 0 of 19, and an
    # earlier version of this rule told the team to stop doing them. The
    # operating model then established that the FollowUp columns were never
    # filled in any row — so those 19 are a record-keeping artifact, not a
    # measured cohort. The rule now says the opposite: run the ladder properly,
    # then let the engine measure it for real.
    depths = {s.key: s for s in f.by_followup_depth}
    logged = sum(s.n for k, s in depths.items() if k != "F0")
    total = sum(s.n for s in depths.values())
    if total and logged / total < 0.10:
        tasks.append(Task(
            id="followup-engine",
            title="Turn the follow-up engine on — the columns have never been used",
            category="funnel",
            owner="All CSRs (compliance owned by Hasnain)",
            why=(f"Only {logged} of {total} logged inquiries carry any follow-up at "
                 f"all ({logged / total:.1%}). 'Waiting response' is the most common "
                 f"note in the log, which in the current process means the "
                 f"conversation ended there. $5,472 of quoted work sits behind it."),
            steps=[
                "No inquiry may be closed as Not Placed until FollowUp 1, 2 and 3 "
                "carry dates. A lead closed without three touches gets reopened "
                "and reassigned.",
                "Follow-up 2 uses a different angle — address the likely objection, "
                "do not repeat the offer.",
                "Follow-up 3 is the final touch; only then may the lead be closed, "
                "with a reason code.",
                "Do not act on the old '0 of 19 third follow-ups' figure. It "
                "measured empty columns, not failed follow-ups.",
            ],
            impact_usd=820, confidence=0.6, effort_hours=1.0, urgency=1,
            playbook="playbooks/dead_pipeline.md"))

    # -- Upsell programme --------------------------------------------------
    up = f.upsell_lift
    if up.get("relative_lift") and up.get("significant"):
        tasks.append(Task(
            id="upsell-program",
            title="Run the upsell A/B test to de-bias the 54% vs 31% gap",
            category="experiment",
            owner="CEO + Salman",
            why=(f"Leads with an upsell attempt convert "
                 f"{up['with_upsell']['conv']:.1%} (n={up['with_upsell']['n']}) "
                 f"against {up['without_upsell']['conv']:.1%} "
                 f"(n={up['without_upsell']['n']}), z={up['z']}. That is a "
                 f"{up['relative_lift']:+.0%} relative lift — but it is "
                 f"observational, and CSRs choose who to upsell. The test tells "
                 f"you how much of it is real."),
            steps=[
                "For the next 100 inbound inquiries, alternate strictly: odd-numbered "
                "leads get an upsell attempt, even-numbered do not.",
                "Do not let CSRs choose. That choice is exactly the bias being measured.",
                "Log the assignment in the Upsell column so the engine can score it.",
                "The engine will report the de-biased effect once n>=100 per arm.",
            ],
            impact_usd=3000, confidence=0.4, effort_hours=1.0,
            playbook="playbooks/upsell.md"))
    return tasks


def _economics_rules(bundle: MetricBundle, orders: Sequence[C.Order]) -> list[Task]:
    tasks: list[Task] = []
    e = bundle.econ

    if e.review_capture_rate < 0.30:
        # Scope to orders that will actually arrive in the next 90 days.
        # Sizing this off the lifetime order book instead would promise
        # hundreds of reviews that can only come from backfilling history,
        # which is not a thing anyone can do.
        forward_orders = bundle.flow_7d.total_per_day * 90
        gain = forward_orders * (0.65 - e.review_capture_rate)
        tasks.append(Task(
            id="review-capture",
            title="Install the mid-order checkpoint — private feedback is the leak",
            category="reputation",
            owner="All CSRs (compliance owned by Hasnain)",
            why=(f"Only {e.review_capture_rate:.1%} of the {e.review_denominator} "
                 f"orders on tabs that track reviews have one recorded, but public "
                 f"reviews are not where the damage is. Private ratings run "
                 f"underneath, stay open 60 days, are weighted most heavily for "
                 f"first-time buyers, and are invisible. That is why 1,583 reviews "
                 f"at 4.8 sit alongside Success Score 8. Asking for reviews does "
                 f"nothing about it; catching the problem mid-order does."),
            steps=[
                "At 50% of elapsed time on every order, send the direction so far "
                "and ask plainly whether anything needs changing. This is the one "
                "habit that converts a silent 3-star private rating into a fixed "
                "order, while the order is still open.",
                "Chase any silent buyer within 24 hours of delivery — orders "
                "auto-complete after 3 days and the private window stays open 60 "
                "days after that.",
                "Log every order where the buyer went silent, exceeded the agreed "
                "revisions, or accepted without a word. That is your proxy for the "
                "feedback you cannot see.",
                "Do NOT ask for a review beyond one neutral line at delivery, and "
                "never name a rating. Team briefing Rule 7 treats soliciting as an "
                "Integrity violation; see playbooks/review_capture.md.",
            ],
            impact_usd=gain * 25, confidence=0.45, effort_hours=1.0, urgency=1,
            playbook="playbooks/review_capture.md"))

    if e.upsell_rate < 0.05 and e.upsell_denominator >= 50:
        tasks.append(Task(
            id="upsell-tracking",
            title="Start recording upsells — the column is empty",
            category="data_quality",
            owner="All CSRs",
            why=(f"Upsell is marked on {e.upsell_rate:.1%} of the "
                 f"{e.upsell_denominator} orders whose tab has an Upsell column. "
                 f"That is not a low upsell rate, it is an unused column. The "
                 f"highest-value lever in the funnel currently cannot be measured, "
                 f"which means it cannot be improved or defended."),
            steps=[
                "Fill the Upsell column on every order: TRUE/FALSE, no blanks.",
                "Fill 'What did you upsell and how much' whenever TRUE.",
                "Backfill the last 30 completed orders from memory this week.",
            ],
            impact_usd=1200, confidence=0.5, effort_hours=1.5,
            playbook="playbooks/upsell.md"))

    # -- Designer routing --------------------------------------------------
    if len(e.by_designer) >= 4:
        top, bottom = e.by_designer[0], e.by_designer[-1]
        if top["aov"] > bottom["aov"] * 1.4:
            tasks.append(Task(
                id="designer-routing",
                title=f"Route high-value briefs to {top['name']}",
                category="delivery",
                owner="CEO",
                why=(f"{top['name']} averages ${top['aov']:.0f} across {top['n']} "
                     f"orders; {bottom['name']} averages ${bottom['aov']:.0f} across "
                     f"{bottom['n']}. Some of that is brief mix rather than skill — "
                     f"but routing the $200+ briefs to the designers who already "
                     f"deliver at that level protects both AOV and rating."),
                steps=[
                    f"Assign every brief above $200 to {top['name']} or the next "
                    f"two by AOV.",
                    "Check whether the low-AOV designers are getting low-value briefs "
                    "or producing low-value outcomes before acting on this.",
                    "Revisit in 30 days with the engine's updated per-designer AOV.",
                ],
                impact_usd=800, confidence=0.35, effort_hours=0.5,
                playbook="playbooks/staffing.md"))
    return tasks


def _data_quality_rules(violations: Sequence[C.Violation],
                        automation_errors: Sequence[dict]) -> list[Task]:
    tasks: list[Task] = []
    counts: dict[str, int] = {}
    for v in violations:
        counts[v.code] = counts.get(v.code, 0) + 1

    if counts.get("FLOW_REVENUE_MISSING", 0) > 10:
        n = counts["FLOW_REVENUE_MISSING"]
        tasks.append(Task(
            id="dq-flow-revenue",
            title=f"Fill revenue in the daily ledger ({n} days blank)",
            category="data_quality",
            owner="Whoever owns the daily ledger",
            why=(f"{n} ledger days record orders but $0 revenue. Every revenue "
                 f"forecast, the AOV target and the whole revenue side of the "
                 f"objective are currently inferred from the CRM sheet instead of "
                 f"measured, because this column is empty."),
            steps=[
                "Fill every revenue column in the ledger for every day that "
                "recorded orders.",
                "Backfill from 2026-06-11 forward — that is where the ledger starts.",
                "This is the single highest-value data fix available: it unblocks "
                "revenue forecasting entirely.",
            ],
            impact_usd=2000, confidence=0.9, effort_hours=2.0, priority="P0", urgency=1,
            playbook="playbooks/data_hygiene.md"))

    if counts.get("LEAD_PLACED_NO_VALUE", 0) > 20:
        n = counts["LEAD_PLACED_NO_VALUE"]
        tasks.append(Task(
            id="dq-lead-value",
            title=f"Record order value on placed leads ({n} missing)",
            category="data_quality",
            owner="All CSRs",
            why=(f"{n} leads are marked Placed with no order value. Pipeline value "
                 f"and per-CSR revenue attribution are both understated by an unknown "
                 f"amount, which makes CSR performance comparisons unreliable."),
            steps=[
                "Fill Order Price on every lead marked Placed, same day.",
                "Backfill the last 30 placed leads from the CRM sheet this week — "
                "the two sheets already hold the amounts, they are just not joined.",
                "Treat a blank price on a Placed lead as an incomplete row, not a "
                "minor omission.",
            ],
            impact_usd=400, confidence=0.8, effort_hours=1.0,
            playbook="playbooks/data_hygiene.md"))

    if automation_errors:
        msgs = {e["message"] for e in automation_errors}
        token = [m for m in msgs if "TOKEN" in m.upper()]
        if token:
            tasks.append(Task(
                id="fix-clickup",
                title=f"Fix the broken ClickUp sync ({len(automation_errors)} logged failures)",
                category="automation",
                owner="CEO / whoever owns the Apps Script",
                why=(f"The Apps Script has logged {len(automation_errors)} failures, "
                     f"including: {sorted(token)[0]}. Every ClickUp task the sheet "
                     f"should have created since then does not exist, so work is "
                     f"being tracked in two places that disagree."),
                steps=[
                    "Set CLICKUP_TOKEN in the Apps Script's Script Properties.",
                    "Re-run the sync for the backlog.",
                    "Add a failure alert — 300+ silent failures is the real defect.",
                ],
                impact_usd=600, confidence=0.7, effort_hours=1.0,
                playbook="playbooks/data_hygiene.md"))
    return tasks


def _decomposition_rules(bundle: MetricBundle) -> list[Task]:
    """Turn the reach-vs-conversion diagnosis into the right kind of work.

    This rule exists because the three causes need opposite responses. Telling
    the team to "improve conversion" when reach halved is worse than saying
    nothing — it sends them to rewrite a gig page that was never the problem.
    """
    d = bundle.decomposition
    if d and d.verdict == "stale":
        return [Task(
            id="impressions-stale",
            title="Bring the impressions sheet up to date — it stops months ago",
            category="data_quality",
            owner="Hasnain",
            why=d.explanation + (
                " Impressions are the leading indicator on the whole objective: "
                "Success Score drives impressions, impressions drive organic "
                "orders, organic orders drive revenue. Without a current series "
                "the engine can see that organic fell but not whether reach or "
                "conversion caused it, and those need opposite responses."),
            steps=[
                "Append daily rows from Fiverr Analytics from the last logged date "
                "to today: Date, Account Name, Impressions, Clicks, Organic Orders.",
                "Keep the existing column names exactly — the engine already reads "
                "them and a rename is what schema drift is.",
                "Post impressions and the 7-day average every morning at 09:00 PKT. "
                "It is the one number that says whether the suppression is lifting.",
                "Once 28 consecutive days exist, the engine attributes any decline "
                "to reach, click-through or close rate automatically.",
            ],
            impact_usd=2500, confidence=0.8, effort_hours=1.0,
            priority="P0", urgency=1, playbook="playbooks/data_hygiene.md")]
    if not d or not d.have_data or d.verdict in ("no_data", "insufficient"):
        return []
    share = abs(d.attribution.get(d.verdict, 0.0))
    if share < 0.45:
        return []          # no single factor dominates; do not over-claim
    orders_moved = (d.orders_now - d.orders_prior) / d.orders_prior if d.orders_prior else 0
    if orders_moved > -0.05:
        return []          # only act on a real decline

    playbooks = {
        "impressions": ("ranking", "playbooks/review_capture.md", [
            "Treat this as a ranking problem, not a gig-page problem — the "
            "page is converting exactly as well as before.",
            "Push review capture on every delivery; review velocity is the "
            "strongest ranking input you control.",
            "Audit on-time delivery and response time over the same window — "
            "both feed the success score that drives impressions.",
            "List every change made to how the profile was run in the same "
            "window — pricing, order mix, delivery times, gig edits — and "
            "line them up against the impression series by date. Impressions "
            "are the one metric that can date a ranking change.",
        ]),
        "ctr": ("listing", "playbooks/lead_triage.md", [
            "Treat this as a listing problem — people are seeing the gig and "
            "not clicking. Reach is fine.",
            "Change one thing at a time: thumbnail first, then title, then "
            "starting price. Changing three at once tells you nothing.",
            "Give each change 7 days before judging it; daily CTR on this "
            "volume is mostly noise.",
        ]),
        "order_rate": ("gig page and handling", "playbooks/upsell.md", [
            "Treat this as a page-and-handling problem — reach and clicks are "
            "holding, buyers are arriving and not ordering.",
            "Check first-response time on inbound inquiries over this window. "
            "Slow first replies show up here before anywhere else.",
            "Re-read the gig packages against the last 10 lost inquiries: are "
            "buyers asking for something the packages do not describe?",
        ]),
    }
    kind, playbook, steps = playbooks[d.verdict]
    return [Task(
        id=f"diagnose-{d.verdict}",
        title=f"Organic decline is a {kind} problem — act accordingly",
        category="diagnosis",
        owner="CEO",
        why=d.explanation,
        steps=steps,
        impact_usd=(bundle.econ.aov or 137.0) * abs(d.orders_prior - d.orders_now),
        confidence=0.75, effort_hours=2.0, priority="P0", urgency=1,
        playbook=playbook)]


def _dispute_rules(disputes: Sequence[C.Dispute], today: _dt.date,
                   aov: float) -> list[Task]:
    if not disputes:
        return []
    tasks: list[Task] = []
    open_ = [d for d in disputes if d.is_open()]

    if open_:
        exposure = sum(d.exposure() for d in open_)
        oldest = max((d.days_open(today) or 0) for d in open_)
        tasks.append(Task(
            id="disputes-open",
            title=f"Clear {len(open_)} open dispute(s) — ${exposure:,.0f} at risk",
            category="dispute_rescue",
            owner="Ezan (escalate to CEO above $300)",
            why=(f"{len(open_)} disputes are unresolved with ${exposure:,.0f} of "
                 f"order value exposed; the oldest has been open {oldest} days. "
                 f"Open disputes do not age well — Fiverr's resolution centre "
                 f"favours the party who engaged first and most clearly."),
            steps=[
                "Work them oldest-first; time open is the strongest predictor "
                "of a bad outcome.",
                "For each, decide today: rescue with a fresh senior direction, "
                "or exit cleanly with a partial refund and mutual cancellation.",
                "Record the root cause on every one. Without it you cannot tell "
                "a quality problem from a brief-taking problem.",
            ],
            impact_usd=exposure, confidence=0.7, effort_hours=2.0,
            priority="P0", urgency=2, playbook="playbooks/dispute_rescue.md"))

    # Concentrated root cause = a fixable process, not bad luck.
    causes = Counter(d.root_cause for d in disputes if d.root_cause != "unknown")
    if causes:
        top, n = causes.most_common(1)[0]
        if n >= 3 and n / max(len(disputes), 1) >= 0.35:
            fixes = {
                "brief_mismatch": "Tighten the requirements form and confirm the "
                                  "brief back to the buyer in writing before design starts.",
                "quality": "Add a senior review gate before first delivery.",
                "communication": "Set a first-response SLA and measure it per CSR.",
                "late": "Stop accepting orders above queue capacity.",
                "scope_creep": "Write the revision limit into the first message, "
                               "and quote paid extras the moment scope moves.",
                "buyer_changed_mind": "Take a deposit-style partial before concept work.",
                "scammer": "Never deliver before an order is placed; never move "
                           "off-platform before payment.",
            }
            tasks.append(Task(
                id=f"dispute-cause-{top}",
                title=f"Fix the root cause behind {n} disputes: {top.replace('_', ' ')}",
                category="process",
                owner="CEO",
                why=(f"{n} of {len(disputes)} recorded disputes "
                     f"({n / len(disputes):.0%}) share the root cause "
                     f"'{top.replace('_', ' ')}'. A concentration that high is a "
                     f"process defect, not bad luck, and it will keep producing "
                     f"disputes until the process changes."),
                steps=[
                    fixes.get(top, "Review the process that produces this cause."),
                    "Apply it to every new order from today, not retroactively.",
                    "The engine will report whether the share of this cause falls "
                    "over the next 30 days.",
                ],
                impact_usd=n * aov * 0.8, confidence=0.6, effort_hours=2.0,
                playbook="playbooks/dispute_rescue.md"))
    return tasks


def _dead_pipeline_rule(config: dict[str, Any]) -> list[Task]:
    """Quoted work that was never followed up.

    The clearest money in the whole dataset: named leads, known prices, zero
    touches, no new traffic required.
    """
    dp = config.get("dead_pipeline") or {}
    total = float(dp.get("total") or 0)
    if total <= 0:
        return []
    named = dp.get("named") or []
    rate = float(dp.get("recovery_assumption", 0.15))
    top = sorted(named, key=lambda x: -float(x.get("quoted", 0)))[:4]
    return [Task(
        id="dead-pipeline",
        title=f"Work the ${total:,.0f} dead pipeline, largest first",
        category="funnel",
        owner=config.get("team", {}).get("lead", "Operations lead"),
        why=(f"${total:,.0f} quoted across {dp.get('leads_logged', 0)} named leads "
             f"with {dp.get('followups_logged', 0)} follow-ups ever logged. At a "
             f"{rate:.0%} recovery that is ${total * rate:,.0f} — more than a full "
             f"day of current revenue, for zero ad spend and no new traffic. Top "
             f"Rated needs $10,000 earned and over half of it is sitting in a "
             f"spreadsheet column."),
        steps=[
            "Start with: " + ", ".join(
                f"{l['client']} (${l['quoted']:,.0f})" for l in top) + ".",
            "Use the four-line message in playbooks/dead_pipeline.md — quote still "
            "open, ask when to check back, ask for their number if budget was the "
            "issue.",
            "Log every touch in the FollowUp column with a date, same day.",
            "Anything that reopens goes straight into the normal intake flow.",
        ],
        impact_usd=total * rate, confidence=0.55, effort_hours=3.0,
        priority="P0", urgency=1, playbook="playbooks/dead_pipeline.md")]


def _missing_source_rules(missing: Sequence[dict]) -> list[Task]:
    if not missing:
        return []
    names = ", ".join(m["name"] for m in missing)
    return [Task(
        id="wire-missing-sources",
        title=f"Wire up the {len(missing)} promised data sources",
        category="data_quality",
        owner="CEO",
        why=(f"{len(missing)} sources are referenced by the plan but not readable "
             f"by the engine: {names}. Until they exist, dispute exposure, impression-vs-"
             f"conversion attribution and team-activity attribution are all "
             f"guesses. In particular, without impressions the engine cannot tell "
             f"whether an organic decline is falling reach or falling conversion — "
             f"and those need opposite responses."),
        steps=[m["why"] for m in missing] + [
            "Share each sheet with the Google account the engine reads as, "
            "then add its file_id to config/sources.yml.",
        ],
        impact_usd=1500, confidence=0.5, effort_hours=1.0,
        playbook="playbooks/data_hygiene.md")]


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------

def generate(
    *,
    bundle: MetricBundle,
    plan: DosePlan,
    active: Sequence[C.ActiveOrder],
    orders: Sequence[C.Order],
    disputes: Sequence[C.Dispute] = (),
    violations: Sequence[C.Violation] = (),
    automation_errors: Sequence[dict],
    missing_sources: Sequence[dict],
    today: _dt.date,
    config: dict[str, Any] | None = None,
    max_tasks: int = 12,
) -> list[Task]:
    tasks: list[Task] = []
    config = config or {}
    aov = bundle.econ.aov or 137.0
    if plan.action != "disabled":
        tasks.append(_dosing_rule(plan, bundle.health.verdict()))
    tasks += _decomposition_rules(bundle)
    tasks += _dispute_rules(disputes, today, aov)
    tasks += _active_order_rules(active, today, bundle.gig, aov)
    tasks += _funnel_rules(bundle)
    tasks += _dead_pipeline_rule(config)
    tasks += _economics_rules(bundle, orders)
    tasks += _data_quality_rules(violations, automation_errors)
    tasks += _missing_source_rules(missing_sources)

    # De-duplicate by id, keeping the highest-scoring instance.
    best: dict[str, Task] = {}
    for t in tasks:
        if t.id not in best or t.score > best[t.id].score:
            best[t.id] = t
    return _prioritise(list(best.values()))[:max_tasks]
