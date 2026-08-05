#!/usr/bin/env python3
"""Publish the dashboard as the Vercel site.

Takes ``reports/dashboard.html`` — the same self-contained page the Claude
artifact serves — and wraps it for deployment beside CSR Pulse:

* a full ``<!doctype html>`` document (the artifact host supplies its own
  skeleton; Vercel does not),
* with ``--gate``, a password wall enforced **on the server**.

The page deliberately loads no webfont and no external stylesheet. It used to
pull Inter and Space Grotesk from Google Fonts to match csr-pulse, but the
published artifact runs under a CSP that blocks every external host, so those
requests failed silently on one of the two targets while looking correct on
the other. System faces render identically in both places.

Two publishing modes
--------------------

``--gate`` **(server-rendered, the mode the team uses)**
    The page is emitted as ``site/api/brief.js`` — a serverless function that
    checks the session cookie and only then returns the HTML. An unauthenticated
    request gets a login form and nothing else: no client names, no revenue, no
    pipeline. ``site/index.html`` is *deleted*, because Vercel checks the
    filesystem before it applies rewrites, so a leftover static page would keep
    being served in front of the function.

    This replaced an earlier gate that shipped the whole brief inside
    ``<div id="brief" hidden>`` and revealed it in JavaScript once ``/api/auth``
    answered. That is not a gate. ``curl`` returned every figure on the page
    without ever presenting a password, and the deployed site was in exactly
    that state when the exposure was found. If you are tempted to go back to a
    client-side reveal for speed: the data has already left the server by then.

no flag
    A plain static ``site/index.html``, for use behind Vercel's own Deployment
    Protection. Right for a single viewer who is already signed in to Vercel:
    nothing to type, and no shared password to leak or rotate. Wrong the moment
    anyone else needs the link.

The output is generated on every run. Never hand-edit either file.
"""

from __future__ import annotations

import argparse
import base64
import datetime as _dt
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# No webfont link. The brief renders in system fonts, and the published
# artifact runs under a CSP that blocks every external host, so a Google Fonts
# <link> is not a cosmetic choice — it is a request that fails on one of the
# two targets while looking fine on the other. Empty rather than deleted so the
# __FONTS__ placeholder keeps working.
def _fonts_css() -> str:
    """The same two faces the brief embeds, inlined here too.

    The login page is a separate document and never sees the dashboard's
    stylesheet, so without this it renders in a system face and the sign-in
    screen looks like a different product from the page behind it. Embedded
    rather than linked for the same reason as the brief: the CSP on the
    published artifact blocks external hosts, and a <link> that silently does
    nothing is worse than no link at all.
    """
    d = ROOT / "assets" / "fonts"
    faces = [("Inter", d / "inter-latin-var.woff2", "400 700"),
             ("JetBrains Mono", d / "jetbrains-mono-latin-var.woff2", "400 600")]
    out = []
    for family, path, weights in faces:
        if not path.exists():
            continue  # fall through to the system stack rather than emit a broken URI
        b64 = base64.b64encode(path.read_bytes()).decode("ascii")
        out.append(f"@font-face{{font-family:'{family}';font-style:normal;"
                   f"font-weight:{weights};font-display:swap;"
                   f"src:url(data:font/woff2;base64,{b64}) format('woff2')}}")
    return "<style>" + "".join(out) + "</style>" if out else ""


FONTS = ""

FAVICON = (
    '<link rel="icon" href="data:image/svg+xml,'
    "%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E"
    "%3Crect width='32' height='32' rx='8' fill='%234F46E5'/%3E"
    "%3Cpath d='M9 21l5-6 4 3 5-8' stroke='white' stroke-width='2.5' "
    "fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E"
    "%3C/svg%3E\">"
)

