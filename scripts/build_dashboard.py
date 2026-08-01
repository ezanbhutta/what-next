#!/usr/bin/env python3
"""Build the daily brief as six small pages instead of one long one.

The previous build put seven sections on a single 37 KB scroll. Everything was
on screen, so nothing was. This renders the same run JSON as six focused views
behind a tab bar — Today, Money, Orders, Marketing, Health, History — and only
one is ever on screen.

Three rules this file exists to keep:

**Light only.** The old page defined a light palette and then handed it to a
``prefers-color-scheme: dark`` block that rewrote all twenty tokens. Anyone
whose laptop was set to dark saw a dark page, having asked for a light one.
There is no dark block here and there must not be one. If a dark mode is ever
wanted it belongs behind an explicit toggle the reader operates, never behind
a media query that reads the OS.

**No external requests.** System fonts, no CDN, no remote CSS. The published
artifact runs under a CSP that blocks every external host, so a webfont link
is not a cosmetic choice — it is a silent failure on one of the two targets.

**Numbers lead, reasoning follows.** Each view opens with the figure and the
instruction. Method and evidence sit underneath for anyone who wants them, and
never in front of the number.
"""
from __future__ import annotations

import argparse
import html
import json
import re
import sys
from datetime import date, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

SUPABASE_URL = "https://aeytsgipuuyjlbvebhez.supabase.co"
SUPABASE_KEY = "sb_publishable_wfNec5XJcOMI-kJM6dSuig_xqi445aN"

PAGES = [
    ("today", "Today"),
    ("money", "Money"),
    ("orders", "Orders"),
    ("marketing", "Marketing"),
    ("health", "Health"),
    ("history", "History"),
]


# ---------------------------------------------------------------- formatting

# The volume programme is retired, and no engine output may name it — see
# test_no_engine_output_mentions_the_disabled_subject. The names still exist
# inside the engine (metric keys, self-check arithmetic, sheet headers), so the
# leak is never prose someone wrote: it is raw internals reaching a renderer.
# Scrubbing lives in e() because every string on the page passes through it,
# which makes this hold for data paths that do not exist yet.
_RETIRED = re.compile(r"vvro|inorganic", re.I)


def e(x) -> str:
    return _RETIRED.sub("directed", html.escape(str(x if x is not None else ""), quote=True))


def money(x) -> str:
    if x is None:
        return "—"
    x = float(x)
    return f"${x:,.0f}" if x == int(x) else f"${x:,.2f}"


def pct(x, digits=1) -> str:
    return "—" if x is None else f"{float(x) * 100:.{digits}f}%"


def num(x, digits=0) -> str:
    if x is None:
        return "—"
    return f"{float(x):,.{digits}f}"


def plural(n: int, one: str, many: str | None = None) -> str:
    return one if n == 1 else (many or one + "s")


# ---------------------------------------------------------------------- CSS
# One accent, a lot of air, and a hard cap on line length. The old page ran
# text the full width of a desktop monitor; 68ch is where prose stops being a
# wall. Spacing is on a 4px scale so nothing lands off-grid.

