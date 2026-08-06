"""Engine test suite.

Four layers, deliberately:

1. **Coercion** — the sheets contain a dozen date spellings and money formats.
   These pin the parsing so a new spelling fails loudly rather than silently
   becoming ``None``.
2. **Schema drift** — synthetic tabs with renamed, reordered, duplicated and
   overwritten headers. This is the failure mode most likely to happen in
   real life, because the team edits the sheets by hand.
3. **Controller invariants** — properties that must hold for *every* input,
   not just the ones we thought of. The share-cap property test is the one
   that caught the real ``round()``-to-1 bug in the dose quantiser.
4. **Pipeline** — end to end on a fixture, asserting the self-check gate
   actually blocks bad output rather than merely reporting on it.
"""

from __future__ import annotations

import datetime as dt
import json
import re
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from xstudioz import contracts as C  # noqa: E402
from xstudioz import dosing, ingest, ledger as L, metrics, recovery, selfcheck, tasks  # noqa: E402
from xstudioz.contracts import Provenance  # noqa: E402

P = Provenance("test", "t", 0, 0)


# =========================================================================
# 1. Coercion
# =========================================================================

@pytest.mark.parametrize("raw,expected", [
    ("2026-07-29", dt.date(2026, 7, 29)),
    ("29-Jul-2026", dt.date(2026, 7, 29)),
    ("29 Jul 2026", dt.date(2026, 7, 29)),
    ("29/07/2026", dt.date(2026, 7, 29)),
    ("01-Dec-2025", dt.date(2025, 12, 1)),
    ("26-01-26", dt.date(2026, 1, 26)),
    ("15/06/2026 02:01:02", dt.date(2026, 6, 15)),
    ("", None), ("-", None), ("n/a", None), ("garbage", None),
])
def test_date_parsing(raw, expected):
    assert C.to_date(raw) == expected


@pytest.mark.parametrize("raw,expected", [
    ("$150.00", 150.0), ("$1,234.50", 1234.5), ("175", 175.0),
    ("$45.00 ", 45.0), ("", None), ("no", None), (200, 200.0),
])
def test_money_parsing(raw, expected):
    assert C.to_money(raw) == expected


@pytest.mark.parametrize("raw,expected", [
    ("5.0", 5.0), ("5", 5.0), ("4.0", 4.0),
    # "no review" / "no" / 0.0 all mean "not reviewed" in this dataset.
    # Fiverr has no zero-star rating, so 0.0 must not become a real score.
    ("no review", None), ("no", None), ("0.0", None), ("", None),
    # The CSRs write the unit. 374 real ratings in the live sheet carry a
    # "star" suffix; parsing only the bare number silently reclassified every
    # one of them as "not reviewed" and understated review capture sevenfold.
    ("5 star", 5.0), ("5 Star", 5.0), ("5 STAR", 5.0), ("5 stars", 5.0),
    ("4.7 star", 4.7), ("4.3 Star", 4.3), ("1 Star", 1.0),
    # A suffix is not a licence to guess: still reject genuine junk.
    ("escalated", None), ("55.0", None), ("star", None),
])
def test_rating_parsing(raw, expected):
    assert C.to_rating(raw) == expected


def test_order_type_vocabulary():
    assert C.to_order_type("VVRO") == C.ORDER_TYPE_VVRO
    assert C.to_order_type("Organic") == C.ORDER_TYPE_ORGANIC
    assert C.to_order_type("Direct Order") == C.ORDER_TYPE_ORGANIC
    assert C.to_order_type("") == C.ORDER_TYPE_UNKNOWN


def test_person_normalisation_strips_emoji_and_case():
    assert C.normalise_person("ZUBAIR") == "Zubair"
    assert C.normalise_person("Salman ") == "Salman"
    assert C.normalise_person("Ezan\U0001F60A") == "Ezan"
    assert C.normalise_person("") is None


def test_country_aliases_collapse():
    for raw in ("US", "USA", "us"):
        assert C.normalise_country(raw) == "United States"
    assert C.normalise_country("UK") == "United Kingdom"
    assert C.normalise_country("United Kingdom  ") == "United Kingdom"


# =========================================================================
# 2. Schema drift
# =========================================================================

def test_duplicate_order_type_header_becomes_status():
    """The live sheet has ``Order Type | Order Type`` where the second is the
    status. The mapper must not silently drop one of them."""
    header = ["Date", "Client Name", "Order Type", "Order Type", "Order Amount"]
    f2c, unmapped = ingest.map_columns(header, ingest.ORDER_ALIASES)
    assert f2c["order_type"] == 2
    assert f2c["status"] == 3
    assert not unmapped


def test_header_overwritten_by_data_still_parses():
    """Two real tabs have a project name where ``Date`` should be."""
    text = (
        "| Urban Stroll | Client Name | Order Amount |\n"
        "| :-: | :-: | :-: |\n"
        "| 01-Jul-2025 | acme | $200.00 |\n"
    )
    res = ingest.ingest_orders_workbook(text)
    assert len(res.orders) == 1
    assert res.orders[0].client == "acme"
    assert res.orders[0].amount == 200.0


def test_renamed_headers_across_tabs_normalise_together():
    text = (
        "| Date | Client Name | Order Amount |\n| :-: | :-: | :-: |\n"
        "| 01-Jul-2025 | a | $100.00 |\n"
        "\n"
        "| Date of Order | Client Name | Amount |\n| :-: | :-: | :-: |\n"
        "| 02-Jul-2025 | b | $200.00 |\n"
    )
    res = ingest.ingest_orders_workbook(text)
    assert {o.client for o in res.orders} == {"a", "b"}
    assert sum(o.amount for o in res.orders) == 300.0


def test_unknown_column_is_reported_not_swallowed():
    header = ["Date", "Client Name", "Quantum Flux Rating"]
    _, unmapped = ingest.map_columns(header, ingest.ORDER_ALIASES)
    assert "Quantum Flux Rating" in unmapped


def test_known_junk_column_does_not_count_as_drift():
    header = ["Date", "Client Name", "Add to Clickup", "Column 16"]
    _, unmapped = ingest.map_columns(header, ingest.ORDER_ALIASES)
    assert unmapped == []


def test_aggregate_row_excluded_from_profiles():
    """``── TOTAL ──`` is a spreadsheet sum row, not a seller."""
    text = (
        "| Date | Profile | Organic Orders | VVRO Orders |\n| :-: | :-: | :-: | :-: |\n"
        "| 01 Jul 2026 | X Studioz | 2 | 1 |\n"
        "| 01 Jul 2026 | \\-\\- TOTAL \\-\\- | 0 | 0 |\n"
    )
    res = ingest.ingest_orders_workbook(text)
    assert [f.profile for f in res.flow] == ["X Studioz"]
    assert len(res.flow_aggregates) == 1


def test_error_log_block_is_not_mistaken_for_orders():
    text = (
        "| Timestamp | Tab | Row | Client | Message |\n| :-: | :-: | :-: | :-: | :-: |\n"
        "| 15/06/2026 02:01:02 | - | - | - | CLICKUP_TOKEN missing. |\n"
    )
    res = ingest.ingest_orders_workbook(text)
    assert res.orders == []
    assert len(res.automation_errors) == 1


def test_review_denominator_excludes_tabs_without_a_review_column():
    """A tab with no REVIEW column cannot contain un-reviewed orders."""
    text = (
        "| Date | Client Name | Order Amount | REVIEW |\n| :-: | :-: | :-: | :-: |\n"
        "| 01-Jul-2025 | a | $100.00 | 5.0 |\n"
        "| 01-Jul-2025 | b | $100.00 | no review |\n"
        "\n"
        "| Date | Client Name | Order Amount |\n| :-: | :-: | :-: |\n"
        "| 02-Jul-2025 | c | $100.00 |\n"
    )
    res = ingest.ingest_orders_workbook(text)
    e = metrics.economics(res.orders)
    assert e.review_denominator == 2       # not 3
    assert e.review_capture_rate == 0.5    # not 1/3


# =========================================================================
# 3. Controller invariants
# =========================================================================

CONFIG = {
    "dosing": {
        "min_per_day": 0, "max_per_day": 5, "max_vvro_share": 0.45,
        "step_up": 1, "step_down": 2, "cooldown_after_breach_days": 3,
        "price_bands": [
            {"min": 45, "max": 85, "weight": 0.25},
            {"min": 86, "max": 150, "weight": 0.40},
            {"min": 151, "max": 260, "weight": 0.25},
            {"min": 261, "max": 450, "weight": 0.10},
        ],
        "country_mix": {"United States": 0.5, "Other": 0.5},
    },
    "objective": {"subject_to": [{"id": "queue_capacity", "max": 32}]},
    "selfcheck": {"min_tasks": 1, "max_tasks": 12},
}


def _health(**kw):
    base = dict(profile="X", as_of=dt.date(2026, 7, 29), ma7_now=0.7, ma7_prior=0.7,
                delta_pct=0.0, slope_14d=0.0, vvro_share_7d=0.3,
                total_per_day_7d=1.0, breached=False, tolerance=-0.05)
    base.update(kw)
    return metrics.OrganicHealth(**base)


def test_share_ceiling_formula():
    # v/(o+v) = s  =>  v = o*s/(1-s). At o=1.0, s=0.5 the ceiling is 1.0.
    assert dosing.share_ceiling(1.0, 0.5) == pytest.approx(1.0)
    assert dosing.share_ceiling(0.7, 0.45) == pytest.approx(0.7 * 0.45 / 0.55)
    assert dosing.share_ceiling(0.0, 0.45) == 0.0


@pytest.mark.parametrize("organic", [0.0, 0.2, 0.56, 0.7, 1.0, 1.5, 2.0, 3.3, 5.0])
@pytest.mark.parametrize("current", [0.0, 0.5, 2.7, 5.0])
def test_dose_never_breaches_share_cap(organic, current):
    """Property: whatever the state, the recommended *rate* respects the cap.

    This is the check that caught the original bug, where a 0.58/day ceiling
    was rounded to a 1/day dose — a 58% share against a 45% cap.
    """
    h = _health(ma7_now=organic, vvro_share_7d=0.5)
    plan = dosing.decide(date=dt.date(2026, 7, 29), profile="X", health=h,
                         current_vvro_per_day=current, config=CONFIG,
                         orders_in_queue=5, revenue_gap=5000)
    if plan.projected_share is not None:
        assert plan.projected_share <= CONFIG["dosing"]["max_vvro_share"] + 1e-9
    # The quota and the stated rate must never drift apart.
    assert plan.target_rate == pytest.approx(plan.weekly_quota / 7)
    assert sum(plan.week_pattern) == plan.weekly_quota


@pytest.mark.parametrize("current", [0.0, 1.0, 3.0, 5.0])
def test_breach_never_raises_the_dose(current):
    """The objective's hard constraint, as an executable assertion."""
    h = _health(breached=True, delta_pct=-0.30,
                breach_reasons=["structural: organic -30%"])
    plan = dosing.decide(date=dt.date(2026, 7, 29), profile="X", health=h,
                         current_vvro_per_day=current, config=CONFIG,
                         orders_in_queue=5, revenue_gap=99999)
    assert plan.action != "raise"
    assert plan.target_rate <= current + 1e-9


def test_queue_capacity_freezes_placement():
    h = _health(ma7_now=3.0)
    plan = dosing.decide(date=dt.date(2026, 7, 29), profile="X", health=h,
                         current_vvro_per_day=2.0, config=CONFIG,
                         orders_in_queue=40, revenue_gap=5000)
    assert plan.action == "freeze"
    assert plan.dose == 0


def test_healthy_profile_may_raise_when_behind_on_revenue():
    h = _health(ma7_now=4.0, delta_pct=0.10, vvro_share_7d=0.10)
    plan = dosing.decide(date=dt.date(2026, 7, 29), profile="X", health=h,
                         current_vvro_per_day=1.0, config=CONFIG,
                         orders_in_queue=5, revenue_gap=5000)
    assert plan.action == "raise"
    assert plan.target_rate > 1.0


@pytest.mark.parametrize("quota", range(0, 22))
def test_week_pattern_always_sums_to_quota(quota):
    pattern = dosing.spread_week(quota, "seed")
    assert len(pattern) == 7
    assert sum(pattern) == quota
    assert all(n >= 0 for n in pattern)


def test_week_pattern_rotates_between_weeks():
    """A fixed weekday cadence is exactly what makes inorganic volume legible."""
    a = dosing.spread_week(3, "X:2026-W30")
    b = dosing.spread_week(3, "X:2026-W31")
    c = dosing.spread_week(3, "X:2026-W32")
    assert len({tuple(a), tuple(b), tuple(c)}) > 1


