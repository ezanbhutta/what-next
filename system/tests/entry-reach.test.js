// tests/entry-reach.test.js, the reach page has to describe the source it
// actually reads.
//
// WHAT THIS FILE USED TO PIN
//
// A form. server.js summed the per-gig rows into the profile's reach and threw
// the typed total away, and the view still told the CSR the opposite: that the
// split was stored as typed and never added into the totals. Nothing about
// that failed. The page loaded, the number looked plausible, and a CSR who
// followed the instruction replaced the whole profile's reach with one gig's.
//
// The form is gone. The team types these figures into the Daily Data Sheet
// and this page reads them. So the drift this file exists to catch moved with
// it, and it is the same shape as before: two sides edited in different files,
// agreeing on the day they are written and nowhere after.
//
// THE THREE WAYS THIS PAGE CAN BE WRONG WHILE LOOKING RIGHT
//
//   1. It stops saying how old the sheet is. Every figure is still rendered,
//      still correct for its own date, and read as today's.
//   2. It adds up a standing figure. A week of lifetime review counts summed
//      comes to about eleven thousand reviews, printed in the same typeface as
//      every true number on the page.
//   3. It starts writing again. Two places to type one number is two answers
//      and no way to know which is being read.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const { render, WINDOWS } = await import('../views/entry.js');
const { REACH_FLOWS, REACH_LEVELS } = await import('../lib/external.js');

/** A board day, in the vocabulary `reachDays` hands over. */
const day = (entry_date, over = {}) => ({
  entry_date,
  gigs: [{ gig: 'XStudioz', impressions: over.impressions ?? 1000 }],
  impressions: 1000,
  clicks: 20,
  organic_orders: 1,
  organic_value: 300,
  directed_orders: 2,
  directed_value: 600,
  total_orders: 3,
  orders_completed: 2,
  completed_value: 500,
  inquiries_received: 4,
  cancellations: 0,
  cancelled_value: 0,
  orders_in_queue: 30,
  total_reviews: 1546,
  success_score: 8,
  profile_rating: 4.8,
  entered_by: 'Sheet import',
  updated_at: '2026-07-29T10:19:16Z',
  ...over,
});

const ctx = (over = {}) => ({
  data: {
    window: '7',
    asOf: { ok: true, date: '2026-07-28', daysOld: 9, enteredBy: 'Sheet import', notice: null },
    days: { ok: true, rows: [day('2026-07-28'), day('2026-07-27')], notice: null },
    gigs: {
      ok: true,
      rows: [
        { id: 'xstudioz', name: 'XStudioz', account: 'XStudioz', active: true, main: true },
        { id: 'gig-x-studioz-new-gig', name: 'X_Studioz new gig', account: 'XStudioz', active: true, main: false },
      ],
      notice: null,
    },
    notice: null,
    ...over,
  },
  user: { name: 'Ezan', role: 'owner' },
  query: {},
});

const body = (over) => String(render(ctx(over)).html);

/** The page as a reader sees it. Every figure on this page goes through `num()`
 *  or `money()`, which wrap it in a span, so a scan of the raw markup for
 *  "9 days ago" misses text that is plainly on the screen. */
const text = (over) => body(over).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');

test('a board this far behind says so before it says anything else', () => {
  const out = render(ctx());
  const page = String(out.html).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');

  assert.match(
    page,
    /9 days ago/,
    'the staleness banner must print how many days behind the sheet is. Without it every figure on ' +
      'this page reads as current, and each one is individually correct for a date nobody can see.'
  );
  assert.match(
    out.title,
    /9 days ago/,
    'the page title is the one line a reader always sees. With the sheet behind, that is the headline.'
  );
  const asOfCard = out.ticker.find((t) => /board as of/i.test(t.label));
  assert.ok(asOfCard, 'the ticker must carry the board date');
  assert.equal(String(asOfCard.sub), '9 days ago');
});

test('a current board does not shout about it', () => {
  const page = text({
    asOf: { ok: true, date: '2026-08-05', daysOld: 1, enteredBy: 'Amrah', notice: null },
    days: { ok: true, rows: [day('2026-08-05'), day('2026-08-04')], notice: null },
  });
  assert.ok(
    !/days ago,/.test(page),
    'one day behind is what Fiverr publishing at midday looks like, not a gap. A warning that fires ' +
      'every single day is a warning nobody reads on the day it matters.'
  );
});

test('a board that cannot be read is an outage, never a quiet month', () => {
  const out = render(ctx({ days: { ok: false, rows: null, notice: 'Impressions board answered 503' } }));
  const page = String(out.html).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
  assert.match(out.title, /cannot be read/i);
  assert.match(page, /503/,
    'the reason the store gave belongs on screen');
  assert.ok(
    !/\b0 impressions\b/.test(page),
    'an unreachable board must never render as zero reach'
  );
});

