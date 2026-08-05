// lib/roster.test.js, the desk is never wrongly reported empty.
//
// The one bug that matters here: a 9 PM to 9 AM shift is stored on the day it
// STARTS, so asking "who is on at 3 AM Tuesday" has to look at Monday's row.
// Get it wrong and the hub reports an empty desk for the eight hours that are
// 3 PM to midnight in US Eastern, which is the heaviest ordering window on
// Fiverr and the one the roster document calls out as its top risk.
//
// The coverage totals below come from the roster's own section 03 footer:
// 168 of 168 hours covered, 52 at 3 deep, 41 at 2 deep, 75 at 1 deep. If a
// transcription slips, those totals stop reconciling.

import test from 'node:test';
import assert from 'node:assert/strict';

import { ROSTER, onDutyAt, nextHandover, pktNow, clock, deskNow } from './roster.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

test('every one of the 168 hours has somebody on the desk', () => {
  const empty = [];
  for (const day of DAYS) {
    for (let hour = 0; hour < 24; hour++) {
      if (onDutyAt(day, hour).length === 0) empty.push(`${day} ${hour}:00`);
    }
  }
  assert.deepEqual(empty, [], 'the roster covers 168 of 168 hours');
});

test('the coverage depths reconcile with the roster document', () => {
  // Section 03: 52 hrs at 3 deep, 41 at 2 deep, 75 at 1 deep.
  const tally = {};
  for (const day of DAYS) {
    for (let hour = 0; hour < 24; hour++) {
      const n = onDutyAt(day, hour).length;
      tally[n] = (tally[n] || 0) + 1;
    }
  }
  assert.equal(tally[3], 52, '3-deep hours');
  assert.equal(tally[2], 41, '2-deep hours');
  assert.equal(tally[1], 75, '1-deep hours');
  assert.equal(Object.values(tally).reduce((a, b) => a + b, 0), 168);
});

test('the night shift is found from the day it started', () => {
  // Nadir clocks in 9 PM Monday and works until 9 AM Tuesday. Every hour of
  // that stretch has to name him, including the ones dated Tuesday.
  for (const hour of [21, 22, 23]) {
    assert.ok(onDutyAt('Mon', hour).some((p) => p.name === 'Nadir'), `Mon ${hour}:00`);
  }
  for (const hour of [0, 1, 2, 5, 8]) {
    const on = onDutyAt('Tue', hour);
    assert.ok(on.some((p) => p.name === 'Nadir'), `Tue ${hour}:00 should be Nadir`);
    assert.ok(on.find((p) => p.name === 'Nadir').overnight, 'flagged as an overnight carry');
  }
  // He is gone at 9 AM sharp, when the day opens.
  assert.ok(!onDutyAt('Tue', 9).some((p) => p.name === 'Nadir'));
});

test('Nadir rest window is empty of Nadir, and Hasnain covers it', () => {
  // Friday 9 AM to Saturday 9 PM, protected. Standing rule 1.
  for (const hour of [9, 12, 18, 23]) {
    assert.ok(!onDutyAt('Fri', hour).some((p) => p.name === 'Nadir'), `Fri ${hour}:00`);
  }
  for (const hour of [0, 6, 12, 20]) {
    assert.ok(!onDutyAt('Sat', hour).some((p) => p.name === 'Nadir'), `Sat ${hour}:00`);
  }
  // Hasnain takes Friday night 9 PM to Saturday 9 AM instead.
  assert.ok(onDutyAt('Fri', 22).some((p) => p.name === 'Hasnain'));
  assert.ok(onDutyAt('Sat', 3).some((p) => p.name === 'Hasnain'));
  // And he is back on his own rest day at 9 PM Saturday.
  assert.ok(onDutyAt('Sat', 21).some((p) => p.name === 'Nadir'));
});

