"""The impressions board reader, and the merge that lets it override the sheet.

WHY THIS FILE EXISTS

Impressions reached the engine through a Google Sheet until 2026-08-07, when
the team moved to entering them on the board. Nobody told the engine. It went
on reading the sheet, went on emitting a P0 asking somebody to bring it
current, and went nine days without the reach data that was sitting in a table
the hub was already reading on another page.

`/feeds` was showing the evidence the whole time -- the sheet row and the board
row drifting apart is documented as meaning exactly this -- and it was not read
as a signal. So the tests below pin the behaviour, and one of them pins the
instrument: a run that silently falls back to the sheet has to say so.

Nothing here touches the network. `fetch_rows` is the only function that does,
and it is deliberately separable from `to_impressions` so the mapping can be
tested against fixtures rather than against whatever the board happens to hold.
"""
from __future__ import annotations

import datetime as _dt
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from xstudioz import board  # noqa: E402
from xstudioz import contracts as C  # noqa: E402
from xstudioz.contracts import Provenance  # noqa: E402


def row(date, profile="XStudioz", **kw):
    base = {"date": date, "profile": profile, "entered_by": ""}
    base.update({k: None for k in board.COLUMNS})
    base.update(kw)
    return base


def sheet_impression(day, profile="X Studioz", **kw):
    return C.Impression(
        date=_dt.date.fromisoformat(day),
        provenance=Provenance(source_id="snapshot", table_id="sheet",
                              block_index=0, row_index=0),
        profile=profile, **kw)


# --------------------------------------------------------------------------
# Mapping
# --------------------------------------------------------------------------

def test_board_rows_become_impressions_with_every_column_carried():
    recs = board.to_impressions([row(
        "2026-08-15", impressions=5246, clicks=75, total_orders=3,
        organic_orders=1, vvro_orders=2, organic_price=45.0, vvro_price=90.0,
        orders_completed=2, completed_price=120.0, order_queue=22)])
    assert len(recs) == 1
    r = recs[0]
    assert r.date == _dt.date(2026, 8, 15)
    assert (r.impressions, r.clicks, r.orders) == (5246.0, 75.0, 3.0)
    assert r.organic_orders == 1.0
    assert r.directed_orders == 2.0          # the board calls this vvro_orders
    assert r.order_queue == 22.0
    assert r.ctr() == pytest.approx(75 / 5246)


def test_the_retired_programme_name_does_not_survive_the_mapping():
    """The board's schema is somebody else's and still uses the old name.

    It maps onto `directed_*` on the way in. Output scrubbing at the renderer
    already covers prose, but a field carrying that name inside the engine is
    one more surface for it to reach a page from, and this one arrives from a
    system this repo does not control.
    """
    recs = board.to_impressions([row("2026-08-15", vvro_orders=2, vvro_price=90.0)])
    fields = vars(recs[0])
    assert not [k for k in fields if "vvro" in k.lower()]
    assert fields["directed_orders"] == 2.0
    assert fields["directed_price"] == 90.0


def test_a_row_with_no_figures_at_all_is_dropped_not_recorded_as_zeroes():
    """The board pre-creates rows, exactly as the sheet pre-created blocks.

    A run of zeroes in a reach series reads as a collapse. The contract says
    this series must never invent one, so an empty row is absent rather than 0.
    """
    recs = board.to_impressions([
        row("2026-08-14", impressions=5320, clicks=82),
        row("2026-08-15"),                     # pre-created, entirely blank
    ])
    assert [r.date for r in recs] == [_dt.date(2026, 8, 14)]


def test_a_real_zero_is_kept_because_zero_and_blank_are_different_facts():
    recs = board.to_impressions([row("2026-08-09", impressions=6141,
                                     clicks=105, organic_orders=0)])
    assert len(recs) == 1
    assert recs[0].organic_orders == 0.0       # a day with no orders
    assert recs[0].directed_orders is None     # a column nobody filled in


def test_rows_without_a_usable_date_or_profile_are_skipped():
    recs = board.to_impressions([
        row("", impressions=100),
        row("2026-08-15", profile="", impressions=100),
        row("not-a-date", impressions=100),
    ])
    assert recs == []


# --------------------------------------------------------------------------
# The merge
# --------------------------------------------------------------------------

def test_board_overrides_the_sheet_for_the_same_day_and_profile():
    """The board is the corrected copy.

    On 2026-08-05 the sheet held a duplicated 10,096/262 while the board
    already carried the fixed 10,455/256. Whichever arrives second must not
    decide it.
    """
    sheet = [sheet_impression("2026-08-05", impressions=10096.0, clicks=262.0)]
    brd = board.to_impressions([row("2026-08-05", impressions=10455, clicks=256)])
    merged = board.merge_over_sheet(sheet, brd)
    assert len(merged) == 1
    assert (merged[0].impressions, merged[0].clicks) == (10455.0, 256.0)


