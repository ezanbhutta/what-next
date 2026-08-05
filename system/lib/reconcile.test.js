// lib/reconcile.test.js, run with `node --test lib/`
//
// These assertions are the verified ground truth of the finding this hub was
// built on. They are pinned against the committed engine output in data/.
//
// If one of them fails, the join changed, not the truth. Fix the join. The
// only legitimate reason for these numbers to move is a genuinely newer
// data/ from the engine, and in that case the new numbers must be re-verified
// against the sheets by hand before this file is edited. Never adjust an
// expectation to make a run go green.

import test from 'node:test';
import assert from 'node:assert/strict';

import { reconcile, normaliseBuyer, wilson, MIN_SAMPLE } from './reconcile.js';
import {
  MISSING,
  isMissing,
  pick,
  run,
  orders,
  leads,
  flow,
  impressions,
  staleness,
  dataStatus,
  clearCache,
} from './data.js';

// ------------------------------------------------------- the ground truth
//
// These used to assert against the LIVE files: orders().length === 1053,
// $3,628, 29.4%. That is a data assertion wearing a test's clothes. The
// engine refreshes data/ every morning, so the suite went red the first time
// real numbers arrived, and the only ways out were to re-pin the constants to
// whatever the sheet said today (which tests nothing and quietly launders a
// bad parse into "verified") or to stop refreshing the data.
//
// So the LOGIC is pinned to a fixture, and the LIVE files are checked against
// invariants that must hold whatever the sheet says. A join bug still fails
// the suite. A busy Tuesday does not.

/** A hand-built book that exercises every branch of the join. */
const FIXTURE = {
  leads: [
    { client: 'alpha', status: 'placed' },      // said won, and did order
    { client: 'Beta_One', status: 'placed' },   // said won, never ordered
    { client: 'gamma', status: 'not_placed' },  // written off, and DID order
    { client: 'delta', status: 'not_placed' },  // written off, correctly
    { client: 'epsilon', status: 'unknown' },   // no verdict either way
  ],
  orders: [
    { client: 'alpha', amount: 100, order_date: '2026-07-01' },
    // Same buyer, different spelling and case. The join normalises, so these
    // must land on `gamma`, not invent a sixth buyer.
    { client: 'Gamma', amount: 200, order_date: '2026-07-02' },
    { client: 'g-a-m-m-a', amount: 300, order_date: '2026-07-03' },
    { client: 'zeta', amount: 400, order_date: '2026-07-04' },   // never inquired
  ],
};

test('the join is case and punctuation insensitive on the buyer username', () => {
  const r = reconcile(FIXTURE);
  assert.equal(r.available, true);

  // "Gamma" and "g-a-m-m-a" are one buyer with two orders, $200 + $300.
  const lost = r.findings.marked_lost_but_ordered;
  assert.equal(lost.length, 1);
  assert.equal(r.summary.not_placed_but_ordered, 1);
  assert.equal(r.summary.not_placed_but_ordered_orders, 2);
  assert.equal(Math.round(r.summary.not_placed_but_ordered_value), 500);
});

test('a lead marked won with no order behind it is reported separately', () => {
  const r = reconcile(FIXTURE);
  assert.equal(r.summary.placed_no_order, 1);
  assert.equal(r.findings.marked_won_no_order[0].buyer.toLowerCase().startsWith('beta'), true);
});

test('an order from a buyer who never inquired is its own finding', () => {
  const r = reconcile(FIXTURE);
  const none = r.findings.order_without_inquiry.map((f) => f.buyer);
  assert.deepEqual(none, ['zeta']);
});

test('true conversion counts buyers who ordered, claimed counts the sheet’s verdict', () => {
  const { conversion } = reconcile(FIXTURE);
  // 5 leads. alpha and gamma actually ordered -> 2/5 = 40%.
  // The sheet claims alpha and Beta_One -> 2/5 = 40% as well, but the SET is
  // different: it credits a sale that never landed and misses one that did.
  assert.equal(conversion.denominator, 5);
  assert.equal(conversion.true_converted, 2);
  assert.equal(conversion.claimed_placed, 2);
  // Rates are not pre-rounded to display width. If they were, formatting them
  // would round a second time and move the number.
  assert.equal((conversion.true_rate * 100).toFixed(2), '40.00');
});