# The login page is a whole separate document, not a layer over a hidden brief.
# It carries its own tokens because the dashboard's stylesheet never reaches an
# unauthenticated visitor — that is the point.
LOGIN_PAGE = """<!doctype html>
<html lang="en" data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>XStudioz &middot; Daily brief</title>
<script>(function(){try{var t=localStorage.getItem('xs-theme');
document.documentElement.setAttribute('data-theme',t==='light'?'light':'dark')}
catch(e){document.documentElement.setAttribute('data-theme','dark')}})()</script>
__FONTS__
__FAVICON__
<style>
/* The same tokens as the brief, so signing in is continuous rather than a jump
   between two different-looking products. Dark by default, light behind the
   same toggle, and deliberately NO prefers-color-scheme block: this page once
   defined a light palette and handed it to a dark override, so anyone whose
   device was set to dark met a dark sign-in screen having asked for a light
   one. The reader chooses; the operating system does not. */
:root,:root[data-theme="dark"]{
  --canvas:#0B0F17;--card:rgba(22,28,45,.75);--sunk:rgba(255,255,255,.04);
  --ink:#F1F5F9;--body:#CBD5E1;--dim:#94A3B8;
  --line:rgba(255,255,255,.08);--line-hi:rgba(255,255,255,.14);
  --accent:#6366F1;--accent-ink:#A5B4FC;--info:#38BDF8;--coral:#F87171;
  --ring:rgba(99,102,241,.35);
  --shadow:0 1px 2px rgba(0,0,0,.4),0 18px 44px -10px rgba(0,0,0,.6);
  color-scheme:dark}
:root[data-theme="light"]{
  --canvas:#F8FAFC;--card:#FFFFFF;--sunk:#F1F5F9;
  --ink:#0F172A;--body:#334155;--dim:#64748B;
  --line:#E2E8F0;--line-hi:#CBD5E1;
  --accent:#4F46E5;--accent-ink:#3730A3;--info:#0284C7;--coral:#DC2626;
  --ring:rgba(79,70,229,.30);
  --shadow:0 10px 30px -5px rgba(0,0,0,.05),0 1px 2px rgba(15,23,42,.04);
  color-scheme:light}
:root{
  --sans:'Inter',-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --mono:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;
  justify-content:center;background:var(--canvas);padding:24px;
  font-family:var(--sans);-webkit-font-smoothing:antialiased;position:relative}
body::before{content:"";position:fixed;inset:0;pointer-events:none;
  background:
    radial-gradient(760px 420px at 50% -10%,rgba(99,102,241,.16),transparent 62%),
    radial-gradient(560px 320px at 88% 8%,rgba(56,189,248,.10),transparent 58%)}
:root[data-theme="light"] body::before{
  background:
    radial-gradient(760px 420px at 50% -10%,rgba(99,102,241,.08),transparent 62%),
    radial-gradient(560px 320px at 88% 8%,rgba(56,189,248,.06),transparent 58%)}
form{position:relative;z-index:1;background:var(--card);border:1px solid var(--line);
  border-radius:18px;padding:32px 32px 26px;width:100%;max-width:360px;
  display:flex;flex-direction:column;gap:15px;box-shadow:var(--shadow);
  -webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px)}
.brandline{display:flex;align-items:center;gap:9px}
.mark{width:11px;height:11px;border-radius:3.5px;flex:0 0 auto;
  background:linear-gradient(135deg,var(--accent),var(--info));
  box-shadow:0 0 14px var(--ring)}
h2{margin:0;font:600 10px/1.4 var(--sans);text-transform:uppercase;
  letter-spacing:.18em;color:var(--dim)}
.t{font:700 22px/1.25 var(--sans);letter-spacing:-.025em;color:var(--ink);
  margin-top:-4px}
.lede{font:400 13.5px/1.55 var(--sans);color:var(--dim);margin:-6px 0 2px}
input{font:500 14px/1.4 var(--sans);padding:12px 14px;border-radius:11px;
  border:1px solid var(--line-hi);background:var(--sunk);color:var(--ink);
  transition:border-color .16s,box-shadow .16s,background .16s}
input::placeholder{color:var(--dim)}
input:focus{outline:none;border-color:var(--accent);
  box-shadow:0 0 0 4px var(--ring);background:transparent}
button.go{font:600 12.5px/1 var(--sans);letter-spacing:.05em;padding:13px;border:0;
  border-radius:11px;color:#fff;cursor:pointer;
  background:linear-gradient(135deg,var(--accent),#4F46E5);
  box-shadow:0 6px 18px -6px var(--ring);
  transition:transform .14s,box-shadow .14s,opacity .14s}
button.go:hover:not(:disabled){transform:translateY(-1px);
  box-shadow:0 10px 24px -6px var(--ring)}
button.go:focus-visible{outline:2px solid var(--accent-ink);outline-offset:2px}
button.go:disabled{opacity:.55;cursor:default;transform:none}
.err{font:500 12px/1.45 var(--sans);color:var(--coral);min-height:1.2em}
.foot{display:flex;align-items:center;justify-content:space-between;gap:10px;
  margin-top:2px;padding-top:14px;border-top:1px solid var(--line)}
.foot span{font:500 10px/1.5 var(--mono);color:var(--dim);
  text-transform:uppercase;letter-spacing:.1em}
.themer{display:inline-flex;align-items:center;justify-content:center;
  width:30px;height:30px;padding:0;border-radius:9px;cursor:pointer;
  background:var(--sunk);border:1px solid var(--line);color:var(--dim);
  transition:color .14s,background .14s}
.themer:hover{color:var(--ink);background:var(--sunk)}
.themer:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.themer svg{width:15px;height:15px;display:block}
.themer .moon{display:none}
:root[data-theme="light"] .themer .moon{display:block}
:root[data-theme="light"] .themer .sun{display:none}
@media (prefers-reduced-motion:reduce){button.go{transition:none}
  button.go:hover:not(:disabled){transform:none}}
</style></head><body>
<form id="gform" autocomplete="off">
  <div class="brandline"><span class="mark"></span><h2>XStudioz</h2></div>
  <div class="t">Daily brief</div>
  <p class="lede">This page carries client names, revenue and the open pipeline.</p>
  <label for="pw" style="position:absolute;left:-9999px">Access password</label>
  <input id="pw" type="password" placeholder="Access password" required
         autocomplete="current-password" autofocus>
  <div class="err" id="gerr" role="alert" aria-live="polite"></div>
  <button class="go" type="submit" id="gbtn">Sign in</button>
  <div class="foot">
    <span>Internal &middot; Confidential</span>
    <button class="themer" id="themer" type="button" aria-label="Switch to light"
            title="Switch to light">
      <svg class="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="4.2"/><path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6"/>
      </svg>
      <svg class="moon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M20.5 14.6A8.6 8.6 0 1 1 9.4 3.5a6.9 6.9 0 0 0 11.1 11.1Z"/>
      </svg>
    </button>
  </div>
</form>
<script>
(function(){
  var TKEY='xs-theme';
  function apply(t){
    document.documentElement.setAttribute('data-theme',t);
    var b=document.getElementById('themer');
    if(b){ b.title=t==='light'?'Switch to dark':'Switch to light';
           b.setAttribute('aria-label',b.title); }
  }
  var tb=document.getElementById('themer');
  if(tb) tb.addEventListener('click',function(){
    var t=document.documentElement.getAttribute('data-theme')==='light'?'dark':'light';
    try{ localStorage.setItem(TKEY,t); }catch(e){}
    try{ document.cookie=TKEY+'='+t+';path=/;max-age=31536000;samesite=lax'; }catch(e){}
    apply(t);
  });
  try{ apply(localStorage.getItem(TKEY)==='light'?'light':'dark'); }catch(e){}

  var form=document.getElementById('gform'),pw=document.getElementById('pw'),
      err=document.getElementById('gerr'),btn=document.getElementById('gbtn');
  form.addEventListener('submit',function(e){
    e.preventDefault(); err.textContent=''; btn.disabled=true;
    fetch('/api/auth',{method:'POST',credentials:'same-origin',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'login',password:pw.value})
    }).then(function(r){
      // The brief is not in this document. A correct password sets the cookie;
      // reloading is what fetches the page from the server for the first time.
      if(r.ok){ location.reload(); return; }
      err.textContent = r.status===429
        ? 'Too many attempts. Wait a minute and try again.'
        : r.status===503
        ? 'The server has no password configured. Set APP_PASSWORD in Vercel.'
        : 'That password is not right.';
      btn.disabled=false; pw.select();
    }).catch(function(){
      err.textContent='Could not reach the server. Try again.';
      btn.disabled=false;
    });
  });
})();
</script>
</body></html>
"""

