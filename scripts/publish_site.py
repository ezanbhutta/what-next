#!/usr/bin/env python3
"""Publish the dashboard as the gated Vercel site.

Takes ``reports/dashboard.html`` — the same self-contained page the Claude
artifact serves — and wraps it for deployment beside CSR Pulse:

* a full ``<!doctype html>`` document (the artifact host supplies its own
  skeleton; Vercel does not),
* the Google Fonts links csr-pulse uses, so here the page is typographically
  identical rather than falling back to system faces,
* a password gate that talks to ``site/api/auth.js`` — the same auth code,
  copied verbatim from csr-pulse so the suite has one implementation.

The output is generated on every run. Nothing in ``site/public/`` should ever
be hand-edited.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

FONTS = (
    '<link rel="preconnect" href="https://fonts.googleapis.com">'
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
    '<link href="https://fonts.googleapis.com/css2?'
    'family=Inter:wght@400;500;600;700&'
    'family=Space+Grotesk:wght@500;600;700&'
    'family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">'
)

# The gate renders first and the brief stays hidden until /api/auth confirms a
# session. It is not a security boundary on its own — the cookie check on the
# server is — but it stops the numbers being visible for the half second before
# a redirect would fire.
GATE_CSS = """
#gate{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;
  justify-content:center;background:var(--bg);padding:24px}
#gate form{background:var(--card);border:1px solid var(--border);
  border-radius:14px;padding:28px 30px;width:100%;max-width:340px;
  display:flex;flex-direction:column;gap:14px}
#gate h2{font:600 10px/1.4 var(--sans);text-transform:uppercase;
  letter-spacing:.18em;color:var(--dim)}
#gate .t{font:700 20px/1.25 var(--disp);letter-spacing:-.02em;color:var(--ink)}
#gate input{font:500 14px/1.4 var(--sans);padding:11px 13px;border-radius:9px;
  border:1px solid var(--border-hi);background:var(--raised);color:var(--ink)}
#gate input:focus{outline:2px solid var(--violet);outline-offset:1px}
#gate button{font:600 12px/1 var(--sans);letter-spacing:.06em;padding:12px;
  border:0;border-radius:9px;background:var(--violet);color:#fff;cursor:pointer}
#gate button:disabled{opacity:.55;cursor:default}
#gate .err{font:500 12px/1.4 var(--sans);color:var(--coral);min-height:1.2em}
#gate .foot{font:500 10px/1.5 var(--mono);color:var(--dim);text-align:center}
#brief[hidden]{display:none}
"""

GATE_HTML = """
<div id="gate">
  <form id="gform" autocomplete="off">
    <h2>XStudioz</h2>
    <div class="t">Daily brief</div>
    <label for="pw" class="sr-only" style="position:absolute;left:-9999px">Access password</label>
    <input id="pw" type="password" placeholder="Access password" required
           autocomplete="current-password">
    <div class="err" id="gerr" role="alert" aria-live="polite"></div>
    <button type="submit" id="gbtn">Sign in</button>
    <div class="foot">Internal &middot; Confidential</div>
  </form>
</div>
"""

GATE_JS = """
<script>
(function(){
  var gate=document.getElementById('gate'),brief=document.getElementById('brief'),
      form=document.getElementById('gform'),pw=document.getElementById('pw'),
      err=document.getElementById('gerr'),btn=document.getElementById('gbtn');
  function post(body){
    return fetch('/api/auth',{method:'POST',credentials:'same-origin',
      headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  }
  function open_(){ gate.remove(); brief.hidden=false; }
  post({action:'verify'}).then(function(r){ if(r.ok) open_(); else pw.focus(); })
    .catch(function(){ pw.focus(); });
  form.addEventListener('submit',function(e){
    e.preventDefault(); err.textContent=''; btn.disabled=true;
    post({action:'login',password:pw.value}).then(function(r){
      if(r.ok){ open_(); return; }
      // 429 is the auth function's rate limit, not a wrong password.
      err.textContent = r.status===429
        ? 'Too many attempts. Wait a minute and try again.'
        : 'That password is not right.';
      btn.disabled=false; pw.select();
    }).catch(function(){
      err.textContent='Could not reach the server. Try again.';
      btn.disabled=false;
    });
  });
})();
</script>
"""


def build(fragment: str, generated: str) -> str:
    title_m = re.search(r"<title>(.*?)</title>", fragment, re.S)
    title = title_m.group(1) if title_m else "XStudioz — Daily brief"
    body = re.sub(r"<title>.*?</title>", "", fragment, count=1, flags=re.S)

    # Fold the gate's styles into the page's own <style> so both share the
    # design tokens rather than duplicating them.
    body = body.replace("</style>", GATE_CSS + "</style>", 1)

    return (
        "<!doctype html>\n"
        '<html lang="en"><head>'
        '<meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        '<meta name="robots" content="noindex,nofollow">'
        f"<title>{title} · HaseebMadeIt</title>"
        + FONTS +
        '<link rel="icon" href="data:image/svg+xml,'
        "%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E"
        "%3Crect width='32' height='32' rx='8' fill='%237229FF'/%3E"
        "%3Cpath d='M9 21l5-6 4 3 5-8' stroke='white' stroke-width='2.5' "
        "fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E"
        "%3C/svg%3E\">"
        "</head><body>"
        + GATE_HTML
        + '<div id="brief" hidden>' + body + "</div>"
        + GATE_JS
        + f"<!-- generated {generated} by scripts/publish_site.py -->"
        "</body></html>\n"
    )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", default=str(ROOT))
    ap.add_argument("--src", help="default reports/dashboard.html")
    ap.add_argument("--out", help="default site/public/index.html")
    args = ap.parse_args()

    root = Path(args.root)
    src = Path(args.src) if args.src else root / "reports" / "dashboard.html"
    out = Path(args.out) if args.out else root / "site" / "public" / "index.html"

    if not src.exists():
        print(f"[error] {src} not found. Run scripts/build_dashboard.py first.",
              file=sys.stderr)
        return 2

    out.parent.mkdir(parents=True, exist_ok=True)
    html = build(src.read_text(encoding="utf-8"),
                 _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"))
    out.write_text(html, encoding="utf-8")
    print(f"wrote {out} ({out.stat().st_size / 1024:.0f} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