test('no standing figure is ever added up', () => {
  // The window total strip is built from RAW_FIELDS. A level in that list
  // would be summed across days, and the wrong total looks exactly as
  // reasonable as the right one.
  const src = read('views/entry.js');
  const rawBlock = src.slice(src.indexOf('const RAW_FIELDS'), src.indexOf('const LEVEL_FIELDS'));
  for (const level of REACH_LEVELS) {
    assert.ok(
      !rawBlock.includes(`'${level}'`),
      `${level} is a standing figure and it is in RAW_FIELDS, which is the list this page adds up. ` +
        'A week of lifetime review counts summed comes to about eleven thousand reviews.'
    );
  }
  // And the flows must all be there, or the page silently stops reporting one.
  const levelBlock = src.slice(src.indexOf('const LEVEL_FIELDS'), src.indexOf('const cell ='));
  for (const flow of REACH_FLOWS) {
    if (flow === 'total_orders') continue; // shown as organic + directed, which is the same number
    assert.ok(
      rawBlock.includes(`'${flow}'`) && !levelBlock.includes(`'${flow}'`),
      `${flow} is a flow the sheet records and this page does not print it`
    );
  }
});

test('a gap in the window is stated, not summed around', () => {
  // Two days on the sheet, a seven day window. Five days are simply absent and
  // a total that ignores that is a smaller number wearing a bigger label.
  const page = text();
  assert.match(page, /2 of 7 days filled in/, 'the control must say how much of its window exists');
  assert.match(page, /5 of these 7 days/, 'the missing days must be named in the window panel');
});

test('a partial window total carries the days it actually covers', () => {
  // Two days on the sheet, one of them blank on impressions. The first cut of
  // this returned MISSING for the whole window, which is defensible and was
  // wrong in practice: one blank cell in one column on one day turned every
  // headline on the page to MISSING and threw away tens of thousands of real
  // impressions to avoid printing them under a label saying 30 days.
  //
  // The denominator comes with the number instead of replacing it. A reader
  // cannot mistake it for a complete month, which was the whole point.
  const page = text({
    days: {
      ok: true,
      rows: [day('2026-07-28'), day('2026-07-27', { impressions: null })],
      notice: null,
    },
  });
  const panel = page.slice(page.indexOf('Last 7 days,'), page.indexOf('Day by day'));
  assert.ok(panel.length > 40, 'expected to find the window panel to read the totals out of');

  const impressions = panel.match(/Impressions\s+(MISSING|[\d,]+)\s*(All \d+ days|Across (\d+) of (\d+) days)?/);
  assert.ok(impressions, `no Impressions total found in the window panel: ${panel.slice(0, 300)}`);
  assert.equal(impressions[1], '1,000', 'the one day that carried the column is still worth printing');
  assert.equal(
    impressions[3],
    '1',
    'the total must say it covers ONE day. A bare 1,000 under a heading saying seven days is a ' +
      'smaller number wearing a bigger label, which is the one arithmetic error nothing on a page shows.'
  );
  assert.equal(impressions[4], '7');
});

test('a rate is never taken across two columns covering different days', () => {
  // 2 days of impressions over 1 day of clicks is not a click-through rate. It
  // is a ratio of two different weeks, and it lands among the plausible values
  // so nothing about it reads as wrong.
  const page = text({
    days: {
      ok: true,
      rows: [day('2026-07-28'), day('2026-07-27', { clicks: null })],
      notice: null,
    },
  });
  const panel = page.slice(page.indexOf('Last 7 days,'), page.indexOf('Day by day'));
  const ctr = panel.match(/Click-through\s+(MISSING|[\d.]+%|[^ ]+)/);
  assert.ok(ctr, `no click-through figure found: ${panel.slice(0, 300)}`);
  assert.equal(
    ctr[1],
    'MISSING',
    'the window click-through was computed from impressions over 2 days and clicks over 1'
  );
});

test('the page states that it does not write, and server.js does not', () => {
  const view = read('views/entry.js');
  assert.match(
    view,
    /NOTHING HERE WRITES/,
    'the file has to say it is read-only, because the next person to want a form here will read this first'
  );
  assert.ok(
    !/<form[^>]*method="post"/i.test(view),
    'a POST form on this page means a second place to type numbers the sheet already holds'
  );

  const server = read('server.js');
  assert.ok(
    !/app\.post\(\s*\n?\s*'\/entry'/.test(server),
    "POST /entry is back. The form's whole problem was that it was a second answer to a question the " +
      'Daily Data Sheet already answers, and nobody could tell which one a figure came from.'
  );
  assert.ok(
    !/INSERT INTO daily_entry/.test(server),
    'nothing may write to daily_entry any more'
  );
});

test('the windows the view offers are the windows the loader accepts', () => {
  const server = read('server.js');
  const declared = server.match(/const REACH_WINDOWS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(declared, 'server.js must declare the reach windows it will honour');
  const accepted = [...declared[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(
    accepted,
    WINDOWS.map((w) => w.key).sort(),
    'a window the view links to and the loader rejects falls back to the default with nothing on ' +
      'screen to say it did, so the reader gets 30 days under a label saying 90'
  );
});
