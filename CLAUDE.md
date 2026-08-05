# XStudioz Growth Engine — daily operating manual

You are the daily operator of this system. This file tells you exactly what to do
each morning. Follow it in order; do not improvise the data steps.

## The objective

**Maximise monthly revenue, subject to organic order flow recovering.**

Organic flow is a *hard constraint*, not a preference. If organic is breached you may
not recommend adding directed volume on top of it, no matter how far behind revenue
is. The engine enforces this in code (`xstudioz/dosing.py`) and the self-check blocks
any brief that violates it. Do not talk around it in prose either.

The directed-volume controller is currently **switched off as policy**
(`dosing.disabled_plan`, quota 0). While it is off there is no volume instruction
to give, and the brief must not print a zeroed quota — see rule 5 below.

## Daily sequence

### 1. Get the data

**Preferred — the snapshot endpoint.** If `XSTUDIOZ_SNAPSHOT_URL` is set, the
runner fetches it automatically and you do nothing. It also reads any snapshot
the Apps Script timer left in `data/raw/snapshots/` and uses whichever is newer.
Check the `[snapshot]` lines on stderr to see which path won and how old it is.

**Fallback — manual fetch.** Only if the runner reports no snapshot at all.
Never write to any source sheet. Pull each into a dated file:

| Source | How | Path |
|---|---|---|
| Order / CRM workbook | `mcp__Google_Drive__read_file_content`, `fileId` `1kHw1DB7r4RhgBpF4l4CtapBdgtozJwJXtF-egVBZGUE` | `data/raw/orders/<YYYY-MM-DD>.md` |
| Inquiry workbook | same tool, `fileId` `1Pp6RhsR96FzGfB3MV--CYj7Idja2-iyF7BNPhJ9Md_A` | `data/raw/inquiries/<YYYY-MM-DD>.md` |
| Live gig page | fetch the gig URL in `config/sources.yml` | `data/raw/gig/<YYYY-MM-DD>.json` |
| CSR handoff tracker | whatever the user uploads | `data/raw/order_tracker/*.xlsx` |

The Drive tool returns oversized results to a file on disk. That is expected —
write the `fileContent` value straight to the path with a short script rather
than reading it into context. **You do not need to read the sheet contents
yourself.** The engine parses them; pulling 200k characters into context wastes
the budget you need for judgement.

From the gig page capture: `level`, `reviews_total`, the `stars` histogram,
`orders_in_queue`, `avg_response_time_hours`. The star histogram is what makes
the rating maths work, so do not skip it.

If the snapshot endpoint is configured but failing, say so at the top of your
report and fix it — see `automation/README.md` troubleshooting. A silently
degraded intake that nobody notices is how a system stops being trustworthy.

### 2. Run the engine

```bash
python3 scripts/daily_run.py --date <YYYY-MM-DD>
```

Exit code `0` means the self-check passed and the brief is trustworthy.
Exit code `1` means the brief was produced but **failed its own gate** — see below.
Exit code `2` means no snapshots were found; go back to step 1.

### 3. Handle a failed gate

If the self-check blocked, do **not** hand the brief to the user as if it were fine.
Read the `[BLOCK]` lines on stderr and act:

- `dose_within_share_cap`, `week_pattern_sums_to_quota`, `bands_sum_to_dose`,
  `no_raise_under_breach` — a controller bug. Fix the code, add a regression test,
  re-run. These must never reach the user.
- `schema_drift` — a sheet changed shape. Add the new header to the right alias table
  in `xstudioz/ingest.py`, or to `IGNORED_HEADERS` if it carries no signal. Re-run.
- `data_freshness` — the sheets have not been updated. Say so plainly at the top of
  your message; do not present stale numbers as current.
- `predictions_falsifiable`, `all_tasks_owned` — a generation bug. Fix, do not paper over.

### 4. Rebuild the dashboard

```bash
python3 scripts/build_dashboard.py     # reports/dashboard.html
```

The brief is **six views behind a tab bar**, not one long scroll: Today, Money,
Orders, Marketing, Health, History. Only one is on screen at a time and each
answers a single question. Today is the landing view and is a **checklist** —
every task carries a checkbox whose state is written to the `growth_task_state`
table in the `reports` Supabase project, keyed by run date and task id, so a
tick follows Ezan from phone to laptop. If the database is unreachable the page
falls back to `localStorage` and says so in the masthead; it never silently
drops a tick.

Each view leads with the number and the instruction. Reasoning goes inside a
`<details>` underneath, never in front. If you find yourself writing a
paragraph before a figure, the figure is in the wrong place.

