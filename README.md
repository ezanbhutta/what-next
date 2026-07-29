# XStudioz Growth Engine

An autonomous daily decision system for the Fiverr profile **x_studioz**.

Every morning it reads the live sheets, recomputes where the business actually is,
decides how many inorganic (VVRO) orders to place, generates an owned and evidenced
task list for the team, makes falsifiable predictions, scores yesterday's predictions,
and refuses to publish any of it if its own checks fail.

```
        ┌─ Apps Script timer ──▶ snapshot file ──┐
Sheets ─┤                                        ├─▶ ingest ─▶ validate ─▶ metrics
        └─ Apps Script web app ◀── HTTPS ────────┘                            │
                                                                              ▼
   brief + dashboard ◀── self-check gate ◀── tasks ◀── dose controller ◀───────┤
                                 ▲                                            │
                                 └────────── ledger ◀── forecast ◀────────────┘
```

Intake is **belt and braces**: two independent producers of the same snapshot, and
the engine takes whichever is newer. Neither needs a Google connector grant — the
Apps Script lives in your own account and serves JSON over plain HTTPS. Setup is in
[`automation/README.md`](automation/README.md) and takes about fifteen minutes, once.

## The objective

> **Maximise monthly revenue, subject to organic order flow recovering.**

Organic flow is a hard constraint. The controller will not scale VVRO while organic is
breached, regardless of the revenue gap — and `tests/test_engine.py` asserts that as a
property over the whole input space, not just the cases we thought of.

## What the baseline scan found

Scanned on 2026-07-29 across 803 order rows, 1,000 inquiries, 326 daily-ledger days and
the live gig page.

| Finding | Number |
|---|---|
| **Organic declined since VVRO began** (2026-07-13) | 0.66 → 0.56 orders/day, **−14.3%** |
| VVRO share of orders, last 7d | **79%** against a 45% policy cap |
| Gig | Level 2, **1,582 reviews**, 4.837★, 20 in queue |
| AOV | **$137** (median $100, Q3 $175) |
| Inquiry conversion | **33.5%** (324 / 968) |
| Upsell attempted → conversion | **54.3%** vs 30.8% without (z = 4.05) |
| Morning vs Evening shift | **38.5%** vs 22.0% |
| Third follow-ups | **0 placed of 19** |
| Review capture | **13.6%** of reviewable orders |
| Upsell column filled | **0.0%** of 492 orders |
| Daily ledger revenue | **$0 across 111 days with orders** |
| Broken ClickUp sync | **334 logged failures** |

The organic decline is *correlated* with the VVRO ramp, not proven caused by it — 16 days
is a short window. The engine logs a falsifiable prediction about the corrective cut so
the question resolves on evidence rather than opinion.

## Quick start

```bash
pip install pyyaml openpyxl pytest

python3 -m pytest tests/ -q                 # 164 tests
python3 scripts/daily_run.py                # brief -> reports/latest.md
python3 scripts/build_dashboard.py          # page  -> reports/dashboard.html
```

Once the snapshot endpoint is deployed, set `XSTUDIOZ_SNAPSHOT_URL` and
`XSTUDIOZ_SNAPSHOT_TOKEN` and the fetch happens automatically. Without them the
engine falls back to on-disk snapshots, then to markdown exports — "not configured
yet" is not treated as an error.

Exit codes: `0` passed the gate · `1` produced but failed its own gate · `2` no snapshots.

## Layout

| Path | What it is |
|---|---|
| `config/profile.yml` | The objective, constraints, targets, measured levers. **All policy lives here, not in code.** |
| `config/sources.yml` | Where to read from, and what is still missing |
| `automation/Snapshot.gs` | Apps Script: serves the snapshot, runs the daily timer, scaffolds the missing sheets |
| `xstudioz/snapshot.py` | The snapshot contract, fetching, freshest-wins selection |
| `xstudioz/contracts.py` | Canonical records, coercion, validation |
| `xstudioz/ingest.py` | Schema-drift-tolerant parsing (handles 10 header layouts) |
| `xstudioz/metrics.py` | KPIs, organic health index, Wilson bounds, rating maths |
| `xstudioz/dosing.py` | The constrained VVRO controller |
| `xstudioz/forecast.py` | Damped-trend forecasts with Poisson intervals |
| `xstudioz/ledger.py` | Prediction ledger, scoring, interval recalibration |
| `xstudioz/tasks.py` | Rule-based task generation |
| `xstudioz/selfcheck.py` | Invariants, consistency, rubric, auto-repair |
| `xstudioz/report.py` | Brief rendering |
| `xstudioz/pipeline.py` | End-to-end run |
| `scripts/build_dashboard.py` | Renders the self-contained HTML control panel |
| `playbooks/` | The "handle this case like this" scripts |
| `reports/` | Generated briefs, one per day |
| `data/state/` | Prediction ledger, calibration, controller state |

## Why organic flow moved

Orders decompose multiplicatively — `orders = impressions × CTR × close-rate` — so a
decline has exactly three possible sources, and they need **opposite** responses:

| Factor fell | Kind of problem | What to work on |
|---|---|---|
| Impressions | Ranking | Review velocity, on-time delivery, response time |
| CTR | Listing | Thumbnail, title, price point, badge |
| Close rate | Gig page and handling | Copy, packages, response speed, CSR quality |

`metrics.decompose_funnel` attributes the movement using a log decomposition (exact
for a product), names the dominant factor, and emits a task pointing at the right
kind of work. It refuses to attribute when no single factor reaches 45% of the swing,
and says "unknown" loudly when the impression sheet does not exist yet — which today
it does not. That sheet is worth more than the other two missing sources combined.

## How it self-improves

Each forecast is stored with a resolvable metric path, an 80% interval and a resolution
date. On every run the ledger scores what is due and writes a calibration profile.
Interval widths for future forecasts derive from *realised* coverage, so stated
confidence converges on real accuracy instead of staying at whatever felt right on day one.

Predictions whose metric path stops resolving are marked `unresolvable` rather than
dropped — a metric key that vanished is itself a defect worth surfacing.

## How it validates itself

Before any brief is emitted:

- **Invariants** — the dose must respect the share cap it was clamped to; a breach must
  never coincide with a raise; price bands must sum to the dose; the week pattern must
  sum to the quota.
- **Consistency** — AOV recomputed from revenue ÷ orders; flow totals recomputed from
  organic + VVRO; health delta recomputed from the moving averages. Disagreement blocks.
- **Rubric** (0–100) — every task owned, evidenced with a number, and ≥2 concrete steps;
  every prediction falsifiable and dated; priorities actually spread.
- **Auto-repair** — drops unowned tasks, clamps out-of-interval points, trims overlong
  lists. It never invents content, because inventing an owner would defeat the check
  that exists to catch a missing one.

Source-data mistakes never block a run. Finding them *is* the product: they become tasks.
Only engine-domain errors — a broken schema, arithmetic that does not close — stop the line.

## Read-only guarantee

The engine never writes to any Google Sheet. It reads snapshots and emits into
`reports/` and `data/`. Verified by inspection: no Drive write tool is referenced
anywhere in `xstudioz/`.