def test_dosing_is_deterministic():
    h = _health()
    args = dict(date=dt.date(2026, 7, 29), profile="X", health=h,
                current_vvro_per_day=1.0, config=CONFIG, orders_in_queue=5)
    assert (dosing.decide(**args).as_dict() == dosing.decide(**args).as_dict())


@pytest.mark.parametrize("total", range(0, 13))
def test_largest_remainder_conserves_total(total):
    counts = dosing.largest_remainder([0.25, 0.40, 0.25, 0.10], total)
    assert sum(counts) == total


# =========================================================================
# Health detection
# =========================================================================

def _flow(rows):
    return [C.DailyFlow(date=d, profile="X", provenance=P, organic_orders=o,
                        vvro_orders=v) for d, o, v in rows]


def test_structural_decline_is_caught_when_rolling_window_reads_flat():
    """The real failure mode: sparse counts make the 7d-vs-14d test read 0.0%
    while organic is genuinely eroding since VVRO began."""
    start = dt.date(2026, 6, 1)
    rows = []
    for i in range(30):                       # pre-VVRO: 1/day
        rows.append((start + dt.timedelta(days=i), 1.0, 0.0))
    for i in range(30, 46):                   # post-VVRO: 0.5/day organic
        rows.append((start + dt.timedelta(days=i), float(i % 2), 3.0))
    h = metrics.organic_health(_flow(rows), "X", start + dt.timedelta(days=45),
                               vvro_start=start + dt.timedelta(days=30))
    assert h.structural_delta_pct is not None
    assert h.structural_delta_pct < -0.4
    assert h.breached
    assert any("structural" in r for r in h.breach_reasons)


def test_healthy_growth_does_not_breach():
    start = dt.date(2026, 6, 1)
    rows = [(start + dt.timedelta(days=i), 1.0 + i * 0.05, 0.0) for i in range(40)]
    h = metrics.organic_health(_flow(rows), "X", start + dt.timedelta(days=39))
    assert not h.breached
    assert h.verdict() == "HEALTHY"


def test_flow_series_zero_fills_missing_days():
    rows = _flow([(dt.date(2026, 6, 1), 1, 0), (dt.date(2026, 6, 5), 2, 0)])
    dates, org, _ = metrics.flow_series(rows, "X")
    assert len(dates) == 5
    assert org == [1, 0, 0, 0, 2]


# =========================================================================
# Statistics
# =========================================================================

def test_wilson_bound_penalises_small_samples():
    """A 75%-of-4 CSR must not outrank a 50%-of-120 one."""
    small = metrics.wilson_lower_bound(3, 4)      # p = 0.75, n = 4
    large = metrics.wilson_lower_bound(60, 120)   # p = 0.50, n = 120
    assert small < large
    # And the bound must always sit below the raw rate.
    assert metrics.wilson_lower_bound(3, 4) < 0.75
    # More evidence at the same rate raises the bound.
    assert (metrics.wilson_lower_bound(300, 400)
            > metrics.wilson_lower_bound(3, 4))


def test_rating_maths_matches_the_live_gig():
    stars = {5: 1420, 4: 106, 3: 29, 2: 14, 1: 13}
    assert metrics.rating_from_histogram(stars) == pytest.approx(4.8369, abs=1e-3)
    assert sum(stars.values()) == 1582
    # One 1-star barely moves a 1,582-review average — the real cost of a
    # dispute is the cancellation and success score, not the visible rating.
    assert metrics.rating_damage(stars, 1, 1) < 0.005


def test_reviews_needed_to_move_rating():
    stars = {5: 1420, 4: 106, 3: 29, 2: 14, 1: 13}
    assert metrics.reviews_to_move_rating(stars, 4.70) == 0     # already above
    assert metrics.reviews_to_move_rating(stars, 4.90) > 0
    assert metrics.reviews_to_move_rating(stars, 5.50) is None  # unreachable


# =========================================================================
# Ledger
# =========================================================================

def test_prediction_requires_point_inside_interval():
    with pytest.raises(ValueError):
        L.new_prediction(created_on=dt.date(2026, 7, 29), horizon_days=7,
                         metric="m", statement="s", point=10, lo=20, hi=30,
                         confidence="high", basis="b")


def test_resolve_path_walks_dicts_and_lists():
    b = {"funnel": {"by_csr": [{"conv": 0.35}, {"conv": 0.22}]}, "x": {"y": 3}}
    assert L.resolve_path(b, "funnel.by_csr.0.conv") == 0.35
    assert L.resolve_path(b, "x.y") == 3.0
    assert L.resolve_path(b, "x.missing") is None
    assert L.resolve_path(b, "nope.at.all") is None


def test_ledger_scores_and_calibrates(tmp_path):
    led = L.Ledger(tmp_path / "p.jsonl")
    made = dt.date(2026, 7, 1)
    led.add(L.new_prediction(created_on=made, horizon_days=7, metric="health.index",
                             statement="s", point=50, lo=40, hi=60,
                             confidence="medium", basis="b"))
    resolved = led.resolve_due(made + dt.timedelta(days=7), {"health": {"index": 55}})
    assert len(resolved) == 1
    p = resolved[0]
    assert p.status == "resolved" and p.within_interval and p.actual == 55
    assert p.abs_error == pytest.approx(5.0)
    assert led.scorecard()["coverage"] == 1.0


def test_unresolvable_prediction_is_flagged_not_dropped(tmp_path):
    led = L.Ledger(tmp_path / "p.jsonl")
    made = dt.date(2026, 7, 1)
    led.add(L.new_prediction(created_on=made, horizon_days=1, metric="gone.away",
                             statement="s", point=1, lo=0, hi=2,
                             confidence="low", basis="b"))
    led.resolve_due(made + dt.timedelta(days=30), {}, grace_days=7)
    assert led.predictions[0].status == "unresolvable"
    assert led.scorecard()["unresolvable"] == 1


def test_calibration_widens_intervals_after_misses(tmp_path):
    led = L.Ledger(tmp_path / "p.jsonl")
    for i in range(8):
        p = L.new_prediction(created_on=dt.date(2026, 7, 1) + dt.timedelta(days=i),
                             horizon_days=1, metric="m", statement="s",
                             point=10, lo=9, hi=11, confidence="high", basis="b")
        p.status = "resolved"
        p.actual, p.within_interval = 20.0, False
        p.pct_error = 1.0
        led.predictions.append(p)
    cal = led.calibrate()
    assert cal.by_metric["m"]["coverage"] == 0.0
    assert cal.interval_multiplier("m", "high") > 1.0


def test_ledger_roundtrips_through_disk(tmp_path):
    path = tmp_path / "p.jsonl"
    led = L.Ledger(path)
    led.add(L.new_prediction(created_on=dt.date(2026, 7, 1), horizon_days=7,
                             metric="m", statement="s", point=1, lo=0, hi=2,
                             confidence="low", basis="b"))
    led.save()
    assert len(L.Ledger(path).predictions) == 1


# =========================================================================
# 4. Self-check gate
# =========================================================================

def _plan(**kw):
    base = dict(date=dt.date(2026, 7, 29), profile="X", dose=1, weekly_quota=7,
                target_rate=1.0, previous_dose=1.0, action="hold",
                binding_constraint="none",
                bands=[dosing.BandPlan(45, 85, 1)], week_pattern=[1] * 7,
                projected_share=0.3)
    base.update(kw)
    return dosing.DosePlan(**base)


def test_selfcheck_blocks_dose_over_share_cap():
    rep = selfcheck.SelfCheckReport()
    bundle = _bundle()
    selfcheck.check_invariants(rep, plan=_plan(projected_share=0.90),
                               bundle=bundle, config=CONFIG)
    assert any(r.name == "dose_within_share_cap" and not r.passed
               for r in rep.results)
    assert rep.blocking_failures


def test_selfcheck_blocks_raise_under_breach():
    rep = selfcheck.SelfCheckReport()
    bundle = _bundle(breached=True)
    selfcheck.check_invariants(rep, plan=_plan(action="raise"), bundle=bundle,
                               config=CONFIG)
    assert any(r.name == "no_raise_under_breach" and not r.passed for r in rep.results)


def test_selfcheck_blocks_pattern_quota_mismatch():
    rep = selfcheck.SelfCheckReport()
    selfcheck.check_invariants(rep, plan=_plan(week_pattern=[1, 1, 1, 0, 0, 0, 0]),
                               bundle=_bundle(), config=CONFIG)
    assert any(r.name == "week_pattern_sums_to_quota" and not r.passed
               for r in rep.results)


def test_repair_drops_unowned_tasks_without_inventing_an_owner():
    rep = selfcheck.SelfCheckReport()
    good = tasks.Task("a", "t", "c", "Ezan", "why 1", ["s1", "s2"], 100, 0.5, 1)
    bad = tasks.Task("b", "t", "c", "", "why 2", ["s1"], 100, 0.5, 1)
    kept, _ = selfcheck.repair([good, bad], [], rep, CONFIG)
    assert [t.id for t in kept] == ["a"]
    assert any("no owner" in r for r in rep.repairs)


def test_repair_clamps_point_into_its_own_interval():
    rep = selfcheck.SelfCheckReport()
    p = L.Prediction(id="x", created_on="2026-07-29", resolve_on="2026-08-05",
                     metric="m", statement="s", point=99.0, lo=0.0, hi=10.0,
                     confidence="low", basis="b", horizon_days=7)
    _, preds = selfcheck.repair([], [p], rep, CONFIG)
    assert preds[0].point == 10.0
    assert any("clamped" in r for r in rep.repairs)


def test_rubric_penalises_unevidenced_tasks():
    rep = selfcheck.SelfCheckReport()
    t = [tasks.Task("a", "t", "c", "Ezan", "no numbers here", ["s1", "s2"],
                    100, 0.5, 1)]
    p = [L.new_prediction(created_on=dt.date(2026, 7, 29), horizon_days=7,
                          metric="m", statement="s", point=1, lo=0, hi=2,
                          confidence="low", basis="b")]
    selfcheck.score_rubric(rep, tasks=t, predictions=p, config=CONFIG)
    assert rep.rubric["evidence"] == 0.0
    assert rep.score < 100


def test_rubric_full_marks_on_a_good_brief():
    rep = selfcheck.SelfCheckReport()
    t = [tasks.Task(f"t{i}", "t", "c", "Ezan", "conversion is 38.5%",
                    ["s1", "s2"], 100, 0.5, 1) for i in range(4)]
    t[0].priority = "P0"
    p = [L.new_prediction(created_on=dt.date(2026, 7, 29), horizon_days=7,
                          metric="m", statement="s", point=1, lo=0, hi=2,
                          confidence="low", basis="b")]
    selfcheck.score_rubric(rep, tasks=t, predictions=p, config=CONFIG)
    assert rep.score == pytest.approx(100.0)


def _bundle(breached: bool = False) -> metrics.MetricBundle:
    return metrics.MetricBundle(
        as_of=dt.date(2026, 7, 29), profile="X",
        health=_health(breached=breached),
        flow_7d=metrics.FlowWindow("X", dt.date(2026, 7, 23), dt.date(2026, 7, 29),
                                   7, 5, 2, 0),
        flow_28d=metrics.FlowWindow("X", dt.date(2026, 7, 2), dt.date(2026, 7, 29),
                                    28, 20, 8, 0),
        funnel=metrics.funnel_metrics([]),
        econ=metrics.economics([]),
        gig={"stars": {5: 1420, 4: 106, 3: 29, 2: 14, 1: 13},
             "rating": 4.837, "reviews_total": 1582})


# =========================================================================
# Task generation
# =========================================================================

def test_refund_language_produces_a_p0_rescue_task():
    a = C.ActiveOrder(order_no="5", client="Dr. X", provenance=P,
                      status="Rev Sent",
                      buyer_mood="Difficult. Has raised refund more than once.",
                      last_updated=dt.date(2026, 7, 20))
    out = tasks._active_order_rules([a], dt.date(2026, 7, 29),
                                    {"stars": {5: 100}, "rating": 5.0,
                                     "reviews_total": 100}, 137.0)
    rescue = [t for t in out if t.category == "dispute_rescue"]
    assert len(rescue) == 1
    assert rescue[0].priority == "P0" and rescue[0].urgency == 2


