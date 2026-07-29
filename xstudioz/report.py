"""Daily brief rendering.

The brief opens with what to do, not with how the system feels. Numbers carry
their sample size, recommendations carry the constraint that produced them,
and anything the engine could not verify is stated as such rather than
smoothed over.
"""

from __future__ import annotations

import datetime as _dt
from typing import Any, Sequence

from .dosing import DosePlan, weekly_schedule, week_totals
from .ledger import Ledger, Prediction
from .metrics import MetricBundle
from .selfcheck import SelfCheckReport
from .tasks import Task

_SEP = "\n---\n"


def _fmt_money(x: float) -> str:
    return f"${x:,.0f}"


def render_markdown(
    *,
    today: _dt.date,
    bundle: MetricBundle,
    plan: DosePlan,
    tasks: Sequence[Task],
    predictions: Sequence[Prediction],
    resolved: Sequence[Prediction],
    ledger: Ledger,
    check: SelfCheckReport,
    config: dict[str, Any],
    revenue_projection: dict[str, Any],
    gap: dict[str, Any],
    missing_sources: Sequence[dict],
) -> str:
    h = bundle.health
    e = bundle.econ
    f = bundle.funnel
    out: list[str] = []

    out.append(f"# XStudioz — What Next · {today:%A %d %B %Y}")
    out.append("")

    # ---------------- headline ----------------
    verdict = h.verdict()
    badge = {"BREACH": "🔴", "SOFTENING": "🟠", "HEALTHY": "🟢"}[verdict]
    out.append(f"**Organic health: {badge} {verdict}** · index {h.index:.0f}/100 · "
               f"VVRO share {h.vvro_share_7d:.0%} (cap "
               f"{config['dosing']['max_vvro_share']:.0%})")
    out.append("")
    out.append(f"> {plan.summary_line()}")
    out.append("")

    if h.breach_reasons:
        out.append("**Why the constraint is breached**")
        for r in h.breach_reasons:
            out.append(f"- {r}")
        out.append("")

    # ---------------- do today ----------------
    out.append("## Do today")
    out.append("")
    for t in tasks:
        out.append(f"### {t.priority} · {t.title}")
        out.append(f"**Owner:** {t.owner} · **Est. impact:** {_fmt_money(t.impact_usd)} "
                   f"· **Effort:** {t.effort_hours}h · **Confidence:** {t.confidence:.0%}")
        out.append("")
        out.append(f"*Why:* {t.why}")
        out.append("")
        for s in t.steps:
            if s:
                out.append(f"- {s}")
        if t.playbook:
            out.append(f"- Script: `{t.playbook}`")
        if t.refs:
            out.append(f"- Source rows: {', '.join(f'`{r}`' for r in t.refs)}")
        out.append("")

    # ---------------- VVRO plan ----------------
    out.append(_SEP)
    out.append("## Inorganic (VVRO) plan")
    out.append("")
    out.append(f"- **Action:** {plan.action.upper()} · binding constraint: "
               f"`{plan.binding_constraint}`")
    out.append(f"- **Quota:** {plan.weekly_quota}/week "
               f"({plan.target_rate:.2f}/day) · today: **{plan.dose}**")
    out.append(f"- **Ceiling from share cap:** {plan.ceiling_from_share:.2f}/day at the "
               f"current organic rate of {h.ma7_now:.2f}/day")
    if plan.projected_share is not None:
        out.append(f"- **Projected VVRO share at this rate:** {plan.projected_share:.0%}")
    if plan.cooldown_until:
        out.append(f"- **Cooldown until:** {plan.cooldown_until}")
    out.append("")
    sched = weekly_schedule(plan, config)
    totals = week_totals(sched)
    out.append("| Date | Day | Place | Price bands |")
    out.append("|---|---|---|---|")
    for s in sched:
        bands = ", ".join(f"{b['count']}x {b['range']}" for b in s["bands"]) or "—"
        out.append(f"| {s['date']} | {s['weekday']} | {s['dose']} | {bands} |")
    out.append("")
    out.append("Per ISO week: " + ", ".join(f"**{w}** = {n}" for w, n in totals.items())
               + f" (quota is {plan.weekly_quota}/week; a 7-day window straddles two "
                 f"weeks, so these will not both equal the quota).")
    out.append("")

    # ---------------- predictions ----------------
    out.append(_SEP)
    out.append("## Predictions")
    out.append("")
    out.append("Each is scored automatically on its resolution date and feeds "
               "interval calibration.")
    out.append("")
    out.append("| Resolve on | Prediction | 80% interval | Confidence |")
    out.append("|---|---|---|---|")
    for p in predictions:
        out.append(f"| {p.resolve_on} | {p.statement} | {p.lo:.2f} – {p.hi:.2f} | "
                   f"{p.confidence} |")
    out.append("")

    if resolved:
        out.append("### Resolved since last run")
        out.append("")
        out.append("| Made on | Prediction | Predicted | Actual | In interval? |")
        out.append("|---|---|---|---|---|")
        for p in resolved:
            hit = "✅" if p.within_interval else "❌"
            act = f"{p.actual:.2f}" if p.actual is not None else "—"
            out.append(f"| {p.created_on} | {p.metric} | {p.point:.2f} | {act} | {hit} |")
        out.append("")

    sc = ledger.scorecard()
    out.append(f"**Track record:** {sc['resolved']} resolved, "
               f"coverage {sc['coverage']:.0%} " if sc["coverage"] is not None
               else "**Track record:** no predictions resolved yet — "
                    "the first scores land in 7 days.")
    if sc["coverage"] is not None:
        out.append(f"(target 80%), median absolute error "
                   f"{sc['median_abs_pct_error']:.0%}.")
    out.append("")

    # ---------------- numbers ----------------
    out.append(_SEP)
    out.append("## Where the business actually is")
    out.append("")
    out.append("| Metric | Value | Note |")
    out.append("|---|---|---|")
    out.append(f"| Organic orders/day (7d MA) | {h.ma7_now:.2f} | vs {h.ma7_prior:.2f} "
               f"14d ago |")
    if h.structural_delta_pct is not None:
        out.append(f"| Organic since VVRO began | {h.structural_post:.2f}/day | "
                   f"was {h.structural_pre:.2f}/day ({h.structural_delta_pct:+.1%}) |")
    out.append(f"| Total orders/day (7d) | {bundle.flow_7d.total_per_day:.2f} | "
               f"{bundle.flow_7d.organic:.0f} organic + {bundle.flow_7d.vvro:.0f} VVRO |")
    out.append(f"| AOV | {_fmt_money(e.aov)} | median {_fmt_money(e.median)}, "
               f"n={e.n_priced} priced orders |")
    out.append(f"| Lifetime tracked revenue | {_fmt_money(e.revenue)} | "
               f"across {e.n_orders} order rows |")
    out.append(f"| Inquiry conversion | {f.conversion:.1%} | {f.placed}/{f.inquiries} |")
    out.append(f"| Upsell recorded | {e.upsell_rate:.1%} | column is effectively unused |")
    out.append(f"| Review capture | {e.review_capture_rate:.1%} | "
               f"biggest free growth lever |")
    if bundle.gig:
        g = bundle.gig
        out.append(f"| Gig rating | {g.get('rating', 0):.3f} | "
                   f"{g.get('reviews_total', 0):,} reviews, {g.get('level', '?')} |")
        out.append(f"| Orders in queue | {g.get('orders_in_queue', '?')} | live from "
                   f"the gig page |")
    out.append("")

    # ---------------- revenue ----------------
    out.append("### Revenue path")
    out.append("")
    rp = revenue_projection
    out.append(f"At {rp['total_rate']:.2f} orders/day and {_fmt_money(rp['aov'])} AOV, "
               f"the next {rp['days']} days project **{_fmt_money(rp['projected_revenue'])}** "
               f"({rp['projected_orders']:.0f} orders).")
    out.append("")
    if gap.get("status") == "behind":
        rv, ra = gap["route_volume"], gap["route_aov"]
        out.append(f"That is **{_fmt_money(gap['gap'])} behind** the 30-day target. "
                   f"Two routes close it:")
        out.append("")
        out.append(f"- **Volume:** +{rv['extra_orders']:.0f} orders "
                   f"(+{rv['extra_per_day']:.2f}/day). "
                   + ("Feasible organically." if rv["feasible_organically"]
                      else "**Not feasible** — the organic constraint caps volume, and "
                           "VVRO is already at its ceiling."))
        out.append(f"- **AOV:** raise AOV to {_fmt_money(ra['required_aov'])} "
                   f"({ra['uplift_vs_current']:+.0%}). This is the route the "
                   f"constraint leaves open.")
        out.append("")
    else:
        out.append("On track against the 30-day target.")
        out.append("")

    # ---------------- funnel detail ----------------
    out.append("### Funnel leverage")
    out.append("")
    out.append("| Segment | n | Conversion | Lower bound |")
    out.append("|---|---|---|---|")
    for s in (f.by_shift or [])[:4]:
        out.append(f"| Shift: {s.key} | {s.n} | {s.conv:.1%} | {s.conv_lb:.1%} |")
    for s in (f.by_country or [])[:6]:
        out.append(f"| {s.key} | {s.n} | {s.conv:.1%} | {s.conv_lb:.1%} |")
    out.append("")
    out.append("Ranked on the Wilson lower bound, not raw rate, so small samples "
               "cannot outrank large ones.")
    out.append("")

    # ---------------- integrity ----------------
    out.append(_SEP)
    out.append("## System integrity")
    out.append("")
    out.append(f"**Self-check score: {check.score:.0f}/100** · "
               f"{len(check.blocking_failures)} blocking failure(s)")
    out.append("")
    for k, v in check.rubric.items():
        out.append(f"- {k}: {v:.0f}")
    out.append("")
    if check.repairs:
        out.append("**Auto-repairs applied this run**")
        for r in check.repairs:
            out.append(f"- {r}")
        out.append("")
    failed = [r for r in check.results if not r.passed]
    if failed:
        out.append("**Checks not passing**")
        for r in failed:
            out.append(f"- `{r.severity}` **{r.name}** — {r.detail}")
        out.append("")
    if missing_sources:
        out.append("**Data sources still missing**")
        for m in missing_sources:
            out.append(f"- {m['name']} — {m['why']}")
        out.append("")

    out.append(_SEP)
    out.append(f"*Generated {today.isoformat()} by the XStudioz growth engine. "
               f"Read-only: no source sheet was modified.*")
    return "\n".join(out)
