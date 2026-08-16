"""The impressions board, read directly, because the sheet behind it stopped.

WHY THIS MODULE EXISTS

Impressions reached the engine through a Google Sheet that a person filled in.
On 2026-08-07 the team moved to entering them on the impressions board instead,
and the sheet has had nothing new since 2026-08-06. That is visible in the
board's own data: every row up to 2026-08-06 carries `entered_by: "Sheet
import"`, and every row after it was typed straight in.

So the sheet is not stale in the ordinary sense. It was superseded, and no
amount of asking will bring it current. The engine went on reading it anyway
and went on emitting a P0 task telling somebody to update it, while nine days
of real reach data sat in a table the hub was already reading on another page.

`/feeds` had been carrying the evidence the whole time. It reports the sheet
and the board as two rows precisely so that a gap between them is visible, and
CLAUDE.md says in as many words that such a gap means the import has stalled.
It was showing one. Nobody read it as the signal it was designed to be, which
is worth more attention than the missing days: an instrument nobody reads is
not an instrument.

WHAT THIS DOES NOT DO

It never writes. `harden.sql` on that project revokes insert, update and delete
from `anon` and the key used here is the anon key, so a write would fail — but
this module does not attempt one regardless. The board belongs to another team
and this engine is a reader of it.

It does not hardcode the gig list. `profiles` on the board carries an `account`
column, and the gigs are read from it, because the account gained a third gig
once already and nothing had to change to pick it up. A copy of that list kept
here would be a copy to forget.
"""
from __future__ import annotations

import datetime as _dt
import json
import os
import urllib.parse
import urllib.request
from typing import Any

from . import contracts as C
from .contracts import Provenance

#: Where the board lives. Overridable for the same reason the hub allows it:
#: if the project ever moves, that is configuration, not a code change.
DEFAULT_URL = "https://jkigyrnvlfcwloqtrycu.supabase.co"

URL_ENV = "IMPRESSIONS_SUPABASE_URL"
KEY_ENV = "IMPRESSIONS_SUPABASE_KEY"

#: The board's `account` value for this hub's profile. Its `profile` column is
#: a GIG, not an account -- "XStudioz" and "XStudioz Logo" are two gigs of one
#: account, exactly as "Dygram" and "Dygram PPT" are two of another. Matching on
#: the account and then reading its gigs is what keeps a new gig arriving on its
#: own.
ACCOUNT = "XStudioz"

DEFAULT_TIMEOUT = 20.0


class BoardError(RuntimeError):
    """The board could not be read. Never raised for 'it answered, but empty'."""


def configured(env: dict[str, str] | None = None) -> bool:
    env = os.environ if env is None else env
    return bool(env.get(KEY_ENV))


def _base(env: dict[str, str] | None = None) -> str:
    env = os.environ if env is None else env
    return (env.get(URL_ENV) or DEFAULT_URL).rstrip("/")


