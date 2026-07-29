# Deploying, and keeping it getting smarter

Two separate questions. Deployment is a checklist and finishes. Getting smarter
is a loop and does not.

---

## Part 1 — Deploy

### What is already live

| Piece | State |
|---|---|
| Engine (`xstudioz/`, 187 tests) | Running, gate passing |
| Daily Routine `trig_012hMr9MJEmXYWyRDakBY1Pv` | Fires 02:13 UTC (07:13 PKT) daily |
| Dashboard artifact | Republishes to the same URL every morning |
| Brief `reports/latest.md` + per-person boards | Generated each run |
| Git history | Every run committed and pushed |

### What is not, and the three steps that finish it

**1. Deploy the Apps Script — 15 minutes, once.**
`automation/README.md` walks it. This is the only step that matters: until it
runs, the engine reads snapshots that a human put there. After it runs, data
arrives on its own from your own Google account, with no connector grant and no
upload.

**2. Set two environment variables** wherever the engine runs (Claude
environment settings, and your shell if you run it by hand):

```
XSTUDIOZ_SNAPSHOT_URL=https://script.google.com/macros/s/.../exec
XSTUDIOZ_SNAPSHOT_TOKEN=<from generateToken>
```

**3. Bring the impressions sheet current.** It stops on 2025-12-12. Everything
about *why* organic moved is blocked behind it, and the engine will keep saying
so at P0 until it is fixed.

That is the whole deployment. There is no server to run and nothing to host.

### Where the dashboard should live

Right now it is a Claude artifact — private, one URL, republished daily. That is
correct for you and Ezan. It is not correct for the team.

When you want the team in it, the page is a **single self-contained HTML file
with no external requests**, so it drops into the same Vercel setup as CSR Pulse
with nothing to build:

```bash
mkdir -p xstudioz-brief/public
cp reports/dashboard.html xstudioz-brief/public/index.html
cd xstudioz-brief && vercel --prod
```

Add the same password gate CSR Pulse uses (`api/auth.js`) and it behaves like the
rest of the suite. Better still, add a step to the daily Routine that copies the
file into the repo and pushes — Vercel redeploys on push and the page is current
by 07:15 PKT with nobody touching it.

### The UI now matches

The dashboard is styled from `ezanbhutta/csr-pulse` `src/CSRPulse.jsx` — the same
`const C` token object, the same violet-tinted off-white canvas, the same Inter /
Space Grotesk / JetBrains Mono roles, the same wide-tracked uppercase micro-labels
and pill vocabulary.

One honest gap: **csr-pulse loads its fonts from Google Fonts and the Artifact CSP
blocks external hosts.** The same families are declared, so they resolve for
anyone who has them installed and fall back to system equivalents otherwise. The
moment the page moves to Vercel that constraint disappears — add the same
`<link>` tag csr-pulse uses and it is pixel-identical.

---

## Part 2 — Keep it getting smarter

Four loops, running at different speeds. Only the first is automatic today.

### Loop 1 — daily, automatic: calibration

Every forecast is written to `data/state/predictions.jsonl` with a resolvable
metric path, an 80% interval and a resolution date. Each morning the ledger scores
everything due and rewrites `data/state/calibration.json`. Future interval widths
are derived from **realised** coverage, so stated confidence converges on real
accuracy instead of staying at whatever felt right on day one.

You do not have to do anything for this. It compounds on its own from the day the
first prediction resolves — seven days after the first run.

### Loop 2 — daily, automatic: the data itself

Every new day of real data makes every estimate better, and some estimates are
currently blocked entirely rather than merely noisy:

| Blocked on | Unlocks |
|---|---|
| Impressions brought current | Whether organic fell from reach, click-through or close rate. Three causes, opposite responses. |
| 28 consecutive impression days | Automatic attribution in every brief, no analysis needed |
| Ledger revenue filled (111 blank days) | Revenue forecasting measured instead of inferred |
| Upsell column filled | The 54% vs 31% lift measured instead of assumed |
| Disputes sheet | Root-cause concentration — a process defect rather than bad luck |
| Follow-up columns used for 30 days | Whether the follow-up ladder works, on real data instead of empty cells |

Each of those is a P0 or P1 task in the brief already. The system gets smarter
exactly as fast as those get filled.

### Loop 3 — weekly, yours: kill the bad model

**When a prediction misses, do not just note it. Ask why the model was wrong and
change the model.** A miss that produces no change is a wasted miss.

The brief shows resolved predictions with predicted vs actual every morning.
Thirty minutes a week:

1. Any prediction outside its interval — why? Wrong rate, wrong assumption, or
   something real that the model has no input for?
2. Any task recommended three days running and never done — it is wrong, badly
   scoped, or aimed at the wrong person. Fix the rule, do not repeat it.
3. Anything the engine said that you knew was wrong — that is a missing input,
   and it belongs in `config/profile.yml` or a new source.

Tell me in a session and I change the code. That is the loop that actually
improves judgement, and it is the one that needs a human.

### Loop 4 — at each gate: re-derive the diagnosis

`2026-08-10` is the Phase 1 gate. `2026-08-20` is the kill-criteria check.
`2026-08-30` is the horizon.

At each, the diagnosis gets re-run rather than assumed. The operating model says
this plainly: *if the seven-day impression average has not moved by 10 August with
Phase 1 actions at full compliance, the diagnosis in Part 1 is wrong.* The engine
holds the kill criteria and will say so; it will not quietly keep recommending a
plan that stopped working.

---

## How to extend it

| Want | Do |
|---|---|
| New data source | `config/sources.yml` + alias table in `xstudioz/ingest.py` + drift test. Section in `CLAUDE.md`. |
| Change risk appetite | `dosing.max_vvro_share`. Nothing in code. |
| Change targets | `targets.*` |
| Add a task rule | A function in `xstudioz/tasks.py` returning `Task(...)`. The rubric enforces owner, evidence, ≥2 steps. |
| Change who owns what | `roles.CATEGORY_OWNER` and `team.roster` |
| Advance the phase | `phases.current`. The gate blocks Phase 2 actions until all three conditions read true. |

Everything is tested. `python3 -m pytest tests/ -q` — 187 tests, under a second.

## What this system will not do

Stated so nobody waits for it:

- It does not watch competitors. The strongest comparison available is **inside
  your own portfolio** — Dygram at 44% inorganic with Success Score 9 and 8× the
  impressions is closer to a controlled experiment than any scraped rival.
- It does not read your Fiverr inbox or send messages. It writes the message; a
  person sends it.
- It cannot see private feedback. Nobody can. It builds a proxy instead.
- It does not prove causation. The organic decline correlates with the VVRO ramp
  and with a cancellation cluster in the same window, and this dataset cannot
  separate them. Both remedies overlap, so act on both — and the engine logs a
  falsifiable prediction so the question resolves on evidence.