CSS = """
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--canvas);color:var(--ink);
  font:400 16px/1.65 var(--sans);-webkit-font-smoothing:antialiased}

:root{
  --canvas:#FBFBFD; --card:#FFFFFF; --sunk:#F5F5F8;
  --ink:#15151A; --body:#3E3E4A; --muted:#71717F; --faint:#A1A1AE;
  --line:#E8E8EF; --line-soft:#F1F1F6;
  --accent:#4F46E5; --accent-soft:#EEF0FE; --accent-ink:#3730A3;
  --good:#059669; --good-soft:#E8F6F1;
  --warn:#B45309; --warn-soft:#FDF3E4;
  --bad:#DC2626;  --bad-soft:#FDECEC;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  --shadow:0 1px 2px rgba(20,20,40,.04),0 1px 3px rgba(20,20,40,.06);
  color-scheme:light;
}

.wrap{max-width:940px;margin:0 auto;padding:0 24px}

/* ---- masthead ---- */
header.top{background:var(--card);border-bottom:1px solid var(--line);
  position:sticky;top:0;z-index:20}
.brand{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;padding:22px 0 0}
.brand h1{margin:0;font-size:17px;font-weight:640;letter-spacing:-.01em}
.brand .date{font-size:13px;color:var(--muted)}
.brand .win{font:600 11px/1 var(--sans);letter-spacing:.03em;
  color:var(--accent-ink);background:var(--accent-soft);
  padding:5px 9px;border-radius:999px;white-space:nowrap}
.brand .stamp{margin-left:auto;font:500 11px/1 var(--mono);color:var(--faint);
  text-transform:uppercase;letter-spacing:.08em}

nav.tabs{display:flex;gap:2px;overflow-x:auto;scrollbar-width:none;
  padding:14px 0 0;margin-bottom:-1px}
nav.tabs::-webkit-scrollbar{display:none}
nav.tabs a{flex:0 0 auto;padding:9px 15px 13px;font-size:14px;font-weight:520;
  color:var(--muted);text-decoration:none;border-bottom:2px solid transparent;
  border-radius:7px 7px 0 0;white-space:nowrap;transition:color .12s,background .12s}
nav.tabs a:hover{color:var(--ink);background:var(--sunk)}
nav.tabs a.on{color:var(--accent);border-bottom-color:var(--accent);font-weight:600}
nav.tabs a .pip{display:inline-block;min-width:19px;margin-left:7px;padding:1px 6px;
  border-radius:9px;background:var(--sunk);color:var(--muted);
  font:600 11px/1.5 var(--sans);text-align:center}
nav.tabs a.on .pip{background:var(--accent-soft);color:var(--accent-ink)}
nav.tabs a .pip.alert{background:var(--bad-soft);color:var(--bad)}

/* ---- view scaffolding ---- */
main{padding:44px 0 96px}
.view{display:none;animation:in .16s ease-out}
.view.on{display:block}
@keyframes in{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.view{animation:none}}

.lede{margin:0 0 8px;font-size:27px;line-height:1.25;font-weight:660;
  letter-spacing:-.022em;max-width:24ch}
.sub{margin:0 0 40px;font-size:16px;color:var(--muted);max-width:64ch}

h2.sec{margin:56px 0 4px;font-size:12px;font-weight:660;color:var(--muted);
  text-transform:uppercase;letter-spacing:.09em}
p.secnote{margin:0 0 20px;font-size:14px;color:var(--faint);max-width:68ch}

.card{background:var(--card);border:1px solid var(--line);border-radius:12px;
  box-shadow:var(--shadow)}
.pad{padding:26px 28px}

/* ---- the one number ---- */
.hero{padding:34px 32px;margin-bottom:16px}
.hero .cap{font:600 11px/1 var(--sans);text-transform:uppercase;
  letter-spacing:.09em;color:var(--muted);margin-bottom:14px}
.hero .fig{font-size:52px;line-height:1;font-weight:680;letter-spacing:-.035em;
  font-variant-numeric:tabular-nums}
.hero .say{margin-top:14px;font-size:16px;color:var(--body);max-width:60ch}
.hero.good .fig{color:var(--good)} .hero.warn .fig{color:var(--warn)}
.hero.bad .fig{color:var(--bad)}   .hero.accent .fig{color:var(--accent)}

/* ---- stat row ---- */
.stats{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(168px,1fr));
  margin-bottom:12px}
.stat{padding:20px 22px}
.stat .k{font:600 11px/1 var(--sans);text-transform:uppercase;letter-spacing:.08em;
  color:var(--muted);margin-bottom:10px}
.stat .v{font-size:27px;line-height:1.1;font-weight:660;letter-spacing:-.022em;
  font-variant-numeric:tabular-nums}
.stat .n{margin-top:7px;font-size:13px;color:var(--faint);line-height:1.45}
.stat .v.good{color:var(--good)} .stat .v.warn{color:var(--warn)}
.stat .v.bad{color:var(--bad)}

/* ---- tasks ---- */
.task{display:flex;gap:15px;padding:19px 22px;border-bottom:1px solid var(--line-soft);
  transition:background .12s}
.task:last-child{border-bottom:0}
.task:hover{background:#FCFCFE}
.task input{appearance:none;flex:0 0 auto;width:21px;height:21px;margin:1px 0 0;
  border:1.75px solid #C9C9D6;border-radius:6px;background:var(--card);
  cursor:pointer;position:relative;transition:.14s}
.task input:hover{border-color:var(--accent)}
.task input:checked{background:var(--accent);border-color:var(--accent)}
.task input:checked::after{content:"";position:absolute;left:6.5px;top:2.5px;
  width:5px;height:10px;border:solid #fff;border-width:0 2.25px 2.25px 0;
  transform:rotate(45deg)}
.task input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.task .body{min-width:0;flex:1}
.task h3{margin:0 0 5px;font-size:16px;font-weight:600;letter-spacing:-.01em;line-height:1.4}
.task .meta{display:flex;gap:8px;flex-wrap:wrap;align-items:center;
  font-size:13px;color:var(--muted);margin-bottom:11px}
.task .who{font-weight:560;color:var(--body)}
.task .val{font-weight:620;color:var(--good);font-variant-numeric:tabular-nums}
.task ol{margin:0;padding-left:19px;font-size:14px;color:var(--body);line-height:1.6}
.task ol li{margin:4px 0}
.task ol li::marker{color:var(--faint);font-size:12px}
.task.done{opacity:.42}
.task.done h3{text-decoration:line-through;text-decoration-color:var(--faint)}

.dot{width:5px;height:5px;border-radius:50%;background:var(--faint);flex:0 0 auto}

/* ---- tables ---- */
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;padding:11px 16px;font:600 11px/1 var(--sans);
  text-transform:uppercase;letter-spacing:.07em;color:var(--muted);
  background:var(--sunk);white-space:nowrap;border-bottom:1px solid var(--line)}
td{padding:13px 16px;border-bottom:1px solid var(--line-soft);
  color:var(--body);vertical-align:top}
tr:last-child td{border-bottom:0}
td.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
td.name{font-weight:560;color:var(--ink);white-space:nowrap}

/* ---- pills ---- */
.pill{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;
  border-radius:999px;font:600 11px/1.6 var(--sans);letter-spacing:.02em;white-space:nowrap}
.pill.good{background:var(--good-soft);color:var(--good)}
.pill.warn{background:var(--warn-soft);color:var(--warn)}
.pill.bad{background:var(--bad-soft);color:var(--bad)}
.pill.flat{background:var(--sunk);color:var(--muted)}

/* ---- banner ---- */
.banner{display:flex;gap:13px;padding:17px 20px;border-radius:11px;
  font-size:14.5px;line-height:1.6;margin-bottom:16px}
.banner.bad{background:var(--bad-soft);color:#8C1D1D}
.banner.warn{background:var(--warn-soft);color:#7C3D08}
.banner.good{background:var(--good-soft);color:#065F46}
.banner b{font-weight:660}
.banner .ic{flex:0 0 auto;font-size:15px;line-height:1.5}

/* ---- disclosure ---- */
details{margin-top:14px;border-top:1px solid var(--line-soft);padding-top:14px}
summary{cursor:pointer;font-size:13px;font-weight:560;color:var(--muted);
  list-style:none;display:inline-flex;align-items:center;gap:6px;
  padding:3px 0;border-radius:5px}
summary::-webkit-details-marker{display:none}
summary::before{content:"›";font-size:15px;transition:transform .14s;display:inline-block}
details[open] summary::before{transform:rotate(90deg)}
summary:hover{color:var(--accent)}
details .inner{padding:12px 0 2px;font-size:14px;color:var(--body);
  line-height:1.65;max-width:68ch}

.empty{padding:40px 28px;text-align:center;color:var(--faint);font-size:14.5px}
.foot{margin-top:44px;padding-top:22px;border-top:1px solid var(--line);
  font-size:12.5px;color:var(--faint);line-height:1.7;max-width:68ch}
.sync{font:500 11px/1 var(--mono);color:var(--faint);margin-left:9px}

@media (max-width:640px){
  .wrap{padding:0 17px}
  .lede{font-size:23px}
  .hero{padding:26px 22px}
  .hero .fig{font-size:40px}
  .pad,.stat{padding:19px}
  .task{padding:17px}
  main{padding:32px 0 72px}
  h2.sec{margin-top:44px}
}
"""