FUNCTION_TEMPLATE = """// GENERATED by scripts/publish_site.py — do not edit.
//
// The daily brief, served only to an authenticated session.
//
// Everything confidential lives in PAGE, inside this function. It is never a
// static asset, so there is no URL that returns it without the cookie check
// below. An unauthenticated GET gets LOGIN, which contains a form and nothing
// else.
//
// vercel.json rewrites `/` here. Vercel consults the filesystem before it
// applies rewrites, so `site/index.html` must not exist in gated mode — the
// publisher deletes it.
import { verifyToken, cookieFrom, COOKIE } from './auth.js';

const LOGIN = %(login)s;
const PAGE = %(page)s;

export default function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    res.status(405).end();
    return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  const password = process.env.APP_PASSWORD;
  if (!password) {
    // Fail CLOSED. A missing password must never mean "let everyone in" —
    // that is the accident this whole function exists to prevent.
    console.error('AUTH MISCONFIG: APP_PASSWORD is not set; serving the login page only');
    res.status(503).send(LOGIN);
    return;
  }
  if (!verifyToken(cookieFrom(req, COOKIE), password)) {
    res.status(401).send(LOGIN);
    return;
  }
  res.status(200).send(PAGE);
}
"""


def build(fragment: str, generated: str) -> str:
    """Wrap the dashboard fragment in a full HTML document."""
    title_m = re.search(r"<title>(.*?)</title>", fragment, re.S)
    title = title_m.group(1) if title_m else "XStudioz — Daily brief"
    body = re.sub(r"<title>.*?</title>", "", fragment, count=1, flags=re.S)
    return (
        "<!doctype html>\n"
        '<html lang="en"><head>'
        '<meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        '<meta name="robots" content="noindex,nofollow">'
        f"<title>{title} · HaseebMadeIt</title>"
        + FONTS + FAVICON +
        "</head><body>"
        + body
        + f"<!-- generated {generated} by scripts/publish_site.py -->"
        "</body></html>\n"
    )