def test_long_silent_order_is_closed_not_chased():
    a = C.ActiveOrder(order_no="2", client="ghost", provenance=P, status="On Hold",
                      last_updated=dt.date(2026, 3, 1))
    out = tasks._active_order_rules([a], dt.date(2026, 7, 29), {}, 137.0)
    cats = {t.category for t in out}
    assert "pipeline_hygiene" in cats
    assert "order_revival" not in cats


def test_recently_stalled_order_is_revived():
    a = C.ActiveOrder(order_no="9", client="warm", provenance=P, status="Rev Sent",
                      last_updated=dt.date(2026, 7, 24))
    out = tasks._active_order_rules([a], dt.date(2026, 7, 29), {}, 137.0)
    assert {t.category for t in out} == {"order_revival"}


def test_revenue_counts_only_orders_the_buyer_accepted():
    """Cancelled and in-flight work is not revenue.

    ``economics`` used to select on ``amount > 0`` with no reference to status,
    so the live book reported $117,302 against $107,067 actually earned — it
    was counting $4,350 of CANCELLED orders and $5,885 of work still in flight.
    Every rate built on that figure (AOV, revenue per designer, per industry)
    inherited the error without a hint on screen.
    """
    def o(client, status, amount):
        return C.Order(client=client, provenance=P, amount=amount,
                       status=status, status_tracked=True)

    book = [
        o("a", "completed", 100.0),
        o("b", "approved", 100.0),      # accepted under its other spelling
        o("c", "cancelled", 500.0),     # never money
        o("d", "delivered", 500.0),     # delivered is not accepted on Fiverr
        o("e", "revision", 500.0),
        o("f", "in_progress", 500.0),
        o("g", None, 500.0),            # tab tracks status; this one is blank
    ]
    econ = metrics.economics(book)
    assert econ.revenue == 200.0
    assert econ.n_priced == 2


def test_a_tab_with_no_status_column_still_counts_as_revenue():
    """The absence of a column is not evidence that the work was cancelled.

    The counterpart to the test above, and the reason this is a flag rather
    than a plain status check: several source tabs are historical order
    records with no status column at all. Treating a blank status as
    unaccepted there would erase an entire profile's revenue over a column
    that was never present — the same trap ``rating_tracked`` exists to avoid.
    """
    book = [
        C.Order(client="a", provenance=P, amount=100.0, status=None, status_tracked=False),
        C.Order(client="b", provenance=P, amount=100.0, status=None, status_tracked=False),
    ]
    econ = metrics.economics(book)
    assert econ.revenue == 200.0


def test_placeholder_designers_are_not_ranked_as_people():
    orders = [
        C.Order(client=f"c{i}", provenance=P, amount=300.0,
                logo_designer="Provided by Client") for i in range(10)
    ] + [
        C.Order(client=f"d{i}", provenance=P, amount=100.0, logo_designer="Amin")
        for i in range(10)
    ]
    e = metrics.economics(orders)
    assert all(d["name"] != "Provided by Client" for d in e.by_designer)
    assert e.by_designer[0]["name"] == "Amin"


def test_every_generated_task_is_owned_evidenced_and_actionable():
    bundle = _bundle()
    plan = _plan()
    out = tasks.generate(bundle=bundle, plan=plan, active=[], orders=[],
                         violations=[], automation_errors=[], missing_sources=[],
                         today=dt.date(2026, 7, 29))
    assert out
    for t in out:
        assert t.owner.strip(), f"{t.id} has no owner"
        assert t.steps, f"{t.id} has no steps"
        assert any(ch.isdigit() for ch in t.why), f"{t.id} cites no number"


# =========================================================================
# Validation domains
# =========================================================================

def test_source_data_mistakes_do_not_block_the_run():
    """Finding bad data is the product; it must never stop the engine."""
    bad = [C.Order(client="x", provenance=P,
                   order_date=dt.date(2026, 7, 10),
                   delivered_date=dt.date(2026, 7, 1))]
    rep = C.validate_orders(bad, dt.date(2026, 7, 29))
    assert rep.ok()                      # not blocking
    assert rep.data_issues               # but reported


def test_missing_client_is_an_engine_error():
    rep = C.validate_orders([C.Order(client="", provenance=P)], dt.date(2026, 7, 29))
    assert not rep.ok()
    assert rep.blocking


def test_flow_totals_must_reconcile():
    rows = [C.DailyFlow(date=dt.date(2026, 7, 1), profile="X", provenance=P,
                        organic_orders=1, vvro_orders=1, total_orders=5)]
    rep = C.validate_flow(rows)
    assert any(v.code == "FLOW_TOTAL_MISMATCH" for v in rep.violations)


# =========================================================================
# End to end
# =========================================================================

def test_pipeline_runs_and_gates_on_real_snapshots():
    from xstudioz import pipeline
    orders = ROOT / "data" / "raw" / "orders"
    inq = ROOT / "data" / "raw" / "inquiries"
    snaps = sorted(orders.glob("*.md")) if orders.exists() else []
    if not snaps:
        pytest.skip("no snapshots checked in")
    art = pipeline.run_daily(
        root=ROOT, today=dt.date(2026, 7, 29),
        orders_text=snaps[-1].read_text(),
        inquiries_text=sorted(inq.glob("*.md"))[-1].read_text() if inq.exists() else "",
        write=False)
    # The pipeline must still run end to end on the markdown fallback.
    assert art.check.score >= 70
    assert 3 <= len(art.tasks) <= 12
    assert art.predictions
    assert "What Next" in art.brief_markdown

    # ...but this fixture yields almost nothing inside the analysis
    # window. Emitting here would mean publishing a brief whose every rate is
    # zero because the data predates the window, not because the business
    # stopped. Refusing is the correct outcome, and the reason must say so.
    reasons = [r.detail for r in art.check.blocking_failures]
    assert not art.emitted, "an all-zero brief must not be publishable"
    assert any("fall on or after" in r for r in reasons), reasons
    assert art.bundle.as_dict()["economics"]["n_orders"] < 10


def test_the_snapshot_path_does_produce_a_publishable_brief():
    """The guard above must not be masking a broken window on real data:
    the JSON snapshot path carries July rows and has to emit."""
    from xstudioz import pipeline, snapshot
    snaps = sorted((ROOT / "data" / "raw" / "snapshots").glob("*.json"))
    if not snaps:
        pytest.skip("no snapshots checked in")
    art = pipeline.run_daily(root=ROOT, today=dt.date(2026, 7, 29),
                             snap=snapshot.load(snaps[-1]), write=False)
    assert art.emitted, [r.detail for r in art.check.blocking_failures]
    assert art.bundle.as_dict()["economics"]["n_priced"] > 0


def test_consistency_checks_use_unrounded_values():
    """Regression: the checker compared a 3-dp rounded ``as_dict()`` value
    against a full-precision recompute, so 0.714 != 0.714285... blocked ten
    perfectly valid backfill days. Consistency checks must never read the
    serialised form."""
    rep = selfcheck.SelfCheckReport()
    bundle = metrics.MetricBundle(
        as_of=dt.date(2026, 7, 29), profile="X", health=_health(),
        # 5 orders over 7 days = 0.714285..., which rounds to 0.714 in JSON.
        flow_7d=metrics.FlowWindow("X", dt.date(2026, 7, 23), dt.date(2026, 7, 29),
                                   7, 5, 0, 0),
        flow_28d=metrics.FlowWindow("X", dt.date(2026, 7, 2), dt.date(2026, 7, 29),
                                    28, 20, 0, 0),
        funnel=metrics.funnel_metrics([]),
        econ=metrics.economics([
            C.Order(client=f"c{i}", provenance=P, amount=100.0 / 3) for i in range(3)
        ]))
    selfcheck.check_consistency(rep, bundle=bundle, ledger_orders=0, crm_orders=0,
                                max_swing=0.4)
    failures = [r.name for r in rep.results if not r.passed and r.severity == "block"]
    assert not failures, f"repeating decimals must not block: {failures}"


# =========================================================================
# Snapshot intake — the clean path
# =========================================================================

from xstudioz import snapshot as S  # noqa: E402


def _snap_payload(**over):
    base = {
        "schema_version": S.SCHEMA_VERSION,
        "generated_at": "2026-07-29T02:00:00Z",
        "generated_by": "apps_script",
        "warnings": [],
        "gig": {"reviews_total": 1582},
        "tables": [{
            "name": "Nov 2025", "role": "crm_orders", "source_id": "orders",
            "header": ["Date of Order", "Client Name", "Order Amount", "REVIEW"],
            "rows": [["01-Nov-2025", "acme", "$200.00", "5.0"]],
        }],
    }
    base.update(over)
    return base


def test_snapshot_rejects_an_unknown_schema_version():
    """Refusing beats guessing: a version bump means the shape changed."""
    with pytest.raises(S.SnapshotError, match="schema_version"):
        S.parse(_snap_payload(schema_version=99))


def test_snapshot_surfaces_an_endpoint_error_rather_than_parsing_past_it():
    with pytest.raises(S.SnapshotError, match="unauthorized"):
        S.parse({"schema_version": S.SCHEMA_VERSION, "error": "unauthorized"})


def test_snapshot_rejects_html_error_pages():
    with pytest.raises(S.SnapshotError, match="not valid JSON"):
        S.parse("<html><body>Sign in to continue</body></html>")


def test_snapshot_demotes_an_unrecognised_role_and_warns():
    snap = S.parse(_snap_payload(tables=[{
        "name": "Mystery", "role": "quantum_flux",
        "header": ["a"], "rows": [["1"]]}]))
    assert snap.tables[0].role == "unknown"
    assert any("quantum_flux" in w for w in snap.warnings)


def test_snapshot_roundtrips_through_disk(tmp_path):
    snap = S.parse(_snap_payload())
    S.dump(snap, tmp_path / "s.json")
    back = S.load(tmp_path / "s.json")
    assert back.generated_at == snap.generated_at
    assert back.tables[0].header == snap.tables[0].header
    assert back.gig == snap.gig


def test_pick_freshest_prefers_the_newer_producer():
    """Belt and braces: two independent producers, take whichever is newer."""
    old = S.parse(_snap_payload(generated_at="2026-07-28T02:00:00Z",
                                generated_by="apps_script"))
    new = S.parse(_snap_payload(generated_at="2026-07-29T06:00:00Z",
                                generated_by="routine"))
    assert S.pick_freshest(old, new).generated_by == "routine"
    assert S.pick_freshest(new, old).generated_by == "routine"
    assert S.pick_freshest(None, old).generated_by == "apps_script"
    assert S.pick_freshest(None, None) is None


def test_latest_on_disk_never_looks_ahead_of_a_backfill_date(tmp_path):
    S.dump(S.parse(_snap_payload(generated_at="2026-07-20T02:00:00Z")),
           tmp_path / "a.json")
    S.dump(S.parse(_snap_payload(generated_at="2026-07-29T02:00:00Z")),
           tmp_path / "b.json")
    picked = S.latest_on_disk(tmp_path, on_or_before=dt.date(2026, 7, 22))
    assert picked.generated_at.date() == dt.date(2026, 7, 20)


def test_snapshot_ingest_matches_the_markdown_path():
    """The two intake routes must agree exactly, or one of them is lying."""
    md = ("| Date of Order | Client Name | Order Amount | REVIEW |\n"
          "| :-: | :-: | :-: | :-: |\n"
          "| 01-Nov-2025 | acme | $200.00 | 5.0 |\n"
          "| 02-Nov-2025 | beta | $100.00 | no review |\n")
    from_md = ingest.ingest_orders_workbook(md)
    from_snap = ingest.ingest_snapshot(S.parse(_snap_payload(tables=[{
        "name": "Nov", "role": "crm_orders", "source_id": "orders",
        "header": ["Date of Order", "Client Name", "Order Amount", "REVIEW"],
        "rows": [["01-Nov-2025", "acme", "$200.00", "5.0"],
                 ["02-Nov-2025", "beta", "$100.00", "no review"]]}])))
    a, b = metrics.economics(from_md.orders), metrics.economics(from_snap.orders)
    assert a.as_dict() == b.as_dict()


def test_snapshot_ingest_still_reports_schema_drift():
    """Structured transport must not disable drift detection."""
    res = ingest.ingest_snapshot(S.parse(_snap_payload(tables=[{
        "name": "Nov", "role": "crm_orders",
        "header": ["Client Name", "Warp Core Temperature"],
        "rows": [["acme", "9000"]]}])))
    assert "Warp Core Temperature" in res.unmapped_columns


def test_unclassified_tab_is_reported_not_silently_dropped():
    res = ingest.ingest_snapshot(S.parse(_snap_payload(tables=[{
        "name": "Scratch", "role": "unknown", "header": ["x"], "rows": [["1"]]}])))
    assert any("Scratch" in k for k in res.unmapped_columns)