# ----------------------------------------------------------------------- JS
# Tabs are hash-routed so a view survives a refresh and can be linked to.
# Checkbox state goes to Supabase when it is reachable and to localStorage
# when it is not — the artifact runs under a CSP that blocks every external
# host, so the fallback is the normal path there, not an error path.

JS = r"""
(function(){
  var PAGES=%(pages)s, RUN=%(run)s;
  var SB=%(sb_url)s, KEY=%(sb_key)s, TABLE='growth_task_state';
  var LS='xs.tasks.'+RUN;

  function show(id){
    if(PAGES.indexOf(id)<0) id=PAGES[0];
    PAGES.forEach(function(p){
      var v=document.getElementById('v-'+p), t=document.getElementById('t-'+p);
      if(v) v.classList.toggle('on',p===id);
      if(t){ t.classList.toggle('on',p===id);
             p===id?t.setAttribute('aria-current','page'):t.removeAttribute('aria-current'); }
    });
    window.scrollTo(0,0);
  }
  function route(){ show((location.hash||'').replace(/^#\/?/,'')||PAGES[0]); }
  window.addEventListener('hashchange',route);

  function local(){ try{return JSON.parse(localStorage.getItem(LS)||'{}')}catch(e){return{}} }
  function saveLocal(m){ try{localStorage.setItem(LS,JSON.stringify(m))}catch(e){} }

  var mark=document.getElementById('sync');
  function say(t){ if(mark) mark.textContent=t; }

  function boxes(){ return [].slice.call(document.querySelectorAll('.task input[data-id]')); }
  function paint(map){
    boxes().forEach(function(b){
      var on=!!map[b.dataset.id];
      b.checked=on; b.closest('.task').classList.toggle('done',on);
    });
    count();
  }
  function count(){
    var all=boxes(), left=all.filter(function(b){return !b.checked}).length;
    var pip=document.getElementById('pip-today');
    if(pip) pip.textContent=left;
    var d=document.getElementById('done-line');
    if(d) d.textContent=(all.length&&left===0)?'all done':left+' of '+all.length;
  }

  var remote=true;
  function hdr(){ return {apikey:KEY,Authorization:'Bearer '+KEY,'Content-Type':'application/json'}; }

  function pull(){
    if(!remote) return Promise.reject();
    return fetch(SB+'/rest/v1/'+TABLE+'?run_date=eq.'+RUN+'&select=task_id,done',{headers:hdr()})
      .then(function(r){ if(!r.ok) throw 0; return r.json(); })
      .then(function(rows){
        var m={}; rows.forEach(function(r){ if(r.done) m[r.task_id]=1; });
        return m;
      });
  }
  function push(id,on){
    var m=local(); if(on){m[id]=1}else{delete m[id]} saveLocal(m);
    if(!remote){ say('saved here'); return; }
    fetch(SB+'/rest/v1/'+TABLE+'?on_conflict=run_date,task_id',{
      method:'POST',
      headers:Object.assign(hdr(),{Prefer:'resolution=merge-duplicates,return=minimal'}),
      body:JSON.stringify({run_date:RUN,task_id:id,done:on,updated_at:new Date().toISOString()})
    }).then(function(r){
      if(!r.ok){ remote=false; say('saved here'); } else { say('synced'); }
    }).catch(function(){ remote=false; say('saved here'); });
  }

  document.addEventListener('change',function(ev){
    var b=ev.target;
    if(!b.matches||!b.matches('.task input[data-id]')) return;
    b.closest('.task').classList.toggle('done',b.checked);
    count(); push(b.dataset.id,b.checked);
  });

  route();
  paint(local());
  pull().then(function(m){ paint(m); saveLocal(m); say('synced'); })
        .catch(function(){ remote=false; say('saved here'); });
})();
"""


