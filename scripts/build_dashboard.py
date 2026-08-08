#!/usr/bin/env python3
"""Build the daily brief as six small pages instead of one long one.

The previous build put seven sections on a single 37 KB scroll. Everything was
on screen, so nothing was. This renders the same run JSON as six focused views
behind a tab bar — Today, Money, Orders, Marketing, Health, History — and only
one is ever on screen.

Three rules this file exists to keep:

**The reader picks the theme, never the OS.** The page ships dark by default
with a light palette behind a toggle in the header, remembered in
``localStorage`` under ``xs-theme`` and applied by an inline script before
first paint so the wrong palette never flashes. What must never come back is
the ``prefers-color-scheme`` block that used to rewrite all twenty tokens:
that handed a stated product decision to the reader's operating system, and
everyone whose laptop was set to dark opened a dark page having asked for a
light one. Two palettes, one attribute, one button.

**No external requests.** No CDN, no remote CSS, no webfont link. Inter and
JetBrains Mono are base64-embedded from ``assets/fonts/``. The published
artifact runs under a CSP that blocks every external host, so a link to
fonts.googleapis.com renders on Vercel and silently falls back to a system
face on the artifact — a design that looks like it was never applied. The
bytes travel inside the file so both targets render identically.

**Numbers lead, reasoning follows.** Each view opens with the figure and the
instruction. Method and evidence sit underneath for anyone who wants them, and
never in front of the number.
"""
from __future__ import annotations

import argparse
import base64
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


def _daymon(iso: str | None) -> str:
    """'2026-08-07' -> '7 Aug'. Returns the input unchanged if it is not a
    date, rather than raising inside a card and taking the page with it."""
    if not iso:
        return "—"
    try:
        return datetime.strptime(str(iso)[:10], "%Y-%m-%d").strftime("%-d %b")
    except (ValueError, TypeError):
        return str(iso)


# ---------------------------------------------------------------------- FONTS
# Inter for the interface, JetBrains Mono for anything a reader compares down a
# column: figures, dates, ids. Both are the latin subset of the variable font,
# base64-embedded rather than linked.
#
# The embedding is not a preference. This page ships to two targets, and one of
# them (the published artifact) runs under a CSP that blocks every external
# host. A <link> to fonts.googleapis.com renders perfectly on Vercel and
# silently falls back to a system font on the artifact, which is the worst kind
# of failure: it looks like a design that was never applied. So the bytes
# travel inside the file, tests/test_engine.py asserts no external host appears
# in the output, and the two targets render identically.
#
# 106 KB of base64 for both faces. That is the price of the page looking the
# same everywhere, paid once per load.

def _font_face(family: str, path: Path, weights: str) -> str:
    """One @font-face with the file inlined as a data: URI."""
    if not path.exists():
        # Never fabricate a font. Without the file the stack falls through to
        # the system face and the page still renders; a broken data: URI would
        # give the browser something to fail at instead.
        return ""
    b64 = base64.b64encode(path.read_bytes()).decode("ascii")
    return (f"@font-face{{font-family:'{family}';font-style:normal;"
            f"font-weight:{weights};font-display:swap;"
            f"src:url(data:font/woff2;base64,{b64}) format('woff2')}}")


def fonts_css(root: Path) -> str:
    d = root / "assets" / "fonts"
    return (_font_face("Inter", d / "inter-latin-var.woff2", "400 700")
            + _font_face("JetBrains Mono", d / "jetbrains-mono-latin-var.woff2", "400 600"))


# ---------------------------------------------------------------------- CSS
#
# TWO THEMES, AND NEITHER OF THEM IS THE OPERATING SYSTEM'S CHOICE
#
# The page used to define a light palette and hand it to a
# `@media (prefers-color-scheme: dark)` block that rewrote all twenty tokens.
# Nothing in the source looked wrong, so it passed review twice, and everyone
# whose laptop was set to dark opened a dark page they had explicitly not
# asked for.
#
# The lesson was never "no dark mode". It was that a stated product decision
# does not belong in a media query. So there are two palettes here, dark is
# the default, and the ONLY thing that switches them is a button the reader
# presses. `data-theme` on <html> is the switch; there is no
# prefers-color-scheme rule anywhere in this file and
# test_no_output_lets_the_os_pick_the_colour_scheme keeps it that way.
#
# Spacing is on a 4px scale. Prose stops at 68ch, because the old page ran
# text the full width of a monitor and a 140-character line is not read, it is
# skimmed.

