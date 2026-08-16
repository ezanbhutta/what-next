# Deploying, and keeping it getting smarter

Two separate questions. Deployment is a checklist and finishes. Getting smarter
is a loop and does not.

---

## Part 1 — Deploy

### What is already live

| Piece | State |
|---|---|
| Engine (`xstudioz/`, 259 tests) | Running, gate passing |
| Daily Routine `trig_01RW4AVCbNjhmZzQzwSGUz9g` | Fires 02:13 UTC (07:13 PKT) daily |
| Apps Script snapshot | Deployed; runs land at `intake.path: "live"`, age ~0h |
| Hub `system.xstudioz.com` | Hostinger Web App, auto-deploys `main` |
| Dashboard artifact | Republishes to the same URL every morning |
| Git history | Every run committed and pushed |

Deployment is finished. It runs unattended end to end: build the brief, publish
to the hub, rebuild the dashboard, push, auto-deploy. Verified on 2026-08-10 and
2026-08-11, both clean.

### The four things that had to be true, and how to check each

Each of these was broken at some point and each failed silently, so they are
listed with the command that answers them rather than as prose to trust.

**1. The snapshot credentials must be present where the engine runs.** They live
in the daily Routine's prompt. A run started any other way does not have them
and falls back to whatever snapshot is on disk **without failing** — on
2026-08-08 that produced a correct-looking brief built on a stale export.

    python3 -c "import json,datetime;print(json.load(open('reports/'+datetime.date.today().isoformat()+'-run.json'))['intake'])"

`path` must be `live`. `disk` means the credentials were missing.

**2. Hostinger's build configuration must point at the app.** The Node app is in
`system/`, not the repo root. Framework preset **Express**, root directory
`system`, entry file `server.js`. It was once set to the **Astro** preset at root
`./`, which fails on every build — while the last good deployment kept serving,
so the site looked healthy and was days stale.

**3. Every environment variable the hub reads must be in the Hostinger panel.**
`system/README.md` lists them and `system/tests/env-documented.test.js` fails if
that list falls behind the code. Both Supabase keys were absent for days because
the runbook never named them.

    curl -s https://system.xstudioz.com/healthz | python3 -m json.tool

`auth.configured`, `db.reachable`, and every entry under `stores` showing
`configured: true` with `key_matches_url: true`.

**4. The unattended run must be allowed to run its own pipeline.**
`.claude/settings.json` pre-approves the engine scripts and the git commands.
Without it the Routine builds the brief and is then refused at
`publish_hub.py`, which overwrites files — so the repo gets the new brief and
the hub does not. That is not visible from the brief; it shows up as
`engine.run_date` on `/healthz` lagging a day behind `reports/`.

There is no server to run and nothing else to host.

### Where the dashboard lives, and where it must not

Two surfaces, and only two: the **Claude artifact** (private, one stable URL,
republished every morning) for Ezan, and **system.xstudioz.com** for the team.

**Do not publish the brief to a third place.** This section used to give
copy-paste instructions for pushing `reports/dashboard.html` to Vercel, and
suggested wiring it into the daily Routine so it happened every morning. That
surface was retired on 2026-08-05 and the instructions outlived it by six days.

It is retired because it leaked. The gate rendered the entire brief inside a
hidden `<div>` and served it to anyone: `curl` returned every client name and
every revenue figure with no password. A second copy of these numbers on a
second domain is also one more thing to keep in sync and one more password to
hand out.

The code cannot come back — `test_the_published_site_stays_retired` fails if
`site/` or `scripts/publish_site.py` reappears. The *instructions* had no such
guard, which is why they sat here recommending the exact thing the test forbids.
`tests/test_engine.py::test_docs_do_not_teach_the_retired_publish_path` now
covers the docs too. Do not delete either test to make something pass. If that
surface is ever genuinely wanted again, restore the gate tests with it.

### Fonts

Inter and JetBrains Mono are base64-embedded from `assets/fonts/` rather than
linked. The artifact's CSP blocks every external host, so a `<link>` to Google
Fonts fails there silently while looking correct everywhere else.

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
