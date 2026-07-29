"""Route the daily task list to the people who will actually do it.

One combined list is a list nobody owns. This module splits the day's work
into a board per person, so Amrah opens the brief at 09:00 and sees her four
things rather than twelve, eight of which are someone else's.

Routing has two inputs:

*ownership* — some work belongs to a role regardless of clock. QA gates and
escalations are the team lead's. Ratio policy and pricing are the CEO's.

*the clock* — the rest belongs to whoever is on shift when it has to happen.
A buyer who messages at 03:00 PKT is Nadir's, not the person who wrote the
rule. Shifts are PKT and cover the full 24 hours, with a double-up from
21:00 to 01:00.

The board also carries what a person needs to hand over. A task that starts in
one shift and finishes in another is where things get dropped, so each board
ends with the five-line handoff the operating model specifies.
"""

from __future__ import annotations

import datetime as _dt
from dataclasses import dataclass, field
from typing import Any, Sequence

# --------------------------------------------------------------------------
# Ownership
# --------------------------------------------------------------------------

#: Task category -> who owns it regardless of shift.
CATEGORY_OWNER = {
    "vvro_dosing": "ceo",            # ratio policy is the CEO's call
    "pricing": "ceo",
    "process": "lead",
    "staffing": "ceo",
    "experiment": "ceo",
    "diagnosis": "lead",
    "automation": "lead",
    "delivery": "lead",              # QA gate before delivery
    "dispute_rescue": "lead",        # escalation path
    # Data hygiene is executable work, not supervision. Routing it to the lead
    # buried him under nine hours while a CSR had an empty board.
    "data_quality": "shift",
    "reputation": "shift",           # the mid-order checkpoint is per-order
    "order_revival": "shift",
    "pipeline_hygiene": "shift",
    "funnel": "shift",
    "upsell": "shift",
}


#: A team lead who is executing all day is not gating anyone's delivery.
MAX_LEAD_HOURS = 4.0


def _parse_hm(text: str) -> int:
    h, m = str(text).split(":")
    return int(h) * 60 + int(m)


@dataclass
class Shift:
    name: str
    start_min: int
    end_min: int
    label: str = ""

    def covers(self, minute_of_day: int) -> bool:
        if self.start_min <= self.end_min:
            return self.start_min <= minute_of_day < self.end_min
        # Wraps past midnight (17:00-01:00, 21:00-09:00).
        return minute_of_day >= self.start_min or minute_of_day < self.end_min

    def hours(self) -> float:
        span = (self.end_min - self.start_min) % (24 * 60)
        return (span or 24 * 60) / 60


@dataclass
class Board:
    person: str
    role: str
    window: str
    tasks: list[Any] = field(default_factory=list)
    standing: list[str] = field(default_factory=list)

    @property
    def total_effort(self) -> float:
        return sum(getattr(t, "effort_hours", 0) for t in self.tasks)

    @property
    def total_impact(self) -> float:
        return sum(getattr(t, "impact_usd", 0) for t in self.tasks)

    def as_dict(self) -> dict[str, Any]:
        return {
            "person": self.person, "role": self.role, "window": self.window,
            "task_ids": [t.id for t in self.tasks],
            "tasks": [t.as_dict() for t in self.tasks],
            "standing": self.standing,
            "total_effort_hours": round(self.total_effort, 2),
            "total_impact_usd": round(self.total_impact, 2),
        }


# --------------------------------------------------------------------------
# Standing duties — the things that happen every shift, task list or not.
# --------------------------------------------------------------------------

STANDING_CSR = [
    "Answer every new first-message within 30 minutes. Response rate counts "
    "only the first message in a thread, on a 24-hour window, rolling 90 days.",
    "Report spam as spam within 24 hours — it then does not count against "
    "response rate. Most agencies bleed this metric on messages they could "
    "have flagged in three seconds.",
    "Post the 12-question intake within 15 minutes of any order starting.",
    "Send the 50%-elapsed checkpoint on every live order. This is the habit "
    "that converts an invisible 3-star private rating into a fixed order.",
    "Log every quoted price into the inquiry sheet the moment it is sent.",
    "Never move a pre-order conversation off Fiverr, and never argue.",
]