test('the live files still hold every invariant the findings depend on', () => {
  const r = reconcile();
  assert.equal(r.available, true);

  // Sizes move daily. That they are plausible does not.
  assert.ok(r.summary.orders > 0, 'no orders loaded');
  assert.ok(r.summary.leads > 0, 'no leads loaded');

  // Arithmetic that cannot be false unless the join is broken.
  assert.equal(
    r.summary.placed_and_ordered + r.summary.placed_no_order,
    r.summary.marked_placed,
    'marked-placed does not split into ordered + not-ordered'
  );
  assert.equal(
    r.summary.placed_and_ordered + r.summary.not_placed_but_ordered,
    r.summary.actually_ordered,
    'actually-ordered does not split by what the sheet claimed'
  );
  assert.ok(
    r.summary.actually_ordered >= r.summary.marked_placed,
    'the sheet claims more conversions than the order book can support'
  );
  assert.equal(r.findings.marked_lost_but_ordered.length, r.summary.not_placed_but_ordered);

  // The finding this hub exists for. Its size changes; its direction does not.
  assert.ok(
    r.summary.not_placed_but_ordered > 0,
    'no buyers marked lost who actually ordered: verify before believing this'
  );
  assert.ok(r.conversion.gap_points > 0, 'true conversion is no longer above claimed');
});

test('the three finding sets partition cleanly and none overlap', () => {
  const r = reconcile();
  const lost = new Set(r.findings.marked_lost_but_ordered.map((f) => f.buyer));
  const won = new Set(r.findings.marked_won_no_order.map((f) => f.buyer));
  const none = new Set(r.findings.order_without_inquiry.map((f) => f.buyer));

  for (const b of lost) assert.ok(!won.has(b), `${b} is in two finding sets`);
  for (const b of lost) assert.ok(!none.has(b), `${b} is in two finding sets`);
  for (const b of won) assert.ok(!none.has(b), `${b} is in two finding sets`);

  // Every lead buyer is accounted for: placed-and-ordered, or one of the two
  // inquiry-side findings, or genuinely lost. Counts move daily; the
  // relationship between them does not, which is the part worth pinning.
  assert.ok(r.summary.lead_buyers > 0, 'no lead buyers loaded');
  assert.ok(
    r.summary.lead_buyers <= r.summary.leads,
    'more distinct buyers than lead rows, which the join cannot produce'
  );
  assert.equal(r.summary.order_buyers, none.size + r.summary.actually_ordered);
});

test('order_without_inquiry covers every order buyer with no inquiry logged', () => {
  const r = reconcile();
  const set = r.findings.order_without_inquiry;
  // The size is whatever the sheets say today. That it equals order buyers
  // minus the ones who did inquire is arithmetic, and arithmetic is testable.
  assert.equal(set.length, r.summary.order_buyers - r.summary.actually_ordered);
  for (const f of set) {
    assert.equal(f.lead_rows, 0);
    assert.ok(f.order_count >= 1);
    assert.ok(isMissing(f.first_lead_date));
  }
});

// -------------------------------------------------------------- the join

test('an inquiry logged under a display name is flagged, never fuzzy-matched', () => {
  const won = reconcile().findings.marked_won_no_order;
  // Four of the five sheet-claimed wins with no order are not usernames at
  // all ("Adrian C", "Andrew"), so no exact join could ever reach them.
  assert.equal(won.filter((f) => f.logged_as_display_name).length, 4);

  // Near-misses stay unmatched on purpose: `alanzfs` in the inquiry log is one
  // character from the order book's `alanzfss`, and guessing the link would
  // attach money to a buyer on the strength of a typo.
  const r = reconcile({
    leads: [{ client: 'alanzfs', status: 'placed', date: '2026-04-26' }],
    orders: [{ client: 'alanzfss', amount: 300, order_date: '2026-04-27' }],
  });
  assert.equal(r.summary.placed_no_order, 1);
  assert.equal(r.findings.order_without_inquiry.length, 1);
});

test('the join key lowercases and strips non-alphanumerics', () => {
  assert.equal(normaliseBuyer('Nativ_Shaibi'), 'nativshaibi');
  assert.equal(normaliseBuyer('nativ shaibi'), 'nativshaibi');
  assert.equal(normaliseBuyer('  dcleanglobe '), 'dcleanglobe');
  assert.equal(normaliseBuyer('thisguy07'), 'thisguy07');
  assert.equal(normaliseBuyer(null), '');
  assert.equal(normaliseBuyer('---'), '');
});