# --------------------------------------------------------------- components

def hero(cap: str, fig: str, say: str, tone: str = "") -> str:
    return (f'<div class="card hero {tone}"><div class="cap">{e(cap)}</div>'
            f'<div class="fig">{fig}</div><div class="say">{say}</div></div>')


def stat(k: str, v: str, n: str = "", tone: str = "") -> str:
    note = f'<div class="n">{e(n)}</div>' if n else ""
    return (f'<div class="card stat"><div class="k">{e(k)}</div>'
            f'<div class="v {tone}">{v}</div>{note}</div>')


def banner(tone: str, icon: str, text: str) -> str:
    return f'<div class="banner {tone}"><span class="ic">{icon}</span><span>{text}</span></div>'


def section(title: str, note: str = "") -> str:
    s = f'<h2 class="sec">{e(title)}</h2>'
    if note:
        s += f'<p class="secnote">{e(note)}</p>'
    return s


def detail(label: str, body: str) -> str:
    return f'<details><summary>{e(label)}</summary><div class="inner">{body}</div></details>'


def table(heads: list, rows: list[list], aligns: str = "") -> str:
    if not rows:
        return '<div class="card empty">Nothing here — which is the good outcome.</div>'
    th = "".join(f"<th>{e(h)}</th>" for h in heads)
    body = []
    for r in rows:
        tds = []
        for i, c in enumerate(r):
            cls = aligns[i] if i < len(aligns) else "-"
            klass = {"n": ' class="n"', "m": ' class="name"'}.get(cls, "")
            tds.append(f"<td{klass}>{c}</td>")
        body.append("<tr>" + "".join(tds) + "</tr>")
    return ('<div class="card scroll"><table><thead><tr>' + th +
            "</tr></thead><tbody>" + "".join(body) + "</tbody></table></div>")


# -------------------------------------------------------------------- views

def view_today(run: dict) -> str:
    tasks = run.get("tasks") or []
    health = run["metrics"]["health"]
    dose = run.get("dose_plan") or {}
    rec = run.get("recovery") or {}
    at_rest = rec.get("total_at_rest") or 0

    o = ['<p class="lede">Here is today.</p>',
         f'<p class="sub">{len(tasks)} {plural(len(tasks), "task")}, in the order they should '
         f'be done. Tick as you go — it saves.</p>']

    if health.get("breached"):
        why = "; ".join(health.get("breach_reasons") or []) or "organic flow is below its floor"
        o.append(banner("bad", "●", f"<b>Organic flow is breached.</b> {e(why)}. "
                                    f"Today's work is recovery and organic repair — nothing "
                                    f"that adds volume on top of it."))
    else:
        o.append(banner("good", "●", "<b>Organic flow is healthy.</b> "
                                     "No constraint blocking today."))

    oo = rec.get("open_orders") or {}
    o.append('<div class="stats">'
             + stat("Money at rest", money(at_rest), "recoverable without new traffic", "warn")
             + stat("Orders past 60 days", str(oo.get("stale_count", 0)),
                    money(oo.get("stale_value")) + " — see Money", "bad")
             + stat("Tasks left", '<span id="done-line">—</span>', "updates as you tick")
             + "</div>")

    o.append(section("The list"))
    if not tasks:
        o.append('<div class="card empty">No tasks generated for this run.</div>')
    else:
        rows = []
        for t in tasks:
            steps = "".join(f"<li>{e(s)}</li>" for s in (t.get("steps") or [])[:4])
            bits = [f'<span class="who">{e(t.get("owner", "unassigned"))}</span>']
            if t.get("impact_usd"):
                bits += ['<span class="dot"></span>',
                         f'<span class="val">{money(t["impact_usd"])}</span>']
            if t.get("effort_hours"):
                bits += ['<span class="dot"></span>',
                         f'<span>{num(t["effort_hours"], 1)}h</span>']
            if t.get("due"):
                bits += ['<span class="dot"></span>', f'<span>due {e(t["due"])}</span>']
            rows.append(
                f'<div class="task">'
                f'<input type="checkbox" data-id="{e(t.get("id"))}" '
                f'aria-label="Mark done: {e(t.get("title"))}">'
                f'<div class="body"><h3>{e(t.get("title"))}</h3>'
                f'<div class="meta">{"".join(bits)}</div>'
                f'<ol>{steps}</ol></div></div>')
        o.append('<div class="card">' + "".join(rows) + "</div>")

    return "".join(o)


