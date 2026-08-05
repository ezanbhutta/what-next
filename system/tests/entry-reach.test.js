// tests/entry-reach.test.js, the daily entry page has to describe the save it
// actually performs.
//
// WHAT WENT WRONG
//
// server.js was changed so the profile's reach is the SUM of the per-gig rows,
// and the typed impressions and clicks boxes are thrown away whenever one gig
// is named. That change is right: asking for the parts and the total is two
// copies of one number, and two copies drift.
//
// The view was not changed with it. The gig panel still read "these figures
// are stored as typed and are never added into the totals above, the
// profile-level impressions box is the number the derived rate uses", which is
// the exact opposite of what the handler does, and the stat strip captioned
// the stored impressions "as typed" on days when nothing about it was typed.
//
// Nothing about that fails. The page loads, the number looks plausible, and a
// CSR who follows the instruction fills in the one gig they happened to be
// looking at and silently replaces the whole profile's reach with a subset.
// Every click-through rate for that day then describes a fraction of the
// profile, and the rate is the figure this page leads with.
//
// So the copy is pinned here. This is a seam test in the same sense as
// tests/wiring.test.js: the two sides are edited in different files, they
// drift, and the drift renders as a calm correct-looking page.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { render } from '../views/entry.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** ctx.data as the entry loader supplies it, with whatever rows a test needs. */
function ctxWith({ entryRow = null, gigRows = [] } = {}) {
  const ok = (rows) => ({ ok: true, rows });
  return {
    query: {},
    csrfToken: 't',
    user: { name: 'Ezan', role: 'owner' },
    engine: { runDate: '2026-08-05' },
    data: {
      date: '2026-08-04',
      profiles: ['X Studioz'],
      entries: ok(entryRow ? [entryRow] : []),
      gigs: ok(gigRows),
      recent: ok([]),
      previous: ok([]),
      previousGigs: ok([]),
    },
  };
}

const ROW = {
  profile: 'X Studioz',
  entry_date: '2026-08-04',
  impressions: 350,
  clicks: 40,
  entered_by: 'Ezan',
};

const GIGS = [
  { profile: 'X Studioz', gig: 'Logo design', impressions: 100, clicks: 12 },
  { profile: 'X Studioz', gig: 'Brand guidelines', impressions: 250, clicks: 28 },
];

/**
 * The caption under one stat-strip figure.
 *
 * render() returns the strip as `ticker`, a structured list, and only the
 * layout turns it into markup. Searching the `html` half for these captions
 * finds nothing and passes, which is how a test can watch a figure it is not
 * actually looking at.
 */
function captionFor(out, label) {
  const cell = (out.ticker || []).find((t) => t.label === label);
  assert.ok(cell, `the strip has no "${label}" figure`);
  return String(cell.sub ?? '');
}

// -------------------------------------------------------------- the caption

test('reach saved from a gig split is not captioned "as typed"', () => {
  const out = render(ctxWith({ entryRow: ROW, gigRows: GIGS }));
  for (const label of ['Impressions', 'Clicks']) {
    assert.equal(
      captionFor(out, label),
      'summed from 2 gigs',
      `${label} was stored as the sum of the split. The strip has to say so.`
    );
  }
});

test('reach with no gig split is still captioned "as typed"', () => {
  // The other half. A caption that always says "summed" is as wrong as one
  // that always says "typed", and checking only the interesting case would
  // pass a constant.
  const out = render(ctxWith({ entryRow: ROW, gigRows: [] }));
  assert.equal(captionFor(out, 'Impressions'), 'as typed');
  assert.equal(captionFor(out, 'Clicks'), 'as typed');
});

test('one gig reads "gig", not "gigs"', () => {
  const out = render(ctxWith({ entryRow: ROW, gigRows: [GIGS[0]] }));
  assert.equal(captionFor(out, 'Impressions'), 'summed from 1 gig');
});

// ----------------------------------------------------------- the instruction

test('the gig panel does not tell the CSR the split is ignored', () => {
  // Pinned against the source rather than one render, because this claim can
  // reappear anywhere in the file and the page it damages is the page that
  // does not show it.
  const source = fs.readFileSync(path.join(ROOT, 'views', 'entry.js'), 'utf8');
  const prose = source.replace(/^\s*(\/\/.*)$/gm, '');
  assert.doesNotMatch(
    prose,
    /never added into the totals/,
    'server.js adds them into the totals. Saying otherwise gets a real day of reach overwritten.'
  );
  assert.match(
    prose,
    /becomes the profile's reach/,
    'The panel has to state that naming a gig replaces the typed reach.'
  );
});

test('server.js still derives reach from the gigs, which is what the copy promises', () => {
  // The copy above is only correct while this is. If someone reverses the
  // handler, this test names the file that now lies rather than leaving the
  // page to be wrong quietly.
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(server, /if \(c === 'impressions' && gigImpTotal !== undefined\) vals\.push\(gigImpTotal\)/);
  assert.match(server, /if \(c === 'clicks' && gigClickTotal !== undefined\) vals\.push\(gigClickTotal\)/);
});