def test_a_day_only_the_sheet_has_survives_the_merge():
    """An override, not a replacement. Losing history to gain freshness would
    be a bad trade and an invisible one."""
    sheet = [sheet_impression("2025-09-09", impressions=1200.0),
             sheet_impression("2026-08-06", impressions=8383.0)]
    brd = board.to_impressions([row("2026-08-06", impressions=8383),
                                row("2026-08-15", impressions=5246)])
    merged = board.merge_over_sheet(sheet, brd)
    assert [m.date.isoformat() for m in merged] == [
        "2025-09-09", "2026-08-06", "2026-08-15"]


def test_the_merge_keeps_profiles_apart():
    """`profile` on the board is a GIG, not an account: XStudioz and XStudioz
    Logo are two gigs of one account. Folding them would give one profile two
    rows a day and halve every rate computed from them."""
    sheet = [sheet_impression("2026-08-15", profile="X Studioz", impressions=1.0)]
    brd = board.to_impressions([
        row("2026-08-15", profile="XStudioz", impressions=5246),
        row("2026-08-15", profile="XStudioz Logo", impressions=900),
    ])
    merged = board.merge_over_sheet(sheet, brd)
    assert len(merged) == 2
    by_profile = {m.profile: m.impressions for m in merged}
    assert by_profile["X Studioz"] == 5246.0
    assert by_profile["XStudioz Logo"] == 900.0


def test_merging_an_empty_board_changes_nothing():
    """A board that answers with no rows must not blank the sheet. This is the
    same shape as the publish glob that put a 0-byte file over 25KB every
    morning: an empty source is not a reason to discard a full destination."""
    sheet = [sheet_impression("2026-08-06", impressions=8383.0)]
    merged = board.merge_over_sheet(sheet, [])
    assert len(merged) == 1
    assert merged[0].impressions == 8383.0


# --------------------------------------------------------------------------
# Configuration, and saying so when it is missing
# --------------------------------------------------------------------------

def test_configured_is_false_without_a_key():
    assert board.configured({}) is False
    assert board.configured({board.KEY_ENV: ""}) is False
    assert board.configured({board.KEY_ENV: "x"}) is True


def test_reading_without_a_key_raises_and_names_the_variable():
    """It must not return [] for a missing key. An empty result and an
    unconfigured reader are different facts, and collapsing them is how the
    sheet went nine days without anybody noticing."""
    with pytest.raises(board.BoardError) as exc:
        board._get("entries", env={})
    assert board.KEY_ENV in str(exc.value)


def test_the_feed_row_says_which_source_the_run_actually_used():
    from xstudioz import feeds
    now = _dt.datetime(2026, 8, 16, tzinfo=_dt.timezone.utc)

    used_board = feeds.impressions_source_feed(
        {"impressions": {"source": "board", "board_rows": 323,
                         "sheet_rows": 300, "board_newest": "2026-08-15"}}, now)
    assert used_board.status == "live"
    assert used_board.as_of == "2026-08-15"

    fell_back = feeds.impressions_source_feed({"impressions": {"source": "sheet"}}, now)
    assert fell_back.status == "unreachable"
    assert "2026-08-06" in fell_back.detail
    assert board.KEY_ENV in fell_back.fix


def test_the_board_reader_never_writes():
    """This engine is a reader of another team's system. `harden.sql` revokes
    insert, update and delete from anon so a write would fail anyway, but the
    module must not attempt one, and a future edit must not add one quietly."""
    src = (Path(__file__).resolve().parent.parent / "xstudioz" / "board.py").read_text()
    for verb in ('method="POST"', 'method="PATCH"', 'method="DELETE"',
                 'method="PUT"', "urlopen(req, data="):
        assert verb not in src, f"board.py appears to write: {verb}"


def test_a_gig_name_with_a_space_does_not_break_the_url():
    """Two of the three gigs have a space in the name.

    The first live run of this module built the query by hand, pasted
    `in.("XStudioz Logo",...)` straight into the query string, and urllib
    refused the whole URL as containing a control character -- so the run fell
    back to the sheet it was written to replace. The filter is a VALUE now, and
    urlencode is what turns it into a query string.
    """
    import urllib.parse
    names = ["XStudioz", "XStudioz Logo", "X_Studioz new gig"]
    q = urllib.parse.urlencode({"profile": board._in_filter(names)})
    assert " " not in q
    # and it still round-trips to the filter PostgREST expects
    assert urllib.parse.parse_qs(q)["profile"][0] == \
        'in.("XStudioz","XStudioz Logo","X_Studioz new gig")'