It ships **dark by default with a light toggle**, remembered in `localStorage`
under `xs-theme` and applied by an inline script before the stylesheet so the
wrong palette never flashes. There is no `prefers-color-scheme` rule and there
must not be one: that hands a stated product decision to the reader's OS, which
is how everyone with a dark laptop once opened a dark page having asked for a
light one. Inter and JetBrains Mono are base64-embedded from `assets/fonts/`
rather than linked, because the artifact's CSP blocks every external host and a
`<link>` to Google Fonts fails there silently while looking fine elsewhere.

Then republish the artifact to the same URL so the link you and Ezan already
have stays current:

    Artifact(file_path="reports/dashboard.html",
             url="https://claude.ai/code/artifact/efdf1312-b4e7-4974-960d-4a035031cdaf",
             favicon="📉")

Passing `url` is what keeps the URL stable from a fresh session. Do not change
the `<title>` or the favicon — the page is found by its name and tab icon.

**There is no website to publish to any more.** The Vercel site was retired on
2026-08-05: `site/`, `scripts/publish_site.py` and the whole password gate are
gone, and `xstudioz-manage.vercel.app` with them. **The one domain is
system.xstudioz.com**, the hub on Hostinger, and it is the only place the team
reads. A second gated copy of the same numbers on a second domain was one more
thing to keep in sync, one more password to hand out and one more place to leak
from.

`test_the_published_site_stays_retired` fails if `site/` or `publish_site.py`
comes back. Do not delete it to make a run pass. If that surface is ever
genuinely wanted again, restore the gate tests along with it — the original
leak shipped the entire brief inside a hidden `<div>` and `curl` returned every
client name and revenue figure without a password.

### 5. Report to the user

Lead with the single most important thing, then the task list. Keep it short — the full
detail is in `reports/latest.md`. Always state:

- the organic health verdict and whether the constraint is breached,
- what the money-at-rest figure is and who is chasing it today,
- the top 3 tasks with owners,
- anything the self-check flagged.

### 6. Commit

```bash
git config user.email "ezanmujahid@gmail.com"
git config user.name  "XStudioz Growth Engine"
git add -A && git commit -m "daily: <date> brief" && git push -u origin main
```

**Push to `main`.** It is the default branch. The engine used to push to a
long-lived `claude/…` branch; that branch is history and nothing should target
it.

**Set the email every run — it is not optional.** The container is fresh each
morning and defaults to `haseeb53810@gmail.com`, which is not attached to the
GitHub account. An unattributable commit author has already cost one silent
failed deploy, and it is two seconds to set.

**Pushing does not deploy the hub.** system.xstudioz.com runs on Hostinger, not
on a build triggered by this push. Nothing in this repo is a deploy hook. If a
change needs to reach the team today, confirm it is actually live rather than
assuming the push did it — hit a route that only exists in the new code and
check for a redirect rather than a 404:

    curl -s -o /dev/null -w "%{http_code} %{redirect_url}" https://system.xstudioz.com/<new-route>

A route that 404s is old code; a route that redirects to /login is deployed and
gated, which is the healthy answer for anything behind auth.

The container is ephemeral. Uncommitted state is lost. Commit every run.

## What the brief leads with

The top of the page is **Money sitting still** — orders open past 60 days, and
quotes that never became orders. Both are computed live in
`xstudioz/recovery.py` on every run. This is the centre of the page on purpose:
it is the only block of money that needs no new traffic, no marketplace lever
and nobody's permission. Ezan owns all of it.

Two traps live in this data, and both are already handled in code. Do not
re-introduce either in prose:

- **An open order is not one thing.** Before any message goes out, each order
  has to be sorted into *we owe work*, *they owe a reply*, or *dead* — see
  `playbooks/stale_orders.md`. A "just checking in" note sent to a buyer who is
  waiting on us is how a late order becomes a dispute.
- **Follow-up counts are not a measure of neglect.** Quoted leads with no
  logged follow-up convert at ~91%, because a follow-up only ever gets logged
  when the buyer did not say yes immediately. `recovery.followup_benchmark`
  reports the rate *within* the followed-up group instead, and that is what the
  task is costed on. Never quote the raw split as if chasing were harmful.

Never attach a review request to any of this work. These are late or cold
orders, and a review ask on a late delivery is the most reliable way to turn a
private 3-star into a public one.

## Rules that do not bend

1. **Read-only on all source sheets.** The team depends on them live.
2. **Never fabricate a number.** If a source is missing, the brief says MISSING. The
   engine already emits a task for each missing source; leave it there.
3. **Every task needs an owner, a number in its rationale, and ≥2 concrete steps.**
   The rubric enforces this; do not hand-write tasks that would fail it.
4. **Every prediction needs a resolvable metric path and a date.** If you cannot state
   how it would be proven wrong, it is not a prediction.
