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
python3 scripts/publish_site.py        # site/index.html (gated, for the team)
```

Then republish the artifact to the same URL so the link you and Ezan already
have stays current:

    Artifact(file_path="reports/dashboard.html",
             url="https://claude.ai/code/artifact/efdf1312-b4e7-4974-960d-4a035031cdaf",
             favicon="📉")

Passing `url` is what keeps the URL stable from a fresh session. Do not change
the `<title>` or the favicon — the page is found by its name and tab icon.

`site/index.html` is generated, never hand-edited. Committing it in step 6
is what deploys it: Vercel redeploys on push, so the team's page is current by
07:15 PKT without anyone touching it. If the Vercel project is not linked yet,
the file is still committed and simply waits — see `site/README.md`.

### 5. Report to the user

Lead with the single most important thing, then the task list. Keep it short — the full
detail is in `reports/latest.md`. Always state:

- the organic health verdict and whether the constraint is breached,
- today's VVRO instruction (weekly quota, not a vague direction),
- the top 3 tasks with owners,
- anything the self-check flagged.

### 6. Commit

```bash
git add -A && git commit -m "daily: <date> brief" && git push -u origin claude/xstudioz-growth-automation-dj8u2z
```

The container is ephemeral. Uncommitted state is lost. Commit every run.

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

## Adding a new data source

1. Add it to `config/sources.yml` (and remove it from `expected_but_missing`).
2. Add its header spellings to the relevant alias table in `xstudioz/ingest.py`.
3. Add a schema-drift test in `tests/test_engine.py`.
4. Run `python3 -m pytest tests/ -q`. All tests must pass before the source goes live.

## Changing policy

Numbers live in `config/profile.yml`, not in code. To change the risk appetite, edit
`dosing.max_vvro_share`. To change growth targets, edit `targets`. To change what the
gate accepts, edit `selfcheck`. Never hard-code a policy number into a module.
