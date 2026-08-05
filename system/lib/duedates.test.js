// lib/duedates.test.js
//
// The rule under test is one sentence: LATE is not OLD, and NEITHER is
// UNKNOWN. Every failure below is a version of the system claiming an order
// is late when nobody ever wrote down what was promised.

import test from 'node:test';
import assert from 'node:assert/strict';

import { orderKey, lateness, applyDueDates, orphanedPromises } from './duedates.js';

const AS_OF = '2026-08-05';

test('an order with no promised date is never late', () => {
  for (const due of [null, undefined, '', 'not a date', '   ']) {
    const l = lateness(due, AS_OF);
    assert.equal(l.late, false, `due=${JSON.stringify(due)} must not be late`);
    assert.equal(l.known, false);
    assert.equal(l.state, 'unknown');
  }
});

test('a 272-day-old order inside its agreed scope is on time, not late', () => {
  // The case the whole table exists for. Age says stale; the promise says fine.
  const l = lateness('2026-09-30', AS_OF);
  assert.equal(l.state, 'on_time');
  assert.equal(l.late, false);
  assert.equal(l.days, -56);
  assert.match(l.label, /Due in 56 days/);
});

test('a 6-day-old order promised in 5 days is late, well inside the 60-day band', () => {
  // The other half: lateness the age banding cannot see at all.
  const l = lateness('2026-08-04', AS_OF);
  assert.equal(l.state, 'late');
  assert.equal(l.late, true);
  assert.equal(l.days, 1);
  assert.equal(l.label, '1 day past the promised date');
});

test('due today is not yet late', () => {
  const l = lateness(AS_OF, AS_OF);
  assert.equal(l.state, 'on_time');
  assert.equal(l.late, false);
  assert.equal(l.label, 'Due today');
});

test('lateness is measured against the run, not the wall clock', () => {
  // A page must agree with the run it is rendering. Measuring against `now`
  // flips an order to late at midnight while every figure beside it still
  // describes yesterday's run.
  assert.equal(lateness('2026-08-05', '2026-08-05').late, false);
  assert.equal(lateness('2026-08-05', '2026-08-06').late, true);
});

test('the order key is stable, and refuses to be built without a buyer', () => {
  const row = { client: 'Osmanbey_35', project: 'Vodenco Pitch Deck', order_date: '2025-11-06' };
  assert.equal(orderKey(row), 'osmanbey35|vodencopitchdeck|2025-11-06');
  // Same order, different spelling and a timestamp on the date.
  assert.equal(
    orderKey({ client: 'osmanbey 35', project: 'Vodenco  Pitch-Deck', order_date: '2025-11-06T09:00:00Z' }),
    orderKey(row)
  );
  // No buyer, no key: a key built from a blank buyer collides with every
  // other blank buyer, which puts one person's promise on another's order.
  for (const bad of [{}, { client: '' }, { client: '   ' }, { project: 'x' }]) {
    assert.equal(orderKey(bad), null);
  }
});

test('an unreadable store reads as unknown, not as "nobody promised anything"', () => {
  const rows = [{ client: 'acme', project: 'Logo', order_date: '2026-07-01' }];
  const res = applyDueDates(rows, null, AS_OF);
  assert.equal(res.store_readable, false);
  assert.equal(res.late.length, 0);
  assert.equal(res.unpromised.length, 1);
  assert.equal(res.rows[0].due.state, 'unknown');

  const empty = applyDueDates(rows, new Map(), AS_OF);
  assert.equal(empty.store_readable, true, 'an empty table is a readable answer');
  assert.equal(empty.unpromised.length, 1);
});

test('the late list holds only orders with evidence behind them', () => {
  const rows = [
    { client: 'late1', project: 'A', order_date: '2026-07-01' },   // promised, passed
    { client: 'ontime', project: 'B', order_date: '2026-01-01' },  // ancient, promised later
    { client: 'nopromise', project: 'C', order_date: '2025-11-06' }, // 272 days, no promise
  ];
  const due = new Map([
    ['late1|a|2026-07-01', { order_key: 'late1|a|2026-07-01', due_date: '2026-07-20' }],
    ['ontime|b|2026-01-01', { order_key: 'ontime|b|2026-01-01', due_date: '2026-12-31' }],
  ]);
  const res = applyDueDates(rows, due, AS_OF);
  assert.deepEqual(res.late.map((r) => r.client), ['late1']);
  assert.deepEqual(res.on_time.map((r) => r.client), ['ontime']);
  assert.deepEqual(res.unpromised.map((r) => r.client), ['nopromise']);
  // The oldest order in the set is the one NOT called late. That is the point.
  assert.equal(res.rows[2].due.late, false);
});

test('a renamed project orphans its promise, and the orphan is reported', () => {
  // The key is derived from the sheet, so an edit in the sheet detaches the
  // row. Losing it silently would lose the only record of what was promised.
  const due = new Map([
    ['acme|oldname|2026-07-01', {
      order_key: 'acme|oldname|2026-07-01', buyer: 'acme',
      project: 'Old Name', order_date: '2026-07-01', due_date: '2026-08-01',
    }],
  ]);
  const rows = [{ client: 'acme', project: 'New Name', order_date: '2026-07-01' }];
  const orphans = orphanedPromises(due, rows);
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].project, 'Old Name', 'the orphan still says what it was attached to');
  assert.equal(orphanedPromises(null, rows).length, 0, 'an unreadable store reports no orphans');
  assert.equal(orphanedPromises(due, [{ client: 'acme', project: 'Old Name', order_date: '2026-07-01' }]).length, 0);
});
