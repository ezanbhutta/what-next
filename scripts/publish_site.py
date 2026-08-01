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
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>XStudioz &middot; Daily brief</title>
__FONTS__
__FAVICON__
<style>
/* Light only, and deliberately no prefers-color-scheme block. This page used
   to define a light palette and then hand it to a dark override, so anyone
   whose device was set to dark met a dark sign-in screen having asked for a
   light one. The tokens below match the brief's, so signing in is continuous
   rather than a jump between two different products. */
:root{--accent:#4F46E5;--ink:#15151A;--dim:#71717F;--bg:#FBFBFD;
  --card:#fff;--raised:#F5F5F8;--border:#E8E8EF;--border-hi:#DDDDE7;
  --coral:#DC2626;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  color-scheme:light}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;
  justify-content:center;background:var(--bg);padding:24px}
form{background:var(--card);border:1px solid var(--border);border-radius:14px;
  padding:28px 30px;width:100%;max-width:340px;display:flex;
  flex-direction:column;gap:14px}
h2{margin:0;font:600 10px/1.4 var(--sans);text-transform:uppercase;
  letter-spacing:.18em;color:var(--dim)}
.t{font:700 20px/1.25 var(--sans);letter-spacing:-.02em;color:var(--ink)}
input{font:500 14px/1.4 var(--sans);padding:11px 13px;border-radius:9px;
  border:1px solid var(--border-hi);background:var(--raised);color:var(--ink)}
input:focus{outline:2px solid var(--accent);outline-offset:1px}
button{font:600 12px/1 var(--sans);letter-spacing:.06em;padding:12px;border:0;
  border-radius:9px;background:var(--accent);color:#fff;cursor:pointer}
button:disabled{opacity:.55;cursor:default}
.err{font:500 12px/1.4 var(--sans);color:var(--coral);min-height:1.2em}
.foot{font:500 10px/1.5 var(--mono);color:var(--dim);text-align:center}
</style></head><body>
<form id="gform" autocomplete="off">
  <h2>XStudioz</h2>
  <div class="t">Daily brief</div>
  <label for="pw" style="position:absolute;left:-9999px">Access password</label>
  <input id="pw" type="password" placeholder="Access password" required
         autocomplete="current-password" autofocus>
  <div class="err" id="gerr" role="alert" aria-live="polite"></div>
  <button type="submit" id="gbtn">Sign in</button>
  <div class="foot">Internal &middot; Confidential</div>
</form>
<script>
(function(){
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
    return LOGIN_PAGE.replace("__FONTS__", FONTS).replace("__FAVICON__", FAVICON)


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
