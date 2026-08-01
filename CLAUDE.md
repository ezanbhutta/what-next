# XStudioz Growth Engine — daily operating manual

You are the daily operator of this system. This file tells you exactly what to do
each morning. Follow it in order; do not improvise the data steps.

## The objective

**Maximise monthly revenue, subject to organic order flow recovering.**

Organic flow is a *hard constraint*, not a preference. If organic is breached you may
not recommend scaling VVRO volume, no matter how far behind revenue is. The engine
enforces this in code (`xstudioz/dosing.py`) and the self-check blocks any brief that
violates it. Do not talk around it in prose either.

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

### 4. Rebuild and publish the dashboard

```bash
python3 scripts/build_dashboard.py     # reports/dashboard.html
python3 scripts/publish_site.py --gate # site/api/brief.js (password gated)
```

Then republish the artifact to the same URL so the link you and Ezan already
have stays current:

    Artifact(file_path="reports/dashboard.html",
             url="https://claude.ai/code/artifact/efdf1312-b4e7-4974-960d-4a035031cdaf",
             favicon="📉")

Passing `url` is what keeps the URL stable from a fresh session. Do not change
the `<title>` or the favicon — the page is found by its name and tab icon.

`site/api/brief.js` is generated, never hand-edited. Committing it in step 6
is what deploys it: Vercel redeploys on push, so the team's page is current by
07:15 PKT without anyone touching it. If the Vercel project is not linked yet,
the file is still committed and simply waits — see `site/README.md`.

**Never publish without `--gate`, and never commit a `site/index.html`.** The
page carries client names, revenue and the dead pipeline. Vercel checks the
filesystem before it applies rewrites, so a static `index.html` is served *in
front of* the gate and silently reopens the whole page to anyone with the URL.
`tests/test_engine.py` fails if both exist; do not delete that test to make a
run pass.

### 5. Report to the user

Lead with the single most important thing, then the task list. Keep it short — the full
detail is in `reports/latest.md`. Always state:

- the organic health verdict and whether the constraint is breached,
- today's VVRO instruction (weekly quota, not a vague direction),
- the top 3 tasks with owners,
- anything the self-check flagged.

### 6. Commit

```bash
git config user.email "ezanmujahid@gmail.com"
git config user.name  "XStudioz Growth Engine"
git add -A && git commit -m "daily: <date> brief" && git push -u origin main
```

**Push to `main`.** It is the default branch and Vercel's production branch, so
pushing there is what deploys. The engine used to push to a long-lived
`claude/…` branch; that branch is history and nothing should target it.

**Set the email every run — it is not optional.** The container is fresh each
morning and defaults to `haseeb53810@gmail.com`, which is not attached to the
GitHub account. Vercel refuses to build a commit whose author it cannot match to
a GitHub user, and the deployment comes back `BLOCKED` with no build log at all.
The site then silently keeps serving yesterday's page, so a run can look
successful while nothing reached the team. If a push does not produce a new
READY deployment, check the commit author before anything else.

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
5. **Never recommend anything that violates Fiverr ToS** — no review manipulation, no
   asking buyers to withdraw reviews, no incentivised ratings. The account is worth
   more than any order.
6. **Distinguish correlation from causation in prose.** The organic decline since VVRO
   began is *correlated*; 16 days is not proof. The engine logs a falsifiable
   prediction about the cut precisely so this resolves on evidence. Say so.

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

## Changing policy

Numbers live in `config/profile.yml`, not in code. To change the risk appetite, edit
`dosing.max_vvro_share`. To change growth targets, edit `targets`. To change what the
gate accepts, edit `selfcheck`. Never hard-code a policy number into a module.