test('the known one-deep risks are reported as one deep, not hidden', () => {
  // Section 07 calls these out. The hub must agree with them, because a lone
  // name shown without "alone" beside it hides a risk somebody accepted.
  for (const hour of [1, 3, 6, 8]) {
    assert.equal(onDutyAt('Tue', hour).length, 1, `Tue ${hour}:00 is one deep`);
  }
  // Sunday runs one deep for 23 of 24 hours; the exception is midnight to 1 AM
  // when Hasnain's Saturday night overlaps Nadir's Sunday.
  const sunday = [];
  for (let hour = 0; hour < 24; hour++) sunday.push(onDutyAt('Sun', hour).length);
  assert.equal(sunday.filter((n) => n === 1).length, 23);
  assert.equal(sunday[0], 2, 'midnight Sunday has Hasnain and Nadir');
  // Friday 6 PM to 9 PM is Ezan alone.
  for (const hour of [18, 19, 20]) {
    const on = onDutyAt('Fri', hour);
    assert.deepEqual(on.map((p) => p.name), ['Ezan'], `Fri ${hour}:00`);
  }
});

test('Sunday is off for the three who rest on Sunday', () => {
  for (let hour = 0; hour < 24; hour++) {
    const names = onDutyAt('Sun', hour).map((p) => p.name);
    for (const resting of ['Amrah', 'Zaheen']) {
      assert.ok(!names.includes(resting), `${resting} works Sun ${hour}:00`);
    }
  }
  // Hasnain rests Sunday too, but his Saturday night runs to 1 AM Sunday.
  assert.ok(onDutyAt('Sun', 0).some((p) => p.name === 'Hasnain'));
  for (let hour = 1; hour < 24; hour++) {
    assert.ok(!onDutyAt('Sun', hour).some((p) => p.name === 'Hasnain'), `Sun ${hour}:00`);
  }
});

test('weekly hours match what each person agreed to', () => {
  const stated = { Amrah: 51, Zaheen: 54, Hasnain: 52, Nadir: 72, Ezan: 84 };
  for (const person of ROSTER) {
    let worked = 0;
    for (const [, [start, end]] of Object.entries(person.shifts)) {
      worked += end <= start ? 24 - start + end : end - start;
    }
    assert.equal(worked, stated[person.name], `${person.name} weekly hours`);
    assert.equal(worked, person.hours, `${person.name} declared hours match the shifts`);
  }
  const total = ROSTER.reduce((n, p) => n + p.hours, 0);
  assert.equal(total, 313, 'roster total, section 01');
});

test('the next handover wraps past midnight instead of going backwards', () => {
  // At 11 PM the next change is 1 AM, two hours away. A naive subtraction
  // makes that -22 and picks a handover that already happened.
  const at23 = nextHandover('Mon', 23, 0);
  assert.equal(at23.hour, 1);
  assert.equal(at23.minutesAway, 120);

  const at1630 = nextHandover('Mon', 16, 30);
  assert.equal(at1630.hour, 17);
  assert.equal(at1630.minutesAway, 30);
});

test('the PKT clock is derived, not taken from the server timezone', () => {
  // 2026-08-05T02:13:00Z is 07:13 PKT, the hour the daily engine runs.
  const at = pktNow(new Date('2026-08-05T02:13:00Z'));
  assert.equal(at.hour, 7);
  assert.equal(at.minute, 13);
  assert.equal(at.label, '07:13 PKT');
  assert.equal(at.day, 'Wed');

  // 21:30 UTC is 02:30 PKT the NEXT day. The date rolls, and a shift lookup
  // that used the UTC day here would ask the wrong row entirely.
  const rolled = pktNow(new Date('2026-08-05T21:30:00Z'));
  assert.equal(rolled.hour, 2);
  assert.equal(rolled.day, 'Thu');
});

test('deskNow names who is on and says when only one person is', () => {
  // 21:30 UTC Wednesday is 02:30 PKT Thursday: Nadir, on his own.
  const desk = deskNow(new Date('2026-08-05T21:30:00Z'));
  assert.deepEqual(desk.names, ['Nadir']);
  assert.equal(desk.alone, true);
  assert.equal(desk.uncovered, false);
  assert.equal(desk.depth, 1);
  assert.equal(desk.next.hour, 9);
});

test('clock reads as a person would say it', () => {
  assert.equal(clock(0), '12 AM');
  assert.equal(clock(9), '9 AM');
  assert.equal(clock(12), '12 PM');
  assert.equal(clock(17), '5 PM');
  assert.equal(clock(23), '11 PM');
});
