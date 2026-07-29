"""Phase gate and kill criteria.

The operating model runs two phases with a hard gate between them, and the
whole point of a gate is that it is not a judgement call. Phase 1 is signal
repair: no ads, no new gigs, no queue growth, no price moves. Phase 2 opens
only when all three gate conditions read true at once.

This module makes that mechanical. It decides which phase is active, evaluates
the gate and the kill criteria against today's numbers, and classifies every
recommended action as permitted or not. The self-check treats a Phase 2 action
recommended during Phase 1 as a blocking failure rather than a warning,
because a gate that can be talked past is not a gate.

Kill criteria are the other half. A plan that cannot say when it is wrong is
not a plan, and the operating model names four conditions that stop the work
instead of continuing it.
"""

from __future__ import annotations

import datetime as _dt
from dataclasses import dataclass, field
from typing import Any, Sequence


@dataclass
class GateCondition:
    id: str
    label: str
    required: float
    actual: float | None
    met: bool
    source: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {"id": self.id, "label": self.label, "required": self.required,
                "actual": self.actual, "met": self.met, "source": self.source}


@dataclass
class KillTrigger:
    id: str
    fired: bool
    condition: str
    response: str
    detail: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {"id": self.id, "fired": self.fired, "condition": self.condition,
                "response": self.response, "detail": self.detail}


@dataclass
class PhaseState:
    id: str
    label: str
    objective: str
    window: tuple[_dt.date | None, _dt.date | None]
    days_remaining: int | None
    allowed: frozenset[str]
    forbidden: frozenset[str]
    forbidden_why: dict[str, str] = field(default_factory=dict)
    gate: list[GateCondition] = field(default_factory=list)
    gate_open: bool = False
    kills: list[KillTrigger] = field(default_factory=list)

    @property
    def fired_kills(self) -> list[KillTrigger]:
        return [k for k in self.kills if k.fired]

    def permits(self, action: str) -> bool:
        if action in self.forbidden:
            return False
        # An unlisted action is permitted. The forbidden list is the control;
        # the allowed list is documentation. Requiring every task category to
        # be pre-registered would make adding a rule a config change too.
        return True

    def why_forbidden(self, action: str) -> str:
        return self.forbidden_why.get(
            action, f"{action} is not permitted during {self.label}.")

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id, "label": self.label, "objective": self.objective,
            "window": [d.isoformat() if d else None for d in self.window],
            "days_remaining": self.days_remaining,
            "gate_open": self.gate_open,
            "gate": [g.as_dict() for g in self.gate],
            "kills_fired": [k.as_dict() for k in self.fired_kills],
            "forbidden": sorted(self.forbidden),
        }


def _as_date(v: Any) -> _dt.date | None:
    if isinstance(v, _dt.date):
        return v
    try:
        return _dt.date.fromisoformat(str(v))
    except (ValueError, TypeError):
        return None