STANDING_LEAD = [
    "QA gate: nothing ships without a check against the question-11 "
    "deliverable list. Watermarks removed, fonts noted, vectors included.",
    "Reconcile the inquiry log against the order tracker. On 27 July the "
    "tracker showed 5 orders and the inquiry log showed 2 for the whole month; "
    "until those agree, no conversion figure is trustworthy.",
    "Take the shift handoff at each changeover — five lines, no exceptions.",
    "Escalate any cancellation risk before it is filed, never after.",
]

STANDING_CEO = [
    "Post impressions and the 7-day average every morning. It is the single "
    "number that says whether the suppression is lifting.",
    "Watch the blended AOV against the organic AOV every week. When the two "
    "diverge, the profile is being priced below what its review base can "
    "carry, and the objective is revenue, not order count.",
    "Any order past day 7, or any cancellation, comes to you the same day.",
]

HANDOFF = [
    "Open orders and their deadlines",
    "Unanswered first-messages",
    "Orders at risk — past day 5, revision loops, unhappy tone",
    "Escalations needing the lead",
    "Revenue booked this shift",
]


# --------------------------------------------------------------------------
# Build
# --------------------------------------------------------------------------

def build_shifts(config: dict[str, Any]) -> list[Shift]:
    out: list[Shift] = []
    for r in config.get("team", {}).get("roster", []):
        sh = r.get("shift")
        if not sh:
            continue
        out.append(Shift(name=r["name"],
                         start_min=_parse_hm(sh["start"]),
                         end_min=_parse_hm(sh["end"]),
                         label=r.get("window_label", "")))
    return out


def on_shift(shifts: Sequence[Shift], at: _dt.time) -> list[str]:
    m = at.hour * 60 + at.minute
    return [s.name for s in shifts if s.covers(m)]


def route(config: dict[str, Any], tasks: Sequence[Any],
          now: _dt.time | None = None) -> list[Board]:
    """Split the day's tasks into one board per person.

    Shift-owned work is spread across the CSRs rather than dumped on whoever
    happens to be on duty at generation time: the brief is written once in the
    morning but worked all day, so assigning everything to the 09:00 shift
    would leave the two highest-value windows with nothing.
    """
    team = config.get("team", {})
    lead = team.get("lead", "Lead")
    shifts = build_shifts(config)

    boards: dict[str, Board] = {}
    for r in team.get("roster", []):
        sh = r.get("shift")
        window = (f"{sh['start']}-{sh['end']} PKT" if sh else "all hours")
        boards[r["name"]] = Board(person=r["name"], role=r.get("role", "csr"),
                                  window=window)
    boards["CEO"] = Board(person="CEO", role="ceo", window="—")

    csrs = [r["name"] for r in team.get("roster", [])
            if r.get("role") == "csr" and r["name"] in boards]
    # Highest-value window first, so the biggest shift-owned item lands where
    # the demand is. 01:00-09:00 is US peak and runs single-manned.
    priority_csrs = [n for n in ("Nadir", "Hasnain", "Amrah") if n in csrs] or csrs

    rr = 0
    for t in tasks:
        owner_kind = CATEGORY_OWNER.get(getattr(t, "category", ""), "shift")
        if owner_kind == "ceo":
            boards["CEO"].tasks.append(t)
        elif owner_kind == "lead" and lead in boards:
            boards[lead].tasks.append(t)
        elif owner_kind == "shift" and priority_csrs:
            boards[priority_csrs[rr % len(priority_csrs)]].tasks.append(t)
            rr += 1
        elif lead in boards:
            boards[lead].tasks.append(t)

    # Rebalance. A supervisor with nine hours of execution is not supervising,
    # and a CSR with an empty board will find something less useful to do.
    csr_boards = [boards[n] for n in priority_csrs]
    lead_board = boards.get(lead)
    if lead_board and csr_boards:
        movable = [t for t in lead_board.tasks
                   if getattr(t, "priority", "P3") in ("P2", "P3")]
        while (lead_board.total_effort > MAX_LEAD_HOURS and movable):
            target = min(csr_boards, key=lambda b: b.total_effort)
            t = movable.pop()
            lead_board.tasks.remove(t)
            target.tasks.append(t)
    # Nobody idle while someone else is loaded.
    for _ in range(len(tasks)):
        empty = [b for b in csr_boards if not b.tasks]
        loaded = [b for b in csr_boards if len(b.tasks) > 1]
        if not empty or not loaded:
            break
        donor = max(loaded, key=lambda b: b.total_effort)
        empty[0].tasks.append(donor.tasks.pop())

    for b in boards.values():
        if b.role == "csr":
            b.standing = list(STANDING_CSR)
        elif b.role == "team_lead":
            b.standing = list(STANDING_LEAD)
        elif b.role == "ceo":
            b.standing = list(STANDING_CEO)

    order = {"team_lead": 0, "ceo": 1, "csr": 2}
    return sorted(boards.values(),
                  key=lambda b: (order.get(b.role, 3), -b.total_impact))


