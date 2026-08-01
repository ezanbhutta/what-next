# XStudioz daily brief — site

The published copy of `reports/dashboard.html`, behind the same password
mechanism CSR Pulse uses.

Everything here is **generated**. Do not edit `api/brief.js` by hand — it is
overwritten every morning by `scripts/publish_site.py`, which the daily run
calls.

## One-time setup

In the Vercel web UI:

1. **vercel.com/new** → import `ezanbhutta/what-next`
2. **Root Directory** → `site`   ← the step people miss
3. **Framework Preset** → Other. Leave build command and output directory empty.
4. Deploy
5. **Settings → Git → Production Branch** → `main`
   This must match the branch the daily run pushes to, or the page never
   updates: Vercel builds every other branch as a *preview* and leaves the
   production domain on whatever it last built. The symptom is a run that
   reports success, a deployment that is READY, and a team still reading
   yesterday's numbers — check `target` on the deployment, not just its state.
6. **Settings → Environment Variables** → add `APP_PASSWORD`.

## Access

### The password gate (what the daily run publishes)

`scripts/publish_site.py --gate` emits the whole page **inside a serverless
function**, `api/brief.js`. A request with no valid session cookie gets a login
form of about 4 KB and nothing else — no client names, no revenue, no pipeline.
`vercel.json` rewrites `/` to that function.

Two environment variables in Vercel:

```
APP_PASSWORD     what the team types      (required — without it the page
                                           refuses everyone rather than
                                           opening to everyone)
SESSION_SECRET   any long random string; rotating it logs everyone out
```

`SESSION_SECRET` can be changed to revoke every session at once without
changing the password anyone types. If unset the app still works.

### Why the page is not a static file

It used to be. `--gate` wrapped the brief in `<div id="brief" hidden>` and
revealed it in JavaScript once `/api/auth` answered — which means the server
had already sent every figure to anyone who asked. `curl` on the deployed URL
returned client usernames, revenue, AOV, the dead pipeline and the team roster
without a password. A hidden div is a UI state, not an access control.

Two consequences worth keeping in mind:

* **There must be no `site/index.html`.** Vercel checks the filesystem before it
  applies rewrites, so a static page at the root is served in front of the
  function and reopens everything. The publisher deletes it and the test suite
  fails if both exist.
* **A missing `APP_PASSWORD` fails closed.** The function serves the login page
  and logs a misconfiguration rather than assuming no password means no gate.

### Single viewer, no password — Vercel Deployment Protection

If only the owner ever opens the link, `python3 scripts/publish_site.py` with no
flag writes a plain static `site/index.html` (and removes `api/brief.js`), and
**Settings → Deployment Protection → Vercel Authentication → All Deployments**
does the gating. Nothing to type, no shared password to leak or rotate. This is
only safe with Deployment Protection actually switched on — the file itself is
world-readable.

## Fonts

Unlike the Claude artifact, this deployment CAN load Inter, Space Grotesk and
JetBrains Mono from Google Fonts — the CSP in `vercel.json` allows exactly those
two hosts and nothing else. `publish_site.py` injects the same `<link>` tags
csr-pulse uses, so here the page is typographically identical to the rest of the
suite.

## Auth

`api/auth.js` is copied from `ezanbhutta/csr-pulse` so the suite has one auth
implementation rather than two that drift. Two changes: the cookie name is
namespaced (a CSR Pulse session is not a session here), and `verifyToken`,
`cookieFrom` and `COOKIE` are exported so `api/brief.js` checks sessions with
the same code that issues them.