def login_page() -> str:
    return LOGIN_PAGE.replace("__FONTS__", _fonts_css()).replace("__FAVICON__", FAVICON)


def build_function(page_html: str) -> str:
    """Emit the gated serverless function.

    ``json.dumps`` is doing real work here, not cosmetics: it escapes the
    backslashes, quotes and — with ``ensure_ascii`` — the U+2028/U+2029 line
    terminators that would otherwise end a JavaScript string literal early and
    turn the rest of the brief into syntax errors.
    """
    return FUNCTION_TEMPLATE % {
        "login": json.dumps(login_page()),
        "page": json.dumps(page_html),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", default=str(ROOT))
    ap.add_argument("--src", help="default reports/dashboard.html")
    ap.add_argument("--out", help="static output; default site/index.html")
    ap.add_argument("--gate", action="store_true",
                    help="serve the page from a server-side password gate "
                         "instead of publishing it as a static file.")
    args = ap.parse_args()

    root = Path(args.root)
    src = Path(args.src) if args.src else root / "reports" / "dashboard.html"
    static_out = Path(args.out) if args.out else root / "site" / "index.html"
    fn_out = root / "site" / "api" / "brief.js"

    if not src.exists():
        print(f"[error] {src} not found. Run scripts/build_dashboard.py first.",
              file=sys.stderr)
        return 2

    generated = _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds")
    page = build(src.read_text(encoding="utf-8"), generated)

    if args.gate:
        fn_out.parent.mkdir(parents=True, exist_ok=True)
        fn_out.write_text(build_function(page), encoding="utf-8")
        print(f"wrote {fn_out} ({fn_out.stat().st_size / 1024:.0f} KB, gated)")
        if static_out.exists():
            static_out.unlink()
            print(f"removed {static_out} — a static page would be served "
                  f"in front of the gate")
        return 0

    static_out.parent.mkdir(parents=True, exist_ok=True)
    static_out.write_text(page, encoding="utf-8")
    print(f"wrote {static_out} ({static_out.stat().st_size / 1024:.0f} KB, "
          f"UNGATED — rely on Vercel Deployment Protection)")
    if fn_out.exists():
        fn_out.unlink()
        print(f"removed {fn_out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