5. **The volume programme is retired and no output may name it.** The names still
   live inside the engine — metric keys, self-check arithmetic, sheet headers — so
   the leak is never prose anyone wrote, it is raw internals reaching a renderer.
   Scrubbing happens in `build_dashboard.e()`, which every rendered string passes
   through, so it holds for data paths that do not exist yet. Do not scrub at a
   call site; that only fixes the one you noticed.
6. **Never recommend anything that violates Fiverr ToS** — no review manipulation, no
   asking buyers to withdraw reviews, no incentivised ratings. The account is worth
   more than any order.
7. **Distinguish correlation from causation in prose.** The organic decline and the
   start of directed volume are *correlated*; 16 days is not proof of a cut. The
   engine logs a falsifiable prediction about it precisely so this resolves on
   evidence rather than on argument. Say so.

## What makes this system self-improving

Every forecast is written to `data/state/predictions.jsonl` with a resolution date and
a metric path. On each run the ledger resolves everything due, scores it, and updates
`data/state/calibration.json`. Interval widths for future forecasts are derived from
realised coverage, so stated confidence converges on real accuracy.

**Your part:** when a prediction resolves badly, do not just note it. Ask why the model
was wrong and change the model. A miss that produces no change is a wasted miss.

## Known parsing traps

These are fixed and pinned by tests. They are listed because each one produced
confident, wrong numbers for months, and the next one will look just as normal.

| Trap | What it did | Guard |
|---|---|---|
| Trailing blank rows | Sheets are sized generously; a checkbox column renders `FALSE` in every unused row, so the padding is not literally blank. Forward-filling it stamped the last real order's date and client onto 8,339 empty rows — inventing one client with 1,311 orders in a day. | `ingest._is_padding` |
| `"5 star"` ratings | CSRs type the unit. 374 real ratings carried a `star` suffix; a bare `float()` turned every one into "no review", understating review capture sevenfold and putting a fabricated task at the top of every brief. | `contracts.to_rating` |
| OS-driven dark mode | The page defined a light palette and then handed it to a `@media (prefers-color-scheme: dark)` block that rewrote all twenty tokens. Nothing in the source looks wrong — the light values are right at the top — so it passed review twice while everyone whose laptop was set to dark opened a dark page they had explicitly not asked for. | `test_no_output_lets_the_os_pick_the_colour_scheme` |
| Unserialised evidence | `breach_reasons` never reached the run JSON, so the dashboard printed "No breach" directly beneath a red BREACH badge. | `MetricBundle.as_dict` |

The shared lesson: a number that looks plausible is not evidence that the
parse was right. When a metric drives a task, check the raw column
distribution before trusting it — `collections.Counter` over the source cells
takes a minute and has caught every one of these.

## Adding a new data source

1. Add it to `config/sources.yml` (and remove it from `expected_but_missing`).
2. Add its header spellings to the relevant alias table in `xstudioz/ingest.py`.
3. Add a schema-drift test in `tests/test_engine.py`.
4. Run `python3 -m pytest tests/ -q`. All tests must pass before the source goes live.

## Retiring a data source

The hub replaced three sheets on 2026-08-05: impressions, team review, and
resources + upsell. Deleting a source from `config/sources.yml` does **not**
stop it being read. Tables are detected by header fingerprint, so a retired
sheet still present in a snapshot keeps being classified, and a sheet whose own
rule is gone does not go unclassified: it falls through to the next fingerprint
that fits. The impressions sheet carries its own organic and directed order
columns, so unclaimed it becomes the daily ledger and doubles every order in it.

To retire a sheet:

1. Add it to `RETIRED_ROLES` in `xstudioz/ingest.py`, with where the data lives
   now. Add a header fingerprint to `RETIRED_FINGERPRINTS` that no live table
   could match, so the sheet is refused even without its id or its role tag.
2. Move it from `sources` to `retired` in `config/sources.yml`.
3. Take its `fileId` out of `SOURCES` in `automation/Snapshot.gs`, and leave
   its `ROLE_RULES` entry in place so a returning tab arrives under its own
   name rather than the ledger's.
4. Add a test that fails if one of its tables is ingested.

What the ingester refuses it counts. The count reaches the run JSON, the Health
view and the `retired_sources_refused` self-check, and `daily_run.py` prints a
`[retired]` line. That check is a warning, not a block: refusing the rows keeps
the numbers right, and the warning exists so nobody has to notice on their own
that the same fact is being kept in two places.

## Changing policy

Numbers live in `config/profile.yml`, not in code. To change the risk appetite, edit
`dosing.max_vvro_share`. To change growth targets, edit `targets`. To change what the
gate accepts, edit `selfcheck`. Never hard-code a policy number into a module.
