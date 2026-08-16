"""Every feed this system runs on, and whether it is actually current.

WHY THIS MODULE EXISTS

The system has six inputs. Each one was individually checkable and none of them
was checked together, so the honest answer to "is the system live?" was "open
six things and work it out". Nobody does that daily, which means the real answer
was always "probably", and on 2026-08-07 "probably" was wrong by a whole
verdict: the engine on a 44-hour-old snapshot reported organic in BREACH at
index 26, and the same engine on the live snapshot reported HEALTHY at 79.

A feed has three states and they are not the same thing:

    live        it answered, and its newest data is recent enough to use
    stale       it answered, and its newest data is older than it should be
    unreachable it did not answer, or was never configured

`stale` and `unreachable` are both bad and they need different fixes: stale
means somebody has stopped filling something in, unreachable means a credential
or a service. Collapsing them into "not ok" sends whoever is on it to the wrong
place, so they stay distinct all the way to the screen.

WHAT THIS MODULE DOES NOT DO

It does not probe the two Supabase stores. Their keys belong to the hub, not to
the engine, and copying a credential into a second place so a status page can be
tidy is how credentials get committed. The hub probes those itself and joins
them to this on the page. Each side checks what it already has the right to
read.
"""
from __future__ import annotations

import datetime as _dt
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

#: Hours after which a feed is stale. These are not uniform, because the feeds
#: do not update on the same clock and one threshold would either cry wolf on
#: the slow ones or stay silent on the fast ones.
THRESHOLDS_H: dict[str, float] = {
    # Fiverr publishes a day's figures around midday the next day, so 26 hours
    # is the normal maximum for a healthy morning and anything past it is a gap.
    "sheets": 26.0,
    # The gig page is scraped by hand because Fiverr blocks a plain fetch. A
    # week is tolerable for level and review counts; past that the rating maths
    # is describing a profile that has moved.
    "gig": 168.0,
    # The CSR handoff tracker is uploaded, not fetched. Two weeks.
    "tracker": 336.0,
}


@dataclass
class Feed:
    key: str
    label: str
    #: Where it comes from, in words a person can act on.
    source: str
    status: str = "unreachable"          # live | stale | unreachable
    as_of: str | None = None             # ISO date or datetime of newest data
    age_hours: float | None = None
    detail: str = ""
    #: What to do about it, when it is not live. Empty when it is.
    fix: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "key": self.key, "label": self.label, "source": self.source,
            "status": self.status, "as_of": self.as_of,
            "age_hours": self.age_hours, "detail": self.detail, "fix": self.fix,
        }


def _age_hours(when: _dt.datetime, now: _dt.datetime) -> float:
    if when.tzinfo is None:
        when = when.replace(tzinfo=_dt.timezone.utc)
    return (now - when).total_seconds() / 3600.0


def _classify(feed: Feed, threshold_h: float) -> None:
    if feed.age_hours is None:
        feed.status = "unreachable"
        return
    feed.status = "live" if feed.age_hours <= threshold_h else "stale"


def sheets_feed(intake: dict[str, Any] | None, now: _dt.datetime) -> Feed:
    """The order and inquiry workbooks, via the Apps Script snapshot."""
    f = Feed(
        key="sheets",
        label="Order and inquiry workbooks",
        source="Apps Script snapshot endpoint",
    )
    intake = intake or {}
    path = intake.get("path")
    f.age_hours = intake.get("age_hours")
    f.as_of = intake.get("generated_at")

    if path == "markdown":
        f.status = "unreachable"
        f.detail = ("built from a markdown export, which cannot separate profiles "
                    "and truncates")
        f.fix = "Set XSTUDIOZ_SNAPSHOT_URL and XSTUDIOZ_SNAPSHOT_TOKEN and re-run."
        return f

    _classify(f, THRESHOLDS_H["sheets"])
    if path == "live":
        f.detail = f"fetched live, {intake.get('tables', '?')} tables"
    elif path == "disk":
        f.detail = "read from a snapshot on disk; the live endpoint was " + (
            "not reachable" if intake.get("endpoint_configured") else "not configured")
        if not intake.get("endpoint_configured"):
            f.fix = ("Export XSTUDIOZ_SNAPSHOT_URL and XSTUDIOZ_SNAPSHOT_TOKEN "
                     "before the run. Without them every run silently uses "
                     "whatever snapshot happens to be on disk.")
        else:
            f.fix = "The endpoint is configured but did not answer. Check the Apps Script deployment."
    return f