test('a buyer whose username differs only in punctuation is one buyer', () => {
  const r = reconcile({
    leads: [{ client: 'Kai_Utzinger', status: 'not_placed', date: '2026-03-01' }],
    orders: [{ client: 'kaiutzinger', amount: 100, order_date: '2026-03-07' }],
  });
  assert.equal(r.summary.lead_buyers, 1);
  assert.equal(r.summary.not_placed_but_ordered, 1);
  assert.equal(r.findings.order_without_inquiry.length, 0);
});

test('a repeat inquirer counts once, and one placed row claims the win', () => {
  const r = reconcile({
    leads: [
      { client: 'someone', status: 'placed', date: '2026-01-01' },
      { client: 'someone', status: 'not_placed', date: '2026-05-01' },
    ],
    orders: [{ client: 'someone', amount: 50, order_date: '2026-01-05' }],
  });
  assert.equal(r.summary.lead_buyers, 1);
  assert.equal(r.summary.marked_placed, 1);
  assert.equal(r.summary.placed_and_ordered, 1);
  assert.equal(r.summary.not_placed_but_ordered, 0);
});

// ---------------------------------------------------------------- honesty

test('an order with no amount is counted, never valued at zero', () => {
  const r = reconcile({
    leads: [{ client: 'ghost', status: 'not_placed', date: '2026-06-01' }],
    orders: [{ client: 'ghost', amount: null, order_date: '2026-06-30' }],
  });
  const f = r.findings.marked_lost_but_ordered[0];
  assert.equal(f.order_count, 1);
  assert.equal(f.orders_without_value, 1);
  assert.ok(isMissing(f.total_value), 'an unpriced order must not total to 0');
  assert.equal(String(f.total_value), 'MISSING');
});

test('tips are part of what a written-off buyer was worth', () => {
  const r = reconcile({
    leads: [{ client: 'tipper', status: 'not_placed', date: '2026-02-01' }],
    orders: [{ client: 'tipper', amount: 175, tip: 26.25, order_date: '2026-02-11' }],
  });
  assert.equal(r.findings.marked_lost_but_ordered[0].total_value, 201.25);
});

test('a missing source refuses to reconcile rather than inventing findings', () => {
  const r = reconcile({ leads: MISSING, orders: [{ client: 'a', amount: 10 }] });
  assert.equal(r.available, false);
  assert.deepEqual(r.missing_sources, ['leads']);
  assert.ok(isMissing(r.summary));
  assert.ok(isMissing(r.findings.order_without_inquiry));
});

test('every rate carries an interval, and small denominators say so', () => {
  const big = reconcile().conversion;
  assert.equal(big.too_few_to_call, false, 'a denominator in the hundreds is callable');
  assert.ok(big.true_ci[0] < big.true_rate && big.true_rate < big.true_ci[1]);

  const small = reconcile({
    leads: Array.from({ length: 4 }, (_, i) => ({
      client: `b${i}`,
      status: 'not_placed',
      date: '2026-07-01',
    })),
    orders: [{ client: 'b0', amount: 10, order_date: '2026-07-02' }],
  });
  assert.equal(small.conversion.too_few_to_call, true);
  assert.equal(small.conversion.denominator, 4);
  assert.ok(small.conversion.denominator < MIN_SAMPLE);
});

test('wilson matches the interval the house rule quotes: 4 of 34', () => {
  const [lo, hi] = wilson(4, 34);
  assert.equal((lo * 100).toFixed(1), '4.7');
  assert.equal((hi * 100).toFixed(1), '26.6');
});

test('findings are ordered by money at stake so the top row is the biggest', () => {
  const set = reconcile().findings.marked_lost_but_ordered;
  for (let i = 1; i < set.length; i++) {
    const prev = isMissing(set[i - 1].total_value) ? -1 : set[i - 1].total_value;
    const cur = isMissing(set[i].total_value) ? -1 : set[i].total_value;
    assert.ok(prev >= cur, 'finding set is not sorted by value');
  }
});

