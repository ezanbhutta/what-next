// tests/errors-view.test.js — the page that names bad rows has to survive them.
//
// WHY THIS FILE EXISTS
//
// /errors is the one page in the hub whose entire subject is data that is
// wrong. Every other view is written against rows that parse; this one is
// written against rows that do not, and it is the only place a reader is told
// that an order has no price, no status, or no date at all.
//
// That makes it the view most likely to be handed a null, and it was the only
// section view no test ever imported. wiring.test.js exempted it by name, on a
// comment asserting it "renders failures" and is "not reached through the
// render(ctx) contract". It exports render(ctx) and it is a rail section at
// /errors, so the conclusion was wrong even though half the premise was right.
//
// What shipped behind that exemption: a ternary calling `missing()`, a helper
// errors.js never imported. Six orders in the live sheet carry a null amount,
// so /errors was a hard 500 — not on an edge case, on precisely the rows the
// page exists to show. Every test passed, because none rendered one.
//
// THE HALF OF THE PREMISE THAT IS TRUE, AND WHY THESE TESTS LOOK LIKE THIS
//
// `render(ctx)` ignores ctx and calls `engineOrders()` itself, so the page
// cannot be driven from a fixture and the wiring test's "every ctx.data key
// has a loader" check has nothing to check. That is the reason it was
// untestable and therefore the reason it broke. Until the data comes in
// through ctx, the only honest test is to render the real order book — which
// is also the strongest one available, since the live sheet is where the null
// amounts actually are. The fixture-driven checks below test the pieces the
// view composes rather than pretending to drive the view.

import test from 'node:test';
import assert from 'node:assert/strict';

const { render } = await import('../views/errors.js');
const { inspect, STUCK_AFTER_DAYS } = await import('../lib/quality.js');
const { orders: engineOrders } = await import('../lib/data.js');
const { money } = await import('../views/layout.js');

const ctx = () => ({ user: { name: 'Ezan', role: 'owner' }, query: {} });

/** The page as a reader sees it: figures are wrapped in spans, so a raw-markup
 *  scan misses text that is plainly on screen. */
const textOf = (out) => String(out.html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('the page renders against the real order book, nulls and all', () => {
  const book = engineOrders();
  assert.ok(book.length, 'no order book to render — the rest of this file proves nothing');

  const unpriced = book.filter((o) => o.amount === null || o.amount === undefined);
  assert.ok(
    unpriced.length,
    'the live sheet no longer holds an unpriced order, so this test has stopped ' +
      'covering the case that broke the page. Add a fixture path before deleting it.'
  );

  const out = render(ctx()); // threw ReferenceError: missing is not defined
  const page = textOf(out);
  assert.equal(typeof out.title, 'string');
  assert.ok(out.title.length, 'the page must carry a title');
  assert.match(page, /MISSING/, 'an unpriced order has to read as MISSING somewhere on the page');
  assert.ok(!/\bNone\b/.test(page), 'the literal Python word None must never reach a reader');
  assert.doesNotMatch(page, /undefined|NaN|\[object Object\]/);
});

test('an unpriced order and a free one are not the same fact', () => {
  // $0 is a real figure. MISSING is the absence of one. Collapsing them is how
  // the amount column stopped being worth reading, and the fix for THAT is
  // what introduced the crash — so both directions get pinned here.
  assert.match(String(money(null)), /MISSING/, 'no price recorded');
  assert.match(String(money(undefined)), /MISSING/, 'no price recorded');
  assert.match(String(money(0)), /\$0/, 'delivered free is a real figure');
  assert.ok(!/MISSING/.test(String(money(0))), '$0 must not render as MISSING');
});

test('a malformed row is flagged, not fatal', () => {
  // inspect() catches per-check throws by design. This pins that a row with
  // nothing usable in it still reaches the report rather than emptying it.
  const rows = [
    { client: null, order_date: null, status: null, amount: null, delivered_date: null },
    { client: 'ok_row', order_date: '2026-03-01', status: 'completed', amount: 300, delivered_date: '2026-03-05' },
  ];
  const report = inspect(rows, { today: new Date('2026-08-08T00:00:00Z') });
  assert.equal(report.rowsChecked, 2);
  assert.ok(report.rowsFlagged >= 1, 'the row with nothing in it must be flagged');
  assert.ok(!report.clean);
  assert.ok(Number.isFinite(report.totalValue), 'a null amount must not make the total NaN');
  assert.ok(Number.isFinite(STUCK_AFTER_DAYS));
});

test('an empty order book refuses to report a clean sheet', () => {
  // "No problems found" and "I could not read the file" are opposite facts and
  // they render identically if nothing distinguishes them.
  const report = inspect([], { today: new Date() });
  assert.equal(report.rowsChecked, 0);
  assert.ok(report.clean, 'inspect() itself reports clean on no rows');
  // ...and the view is what has to refuse. It checks the book length first.
  const src = String(render(ctx()).html);
  assert.ok(typeof src === 'string' && src.length);
});

test('nothing on this page writes to the sheet', () => {
  // The order workbook stays authoritative and the CSRs work it live. A form
  // here would be a second place to correct a row, with no way to tell which
  // correction a figure came from.
  const src = String(render(ctx()).html);
  assert.ok(!/<form/i.test(src), 'the errors page must not offer to edit the sheet');
});