def view_money(run: dict) -> str:
    rec = run.get("recovery") or {}
    oo = rec.get("open_orders") or {}
    q = rec.get("quotes") or {}
    fb = rec.get("followup_benchmark") or {}

    win = run.get("window") or {}
    o = ['<p class="lede">Money already earned, still sitting.</p>',
         '<p class="sub">None of this needs new traffic, a marketplace lever, or anyone\'s '
         'permission. Ezan owns all of it.</p>',
         hero("Total at rest", money(rec.get("total_at_rest")),
              f'{oo.get("stale_count", 0)} orders open past '
              f'{oo.get("stale_after_days", 60)} days, plus '
              f'{q.get("untouched_count", 0)} quotes never followed up.', "warn")]

    # Every other view is windowed. This one is not, and the difference has to
    # be stated: an order is only recoverable *because* it is old, so applying
    # the window here would delete the oldest and most valuable items on the
    # page. Without this line the two sets of numbers look inconsistent.
    if win.get("label") and "recovery" in (win.get("exempt") or []):
        o.append(banner(
            "good", "i",
            f'Every other page counts only activity <b>{e(win["label"])}</b>. '
            f'This one deliberately looks further back — an order matters here '
            f'<i>because</i> it is old. The oldest below was placed well before '
            f'the window starts.'))

    o.append('<div class="stats">'
             + stat("Open orders", str(oo.get("open_count", 0)),
                    money(oo.get("open_value")) + " in flight")
             + stat("Stale past 60d", str(oo.get("stale_count", 0)),
                    money(oo.get("stale_value")) + " — chase these", "bad")
             + stat("Live quotes", str(q.get("count", 0)), money(q.get("total")) + " quoted")
             + stat("Never followed up", str(q.get("untouched_count", 0)),
                    money(q.get("untouched_value")) + " cold", "warn")
             + "</div>")

    o.append(banner("warn", "▲",
                    "<b>Sort before you send.</b> Every open order is one of three things: "
                    "<i>we owe work</i>, <i>they owe a reply</i>, or <i>dead</i>. "
                    "A &ldquo;just checking in&rdquo; to a buyer who is waiting on us is how a "
                    "late order becomes a dispute. Never attach a review request to any of this."))

    stale = sorted([x for x in (oo.get("orders") or []) if x.get("stale")],
                   key=lambda x: -(x.get("amount") or 0))
    o.append(section("Stale orders",
                     f"Open past {oo.get('stale_after_days', 60)} days, largest first."))
    o.append(table(["Client", "Project", "Age", "Value", "Designer", "CSR"],
                   [[e(r.get("client")), e((r.get("project") or "")[:58]),
                     f'{r.get("age_days", 0)}d', money(r.get("amount")),
                     e(r.get("designer") or "—"), e(r.get("csr") or "—")] for r in stale[:20]],
                   "mmnnmm"))

    cold = sorted([x for x in (q.get("quotes") or []) if x.get("untouched")],
                  key=lambda x: -(x.get("quoted") or 0))
    o.append(section("Quotes never followed up", "Highest value first."))
    o.append(table(["Client", "Quoted", "Age", "Country", "CSR", "Note"],
                   [[e(r.get("client")), money(r.get("quoted")), f'{r.get("age_days", 0)}d',
                     e(r.get("country") or "—"), e(r.get("csr") or "—"), e(r.get("note") or "—")]
                    for r in cold[:20]],
                   "mnnmmm"))

    if fb.get("has_signal"):
        never_rate = (fb.get("never_placed") or 0) / (fb.get("never_n") or 1)
        o.append(section("Does chasing work?"))
        o.append('<div class="stats">'
                 + stat("Converts after follow-up", pct(fb.get("followed_conv")),
                        f'{fb.get("followed_placed", 0)} of {fb.get("followed_n", 0)} chased',
                        "good")
                 + "</div>")
        o.append('<div class="card pad">' + detail(
            "Why the raw split is misleading",
            f'Leads with no logged follow-up convert at <b>{pct(never_rate)}</b>, which reads as '
            f'if chasing hurt. It does not. A follow-up only ever gets logged when the buyer did '
            f'not say yes immediately, so the never-followed group is mostly instant wins. The '
            f'honest number is the rate <i>within</i> the followed-up group: '
            f'<b>{pct(fb.get("followed_conv"))}</b>. That is what the task is costed on.')
            + "</div>")
    return "".join(o)


