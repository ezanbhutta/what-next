#!/usr/bin/env python3
"""Replay the engine day by day over a historical range.

Two uses:

**Seed the ledger.** The user asked for predictions starting 2026-06-03. Running
forward from that date builds a real track record instead of starting from zero,
so the calibration layer has something to calibrate against on day one.

**Backtest the controller.** Because each simulated day sees only snapshots dated
on or before it, the replay cannot peek at the future. That restriction is the whole
point: a backfill that peeked would report excellent calibration and teach you nothing.

Note the honest limitation — snapshots only exist from the day they were first
captured. Replaying a date earlier than the first snapshot uses that snapshot, which
*does* contain later rows. The engine filters by date where it can (flow windows,
order dates), but lifetime aggregates like AOV are computed over whatever the snapshot
holds. Treat pre-first-snapshot scores as indicative, not clean. The summary flags
exactly which days are affected.

Usage
-----
    python3 scripts/backfill.py --from 2026-06-03 --to 2026-07-29
    python3 scripts/backfill.py --from 2026-06-03 --to 2026-07-29 --step 7
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from xstudioz import pipeline  # noqa: E402
from scripts.daily_run import latest_snapshot, read_tracker  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--from", dest="start", required=True)
    ap.add_argument("--to", dest="end", required=True)
    ap.add_argument("--step", type=int, default=1, help="days between runs")
    ap.add_argument("--root", default=str(ROOT))
    ap.add_argument("--no-write", action="store_true")
    args = ap.parse_args()

    root = Path(args.root)
    start = _dt.date.fromisoformat(args.start)
    end = _dt.date.fromisoformat(args.end)
    raw = root / "data" / "raw"

    # Earliest snapshot we hold; days before it cannot be replayed cleanly.
    first_snap = None
    for sub in ("orders", "inquiries"):
        d = raw / sub
        if d.exists():
            for p in d.glob("*.md"):
                try:
                    sd = _dt.date.fromisoformat(p.stem[:10])
                except ValueError:
                    continue
                if first_snap is None or sd < first_snap:
                    first_snap = sd

    tracker = read_tracker(raw / "order_tracker")
    rows: list[dict] = []
    day = start
    while day <= end:
        o = latest_snapshot(raw / "orders", day) or latest_snapshot(raw / "orders", end)
        i = (latest_snapshot(raw / "inquiries", day)
             or latest_snapshot(raw / "inquiries", end))
        g = latest_snapshot(raw / "gig", day, suffixes=(".json",))
        if not o and not i:
            print(f"[skip] {day}: no snapshots", file=sys.stderr)
            day += _dt.timedelta(days=args.step)
            continue

        art = pipeline.run_daily(
            root=root, today=day,
            orders_text=o.read_text(encoding="utf-8") if o else "",
            inquiries_text=i.read_text(encoding="utf-8") if i else "",
            tracker_rows=tracker,
            gig=json.loads(g.read_text()) if g else None,
            write=not args.no_write)

        lookahead = bool(first_snap and day < first_snap)
        rows.append({
            "date": day.isoformat(),
            "health": art.bundle.health.verdict(),
            "index": art.bundle.health.index,
            "organic_ma7": round(art.bundle.health.ma7_now, 3),
            "quota": art.plan.weekly_quota,
            "action": art.plan.action,
            "binding": art.plan.binding_constraint,
            "tasks": len(art.tasks),
            "score": art.check.score,
            "emitted": art.emitted,
            "lookahead_risk": lookahead,
        })
        flag = " ⚠ lookahead" if lookahead else ""
        print(f"{day}  {art.bundle.health.verdict():<10} idx={art.bundle.health.index:>5.1f} "
              f"org={art.bundle.health.ma7_now:.2f}/d  quota={art.plan.weekly_quota:>2}/wk "
              f"{art.plan.action:<6} {art.plan.binding_constraint:<24} "
              f"tasks={len(art.tasks):>2} gate={art.check.score:>5.1f}"
              f"{'' if art.emitted else '  BLOCKED'}{flag}")
        day += _dt.timedelta(days=args.step)

    if not rows:
        print("[error] nothing replayed", file=sys.stderr)
        return 2

    out = root / "reports" / f"backfill-{start}-to-{end}.json"
    if not args.no_write:
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(rows, indent=2))

    tainted = sum(1 for r in rows if r["lookahead_risk"])
    blocked = sum(1 for r in rows if not r["emitted"])
    breaches = sum(1 for r in rows if r["health"] == "BREACH")
    print(f"\n{len(rows)} days replayed · {breaches} breach days · {blocked} blocked "
          f"· mean gate score "
          f"{sum(r['score'] for r in rows) / len(rows):.1f}")
    if tainted:
        print(f"⚠ {tainted} day(s) precede the first snapshot ({first_snap}) and may "
              f"include look-ahead in lifetime aggregates — treat those scores as "
              f"indicative only.")
    if not args.no_write:
        print(f"written: {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