def impressions_source_feed(intake: dict[str, Any] | None, now: _dt.datetime) -> Feed:
    """Which source today's impressions actually came from.

    Separate from the freshness row below, because "the numbers are old" and
    "the engine is reading the wrong place" are different sentences with
    different fixes, and for nine days in August the second one was the true
    one while only the first was on the page.

    The sheet stopped on 2026-08-06 when the team moved to the board. Reading
    the sheet after that is not a stale feed, it is the wrong feed, and it will
    never come right no matter who is asked to fill something in.
    """
    f = Feed(key="impressions_source", label="Impressions source",
             source="impressions board, via IMPRESSIONS_SUPABASE_KEY")
    note = ((intake or {}).get("impressions") or {})
    if note.get("source") == "board":
        f.status = "live"
        f.age_hours = 0.0
        f.as_of = note.get("board_newest")
        f.detail = (f"{note.get('board_rows', '?')} row(s) from the board, "
                    f"overriding {note.get('sheet_rows', '?')} from the sheet")
        return f
    f.status = "unreachable"
    f.detail = "impressions came from the sheet, which stopped on 2026-08-06"
    f.fix = ("Set IMPRESSIONS_SUPABASE_KEY where the engine runs. It is the "
             "anon key of the project the hub already reads. Without it the "
             "engine reads a sheet nobody fills in any more.")
    return f


def impressions_feed(root: Path, now: _dt.datetime, profile: str = "X Studioz",
                     records: list[Any] | None = None) -> Feed:
    """The Daily Data Sheet, via the same snapshot as the workbooks.

    Its own row rather than folded into `sheets`, because it is a different tab
    filled in by a different person on a different rhythm. It was 10 days
    behind while the order workbook was current, and one combined row would
    have reported the fresher of the two and hidden that entirely.

    NOTE THIS IS THE ENGINE'S COPY, NOT WHAT /entry SHOWS. From 2026-08-07 the
    hub reads XStudioz impressions from the impressions board, on Ezan's
    instruction; the board is fed from this same sheet and holds the corrected
    figures. The engine still ingests the sheet for its reach-versus-conversion
    diagnosis, so both rows appear on /feeds and a gap between them is a real
    signal rather than a duplicate.
    """
    f = Feed(key="impressions_sheet", label="Impressions (engine copy)",
             source="board, merged over the Daily Data Sheet")

    # IN-MEMORY FIRST, AND WHY IT MATTERS.
    #
    # This read the normalized file off disk, and `collect()` runs BEFORE
    # `write_normalized`, so it was reporting the PREVIOUS run's impressions
    # every morning -- always exactly one run behind. Harmless while the sheet
    # moved a day at a time and invisible for the same reason. It stopped being
    # harmless the morning the board arrived nine days fresher than the sheet:
    # the row went on saying 2026-08-06 while the file it names had just been
    # rebuilt to 2026-08-15.
    #
    # Passing the records the run actually computed removes the ordering
    # dependency rather than reordering two calls and hoping nobody swaps them
    # back. Disk stays as the fallback for callers that have no run in hand.
    if records is not None:
        newest_day = None
        for rec in records:
            if str(getattr(rec, "profile", "") or "") != profile:
                continue
            day = getattr(rec, "date", None)
            day = day.isoformat() if hasattr(day, "isoformat") else str(day or "")[:10]
            if day and (newest_day is None or day > newest_day):
                newest_day = day
        if not newest_day:
            f.detail = f"no row for {profile} in this run"
            f.fix = "The board and the sheet both hold nothing for this profile."
            return f
        f.as_of = newest_day
        when = _dt.datetime.fromisoformat(f"{newest_day}T12:00:00+00:00")
        f.age_hours = _age_hours(when, now)
        _classify(f, THRESHOLDS_H["sheets"] + 24)
        f.detail = f"newest row {newest_day}"
        if f.status != "live":
            f.fix = (f"Nothing has been entered on the impressions board since "
                     f"{newest_day}. The sheet behind it stopped on 2026-08-06 "
                     f"and is not coming back.")
        return f

    path = root / "data" / "normalized" / "impressions.jsonl"
    if not path.exists():
        f.detail = "the last run produced no impressions file"
        f.fix = "Run the engine. If it runs and this stays empty, the sheet tab was refused."
        return f
    newest = None
    try:
        import json as _json
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            rec = _json.loads(line)
            if str(rec.get("profile") or "") != profile:
                continue
            day = str(rec.get("date") or "")[:10]
            if day and (newest is None or day > newest):
                newest = day
    except (OSError, ValueError) as exc:
        f.detail = f"impressions.jsonl could not be read: {exc}"
        return f

    if not newest:
        f.detail = f"no row for {profile}"
        f.fix = "The sheet holds no day for this profile, or the tab was refused."
        return f
    f.as_of = newest
    when = _dt.datetime.fromisoformat(f"{newest}T12:00:00+00:00")
    f.age_hours = _age_hours(when, now)
    _classify(f, THRESHOLDS_H["sheets"] + 24)  # filled in a day behind, like the rest
    f.detail = f"newest row {newest}"
    if f.status != "live":
        f.fix = f"Nobody has filled in the Daily Data Sheet since {newest}."
    return f