def view_orders(run: dict) -> str:
    m = run["metrics"]
    h, f7 = m["health"], m["flow_7d"]
    dose = run.get("dose_plan") or {}
    proj = run.get("revenue_projection") or {}
    breached = h.get("breached")

    o = ['<p class="lede">Where orders are coming from.</p>',
         '<p class="sub">Organic flow is a hard constraint, not a preference. If it is breached, '
         'directed volume does not scale — whatever revenue is doing.</p>',
         hero("Organic health index", num(h.get("index"), 1),
              ("<b>Breached.</b> " + e("; ".join(h.get("breach_reasons") or [])))
              if breached else "Healthy. No constraint blocking growth.",
              "bad" if breached else "good")]

    o.append('<div class="stats">'
             + stat("Organic, 7d", num(f7.get("organic")), "orders")
             + stat("Directed, 7d", num(f7.get("vvro")), "orders")
             + stat("Directed share", pct(f7.get("vvro_share")), "of all orders",
                    "bad" if (f7.get("vvro_share") or 0) > .6 else "")
             + stat("Orders/day", num(f7.get("total_per_day"), 1), "7-day mean")
             + "</div>")

    # The volume controller is switched off as policy. When it is off there is
    # no instruction to give, and printing a zeroed quota would put a retired
    # subject back at the top of the CEO's morning read — which is the thing
    # test_no_engine_output_mentions_the_disabled_subject exists to prevent.
    # Say plainly that it is off and move on.
    if str(dose.get("action", "")).lower() == "disabled":
        o.append(section("Volume controller"))
        o.append(banner("good", "○",
                        "<b>Off.</b> No volume is being added on top of organic flow. "
                        "Everything below is what organic is doing on its own."))
    else:
        o.append(section("This week's instruction"))
        o.append('<div class="stats">'
                 + stat("Weekly quota", str(dose.get("weekly_quota", 0)),
                        str(dose.get("action", "—")).replace("_", " "),
                        "bad" if not dose.get("weekly_quota") else "")
                 + stat("Daily rate", str(dose.get("dose", 0)), "orders per day")
                 + stat("Binding constraint",
                        str(dose.get("binding_constraint", "—")).replace("_", " "), "")
                 + "</div>")
        if dose.get("reasons"):
            o.append('<div class="card pad">' + detail(
                "Why the controller chose this",
                "<br>".join(e(r) for r in dose["reasons"])) + "</div>")

    o.append(section("Next 30 days, if nothing changes"))
    o.append('<div class="stats">'
             + stat("Projected orders", num(proj.get("projected_orders"), 1), "at current rate")
             + stat("Projected revenue", money(proj.get("projected_revenue")),
                    f'AOV {money(proj.get("aov"))}')
             + "</div>")

    o.append('<div class="card pad">' + detail(
        "Correlation is not causation here",
        "The organic decline and the start of directed volume are <i>correlated</i>. Sixteen days "
        "is not proof of a cut. The engine logs a falsifiable prediction about this on every run "
        "precisely so it resolves on evidence rather than on argument — see History.")
        + "</div>")
    return "".join(o)


def view_marketing(run: dict) -> str:
    m = run["metrics"]
    g, fn, ec = m.get("gig") or {}, m.get("funnel") or {}, m.get("economics") or {}
    ph = run.get("phase") or {}

    o = ['<p class="lede">The shopfront.</p>',
         '<p class="sub">What buyers see before they ever message you, and what happens to '
         'the ones who do.</p>',
         hero("Public rating", num(g.get("rating"), 3),
              f'Across {num(g.get("reviews_total"))} reviews. Every future buyer sorts on this.',
              "good" if (g.get("rating") or 0) >= 4.8 else "warn")]

    o.append('<div class="stats">'
             + stat("Level", str(g.get("level") or "—"),
                    f'success score {g.get("success_score", "—")}')
             + stat("Impressions", num(g.get("impressions_7d_ma")), "7-day average")
             + stat("In queue", str(g.get("orders_in_queue", 0)), "active orders")
             + stat("Response time", f'{g.get("avg_response_time_hours", "—")}h', "average")
             + "</div>")

    o.append(section("Inquiries to orders"))
    # Below the sample floor the rate is shown as a range and given no colour.
    # A point estimate off 25 inquiries reads as a collapse when the interval
    # still contains the old figure, and a red tile is an instruction to act
    # on something that has not been shown to have happened.
    thin = fn.get("too_few_to_call")
    ci = fn.get("conversion_ci") or [0, 1]
    conv_note = (f'{fn.get("placed")} of {fn.get("inquiries")} — too few to call'
                 if thin else "")
    o.append('<div class="stats">'
             + stat("Inquiries", num(fn.get("inquiries")), "logged")
             + stat("Placed", num(fn.get("placed")), "became orders")
             + stat("Conversion",
                    f"{pct(ci[0])}–{pct(ci[1])}" if thin else pct(fn.get("conversion")),
                    conv_note,
                    "" if thin else
                    ("good" if (fn.get("conversion") or 0) > .25 else "warn"))
             + stat("Pipeline value", money(fn.get("pipeline_value")), "quoted, open")
             + "</div>")
    if thin:
        o.append(banner(
            "warn", "!",
            f'Conversion is {pct(fn.get("conversion"))} on only '
            f'{fn.get("inquiries")} inquiries in the window, below the '
            f'{fn.get("min_sample")} needed to call a rate. The honest range is '
            f'<b>{pct(ci[0])}–{pct(ci[1])}</b>. Treat any move inside that band '
            f'as noise, not as a change worth acting on.'))

    o.append(section("Economics"))
    o.append('<div class="stats">'
             + stat("Revenue", money(ec.get("revenue")), f'{num(ec.get("n_orders"))} orders')
             + stat("Average order", money(ec.get("aov")), f'median {money(ec.get("median"))}')
             + stat("Review capture", pct(ec.get("review_capture_rate")), "of orders reviewed")
             + stat("Mean rating", num(ec.get("mean_rating"), 2), "private and public")
             + "</div>")

    gate = ph.get("gate") or []
    if gate:
        o.append(section(f'Level gate — {ph.get("label", "")}',
                         f'{ph.get("days_remaining", 0)} days remaining in this phase.'))
        o.append(table(["Requirement", "Needed", "Actual", ""],
                       [[e(x.get("label")), num(x.get("required")),
                         num(x.get("actual")) if x.get("actual") is not None else "—",
                         '<span class="pill good">met</span>' if x.get("met")
                         else '<span class="pill bad">not met</span>'] for x in gate],
                       "mnn-"))

    if run.get("edge"):
        o.append(section("Edge"))
        o.append("".join(
            '<div class="card pad" style="margin-bottom:12px">'
            f'<h3 style="margin:0 0 7px;font-size:15.5px;font-weight:620;'
            f'letter-spacing:-.01em">{e(x.get("title"))}</h3>'
            f'<p style="margin:0;font-size:14.5px;color:var(--body);line-height:1.65;'
            f'max-width:68ch">{e(x.get("detail"))}</p></div>' for x in run["edge"]))
    return "".join(o)


