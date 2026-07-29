#!/usr/bin/env python3
"""Render the daily brief as a standalone HTML dashboard.

Reads ``reports/<date>-run.json`` plus the normalized flow series and writes a
single self-contained page. No external requests: the Artifact CSP blocks CDNs,
and a dashboard that silently loses its font or its chart library is worse than
one that never had them.

The page is an instrument, not an article — it gets scanned and acted on, so
state is encoded in form (stripe, pill, rule) as well as in number.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import html
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

E = html.escape

VERDICT_TONE = {"BREACH": "critical", "SOFTENING": "warn", "HEALTHY": "good"}
PRIORITY_TONE = {"P0": "critical", "P1": "warn", "P2": "muted", "P3": "muted"}


def money(x: float) -> str:
    return f"${x:,.0f}"


def load_flow(root: Path, profile: str) -> list[dict]:
    p = root / "data" / "normalized" / "flow.jsonl"
    if not p.exists():
        return []
    rows = []
    for line in p.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        r = json.loads(line)
        if r.get("profile") == profile:
            rows.append({"date": r["date"], "o": r.get("organic_orders", 0),
                         "v": r.get("vvro_orders", 0)})
    rows.sort(key=lambda r: r["date"])
    return rows


# --------------------------------------------------------------------------

CSS = """
/* Design system lifted from ezanbhutta/csr-pulse (src/CSRPulse.jsx, const C)
   so this page reads as part of the same suite as CSR Pulse and Designer
   Pulse rather than a bolt-on. Their canvas principle is "~55% white
   dominance via tinted off-whites" — a barely-there violet cast on every
   neutral, deep violet as the only accent, white cards floating on it.

   Fonts: csr-pulse loads Inter / Space Grotesk / JetBrains Mono from Google
   Fonts. The Artifact CSP blocks external hosts, so the same families are
   declared and resolve when the viewer has them, falling back to system
   equivalents rather than risking a silent swap to Times.

   csr-pulse is light-only. Artifacts render in the viewer's theme, so the
   dark variant is a faithful translation: bgInk becomes the ground and
   violetGlow carries the accent, keeping the brand legible either way. */
*,*::before,*::after{box-sizing:border-box}
:root{
  --bg:#FAFAFE; --raised:#F4F2FA; --card:#FFFFFF; --hover:#F0EEFA;
  --ink:#160A33; --muted:#534A78; --dim:#8B82A8;
  --border:#E8E5F3; --border-hi:#D4CFEC;
  --violet:#7229FF; --violet-dim:#5E1FD8; --violet-glow:#9F66FF;
  --violet-bg:#F1EBFF;
  --mint:#10B981; --mint-bg:#E7F8F1;
  --amber:#F59E0B; --amber-bg:#FEF4DE;
  --coral:#EF4444; --coral-bg:#FDE9E9;
  --sky:#0EA5E9; --sky-bg:#E5F4FE;
  --sans:"Inter",-apple-system,BlinkMacSystemFont,system-ui,sans-serif;
  --disp:"Space Grotesk","Inter",system-ui,sans-serif;
  --mono:"JetBrains Mono","Fira Code",ui-monospace,SFMono-Regular,Menlo,monospace;
  color-scheme:light;
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#0F0722; --raised:#160A33; --card:#1C0F3E; --hover:#241452;
    --ink:#F4F2FA; --muted:#C3BBDF; --dim:#8B82A8;
    --border:#2A1A56; --border-hi:#3B2670;
    --violet:#9F66FF; --violet-dim:#7229FF; --violet-glow:#B98CFF;
    --violet-bg:#241452;
    --mint:#34D399; --mint-bg:#0C2C22;
    --amber:#FBBF24; --amber-bg:#2E2410;
    --coral:#F87171; --coral-bg:#301618;
    --sky:#38BDF8; --sky-bg:#0B2739;
    color-scheme:dark;
  }
}
:root[data-theme="dark"]{
  --bg:#0F0722; --raised:#160A33; --card:#1C0F3E; --hover:#241452;
  --ink:#F4F2FA; --muted:#C3BBDF; --dim:#8B82A8;
  --border:#2A1A56; --border-hi:#3B2670;
  --violet:#9F66FF; --violet-dim:#7229FF; --violet-glow:#B98CFF;
  --violet-bg:#241452;
  --mint:#34D399; --mint-bg:#0C2C22;
  --amber:#FBBF24; --amber-bg:#2E2410;
  --coral:#F87171; --coral-bg:#301618;
  --sky:#38BDF8; --sky-bg:#0B2739;
  color-scheme:dark;
}
:root[data-theme="light"]{
  --bg:#FAFAFE; --raised:#F4F2FA; --card:#FFFFFF; --hover:#F0EEFA;
  --ink:#160A33; --muted:#534A78; --dim:#8B82A8;
  --border:#E8E5F3; --border-hi:#D4CFEC;
  --violet:#7229FF; --violet-dim:#5E1FD8; --violet-glow:#9F66FF;
  --violet-bg:#F1EBFF;
  --mint:#10B981; --mint-bg:#E7F8F1;
  --amber:#F59E0B; --amber-bg:#FEF4DE;
  --coral:#EF4444; --coral-bg:#FDE9E9;
  --sky:#0EA5E9; --sky-bg:#E5F4FE;
  color-scheme:light;
}
body{margin:0;background:var(--bg);color:var(--muted);
  font:14px/1.6 var(--sans);-webkit-font-smoothing:antialiased;
  -moz-osx-font-smoothing:grayscale}
