"""Daily brief rendering.

The brief opens with what to do, not with how the system feels. Numbers carry
their sample size, recommendations carry the constraint that produced them,
and anything the engine could not verify is stated as such rather than
smoothed over.
"""

from __future__ import annotations

import datetime as _dt
from typing import Any, Sequence

from .dosing import DosePlan
from .ledger import Ledger, Prediction
from . import recovery as _recovery_mod
from .metrics import MetricBundle
from .selfcheck import SelfCheckReport
from .tasks import Task
from . import roles as _roles

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
    recovery: Any = None,
    intake: dict[str, Any] | None = None,
    feeds: list[dict[str, Any]] | None = None,
) -> str:
    h = bundle.health
    e = bundle.econ
    f = bundle.funnel
    out: list[str] = []

    out.append(f"# XStudioz — What Next · {today:%A %d %B %Y}")
    out.append("")

    # ---------------- what this brief is actually built on ----------------
    #
    # ABOVE THE HEADLINE, ON PURPOSE, AND ONLY WHEN IT IS NOT FINE.
    #
    # The date in the title is the date of the RUN. It says nothing about the
    # age of the data, and for months the two were assumed to match because a
    # stale run looked exactly like a fresh one: same layout, same figures,
    # same confidence. The scheduled run could fail for a week and the only
    # evidence was a line on stderr in a container nobody kept.
    #
    # A live intake prints nothing. A warning that fires every morning is one
    # nobody reads on the morning it means something.
    _intake = intake or {}
    _age = _intake.get("age_hours")
    _path = _intake.get("path")
    if _path == "markdown":
        out.append(
            "> ⚠️ **Built from a markdown export, not a snapshot.** "
            f"{_intake.get('caveat', '')} Every count below is suspect.")
        out.append("")
    elif _age is not None and _age >= 26:
        _gen = str(_intake.get("generated_at", ""))[:16].replace("T", " ")
        out.append(
            f"> ⚠️ **These figures are {_age:.0f} hours old.** The snapshot was taken "
            f"{_gen} UTC and the live endpoint was "
            f"{'not reachable' if _intake.get('endpoint_configured') else 'not configured'}. "
            "Everything below describes that moment, not today.")
        out.append("")

    # ---------------- headline ----------------
    verdict = h.verdict()
    badge = {"BREACH": "🔴", "SOFTENING": "🟠", "HEALTHY": "🟢"}[verdict]
    out.append(f"**Organic health: {badge} {verdict}** · index {h.index:.0f}/100")
    out.append("")
    if plan.action != "disabled":
        out.append(f"> {plan.summary_line()}")
        out.append("")

    if h.breach_reasons:
        out.append("**Why the constraint is breached**")
        for r in h.breach_reasons:
            out.append(f"- {r}")
        out.append("")

    # ---------------- money at rest ----------------
    # Leads the brief because it is the only block of money that needs no new
    # traffic, no marketplace lever and no permission: it is already committed.
    if recovery is not None:
        ob, qb = recovery.open_book, recovery.quote_book
        out.append("## Money sitting still")
        out.append("")
        out.append(f"**${recovery.total_at_rest:,.0f}** is committed or quoted and "
                   f"not moving — ${ob.stale_value:,.0f} in orders open more than "
                   f"{_recovery_mod.STALE_AFTER_DAYS} days, ${qb.total:,.0f} in "
                   f"quotes that were never placed.")
        out.append("")
        out.append("| Open orders | Count | Value |")
        out.append("| :-- | --: | --: |")
        for name, stats in ob.by_band().items():
            label = f"{name} days" + (" ⚠️" if name == "60+" else "")
            out.append(f"| {label} | {stats['count']} | ${stats['value']:,.0f} |")
        out.append(f"| **All open** | **{len(ob.orders)}** | "
                   f"**${ob.total_value:,.0f}** |")
        out.append("")
        if ob.stale:
            out.append("**Oldest open orders**")
            out.append("")
            out.append("| Client | Age | Status | Value | Designer |")
            out.append("| :-- | --: | :-- | --: | :-- |")
            for o in ob.oldest(8):
                out.append(f"| {o.client} | {o.age_days}d | {o.status} | "
                           f"{'MISSING' if o.amount is None else f'${o.amount:,.0f}'} "
                           f"| {o.designer or '—'} |")
            out.append("")
        if qb.untouched:
            out.append(f"**Quotes with no follow-up ever logged** — "
                       f"{len(qb.untouched)} worth ${qb.untouched_value:,.0f}")
            out.append("")
            out.append("| Client | Quoted | Age | CSR |")
            out.append("| :-- | --: | --: | :-- |")
            for q in sorted(qb.untouched, key=lambda q: -q.quoted)[:8]:
                out.append(f"| {q.client} | ${q.quoted:,.0f} | {q.age_days}d | "
                           f"{q.csr or '—'} |")
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

    # ---------------- who does what ----------------
    boards = _roles.route(config, tasks)
    out.append(_SEP)
    out.append("## Who does what")
    out.append("")
    for b in boards:
        if not b.tasks and not b.standing:
            continue
        out.append(f"### {b.person} · {b.role.replace('_', ' ')} · {b.window}")
        if b.tasks:
            out.append(f"*{len(b.tasks)} task(s), ~{b.total_effort:.1f}h*")
            out.append("")
            for t in b.tasks:
                out.append(f"- **{t.priority}** {t.title}")
        else:
            out.append("*No assigned tasks today — standing duties only.*")
        if b.standing:
            out.append("")
            out.append("Standing duties, every shift:")
            for sd in b.standing:
                out.append(f"- {sd}")
        out.append("")
    note = _roles.coverage_note(config)
    if note:
        out.append(f"> {note}")
        out.append("")
    out.append("**Shift handoff — five lines, every changeover:** "
               + "; ".join(_roles.HANDOFF) + ".")
    out.append("")

    # ---------------- edge ----------------
    edges = _roles.edge(config)
    if edges:
        out.append(_SEP)
        out.append("## Where the edge is")
        out.append("")
        for item in edges:
            out.append(f"**{item['title']}** — {item['detail']}")
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
        out.append(f"| Organic, recent vs earlier | {h.structural_post:.2f}/day | "
                   f"was {h.structural_pre:.2f}/day ({h.structural_delta_pct:+.1%}) |")
    # The window is named, not just its length. It ends on the last day the
    # ledger reports, which is a day behind the run and further behind when
    # nobody has filled the sheet in — and a bare "last 7d" hides both.
    _w7 = bundle.flow_7d
    out.append(f"| Organic orders, 7d to {_w7.end:%-d %b} | {_w7.organic:.0f} | "
               f"{_w7.organic_per_day:.2f}/day"
               + (f", ledger {_w7.lag_days}d behind this run |" if _w7.lag_days >= 2
                  else " |"))
    out.append(f"| AOV | {_fmt_money(e.aov)} | median {_fmt_money(e.median)}, "
               f"n={e.n_priced} priced orders |")
    out.append(f"| Lifetime tracked revenue | {_fmt_money(e.revenue)} | "
               f"across {e.n_orders} order rows |")
    out.append(f"| Inquiry conversion | {f.conversion:.1%} | {f.placed}/{f.inquiries} |")
    out.append(f"| Upsell recorded | {e.upsell_rate:.1%} | column is effectively unused |")
    out.append(f"| Review capture | {e.review_capture_rate:.1%} | "
               f"{round(e.review_capture_rate * e.review_denominator)}/"
               f"{e.review_denominator} orders that could be rated |")
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
                      else "**Not feasible** — organic flow cannot supply this "
                           "many orders inside the window."))
        out.append(f"- **AOV:** raise AOV to {_fmt_money(ra['required_aov'])} "
                   f"({ra['uplift_vs_current']:+.0%}). This is the route the "
                   f"constraint leaves open.")
        out.append("")
    elif gap.get("status") == "no_target":
        out.append("**No 30-day revenue target is set**, so nothing here can say "
                   "whether the month is on track. Set "
                   "`targets.monthly_revenue.t30` in `config/profile.yml`. This "
                   "line used to read \"On track against the 30-day target\", "
                   "which a target of zero clears every single day.")
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

    # ---------------- the feeds ----------------
    #
    # One table, because the honest answer to "is the system live" used to
    # require opening six things. `stale` and `unreachable` stay distinct: the
    # first means somebody stopped filling something in, the second means a
    # credential or a service, and they send you to different places.
    if feeds:
        out.append(_SEP)
        out.append("## Data feeds")
        out.append("")
        icon = {"live": "🟢", "stale": "🟠", "unreachable": "🔴"}
        out.append("| Feed | State | As of | Age | Where it comes from |")
        out.append("|---|---|---|---|---|")
        for f in feeds:
            age = f"{f['age_hours']:.0f}h" if f.get("age_hours") is not None else "—"
            out.append(
                f"| {f['label']} | {icon.get(f['status'], '?')} {f['status']} | "
                f"{f.get('as_of') or '—'} | {age} | {f['source']} |")
        out.append("")
        for f in [x for x in feeds if x["status"] != "live" and x.get("fix")]:
            out.append(f"- **{f['label']}** — {f['detail']}. {f['fix']}")
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