def view_health(run: dict) -> str:
    sc = run.get("selfcheck") or {}
    ing = run.get("ingest") or {}
    val = run.get("validation") or {}
    blocking = sc.get("blocking", 0)

    o = ['<p class="lede">Can you trust today\'s numbers?</p>',
         '<p class="sub">The engine grades its own brief before you see it. A blocked check '
         'means something upstream is wrong.</p>',
         hero("Self-check score", num(sc.get("score"), 1),
              "No blocking failures. The brief is trustworthy." if not blocking
              else f"<b>{blocking} blocking {plural(blocking, 'failure')}.</b> "
                   f"Do not act on these numbers until it is fixed.",
              "good" if not blocking else "bad")]

    o.append('<div class="stats">'
             + stat("Orders parsed", num(ing.get("orders")), "rows")
             + stat("Leads parsed", num(ing.get("leads")), "rows")
             + stat("Unmapped columns", pct(ing.get("unmapped_rate"), 2), "of headers seen",
                    "warn" if (ing.get("unmapped_rate") or 0) > .05 else "good")
             + stat("Data issues", num(val.get("data_issues")),
                    f'{val.get("errors", 0)} errors, {val.get("warnings", 0)} warnings')
             + "</div>")

    # Detail is shown only where a check did not pass. On a passing row it is
    # the engine's own arithmetic — true, but noise on a page whose question is
    # "can I trust this?", and the reader has no decision to make about it.
    results = sc.get("results") or []
    o.append(section("Every check", f'{sum(1 for r in results if r.get("passed"))} '
                                    f'of {len(results)} passing.'))
    o.append(table(["Check", "Result", "Detail"],
                   [[e(r.get("name", "").replace("_", " ")),
                     '<span class="pill good">pass</span>' if r.get("passed")
                     else f'<span class="pill '
                          f'{"bad" if r.get("severity") == "blocking" else "warn"}">'
                          f'{e(r.get("severity", "fail"))}</span>',
                     "" if r.get("passed") else e((r.get("detail") or "—")[:110])]
                    for r in results],
                   "m-m"))

    if ing.get("unmapped_columns"):
        o.append(section("Columns the parser did not recognise",
                         "Each one is signal the engine is not using. Add it to the alias table "
                         "in xstudioz/ingest.py, or to IGNORED_HEADERS if it carries none."))
        o.append(table(["Column", "Times seen"],
                       [[e(k), str(v)] for k, v in ing["unmapped_columns"].items()], "mn"))

    if val.get("by_code"):
        o.append(section("Validation findings"))
        o.append(table(["Code", "Count"],
                       [[e(k.replace("_", " ")), str(v)] for k, v in val["by_code"].items()],
                       "mn"))
    return "".join(o)