.wrap{max-width:1180px;margin:0 auto;padding:28px 20px 72px;
  display:flex;flex-direction:column;gap:22px}
h1,h2,h3{color:var(--ink);margin:0;text-wrap:balance}
h1{font:700 26px/1.2 var(--disp);letter-spacing:-.02em}
h2{font:600 10px/1.4 var(--sans);text-transform:uppercase;
  letter-spacing:.18em;color:var(--dim)}
h3{font:600 15px/1.35 var(--sans);letter-spacing:-.01em}
a{color:var(--violet)}
.mono{font-family:var(--mono);font-variant-numeric:tabular-nums}
.disp{font-family:var(--disp);letter-spacing:-.02em}

/* masthead */
.mast{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;
  gap:12px;padding-bottom:14px;border-bottom:1px solid var(--border)}
.mast .meta{font:500 11px/1.5 var(--mono);color:var(--dim)}
.brand{display:flex;align-items:center;gap:10px}
.dot{width:9px;height:9px;border-radius:50%;background:var(--violet);
  box-shadow:0 0 0 3px var(--violet-bg)}

/* KPI strip */
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}
.kpi{background:var(--card);border:1px solid var(--border);border-radius:12px;
  padding:14px 16px;display:flex;flex-direction:column;gap:5px}
.kpi .k{font:600 9px/1.4 var(--sans);text-transform:uppercase;
  letter-spacing:.15em;color:var(--dim)}
.kpi .v{font:600 24px/1.1 var(--mono);color:var(--ink);
  font-variant-numeric:tabular-nums}
.kpi .s{font:500 11px/1.4 var(--sans);color:var(--muted)}
.kpi.good .v{color:var(--mint)} .kpi.warn .v{color:var(--amber)}
.kpi.critical .v{color:var(--coral)}

/* cards */
.card{background:var(--card);border:1px solid var(--border);border-radius:14px;
  padding:20px 22px;display:flex;flex-direction:column;gap:14px}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}

/* the gate — page thesis */
.gate{border-radius:14px;padding:20px 22px;display:flex;flex-direction:column;
  gap:14px;background:var(--card);border:1px solid var(--border);
  border-left:4px solid var(--tone)}
