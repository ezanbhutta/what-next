// tests/pulse.test.js, the delivered-work page.
//
// Every figure on this page is a cut of the same order rows three other pages
// already read, so the failure mode is not a crash. It is a number that is
// four percent off, or a denominator that quietly includes rows it should not,
// on a page that looks exactly as finished either way.
//
// The five pinned here are the ones this particular data invites:
//
//   1. Bucketing deliveries and orders-taken by one date column. They are two
//      events. One window cannot hold both.
//   2. Counting a row with no rating column as a buyer who left no review.
//      Those render identically and only one of them is anybody's fault.
//   3. Treating a blank price as zero, which makes an order worth nothing and
//      drags the average down with it.
//   4. Offering something to do about a low rating. Every route from a public
//      rating back to a better one runs through asking the buyer to change it,
//      and that is against Fiverr's terms.
//   5. A window the view links to and the loader will not honour, which falls
//      back to the default with nothing on screen to say it did.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const { render, WINDOWS } = await import('../views/pulse.js');
const { MISSING } = await import('../lib/data.js');

/** One order, in the shape the engine writes to data/orders.jsonl. */
const order = (over = {}) => ({
  client: 'somebuyer',
  profile: 'X Studioz',
  order_date: '2026-07-10',
  delivered_date: '2026-07-15',
  project: 'A mark',
  order_type: 'organic',
  status: 'completed',
  amount: 100,
  rating: 5,
  logo_designer: 'Amin',
  branding_designer: null,
  csr: 'Iqra',
  rating_tracked: true,
  ...over,
});

const ctx = (book, window = '30') => ({
  data: { window, today: '2026-07-20', book },
  user: { name: 'Ezan', role: 'owner' },
  query: {},
});