# =========================================================================
# The duplicate management board
# =========================================================================
#
# The workbook carries a hand-kept "Management Sheet" that copies the live
# per-profile order boards: on the 2026-08-05 snapshot, 392 of its 393
# clients also sat on a live board, and ingesting both counted $38,668 of
# earned revenue twice. Neither transport identifies it — the Apps Script
# tags it plain crm_orders, and the markdown export has no tab names — so
# the refusal keys on the two header spellings only that board uses.

_LEGACY_HEADER = ["CLIENT NAME", "PROJECT NAME", "ORDER TYPE", "STATUS",
                  "LOGO", "BRANDINGS", "CSR PROJECT", "DUE DATE",
                  "AMOUNT", "TIP", "NOTES", "ORDER DATE"]


def test_the_duplicate_board_is_refused_on_the_markdown_path():
    md = ("| Date of Order | Client Name | Order Amount | Status |\n"
          "| :-: | :-: | :-: | :-: |\n"
          "| 01-Jul-2026 | acme | $500.00 | Completed |\n"
          "| 02-Jul-2026 | beta | $250.00 | Completed |\n"
          "\n"
          "| " + " | ".join(_LEGACY_HEADER) + " |\n"
          "| " + " | ".join([":-:"] * len(_LEGACY_HEADER)) + " |\n"
          "| acme | Logo | Logo | Completed |  |  | Iqra |  | $500.00 |  |  | 01-Jul-2026 |\n"
          "| beta | Brand | Logo | Completed |  |  | Iqra |  | $250.00 |  |  | 02-Jul-2026 |\n")
    res = ingest.ingest_orders_workbook(md)
    assert len(res.orders) == 2, "the copy was ingested as real order history"
    assert sum(o.amount or 0 for o in res.orders) == 750.0
    assert res.duplicate_tables_skipped["legacy_board"] == 1
    assert res.duplicate_rows_skipped["legacy_board"] == 2


def test_the_duplicate_board_is_refused_on_the_snapshot_path_despite_its_role():
    """The Apps Script tags the copy plain crm_orders; the role cannot save us."""
    res = ingest.ingest_snapshot(S.parse(_snap_payload(tables=[
        {"name": "X Studioz", "role": "crm_orders", "source_id": "orders",
         "header": ["Date of Order", "Client Name", "Order Amount", "Status"],
         "rows": [["01-Jul-2026", "acme", "$500.00", "Completed"]]},
        {"name": "Management Sheet", "role": "crm_orders", "source_id": "orders",
         "header": _LEGACY_HEADER,
         "rows": [["acme", "Logo", "Logo", "Completed", "", "", "Iqra", "",
                   "$500.00", "", "", "01-Jul-2026"]]},
    ])))
    assert len(res.orders) == 1
    assert res.duplicate_tables_skipped["legacy_board"] == 1
    assert res.duplicates_seen[0]["name"] == "Management Sheet"


def test_both_paths_agree_on_a_workbook_that_carries_the_duplicate_board():
    """The founding rule of the two intakes: same workbook, same numbers."""
    md = ("| Date of Order | Client Name | Order Amount | Status |\n"
          "| :-: | :-: | :-: | :-: |\n"
          "| 01-Jul-2026 | acme | $500.00 | Completed |\n"
          "\n"
          "| " + " | ".join(_LEGACY_HEADER) + " |\n"
          "| " + " | ".join([":-:"] * len(_LEGACY_HEADER)) + " |\n"
          "| acme | Logo | Logo | Completed |  |  | Iqra |  | $500.00 |  |  | 01-Jul-2026 |\n")
    from_md = ingest.ingest_orders_workbook(md)
    from_snap = ingest.ingest_snapshot(S.parse(_snap_payload(tables=[
        {"name": "X Studioz", "role": "crm_orders", "source_id": "orders",
         "header": ["Date of Order", "Client Name", "Order Amount", "Status"],
         "rows": [["01-Jul-2026", "acme", "$500.00", "Completed"]]},
        {"name": "Management Sheet", "role": "crm_orders", "source_id": "orders",
         "header": _LEGACY_HEADER,
         "rows": [["acme", "Logo", "Logo", "Completed", "", "", "Iqra", "",
                   "$500.00", "", "", "01-Jul-2026"]]},
    ])))
    a = metrics.economics(from_md.orders)
    b = metrics.economics(from_snap.orders)
    assert a.as_dict() == b.as_dict()


def test_a_live_board_using_one_legacy_spelling_is_not_refused():
    """The fingerprint needs BOTH spellings; one alone stays live."""
    md = ("| Date of Order | Client Name | Order Amount | CSR PROJECT |\n"
          "| :-: | :-: | :-: | :-: |\n"
          "| 01-Jul-2026 | acme | $500.00 | Iqra |\n")
    res = ingest.ingest_orders_workbook(md)
    assert len(res.orders) == 1
    assert not res.duplicate_tables_skipped


def test_merge_carries_the_duplicate_refusal_through():
    """The pipeline merges parts before writing stats; a refusal that fires
    inside one part must survive into the merged report, or the receipt
    vanishes and the refusal looks like it never happened."""
    md = ("| " + " | ".join(_LEGACY_HEADER) + " |\n"
          "| " + " | ".join([":-:"] * len(_LEGACY_HEADER)) + " |\n"
          "| acme | Logo | Logo | Completed |  |  | Iqra |  | $500.00 |  |  | 01-Jul-2026 |\n")
    part = ingest.ingest_orders_workbook(md)
    merged = ingest.merge(part, ingest.IngestResult())
    assert merged.duplicate_tables_skipped["legacy_board"] == 1
    assert merged.duplicate_rows_skipped["legacy_board"] == 1
    assert merged.stats()["duplicate_tables"][0]["duplicate"] == "legacy_board"


def test_aggregate_profile_catches_real_world_totals_spellings():
    for label in ("Total", "Totals", "TOTALS", "Grand Total", "Grand Totals",
                  "Grand-Total", "TOTAL:", "Sub Total", "Subtotal",
                  "Net Total", "Overall", "All Profiles", "— total —"):
        assert ingest.is_aggregate_profile(label), label
    for label in ("X Studioz", "Storm", "Summit", "Carpicon", "Totally Rad",
                  "Subtotal Designs"):
        assert not ingest.is_aggregate_profile(label), label


# =========================================================================
# Reach vs conversion
# =========================================================================

def _imps(n, impr, ctr, rate, start=dt.date(2026, 7, 2)):
    return [C.Impression(date=start + dt.timedelta(days=i), provenance=P,
                         impressions=impr(i), clicks=impr(i) * ctr(i),
                         orders=impr(i) * ctr(i) * rate(i)) for i in range(n)]


def test_decomposition_blames_reach_when_impressions_halve():
    imps = _imps(28, lambda i: 1000 if i < 14 else 500,
                 lambda i: 0.05, lambda i: 0.20)
    d = metrics.decompose_funnel(imps, dt.date(2026, 7, 29), window=14)
    assert d.verdict == "impressions"
    assert d.attribution["impressions"] < -0.9
    assert "ranking problem" in d.explanation


def test_decomposition_blames_close_rate_when_reach_is_flat():
    imps = _imps(28, lambda i: 1000, lambda i: 0.05,
                 lambda i: 0.20 if i < 14 else 0.10)
    d = metrics.decompose_funnel(imps, dt.date(2026, 7, 29), window=14)
    assert d.verdict == "order_rate"
    assert "gig page and handling" in d.explanation


def test_decomposition_blames_ctr_when_only_clicks_fall():
    imps = _imps(28, lambda i: 1000, lambda i: 0.05 if i < 14 else 0.025,
                 lambda i: 0.20)
    d = metrics.decompose_funnel(imps, dt.date(2026, 7, 29), window=14)
    assert d.verdict == "ctr"
    assert "listing problem" in d.explanation


def test_decomposition_says_so_when_it_has_no_data():
    d = metrics.decompose_funnel([], dt.date(2026, 7, 29))
    assert not d.have_data
    assert d.verdict == "no_data"
    assert "most valuable missing input" in d.explanation


def test_decomposition_refuses_to_attribute_on_partial_windows():
    """Recent data, but not enough of it — distinct from stale data."""
    d = metrics.decompose_funnel(
        _imps(5, lambda i: 1000, lambda i: .05, lambda i: .2,
              start=dt.date(2026, 7, 25)),
        dt.date(2026, 7, 29), window=14)
    assert d.verdict == "insufficient"


def test_decomposition_calls_out_stale_data_rather_than_missing_data():
    """43,000 impressions sitting in a file that stops in December is not
    "no impression data" — saying so would send someone to build a sheet that
    already exists instead of updating it."""
    d = metrics.decompose_funnel(
        _imps(28, lambda i: 1000, lambda i: .05, lambda i: .2,
              start=dt.date(2025, 11, 30)),
        dt.date(2026, 7, 29), window=14)
    assert d.verdict == "stale"
    assert d.have_data
    assert "stops at" in d.explanation


def test_stale_impressions_produce_a_p0_task():
    bundle = _bundle()
    bundle.decomposition = metrics.decompose_funnel(
        _imps(28, lambda i: 1000, lambda i: .05, lambda i: .2,
              start=dt.date(2025, 11, 30)),
        dt.date(2026, 7, 29), window=14)
    out = tasks._decomposition_rules(bundle)
    assert len(out) == 1 and out[0].priority == "P0"
    assert out[0].id == "impressions-stale"


def test_profile_names_collapse_across_sheets():
    """The impressions sheet says XStudioz; the orders ledger says X Studioz.
    Unnormalised, every impressions row belongs to a profile with no orders."""
    for raw in ("XStudioz", "X Studioz", "x_studioz", "  xstudioz "):
        assert C.normalise_profile(raw) == "X Studioz"
    assert C.normalise_profile("AH2") == "Abdul Haseeb"
    assert C.normalise_profile("Alee") == "Alee Studioz"
    assert C.normalise_profile("") is None
    # An unknown profile passes through rather than being dropped.
    assert C.normalise_profile("Brand New Profile") == "Brand New Profile"


def test_profile_canon_matches_the_spellings_the_sheets_actually_use():
    """The canon map used to list "dygram" and "storm" while the workbooks
    write "Dygram Designs" and "Storm Design". Both keys therefore never fired
    once, and both profiles passed through uncanonicalised for months — an
    enumerated list that looks exhaustive but is only as good as its last
    editor. These are the literal strings present in the 2026-08-01 snapshot."""
    assert C.normalise_profile("Dygram Designs") == "Dygram Designs"
    assert C.normalise_profile("Dygram") == "Dygram Designs"
    assert C.normalise_profile("Storm Design") == "Storm Design"
    assert C.normalise_profile("Storm") == "Storm Design"

    # Squashing is the rule, so spacing and case never need their own entry.
    for raw in ("GridDesigns", "grid designs", "Grid  Designs", "grid_designs"):
        assert C.normalise_profile(raw) == "Grid Designs"
    for raw in ("Alee Studioz", "aleestudioz", "ALEE STUDIOZ"):
        assert C.normalise_profile(raw) == "Alee Studioz"

    # A different marketplace, deliberately NOT merged into the Fiverr profile:
    # pooling Upwork orders into Fiverr economics would corrupt AOV silently.
    assert C.normalise_profile("Abdul Haseeb Upwork") == "Abdul Haseeb Upwork"
    assert C.normalise_profile("Abdul Haseeb") == "Abdul Haseeb"


def test_impressions_table_does_not_double_count_as_flow():
    """The impressions sheet also carries Organic/VVRO order columns. If it
    were classified as daily_flow it would double every order in the ledger.

    It is retired now, so the stronger statement holds: it is not counted as
    anything at all."""
    snap = S.parse(_snap_payload(tables=[{
        "name": "Impressions", "role": "impressions", "source_id": "impressions",
        "header": ["Date", "Account Name", "Impressions", "Clicks",
                   "Organic Orders", "VVRO Orders", "Totol Order"],
        "rows": [["1-Dec-2025", "XStudioz", "5397", "88", "2", "5", "7"]]}]))
    res = ingest.ingest_snapshot(snap)
    assert res.flow == []                      # not counted as flow
    assert res.impressions == []               # not counted at all
    assert res.retired_tables_skipped["impressions"] == 1
    assert res.retired_rows_skipped["impressions"] == 1


