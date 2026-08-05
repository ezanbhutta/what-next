// The previous day's figures land around midday, so the entry form must not
// open on a day Fiverr has not published yet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { entryDay } from '../lib/roster.js';

/** A UTC instant that is `hour` PKT on 5 Aug 2026. PKT is UTC+5. */
const pktAt = (hour) => new Date(Date.UTC(2026, 7, 5, hour - 5, 0, 0));

test('before noon PKT the form opens on the day before yesterday', () => {
  for (const h of [0, 6, 9, 11]) {
    const r = entryDay(pktAt(h));
    assert.equal(r.ready, false, `${h}:00 PKT should not be ready`);
    assert.equal(r.date, '2026-08-03', `${h}:00 PKT opened on ${r.date}`);
  }
});

test('from noon PKT it opens on yesterday', () => {
  for (const h of [12, 13, 18, 23]) {
    const r = entryDay(pktAt(h));
    assert.equal(r.ready, true, `${h}:00 PKT should be ready`);
    assert.equal(r.date, '2026-08-04', `${h}:00 PKT opened on ${r.date}`);
  }
});

test('noon is the boundary, and 11:59 is still not ready', () => {
  assert.equal(entryDay(new Date(Date.UTC(2026, 7, 5, 6, 59))).ready, false); // 11:59 PKT
  assert.equal(entryDay(new Date(Date.UTC(2026, 7, 5, 7, 0))).ready, true);   // 12:00 PKT
});

test('it always says why, so the form can print it', () => {
  assert.match(entryDay(pktAt(9)).why, /not published until about midday/);
  assert.match(entryDay(pktAt(15)).why, /are published/);
  assert.equal(entryDay(pktAt(9)).yesterday, '2026-08-04', 'yesterday is still named');
});

test('it uses PKT, not the server clock', () => {
  // 20:00 UTC on 5 Aug is 01:00 PKT on 6 Aug: a new PKT day, before noon, so
  // the form opens on 4 Aug. A server-local implementation would say 4 Aug too
  // but for the wrong reason, so check the PKT rollover explicitly.
  const r = entryDay(new Date(Date.UTC(2026, 7, 5, 20, 0)));
  assert.equal(r.ready, false);
  assert.equal(r.yesterday, '2026-08-05');
  assert.equal(r.date, '2026-08-04');
});
