# XStudioz daily brief — site

The published copy of `reports/dashboard.html`, gated by the same password
mechanism CSR Pulse uses.

`index.html` is **generated**. Do not edit it by hand — it is overwritten
every morning by `scripts/publish_site.py`, which the daily run calls.

## One-time setup

```bash
cd site
vercel link          # or: vercel --prod, then link
vercel env add APP_PASSWORD production      # what the team types
vercel env add SESSION_SECRET production    # any long random string
```

`SESSION_SECRET` lets you revoke every session at once by rotating it, without
changing the password anyone types. If it is unset the app still works.

## After that

Nothing. The daily run regenerates `index.html`, commits, and pushes;
Vercel redeploys on push, so the page is current by 07:15 PKT with nobody
touching it.

## Fonts

Unlike the Claude artifact, this deployment CAN load Inter, Space Grotesk and
JetBrains Mono from Google Fonts — the CSP in `vercel.json` allows exactly those
two hosts and nothing else. `publish_site.py` injects the same `<link>` tags
csr-pulse uses, so here the page is typographically identical to the rest of the
suite.

## Auth

`api/auth.js` is copied verbatim from `ezanbhutta/csr-pulse` so the suite has one
auth implementation rather than two that drift. The only change is the cookie
name, so a CSR Pulse session is not a session here.