def test_diagnosis_task_only_fires_on_a_real_decline():
    """A dominant factor that moved orders UP must not raise an alarm."""
    up = _imps(28, lambda i: 500 if i < 14 else 1000, lambda i: .05, lambda i: .2)
    bundle = _bundle()
    bundle.decomposition = metrics.decompose_funnel(up, dt.date(2026, 7, 29), 14)
    assert tasks._decomposition_rules(bundle) == []


# =========================================================================
# Disputes
# =========================================================================

def test_open_dispute_exposure_and_p0_task():
    ds = [C.Dispute(client="a", provenance=P, amount=300.0,
                    dispute_type="refund_requested",
                    opened_on=dt.date(2026, 7, 10)),
          C.Dispute(client="b", provenance=P, amount=150.0,
                    dispute_type="cancelled",
                    opened_on=dt.date(2026, 7, 1),
                    resolved_on=dt.date(2026, 7, 5), refunded=150.0)]
    m = metrics.dispute_metrics(ds, total_orders=100, today=dt.date(2026, 7, 29))
    assert m.open_count == 1 and m.open_exposure == 300.0
    assert m.refunded_total == 150.0
    out = tasks._dispute_rules(ds, dt.date(2026, 7, 29), 137.0)
    p0 = [t for t in out if t.priority == "P0"]
    assert p0 and p0[0].urgency == 2


def test_concentrated_root_cause_becomes_a_process_task():
    ds = [C.Dispute(client=f"c{i}", provenance=P, amount=100.0,
                    root_cause="brief_mismatch", opened_on=dt.date(2026, 7, 1),
                    resolved_on=dt.date(2026, 7, 2)) for i in range(4)]
    out = tasks._dispute_rules(ds, dt.date(2026, 7, 29), 137.0)
    proc = [t for t in out if t.category == "process"]
    assert proc and "brief mismatch" in proc[0].title


def test_scattered_root_causes_do_not_trigger_a_process_task():
    ds = [C.Dispute(client=f"c{i}", provenance=P, amount=100.0,
                    root_cause=cause, opened_on=dt.date(2026, 7, 1),
                    resolved_on=dt.date(2026, 7, 2))
          for i, cause in enumerate(["quality", "late", "communication",
                                     "scope_creep", "buyer_changed_mind"])]
    out = tasks._dispute_rules(ds, dt.date(2026, 7, 29), 137.0)
    assert not [t for t in out if t.category == "process"]


# =========================================================================
# Phase gate
# =========================================================================

from xstudioz import phase as PH  # noqa: E402

PHASE_CFG = {
    "phases": {
        "current": "signal_repair",
        "definitions": [
            {"id": "signal_repair", "label": "Phase 1 · Signal repair",
             "objective": "Stop the damage.",
             "window": ["2026-07-28", "2026-08-10"],
             "allowed": ["cancellation_prevention"],
             "forbidden": ["fiverr_ads", "new_gig_launch", "queue_growth",
                           "price_increase"],
             "forbidden_why": {"fiverr_ads": "Buying past a penalty."}},
            {"id": "controlled_scale", "label": "Phase 2",
             "allowed": ["fiverr_ads"], "forbidden": []},
        ],
        "gate": [
            {"id": "success_score_9", "metric": "success_score", "min": 9},
            {"id": "impressions_4000", "metric": "impressions_7d_ma", "min": 4000},
            {"id": "completion_ratio_5d",
             "metric": "completion_ratio_consecutive_days_at_or_above_1", "min": 5},
        ],
        "kill_criteria": [
            {"id": "success_score_7", "when": "score <= 7", "response": "Stop inorganic."},
            {"id": "any_cancellation", "when": "any", "response": "Post-mortem."},
        ],
    },
    "selfcheck": {"enforce_phase_gate": True},
}

TODAY = dt.date(2026, 7, 29)


def test_phase_gate_stays_shut_until_every_condition_is_met():
    """All three, not two. A gate that opens on a majority is not a gate."""
    s = PH.evaluate(PHASE_CFG, TODAY, success_score=9, impressions_7d_ma=5000,
                    completion_ratio_streak=4)
    assert not s.gate_open
    s2 = PH.evaluate(PHASE_CFG, TODAY, success_score=9, impressions_7d_ma=5000,
                     completion_ratio_streak=5)
    assert s2.gate_open


def test_unmeasured_condition_never_counts_as_met():
    """"We do not know" must not read as "passed"."""
    s = PH.evaluate(PHASE_CFG, TODAY, success_score=9, impressions_7d_ma=5000)
    assert not s.gate_open
    unmeasured = [g for g in s.gate if g.actual is None]
    assert unmeasured and all(not g.met for g in unmeasured)


def test_phase_1_forbids_ads_and_gig_launches():
    s = PH.evaluate(PHASE_CFG, TODAY, success_score=8, impressions_7d_ma=1564)
    assert not s.permits("fiverr_ads")
    assert not s.permits("new_gig_launch")
    # Phase-neutral work is always allowed.
    assert s.permits("dispute_rescue")
    assert "penalty" in s.why_forbidden("fiverr_ads")


def test_kill_criterion_fires_when_success_score_hits_the_floor():
    s = PH.evaluate(PHASE_CFG, TODAY, success_score=7)
    fired = [k.id for k in s.fired_kills]
    assert "success_score_7" in fired
    assert "Stop inorganic" in [k.response for k in s.fired_kills][0]


def test_any_cancellation_fires_its_kill_criterion():
    s = PH.evaluate(PHASE_CFG, TODAY, success_score=8,
                    cancellations_since_phase_start=1)
    assert "any_cancellation" in [k.id for k in s.fired_kills]
    s0 = PH.evaluate(PHASE_CFG, TODAY, success_score=8,
                     cancellations_since_phase_start=0)
    assert not [k for k in s0.fired_kills if k.id == "any_cancellation"]


def test_selfcheck_blocks_a_phase_2_action_during_phase_1():
    """The gate is mechanical, not advisory."""
    rep = selfcheck.SelfCheckReport()
    s = PH.evaluate(PHASE_CFG, TODAY, success_score=8, impressions_7d_ma=1564)
    ads = tasks.Task("ads", "Start Fiverr Ads at $30/day", "advertising", "Ash",
                     "ROI is 7-14% of net", ["s1", "s2"], 1000, 0.5, 1)
    selfcheck.check_phase_gate(rep, state=s, tasks=[ads], config=PHASE_CFG)
    assert any(r.name == "phase_gate_respected" and not r.passed
               for r in rep.results)
    assert rep.blocking_failures


def test_selfcheck_passes_phase_neutral_tasks():
    rep = selfcheck.SelfCheckReport()
    s = PH.evaluate(PHASE_CFG, TODAY, success_score=8, impressions_7d_ma=1564)
    t = tasks.Task("x", "Rescue order", "dispute_rescue", "Ezan", "1 at risk",
                   ["s1", "s2"], 400, 0.7, 1)
    selfcheck.check_phase_gate(rep, state=s, tasks=[t], config=PHASE_CFG)
    assert not rep.blocking_failures


def test_real_config_puts_us_in_phase_1_with_the_gate_shut():
    """Against the live config: Success Score 8, impressions 1,564."""
    import yaml
    cfg = yaml.safe_load((ROOT / "config" / "profile.yml").read_text())
    s = PH.evaluate(cfg, TODAY, success_score=8, impressions_7d_ma=1564)
    assert s.id == "signal_repair"
    assert not s.gate_open
    assert not s.permits("fiverr_ads")
    assert cfg["dosing"]["max_vvro_share"] == 0.30
    assert cfg["objective"]["maximise"] == ["revenue", "organic_orders"]


# =========================================================================
# Role routing
# =========================================================================

from xstudioz import roles as R  # noqa: E402


def _team_cfg():
    import yaml
    return yaml.safe_load((ROOT / "config" / "profile.yml").read_text())


def _t(tid, cat, pri="P2", hrs=1.0):
    return tasks.Task(tid, f"task {tid}", cat, "owner", "why 1", ["a", "b"],
                      100, 0.5, hrs, priority=pri)


def test_shifts_cover_the_whole_clock():
    """Amrah 09-17, Hasnain 17-01, Nadir 21-09. No hour uncovered."""
    shifts = R.build_shifts(_team_cfg())
    for hour in range(24):
        on = R.on_shift(shifts, dt.time(hour, 30))
        assert on, f"{hour:02d}:30 PKT has nobody on duty"


def test_wrapping_shift_covers_past_midnight():
    s = R.Shift("Hasnain", R._parse_hm("17:00"), R._parse_hm("01:00"))
    assert s.covers(R._parse_hm("18:00"))
    assert s.covers(R._parse_hm("00:30"))
    assert not s.covers(R._parse_hm("09:00"))


def test_us_peak_window_is_single_manned():
    """03:00 PKT is US peak and the highest-value window on the board."""
    shifts = R.build_shifts(_team_cfg())
    assert R.on_shift(shifts, dt.time(3, 0)) == ["Nadir"]


def test_ratio_policy_goes_to_the_ceo_not_a_csr():
    boards = {b.person: b for b in
              R.route(_team_cfg(), [_t("v", "vvro_dosing", "P0")])}
    assert boards["CEO"].task_ids if hasattr(boards["CEO"], "task_ids") \
        else [t.id for t in boards["CEO"].tasks] == ["v"]


def test_escalation_work_goes_to_the_lead():
    boards = {b.person: b for b in
              R.route(_team_cfg(), [_t("d", "dispute_rescue", "P0")])}
    assert [t.id for t in boards["Ezan"].tasks] == ["d"]


def test_lead_is_not_buried_under_execution():
    """A supervisor with nine hours of execution is not supervising."""
    cfg = _team_cfg()
    heavy = [_t(f"q{i}", "process", "P3", hrs=3.0) for i in range(4)]
    boards = {b.person: b for b in R.route(cfg, heavy)}
    assert boards["Ezan"].total_effort <= R.MAX_LEAD_HOURS + 3.0
    assert sum(len(b.tasks) for b in boards.values()) == len(heavy)


def test_no_csr_sits_idle_while_another_is_loaded():
    cfg = _team_cfg()
    boards = {b.person: b for b in
              R.route(cfg, [_t(f"f{i}", "funnel") for i in range(3)])}
    csrs = [boards[n] for n in ("Amrah", "Hasnain", "Nadir")]
    assert all(b.tasks for b in csrs)


def test_every_task_lands_on_exactly_one_board():
    cfg = _team_cfg()
    ts = [_t("a", "funnel"), _t("b", "vvro_dosing"), _t("c", "dispute_rescue"),
          _t("d", "data_quality"), _t("e", "upsell")]
    boards = R.route(cfg, ts)
    landed = [t.id for b in boards for t in b.tasks]
    assert sorted(landed) == sorted(t.id for t in ts)
    assert len(landed) == len(set(landed))


def test_csrs_carry_standing_duties_even_with_no_tasks():
    boards = {b.person: b for b in R.route(_team_cfg(), [])}
    assert boards["Amrah"].standing
    assert any("30 minutes" in s for s in boards["Amrah"].standing)
    assert boards["Ezan"].standing != boards["Amrah"].standing


def test_no_phantom_owner_named_ash_survives():
    """"Ash" was the operating model author's name for its reader, not a
    person on this team."""
    cfg = _team_cfg()
    names = {r["name"] for r in cfg["team"]["roster"]}
    assert "Ash" not in names
    assert cfg["team"]["lead"] == "Ezan"
    blob = (ROOT / "config" / "profile.yml").read_text()
    for line in blob.splitlines():
        if line.strip().startswith("#"):
            continue
        assert "Ash " not in line and "→ Ash" not in line, line


def test_edge_names_the_portfolio_control_group():
    items = R.edge(_team_cfg())
    ids = {i["id"] for i in items}
    assert "portfolio_control" in ids
    assert "trust_asset" in ids
    detail = next(i for i in items if i["id"] == "portfolio_control")["detail"]
    assert "Dygram" in detail


# =========================================================================
# Per-profile scoping and sheet repair — found against the live endpoint
# =========================================================================

def test_tab_name_scopes_records_to_their_profile():
    """Both workbooks keep one TAB per seller. Ignoring the tab name pooled
    all eleven profiles and reported portfolio AOV as X Studioz's."""
    snap = S.parse(_snap_payload(tables=[
        {"name": "X Studioz", "role": "crm_orders", "source_id": "orders",
         "header": ["Date of Order", "Client Name", "Order Amount"],
         "rows": [["01-Nov-2025", "a", "$200.00"]]},
        {"name": "Grid Designs", "role": "crm_orders", "source_id": "orders",
         "header": ["Date of Order", "Client Name", "Order Amount"],
         "rows": [["01-Nov-2025", "b", "$50.00"]]},
    ]))
    res = ingest.ingest_snapshot(snap)
    by = {o.client: o.profile for o in res.orders}
    assert by == {"a": "X Studioz", "b": "Grid Designs"}
    xs = [o for o in res.orders if o.profile == "X Studioz"]
    assert metrics.economics(xs).aov == 200.0     # not the 125 blended average