def evaluate(config: dict[str, Any], today: _dt.date,
             *,
             success_score: float | None = None,
             impressions_7d_ma: float | None = None,
             completion_ratio_streak: int | None = None,
             cancellations_since_phase_start: int = 0) -> PhaseState:
    """Resolve the active phase and evaluate its gate and kill criteria.

    Every metric argument is optional and defaults to ``None`` — "we do not
    have this number yet" is a distinct state from "this number is zero", and
    conflating them would silently report a gate as failed when it is really
    unmeasured. An unmeasured condition is never counted as met.
    """
    pcfg = config.get("phases", {})
    defs = {d["id"]: d for d in pcfg.get("definitions", [])}
    current_id = pcfg.get("current", "signal_repair")
    d = defs.get(current_id, {})

    win = d.get("window") or [None, None]
    start, end = _as_date(win[0]), _as_date(win[1] if len(win) > 1 else None)
    remaining = (end - today).days if end else None

    # ---- gate --------------------------------------------------------
    readings = {
        "success_score": success_score,
        "impressions_7d_ma": impressions_7d_ma,
        "completion_ratio_consecutive_days_at_or_above_1": completion_ratio_streak,
    }
    labels = {
        "success_score": "Success Score",
        "impressions_7d_ma": "Impressions, 7-day average",
        "completion_ratio_consecutive_days_at_or_above_1":
            "Consecutive days with completion ratio >= 1.0",
    }
    gate: list[GateCondition] = []
    for g in pcfg.get("gate", []):
        metric = g.get("metric", "")
        actual = readings.get(metric)
        required = float(g.get("min", 0))
        gate.append(GateCondition(
            id=g.get("id", metric), label=labels.get(metric, metric),
            required=required, actual=actual,
            met=(actual is not None and actual >= required),
            source=g.get("source", "")))
    gate_open = bool(gate) and all(g.met for g in gate)

    # ---- kill criteria -----------------------------------------------
    kills: list[KillTrigger] = []
    for k in pcfg.get("kill_criteria", []):
        kid = k.get("id", "")
        fired, detail = False, ""
        if kid == "success_score_7":
            if success_score is not None and success_score <= 7:
                fired = True
                detail = f"Success Score reads {success_score:g}."
        elif kid == "any_cancellation":
            if cancellations_since_phase_start > 0:
                fired = True
                detail = (f"{cancellations_since_phase_start} cancellation(s) "
                          f"since the phase began.")
        elif kid == "completion_below_1":
            if completion_ratio_streak is not None and completion_ratio_streak <= -5:
                fired = True
                detail = "Completion ratio has been below 1.0 for 5 straight days."
        elif kid == "impressions_flat_at_gate":
            check_on = _dt.date(2026, 8, 20)
            if today >= check_on and impressions_7d_ma is not None \
                    and impressions_7d_ma < 2000:
                fired = True
                detail = (f"On {today}, impressions 7d average is "
                          f"{impressions_7d_ma:,.0f}, below the 2,000 floor.")
        kills.append(KillTrigger(id=kid, fired=fired,
                                 condition=k.get("when", ""),
                                 response=k.get("response", ""), detail=detail))

    return PhaseState(
        id=current_id,
        label=d.get("label", current_id),
        objective=d.get("objective", ""),
        window=(start, end),
        days_remaining=remaining,
        allowed=frozenset(d.get("allowed", [])),
        forbidden=frozenset(d.get("forbidden", [])),
        forbidden_why=dict(d.get("forbidden_why", {})),
        gate=gate, gate_open=gate_open, kills=kills,
    )


#: Task categories that map onto phase-gated actions. Anything not listed is
#: phase-neutral — hygiene, rescue and measurement work are always permitted.
CATEGORY_TO_ACTION = {
    "advertising": "fiverr_ads",
    "gig_launch": "new_gig_launch",
    "queue_growth": "queue_growth",
    "pricing": "price_increase",
}


def action_for(category: str) -> str | None:
    return CATEGORY_TO_ACTION.get(category)


def violations(state: PhaseState, tasks: Sequence[Any]) -> list[tuple[Any, str]]:
    """Tasks that recommend something the active phase forbids."""
    out: list[tuple[Any, str]] = []
    for t in tasks:
        action = action_for(getattr(t, "category", ""))
        if action and not state.permits(action):
            out.append((t, state.why_forbidden(action)))
    return out


def summary_line(state: PhaseState) -> str:
    if state.fired_kills:
        return (f"{state.label} — **{len(state.fired_kills)} kill criterion "
                f"fired**. Stop and re-plan before continuing.")
    met = sum(1 for g in state.gate if g.met)
    unmeasured = sum(1 for g in state.gate if g.actual is None)
    tail = f", {unmeasured} unmeasured" if unmeasured else ""
    days = (f", {state.days_remaining}d left"
            if state.days_remaining is not None and state.days_remaining >= 0
            else ", window elapsed" if state.days_remaining is not None else "")
    if state.gate_open:
        return f"{state.label} — gate OPEN, all {len(state.gate)} conditions met{days}."
    return (f"{state.label} — gate closed, {met}/{len(state.gate)} "
            f"conditions met{tail}{days}.")
