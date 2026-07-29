# Runbook

## Daily (automated)

A Claude Routine (`trig_012hMr9MJEmXYWyRDakBY1Pv`) fires at 02:13 UTC each morning,
follows `CLAUDE.md`, and commits the result.

**Before it can refresh data it needs the Google Drive connector attached — see
`docs/ACCESS.md`.** Without it the run still happens, but on the last snapshot, and the
self-check flags the staleness.
Nothing is required from you unless the self-check fails or a task is assigned to you.

## Running it by hand

```bash
# 1. Snapshots must exist for the date you are running
ls data/raw/orders data/raw/inquiries

# 2. Run
python3 scripts/daily_run.py --date 2026-07-29

# 3. Read
cat reports/latest.md
```

## Backfilling history

```bash
python3 scripts/backfill.py --from 2026-06-03 --to 2026-07-29
```

Backfill uses only snapshots dated on or before each simulated day, so it cannot see the
future. That is what makes the resulting prediction scores meaningful rather than
flattering. A backfill that peeked would report excellent calibration and teach you nothing.

## When the gate blocks

Exit code `1` means the engine does not trust its own output. Read stderr:

```
[BLOCK] dose_within_share_cap: projected VVRO share 58.30% vs cap 45% — dose exceeds the cap it was clamped to
```

| Block | Meaning | Fix |
|---|---|---|
| `dose_within_share_cap` | Controller bug | Fix `xstudioz/dosing.py`, add a regression test |
| `no_raise_under_breach` | Objective violated | Controller bug; must never ship |
| `week_pattern_sums_to_quota` | Allocation bug | Fix `spread_week` |
| `schema_drift` | A sheet changed shape | Add the header to the alias table or `IGNORED_HEADERS` |
| `data_freshness` | Sheets not updated | Chase the team; state the staleness in the brief |
| `all_tasks_owned` | Generation bug | A rule emitted a task with no owner |

## Tuning policy

All policy is in `config/profile.yml`.

| Want to… | Change |
|---|---|
| Take more/less inorganic risk | `dosing.max_vvro_share` |
| Cap daily placements | `dosing.max_per_day` |
| Change how fast the dose cuts | `dosing.step_down` |
| Change growth targets | `targets.*` |
| Loosen/tighten the organic constraint | `objective.subject_to[0].tolerance` |
| Change how strict the gate is | `selfcheck.min_rubric_score` |

Never hard-code a policy number into a module. The tests read the same config, so a
policy change is validated by the suite automatically.

## Tests

```bash
python3 -m pytest tests/ -q          # 144 tests, ~0.3s
python3 -m pytest tests/ -q -k dose  # controller only
```

The property tests (`test_dose_never_breaches_share_cap`) sweep the input space rather
than checking hand-picked cases. They have already caught two real bugs: a `round()`
that pushed the dose over the cap it had just been clamped to, and a weekly-quota
round-up that did the same thing one level higher.

## If something looks wrong in the brief

Every number traces back. `reports/<date>-run.json` holds the full artefact set, and every
canonical record carries a `provenance` ref like `orders/order_history#b3r17` — source,
table, block index, row index. Open the sheet at that row.
