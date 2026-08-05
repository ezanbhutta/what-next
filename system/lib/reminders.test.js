// lib/reminders.test.js, run with `node --test`
//
// One block per rule in REMINDER-LOGICS.md, numbered the same way, asserting
// the three things the spec actually promises for each: that it books at the
// right offset, that the right buttons appear, and, where the rule says so, 
// that it chains, clears itself, or books nothing at all.
//
// The offsets are the spec's, not the code's. If one of these fails because a
// delay moved, the delay moved: the document is authoritative and the number
// here is copied from it. Never edit an expectation to make a run go green.
//
// Everything is a pure function with the clock passed in, so there are no
// fake timers, no database and no sleeps in this file.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  RULES,
  RULE_KEYS,
  RULE_NUMBERS,
  REVIEW_ASK_RULE_KEYS,
  canHoldReviewAsk,
  ACTIVITY_KIND_KEYS,
  SNOOZE_MINUTES,
  UNDO_WINDOW_MS,
  AUTO_CLEARED,
  ORDER_TYPES,
  ReminderError,
  rulesFor,
  rulesForKind,
  alreadyBooked,
  due,
  isDue,
  partitionDue,
  scheduled,
  buttonsFor,
  isAlert,
  canSnooze,
  snooze,
  resolve,
  autoClears,
  recheck,
  applyUndo,
  undoable,
  parseAt,
  toSqlUtc,
  parseRemindIn,
  ratingAverage,
} from './reminders.js';

// ------------------------------------------------------------------- setup

const T0 = Date.parse('2026-08-05T09:00:00Z'); // a fixed, boring Wednesday morning
const MIN = 60_000;
const HOUR = 60 * MIN;

/** An activity as server.js will hand it over. */
const act = (kind, extra = {}) => ({
  id: extra.id ?? 1,
  report_id: 7,
  profile: 'X Studioz',
  kind,
  client: 'thisguy07',
  order_ref: null,
  detail: {},
  at: T0,
  author: 'Tanzeel',
  ...extra,
});

/** Minutes between the log and when the reminder is due. */
const offsetMinutes = (reminder, from = T0) => (parseAt(reminder.due_at) - from) / MIN;

const keysOf = (reminder) => buttonsFor(reminder).map((b) => b.key);

/** One booked reminder, or a failed assertion naming what came back instead. */
function only(drafts, ruleKey) {
  const hit = drafts.filter((d) => d.rule_key === ruleKey);
  assert.equal(hit.length, 1, `expected exactly one ${ruleKey}, got ${JSON.stringify(drafts.map((d) => d.rule_key))}`);
  return hit[0];
}

// =========================================================== the catalogue