def coverage_note(config: dict[str, Any]) -> str:
    return str(config.get("team", {}).get("coverage_note", "")).strip()


def edge(config: dict[str, Any]) -> list[dict[str, str]]:
    """Where the competitive advantage actually is.

    The strongest competitor evidence available is not a scraped rival — it is
    the portfolio itself. Same operator, same team, same category, different
    ratio policy, an 8x difference in distribution. That is closer to a
    controlled experiment than anything a competitor tracker can produce.
    """
    cg = (config.get("control_group") or {}).get("profiles") or []
    best = max(cg, key=lambda p: p.get("jul_impressions_daily", 0), default=None)
    us = next((p for p in cg if p.get("profile") == "X Studioz"), None)
    out: list[dict[str, str]] = []
    if best and us and best is not us:
        ratio = (best.get("jul_impressions_daily", 0)
                 / max(us.get("jul_impressions_daily", 1), 1))
        out.append({
            "id": "portfolio_control",
            "title": f"{best['profile']} is the experiment already run",
            "detail": (
                f"{best['profile']} holds Success Score {best.get('success_score')} "
                f"against X Studioz's {us.get('success_score')}, and pulls "
                f"{ratio:.0f}x the impressions "
                f"({best.get('jul_impressions_daily', 0):,}/day against "
                f"{us.get('jul_impressions_daily', 0):,}). Same operator, same "
                f"team, same category, same marketplace. Whatever is different "
                f"between the two profiles is worth more than any competitor "
                f"study — diagnose it directly rather than theorising about "
                f"the algorithm."),
        })
    econ = config.get("economics") or {}
    blended = econ.get("aov_blended")
    out.append({
        "id": "trust_asset",
        "title": "1,583 reviews is the moat, and it is being spent on cheap orders",
        "detail": (
            "Almost no competitor in logo design can match that review base. It "
            "is a conversion advantage that compounds — and it is currently "
            + (f"attached to a ${blended:,.0f} average order value. "
               if blended else "attached to a low average order value. ")
            + "The same trust aimed at $150-$260 work is the single largest "
              "untaken edge here, and it costs nothing to try."),
    })
    out.append({
        "id": "repeat_base",
        "title": "Half the revenue is from people who already know you",
        "detail": (
            "158 of 574 clients have ordered more than once, producing 48.2% of "
            "orders and $38,724 of revenue — with the Upsell column at 0.0% "
            "filled. Competitors fight for the first order. Nobody is fighting "
            "for the second one here, including us."),
    })
    return out
