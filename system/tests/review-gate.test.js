// tests/review-gate.test.js: house rule 6, pinned.
//
// "Never attach a review request to a late or cold order" is the one rule in
// this repo whose breach is unrecoverable. A late delivery plus a review ask is
// how a private three-star becomes a public one, and no amount of later care
// takes a published rating back down.
//
// `reviewGate()` is not exported, on purpose: the rule is only worth anything
// where it actually runs, which is inside the rendered page. So these tests go
// through `render()` and read the page's own words, exactly as a CSR would.
//
// WHAT BROKE, AND WHY IT LOOKED FINE
//
// The gate enumerated two buckets, `stale` and `owes === 'us'`. But `triage()`
// rewrites EVERY open row's bucket to 'dead' as soon as a human flags the
// buyer, so flagging emptied the very bucket the gate was reading. The result
// was inverted: recording that a buyer was disputed is what UNLOCKED the review
// ask on them. Nothing in the source looked wrong, both halves are correct on
// their own, and the page went on printing a confident green "a review request
// is permitted for this buyer".
//
// A status the order book spells differently did the same thing by another
// route: `OWES_BY_STATUS` maps three strings, anything else falls to 'unknown',
// and the gate walked past that bucket entirely. `verdict()` printed "establish
// the stage first" while the gate underneath printed "permitted", on one page,
// about one order.

import test from 'node:test';
import assert from 'node:assert/strict';

import { render } from '../views/messages.js';

const ok = (rows) => ({ ok: true, rows });
const DOWN = { ok: false };

/**
 * One buyer, one open order, rendered.
 *
 * `flagged`: false = no flag, true = somebody called this buyer dead,
 * null = the flag store did not answer.
 */
function page({
  status = 'delivered',
  flagged = false,
  ageDays = 10,
  orderDate = '2026-07-26',
  deliveredDate = null,
  openOrders = null,
} = {}) {
  const orders =
    openOrders ??
    [{ client: 'testbuyer', project: 'Falcon logo', status, age_days: ageDays,
       stale: ageDays > 60, amount: 200, order_date: orderDate }];

  const ctx = {
    run: {
      recovery: {
        open_orders: { as_of: '2026-08-05', stale_after_days: 60, orders },
        quotes: { quotes: [] },
        followup_benchmark: { followed_n: 50, followed_placed: 20 },
      },
    },
    nonce: 'test-nonce',
    query: {},
    user: { name: 'Ezan', role: 'owner' },
    csrfToken: 'test-csrf',
    data: {
      buyer: 'testbuyer',
      buyerKey: 'testbuyer',
      orders: [
        { client: 'testbuyer', status, amount: 200,
          order_date: orderDate, delivered_date: deliveredDate },
      ],
      leads: [],
      notes:
        flagged === null
          ? DOWN
          : ok(flagged
              ? [{ id: 1, buyer: 'testbuyer', at: '2026-08-01', author: 'Ezan',
                   kind: 'flag', body: 'refund threatened' }]
              : []),
      talk: ok([]),
    },
  };
  return String(render(ctx).html);
}

/** What the page tells the CSR, in its own words. */
function verdictOf(html) {
  const permitted = html.includes('A review request is permitted for this buyer');
  const refused = html.includes('No review request goes to');
  assert.ok(
    permitted !== refused,
    'the page must state exactly one review verdict, and it stated ' +
      (permitted ? 'both' : 'neither')
  );
  return permitted ? 'permitted' : 'refused';
}

test('a flagged buyer is refused, and flagging never unlocks the ask', () => {
  // Every status, because the bug was that the flag rewrote the bucket rather
  // than being read on its own. Which status it rewrote was incidental.
  for (const status of ['in_progress', 'revision', 'delivered', 'completed']) {
    assert.equal(
      verdictOf(page({ status, flagged: true })),
      'refused',
      `a flagged buyer with a ${status} order must be refused a review ask`
    );
  }

  // The inversion itself: the unflagged in-progress order is refused because we
  // owe work. Flagging must not turn that into a yes.
  assert.equal(verdictOf(page({ status: 'in_progress', flagged: false })), 'refused');
  assert.equal(verdictOf(page({ status: 'in_progress', flagged: true })), 'refused');
});

test('the gate fails closed when the flag store cannot be read', () => {
  // MISSING is not "nobody flagged them", on exactly the terms the gate already
  // applies to an unreadable engine run.
  for (const status of ['in_progress', 'revision', 'delivered', 'completed']) {
    assert.equal(
      verdictOf(page({ status, flagged: null })),
      'refused',
      `an unreadable flag store must refuse, not permit, on a ${status} order`
    );
  }
});

test('an open order with no recorded stage is refused', () => {
  // Anything outside OWES_BY_STATUS. A cancelled order, a blank status, and a
  // spelling the order book might start using are all the same fact: we cannot
  // show the work landed.
  for (const status of ['cancelled', 'completed', 'in_revision', 'awaiting_buyer', '']) {
    assert.equal(
      verdictOf(page({ status, flagged: false })),
      'refused',
      `status ${JSON.stringify(status)} does not place the order, so the ask must be refused`
    );
  }
});

test('a late order is refused however the buyer is flagged', () => {
  for (const flagged of [false, true, null]) {
    assert.equal(
      verdictOf(page({ status: 'delivered', flagged, ageDays: 268 })),
      'refused',
      'an order open past the stale line is refused whatever the flag store says'
    );
  }
});

test('the engine being unreadable refuses, and says so rather than going quiet', () => {
  const html = String(
    render({
      run: {},
      nonce: 'n', query: {}, user: { name: 'Ezan', role: 'owner' }, csrfToken: 'c',
      data: {
        buyer: 'testbuyer', buyerKey: 'testbuyer',
        orders: [{ client: 'testbuyer', status: 'delivered', amount: 200,
                   order_date: '2026-07-26', delivered_date: '2026-07-31' }],
        leads: [], notes: ok([]), talk: ok([]),
      },
    }).html
  );
  assert.equal(verdictOf(html), 'refused');
});

test('an unreadable quotes block refuses, it does not read as "no cold quotes"', () => {
  // `runOk` only vouches for recovery.open_orders. The cold-quote check reads
  // recovery.quotes, and an absent block coerced to [] passed it silently: the
  // clean case below stayed permitted with the quotes file gone, even though
  // whether this buyer had a dead quote was unknowable.
  const ctx = {
    run: {
      recovery: {
        open_orders: { as_of: '2026-08-05', stale_after_days: 60, orders: [] },
        followup_benchmark: { followed_n: 50, followed_placed: 20 },
        // no `quotes` key at all: the engine did not write it
      },
    },
    nonce: 'n', query: {}, user: { name: 'Ezan', role: 'owner' }, csrfToken: 'c',
    data: {
      buyer: 'testbuyer', buyerKey: 'testbuyer',
      orders: [{ client: 'testbuyer', status: 'completed', amount: 200,
                 order_date: '2026-07-20', delivered_date: '2026-07-31' }],
      leads: [], notes: ok([]), talk: ok([]),
    },
  };
  assert.equal(verdictOf(String(render(ctx).html)), 'refused');
});

test('the one clean case still clears, so the gate is a gate and not a wall', () => {
  // Nothing open, one delivery inside the stale line, no flag. This is the only
  // combination the page claims will pass, and it has to actually pass: a rule
  // that refuses everything teaches people to route around it.
  const html = page({
    openOrders: [],
    flagged: false,
    status: 'completed',
    deliveredDate: '2026-07-31',
    orderDate: '2026-07-20',
  });
  assert.equal(verdictOf(html), 'permitted');
});
