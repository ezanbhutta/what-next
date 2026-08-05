// lib/duedates.js, what we promised, as distinct from how old it is.
//
// THE DISTINCTION THIS MODULE EXISTS TO PROTECT
//
// The order sheet carries an order date and a delivered date. It does not
// carry the date we told the buyer the work would land. So the only thing the
// engine can compute is AGE, and age is not lateness:
//
//   an order with an agreed 90-day scope is NOT late on day 61
//   an order promised in 5 days IS late on day 6, at an age of 6
//
// The system used to call the first one stale and say nothing about the
// second. Every triage decision, the dispute read and the review gate rested
// on that gap.
//
// THREE STATES, AND THE THIRD IS NOT THE SECOND
//
//   LATE        a due date exists and it has passed
//   ON TIME     a due date exists and it has not passed, at any age
//   UNKNOWN     no due date. NOT "on time", NOT "late".
//
// The third state is the one that has to survive contact with a UI. An order
// with no promised date is not evidence of anything; it is an order nobody
// has recorded a promise for. It renders as MISSING and it is never counted
// into a late total, because a late count that quietly includes "we do not
// know" is the number somebody takes to a buyer.
//
// AGE STILL MATTERS, SEPARATELY
//
// An order open 272 days with no due date is not provably late, and it is
// still the most recoverable money in the book. `band` (the engine's age
// banding) and `lateness` (this module's) are two different facts and both
// are reported. Neither is derived from the other.

import { query, run } from './db.js';

/** Lowercase, strip everything that is not a letter or digit. */
function squash(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** The ISO date part of a value, or '' if it does not carry one. */
function isoDay(value) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(value ?? ''));
  return m ? m[1] : '';
}

/**
 * The join key for an order row.
 *
 * Buyer, project and order date. Measured across all 1,073 orders in the book
 * this is unique with zero collisions. It is derived from the sheet rather
 * than assigned by us because the sheet has no order number and we do not
 * write to the sheet, so there is nowhere to put one.
 *
 * Returns null when there is not enough to identify a row. A key built from a
 * blank buyer would collide with every other blank buyer, which is how one
 * person's promised date ends up displayed on somebody else's order.
 */
export function orderKey(row) {
  const buyer = squash(row?.client ?? row?.buyer);
  if (!buyer) return null;
  return [buyer, squash(row?.project), isoDay(row?.order_date)].join('|');
}

/** Whole days from `a` to `b`, both ISO dates. Negative when b is before a. */
function daysBetween(a, b) {
  const pa = isoDay(a);
  const pb = isoDay(b);
  if (!pa || !pb) return null;
  return Math.round((Date.parse(pb + 'T00:00:00Z') - Date.parse(pa + 'T00:00:00Z')) / 86_400_000);
}

/**
 * Classify one order against its promise.
 *
 * `due` is the stored due date or null/undefined. `asOf` is the run's own
 * as-of date, NOT the wall clock: the page must agree with the run it is
 * rendering, or an order flips to late at midnight while every figure around
 * it still describes yesterday.
 */
export function lateness(due, asOf) {
  const promised = isoDay(due);
  if (!promised) {
    return {
      state: 'unknown',
      known: false,
      late: false, // never true without evidence
      due: null,
      days: null,
      label: 'No promised date',
    };
  }
  const days = daysBetween(promised, asOf);
  if (days === null) {
    return { state: 'unknown', known: false, late: false, due: promised, days: null, label: 'No promised date' };
  }
  if (days > 0) {
    return {
      state: 'late',
      known: true,
      late: true,
      due: promised,
      days,
      label: days === 1 ? '1 day past the promised date' : `${days} days past the promised date`,
    };
  }
  return {
    state: 'on_time',
    known: true,
    late: false,
    due: promised,
    days,
    label: days === 0 ? 'Due today' : `Due in ${Math.abs(days)} day${days === -1 ? '' : 's'}`,
  };
}

// --------------------------------------------------------------- storage

/**
 * Every promised date, as a Map keyed by `order_key`.
 *
 * Returns null, not an empty Map, when the table cannot be read. Those are
 * different facts: an empty Map means nobody has recorded a promise, and null
 * means we cannot tell whether they have. A caller that treats the second as
 * the first prints "no promised date" over a database outage.
 */
export async function loadDueDates() {
  try {
    const rows = await query(
      'SELECT order_key, buyer, project, order_date, due_date, note, set_by, set_at FROM order_due'
    );
    const byKey = new Map();
    for (const r of rows) byKey.set(String(r.order_key), r);
    return byKey;
  } catch {
    return null;
  }
}

/** Record or change one promised date. Returns what happened. */
export async function setDueDate({ row, dueDate, note = null, setBy = null }) {
  const key = orderKey(row);
  if (!key) throw new Error('this order cannot be identified, so a date cannot be attached to it');
  const due = isoDay(dueDate);
  if (!due) throw new Error('a promised date must be a real date');

  await run(
    'INSERT INTO order_due (order_key, buyer, project, order_date, due_date, note, set_by) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?) ' +
      'ON DUPLICATE KEY UPDATE due_date = VALUES(due_date), note = VALUES(note), set_by = VALUES(set_by)',
    [
      key,
      String(row.client ?? row.buyer ?? '').slice(0, 120),
      row.project ? String(row.project).slice(0, 200) : null,
      isoDay(row.order_date) || null,
      due,
      note ? String(note).slice(0, 2000) : null,
      setBy ? String(setBy).slice(0, 80) : null,
    ]
  );
  return { key, due };
}

/** Remove a promised date. Used when one was typed against the wrong order. */
export async function clearDueDate(row) {
  const key = orderKey(row);
  if (!key) return { key: null, cleared: 0 };
  const res = await run('DELETE FROM order_due WHERE order_key = ?', [key]);
  return { key, cleared: res.affectedRows || 0 };
}

/**
 * Attach lateness to a list of order rows.
 *
 * `dueByKey` is the Map from `loadDueDates`, or null when the table could not
 * be read. On null every row comes back `unknown` AND the summary says the
 * store was unreadable, so a page can tell "nobody promised anything" apart
 * from "we could not look".
 */
export function applyDueDates(rows, dueByKey, asOf) {
  const known = dueByKey !== null && dueByKey !== undefined;
  const out = (rows || []).map((row) => {
    const key = orderKey(row);
    const rec = known && key ? dueByKey.get(key) : null;
    return { ...row, order_key: key, due: lateness(rec?.due_date, asOf), due_note: rec?.note ?? null, due_set_by: rec?.set_by ?? null };
  });

  return {
    rows: out,
    store_readable: known,
    late: out.filter((r) => r.due.late),
    on_time: out.filter((r) => r.due.state === 'on_time'),
    unpromised: out.filter((r) => !r.due.known),
  };
}

/**
 * Orphans: promises whose order is no longer in the book under that key.
 *
 * A renamed project in the sheet changes the key and silently detaches the
 * date. Reporting the orphan is what makes that recoverable, because the row
 * still carries the buyer, project and order date it was typed against.
 */
export function orphanedPromises(dueByKey, rows) {
  if (!dueByKey) return [];
  const live = new Set((rows || []).map(orderKey).filter(Boolean));
  return [...dueByKey.values()].filter((r) => !live.has(String(r.order_key)));
}

export default {
  orderKey,
  lateness,
  loadDueDates,
  setDueDate,
  clearDueDate,
  applyDueDates,
  orphanedPromises,
};