const out = (book, window) => render(ctx(book, window));
const text = (book, window) =>
  String(out(book, window).html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('a delivery is counted in the window it was delivered, not ordered', () => {
  // Ordered before the window opened, delivered inside it. It is one delivery
  // and zero orders taken, and a page bucketing both on `order_date` would
  // report it as neither.
  const r = out([order({ order_date: '2026-05-02', delivered_date: '2026-07-15' })]);
  const ticker = Object.fromEntries(r.ticker.map((t) => [t.label, String(t.value).replace(/<[^>]+>/g, '')]));
  assert.equal(ticker.Delivered, '1', 'delivered inside the window and not counted');
  assert.equal(ticker.Taken, '0', 'ordered outside the window and counted anyway');
});

test('an order taken but not yet delivered counts as taken and not as delivered', () => {
  const r = out([order({ order_date: '2026-07-18', delivered_date: null, status: 'in_progress' })]);
  const ticker = Object.fromEntries(r.ticker.map((t) => [t.label, String(t.value).replace(/<[^>]+>/g, '')]));
  assert.equal(ticker.Taken, '1');
  assert.equal(ticker.Delivered, '0');
});

test('a row with no rating column is not a buyer who left no review', () => {
  // Two delivered orders. One tracked with a review, one the source cannot
  // report on at all. Capture is 1 of 1, not 1 of 2: the second is unknown,
  // and folding it in reports a 50% capture rate that describes nothing.
  const r = out([
    order({ rating_tracked: true, rating: 5 }),
    order({ rating_tracked: false, rating: null, client: 'other' }),
  ]);
  const ticker = Object.fromEntries(r.ticker.map((t) => [t.label, String(t.value).replace(/<[^>]+>/g, '')]));
  assert.equal(ticker['Reviews left'], '1');
  assert.equal(
    r.ticker.find((t) => t.label === 'Reviews left').sub,
    'of 1 delivered',
    'the untracked order was counted in the capture denominator'
  );

  const page = text([
    order({ rating_tracked: true, rating: 5 }),
    order({ rating_tracked: false, rating: null, client: 'other' }),
  ]);
  assert.match(page, /No rating column 1/, 'the excluded row must be counted and shown, not just dropped');
});

test('a tracked delivery with no rating IS a buyer who left no review', () => {
  // The other half of the same rule, and the half that makes the rate real.
  const r = out([order({ rating_tracked: true, rating: 5 }), order({ rating_tracked: true, rating: null, client: 'b' })]);
  assert.equal(r.ticker.find((t) => t.label === 'Reviews left').sub, 'of 2 delivered');
});

test('an order with no price is not an order worth nothing', () => {
  // $100 and a blank. The total is $100 over one priced order, so the average
  // is $100. Treating the blank as zero gives an average of $50, which is not
  // a price anybody charged.
  const page = text([order({ amount: 100 }), order({ amount: null, client: 'b' })]);
  assert.match(page, /AOV delivered \$100/, `average was dragged down by a blank price: ${page.slice(0, 400)}`);
  assert.match(page, /1 of 2 carried no price/, 'the blank must be reported, not silently skipped');
});

test('a low rating is named, and nothing is offered to do about it', () => {
  const page = text([order({ rating: 2, client: 'unhappybuyer' })]);
  assert.match(page, /unhappybuyer/, 'the order must be visible: a 2-star nobody looked at teaches nobody');

  // R6. No route from this page towards a buyer's public rating.
  const src = read('views/pulse.js');
  for (const banned of [/ask.{0,20}(remove|change|withdraw|revise|update).{0,20}review/i,
                        /request a review/i,
                        /review request/i,
                        /chase.{0,15}review/i]) {
    assert.ok(!banned.test(src), `views/pulse.js contains "${src.match(banned)?.[0]}", which is a review ask`);
  }
  assert.ok(
    !/<form/i.test(src) && !/<button(?![^>]*aria-label="Close")/i.test(src),
    'this page must offer no action at all, so there is nothing here that could become a review ask'
  );
});

test('an unreadable book is an outage, never a quiet month', () => {
  const r = render(ctx(MISSING));
  assert.match(r.title, /cannot be read/i);
  const page = String(r.html).replace(/<[^>]+>/g, ' ');
  assert.ok(!/\b0 delivered\b/.test(page), 'an unreadable book rendered as zero deliveries');
  assert.deepEqual(r.ticker, [], 'no figure may be stated when the source could not be read');
});

test('an empty book is an empty month, and says so', () => {
  const r = out([]);
  assert.match(r.title, /Nothing delivered/i);
  assert.ok(r.ticker.length > 0, 'a genuinely empty window still states its zeroes');
});

test('the windows the view offers are the windows the loader accepts', () => {
  const server = read('server.js');
  const declared = server.match(/const PULSE_WINDOWS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(declared, 'server.js must declare the pulse windows it will honour');
  const accepted = [...declared[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(
    accepted,
    WINDOWS.map((w) => w.key).sort(),
    'a window the view links to and the loader rejects falls back to the default with nothing on ' +
      'screen to say it did'
  );
});

// The last two are the same rule at two different layers, and they are separate
// tests because they fail for different reasons and only one of them is this
// view's fault.

test('the retired programme cannot be named, even if this view forgets', () => {
  // `order_type` is the raw string 'vvro' in the engine's own rows. The
  // chokepoint in layout.js rewrites it on the way to the screen, so the
  // guarantee does not depend on this file having thought about it. That is
  // the whole point of house rule 5: the leak is never prose anyone wrote, it
  // is raw internals reaching a renderer.
  const page = text([order({ order_type: 'vvro' })]);
  assert.ok(!/vvro/i.test(page), 'the retired name reached the page');
});

test('a directed order is labelled, not left as a raw column value', () => {
  // A separate question from the one above, and this one IS this view's job.
  // The scrub guarantees the name is safe; it does not give the reader a
  // label. Left to the scrub alone the cell reads a bare lowercase "directed"
  // with no pill and no counterpart on the organic rows.
  const page = text([order({ order_type: 'vvro' }), order({ order_type: 'organic', client: 'b' })]);
  assert.match(page, /Directed/, 'a directed order must carry its own label');
  assert.match(page, /Organic/, 'and so must an organic one, or the column reads as a flag on some rows');
});
