"""The snapshot contract — the clean intake layer.

Before this, the engine consumed Google Drive's markdown-table export: ~200k
characters per workbook, tab names lost, header cells sometimes overwritten by
data, and a hard dependency on the Drive connector being granted to whatever
session happened to be running.

A snapshot replaces all of that with one small JSON document produced by an
Apps Script that lives in the user's own Google account (see
``automation/Snapshot.gs``). It is:

*lossless but structured*
    Each tab arrives with its real name, its header row and its data rows as
    arrays. No markdown parsing, no blank-line block splitting, no guessing
    which block is which.

*canonicalised in exactly one place*
    The Apps Script deliberately does **not** map columns to canonical fields.
    Header aliasing stays in :mod:`xstudioz.ingest` so there is one
    implementation to keep correct, not two that drift.

*transport-agnostic*
    Fetched over plain HTTPS from the Apps Script web app, read from a file on
    disk, or handed in directly by a test. No connector required.

The ``schema_version`` field is the compatibility handle: the engine refuses a
version it does not understand rather than silently misreading it.
"""

from __future__ import annotations

import datetime as _dt
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

SCHEMA_VERSION = 1

#: Roles a tab can play. The Apps Script tags each tab with one; anything it
#: cannot classify arrives as ``unknown`` and is reported, never dropped.
ROLES = {
    "crm_orders",      # order history
    "daily_flow",      # the Organic vs VVRO daily ledger
    "funnel",          # inquiry / lead log
    "active_orders",   # CSR handoff tracker
    "disputes",        # disputed, dead and conflicted orders
    "automation_health",
    # Retired: replaced by the hub, refused by xstudioz.ingest. They stay
    # listed so a tab that still carries one keeps its real name in the
    # snapshot instead of arriving as "unknown". The ingester needs to say
    # "the impressions sheet is back", not "there is a tab I can't place".
    "impressions",
    "team_review",
    "resources_upsell",
    "unknown",
}

#: Roles the engine will not ingest. The authority is
#: ``xstudioz.ingest.RETIRED_ROLES``; this mirror exists so a reader of the
#: snapshot contract sees which tags are dead on arrival.
RETIRED_ROLES = frozenset({"impressions", "team_review", "resources_upsell"})


class SnapshotError(RuntimeError):
    """Raised when a snapshot cannot be trusted. Never swallowed."""


@dataclass
class Table:
    name: str
    role: str
    header: list[str]
    rows: list[list[str]]
    source_id: str = ""

    def __len__(self) -> int:
        return len(self.rows)


@dataclass
class Snapshot:
    generated_at: _dt.datetime
    generated_by: str                 # "apps_script" | "routine" | "test"
    tables: list[Table] = field(default_factory=list)
    gig: dict[str, Any] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)
    schema_version: int = SCHEMA_VERSION

    def by_role(self, role: str) -> list[Table]:
        return [t for t in self.tables if t.role == role]

    def age_hours(self, now: _dt.datetime | None = None) -> float:
        now = now or _dt.datetime.now(_dt.timezone.utc)
        gen = self.generated_at
        if gen.tzinfo is None:
            gen = gen.replace(tzinfo=_dt.timezone.utc)
        return (now - gen).total_seconds() / 3600.0

    def stats(self) -> dict[str, Any]:
        by_role: dict[str, int] = {}
        for t in self.tables:
            by_role[t.role] = by_role.get(t.role, 0) + len(t)
        return {
            "schema_version": self.schema_version,
            "generated_at": self.generated_at.isoformat(),
            "generated_by": self.generated_by,
            "tables": len(self.tables),
            "rows_by_role": by_role,
            "unknown_tables": [t.name for t in self.by_role("unknown")],
            "warnings": self.warnings,
            "has_gig": bool(self.gig),
        }


# --------------------------------------------------------------------------
# Parsing
# --------------------------------------------------------------------------

def _parse_ts(value: Any) -> _dt.datetime:
    if isinstance(value, _dt.datetime):
        return value
    text = str(value or "").strip().replace("Z", "+00:00")
    if not text:
        raise SnapshotError("snapshot has no generated_at")
    try:
        dt = _dt.datetime.fromisoformat(text)
    except ValueError as exc:
        raise SnapshotError(f"unparseable generated_at {value!r}") from exc
    return dt if dt.tzinfo else dt.replace(tzinfo=_dt.timezone.utc)