CSS = """
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}

/* ---- tokens: dark is the default, the toggle sets data-theme ---- */
:root,:root[data-theme="dark"]{
  --canvas:#0B0F17; --canvas-2:#0E131F;
  --card:rgba(22,28,45,.75); --card-solid:#161C2D; --sunk:rgba(255,255,255,.03);
  --glass:blur(12px);
  --ink:#F1F5F9; --body:#CBD5E1; --muted:#94A3B8; --faint:#64748B;
  --line:rgba(255,255,255,.08); --line-soft:rgba(255,255,255,.05);
  --accent:#6366F1; --accent-ink:#A5B4FC; --accent-soft:rgba(99,102,241,.14);
  --good:#10B981; --good-ink:#6EE7B7; --good-soft:rgba(16,185,129,.13);
  --warn:#F59E0B; --warn-ink:#FCD34D; --warn-soft:rgba(245,158,11,.13);
  --bad:#EF4444;  --bad-ink:#FCA5A5;  --bad-soft:rgba(239,68,68,.13);
  --info:#38BDF8; --info-soft:rgba(56,189,248,.13);
  --shadow:0 1px 2px rgba(0,0,0,.4),0 8px 24px -6px rgba(0,0,0,.5);
  --shadow-lift:0 12px 32px -8px rgba(0,0,0,.6);
  --ring:rgba(99,102,241,.35);
  color-scheme:dark;
}
:root[data-theme="light"]{
  --canvas:#F8FAFC; --canvas-2:#F1F5F9;
  --card:#FFFFFF; --card-solid:#FFFFFF; --sunk:#F1F5F9;
  --glass:blur(12px);
  --ink:#0F172A; --body:#334155; --muted:#64748B; --faint:#94A3B8;
  --line:#E2E8F0; --line-soft:#EFF3F8;
  --accent:#4F46E5; --accent-ink:#3730A3; --accent-soft:#EEF0FE;
  --good:#059669; --good-ink:#047857; --good-soft:#E8F6F1;
  --warn:#B45309; --warn-ink:#92400E; --warn-soft:#FDF3E4;
  --bad:#DC2626;  --bad-ink:#991B1B;  --bad-soft:#FDECEC;
  --info:#0284C7; --info-soft:#E0F2FE;
  --shadow:0 10px 30px -5px rgba(0,0,0,.05),0 1px 2px rgba(15,23,42,.04);
  --shadow-lift:0 18px 40px -10px rgba(0,0,0,.10);
  --ring:rgba(79,70,229,.30);
  color-scheme:light;
}

body{margin:0;background:var(--canvas);color:var(--ink);
  font:400 16px/1.65 var(--sans);-webkit-font-smoothing:antialiased;
  font-variant-numeric:tabular-nums;
  transition:background .18s ease,color .18s ease}

/* An ambient wash so the dark canvas is not a flat black rectangle. Fixed, so
   it does not travel with the scroll and cost a repaint on every frame. */
body::before{content:"";position:fixed;inset:0;pointer-events:none;z-index:0;
  background:
    radial-gradient(900px 500px at 12% -8%,rgba(99,102,241,.10),transparent 60%),
    radial-gradient(700px 400px at 92% 0%,rgba(56,189,248,.07),transparent 55%)}
:root[data-theme="light"] body::before{
  background:
    radial-gradient(900px 500px at 12% -8%,rgba(99,102,241,.06),transparent 60%),
    radial-gradient(700px 400px at 92% 0%,rgba(56,189,248,.05),transparent 55%)}

:root{
  --sans:'Inter',-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --mono:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}

.wrap{max-width:1040px;margin:0 auto;padding:0 24px;position:relative;z-index:1}

/* ---- masthead ---- */
header.top{position:sticky;top:0;z-index:30;
  background:color-mix(in srgb,var(--canvas) 78%,transparent);
  -webkit-backdrop-filter:saturate(160%) blur(16px);
  backdrop-filter:saturate(160%) blur(16px);
  border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:18px 0 0}
.brand h1{margin:0;font-size:16px;font-weight:700;letter-spacing:-.015em;
  display:flex;align-items:center;gap:9px}
.brand h1::before{content:"";width:9px;height:9px;border-radius:3px;
  background:linear-gradient(135deg,var(--accent),var(--info));
  box-shadow:0 0 12px var(--ring)}
.brand .date{font-size:13px;color:var(--muted)}
.brand .win{font:600 11px/1 var(--sans);letter-spacing:.03em;color:var(--accent-ink);
  background:var(--accent-soft);border:1px solid var(--line);
  padding:5px 10px;border-radius:999px;white-space:nowrap}
.brand .right{margin-left:auto;display:flex;align-items:center;gap:10px}
.brand .stamp{font:500 11px/1 var(--mono);color:var(--faint);
  text-transform:uppercase;letter-spacing:.08em}

/* Theme toggle. Two SVGs, one shown per theme. */
.themer{display:inline-flex;align-items:center;justify-content:center;
  width:34px;height:34px;padding:0;border-radius:10px;cursor:pointer;
  background:var(--sunk);border:1px solid var(--line);color:var(--muted);
  transition:color .14s,background .14s,transform .14s}
.themer:hover{color:var(--ink);background:var(--accent-soft);transform:translateY(-1px)}
.themer:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.themer svg{width:16px;height:16px;display:block}
.themer .moon{display:none}
:root[data-theme="light"] .themer .moon{display:block}
:root[data-theme="light"] .themer .sun{display:none}

/* ---- segmented pill nav with a sliding highlight ---- */
nav.tabs{position:relative;display:flex;gap:2px;overflow-x:auto;scrollbar-width:none;
  margin:14px 0 0;padding:4px;border-radius:14px;
  background:var(--sunk);border:1px solid var(--line)}
nav.tabs::-webkit-scrollbar{display:none}
nav.tabs .slide{position:absolute;top:4px;bottom:4px;left:0;width:0;border-radius:10px;
  background:var(--card-solid);box-shadow:var(--shadow);
  border:1px solid var(--line);
  transition:transform .22s cubic-bezier(.4,0,.2,1),width .22s cubic-bezier(.4,0,.2,1);
  pointer-events:none;z-index:0}
nav.tabs a{position:relative;z-index:1;flex:0 0 auto;display:inline-flex;align-items:center;
  gap:7px;padding:9px 15px;border-radius:10px;font-size:14px;font-weight:520;
  color:var(--muted);text-decoration:none;white-space:nowrap;
  transition:color .14s}
nav.tabs a:hover{color:var(--ink)}
nav.tabs a.on{color:var(--ink);font-weight:640}
nav.tabs a:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
nav.tabs a .pip{display:inline-flex;align-items:center;justify-content:center;
  min-width:20px;height:19px;padding:0 6px;border-radius:9px;
  background:var(--sunk);border:1px solid var(--line);color:var(--muted);
  font:600 11px/1 var(--sans)}
nav.tabs a.on .pip{background:var(--accent-soft);color:var(--accent-ink);
  border-color:transparent}
nav.tabs a .pip.alert{background:var(--bad-soft);color:var(--bad-ink);
  border-color:transparent;font-weight:700}
@media (prefers-reduced-motion:reduce){nav.tabs .slide{transition:none}}

/* ---- view scaffolding ---- */
main{padding:44px 0 96px}
.view{display:none;animation:in .18s ease-out}
.view.on{display:block}
@keyframes in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.view{animation:none}}

.lede{margin:0 0 8px;font-size:28px;line-height:1.22;font-weight:680;
  letter-spacing:-.025em;max-width:24ch}
.sub{margin:0 0 40px;font-size:16px;color:var(--muted);max-width:64ch}

h2.sec{margin:56px 0 4px;font-size:12px;font-weight:680;color:var(--muted);
  text-transform:uppercase;letter-spacing:.10em}
p.secnote{margin:0 0 20px;font-size:14px;color:var(--faint);max-width:68ch}

.card{background:var(--card);border:1px solid var(--line);border-radius:14px;
  box-shadow:var(--shadow);-webkit-backdrop-filter:var(--glass);
  backdrop-filter:var(--glass)}
.pad{padding:26px 28px}

/* ---- hero: the one number ---- */
.hero{position:relative;padding:34px 32px;margin-bottom:16px;overflow:hidden}
/* Gradient border, drawn as a masked ring so the glass behind stays visible. */
.hero::before{content:"";position:absolute;inset:0;border-radius:inherit;padding:1px;
  background:linear-gradient(135deg,var(--accent),transparent 42%,transparent 62%,var(--info));
  -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);
  -webkit-mask-composite:xor;mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);
  mask-composite:exclude;pointer-events:none;opacity:.7}
.hero .cap{display:flex;align-items:center;gap:8px;
  font:600 11px/1 var(--sans);text-transform:uppercase;
  letter-spacing:.10em;color:var(--muted);margin-bottom:14px}
.hero .cap .ic{display:inline-flex;width:20px;height:20px;border-radius:6px;
  align-items:center;justify-content:center;font-size:11px;
  background:var(--accent-soft);color:var(--accent-ink)}
.hero.good .cap .ic{background:var(--good-soft);color:var(--good-ink)}
.hero.warn .cap .ic{background:var(--warn-soft);color:var(--warn-ink)}
.hero.bad  .cap .ic{background:var(--bad-soft);color:var(--bad-ink)}
.hero .fig{font-size:54px;line-height:1;font-weight:700;letter-spacing:-.04em;
  font-variant-numeric:tabular-nums}
.hero .say{margin-top:14px;font-size:16px;color:var(--body);max-width:60ch}
.hero.good .fig{color:var(--good)} .hero.warn .fig{color:var(--warn)}
.hero.bad .fig{color:var(--bad)}   .hero.accent .fig{color:var(--accent-ink)}

/* ---- stat grid ---- */
.stats{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(176px,1fr));
  margin-bottom:12px}
.stat{position:relative;padding:20px 22px;overflow:hidden;
  transition:transform .16s ease,box-shadow .16s ease,border-color .16s ease}
.stat::after{content:"";position:absolute;top:0;left:0;right:0;height:2px;
  background:var(--accent);opacity:.55;transition:opacity .16s}
.stat.good::after{background:var(--good)} .stat.warn::after{background:var(--warn)}
.stat.bad::after{background:var(--bad)}
.stat:hover{transform:translateY(-2px);box-shadow:var(--shadow-lift);border-color:var(--ring)}
.stat:hover::after{opacity:1}
.stat .k{font:600 11px/1 var(--sans);text-transform:uppercase;letter-spacing:.09em;
  color:var(--muted);margin-bottom:10px}
.stat .v{font-size:28px;line-height:1.1;font-weight:680;letter-spacing:-.025em;
  font-variant-numeric:tabular-nums}
.stat .n{margin-top:7px;font-size:13px;color:var(--faint);line-height:1.45}
.stat .v.good{color:var(--good)} .stat .v.warn{color:var(--warn)}
.stat .v.bad{color:var(--bad)}

@media (prefers-reduced-motion:reduce){.stat{transition:none}.stat:hover{transform:none}}

/* ---- tasks ---- */
.task{display:flex;gap:15px;padding:19px 22px;border-bottom:1px solid var(--line-soft);
  transition:background .14s}
.task:last-child{border-bottom:0}
.task:hover{background:var(--sunk)}
.task input{appearance:none;flex:0 0 auto;width:21px;height:21px;margin:2px 0 0;
  border:1.75px solid var(--faint);border-radius:6px;background:transparent;
  cursor:pointer;position:relative;transition:.14s}
.task input:hover{border-color:var(--accent)}
.task input:checked{background:var(--accent);border-color:var(--accent)}
.task input:checked::after{content:"";position:absolute;left:6.5px;top:2.5px;
  width:5px;height:10px;border:solid #fff;border-width:0 2.25px 2.25px 0;
  transform:rotate(45deg)}
.task input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.task .body{min-width:0;flex:1}
.task h3{margin:0 0 7px;font-size:16px;font-weight:620;letter-spacing:-.012em;
  line-height:1.4;transition:opacity .2s,text-decoration-color .2s}
.task .meta{display:flex;gap:7px;flex-wrap:wrap;align-items:center;
  font-size:13px;color:var(--muted);margin-bottom:11px}
.task .val{font-weight:640;color:var(--good);font-variant-numeric:tabular-nums;
  font-family:var(--mono);font-size:12.5px}
.task ol{margin:0;padding-left:0;list-style:none;font-size:14px;color:var(--body);
  line-height:1.6}
.task ol li{position:relative;margin:6px 0;padding-left:24px}
.task ol li::before{content:"";position:absolute;left:0;top:.5em;
  width:13px;height:13px;border-radius:4px;border:1.5px solid var(--line);
  background:var(--sunk)}
.task.done{opacity:.45}
.task.done h3{text-decoration:line-through;text-decoration-color:var(--faint)}

/* Priority and owner badges. Shape and letter carry the meaning, colour only
   reinforces it — P0 and P2 must stay distinguishable in greyscale. */
.tag{display:inline-flex;align-items:center;padding:2px 8px;border-radius:6px;
  font:700 10.5px/1.6 var(--mono);letter-spacing:.05em;white-space:nowrap}
.tag.p0{background:var(--bad-soft);color:var(--bad-ink)}
.tag.p1{background:var(--warn-soft);color:var(--warn-ink)}
.tag.p2{background:var(--info-soft);color:var(--info)}
.tag.p3{background:var(--sunk);color:var(--muted)}
.who{display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:999px;
  background:var(--sunk);border:1px solid var(--line);
  font:560 12px/1.6 var(--sans);color:var(--body)}
.who::before{content:"";width:5px;height:5px;border-radius:50%;background:var(--accent)}

.dot{width:4px;height:4px;border-radius:50%;background:var(--faint);flex:0 0 auto}

/* ---- tables ---- */
.scroll{overflow-x:auto;overflow-y:visible;-webkit-overflow-scrolling:touch;
  border-radius:14px}
table{width:100%;border-collapse:collapse;font-size:14px}
th{position:sticky;top:0;z-index:1;text-align:left;padding:11px 16px;
  font:600 11px/1 var(--sans);text-transform:uppercase;letter-spacing:.08em;
  color:var(--muted);white-space:nowrap;border-bottom:1px solid var(--line);
  background:var(--card-solid)}
td{padding:13px 16px;border-bottom:1px solid var(--line-soft);
  color:var(--body);vertical-align:top;transition:background .12s}
tbody tr{transition:background .12s}
tbody tr:hover td{background:var(--sunk)}
tr:last-child td{border-bottom:0}
td.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;
  font-family:var(--mono);font-size:13px}
td.name{font-weight:560;color:var(--ink);white-space:nowrap}

/* ---- pills ---- */
.pill{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;
  border-radius:999px;font:600 11px/1.6 var(--sans);letter-spacing:.02em;
  white-space:nowrap}
.pill.good{background:var(--good-soft);color:var(--good-ink)}
.pill.warn{background:var(--warn-soft);color:var(--warn-ink)}
.pill.bad{background:var(--bad-soft);color:var(--bad-ink)}
.pill.flat{background:var(--sunk);color:var(--muted)}

/* ---- banner ---- */
.banner{display:flex;gap:13px;padding:17px 20px;border-radius:12px;
  font-size:14.5px;line-height:1.6;margin-bottom:16px;border:1px solid transparent}
.banner.bad{background:var(--bad-soft);color:var(--bad-ink);border-color:var(--bad-soft)}
.banner.warn{background:var(--warn-soft);color:var(--warn-ink);border-color:var(--warn-soft)}
.banner.good{background:var(--good-soft);color:var(--good-ink);border-color:var(--good-soft)}
.banner b{font-weight:680;color:var(--ink)}
.banner .ic{flex:0 0 auto;font-size:15px;line-height:1.5}

/* ---- disclosure ---- */
details{margin-top:14px;border-top:1px solid var(--line-soft);padding-top:14px}
summary{cursor:pointer;font-size:13px;font-weight:560;color:var(--muted);
  list-style:none;display:inline-flex;align-items:center;gap:7px;
  padding:4px 0;border-radius:6px;transition:color .14s}
summary::-webkit-details-marker{display:none}
summary::before{content:"";width:6px;height:6px;flex:0 0 auto;
  border-right:1.6px solid currentColor;border-bottom:1.6px solid currentColor;
  transform:rotate(-45deg);transition:transform .18s ease;margin-left:2px}
details[open] summary::before{transform:rotate(45deg)}
summary:hover{color:var(--accent-ink)}
summary:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
details .inner{padding:14px 16px 4px;font-size:14px;color:var(--body);
  line-height:1.65;max-width:68ch;
  animation:reveal .18s ease-out}
@keyframes reveal{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){details .inner{animation:none}}

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
  .brand{padding-top:14px}
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
  var LS='xs.tasks.'+RUN, TKEY='xs-theme';

  /* ---- theme -------------------------------------------------------------
     Dark is the default and the OS is never consulted. The choice is written
     to localStorage AND to a cookie: localStorage is what this page reads on
     the next load, and the cookie is what a server-rendered page could read
     to paint the right theme before first paint. The inline boot script in
     the <head> applies it, so there is no flash of the wrong palette. */
  function applyTheme(t){
    document.documentElement.setAttribute('data-theme',t);
    var b=document.getElementById('themer');
    if(b){
      b.setAttribute('aria-pressed',t==='light'?'true':'false');
      b.title=t==='light'?'Switch to dark':'Switch to light';
      b.setAttribute('aria-label',b.title);
    }
  }
  function theme(){
    try{ return localStorage.getItem(TKEY)==='light'?'light':'dark'; }catch(e){ return 'dark'; }
  }
  function setTheme(t){
    try{ localStorage.setItem(TKEY,t); }catch(e){}
    try{ document.cookie=TKEY+'='+t+';path=/;max-age=31536000;samesite=lax'; }catch(e){}
    applyTheme(t);
  }
  var themer=document.getElementById('themer');
  if(themer) themer.addEventListener('click',function(){
    setTheme(document.documentElement.getAttribute('data-theme')==='light'?'dark':'light');
  });
  applyTheme(theme());

  /* ---- nav: slide the highlight to the active tab ---- */
  function slide(id){
    var bar=document.querySelector('nav.tabs .slide'), a=document.getElementById('t-'+id);
    if(!bar||!a) return;
    bar.style.width=a.offsetWidth+'px';
    bar.style.transform='translateX('+a.offsetLeft+'px)';
  }
  window.addEventListener('resize',function(){
    var on=document.querySelector('nav.tabs a.on');
    if(on) slide(on.id.replace(/^t-/,''));
  });

  function show(id){
    if(PAGES.indexOf(id)<0) id=PAGES[0];
    PAGES.forEach(function(p){
      var v=document.getElementById('v-'+p), t=document.getElementById('t-'+p);
      if(v) v.classList.toggle('on',p===id);
      if(t){ t.classList.toggle('on',p===id);
             p===id?t.setAttribute('aria-current','page'):t.removeAttribute('aria-current'); }
    });
    slide(id);
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

#: One glyph per tone. Shape carries the status before colour does, so the
#: hero still reads correctly in greyscale or to anyone who cannot separate
#: red from green.
_TONE_ICON = {"good": "&#10003;", "warn": "&#9888;", "bad": "&#9679;", "": "&#9670;", "accent": "&#9670;"}


def hero(cap: str, fig: str, say: str, tone: str = "") -> str:
    icon = _TONE_ICON.get(tone, "&#9670;")
    return (f'<div class="card hero {tone}">'
            f'<div class="cap"><span class="ic" aria-hidden="true">{icon}</span>{e(cap)}</div>'
            f'<div class="fig">{fig}</div><div class="say">{say}</div></div>')


def stat(k: str, v: str, n: str = "", tone: str = "") -> str:
    note = f'<div class="n">{e(n)}</div>' if n else ""
    # The tone goes on the card too, so the top accent bar matches the figure.
    return (f'<div class="card stat {tone}"><div class="k">{e(k)}</div>'
            f'<div class="v {tone}">{v}</div>{note}</div>')


def priority_tag(value: str) -> str:
    """P0..P3 as a badge. Anything unrecognised renders as itself, unstyled,
    rather than being silently dropped or coerced into a level it is not."""
    p = str(value or "").strip().upper()
    if not p:
        return ""
    klass = p.lower() if p in {"P0", "P1", "P2", "P3"} else "p3"
    return f'<span class="tag {klass}" title="Priority {e(p)}">{e(p)}</span>'


def owner_badge(owner: str) -> str:
    """The owner as a short badge, with the full text kept in the tooltip.

    Owners in the run JSON are sentences, not names: "Salman (highest
    value-per-lead at $53)". The qualifier is the reasoning and belongs in the
    task's own text, not in a badge that has to sit on one line beside three
    others. So the badge is the name and the tooltip is the whole thing, and
    nothing is lost.
    """
    full = str(owner or "unassigned").strip()
    short = full.split("(")[0].strip() or full
    return f'<span class="who" title="{e(full)}">{e(short)}</span>'


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
            bits = []
            tag = priority_tag(t.get("priority"))
            if tag:
                bits.append(tag)
            bits.append(owner_badge(t.get("owner", "unassigned")))
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

    # NAME THE SEVEN DAYS. The ledger is a day behind the run because Fiverr
    # publishes at midday, so "7d" has never meant the seven days ending today
    # — and when the sheet stops being filled in it slides further without
    # anything on the card changing.
    _end, _lag = f7.get("end"), f7.get("lag_days") or 0
    _win = f"7d to {_daymon(_end)}" if _end else "7d"
    _note = f"ledger {_lag} days behind this run" if _lag >= 2 else "7-day mean"

    o.append('<div class="stats">'
             + stat(f"Organic, {_win}", num(f7.get("organic")), "orders")
             + stat(f"Directed, {_win}", num(f7.get("vvro")), "orders")
             + stat("Directed share", pct(f7.get("vvro_share")), "of all orders",
                    "bad" if (f7.get("vvro_share") or 0) > .6 else "")
             + stat("Orders/day", num(f7.get("total_per_day"), 1), _note,
                    "warn" if _lag >= 2 else "")
             + "</div>")
    if _lag >= 2:
        o.append(banner("bad", "!",
                        f"<b>These figures end {e(_daymon(_end))}, not today.</b> "
                        f"The order ledger's newest day is {_lag} days before this run. "
                        "One day behind is Fiverr publishing at midday; more than that "
                        "means the sheet has stopped being filled in, and every flow "
                        "number on this page describes a week further back than it looks."))

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

    retired = ing.get("retired_tables") or []
    if retired:
        o.append(section(
            "Retired sheets that turned up anyway",
            f'{ing.get("retired_tables_total", len(retired))} '
            f'{plural(ing.get("retired_tables_total", len(retired)), "table")} '
            f'and {num(ing.get("retired_rows_total"))} rows were refused. These '
            f'sheets were replaced by the hub, so nothing here was counted. '
            f'While they keep arriving, the same fact exists in two places.'))
        o.append(table(["Table", "From", "Rows refused", "Why"],
                       [[e(r.get("name") or "—"), e(r.get("source_id") or "—"),
                         num(r.get("rows")), e(r.get("why") or "")]
                        for r in retired], "mnnl"))

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
    # The theme is applied before the body paints. Waiting for the main script
    # at the end of the document would render one frame of the default palette
    # and then repaint, which reads as a flicker on every single load for
    # whoever chose the non-default theme.
    boot = ("(function(){try{var t=localStorage.getItem('xs-theme');"
            "document.documentElement.setAttribute('data-theme',t==='light'?'light':'dark')}"
            "catch(e){document.documentElement.setAttribute('data-theme','dark')}})()")

    sun = ('<svg class="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
           'stroke-width="2" stroke-linecap="round" aria-hidden="true">'
           '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2'
           'M19.2 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6"/>'
           '</svg>')
    moon = ('<svg class="moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
            'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
            '<path d="M20.5 14.6A8.6 8.6 0 1 1 9.4 3.5a6.9 6.9 0 0 0 11.1 11.1Z"/></svg>')

    return f"""<title>XStudioz — What Next</title>
<script>{boot}</script>
<style>{fonts_css(root)}{CSS}</style>
<header class="top"><div class="wrap">
  <div class="brand">
    <h1>XStudioz</h1><span class="date">{e(pretty)}</span>
    {f'<span class="win">{e(wlabel)}</span>' if wlabel else ''}
    <span class="right">
      <span class="stamp">brief<span class="sync" id="sync">·</span></span>
      <button class="themer" id="themer" type="button" aria-pressed="false"
              aria-label="Switch to light" title="Switch to light">{sun}{moon}</button>
    </span>
  </div>
  <nav class="tabs"><span class="slide" aria-hidden="true"></span>{"".join(tabs)}</nav>
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
    print(f"wrote {out} ({out.stat().st_size / 1024:.0f} KB, {len(PAGES)} views, dark default + light toggle, fonts embedded)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