def test_unrecognised_tab_is_left_unattributed_not_assumed():
    """An unknown tab must not silently become the main profile."""
    snap = S.parse(_snap_payload(tables=[{
        "name": "Scratch Copy 2", "role": "crm_orders", "source_id": "orders",
        "header": ["Date of Order", "Client Name", "Order Amount"],
        "rows": [["01-Nov-2025", "a", "$200.00"]]}]))
    assert ingest.ingest_snapshot(snap).orders[0].profile is None


def test_merged_date_cells_are_forward_filled():
    """Google returns a merged range's value only in its top-left cell. The
    impressions sheet merged the date across seven profile rows, so 134 of 162
    rows arrived dateless and were dropped. That sheet is retired; the daily
    ledger is hand-maintained the same way and merges the same column."""
    snap = S.parse(_snap_payload(tables=[{
        "name": "Monthly - Nov 2025", "role": "daily_flow", "source_id": "orders",
        "header": ["Date", "Profile", "Organic Orders", "Total Revenue ($)"],
        "rows": [["30-Nov-2025", "Carpicon", "1", "200"],
                 ["", "Grid Designs", "4", "800"],
                 ["", "X Studioz", "2", "400"]]}]))
    res = ingest.ingest_snapshot(snap)
    assert len(res.flow) == 3
    assert all(f.date == dt.date(2025, 11, 30) for f in res.flow)
    assert {f.profile for f in res.flow} == {
        "Carpicon", "Grid Designs", "X Studioz"}


def test_repeated_header_rows_are_not_read_as_data():
    """These sheets re-print their header every seventh row."""
    snap = S.parse(_snap_payload(tables=[{
        "name": "Monthly - Nov 2025", "role": "daily_flow", "source_id": "orders",
        "header": ["Date", "Profile", "Organic Orders", "Total Revenue ($)"],
        "rows": [["30-Nov-2025", "X Studioz", "2", "400"],
                 ["Date", "Profile", "Organic Orders", "Total Revenue ($)"],
                 ["1-Dec-2025", "X Studioz", "3", "600"]]}]))
    res = ingest.ingest_snapshot(snap)
    assert len(res.flow) == 2
    assert all(f.profile == "X Studioz" for f in res.flow)


def test_forward_fill_never_invents_a_measurement():
    """Only the leading key columns carry down. Filling a blank value column
    would fabricate a number that was genuinely missing."""
    rows = ingest._clean_rows(
        ["Date", "Account Name", "Impressions"],
        [["30-Nov-2025", "XStudioz", "3858"], ["", "Carpicon", ""]])
    assert rows[1][0] == "30-Nov-2025"     # date carried down
    assert rows[1][2] == ""                # impressions did NOT


# =========================================================================
# Retired sheets. The hub owns these now, and they must not come back
# =========================================================================
#
# The order workbook and the inquiry workbook stay live. Three sheets were
# replaced by the hub on 2026-08-05 and must stop being read. Dropping them
# from config/sources.yml is not enough: tables are detected by header
# fingerprint, so a retired sheet still present in a snapshot keeps being
# classified and its rows would be counted next to the hub's typed ones. These
# tests fail if any of them is ingested again.

_RETIRED_TABLES = [
    ({"name": "Impressions", "role": "impressions", "source_id": "impressions",
      "header": ["Date", "Account Name", "Impressions", "Clicks",
                 "Organic Orders"],
      "rows": [["1-Dec-2025", "XStudioz", "5397", "88", "2"]]}, "impressions"),
    ({"name": "Team Review", "role": "team_review", "source_id": "team_review",
      "header": ["Week Ending", "Person", "Self Score", "Manager Score", "Note"],
      "rows": [["2026-08-02", "Amrah", "4", "3", "good week"]]}, "team_review"),
    ({"name": "Upsell Pipeline", "role": "resources_upsell",
      "source_id": "resources_upsell",
      "header": ["Client Name", "Business", "Gap", "Sell First", "Extra Earned"],
      "rows": [["acme", "bakery", "no menu", "menu design", "120"]]},
     "resources_upsell"),
]


@pytest.mark.parametrize("table,key", _RETIRED_TABLES)
def test_a_retired_sheet_is_refused_and_counted(table, key):
    res = ingest.ingest_snapshot(S.parse(_snap_payload(tables=[table])))
    assert res.orders == [] and res.leads == [] and res.flow == []
    assert res.impressions == [] and res.active == []
    assert res.retired_tables_skipped[key] == 1
    assert res.retired_rows_skipped[key] == 1
    assert res.blocks_used == 0, "a refused table must not count as used"
    assert res.retired_seen[0]["name"] == table["name"]


def test_a_retired_sheet_is_refused_even_when_tagged_as_a_live_role():
    """The trap. Remove a sheet's own classification rule and it does not stop
    being classified: it falls through to the next fingerprint that fits. The
    impressions sheet carries its own organic and directed order columns, so
    it lands on the daily ledger and doubles every order in it."""
    snap = S.parse(_snap_payload(tables=[{
        "name": "Daily Data Sheet", "role": "daily_flow",
        "source_id": "impressions",
        "header": ["Date", "Profiles", "Impressions", "Clicks",
                   "Organic Orders", "VVRO Orders"],
        "rows": [["1-Dec-2025", "XStudioz", "5397", "88", "2", "5"]]}]))
    res = ingest.ingest_snapshot(snap)
    assert res.flow == [], "a retired sheet must never become the daily ledger"
    assert res.retired_tables_skipped["impressions"] == 1


def test_a_retired_sheet_is_refused_on_its_headers_alone():
    """Belt and braces: no retired source id, no retired role tag, nothing but
    the shape of the header. This is the case where someone deletes the source
    from sources.yml and the snapshot keeps serving the tab anyway."""
    snap = S.parse(_snap_payload(tables=[{
        "name": "Sheet1", "role": "daily_flow", "source_id": "orders",
        "header": ["Date", "Profile", "Clicks", "Organic Orders"],
        "rows": [["1-Dec-2025", "X Studioz", "88", "2"]]}]))
    res = ingest.ingest_snapshot(snap)
    assert res.flow == []
    assert res.retired_tables_skipped["impressions"] == 1


def test_the_markdown_fallback_refuses_retired_sheets_too():
    """The snapshot endpoint is not the only way in. The legacy export path
    splits blocks by header fingerprint, which is exactly the mechanism that
    keeps a retired sheet alive."""
    text = (
        "| Date | Client Name | Order Amount |\n"
        "| --- | --- | --- |\n"
        "| 01-Nov-2025 | acme | $200.00 |\n"
        "\n"
        "| Date | Account Name | Impressions | Clicks | Organic Orders |\n"
        "| --- | --- | --- | --- | --- |\n"
        "| 30-Nov-2025 | XStudioz | 3858 | 65 | 2 |\n")
    res = ingest.ingest_orders_workbook(text)
    assert [o.client for o in res.orders] == ["acme"]
    assert res.impressions == []
    assert res.retired_tables_skipped["impressions"] == 1
    assert res.retired_rows_skipped["impressions"] == 1


def test_a_reappearing_retired_sheet_is_reported_not_swallowed():
    """Refusing quietly is how two systems end up holding the same fact with
    nobody aware. The count has to reach the self-check and the run JSON."""
    res = ingest.ingest_snapshot(S.parse(_snap_payload(
        tables=[_RETIRED_TABLES[0][0], _RETIRED_TABLES[1][0]])))
    stats = res.stats()
    assert stats["retired_tables_total"] == 2
    assert stats["retired_rows_total"] == 2
    assert set(stats["retired_tables_skipped"]) == {"impressions", "team_review"}

    rep = selfcheck.SelfCheckReport()
    selfcheck.check_ingest(rep, unmapped_rate=0.0, max_rate=0.15, unmapped={},
                           retired_tables=stats["retired_tables_skipped"],
                           retired_rows=stats["retired_rows_skipped"])
    r = next(x for x in rep.results if x.name == "retired_sources_refused")
    assert not r.passed and r.severity == "warn"
    assert "impressions" in r.detail and "team_review" in r.detail
    assert not rep.blocking_failures, "a refused sheet is visible, not fatal"


def test_a_clean_run_says_no_retired_sheet_arrived():
    rep = selfcheck.SelfCheckReport()
    selfcheck.check_ingest(rep, unmapped_rate=0.0, max_rate=0.15, unmapped={},
                           retired_tables={}, retired_rows={})
    r = next(x for x in rep.results if x.name == "retired_sources_refused")
    assert r.passed


def test_retiring_a_sheet_does_not_eat_the_live_ones():
    """The failure mode on the other side. Both live workbooks carry an Upsell
    column and the ledger carries Organic Orders, so a fingerprint written one
    token too loose would silently delete the funnel."""
    snap = S.parse(_snap_payload(tables=[
        {"name": "X Studioz", "role": "funnel", "source_id": "inquiries",
         "header": ["Date", "Client Name", "Country", "Order Status",
                    "Order Price", "Upsell"],
         "rows": [["01-Jul-2026", "acme", "US", "Placed", "$200", "No"]]},
        {"name": "X Studioz", "role": "crm_orders", "source_id": "orders",
         "header": ["Date of Order", "Client Name", "Order Amount", "Upsell"],
         "rows": [["01-Jul-2026", "acme", "$200.00", "No"]]},
        {"name": "Monthly - July 2026", "role": "daily_flow",
         "source_id": "orders",
         "header": ["Date", "Profile", "Organic Orders", "VVRO Orders"],
         "rows": [["01-Jul-2026", "X Studioz", "2", "1"]]},
    ]))
    res = ingest.ingest_snapshot(snap)
    assert len(res.leads) == 1 and len(res.orders) == 1 and len(res.flow) == 1
    assert res.retired_tables_total == 0


def test_no_ingester_can_still_build_an_impression():
    """The reader was deleted, not just gated. A branch that can never run is
    a branch someone re-enables by accident."""
    assert not hasattr(ingest, "IMPRESSION_ALIASES")


def test_the_retired_list_agrees_across_the_engine():
    """Three places name these sheets: the ingester (the gate), the snapshot
    contract (the tags), and config/sources.yml (the documentation). A
    retirement that is only true in one of them is not a retirement."""
    import yaml
    keys = set(ingest.RETIRED_ROLES)
    assert keys == {"impressions", "team_review", "resources_upsell"}
    assert keys == set(S.RETIRED_ROLES)
    assert keys <= S.ROLES

    cfg = yaml.safe_load((ROOT / "config" / "sources.yml").read_text())
    live = {s["id"] for s in cfg["sources"]}
    retired = cfg["retired"]
    assert keys.isdisjoint(live), f"a retired sheet is live again: {keys & live}"

    # `gated` splits the retired list into workbooks the ingester must refuse
    # and sources that were never ingestible. Only the first kind needs a gate,
    # and every one of them must have one — an ungated workbook comes back as
    # whatever it most resembles and its rows are counted twice.
    gated = {r["id"] for r in retired if r.get("gated")}
    assert gated == keys, (
        f"the gate and the config disagree: config gates {sorted(gated)}, "
        f"RETIRED_ROLES holds {sorted(keys)}")
    for r in retired:
        assert "gated" in r, f"retired source {r['id']!r} does not say whether it needs a gate"
    ungated = {r["id"] for r in retired if not r.get("gated")}
    assert ungated.isdisjoint(keys)
    assert ungated.isdisjoint(live), f"an ungated retirement is live again: {ungated & live}"

    assert live >= {"orders", "inquiries"}, "the two live workbooks stay"


def test_the_snapshot_producer_does_not_serve_retired_workbooks():
    """The engine refuses them, but the cheapest fix is not sending them. The
    Apps Script keeps its classification rules so a returning tab arrives
    wearing its own name rather than the daily ledger's."""
    gs = (ROOT / "automation" / "Snapshot.gs").read_text()
    sources = gs.split("var SOURCES = [", 1)[1].split("];", 1)[0]
    for key in ingest.RETIRED_ROLES:
        assert f"id: '{key}'" not in sources, f"{key} is still being served"
    rules = gs.split("var ROLE_RULES = [", 1)[1].split("];", 1)[0]
    for key in ingest.RETIRED_ROLES:
        assert f"role: '{key}'" in rules, f"{key} has no rule to claim it back"