def parse(payload: dict[str, Any] | str | bytes) -> Snapshot:
    """Validate and load a snapshot document."""
    if isinstance(payload, (str, bytes)):
        try:
            payload = json.loads(payload)
        except json.JSONDecodeError as exc:
            raise SnapshotError(f"snapshot is not valid JSON: {exc}") from exc
    if not isinstance(payload, dict):
        raise SnapshotError("snapshot must be a JSON object")

    version = payload.get("schema_version")
    if version != SCHEMA_VERSION:
        raise SnapshotError(
            f"snapshot schema_version {version!r}, engine understands "
            f"{SCHEMA_VERSION}. Refusing to guess — update the engine or "
            f"redeploy automation/Snapshot.gs.")

    if payload.get("error"):
        raise SnapshotError(f"snapshot endpoint reported: {payload['error']}")

    warnings = list(payload.get("warnings") or [])
    tables: list[Table] = []
    for raw in payload.get("tables") or []:
        role = raw.get("role") or "unknown"
        if role not in ROLES:
            warnings.append(f"tab {raw.get('name')!r} has unknown role {role!r}")
            role = "unknown"
        header = [str(h) for h in (raw.get("header") or [])]
        rows = [[("" if c is None else str(c)) for c in r]
                for r in (raw.get("rows") or [])]
        tables.append(Table(name=str(raw.get("name", "")), role=role,
                            header=header, rows=rows,
                            source_id=str(raw.get("source_id", ""))))

    if not tables:
        raise SnapshotError("snapshot contains no tables")

    return Snapshot(
        generated_at=_parse_ts(payload.get("generated_at")),
        generated_by=str(payload.get("generated_by", "unknown")),
        tables=tables,
        gig=dict(payload.get("gig") or {}),
        warnings=warnings,
    )


def load(path: str | Path) -> Snapshot:
    return parse(Path(path).read_text(encoding="utf-8"))


def dump(snap: Snapshot, path: str | Path) -> Path:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({
        "schema_version": snap.schema_version,
        "generated_at": snap.generated_at.isoformat(),
        "generated_by": snap.generated_by,
        "warnings": snap.warnings,
        "gig": snap.gig,
        "tables": [{"name": t.name, "role": t.role, "source_id": t.source_id,
                    "header": t.header, "rows": t.rows} for t in snap.tables],
    }, ensure_ascii=False), encoding="utf-8")
    return p


# --------------------------------------------------------------------------
# Fetching
# --------------------------------------------------------------------------

def fetch(url: str, token: str | None = None, timeout: int = 120) -> Snapshot:
    """Fetch a snapshot from the Apps Script web app.

    Plain HTTPS with a shared token, so this works from a Claude Routine, a
    GitHub Action, a laptop or a cron box without any of them needing a
    Google connector grant. That independence is the entire point of the
    endpoint.
    """
    if token:
        sep = "&" if "?" in url else "?"
        url = f"{url}{sep}{urllib.parse.urlencode({'token': token})}"
    req = urllib.request.Request(url, headers={"User-Agent": "xstudioz-engine/1"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read()
    except urllib.error.HTTPError as exc:
        raise SnapshotError(
            f"snapshot endpoint returned HTTP {exc.code}. If 401/403, the token "
            f"is wrong; if 302, the web app is not deployed with access set to "
            f"'Anyone'.") from exc
    except urllib.error.URLError as exc:
        raise SnapshotError(f"snapshot endpoint unreachable: {exc.reason}") from exc
    return parse(body)


def fetch_from_env(timeout: int = 120) -> Snapshot | None:
    """Fetch using ``XSTUDIOZ_SNAPSHOT_URL`` / ``XSTUDIOZ_SNAPSHOT_TOKEN``.

    Returns ``None`` when no URL is configured, so callers can fall back to
    disk without treating "not set up yet" as an error.
    """
    url = os.environ.get("XSTUDIOZ_SNAPSHOT_URL", "").strip()
    if not url:
        return None
    return fetch(url, os.environ.get("XSTUDIOZ_SNAPSHOT_TOKEN", "").strip() or None,
                 timeout=timeout)


# --------------------------------------------------------------------------
# Belt and braces
# --------------------------------------------------------------------------

def pick_freshest(*candidates: Snapshot | None) -> Snapshot | None:
    """Choose the newest of several snapshots.

    The daily run has two independent producers — an Apps Script timer inside
    the user's Google account, and a live fetch by whichever session is
    running. Either can be stale or missing on any given morning. Taking the
    newer of the two means one path failing degrades freshness rather than
    stopping the run.
    """
    real = [s for s in candidates if s is not None]
    if not real:
        return None
    return max(real, key=lambda s: s.generated_at)


def latest_on_disk(directory: str | Path,
                   on_or_before: _dt.date | None = None) -> Snapshot | None:
    """Newest snapshot file, optionally restricted to on-or-before a date.

    The date restriction is what keeps backfills honest — a replayed day must
    not see a snapshot captured after it.
    """
    d = Path(directory)
    if not d.exists():
        return None
    best: tuple[_dt.datetime, Snapshot] | None = None
    for p in sorted(d.glob("*.json")):
        try:
            snap = load(p)
        except SnapshotError:
            continue
        if on_or_before and snap.generated_at.date() > on_or_before:
            continue
        if best is None or snap.generated_at > best[0]:
            best = (snap.generated_at, snap)
    return best[1] if best else None
