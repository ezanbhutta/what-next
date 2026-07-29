# XStudioz daily brief — site

The published copy of `reports/dashboard.html`, gated by the same password
mechanism CSR Pulse uses.

`index.html` is **generated**. Do not edit it by hand — it is overwritten
every morning by `scripts/publish_site.py`, which the daily run calls.

## One-time setup

In the Vercel web UI:

1. **vercel.com/new** → import `ezanbhutta/what-next`
2. **Root Directory** → `site`   ← the step people miss
3. **Framework Preset** → Other. Leave build command and output directory empty.
4. Deploy
5. **Settings → Git → Production Branch** → `claude/xstudioz-growth-automation-dj8u2z`
   Without this the page never updates, because the daily run pushes to that
   branch and not to main.

## Access

Two options. Pick by who actually needs to see it.

### Single viewer — Vercel Deployment Protection (default)

**Settings → Deployment Protection → Vercel Authentication → All Deployments.**

Only people signed in to the Vercel account can open the page. The owner is
already signed in, so it just opens — no password to type, none to leak, none
to rotate. This is what `publish_site.py` assumes.

### Team access — the password gate

Run `python3 scripts/publish_site.py --gate` instead, and set two environment
variables in Vercel:

```
APP_PASSWORD     what the team types
SESSION_SECRET   any long random string; rotating it logs everyone out
```

`SESSION_SECRET` can be changed to revoke every session at once without
changing the password anyone types. If unset the app still works.

To make the gate permanent, add `--gate` to the `publish_site.py` line in
`CLAUDE.md` step 4 so the daily run keeps it.

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

It stays in the repo even when the gate is off — switching the team on later is
one flag, not a rebuild.