test('the thirteen rules are all present, numbered 1 to 13', () => {
  assert.deepEqual(RULE_NUMBERS, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  // Rule 9 is a three-stage chain and rule 10 has two entry points, so there
  // are more keys than numbers, but every key carries a number in range.
  for (const key of RULE_KEYS) {
    const n = RULES[key].rule;
    assert.ok(Number.isInteger(n) && n >= 1 && n <= 13, `${key} has rule ${n}`);
  }
});

test('every rule books for the profile and every button set is non-empty', () => {
  for (const key of RULE_KEYS) {
    const def = RULES[key];
    assert.ok(def.buttons.length >= 1, `${key} has no buttons`);
    assert.ok(typeof def.heading === 'function', `${key} has no heading`);
    assert.ok(ACTIVITY_KIND_KEYS.includes(def.on), `${key} triggers on unknown kind ${def.on}`);
  }
});

test('the activity catalogue matches the kind ENUM in db/schema.sql', () => {
  // A kind that exists in one and not the other books no reminder at all, and
  // that failure is invisible: the entry saves and the follow-up never comes.
  const sql = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
  // Anchored on the table: client_note also has a `kind ENUM(...)`, and an
  // unanchored match silently compared this catalogue against ('note','sent','flag').
  const table = /CREATE TABLE IF NOT EXISTS activity \(([\s\S]*?)\n\) ENGINE/.exec(sql);
  assert.ok(table, 'no activity table found in db/schema.sql');
  const enumBody = /kind\s+ENUM\(([\s\S]*?)\)\s+NOT NULL/.exec(table[1]);
  assert.ok(enumBody, 'no activity.kind ENUM found in db/schema.sql');
  const inSql = [...enumBody[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...inSql].sort(), [...ACTIVITY_KIND_KEYS].sort());
});

test('no output names the retired volume programme', () => {
  const banned = /vvro|inorganic/i;
  assert.deepEqual(ORDER_TYPES, ['Organic', 'Directed']);
  const surface = JSON.stringify({
    keys: RULE_KEYS,
    kinds: ACTIVITY_KIND_KEYS,
    buttons: RULE_KEYS.map((k) => RULES[k].buttons),
  });
  assert.ok(!banned.test(surface), 'a rule key, kind or button label names the retired programme');
  // And the headings, which are the strings a CSR actually reads.
  for (const kind of ACTIVITY_KIND_KEYS) {
    for (const def of rulesForKind(kind)) {
      if (kind === 'custom_reminder') continue; // owner-typed; asserted separately
      const a = act(kind, {
        detail: { attempt: '1st', order_via: 'Direct Order', value_rating: 5, quality_rating: 5, communication_rating: 5 },
      });
      assert.ok(!banned.test(def.heading(a)), `${def.rule} heading names the retired programme`);
    }
  }
});

// ================================================================== rule 1

test('rule 1 · new inquiry books the 1st follow-up 25 minutes later', () => {
  const drafts = rulesFor(act('inquiry', { detail: { agenda: 'logo + brand kit' } }), { now: T0 });
  const r = only(drafts, 'inquiry_followup');

  assert.equal(r.rule, 1);
  assert.equal(offsetMinutes(r), 25);
  assert.equal(r.profile, 'X Studioz');
  assert.equal(r.heading, 'Send the 1st follow-up to thisguy07');
  assert.deepEqual(keysOf(r), ['in_discussion', 'followed_up', 'order_taken', 'snooze']);
});

test('rule 1 · auto-clears when that buyer places an order', () => {
  const [booked] = rulesFor(act('inquiry'), { now: T0 });
  const cleared = autoClears(act('new_order', { id: 2 }), [booked], { now: T0 + 10 * MIN, by: 'Iqra' });

  assert.equal(cleared.length, 1);
  assert.equal(cleared[0].reminder.state, 'resolved');
  assert.equal(cleared[0].reminder.resolution, AUTO_CLEARED);
});

test('rule 1 · a different buyer ordering clears nothing', () => {
  const [booked] = rulesFor(act('inquiry'), { now: T0 });
  assert.deepEqual(autoClears(act('new_order', { id: 2, client: 'someone_else' }), [booked], { now: T0 }), []);
});

// ================================================================== rule 2

test('rule 2 · the lead chain books 12h / 24h / 48h and stops at the 4th', () => {
  const cases = [
    ['1st', 12 * 60, 'Send the 2nd follow-up to thisguy07'],
    ['2nd', 24 * 60, 'Send the 3rd follow-up to thisguy07'],
    ['3rd', 48 * 60, 'Send the 4th & last follow-up to thisguy07'],
  ];
  for (const [attempt, minutes, heading] of cases) {
    const r = only(rulesFor(act('lead_followup', { detail: { attempt } }), { now: T0 }), 'lead_followup_next');
    assert.equal(r.rule, 2);
    assert.equal(offsetMinutes(r), minutes, `${attempt} should book ${minutes} minutes out`);
    assert.equal(r.heading, heading);
    assert.deepEqual(keysOf(r), ['in_discussion', 'followed_up', 'order_taken', 'snooze']);
  }
  assert.deepEqual(rulesFor(act('lead_followup', { detail: { attempt: '4th+' } }), { now: T0 }), []);
});

// ================================================================== rule 3

test('rule 3 · a new order books the assign nudge 30 minutes later', () => {
  const r = only(rulesFor(act('new_order', { order_ref: 'Aurora rebrand', detail: { order_via: 'Via Chat' } }), { now: T0 }), 'order_assign');

  assert.equal(r.rule, 3);
  assert.equal(offsetMinutes(r), 30);
  assert.equal(r.heading, "Assign thisguy07's order to a designer");
  assert.deepEqual(keysOf(r), ['next_shift', 'assigned', 'snooze']);
});

test('rule 3 · "Next shift" snoozes 8 hours instead of closing it', () => {
  const [r] = rulesFor(act('new_order', { detail: { order_via: 'Via Chat' } }), { now: T0 });
  const out = resolve(r, 'next_shift', { now: T0 + 30 * MIN, by: 'Hadi' });

  assert.equal(out.reminder.state, 'snoozed', 'the order still is not assigned, it must come back');
  assert.equal(parseAt(out.reminder.snoozed_until) - (T0 + 30 * MIN), 8 * HOUR);
  assert.equal(isDue(out.reminder, T0 + 30 * MIN), false);
  assert.equal(isDue(out.reminder, T0 + 9 * HOUR), true);
});

test('rule 3 · auto-clears when THAT project is assigned, matched on the project', () => {
  const [r] = rulesFor(act('new_order', { order_ref: 'Aurora rebrand', detail: { order_via: 'Via Chat' } }), { now: T0 });

  const wrongProject = act('order_assigned', { id: 2, client: null, order_ref: 'Other job' });
  assert.deepEqual(autoClears(wrongProject, [r], { now: T0 }), []);

  const right = act('order_assigned', { id: 3, client: null, order_ref: 'Aurora rebrand' });
  const cleared = autoClears(right, [r], { now: T0 + MIN });
  assert.equal(cleared.length, 1);
  assert.equal(cleared[0].reminder.resolution, AUTO_CLEARED);
});

// ================================================================== rule 4

test('rule 4 · a Direct Order books the upsell immediately, Via Chat books nothing', () => {
  const direct = rulesFor(act('new_order', { detail: { order_via: 'Direct Order', service: ['Logo Design'] } }), { now: T0 });
  assert.deepEqual(direct.map((d) => d.rule).sort(), [3, 4], 'a Direct Order books both #3 and #4');

  const r = only(direct, 'order_upsell');
  assert.equal(offsetMinutes(r), 0, '"immediate" is zero minutes, not now-ish');
  assert.equal(r.heading, "Potential upsell for thisguy07, what's missing? Especially a Website");
  assert.deepEqual(keysOf(r), ['no_need', 'upsell_done', 'snooze']);
  assert.equal(isDue(r, T0), true, 'it must show on the page that just booked it');

  const chat = rulesFor(act('new_order', { detail: { order_via: 'Via Chat' } }), { now: T0 });
  assert.deepEqual(chat.map((d) => d.rule), [3], 'a Via Chat order books only #3');
});

test('rule 4 · auto-clears when an upsell for that buyer is logged', () => {
  const drafts = rulesFor(act('new_order', { detail: { order_via: 'Direct Order' } }), { now: T0 });
  const cleared = autoClears(act('upsell', { id: 2 }), drafts, { now: T0 + HOUR });
  assert.deepEqual(cleared.map((c) => c.rule_key), ['order_upsell'], 'the assign nudge is untouched');
});

// ================================================================== rule 5

test('rule 5 · a completed order books the public-review ask 30 minutes later', () => {
  const r = only(rulesFor(act('order_completed', { order_ref: 'Aurora rebrand' }), { now: T0 }), 'completed_public_review');

  assert.equal(r.rule, 5);
  assert.equal(offsetMinutes(r), 30);
  assert.equal(r.heading, 'Ask thisguy07 for a Public Review');
  assert.deepEqual(keysOf(r), ['no_need', 'msg_sent', 'review_given', 'snooze']);
});

test('rule 5 · books NOTHING for an order flagged late or disputed', () => {
  // House rule: a review ask on a late delivery is the most reliable way to
  // turn a private 3-star into a public one. This is a suppression, not a delay.
  const a = act('order_completed');
  assert.deepEqual(rulesFor(a, { now: T0, flags: { late: true } }), []);
  assert.deepEqual(rulesFor(a, { now: T0, flags: { disputed: true } }), []);
  assert.deepEqual(rulesFor(a, { now: T0, flags: { frustrated: true } }), []);
  assert.deepEqual(rulesFor(act('order_completed', { detail: { late: true } }), { now: T0 }), []);

  // …and still books on a clean one, so the guard cannot be passing by accident.
  assert.equal(rulesFor(a, { now: T0, flags: {} }).length, 1);
});

test('rule 5 · auto-clears when the review already landed', () => {
  const [r] = rulesFor(act('order_completed'), { now: T0 });
  const cleared = autoClears(act('review_received', { id: 2 }), [r], { now: T0 + 20 * MIN });
  assert.equal(cleared.length, 1, 'no point asking, they already left one');
});

// ================================================================== rule 6

test('rule 6 · a 4.7-5.0 average books the private-review ask exactly 24h later', () => {
  const top = act('review_received', {
    order_ref: 'Aurora rebrand',
    detail: { value_rating: 5, quality_rating: 5, communication_rating: 5 },
  });
  const r = only(rulesFor(top, { now: T0 }), 'review_private_ask');

  assert.equal(r.rule, 6);
  assert.equal(offsetMinutes(r), 24 * 60);
  assert.equal(r.heading, 'Ask thisguy07 for a Private Review');
  assert.deepEqual(keysOf(r), ['msg_sent', 'snooze']);
});

test('rule 6 · the average is rounded to one decimal before the 4.7 test', () => {
  // 5 + 5 + 4 is 4.666…, and 4.7 is what the CSR and the CEO see. A rule
  // reading the unrounded number would refuse a review that qualifies on screen.
  assert.equal(ratingAverage({ value_rating: 5, quality_rating: 5, communication_rating: 4 }), 4.7);
  const borderline = act('review_received', { detail: { value_rating: 5, quality_rating: 5, communication_rating: 4 } });
  assert.equal(rulesFor(borderline, { now: T0 }).length, 1);
});

test('rule 6 · anything below 4.7 books nothing', () => {
  const low = act('review_received', { detail: { value_rating: 4, quality_rating: 4, communication_rating: 5 } });
  assert.equal(ratingAverage(low.detail), 4.3);
  assert.deepEqual(rulesFor(low, { now: T0 }), []);

  const unrated = act('review_received', { detail: {} });
  assert.deepEqual(rulesFor(unrated, { now: T0 }), [], 'no stars means no claim about the rating');
});

// ================================================================== rule 7

test('rule 7 · files assigned books the upsell suggestion immediately', () => {
  const a = act('files_assigned', { order_ref: 'Aurora rebrand', detail: { designer: 'Khubaib' } });
  const r = only(rulesFor(a, { now: T0 }), 'files_upsell');

  assert.equal(r.rule, 7);
  assert.equal(offsetMinutes(r), 0);
  assert.equal(r.heading, 'Suggest an upsell to thisguy07');
  assert.deepEqual(keysOf(r), ['no_need', 'upsell_done', 'snooze']);

  const cleared = autoClears(act('upsell', { id: 9 }), [r], { now: T0 + HOUR });
  assert.equal(cleared.length, 1);
});

// ================================================================== rule 8

test('rule 8 · the revision check uses the typed time, blank means 24 hours', () => {
  const at = (remind_in) =>
    only(rulesFor(act('revision_assigned', { detail: { remind_in, designer: 'Hamid' } }), { now: T0 }), 'revision_check');

  assert.equal(offsetMinutes(at('30m')), 30);
  assert.equal(offsetMinutes(at('2h')), 120);
  assert.equal(offsetMinutes(at('5 H')), 300);
  assert.equal(offsetMinutes(at('1.5h')), 90);
  assert.equal(offsetMinutes(at('')), 24 * 60, 'blank defaults to 24h');
  assert.equal(offsetMinutes(at(undefined)), 24 * 60);
  assert.equal(offsetMinutes(at('nonsense')), 24 * 60);

  const r = at('30m');
  assert.equal(r.rule, 8);
  assert.equal(r.heading, "Check if thisguy07's revision is done");
  assert.deepEqual(keysOf(r), ['followup_done', 'revision_done', 'snooze']);
});

test('rule 8 · always books, there is no condition on it', () => {
  assert.equal(rulesFor(act('revision_assigned', { client: null, detail: {} }), { now: T0 }).length, 1);
});

// ================================================================== rule 9

test('rule 9 · an offer books the 1st follow-up 2 hours out', () => {
  const r = only(rulesFor(act('offer', { detail: { scope: 'full identity', value: '$450' } }), { now: T0 }), 'offer_fu1');

  assert.equal(r.rule, 9);
  assert.equal(r.chain_step, 1);
  assert.equal(offsetMinutes(r), 120);
  assert.equal(r.heading, 'Send the 1st follow-up on the offer to thisguy07');
  assert.deepEqual(keysOf(r), ['order_placed', 'fu1_done', 'snooze']);
});

test('rule 9 · the chain advances 16h then 36h, timed from the tap', () => {
  const [fu1] = rulesFor(act('offer', { detail: { scope: 'full identity' } }), { now: T0 });

  // Tapped late, the next stage counts from the click, not from the offer.
  const tap1 = T0 + 5 * HOUR;
  const step2 = resolve(fu1, 'fu1_done', { now: tap1, by: 'Tayyab' });
  assert.equal(step2.reminder.state, 'resolved');
  assert.equal(step2.reminder.resolution, 'fu1_done');
  assert.ok(step2.booked, 'tapping "1st F/U done" books the 2nd stage');
  assert.equal(step2.booked.rule_key, 'offer_fu2');
  assert.equal(step2.booked.rule, 9);
  assert.equal(step2.booked.chain_step, 2);
  assert.equal(offsetMinutes(step2.booked, tap1), 16 * 60);
  assert.equal(step2.booked.heading, 'Send the 2nd follow-up on the offer to thisguy07');
  assert.deepEqual(keysOf(step2.booked), ['order_placed', 'fu2_done', 'snooze']);

  const tap2 = tap1 + 20 * HOUR;
  const step3 = resolve(step2.booked, 'fu2_done', { now: tap2, by: 'Tayyab' });
  assert.equal(step3.booked.rule_key, 'offer_fu3');
  assert.equal(step3.booked.chain_step, 3);
  assert.equal(offsetMinutes(step3.booked, tap2), 36 * 60);
  assert.deepEqual(keysOf(step3.booked), ['order_placed', 'fu3_done', 'snooze']);

  // Stage 3 is the end of the chain: its buttons book nothing further.
  const end = resolve(step3.booked, 'fu3_done', { now: tap2 + 40 * HOUR, by: 'Tayyab' });
  assert.equal(end.booked, null, 'the chain ends at the 3rd follow-up');
  assert.equal(end.reminder.state, 'resolved');
});

test('rule 9 · "Order placed" ends the chain at any stage', () => {
  const [fu1] = rulesFor(act('offer'), { now: T0 });
  const out = resolve(fu1, 'order_placed', { now: T0 + 3 * HOUR, by: 'Salman' });
  assert.equal(out.booked, null);
  assert.equal(out.reminder.resolution, 'order_placed');
});

test('rule 9 · logging the order clears whichever stage is pending', () => {
  const [fu1] = rulesFor(act('offer'), { now: T0 });
  const { booked: fu2 } = resolve(fu1, 'fu1_done', { now: T0 + 2 * HOUR });
  const cleared = autoClears(act('new_order', { id: 2 }), [fu2], { now: T0 + 3 * HOUR, by: 'Ezan' });
  assert.deepEqual(cleared.map((c) => c.rule_key), ['offer_fu2']);
});

test('rule 9 · chain stages are never booked by logging an offer', () => {
  const drafts = rulesFor(act('offer'), { now: T0 });
  assert.deepEqual(drafts.map((d) => d.rule_key), ['offer_fu1'], 'only a button books stage 2 and 3');
});

// ================================================================= rule 10

test('rule 10 · a delivery and a chat share both book a 15h follow-up', () => {
  const delivered = act('project_delivered', { order_ref: 'Aurora rebrand', detail: { stage: 'Final files' } });
  const d = only(rulesFor(delivered, { now: T0 }), 'delivery_followup');
  assert.equal(d.rule, 10);
  assert.equal(offsetMinutes(d), 15 * 60);
  assert.equal(d.heading, 'Follow up on the final files delivered to thisguy07');
  assert.deepEqual(keysOf(d), ['responded', 'followed_up', 'snooze']);

  const shared = act('shared', { order_ref: 'Aurora rebrand', detail: { elements: ['Initial draft', 'Stationery'] } });
  const s = only(rulesFor(shared, { now: T0 }), 'shared_followup');
  assert.equal(s.rule, 10);
  assert.equal(offsetMinutes(s), 15 * 60);
  assert.equal(s.heading, 'Follow up on the initial draft, stationery shared with thisguy07');
  assert.deepEqual(keysOf(s), ['responded', 'followed_up', 'snooze']);
});

test('rule 10 · a revision clears it only when buyer AND project both match', () => {
  const [d] = rulesFor(act('project_delivered', { order_ref: 'Aurora rebrand', detail: { stage: 'Final files' } }), { now: T0 });

  const noProject = act('revision_assigned', { id: 2, order_ref: null });
  assert.deepEqual(autoClears(noProject, [d], { now: T0 }), [], 'cannot confirm it is the same item');

  const otherProject = act('revision_assigned', { id: 3, order_ref: 'Something else' });
  assert.deepEqual(autoClears(otherProject, [d], { now: T0 }), []);

  const otherBuyer = act('revision_assigned', { id: 4, client: 'someone_else', order_ref: 'Aurora rebrand' });
  assert.deepEqual(autoClears(otherBuyer, [d], { now: T0 }), []);

  const match = act('revision_assigned', { id: 5, order_ref: 'Aurora rebrand' });
  assert.equal(autoClears(match, [d], { now: T0 + HOUR }).length, 1);
});

// ============================================================= rules 11+12

test('rule 11 · a frustrated client raises a red box immediately', () => {
  const a = act('frustrated', { detail: { what: 'third revision, no reply for two days' } });
  const r = only(rulesFor(a, { now: T0 }), 'frustrated_alert');

  assert.equal(r.rule, 11);
  assert.equal(r.alert, 1);
  assert.equal(offsetMinutes(r), 0);
  assert.equal(r.heading, 'thisguy07 is frustrated, handle with caution');
  assert.deepEqual(keysOf(r), ['solved'], 'no snooze on a red alert');
  assert.equal(isDue(r, T0), true);
});

test('rule 12 · a disputed client raises a red box immediately', () => {
  const a = act('disputed', { detail: { reason: 'wants a refund on the logo' } });
  const r = only(rulesFor(a, { now: T0 }), 'disputed_alert');

  assert.equal(r.rule, 12);
  assert.equal(r.alert, 1);
  assert.equal(offsetMinutes(r), 0);
  assert.equal(r.heading, "thisguy07's dispute is OPEN, on the verge of cancelling, treat cautiously");
  assert.deepEqual(keysOf(r), ['solved']);
});

test('rules 11+12 · red alerts cannot be snoozed, only Solved clears them', () => {
  for (const kind of ['frustrated', 'disputed']) {
    const [r] = rulesFor(act(kind, { detail: { what: 'x', reason: 'x' } }), { now: T0 });

    assert.equal(isAlert(r), true);
    assert.equal(canSnooze(r), false);
    assert.ok(!keysOf(r).includes('snooze'), 'no snooze button is offered');

    assert.throws(() => snooze(r, { now: T0 }), (e) => e instanceof ReminderError && e.code === 'SNOOZE_FORBIDDEN');
    assert.throws(() => resolve(r, 'snooze', { now: T0 }), (e) => e.code === 'UNKNOWN_BUTTON');

    const out = resolve(r, 'solved', { now: T0 + 2 * HOUR, by: 'Ezan' });
    assert.equal(out.reminder.state, 'resolved');
    assert.equal(out.reminder.resolution, 'solved');
    assert.equal(out.reminder.resolved_by, 'Ezan');
  }
});

test('rules 11+12 · a red alert persists across shifts until it is solved', () => {
  const [r] = rulesFor(act('frustrated', { detail: { what: 'x' } }), { now: T0 });
  const threeDaysLater = T0 + 3 * 24 * HOUR;
  assert.equal(isDue(r, threeDaysLater), true, 'reminders never expire on their own');
  assert.deepEqual(due([r], threeDaysLater).length, 1);
});

// ================================================================= rule 13

test('rule 13 · a custom reminder pops at the chosen date and time', () => {
  const when = T0 + 30 * HOUR;
  const a = act('custom_reminder', {
    client: null,
    detail: { heading: 'Chase the Aurora invoice', note: 'Ezan wants it before Friday', remind_at: new Date(when).toISOString() },
  });
  const r = only(rulesFor(a, { now: T0 }), 'custom');

  assert.equal(r.rule, 13);
  assert.equal(parseAt(r.due_at), when);
  assert.equal(r.heading, 'Chase the Aurora invoice');
  assert.equal(r.body, 'Ezan wants it before Friday');
  assert.deepEqual(keysOf(r), ['done', 'snooze']);
});

test('rule 13 · a missing heading or time books nothing and says so', () => {
  // Never guess a moment the CSR did not choose: they believe it is set for
  // Tuesday morning, and a quiet 12-hour default is not.
  const noTime = act('custom_reminder', { detail: { heading: 'Chase the invoice' } });
  assert.throws(() => rulesFor(noTime, { now: T0 }), (e) => e.code === 'MISSING_REMIND_AT');

  const noHeading = act('custom_reminder', { detail: { remind_at: new Date(T0 + HOUR).toISOString() } });
  assert.throws(() => rulesFor(noHeading, { now: T0 }), (e) => e.code === 'MISSING_HEADING');
});

// ================================================== what books nothing

test('spam / not relevant books nothing', () => {
  assert.deepEqual(rulesFor(act('spam', { detail: { reason: 'crypto pitch' } }), { now: T0 }), []);
  assert.deepEqual(rulesForKind('spam'), []);
});

test('the other logged-for-the-record activities book nothing', () => {
  const silent = [
    'client_conversation',
    'order_assigned',
    'followup_client',
    'followup_designer',
    'update_followup',
    'upsell',
    'review_request',
    'meeting',
    'extension',
    'spam',
  ];
  for (const kind of silent) {
    assert.deepEqual(rulesFor(act(kind, { detail: {} }), { now: T0 }), [], `${kind} should book nothing`);
  }
  // …and every other kind books at least one, so this list cannot rot silently.
  const booking = ACTIVITY_KIND_KEYS.filter((k) => !silent.includes(k));
  assert.deepEqual(booking.sort(), [
    'custom_reminder', 'files_assigned', 'frustrated', 'disputed', 'inquiry', 'lead_followup',
    'new_order', 'offer', 'order_completed', 'project_delivered', 'revision_assigned',
    'review_received', 'shared',
  ].sort());
});

// ================================================== the shared behaviours

test('one reminder per entry per rule; an auto-cleared one may come back', () => {
  const a = act('inquiry');
  const [first] = rulesFor(a, { now: T0 });
  const booked = { ...first, id: 100, activity_id: a.id };

  assert.deepEqual(rulesFor(a, { now: T0, existing: [booked] }), [], 'a second log books nothing');
  assert.equal(alreadyBooked([booked], a.id, 'inquiry_followup'), true);

  const humanResolved = { ...booked, state: 'resolved', resolution: 'followed_up' };
  assert.equal(alreadyBooked([humanResolved], a.id, 'inquiry_followup'), true, 'finished work must not be resurrected');

  const autoCleared = { ...booked, state: 'resolved', resolution: AUTO_CLEARED };
  assert.equal(alreadyBooked([autoCleared], a.id, 'inquiry_followup'), false, 'an edit may restore it');
});

test('editing an entry re-checks the rule: newly true books, newly false clears', () => {
  const chat = act('new_order', { detail: { order_via: 'Via Chat' } });
  const [assign] = rulesFor(chat, { now: T0 });
  const open = { ...assign, id: 200, activity_id: chat.id };

  // Corrected to a Direct Order → the upsell nudge appears.
  const direct = { ...chat, detail: { order_via: 'Direct Order' } };
  const grown = recheck(direct, [open], { now: T0 + 5 * MIN });
  assert.deepEqual(grown.book.map((d) => d.rule_key), ['order_upsell']);
  assert.deepEqual(grown.clear, []);

  // Corrected back → the upsell nudge clears, the assign nudge stays.
  const upsellOpen = { ...grown.book[0], id: 201, activity_id: chat.id };
  const shrunk = recheck(chat, [open, upsellOpen], { now: T0 + 10 * MIN, by: 'Iqra' });
  assert.deepEqual(shrunk.clear.map((c) => c.rule_key), ['order_upsell']);
  assert.equal(shrunk.clear[0].reminder.resolution, AUTO_CLEARED);
  assert.deepEqual(shrunk.book, []);
});

test('editing the buyer re-words the pending reminder', () => {
  const a = act('inquiry');
  const [booked] = rulesFor(a, { now: T0 });
  const open = { ...booked, id: 300, activity_id: a.id };

  const fixed = recheck({ ...a, client: 'nativ_shaibi' }, [open], { now: T0 + MIN });
  assert.equal(fixed.update.length, 1);
  assert.equal(fixed.update[0].heading, 'Send the 1st follow-up to nativ_shaibi');
  assert.equal(fixed.update[0].client_key, 'nativshaibi');
});

test('snooze is five minutes and the reminder comes back', () => {
  const [r] = rulesFor(act('inquiry'), { now: T0 });
  const at = T0 + 40 * MIN;
  assert.equal(isDue(r, at), true);

  const out = snooze(r, { now: at });
  assert.equal(SNOOZE_MINUTES, 5);
  assert.equal(parseAt(out.reminder.snoozed_until) - at, 5 * MIN);
  assert.equal(isDue(out.reminder, at + 4 * MIN), false);
  assert.equal(isDue(out.reminder, at + 5 * MIN), true, 'it comes back, it does not disappear');
});

test('every action is undoable for five seconds and final after', () => {
  const [r] = rulesFor(act('inquiry'), { now: T0 });
  const at = T0 + 40 * MIN;

  const done = resolve(r, 'followed_up', { now: at, by: 'Amrah' });
  assert.equal(undoable(done.undo, at + 4_999), true);
  assert.equal(applyUndo(done.undo, at + 4_000).reminder.state, 'pending', 'a mis-tap is never final');
  assert.equal(UNDO_WINDOW_MS, 5_000);
  assert.equal(undoable(done.undo, at + 5_001), false);
  assert.throws(() => applyUndo(done.undo, at + 5_001), (e) => e.code === 'UNDO_EXPIRED');

  // Undoing a chain advance also cancels the stage it booked.
  const [fu1] = rulesFor(act('offer'), { now: T0 });
  const chained = resolve(fu1, 'fu1_done', { now: at });
  const undone = applyUndo(chained.undo, at + 1_000);
  assert.equal(undone.reminder.state, 'pending');
  assert.deepEqual(undone.cancel.map((c) => c.rule_key), ['offer_fu2']);

  // Snoozing is undoable too.
  const zzz = snooze(r, { now: at });
  assert.equal(applyUndo(zzz.undo, at + 1_000).reminder.snoozed_until, null);
});

test('a resolved reminder cannot be resolved twice, and an unknown button is refused', () => {
  const [r] = rulesFor(act('inquiry'), { now: T0 });
  const done = resolve(r, 'followed_up', { now: T0 + HOUR }).reminder;
  assert.throws(() => resolve(done, 'followed_up', { now: T0 + 2 * HOUR }), (e) => e.code === 'ALREADY_RESOLVED');
  assert.throws(() => resolve(r, 'nope', { now: T0 }), (e) => e.code === 'UNKNOWN_BUTTON');
});

// ================================================== the queue and the clock

test('due() shows red alerts first, then the most overdue', () => {
  const alert = rulesFor(act('disputed', { id: 1, detail: { reason: 'refund' } }), { now: T0 + 3 * HOUR })[0];
  const early = rulesFor(act('inquiry', { id: 2, at: T0 }), { now: T0 })[0];
  const later = rulesFor(act('order_completed', { id: 3, at: T0 + HOUR }), { now: T0 })[0];
  const future = rulesFor(act('offer', { id: 4, at: T0 + 3 * HOUR }), { now: T0 })[0];

  const now = T0 + 4 * HOUR;
  assert.deepEqual(due([later, early, alert, future], now).map((r) => r.rule), [12, 1, 5]);
  assert.deepEqual(scheduled([later, early, alert, future], now).map((r) => r.rule), [9]);

  const split = partitionDue([later, early, alert, future], now);
  assert.deepEqual(split.alerts.map((r) => r.rule), [12]);
  assert.deepEqual(split.cards.map((r) => r.rule), [1, 5]);
});

test('a stored DATETIME is read as UTC, never as local time', () => {
  // 'YYYY-MM-DD HH:MM:SS' handed to `new Date()` is LOCAL, on a PKT box every
  // reminder would move five hours, and nothing about it would look wrong.
  assert.equal(parseAt('2026-08-05 09:00:00'), Date.parse('2026-08-05T09:00:00Z'));
  assert.equal(parseAt('2026-08-05T09:00:00Z'), Date.parse('2026-08-05T09:00:00Z'));
  assert.equal(parseAt(new Date(T0)), T0);
  assert.equal(parseAt(T0), T0);
  assert.equal(parseAt(null), null);
  assert.equal(parseAt('not a time'), null);
  assert.equal(toSqlUtc(T0), '2026-08-05 09:00:00');
  assert.equal(parseAt(toSqlUtc(T0)), T0, 'the round trip must not drift');
});

test('the delay is measured from when the entry was logged, not from now', () => {
  // A shift logged at 09:00 and saved at 09:07 must still be due at 09:25.
  const logged = act('inquiry', { at: T0 });
  const [r] = rulesFor(logged, { now: T0 + 7 * MIN });
  assert.equal(parseAt(r.due_at), T0 + 25 * MIN);
});

test('"remind me in" parsing accepts the documented forms and nothing else', () => {
  assert.equal(parseRemindIn('30m'), 30);
  assert.equal(parseRemindIn('45 m'), 45);
  assert.equal(parseRemindIn('2h'), 120);
  assert.equal(parseRemindIn('5 H'), 300);
  assert.equal(parseRemindIn('1.5h'), 90);
  assert.equal(parseRemindIn(''), null);
  assert.equal(parseRemindIn('0h'), null);
  assert.equal(parseRemindIn('soon'), null);
  assert.equal(parseRemindIn('30'), null);
});

test('a reminder without a profile is refused, it would be unroutable', () => {
  assert.throws(
    () => rulesFor(act('inquiry', { profile: '' }), { now: T0 }),
    (e) => e.code === 'NO_PROFILE'
  );
  assert.throws(() => rulesFor(act('nonsense_kind'), { now: T0 }), (e) => e.code === 'UNKNOWN_KIND');
});

test('a buyer with no username still books, and stores no invented name', () => {
  const [r] = rulesFor(act('inquiry', { client: null }), { now: T0 });
  assert.equal(r.client, null, 'no fabricated buyer is stored');
  assert.equal(r.client_key, null);
  assert.equal(r.heading, 'Send the 1st follow-up to the client');
});

test('"Close without asking" reaches the two review asks and nothing else', () => {
  // `held_no_ask` is house rule 5's escape hatch: it closes a review ask
  // WITHOUT sending it. It is deliberately not in any rule's button set, which
  // is exactly why it never passes through buttonsFor(), and buttonsFor() is
  // the check that stops a red alert being closed by anything but Solved.
  // Ungated it closed every rule, so an open dispute could be swept off the
  // profile and filed as a review somebody declined to ask for.
  assert.deepEqual([...REVIEW_ASK_RULE_KEYS], ['completed_public_review', 'review_private_ask']);

  assert.ok(canHoldReviewAsk({ rule_key: 'completed_public_review' }), 'rule 5 asks for a public review');
  assert.ok(canHoldReviewAsk({ rule_key: 'review_private_ask' }), 'rule 6 asks for a private review');

  for (const key of ['frustrated_alert', 'disputed_alert']) {
    assert.equal(canHoldReviewAsk({ rule_key: key }), false, `${key} is a red alert, only Solved clears it`);
  }
  for (const key of RULE_KEYS.filter((k) => !RULES[k].review)) {
    assert.equal(canHoldReviewAsk({ rule_key: key }), false, `${key} never asks for a review`);
  }
  assert.equal(canHoldReviewAsk({}), false);
  assert.equal(canHoldReviewAsk(null), false);
});

test('no rule lists held_no_ask as one of its own buttons', () => {
  // If a rule ever did, buttonsFor() would accept it and the gate above would
  // be answering a question that no longer exists.
  for (const key of RULE_KEYS) {
    const keys = buttonsFor({ rule_key: key }).map((b) => b.key);
    assert.ok(!keys.includes('held_no_ask'), `${key} must not carry held_no_ask`);
  }
});