test('every finding carries buyer, first seen, order count and value', () => {
  const r = reconcile();
  for (const name of ['marked_lost_but_ordered', 'marked_won_no_order', 'order_without_inquiry']) {
    for (const f of r.findings[name]) {
      assert.equal(typeof f.buyer, 'string');
      assert.ok(f.buyer.length > 0);
      assert.equal(f.finding, name);
      assert.ok('first_seen' in f);
      assert.equal(typeof f.order_count, 'number');
      assert.ok('total_value' in f);
      if (!isMissing(f.first_seen)) assert.match(f.first_seen, /^\d{4}-\d{2}-\d{2}$/);
    }
  }
});

test('no username reduced to an unjoinable blank', () => {
  const r = reconcile();
  assert.equal(r.unjoinable.orders, 0);
  assert.equal(r.unjoinable.leads, 0);
});

// ------------------------------------------------------------- the reader

test('MISSING renders as MISSING everywhere a value goes', () => {
  assert.equal(String(MISSING), 'MISSING');
  assert.equal(`${MISSING}`, 'MISSING');
  assert.equal(JSON.stringify({ x: MISSING }), '{"x":"MISSING"}');
  assert.ok(isMissing(MISSING));
  assert.ok(!isMissing(0));
  assert.ok(!isMissing(null));
  assert.ok(MISSING, 'MISSING is truthy on purpose, so `x || 0` cannot swallow it');
});

test('pick yields MISSING for an absent path and preserves a real null', () => {
  // The verdict itself moves with the data; that pick REACHES it does not.
  // This asserted 'SOFTENING' and went red the day organic actually breached,
  // which is the one day the suite should have stayed quiet and let the
  // finding speak.
  const verdict = pick(run(), 'metrics.health.verdict');
  assert.ok(!isMissing(verdict), 'pick could not reach a path that exists');
  assert.equal(typeof verdict, 'string');

  assert.ok(isMissing(pick(run(), 'metrics.nothing.here')));
  assert.ok(isMissing(pick(MISSING, 'anything')));

  // A real null must survive as null. If pick turned it into MISSING the page
  // would print "MISSING" for a value the engine deliberately set to nothing.
  assert.equal(pick(run(), 'metrics.decomposition.ctr_now'), null);
});

test('the jsonl readers tolerate blank lines and return rows, not text', () => {
  assert.ok(Array.isArray(flow()) && flow().length > 0);
  assert.ok(Array.isArray(impressions()) && impressions().length > 0);
  assert.equal(dataStatus().parse_errors, 0);
});

test('an absent data directory yields MISSING, never zero or an empty list', () => {
  const original = process.env.XSTUDIOZ_DATA_DIR;
  process.env.XSTUDIOZ_DATA_DIR = '/nonexistent/xstudioz-data';
  clearCache();
  try {
    assert.ok(isMissing(run()));
    assert.ok(isMissing(orders()));
    assert.ok(isMissing(leads()));
    const s = staleness();
    assert.equal(s.ok, false);
    assert.equal(s.fresh, false);
    assert.ok(isMissing(s.age_days), 'an unknown age must not be reported as 0 days');
    assert.equal(s.label, 'no run file');
    assert.deepEqual(dataStatus().missing.sort(), [
      'calibration',
      'flow',
      'impressions',
      'leads',
      'orders',
      'predictions',
      'run',
    ]);
  } finally {
    if (original === undefined) delete process.env.XSTUDIOZ_DATA_DIR;
    else process.env.XSTUDIOZ_DATA_DIR = original;
    clearCache();
  }
});

test('staleness measures the run date, not the file mtime', () => {
  // Anchor on whatever run is committed, then measure FROM it. Hard-coding
  // 2026-08-01 meant the test broke the moment a fresher run landed, which is
  // the opposite of what a staleness test should do.
  const runDate = staleness().run_date;
  const today = staleness({ now: new Date(`${runDate}T12:00:00Z`) });
  assert.equal(today.ok, true);
  assert.equal(today.age_days, 0);
  assert.equal(today.fresh, true);
  assert.equal(today.label, "today's run");

  const base = new Date(`${runDate}T00:00:00Z`);
  const threeDaysOn = new Date(base.getTime() + 3 * 86400000);
  const later = staleness({ now: threeDaysOn });
  assert.equal(later.age_days, 3);
  assert.equal(later.label, '3 days old');
  assert.equal(later.fresh, false, 'a 3-day-old run is not fresh however new the file is');
});