def gig_feed(root: Path, now: _dt.datetime) -> Feed:
    """The live Fiverr gig page capture."""
    f = Feed(
        key="gig",
        label="Fiverr gig page",
        source="browser capture into data/raw/gig/",
    )
    d = root / "data" / "raw" / "gig"
    files = sorted(d.glob("*.json")) if d.exists() else []
    if not files:
        f.detail = "no capture has ever been taken"
        f.fix = ("Fiverr returns 403 to a plain fetch. Use a browser-rendering "
                 "fetch tool on the gig URL in config/sources.yml and write the "
                 "result to data/raw/gig/<date>.json.")
        return f

    newest = files[-1]
    try:
        day = _dt.date.fromisoformat(newest.stem)
        when = _dt.datetime.combine(day, _dt.time(12, 0), tzinfo=_dt.timezone.utc)
    except ValueError:
        f.detail = f"{newest.name} is not named as a date"
        return f

    f.as_of = day.isoformat()
    f.age_hours = _age_hours(when, now)
    _classify(f, THRESHOLDS_H["gig"])
    f.detail = f"captured {day.isoformat()}"
    if f.status != "live":
        f.fix = ("Re-capture the gig page. It carries level, review total, the "
                 "star histogram, queue depth and response time, and the rating "
                 "maths is built on the histogram.")
    return f


def tracker_feed(root: Path, now: _dt.datetime) -> Feed:
    """The CSR handoff tracker workbook, uploaded by hand."""
    f = Feed(
        key="tracker",
        label="CSR handoff tracker",
        source="uploaded into data/raw/order_tracker/",
    )
    d = root / "data" / "raw" / "order_tracker"
    files = sorted(d.glob("*.xlsx"), key=lambda p: p.stat().st_mtime) if d.exists() else []
    if not files:
        f.detail = "nothing uploaded"
        f.fix = "Upload the tracker export into data/raw/order_tracker/."
        return f
    newest = files[-1]
    when = _dt.datetime.fromtimestamp(newest.stat().st_mtime, tz=_dt.timezone.utc)
    f.as_of = when.date().isoformat()
    f.age_hours = _age_hours(when, now)
    _classify(f, THRESHOLDS_H["tracker"])
    f.detail = newest.name
    if f.status != "live":
        f.fix = "Upload a fresh tracker export."
    return f


def snapshot_endpoint_feed(now: _dt.datetime) -> Feed:
    """Whether the credentials for the sheet feed are even present.

    Separate from `sheets_feed` on purpose. "The endpoint is not configured in
    this shell" and "the data is old" are different sentences with different
    fixes, and the second one is the symptom of the first.
    """
    f = Feed(
        key="snapshot_endpoint",
        label="Snapshot credentials",
        source="XSTUDIOZ_SNAPSHOT_URL / _TOKEN in the environment",
    )
    if os.environ.get("XSTUDIOZ_SNAPSHOT_URL") and os.environ.get("XSTUDIOZ_SNAPSHOT_TOKEN"):
        f.status = "live"
        f.age_hours = 0.0
        f.detail = "both present in this shell"
    else:
        f.status = "unreachable"
        f.detail = "not set in this shell, so the run cannot fetch live"
        f.fix = ("They live in the daily Routine's prompt. Any run started by "
                 "hand must export them first or it will quietly use whatever "
                 "snapshot is already on disk.")
    return f


def collect(root: Path, intake: dict[str, Any] | None = None,
            now: _dt.datetime | None = None,
            impressions: list[Any] | None = None) -> list[dict[str, Any]]:
    """Every feed the engine can check for itself."""
    now = now or _dt.datetime.now(_dt.timezone.utc)
    feeds = [
        snapshot_endpoint_feed(now),
        sheets_feed(intake, now),
        impressions_source_feed(intake, now),
        impressions_feed(root, now, records=impressions),
        gig_feed(root, now),
        tracker_feed(root, now),
    ]
    return [f.as_dict() for f in feeds]


def worst(feeds: list[dict[str, Any]]) -> str:
    """The overall verdict. Unreachable beats stale beats live: the page leads
    with the worst thing, because leading with the best is how a broken feed
    stays broken."""
    states = {f.get("status") for f in feeds}
    if "unreachable" in states:
        return "unreachable"
    if "stale" in states:
        return "stale"
    return "live"
