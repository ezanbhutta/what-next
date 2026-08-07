#!/usr/bin/env python3
"""Copy the run's outputs into the hub's data directory.

WHY THIS IS A SCRIPT AND NOT THREE `cp` LINES IN A PROMPT.

It was three `cp` lines in the daily Routine's prompt, and one of them was::

    cp data/normalized/{orders,leads,flow,impressions}.jsonl system/data/

`impressions` was retired from the engine on 2026-08-05. It still normalises,
to an empty file, so that line copied 0 bytes over the hub's 25,682-byte
`impressions.jsonl` on every successful run. Nothing failed. `cp` is not in the
business of asking whether replacing a file with nothing is what you meant.

Nothing currently READS that file, so no figure was wrong because of it. That
is luck, not design, and it is the kind of luck that runs out the day somebody
wires a page to it.

So: an empty source never replaces a non-empty destination, every copy is
printed, and the exit code is non-zero if anything was refused. A morning where
this refuses is a morning somebody needs to look, which is the whole point.

Usage:
    python3 scripts/publish_hub.py --date 2026-08-07
"""
from __future__ import annotations

import argparse
import datetime as _dt
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

#: normalized file -> whether the hub still has a reader for it. The dead ones
#: are still copied when they have content, because "nothing reads it today" is
#: a fact about today, but they are never allowed to blank an existing file.
NORMALIZED = ["orders.jsonl", "leads.jsonl", "flow.jsonl", "impressions.jsonl"]


def publish(root: Path, date: _dt.date) -> int:
    src_dir = root / "data" / "normalized"
    dst_dir = root / "system" / "data"
    dst_dir.mkdir(parents=True, exist_ok=True)

    refused: list[str] = []
    copied: list[str] = []

    run_json = root / "reports" / f"{date.isoformat()}-run.json"
    if not run_json.exists():
        print(f"[publish] no run for {date}: {run_json} is not there", file=sys.stderr)
        print("[publish] the engine did not produce today's run, so there is "
              "nothing to publish. Fix the run first.", file=sys.stderr)
        return 2
    shutil.copy2(run_json, dst_dir / "latest-run.json")
    copied.append(f"{run_json.name} -> latest-run.json")

    for name in NORMALIZED:
        src = src_dir / name
        dst = dst_dir / name
        if not src.exists():
            refused.append(f"{name}: not produced by this run")
            continue
        # THE GUARD. An empty source over a non-empty destination is data loss
        # dressed as a successful copy.
        if src.stat().st_size == 0 and dst.exists() and dst.stat().st_size > 0:
            refused.append(
                f"{name}: source is empty and would blank "
                f"{dst.stat().st_size:,} bytes already there")
            continue
        shutil.copy2(src, dst)
        copied.append(f"{name} ({src.stat().st_size:,} bytes)")

    for line in copied:
        print(f"[publish] copied {line}")
    for line in refused:
        print(f"[publish] REFUSED {line}", file=sys.stderr)

    return 1 if refused else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--date", help="run date (YYYY-MM-DD), default today UTC")
    ap.add_argument("--root", default=str(ROOT))
    args = ap.parse_args()
    date = (_dt.date.fromisoformat(args.date) if args.date
            else _dt.datetime.now(_dt.timezone.utc).date())
    return publish(Path(args.root), date)


if __name__ == "__main__":
    raise SystemExit(main())