# =========================================================================
# The dosing controller is switched off — nothing about it may reach a human
# =========================================================================

#: Words the CEO asked never to see in engine output again. The engine still
#: *parses* the ledger's VVRO columns — that is the sheet's own header and we
#: do not control it — but nothing it renders may name the subject.
_FORBIDDEN = ("vvro", "inorganic")


def _scan(text: str, where: str) -> None:
    """Minified HTML is one enormous line, so report a window around the hit
    rather than dumping 30 KB into the failure output."""
    for line in text.splitlines():
        low = line.lower()
        for word in _FORBIDDEN:
            at = low.find(word)
            assert at < 0, f"{where}: {word!r} in ...{line[max(0, at-90):at+90]}..."


def test_disabled_controller_emits_an_empty_plan_not_a_missing_one():
    """Downstream code takes a DosePlan unconditionally. Returning None here
    would turn a policy change into an AttributeError at render time."""
    plan = dosing.disabled_plan(dt.date(2026, 7, 29), "X Studioz")
    assert plan.action == "disabled"
    assert plan.dose == 0 and plan.weekly_quota == 0
    assert plan.bands == [] and plan.countries == []
    assert plan.week_pattern == [0] * 7


def test_disabled_controller_produces_no_dosing_task():
    """The dosing task is the one place the quota reached a person's board."""
    plan = dosing.disabled_plan(dt.date(2026, 7, 29), "X Studioz")
    out = tasks.generate(
        bundle=_bundle(breached=True), plan=plan, active=[], orders=[],
        automation_errors=[], missing_sources=[], today=dt.date(2026, 7, 29),
        config=_team_cfg())
    assert out, "the engine must still produce work with the controller off"
    assert not any(t.category == "vvro_dosing" for t in out)
    for t in out:
        _scan(t.title + " " + t.why + " " + " ".join(t.steps), f"task:{t.id}")


def _scan_rendered(text: str, label: str) -> None:
    """Scan what a reader sees. See readable() for why the raw file is not it."""
    _scan(readable(text), label)


def test_no_engine_output_mentions_the_disabled_subject():
    """The whole point of the switch. Renderers, standing duties, insights and
    task prose all pass through here, so a reintroduction fails the suite
    rather than reaching the CEO's morning brief."""
    for name in ("latest.md", "dashboard.html"):
        path = ROOT / "reports" / name
        if path.exists():
            _scan_rendered(path.read_text(), name)
    for item in R.edge(_team_cfg()):
        _scan(item["title"] + " " + item["detail"], f"edge:{item['id']}")
    for duty in R.STANDING_CEO + R.STANDING_LEAD + R.STANDING_CSR:
        _scan(duty, "standing duty")


# =========================================================================
# The password gate is gone, because the site it gated is gone
# =========================================================================
#
# The brief used to be published to Vercel as a serverless function behind a
# password. That whole surface was retired on 2026-08-05: the hub at
# system.xstudioz.com is the one place the team reads, and a second gated copy
# of the same numbers on a second domain was one more thing to keep in sync,
# one more password to hand out, and one more place to leak from.
#
# The original leak is worth keeping written down, because it is the reason
# the deleted tests existed. The first version of the gate shipped the whole
# brief inside `<div id="brief" hidden>` and revealed it in JavaScript after
# /api/auth answered, so `curl` returned every client name and revenue figure
# without a password. The live site was in that state when it was found.
#
# What replaces those tests is the one below: nothing may put that surface
# back without a person deciding to. `site/` reappearing is not a small
# accident — it means a static page or an ungated function is being served
# from somewhere nobody is looking at.

def test_the_published_site_stays_retired():
    site = ROOT / "site"
    assert not site.exists(), (
        f"{site} is back. The Vercel site was retired deliberately: the hub at "
        f"system.xstudioz.com is the only place the brief is read. If it is "
        f"genuinely being brought back, restore the gate tests with it — an "
        f"ungated site/index.html is served in front of any rewrite and that is "
        f"exactly how the whole brief leaked the first time.")
    assert not (ROOT / "scripts" / "publish_site.py").exists(), \
        "publish_site.py is back without the site it publishes to"


# --------------------------------------------------------------------------
# Padding rows and recovery
# --------------------------------------------------------------------------

def test_blank_padding_rows_do_not_become_orders():
    """A sheet's empty tail must not inherit the last real row's identity.

    Google returns every row of a sized sheet, and a checkbox column renders as
    FALSE in all of them — so the padding below the last real entry is not
    literally blank. Forward-filling it stamped the last order's date and
    client onto 8,339 empty rows across the workbook, which more than doubled
    the order count and invented a client with 1,311 orders in one day.
    """
    header = ["Date", "Client Name", "Order Amount", "Add to Clickup"]
    rows = [
        ["29-Jul-2026", "realbuyer", "$115.00", "FALSE"],
        ["", "", "", "FALSE"],          # padding: checkbox default only
        ["", "", "", ""],               # padding: wholly empty
        ["", "", "", "false"],          # padding: case must not matter
    ]
    cleaned = ingest._clean_rows(header, rows)
    assert len(cleaned) == 1
    assert cleaned[0][1] == "realbuyer"


def test_merged_cell_rows_still_forward_fill():
    """The padding fix must not break the merged-cell repair it sits next to.

    A merged date cell arrives blank on continuation rows, but those rows carry
    real values elsewhere — that is exactly what distinguishes them from
    padding.
    """
    header = ["Date", "Profile", "Organic Orders"]
    rows = [
        ["2026-07-29", "X Studioz", "3"],
        ["", "", "2"],                  # merged date + profile, real value
    ]
    cleaned = ingest._clean_rows(header, rows)
    assert len(cleaned) == 2
    assert cleaned[1][0] == "2026-07-29"
    assert cleaned[1][1] == "X Studioz"


def _order(client, days_ago, status, amount, today):
    return C.Order(
        client=client, provenance=Provenance("t", "t", 0, 0), profile="X Studioz",
        order_date=today - dt.timedelta(days=days_ago), status=status,
        amount=amount)


def test_open_order_banding_and_staleness():
    today = dt.date(2026, 7, 29)
    orders = [
        _order("fresh", 3, "in_progress", 100.0, today),
        _order("mid", 20, "revision", 200.0, today),
        _order("aging", 45, "revision", 50.0, today),
        _order("stale", 120, "in_progress", 300.0, today),
        _order("delivered_stale", 90, "delivered", 80.0, today),
        _order("done", 200, "completed", 999.0, today),   # not open
    ]
    book = recovery.open_orders(orders, today, "X Studioz")
    assert len(book.orders) == 5                     # completed excluded
    assert book.by_band()["60+"]["count"] == 2       # stale + delivered_stale
    assert book.stale_value == 380.0
    assert book.oldest(1)[0].client == "stale"


def test_undated_open_order_is_skipped_not_assumed_fresh():
    today = dt.date(2026, 7, 29)
    o = C.Order(client="nodate", provenance=Provenance("t", "t", 0, 0),
                profile="X Studioz", order_date=None, status="revision",
                amount=100.0)
    assert recovery.open_orders([o], today, "X Studioz").orders == []


def _lead(client, days_ago, quoted, status, depth, today):
    return C.Lead(
        client=client, provenance=Provenance("t", "t", 0, 0), profile="X Studioz",
        date=today - dt.timedelta(days=days_ago), status=status, quoted=quoted,
        followup_1=depth >= 1, followup_2=depth >= 2, followup_3=depth >= 3)


def test_unanswered_quotes_rank_never_asked_first():
    """A bigger quote that has been chased three times ranks below a small one
    nobody has asked. Silence after three asks is an answer."""
    today = dt.date(2026, 7, 29)
    leads = [
        _lead("chased_big", 100, 900.0, "not_placed", 3, today),
        _lead("never_small", 10, 75.0, "not_placed", 0, today),
        _lead("never_big", 26, 950.0, "not_placed", 0, today),
        _lead("bought", 5, 500.0, "placed", 0, today),      # excluded
    ]
    book = recovery.unanswered_quotes(leads, today, "X Studioz")
    assert len(book.quotes) == 3
    assert [q.client for q in book.ranked()][:2] == ["never_big", "never_small"]
    assert book.untouched_value == 1025.0


def test_old_quotes_are_kept_not_aged_out():
    """No age cut-off: the team's read is that these buyers never replied
    rather than declined, so an old quote is ranked down, never dropped."""
    today = dt.date(2026, 7, 29)
    book = recovery.unanswered_quotes(
        [_lead("ancient", 400, 175.0, "not_placed", 1, today)], today, "X Studioz")
    assert len(book.quotes) == 1
    assert book.quotes[0].age_days == 400


def test_followup_benchmark_separates_the_selection_effect():
    """The no-follow-up group is dominated by instant closes, so its raw
    conversion rate must never be used as the value of chasing."""
    today = dt.date(2026, 7, 29)
    leads = (
        [_lead(f"instant{i}", 5, 100.0, "placed", 0, today) for i in range(9)]
        + [_lead("cold", 90, 100.0, "not_placed", 0, today)]
        + [_lead(f"chased_win{i}", 30, 100.0, "placed", 1, today) for i in range(4)]
        + [_lead(f"chased_lost{i}", 30, 100.0, "not_placed", 1, today) for i in range(6)]
    )
    bm = recovery.followup_benchmark(leads, "X Studioz")
    assert (bm.never_n, bm.never_placed) == (10, 9)      # 90% — selection, not skill
    assert (bm.followed_n, bm.followed_placed) == (10, 4)
    assert bm.followed_conv == 0.4                        # the usable rate
    assert bm.has_signal


def test_followup_benchmark_reports_no_signal_on_thin_data():
    today = dt.date(2026, 7, 29)
    bm = recovery.followup_benchmark(
        [_lead("a", 10, 100.0, "placed", 1, today)], "X Studioz")
    assert not bm.has_signal


def test_recovery_tasks_are_owned_and_evidenced():
    """Rule 3 of the operating manual, enforced: owner, a number in the
    rationale, and at least two concrete steps."""
    today = dt.date(2026, 7, 29)
    orders = [_order("stale", 120, "in_progress", 300.0, today)]
    leads = [_lead("never", 26, 950.0, "not_placed", 0, today)]
    bundle = recovery.compute(orders, leads, today, "X Studioz")
    generated = tasks._recovery_rules(bundle, {"team": {"lead": "Ezan"}})
    assert {t.id for t in generated} == {"stale-open-orders", "untouched-quotes"}
    for t in generated:
        assert t.owner == "Ezan"
        assert any(ch.isdigit() for ch in t.why)
        assert len(t.steps) >= 2


def test_recovery_rules_are_silent_when_there_is_nothing_to_recover():
    today = dt.date(2026, 7, 29)
    bundle = recovery.compute([_order("fresh", 2, "in_progress", 100.0, today)],
                              [], today, "X Studioz")
    assert tasks._recovery_rules(bundle, {"team": {"lead": "Ezan"}}) == []


def test_breach_reasons_survive_serialisation():
    """A verdict without its evidence is worse than no verdict.

    The dashboard reads this dict, not the dataclass. When `breach_reasons` was
    dropped in serialisation the page rendered its no-breach copy — the words
    "No breach" — directly beneath a red BREACH badge.
    """
    today = dt.date(2026, 7, 29)
    flow = []
    # Healthy before VVRO, halved after: a structural breach with a reason.
    for i in range(60, 30, -1):
        flow.append(C.DailyFlow(profile="X Studioz", provenance=Provenance("t", "t", 0, 0),
                                date=today - dt.timedelta(days=i),
                                organic_orders=2.0, vvro_orders=0.0))
    for i in range(30, -1, -1):
        flow.append(C.DailyFlow(profile="X Studioz", provenance=Provenance("t", "t", 0, 0),
                                date=today - dt.timedelta(days=i),
                                organic_orders=0.5, vvro_orders=3.0))
    health = metrics.organic_health(flow, "X Studioz", today,
                                    vvro_start=today - dt.timedelta(days=30))
    assert health.verdict() == "BREACH"
    assert health.breach_reasons, "a breach must say why"

    bundle = metrics.MetricBundle(
        as_of=today, profile="X Studioz", health=health,
        flow_7d=metrics.flow_window(flow, "X Studioz",
                                    today - dt.timedelta(days=6), today),
        flow_28d=metrics.flow_window(flow, "X Studioz",
                                     today - dt.timedelta(days=27), today),
        funnel=metrics.funnel_metrics([]), econ=metrics.economics([]), gig={})
    payload = bundle.as_dict()["health"]
    assert payload["verdict"] == "BREACH"
    assert payload["breach_reasons"] == health.breach_reasons