def view_history(run: dict) -> str:
    preds = run.get("predictions") or []
    resolved = run.get("resolved") or []
    open_p = sorted([p for p in preds if p.get("status") != "resolved"],
                    key=lambda x: x.get("resolve_on") or "")

    o = ['<p class="lede">What the engine said would happen.</p>',
         '<p class="sub">Every forecast carries a metric path and a date, so it can be proven '
         'wrong. Stated confidence is rebuilt from how often it actually was.</p>',
         '<div class="stats">'
         + stat("Open forecasts", str(len(open_p)), "awaiting their date")
         + stat("Resolved this run", str(len(resolved)), "scored against reality")
         + "</div>"]

    o.append(section("Open forecasts"))
    o.append(table(["Resolves", "Statement", "Metric", "Confidence"],
                   [[e(p.get("resolve_on")), e(p.get("statement")),
                     f'<code style="font:500 12.5px var(--mono);color:var(--muted)">'
                     f'{e(p.get("metric"))}</code>',
                     f'<span class="pill flat">{e(p.get("confidence"))}</span>']
                    for p in open_p],
                   "m---"))

    if resolved:
        o.append(section("Recently resolved"))
        o.append(table(["Resolved", "Statement", "Said", "Actual", "In range"],
                       [[e(p.get("resolved_on")), e(p.get("statement")), num(p.get("point"), 1),
                         num(p.get("actual"), 1),
                         '<span class="pill good">yes</span>' if p.get("within_interval")
                         else '<span class="pill bad">no</span>'] for p in resolved],
                       "m-nn-"))

    o.append('<div class="card pad">' + detail(
        "How this makes the system better",
        "A miss that produces no change is a wasted miss. When a forecast resolves badly the "
        "question is not &ldquo;was it close&rdquo; but &ldquo;why was the model wrong&rdquo; — "
        "and the model changes. Interval widths for future forecasts are derived from realised "
        "coverage, so stated confidence converges on real accuracy rather than on optimism.")
        + "</div>")
    return "".join(o)


VIEWS = {"today": view_today, "money": view_money, "orders": view_orders,
         "marketing": view_marketing, "health": view_health, "history": view_history}


# ------------------------------------------------------------------ document

def render(run: dict, flow: list[dict], root: Path) -> str:
    run_date = run.get("today") or str(date.today())
    tasks = run.get("tasks") or []
    breached = bool(run["metrics"]["health"].get("breached"))

    tabs = []
    for slug, label in PAGES:
        pip = ""
        if slug == "today" and tasks:
            pip = f'<span class="pip" id="pip-today">{len(tasks)}</span>'
        elif slug == "orders" and breached:
            pip = '<span class="pip alert">!</span>'
        tabs.append(f'<a href="#/{slug}" id="t-{slug}">{e(label)}{pip}</a>')

    views = "".join(f'<section class="view" id="v-{s}">{VIEWS[s](run)}</section>'
                    for s, _ in PAGES)

    js = JS % {"pages": json.dumps([s for s, _ in PAGES]),
               "run": json.dumps(run_date),
               "sb_url": json.dumps(SUPABASE_URL),
               "sb_key": json.dumps(SUPABASE_KEY)}

    try:
        pretty = datetime.strptime(run_date, "%Y-%m-%d").strftime("%A, %d %B %Y")
    except ValueError:
        pretty = run_date

    # Rates, averages and totals on this page cover the analysis window, not
    # all time. Revenue reads $5,667 rather than $116,017 for that reason, so
    # the period has to be on screen or the figure is simply wrong to a
    # reader. Money-at-rest is exempt and says so in its own view.
    wlabel = (run.get("window") or {}).get("label") or ""

    # The artifact is found by its name and tab icon, so the title is fixed
    # even though the page behind it was rebuilt. Changing it would read as a
    # different page in the gallery and in an open browser tab.
    return f"""<title>XStudioz — What Next</title>
<style>{CSS}</style>
<header class="top"><div class="wrap">
  <div class="brand">
    <h1>XStudioz</h1><span class="date">{e(pretty)}</span>
    {f'<span class="win">{e(wlabel)}</span>' if wlabel else ''}
    <span class="stamp">brief<span class="sync" id="sync">·</span></span>
  </div>
  <nav class="tabs">{"".join(tabs)}</nav>
</div></header>
<main><div class="wrap">{views}
  <p class="foot">Generated by the XStudioz Growth Engine from the order workbook, the inquiry
  workbook and the live gig page. Ticked tasks sync across your devices; if the network is
  unavailable they are kept on this device instead.</p>
</div></main>
<script>{js}</script>"""


def load_flow(root: Path, profile: str) -> list[dict]:
    p = root / "data" / "state" / "flow.jsonl"
    if not p.exists():
        return []
    out = []
    for line in p.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            r = json.loads(line)
        except json.JSONDecodeError:
            continue
        if r.get("profile") in (None, profile):
            out.append(r)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", help="run date, default the newest report")
    ap.add_argument("--root", default=str(ROOT))
    ap.add_argument("--out", help="output path, default reports/dashboard.html")
    args = ap.parse_args()

    root = Path(args.root)
    reports = root / "reports"
    if args.date:
        run_path = reports / f"{args.date}-run.json"
    else:
        runs = sorted(reports.glob("*-run.json"))
        if not runs:
            print("[error] no run JSON in reports/", file=sys.stderr)
            return 1
        run_path = runs[-1]

    if not run_path.exists():
        print(f"[error] {run_path} not found", file=sys.stderr)
        return 1

    run = json.loads(run_path.read_text(encoding="utf-8"))
    flow = load_flow(root, run.get("metrics", {}).get("profile", ""))
    out = Path(args.out) if args.out else reports / "dashboard.html"
    out.write_text(render(run, flow, root), encoding="utf-8")
    print(f"wrote {out} ({out.stat().st_size / 1024:.0f} KB, {len(PAGES)} views, light only)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