.gate.good{--tone:var(--mint)} .gate.warn{--tone:var(--amber)}
.gate.critical{--tone:var(--coral)}
.gate-top{display:flex;flex-wrap:wrap;align-items:center;gap:12px}
.verdict{font:600 10px/1 var(--sans);letter-spacing:.18em;text-transform:uppercase;
  color:var(--tone);background:var(--tone-bg);border-radius:999px;padding:7px 13px}
.gate.good .verdict{--tone-bg:var(--mint-bg)}
.gate.warn .verdict{--tone-bg:var(--amber-bg)}
.gate.critical .verdict{--tone-bg:var(--coral-bg)}
.gate-head{font:600 19px/1.3 var(--disp);letter-spacing:-.02em;color:var(--ink);
  flex:1 1 260px}
.idx{font:600 24px/1 var(--mono);color:var(--ink);font-variant-numeric:tabular-nums}
.idx small{font:500 10px/1 var(--sans);color:var(--dim);letter-spacing:.12em}
.reasons{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:6px}
.reasons li::marker{color:var(--tone)}

/* dose */
.dose{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
.dose .big{font:700 44px/1 var(--mono);color:var(--violet);
  font-variant-numeric:tabular-nums}
.dose .unit{font:600 10px/1.4 var(--sans);color:var(--dim);
  text-transform:uppercase;letter-spacing:.15em}
.pill{font:600 9px/1 var(--sans);letter-spacing:.15em;text-transform:uppercase;
  padding:6px 10px;border-radius:999px;background:var(--raised);color:var(--muted)}
.pill.cut{background:var(--coral-bg);color:var(--coral)}
.pill.raise{background:var(--mint-bg);color:var(--mint)}
.pill.freeze,.pill.hold{background:var(--amber-bg);color:var(--amber)}

/* formula readout */
.formula{background:var(--raised);border:1px solid var(--border);border-radius:10px;
  padding:14px 16px;font-family:var(--mono);font-size:12.5px;line-height:1.9;
  overflow-x:auto}
.formula .sym{color:var(--violet);font-weight:600}
.formula .sub{color:var(--dim);font-size:10.5px}
.formula b{color:var(--ink);font-weight:600;font-variant-numeric:tabular-nums}

/* week strip */
.week{display:grid;grid-template-columns:repeat(7,1fr);gap:6px}
.day{border:1px solid var(--border);border-radius:9px;padding:9px 6px;
  text-align:center;background:var(--raised)}
.day.on{border-color:var(--violet);background:var(--violet-bg)}
.day .dow{font:600 9px/1.4 var(--sans);letter-spacing:.12em;color:var(--dim);
  text-transform:uppercase}
.day .n{font:600 17px/1.3 var(--mono);color:var(--ink)}
.day.on .n{color:var(--violet)}

/* boards */
.board{background:var(--card);border:1px solid var(--border);border-radius:12px;
  padding:16px 18px;display:flex;flex-direction:column;gap:10px}
.board-top{display:flex;flex-wrap:wrap;align-items:baseline;gap:10px}
.who{font:600 15px/1.3 var(--disp);letter-spacing:-.02em;color:var(--ink)}
.win{font:500 11px/1.4 var(--mono);color:var(--dim)}
.board ul{margin:0;padding-left:17px;display:flex;flex-direction:column;gap:5px}
.board li::marker{color:var(--violet-glow)}
.standing{border-top:1px dashed var(--border-hi);padding-top:10px;
  font-size:12.5px;color:var(--dim)}

/* tables */
table{width:100%;border-collapse:collapse;font-size:13px}
.scroll{overflow-x:auto}
th{text-align:left;font:600 9px/1.4 var(--sans);text-transform:uppercase;
  letter-spacing:.15em;color:var(--dim);padding:0 12px 9px 0;
  border-bottom:1px solid var(--border-hi);white-space:nowrap}
td{padding:9px 12px 9px 0;border-bottom:1px solid var(--border);vertical-align:top}
td.n{font-family:var(--mono);font-variant-numeric:tabular-nums;color:var(--ink);
  white-space:nowrap}
tr:last-child td{border-bottom:0}

/* tasks */
.tasks{display:flex;flex-direction:column;gap:10px}
.task{background:var(--card);border:1px solid var(--border);
  border-left:3px solid var(--tone);border-radius:12px;padding:15px 17px;
  display:flex;flex-direction:column;gap:9px}
.task.critical{--tone:var(--coral)} .task.warn{--tone:var(--amber)}
.task.muted{--tone:var(--border-hi)}
.task-top{display:flex;flex-wrap:wrap;align-items:center;gap:9px}
.pri{font:600 9px/1 var(--sans);letter-spacing:.15em;color:var(--tone);
  background:var(--raised);border-radius:6px;padding:5px 8px}
.task h3{flex:1 1 240px}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{font:500 10px/1 var(--mono);color:var(--dim);background:var(--raised);
  border-radius:999px;padding:6px 10px}
.chip b{color:var(--ink);font-weight:600}
.why{font-size:13px;color:var(--muted);margin:0}
.steps{margin:0;padding-left:17px;display:flex;flex-direction:column;gap:5px;
  font-size:13px}
.steps li::marker{color:var(--dim)}

/* chart */
canvas{width:100%;height:150px;display:block}
.legend{display:flex;gap:16px;font:600 9px/1 var(--sans);color:var(--dim);
  text-transform:uppercase;letter-spacing:.15em}
.legend i{display:inline-block;width:9px;height:9px;border-radius:3px;
  margin-right:6px;vertical-align:-1px}

/* bar rows */
.bars{display:flex;flex-direction:column;gap:8px}
.bar{display:grid;grid-template-columns:150px 1fr 44px;gap:10px;align-items:center;
  font:500 10.5px/1.4 var(--sans);color:var(--dim);letter-spacing:.04em}
.bar .track{height:6px;background:var(--raised);border-radius:999px;overflow:hidden}
.bar .fill{height:100%;background:var(--violet);border-radius:999px}
.bar .v{text-align:right;color:var(--ink);font-family:var(--mono);
  font-variant-numeric:tabular-nums}

.note{font-size:12.5px;color:var(--dim);margin:0}
code{font-family:var(--mono);font-size:.92em;background:var(--raised);
  padding:1px 5px;border-radius:5px;color:var(--muted)}
footer{border-top:1px solid var(--border);padding-top:14px;
  font:500 11px/1.6 var(--mono);color:var(--dim)}
:focus-visible{outline:2px solid var(--violet);outline-offset:2px}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
@media (max-width:560px){
  .week{grid-template-columns:repeat(4,1fr)}
  .bar{grid-template-columns:104px 1fr 40px}
  .dose .big{font-size:36px}
}
"""


def render(run: dict, flow: list[dict], root: Path) -> str:
    m = run["metrics"]
    h, plan, econ, fun = m["health"], run["dose_plan"], m["economics"], m["funnel"]
    dec, dis = m.get("decomposition", {}), m.get("disputes", {})
    chk, gap = run["selfcheck"], run.get("gap", {})
    proj = run.get("revenue_projection", {})
    today = run["today"]
    verdict = h["verdict"]
    tone = VERDICT_TONE.get(verdict, "muted")

    o = h["ma7_now"]
    ceiling = plan["ceiling_from_share"]
    share_cap = ceiling / (o + ceiling) if (o + ceiling) else 0

    p: list[str] = []
    A = p.append

    # ---- masthead ----
    A(f'<div class="wrap"><header class="mast">'
      f'<div class="brand"><span class="dot"></span>'
      f'<h1>What Next <span style="color:var(--dim);font-weight:500">'
      f'&middot; {E(m["profile"])}</span></h1></div>'
      f'<div class="meta">{E(today)} &middot; HaseebMadeIt &middot; '
      f'self-check {chk["score"]:.0f}/100</div></header>')

    # KPI strip, mirroring the CSR Pulse layout.
    def kpi(label, value, sub, tone=""):
        return (f'<div class="kpi {tone}"><span class="k">{E(label)}</span>'
                f'<span class="v">{E(value)}</span>'
                f'<span class="s">{E(sub)}</span></div>')
    ph = run.get("phase") or {}
    gmet = sum(1 for g in ph.get("gate", []) if g["met"])
    gtot = len(ph.get("gate", [])) or 1
    A('<section class="kpis">')
    A(kpi("Organic / day", f'{h["ma7_now"]:.2f}', f'7d avg, was {h["ma7_prior"]:.2f}',
          "critical" if verdict == "BREACH" else ""))
    A(kpi("VVRO share", f'{h["vvro_share_7d"]:.0%}', f'cap {share_cap:.0%}',
          "critical" if h["vvro_share_7d"] > share_cap else "good"))
    A(kpi("Today's dose", str(plan["dose"]), f'{plan["weekly_quota"]}/week'))
    A(kpi("AOV", money(econ["aov"]), f'median {money(econ["median"])}'))
    A(kpi("Phase gate", f'{gmet}/{gtot}', ph.get("label", "—"),
          "good" if ph.get("gate_open") else "warn"))
    A('</section>')

    # ---- the constraint ----
    A(f'<section class="gate {tone}"><div class="gate-top">'
      f'<span class="verdict">{E(verdict)}</span>'
      f'<span class="gate-head">Organic flow is the constraint on everything else</span>'
      f'<span class="idx">{h["index"]:.0f}<small> / 100</small></span></div>')
    reasons = h.get("breach_reasons") or []
    if reasons:
        A('<ul class="reasons">' +
          "".join(f"<li>{E(r)}</li>" for r in reasons) + "</ul>")
    else:
        A(f'<p class="note">7-day organic average '
          f'{h["ma7_now"]:.2f}/day against {h["ma7_prior"]:.2f} a fortnight ago. '
          f'No breach — the dose may rise if revenue needs it.</p>')
    A("</section>")

    # ---- decision row ----
    A('<div class="cols">')
    act = plan["action"]
    A(f'<section class="card"><h2>Place today</h2><div class="dose">'
      f'<span class="big">{plan["dose"]}</span>'
      f'<span class="unit">order{"s" if plan["dose"] != 1 else ""} &middot; '
      f'{plan["weekly_quota"]}/week</span>'
      f'<span class="pill {E(act)}">{E(act)}</span></div>')
    bands = [b for b in plan.get("bands", []) if b["count"]]
    if bands:
        A('<div class="chips">' + "".join(
            f'<span class="chip"><b>{b["count"]}&times;</b> {E(b["range"])}</span>'
            for b in bands) + "</div>")
    pattern = plan.get("week_pattern") or []
    if pattern:
        dow = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
        wd = _dt.date.fromisoformat(today).weekday()
        A('<div class="week">' + "".join(
            f'<div class="day{" on" if n else ""}"><div class="dow">{dow[i]}'
            f'{"&bull;" if i == wd else ""}</div><div class="n">{n}</div></div>'
            for i, n in enumerate(pattern)) + "</div>")
    A(f'<p class="note">Binding constraint: <code>{E(plan["binding_constraint"])}</code>. '
      f'Days rotate weekly — a fixed cadence is what makes inorganic volume '
      f'legible from outside.</p></section>')

    # the ceiling formula as a live readout
    A('<section class="card"><h2>Why that number</h2>'
      '<div class="formula">'
      '<span class="sym">v</span> &le; <span class="sym">o</span> &times; '
      '<span class="sym">s</span> &divide; (1 &minus; <span class="sym">s</span>)<br>'
      f'<span class="sub">organic <span class="sym">o</span></span> = '
      f'<b>{o:.2f}</b>/day<br>'
      f'<span class="sub">share cap <span class="sym">s</span></span> = '
      f'<b>{share_cap:.0%}</b><br>'
      f'<span class="sub">ceiling <span class="sym">v</span></span> = '
      f'<b>{ceiling:.2f}</b>/day &rarr; <b>{plan["weekly_quota"]}</b>/week'
      '</div>'
      f'<p class="note">The cap is on the <em>share</em>, so the ceiling moves with '
      f'organic volume. When organic falls, the inorganic headroom falls with it — '
      f'the leverage shrinks exactly when it feels most tempting to pull harder.</p>'
      '</section>')
    A("</div>")

    # ---- flow chart ----
    if flow:
        A('<section class="card"><h2>Order flow</h2>'
          '<canvas id="flow" aria-label="Daily organic and inorganic orders"></canvas>'
          '<div class="legend">'
          '<span><i style="background:var(--accent)"></i>Organic</span>'
          '<span><i style="background:var(--muted)"></i>VVRO</span></div></section>')

    # ---- why it moved ----
    if dec.get("have_data") and dec.get("verdict") not in (None, "no_data"):
        A(f'<section class="card"><h2>Why flow moved</h2>'
          f'<p class="why">{E(dec.get("explanation", ""))}</p></section>')
    else:
        A('<section class="card"><h2>Why flow moved</h2>'
          '<p class="why">Unknown — no impression data. A fall in organic orders '
          'could be falling reach, falling click-through, or falling close rate, '
          'and those need opposite responses. This is the single most valuable '
          'missing input.</p></section>')

    # ---- tasks ----
    A(f'<section><h2>Do today &middot; {len(run["tasks"])} tasks</h2>'
      '<div class="tasks" style="margin-top:14px">')
    for t in run["tasks"]:
        tt = PRIORITY_TONE.get(t["priority"], "muted")
        A(f'<article class="task {tt}"><div class="task-top">'
          f'<span class="pri">{E(t["priority"])}</span><h3>{E(t["title"])}</h3></div>'
          f'<div class="chips">'
          f'<span class="chip">owner <b>{E(t["owner"])}</b></span>'
          f'<span class="chip">impact <b>{money(t["impact_usd"])}</b></span>'
          f'<span class="chip">effort <b>{t["effort_hours"]}h</b></span>'
          f'<span class="chip">confidence <b>{t["confidence"]:.0%}</b></span></div>'
          f'<p class="why">{E(t["why"])}</p>'
          '<ul class="steps">' +
          "".join(f"<li>{E(s)}</li>" for s in t["steps"] if s) + "</ul>")
        if t.get("playbook"):
            A(f'<p class="note">Script: <code>{E(t["playbook"])}</code></p>')
        A("</article>")
    A("</div></section>")

    # ---- numbers ----
    rows = [
        ("Organic orders/day (7d)", f'{h["ma7_now"]:.2f}',
         f'was {h["ma7_prior"]:.2f} 14d ago'),
        ("Total orders/day (7d)", f'{m["flow_7d"]["total_per_day"]:.2f}',
         f'{m["flow_7d"]["organic"]:.0f} organic + {m["flow_7d"]["vvro"]:.0f} VVRO'),
        ("VVRO share (7d)", f'{h["vvro_share_7d"]:.0%}', f"cap {share_cap:.0%}"),
        ("AOV", money(econ["aov"]),
         f'median {money(econ["median"])} · n={econ["n_priced"]}'),
        ("Inquiry conversion", f'{fun["conversion"]:.1%}',
         f'{fun["placed"]}/{fun["inquiries"]}'),
        ("Review capture", f'{econ["review_capture_rate"]:.1%}',
         f'of {econ.get("review_denominator", 0)} reviewable orders'),
        ("Upsell recorded", f'{econ["upsell_rate"]:.1%}',
         f'of {econ.get("upsell_denominator", 0)} orders with the column'),
    ]
    if h.get("structural_delta_pct") is not None:
        rows.insert(1, ("Organic since VVRO began",
                        f'{h["structural_post"]:.2f}/day',
                        f'was {h["structural_pre"]:.2f} '
                        f'({h["structural_delta_pct"]:+.1%})'))
    g = m.get("gig") or {}
    if g:
        rows.append(("Gig rating", f'{g.get("rating", 0):.3f}',
                     f'{g.get("reviews_total", 0):,} reviews · {g.get("level", "?")}'))
        rows.append(("Orders in queue", str(g.get("orders_in_queue", "?")),
                     "live from the gig page"))
    if dis.get("have_data"):
        rows.append(("Open disputes", str(dis.get("open_count", 0)),
                     f'{money(dis.get("open_exposure", 0))} exposed'))
    A('<section class="card"><h2>Where the business is</h2><div class="scroll"><table>'
      "<thead><tr><th>Metric</th><th>Value</th><th>Context</th></tr></thead><tbody>")
    for label, val, ctx in rows:
        A(f'<tr><td>{E(label)}</td><td class="n">{E(val)}</td>'
          f'<td class="n" style="color:var(--muted)">{E(ctx)}</td></tr>')
    A("</tbody></table></div>")
    if gap.get("status") == "behind":
        ra = gap["route_aov"]
        rv = gap["route_volume"]
        A(f'<p class="note">Projecting {money(proj.get("projected_revenue", 0))} over 30 '
          f'days — {money(gap["gap"])} behind target. Volume route needs '
          f'+{rv["extra_per_day"]:.2f} orders/day '
          f'({"feasible" if rv["feasible_organically"] else "not feasible under the cap"}); '
          f'AOV route needs {money(ra["required_aov"])} '
          f'({ra["uplift_vs_current"]:+.0%}).</p>')
    A("</section>")

    # ---- predictions ----
    if run.get("predictions"):
        A('<section class="card"><h2>Predictions</h2><div class="scroll"><table>'
          "<thead><tr><th>Resolves</th><th>Claim</th><th>80% interval</th>"
          "<th>Confidence</th></tr></thead><tbody>")
        for pr in run["predictions"]:
            A(f'<tr><td class="n">{E(pr["resolve_on"])}</td>'
              f'<td>{E(pr["statement"])}</td>'
              f'<td class="n">{pr["lo"]:.2f} &ndash; {pr["hi"]:.2f}</td>'
              f'<td class="n" style="color:var(--muted)">{E(pr["confidence"])}</td></tr>')
        A("</tbody></table></div>")
        A('<p class="note">Each is scored automatically on its resolution date. '
          'Interval widths are derived from realised coverage, so stated confidence '
          'converges on real accuracy.</p></section>')

    # ---- integrity ----
    A('<section class="card"><h2>System integrity</h2><div class="bars">')
    maxima = {"task_count": 10, "ownership": 20, "evidence": 25,
              "actionability": 15, "falsifiability": 20, "priority_spread": 10}
    for k, v in chk.get("rubric", {}).items():
        mx = maxima.get(k, 20)
        A(f'<div class="bar"><span>{E(k.replace("_", " "))}</span>'
          f'<span class="track"><span class="fill" style="width:'
          f'{(v / mx * 100) if mx else 0:.0f}%"></span></span>'
          f'<span class="v">{v:.0f}</span></div>')
    A("</div>")
    failed = [r for r in chk.get("results", []) if not r["passed"]]
    if failed:
        A('<p class="note"><strong>Not passing:</strong></p><ul class="steps">' +
          "".join(f'<li><code>{E(r["severity"])}</code> {E(r["name"])} &mdash; '
                  f'{E(r["detail"])}</li>' for r in failed) + "</ul>")
    if chk.get("repairs"):
        A('<p class="note"><strong>Auto-repairs:</strong> ' +
          "; ".join(E(r) for r in chk["repairs"]) + "</p>")
    A(f'<p class="note">Ingest saw {run["ingest"]["blocks_used"]} tables, '
      f'{run["ingest"]["unmapped_rate"]:.1%} of header cells unrecognised. '
      f'{run["validation"]["data_issues"]} source-data issues found — those become '
      f'tasks, they do not block the run.</p></section>')

    A(f'<footer>Generated {E(today)} &middot; read-only: no source sheet was '
      f'modified &middot; every number traces to a source row via '
      f'<code>reports/{E(today)}-run.json</code></footer></div>')

    chart = ""
    if flow:
        chart = f"""<script>
const FLOW={json.dumps(flow)};
function draw(){{
  const c=document.getElementById('flow'); if(!c) return;
  const dpr=window.devicePixelRatio||1, w=c.clientWidth, h=150;
  c.width=w*dpr; c.height=h*dpr;
  const x=c.getContext('2d'); x.scale(dpr,dpr); x.clearRect(0,0,w,h);
  const cs=getComputedStyle(document.documentElement);
  const accent=cs.getPropertyValue('--accent').trim();
  const muted=cs.getPropertyValue('--muted').trim();
  const hair=cs.getPropertyValue('--hair').trim();
  const pad=18, iw=w-pad*2, ih=h-pad*2;
  const max=Math.max(1,...FLOW.map(d=>Math.max(d.o,d.v)));
  x.strokeStyle=hair; x.lineWidth=1;
  for(let i=0;i<=2;i++){{const y=pad+ih*i/2;
    x.beginPath();x.moveTo(pad,y);x.lineTo(w-pad,y);x.stroke();}}
  const bw=Math.max(1,iw/FLOW.length-1.5);
  FLOW.forEach((d,i)=>{{
    const bx=pad+i*(iw/FLOW.length);
    if(d.v>0){{x.fillStyle=muted;const bh=ih*d.v/max;
      x.fillRect(bx,pad+ih-bh,bw,bh);}}
    if(d.o>0){{x.fillStyle=accent;const bh=ih*d.o/max;
      x.fillRect(bx,pad+ih-bh-(d.v>0?ih*d.v/max:0),bw,bh);}}
  }});
}}
draw();
addEventListener('resize',draw);
new MutationObserver(draw).observe(document.documentElement,
  {{attributes:true,attributeFilter:['data-theme']}});
matchMedia('(prefers-color-scheme:dark)').addEventListener('change',draw);
</script>"""

    # Title stays stable across daily redeploys — it names the artifact, and a
    # title that changes every morning reads as a different page each time.
    return ('<title>XStudioz — What Next</title>'
            f"<style>{CSS}</style>" + "".join(p) + chart)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--date", help="run date, default the newest report")
    ap.add_argument("--root", default=str(ROOT))
    ap.add_argument("--out", help="output path, default reports/dashboard.html")
    args = ap.parse_args()

    root = Path(args.root)
    reports = root / "reports"
    if args.date:
        run_path = reports / f"{args.date}-run.json"
    else:
        candidates = sorted(reports.glob("*-run.json"))
        if not candidates:
            print("[error] no run JSON in reports/. Run daily_run.py first.",
                  file=sys.stderr)
            return 2
        run_path = candidates[-1]
    if not run_path.exists():
        print(f"[error] {run_path} not found", file=sys.stderr)
        return 2

    run = json.loads(run_path.read_text(encoding="utf-8"))
    flow = load_flow(root, run["metrics"]["profile"])
    out = Path(args.out) if args.out else reports / "dashboard.html"
    out.write_text(render(run, flow, root), encoding="utf-8")
    print(f"wrote {out} ({out.stat().st_size / 1024:.0f} KB) from {run_path.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