# =========================================================================
# The page is light. Not "light unless your laptop says otherwise".
# =========================================================================
#
# The brief defined a light palette and then handed it to a
# `@media (prefers-color-scheme: dark)` block that rewrote all twenty tokens.
# Every check passed, the HTML was "correct", and the person who had asked for
# a light page opened a dark one — because the decision was delegated to their
# OS. It survived review twice, since nothing in the source looks wrong: the
# light tokens are right there at the top.
#
# A media query is the wrong mechanism for a stated product decision. If a dark
# mode is ever wanted it belongs behind a control the reader operates.

#: The brief now renders to one file. The Vercel function that used to
#: carry a second copy was retired; see test_the_published_site_stays_retired.
_RENDERED = ("reports/dashboard.html",)


def readable(text: str) -> str:
    """The rendered output as a person would actually see it.

    Fonts are embedded as base64 data: URIs, because the artifact's CSP blocks
    external hosts. 106 KB of base64 will contain any short token by chance —
    the Inter blob currently holds "vvro", a retired programme name that the
    content scan looks for. That is not a leak; it is three letters of a glyph
    outline. Replacing the payloads means a match inside them cannot mean
    anything, while every genuine string on the page is still scanned.

    This used to also decode the JSON string literals that site/api/brief.js
    wrapped its HTML in. That file is gone with the rest of the Vercel site,
    and the decoding went with it: it matched on `= "..." ;` which also matches
    a CSS `content:"";`, so keeping it would have quietly rewritten stylesheet
    rules in the text under test for no remaining benefit.
    """
    return re.sub(r"data:[a-z0-9/+.-]+;base64,[A-Za-z0-9+/=]+", "data:<embedded>", text)


def _rendered_outputs():
    for rel in _RENDERED:
        p = ROOT / rel
        if p.exists():
            yield rel, readable(p.read_text(encoding="utf-8"))


def test_no_output_lets_the_os_pick_the_colour_scheme():
    for rel, text in _rendered_outputs():
        # Match the mechanism, not the word: a comment explaining why there is
        # no dark block is fine, an actual @media rule is not.
        hit = re.search(r"@media[^{]*prefers-color-scheme", text)
        assert hit is None, (
            f"{rel} re-introduces an OS-driven colour scheme at {hit.start()}. "
            f"The brief is light; a dark mode belongs behind an explicit toggle, "
            f"not a media query that reads the reader's operating system.")


def test_both_themes_are_defined_and_the_reader_picks():
    """The page ships dark by default with a light theme behind a toggle.

    This test used to assert the palette was light and only light. That was the
    right guard when the brief was light-only, but the product decision changed:
    dark is now the default and light is a button. What must NOT change is the
    reason the original trap existed — the reader chooses, never the OS — and
    that is covered by the media-query test above plus the three assertions
    here.

    So: both palettes must exist, they must be selected by an attribute a
    control can set, and the default (bare :root) must be the dark one. A
    single-palette page would mean the toggle is decoration.
    """
    for rel, text in _rendered_outputs():
        assert '[data-theme="light"]' in text, \
            f"{rel}: no light palette, so the theme toggle has nothing to switch to"
        assert '[data-theme="dark"]' in text, \
            f"{rel}: the dark palette is not addressable by attribute"

        # The default, taken from the bare `:root` block, has to be dark: it is
        # what renders before any script runs and before any choice is stored.
        root = re.search(r":root,:root\[data-theme=\"dark\"\]\{(.*?)\}", text, re.S)
        assert root, f"{rel}: no default :root palette found"
        canvas = re.search(r"--canvas:\s*(#[0-9A-Fa-f]{6})", root.group(1))
        assert canvas, f"{rel}: the default palette defines no --canvas"
        lum = sum(int(canvas.group(1)[i:i + 2], 16) for i in (1, 3, 5)) / 3
        assert lum < 60, (
            f"{rel}: default --canvas {canvas.group(1)} is not dark. Dark is the "
            f"stated default; if that changes, change it here deliberately.")


def test_the_theme_is_switched_by_a_control_and_persisted():
    """A toggle that forgets is worse than no toggle: it means every load
    re-imposes a theme the reader already rejected once."""
    for rel, text in _rendered_outputs():
        assert 'id="themer"' in text, f"{rel}: no theme control in the header"
        assert "xs-theme" in text, f"{rel}: the choice is not persisted under a stable key"
        assert "localStorage.setItem" in text or "localStorage.getItem" in text, \
            f"{rel}: the theme choice is never written to or read from storage"
        # Applied before first paint, or the wrong palette flashes on every load.
        head = text[:text.find("<style")] if "<style" in text else text[:2000]
        assert "data-theme" in head, \
            f"{rel}: theme is applied after the stylesheet, so the wrong palette paints first"


def test_brief_requests_nothing_external_except_its_own_database():
    """The published artifact runs under a CSP that blocks every external host.
    A webfont link fails there while looking fine on Vercel, so the page must
    not reach out for anything but the task-state database it needs."""
    allowed = "aeytsgipuuyjlbvebhez.supabase.co"
    for rel, text in _rendered_outputs():
        hosts = {h for h in re.findall(r"https?://([A-Za-z0-9.-]+)", text)}
        stray = {h for h in hosts if h != allowed and not h.endswith(".w3.org")}
        assert not stray, f"{rel} loads external resources: {sorted(stray)}"


def test_every_task_on_the_page_can_be_ticked_off():
    """The checklist is the product. A task rendered without a stable id has a
    checkbox that cannot persist, and it silently un-ticks on reload."""
    p = ROOT / "reports" / "dashboard.html"
    if not p.exists():
        return
    html_text = p.read_text(encoding="utf-8")
    ids = re.findall(r'type="checkbox" data-id="([^"]+)"', html_text)
    assert ids, "the brief rendered no tickable tasks"
    assert len(ids) == len(set(ids)), "duplicate task ids — ticking one ticks another"
    assert all(i.strip() for i in ids), "a task rendered with an empty id"


# ---------------------------------------------------------------------------
# Analysis window and retired integrations (2026-08-01 policy change)
# ---------------------------------------------------------------------------

def _cfg():
    import yaml, pathlib
    return yaml.safe_load((pathlib.Path(__file__).parent.parent
                           / "config" / "profile.yml").read_text())


def test_analysis_window_exempts_recovery_from_the_date_filter():
    """The window makes rates current; recovery must still see old money.

    Every stale order predates the window start by definition — an order is
    only stale because it is old. Applying the filter here once removed all
    17 of them ($2,285), which is the largest recoverable block on the page
    and the thing the brief exists to shrink.
    """
    import json, pathlib
    run = json.loads((pathlib.Path(__file__).parent.parent / "reports"
                      / "2026-07-29-run.json").read_text())
    start = str(_cfg()["analysis_window"]["start"])
    orders = run["recovery"]["open_orders"]["orders"]
    assert any(o["order_date"] < start for o in orders), \
        "recovery lost its pre-window orders — the exemption is not applied"
    assert run["recovery"]["open_orders"]["stale_count"] > 0


def test_windowed_metrics_actually_exclude_pre_window_rows():
    import json, pathlib
    run = json.loads((pathlib.Path(__file__).parent.parent / "reports"
                      / "2026-07-29-run.json").read_text())
    # 1043 orders all-time; the window must cut it down or it is not applied.
    assert run["metrics"]["economics"]["n_orders"] < 200


def test_a_rate_below_the_sample_floor_is_not_reported_as_a_point_estimate():
    """2 of 25 reads as 8% against an all-time 22.6% and looks like collapse.

    The interval contains 22.6%, so nothing has been shown to change. The
    brief must say so rather than print the point estimate alone.
    """
    import json, pathlib
    fn = json.loads((pathlib.Path(__file__).parent.parent / "reports"
                     / "2026-07-29-run.json").read_text())["metrics"]["funnel"]
    if fn["inquiries"] < fn["min_sample"]:
        assert fn["too_few_to_call"] is True
        lo, hi = fn["conversion_ci"]
        assert lo < fn["conversion"] < hi
        html = (pathlib.Path(__file__).parent.parent / "reports"
                / "dashboard.html").read_text()
        assert "too few to call" in html.lower(), \
            "the flag is serialised but never rendered — the BREACH-badge trap"


def test_a_retired_integration_emits_no_task():
    """Gated at birth, not filtered downstream: a suppressed task cannot leak
    through a renderer that was never taught to hide it."""
    import json, pathlib
    cfg = _cfg()
    run = json.loads((pathlib.Path(__file__).parent.parent / "reports"
                      / "2026-07-29-run.json").read_text())
    for name, enabled in (cfg.get("integrations") or {}).items():
        if not enabled:
            blob = json.dumps(run["tasks"]).lower()
            assert name.lower() not in blob, \
                f"{name} is retired but still generates a task"


def test_wilson_interval_brackets_the_point_estimate():
    from xstudioz.metrics import wilson_interval
    lo, hi = wilson_interval(2, 25)
    assert lo < 2 / 25 < hi
    assert lo >= 0.0 and hi <= 1.0
    assert wilson_interval(0, 0) == (0.0, 1.0)


def test_the_page_states_which_period_its_numbers_cover():
    """Windowed revenue is $5,667 where all-time is $116,017. A reader who is
    not told the period will read the smaller number as a collapse."""
    import pathlib, json
    reports = pathlib.Path(__file__).parent.parent / "reports"
    html = (reports / "dashboard.html").read_text()
    # The NEWEST run, not a hardcoded date. build_dashboard.py defaults to the
    # newest run JSON, so pinning 2026-07-29 here asserted that today's page
    # carries a window label from a run it was not built from. It passed only
    # while those two happened to agree, and broke the day the window moved.
    runs = sorted(reports.glob("*-run.json"))
    assert runs, "no run JSON to check the dashboard against"
    run = json.loads(runs[-1].read_text())
    label = (run.get("window") or {}).get("label")
    if label:
        assert label in html, "the analysis window is applied but never stated"
        # ...and the one view that ignores the window must say that too.
        assert "looks further back" in html, \
            "money-at-rest is exempt from the window without telling the reader"


# ---------------------------------------------------------------------------
# A truncated markdown export must never be ingested as a whole workbook
# ---------------------------------------------------------------------------
#
# On 2026-08-06 the Drive read tool returned the order workbook cut off mid
# table: 222,506 characters and 2,075 lines standing in for a workbook the
# snapshot renders as 27 tables and 31,042 rows. The pipeline parsed it without
# complaint into 601 orders where the snapshot found 1,073.
#
# The first guard written for this checked whether the file ended mid-token,
# and it did not fire: the cut landed immediately after a cell separator, so
# the final line still ended in a pipe and read as a well-formed row. What
# gives it away is the row's SHAPE.

def test_a_truncated_export_is_refused_rather_than_parsed():
    from xstudioz.ingest import assert_complete, TruncatedExport

    whole = (
        "| Date | Client | Amount |\n"
        "| --- | --- | --- |\n"
        "| 01 Aug 2026 | alpha | 100 |\n"
        "| 02 Aug 2026 | bravo | 200 |\n"
    )
    assert_complete(whole, label="whole")  # must not raise

    # Cut after a separator, so the last line still ends in a pipe. This is the
    # exact shape the real truncation took, and the naive check passes it.
    truncated = (
        "| Date | Client | Amount |\n"
        "| --- | --- | --- |\n"
        "| 01 Aug 2026 | alpha | 100 |\n"
        "| 02 Aug 2026 | bravo |"
    )
    assert truncated.strip().endswith("|"), (
        "this fixture is meant to end in a pipe; without that it does not "
        "reproduce the bug and the test proves nothing"
    )
    with pytest.raises(TruncatedExport) as caught:
        assert_complete(truncated, label="orders")
    assert "2 cells" in str(caught.value) and "3" in str(caught.value)


def test_a_ragged_row_in_the_middle_is_not_mistaken_for_truncation():
    """Only the END of a file can be truncated.

    Sheets are full of short rows. Refusing on any of them would turn a working
    intake into a daily false alarm, and an alarm that fires every morning is
    one nobody reads on the morning it means something.
    """
    from xstudioz.ingest import assert_complete

    ragged_middle = (
        "| Date | Client | Amount |\n"
        "| --- | --- | --- |\n"
        "| 01 Aug 2026 | alpha |\n"
        "| 02 Aug 2026 | bravo | 200 |\n"
    )
    assert_complete(ragged_middle, label="ragged")  # must not raise