def _get(path: str, env: dict[str, str] | None = None,
         timeout: float = DEFAULT_TIMEOUT) -> list[dict[str, Any]]:
    """One PostgREST read. Raises BoardError; never returns [] for a failure."""
    env = os.environ if env is None else env
    key = env.get(KEY_ENV)
    if not key:
        raise BoardError(
            f"{KEY_ENV} is not set, so the impressions board cannot be read. "
            f"It is the anon key of the project the hub already reads; set it "
            f"wherever the engine runs."
        )
    req = urllib.request.Request(
        f"{_base(env)}/rest/v1/{path}",
        headers={"apikey": key, "Authorization": f"Bearer {key}",
                 "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            if resp.status != 200:
                raise BoardError(f"the board answered {resp.status}")
            return json.loads(resp.read().decode("utf-8"))
    except BoardError:
        raise
    except Exception as exc:  # noqa: BLE001 - surfaced verbatim to the runner
        raise BoardError(f"the board could not be reached: {exc}") from exc


def gigs(env: dict[str, str] | None = None,
         timeout: float = DEFAULT_TIMEOUT) -> list[str]:
    """This account's gigs, from the board's own `profiles` table."""
    q = urllib.parse.urlencode({"select": "name,account",
                                "account": f"eq.{ACCOUNT}"})
    rows = _get(f"profiles?{q}", env, timeout)
    return sorted({str(r["name"]) for r in rows if r.get("name")})


def _in_filter(values: list[str]) -> str:
    """A PostgREST `in.(...)` value, ready to be percent-encoded.

    Built as a value and handed to urlencode rather than pasted into the query
    string. Two of this account's three gigs have a space in the name --
    "XStudioz Logo" and "X_Studioz new gig" -- and a raw space makes urllib
    refuse the whole URL as containing a control character. The first live run
    of this module failed on exactly that and fell back to the sheet.
    """
    return "in.(" + ",".join(f'"{v}"' for v in values) + ")"


#: board column -> Impression field. `vvro_orders` is the retired programme's
#: name in somebody else's schema; it lands on `directed_*` here and the name
#: never travels any further. Scrubbing at the renderer covers output, but a
#: field named after it inside the engine is one more place for it to surface.
COLUMNS: dict[str, str] = {
    "impressions": "impressions",
    "clicks": "clicks",
    "total_orders": "orders",
    "organic_orders": "organic_orders",
    "vvro_orders": "directed_orders",
    "organic_price": "organic_price",
    "vvro_price": "directed_price",
    "orders_completed": "orders_completed",
    "completed_price": "completed_price",
    "order_queue": "order_queue",
}


def fetch_rows(profiles: list[str] | None = None,
               env: dict[str, str] | None = None,
               timeout: float = DEFAULT_TIMEOUT) -> list[dict[str, Any]]:
    """Raw `entries` rows for this account's gigs, oldest first."""
    names = profiles if profiles is not None else gigs(env, timeout)
    if not names:
        return []
    q = urllib.parse.urlencode({
        "select": ",".join(["date", "profile", "entered_by", *COLUMNS]),
        "profile": _in_filter(names),
        "order": "date.asc",
    })
    return _get(f"entries?{q}", env, timeout)


def to_impressions(rows: list[dict[str, Any]],
                   source_id: str = "impressions_board") -> list[C.Impression]:
    """Board rows as Impression records.

    A row whose every figure is blank is DROPPED rather than recorded as zeroes.
    The board pre-creates rows the way the sheet pre-created blocks, and a run
    of zeroes in a reach series reads as a collapse — which is the one thing
    the contract says this series must never invent.
    """
    out: list[C.Impression] = []
    for r_i, row in enumerate(rows):
        day = C.to_date(str(row.get("date") or ""))
        if day is None:
            continue
        profile = C.normalise_profile(str(row.get("profile") or "").strip())
        if not profile:
            continue

        vals: dict[str, float | None] = {}
        for src, dst in COLUMNS.items():
            v = row.get(src)
            vals[dst] = None if v is None else C.to_money(v)
        if not any(v is not None for v in vals.values()):
            continue

        out.append(C.Impression(
            date=day,
            provenance=Provenance(source_id=source_id, table_id="entries",
                                  block_index=0, row_index=r_i),
            profile=profile,
            impressions=vals.get("impressions") or 0.0,
            clicks=vals.get("clicks") or 0.0,
            orders=vals.get("orders") or 0.0,
            organic_orders=vals.get("organic_orders"),
            directed_orders=vals.get("directed_orders"),
            organic_price=vals.get("organic_price"),
            directed_price=vals.get("directed_price"),
            orders_completed=vals.get("orders_completed"),
            completed_price=vals.get("completed_price"),
            order_queue=vals.get("order_queue"),
        ))
    return out


def merge_over_sheet(sheet: list[C.Impression],
                     board: list[C.Impression]) -> list[C.Impression]:
    """Board wins per (date, profile); sheet rows survive where it has none.

    The board is authoritative because it is the corrected copy: when the sheet
    held a duplicated 5-Aug of 10,096/262, the board already carried the fixed
    10,455/256. But it is an override, not a replacement, so a day the sheet has
    and the board does not is still counted. Losing history to gain freshness
    would be a bad trade and an invisible one.
    """
    merged: dict[tuple[_dt.date, str], C.Impression] = {
        (i.date, i.profile or ""): i for i in sheet
    }
    for i in board:
        merged[(i.date, i.profile or "")] = i
    return [merged[k] for k in sorted(merged)]


def newest_date(records: list[C.Impression], profile: str | None = None) -> _dt.date | None:
    days = [i.date for i in records
            if profile is None or (i.profile or "") == profile]
    return max(days) if days else None
