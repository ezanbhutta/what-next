// views/reports-ceo.js, the owner half of Reports: what the shifts produced.
//
// WHAT THIS VIEW IS
//
//   The CEO console of the shift logger, rebuilt inside the hub. Not a live
//   feed and not a leaderboard: a settled account of a window of days. Who
//   covered which profile on which shift, what they logged, what follow-ups
//   that logging booked, how many of those got closed, and, the number this
//   page leads with, how many are still open past the time they came due.
//
// WHY *THAT* NUMBER LEADS
//
//   Everything else here is throughput, and throughput is not the risk. A
//   reminder open past its due time is a buyer who was promised a follow-up by
//   the system and has not had one. It is the only figure on the page that
//   describes work owed to somebody outside the company, so it goes first and
//   the activity counts go under it.
//
// THE ORIGINAL'S TWO MEASUREMENT BUGS ARE NOT REPRODUCED
//
//   1. The CEO console ranked CSRs by raw counts with no denominator anywhere
//      near them, so a person who worked two shifts and a person who worked
//      eleven were listed as if the comparison meant something. Here every
//      rate carries its n, and under n<30 it is a RANGE with no bar, see R3
//      and `meter()` in layout.js, which refuses to draw one.
//   2. It counted an auto-cleared reminder as a reminder somebody cleared,
//      which flattered whoever happened to log the next activity. Auto-clears
//      are counted separately and never credited to a person.
//
// HOUSE RULES THIS FILE IS CARRYING
//
//   R2  A read that failed is MISSING. Zero shifts and an unreadable shift
//       table are different facts; the second never prints as the first, and
//       a blank checklist count prints MISSING rather than 0 because "ticked
//       but not counted" is not "none".
//   R3  Every proportion goes through `rate()`/`meter()`. A CSR with 9 logged
//       activities gets counts and an explicit "too few to rate", no
//       percentage, no bar, no arrow. This is enforced by the helpers, and
//       stated in prose next to the table so nobody reads the blank as a gap.
//   R4  The retired programme is never named. Order type is Organic or
//       Directed; `esc()` scrubs anything that reaches a renderer regardless.
//   R6  A review ask never rides on a late or disputed order. The CSR page
//       holds those asks and records the close as `held_no_ask`; this page
//       counts them, because a rule nobody can see working is a rule nobody
//       trusts.
//   R7  The figure leads. Every panel opens with its number; the reasoning is
//       in the `<details>` underneath.
//   R9  Tables scroll inside `.tablewrap`, never the body. Every control is a
//       `.btn` or a `.field`, all ≥44px on a coarse pointer.

import {
  RULES,
  ACTIVITY_KINDS,
  parseAt,
  AUTO_CLEARED,
} from '../lib/reminders.js';

// The wrap-up items, imported from the CSR page that writes them rather than
// restated here. The owner edits that list; a second copy would eventually
// print a shift as having skipped an item that was never on their screen.
import { CHECKLIST } from './reports.js';

import {
  html,
  join,
  safe,
  missing,
  num,
  meter,
  glyph,
  pill,
  panelHead,
  why,
  empty,
  dateShort,
  dateTimeShort,
  MIN_SAMPLE,
} from './layout.js';

// ============================================================================
// 1. CONSTANTS
// ============================================================================

/** The shifts, in the order a day runs. Must match views/reports.js SHIFTS and
 *  the ENUM in db/schema.sql, a name that is in one and not the others makes
 *  a shift's whole output vanish from this page without erroring. */
const SHIFT_ORDER = ['Morning', 'Evening', 'Night'];

const SHIFT_TIME = {
  Morning: '9am – 5pm',
  Evening: '5pm – 1am',
  Night: '1am – 9am',
};

/** The windows the owner actually asks for. `days` is inclusive of `date`. */
export const WINDOWS = [
  { key: '1', days: 1, label: 'That day' },
  { key: '7', days: 7, label: 'Last 7 days' },
  { key: '30', days: 30, label: 'Last 30 days' },
];

/** The activity catalogue, grouped the way the CSR page groups it, so the two
 *  halves of the section name and order the same things. */
const KIND_GROUPS = [
  { key: 'inquiries', label: 'Inquiries and leads' },
  { key: 'orders', label: 'Orders' },
  { key: 'revisions', label: 'Revisions' },
  { key: 'deliveries', label: 'Deliveries' },
  { key: 'followups', label: 'Follow-ups and offers' },
  { key: 'meetings', label: 'Meetings' },
  { key: 'problems', label: 'Problems' },
];

/** Resolutions that are not somebody clearing a reminder. Counted, never
 *  credited: `auto_cleared` is the system noticing the follow-up already
 *  happened, and `held_no_ask` is R6 refusing to send a review request. */
const NOT_A_CLEAR = new Set([AUTO_CLEARED, 'held_no_ask']);

// ============================================================================
// 2. TIME, IN THE TEAM'S CLOCK
// ============================================================================
//
// Every bucket on this page is a PAKISTAN calendar day. It has to be computed
// here rather than in SQL: `at` and `opened_at` are TIMESTAMPs, so what a
// `DATE()` in MySQL returns depends on the server's session time zone, and a
// box configured in UTC silently files the whole Night shift, which runs
// 1am–9am PKT, under the previous day. That is not a rounding error; it is an
// entire shift's work attributed to the wrong date and to nobody's day.

const PKT_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Karachi',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const PKT_CLOCK = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Karachi',
  hour: '2-digit',
  minute: '2-digit',
  hour12: true,
});

function pktDay(value) {
  const ms = parseAt(value);
  if (ms === null) return null;
  try {
    return PKT_DAY.format(new Date(ms));
  } catch {
    return null;
  }
}

function clockPKT(value) {
  const ms = parseAt(value);
  if (ms === null) return null;
  try {
    return PKT_CLOCK.format(new Date(ms)).toLowerCase().replace(/\s+/g, '');
  } catch {
    return null;
  }
}

/** How long something has been waiting, as words. Never negative, a reminder
 *  that is not yet due is not "waiting -3h", it is simply not on this list. */
function waited(dueValue, nowValue) {
  const a = parseAt(dueValue);
  const b = parseAt(nowValue);
  if (a === null || b === null) return null;
  const mins = Math.floor((b - a) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** ISO day arithmetic that never touches a Date, so it cannot drift a day at a
 *  DST boundary in whatever zone the container happens to be in. */
function addDays(iso, delta) {
  const [y, m, d] = String(iso).split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return iso;
  const t = Date.UTC(y, m - 1, d) + delta * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

// ============================================================================
// 3. SMALL HELPERS
// ============================================================================

/** A q() result → rows array, `null` on outage, `undefined` when not loaded.
 *  Three different facts; this page never collapses them into one. */
function rowsOf(result) {
  if (!result) return undefined;
  return result.ok ? result.rows || [] : null;
}

/** A count that knows whether it could be counted at all. */
const count = (rows, ok) => (ok ? num(rows) : missing());

/** Increment a key in a plain object used as a counter. */
function bump(map, key, by = 1) {
  if (key === null || key === undefined) return;
  map[key] = (map[key] || 0) + by;
}

/**
 * R3, as one function.
 *
 * Under MIN_SAMPLE, or wherever the Wilson interval is too wide to call, 
 * `meter()` renders the suppressed track: hatched, no fill, the interval as
 * the value. There is no argument and no flag that makes it draw a bar. The
 * word next to it is deliberate too: "9 logged" is a count and always true,
 * whereas "11.1%" on 1 of 9 is a number that reads like a finding.
 */
function shareCell(k, n, tone = '') {
  if (!Number.isFinite(n) || n <= 0) return html`<span class="caption">no denominator</span>`;
  return meter({ value: k, total: n, tone });
}

/** Is this reminder open, and was it due before `now`? Snooze does not make it
 *  not-owed, five minutes later it is back, so a snoozed reminder past its
 *  due time is still counted here, and said so in the panel's own words. */
function openPastDue(rem, nowMs) {
  if (!rem || rem.state === 'resolved') return false;
  const due = parseAt(rem.due_at);
  return due !== null && due <= nowMs;
}

function isSnoozedNow(rem, nowMs) {
  const until = parseAt(rem?.snoozed_until);
  return until !== null && until > nowMs;
}

/** A person cleared this one, as opposed to the system clearing it, or R6
 *  refusing to let it be sent. */
const clearedByAPerson = (rem) =>
  rem.state === 'resolved' && !NOT_A_CLEAR.has(String(rem.resolution || ''));

/** The rule's number and its human name, from the engine's own table. Never a
 *  second copy of the thirteen logics. REMINDER-LOGICS.md has one authority
 *  and it is lib/reminders.js. */
function ruleLabel(ruleKey) {
  const def = RULES[String(ruleKey)];
  if (!def) return { number: null, name: String(ruleKey || 'unknown'), alert: false };
  return { number: def.rule, name: RULE_NAMES[String(ruleKey)] || String(ruleKey), alert: Boolean(def.alert) };
}

/** Short names for the rule stages, for a table head. The spec's own wording,
 *  shortened, the full sentence is on the reminder itself. */
const RULE_NAMES = {
  inquiry_followup: '1st follow-up on a new inquiry',
  lead_followup_next: 'Next follow-up in the lead chain',
  order_assign: 'Assign the order to a designer',
  order_upsell: 'Upsell on a direct order',
  completed_public_review: 'Ask for a public review',
  review_private_ask: 'Ask for a private review',
  files_upsell: 'Upsell once files are with the designer',
  revision_check: 'Check the revision is done',
  offer_fu1: 'Offer, 1st follow-up',
  offer_fu2: 'Offer, 2nd follow-up',
  offer_fu3: 'Offer, 3rd follow-up',
  delivery_followup: 'Follow up on what was delivered',
  shared_followup: 'Follow up on what was shared',
  frustrated_alert: 'Frustrated client, standing caution',
  disputed_alert: 'Open dispute, standing caution',
  custom: 'Custom reminder',
};

// ============================================================================
// 4. FILTERS
// ============================================================================
//
// GET links, not a JavaScript filter bar. The owner's day starts on a phone
// and the state has to survive a share, a bookmark and a back button, a
// filter that lives in memory produces two people looking at "the same page"
// and reading different numbers, which is the argument this hub exists to end.

function filterBar({ date, days, profile, profiles }) {
  const link = (patch) => {
    const q = new URLSearchParams();
    const merged = { date, days: String(days), profile: profile || '', ...patch };
    if (merged.date) q.set('date', merged.date);
    if (merged.days && merged.days !== '1') q.set('days', merged.days);
    if (merged.profile) q.set('profile', merged.profile);
    const s = q.toString();
    return `/reports/ceo${s ? `?${s}` : ''}`;
  };

  const windows = html`<div class="segment" role="group" aria-label="Window">
      ${join(
        WINDOWS.map(
          (w) => html`<a href="${safe(link({ days: w.key }))}"
              ${safe(String(days) === w.key ? 'aria-current="true"' : '')}>${w.label}</a>`
        )
      )}
    </div>`;

  const profileChips = profiles.length
    ? html`<div class="segment" role="group" aria-label="Profile">
        <a href="${safe(link({ profile: '' }))}" ${safe(!profile ? 'aria-current="true"' : '')}>All profiles</a>
        ${join(
          profiles.map(
            (p) => html`<a href="${safe(link({ profile: p }))}"
                ${safe(profile === p ? 'aria-current="true"' : '')}>${p}</a>`
          )
        )}
      </div>`
    : '';

  return html`<section class="block">
      <div class="btnrow">
        <a class="btn btn--ghost btn--sm" href="${safe(link({ date: addDays(date, -1) }))}">← ${dateShort(addDays(date, -1))}</a>
        <a class="btn btn--ghost btn--sm" href="${safe(link({ date: addDays(date, 1) }))}">${dateShort(addDays(date, 1))} →</a>
      </div>
      <div class="toolbar" style="margin-top:12px">${windows}${profileChips}</div>
      <form method="get" action="/reports/ceo" class="btnrow" style="margin-top:12px">
        <div class="field" style="margin:0">
          <label for="ceo-date">Day the window ends on</label>
          <input id="ceo-date" name="date" type="date" value="${date}">
        </div>
        <input type="hidden" name="days" value="${String(days)}">
        ${profile ? html`<input type="hidden" name="profile" value="${profile}">` : ''}
        <button class="btn btn--ghost" type="submit">Go to that day</button>
      </form>
    </section>`;
}

// ============================================================================
// 5. THE VIEW
// ============================================================================

export function render(ctx) {
  const d = ctx.data || {};

  const shiftRows = rowsOf(d.shifts);
  const activityRows = rowsOf(d.activities);
  const reminderRows = rowsOf(d.reminders);
  const standingRows = rowsOf(d.standing);

  const date = String(d.date || '');
  const from = String(d.from || date);
  const window = Number(d.days) || 1;
  const profile = d.profile ? String(d.profile) : null;
  const profiles = Array.isArray(d.profiles) ? d.profiles : [];
  const nowMs = parseAt(d.now) ?? Date.now();

  const scope = profile ? `${profile}` : 'every profile';
  const spanLabel =
    window === 1
      ? dateShort(date, { year: true })
      : `${dateShort(from)} – ${dateShort(date, { year: true })}`;

  // ---- the shift table is the spine: without it nothing else means anything -
  //
  // Activities and reminders are attributed to shifts. With the shift list
  // unreadable there is no "who covered what" to attach anything to, and a
  // page of unattributed totals is worse than no page, it looks like a
  // finding and it is an artefact of an outage.
  if (shiftRows === null) {
    return {
      title: 'The shift log cannot be read',
      kicker: 'Reports · owner view',
      html: html`<div class="figure">
          <span class="cap">Shifts covered · ${spanLabel}</span>
          <strong class="big">${missing()}</strong>
          <p class="sub">
            The typed-records database did not answer. This page will not show a quiet day in place of an
            unreadable one: nobody can tell those apart from a summary, and the second is the one that needs
            acting on.
          </p>
        </div>
        <p class="note note--neg">
          ${glyph('crit')} <strong>Nothing is lost.</strong> Every shift already filed is filed. The CSR page
          closes logging while the store is down rather than accepting entries it cannot attach to a shift, so
          there is no gap to reconcile afterwards.
        </p>
        <div class="btnrow" style="margin-top:18px">
          <a class="btn btn--ghost" href="/reports">Open the shift page</a>
        </div>`,
    };
  }

  const shifts = shiftRows || [];
  const activities = activityRows || [];
  const reminders = reminderRows || [];
  const actOk = Array.isArray(activityRows);
  const remOk = Array.isArray(reminderRows);

  // ---- index everything once ----------------------------------------------

  const actByReport = new Map();
  for (const a of activities) {
    const list = actByReport.get(a.report_id) || [];
    list.push(a);
    actByReport.set(a.report_id, list);
  }

  const remByReport = new Map();
  for (const r of reminders) {
    const list = remByReport.get(r.report_id) || [];
    list.push(r);
    remByReport.set(r.report_id, list);
  }

  const booked = reminders.length;
  const clearedByPeople = reminders.filter(clearedByAPerson).length;
  const autoCleared = reminders.filter((r) => r.resolution === AUTO_CLEARED).length;
  const heldAsks = reminders.filter((r) => r.resolution === 'held_no_ask').length;
  const stillOpen = reminders.filter((r) => r.state !== 'resolved').length;
  const overdue = reminders.filter((r) => openPastDue(r, nowMs));
  const overdueSnoozed = overdue.filter((r) => isSnoozedNow(r, nowMs)).length;

  const standing = standingRows || [];
  const standingOk = Array.isArray(standingRows);
  const standingAlerts = standing.filter((r) => Boolean(r.alert));

  const people = new Set(shifts.map((s) => s.csr_name).filter(Boolean));
  const profilesCovered = new Set(shifts.map((s) => s.profile).filter(Boolean));

  // ---- the lede ------------------------------------------------------------

  const lede = html`<div class="lede">
      <div class="lede-main">
        <div class="figure">
          <span class="cap">Booked in this window and still open past due</span>
          <strong class="big">${remOk ? num(overdue.length) : missing()}</strong>
          <p class="sub">
            ${!remOk
              ? html`The reminder ledger could not be read. Treat this as unknown, not as clear, an
                  all-clear during an outage is the most expensive sentence this page can print.`
              : overdue.length
                ? html`Of <b>${num(booked)}</b> follow-up${booked === 1 ? '' : 's'} booked across ${scope} in
                    this window, <b>${num(overdue.length)}</b> ${overdue.length === 1 ? 'is' : 'are'} past the
                    time ${overdue.length === 1 ? 'it' : 'they'} came due and nobody has closed
                    ${overdue.length === 1 ? 'it' : 'them'}.
                    ${overdueSnoozed
                      ? html` <b>${num(overdueSnoozed)}</b> ${overdueSnoozed === 1 ? 'is' : 'are'} snoozed and
                          will be back within minutes.`
                      : ''}`
                : booked
                  ? html`Every one of the <b>${num(booked)}</b> follow-ups booked in this window is either
                      closed or not yet due. Nothing is owed and overdue.`
                  : html`No follow-ups were booked across ${scope} in this window. That is a count, not a
                      failure to read, the ledger answered.`}
          </p>
        </div>
        ${why(
          'Why this figure and not the activity count',
          html`<p>
              Activity counts describe effort. This one describes a promise: a reminder past its due time is a
              buyer the system said would hear from us and has not. It is the only number on the page that
              names work owed to somebody outside the company, so it leads and everything else sits under it.
            </p>
            <p>
              A <strong>snoozed</strong> reminder past its due time is counted here. Snooze is five minutes, 
              it moves when you see it, not whether it is owed, and a queue that hid snoozed work would
              report a clean window that the next shift inherits dirty.
            </p>
            <p>
              Reminders are counted against the window they were <strong>booked</strong> in, not the window
              they came due in. That is what makes a shift's row answer "what did this shift set in motion",
              which is the only version of the question a person can act on afterwards.
            </p>`
        )}
      </div>
      <div class="lede-side">
        <div class="figure">
          <span class="cap">Shifts covered</span>
          <strong class="mid">${num(shifts.length)}</strong>
          <p class="sub">
            ${shifts.length
              ? html`<b>${num(people.size)}</b> ${people.size === 1 ? 'person' : 'people'} across
                  <b>${num(profilesCovered.size)}</b> profile${profilesCovered.size === 1 ? '' : 's'},
                  ${actOk
                    ? html`<b>${num(activities.length)}</b> ${activities.length === 1 ? 'entry' : 'entries'} logged.`
                    : html`entries logged ${missing()}.`}`
              : html`Nobody opened a shift on ${scope} in this window. The shift table answered, this is
                  none, not unknown.`}
          </p>
        </div>
        <p class="caption">
          ${spanLabel} · ${scope}. Days are Pakistan calendar days, so the Night shift lands on the day it
          started, not the day UTC thinks it did.
        </p>
      </div>
    </div>`;

  // ---- per day -------------------------------------------------------------

  const dayKeys = [];
  for (let i = 0; i < window; i += 1) {
    dayKeys.push(addDays(from, i));
  }

  // `started_at`, NOT `opened_at`. REPORT_COLS in server.js selects
  // `opened_at AS started_at`, so the raw column name reads back undefined on
  // every row. This grouping used it, and the failure was exactly the silent
  // one the seam test was written for: `pktDay(undefined)` is null, so no shift
  // matched any day, and the page rendered "Day by day: 0 shifts, nobody" and
  // "Who covered what: no shift was opened" directly underneath a masthead
  // reading "Shifts 1 · Entries 19". HTTP 200, nothing in the log, and an owner
  // being told the shift he is looking at did not happen.
  const shiftsByDay = new Map(dayKeys.map((k) => [k, []]));
  const strayDays = [];
  for (const s of shifts) {
    const key = pktDay(s.started_at);
    if (key && shiftsByDay.has(key)) shiftsByDay.get(key).push(s);
    else if (key) strayDays.push(key);
  }

  const dayMetrics = (rows) => {
    let acts = 0;
    let bk = 0;
    let cl = 0;
    let od = 0;
    for (const s of rows) {
      acts += (actByReport.get(s.id) || []).length;
      const rem = remByReport.get(s.id) || [];
      bk += rem.length;
      cl += rem.filter(clearedByAPerson).length;
      od += rem.filter((r) => openPastDue(r, nowMs)).length;
    }
    return { acts, bk, cl, od };
  };

  const daysPanel = html`<section class="panel">
      ${panelHead(
        html`Day by day, ${num(dayKeys.length)} ${dayKeys.length === 1 ? 'day' : 'days'}`,
        'typed',
        'Typed here'
      )}
      <div class="tablewrap">
        <table class="table table--wide">
          <thead>
            <tr>
              <th>Day</th><th class="r">Shifts</th><th>Covered by</th>
              <th class="r">Entries</th><th class="r">Booked</th><th class="r">Cleared</th>
              <th class="r">Open past due</th>
            </tr>
          </thead>
          <tbody>
            ${join(
              [...dayKeys].reverse().map((key) => {
                const rows = shiftsByDay.get(key) || [];
                const m = dayMetrics(rows);
                const who = [...new Set(rows.map((r) => r.csr_name).filter(Boolean))];
                return html`<tr class="${safe(m.od ? 'row-attn' : rows.length ? '' : 'row-cleared')}">
                  <td>
                    <span class="cell-name">${dateShort(key)}</span>
                    ${key === date ? html` ${pill('info', 'window ends')}` : ''}
                  </td>
                  <td class="r cell-figure">${num(rows.length)}</td>
                  <td>${who.length ? join(who, ', ') : html`<span class="caption">nobody</span>`}</td>
                  <td class="r cell-figure">${count(m.acts, actOk)}</td>
                  <td class="r cell-figure">${count(m.bk, remOk)}</td>
                  <td class="r cell-figure">${count(m.cl, remOk)}</td>
                  <td class="r cell-figure">${remOk && m.od ? html`<b class="warn">${num(m.od)}</b>` : count(m.od, remOk)}</td>
                </tr>`;
              })
            )}
          </tbody>
        </table>
        <p class="tablehint" aria-hidden="true">Scroll sideways for more columns →</p>
      </div>
      ${strayDays.length
        ? html`<p class="note note--warn">
            ${glyph('warn')} ${num(strayDays.length)} shift${strayDays.length === 1 ? '' : 's'} in the result
            opened outside the window shown. They are excluded from the rows above rather than folded into the
            nearest day.
          </p>`
        : ''}
      <p class="caption">
        Counts, not rates, a day is one day and there is no denominator here worth taking a percentage of.
        A day with nobody on it is greyed, which is a fact about cover, not about effort.
      </p>
    </section>`;

  // ---- who covered what ----------------------------------------------------

  const coverageRows = [...dayKeys]
    .reverse()
    .flatMap((key) => {
      const rows = [...(shiftsByDay.get(key) || [])].sort((a, b) => {
        const s = SHIFT_ORDER.indexOf(a.shift) - SHIFT_ORDER.indexOf(b.shift);
        if (s) return s;
        return (parseAt(a.started_at) ?? 0) - (parseAt(b.started_at) ?? 0);
      });
      return rows.map((s) => ({ key, s }));
    });

  const coveragePanel = html`<section class="panel">
      ${panelHead(html`Who covered what, ${num(coverageRows.length)}`, 'typed', 'Typed here')}
      ${coverageRows.length
        ? html`<div class="tablewrap tablewrap--capped">
              <table class="table table--wide">
                <thead>
                  <tr>
                    <th>Day</th><th>Shift</th><th>Person</th><th>Profile</th><th>In / out</th>
                    <th class="r">Entries</th><th class="r">Booked</th><th class="r">Cleared</th>
                    <th class="r">Open past due</th><th>Handover</th>
                  </tr>
                </thead>
                <tbody>
                  ${join(
                    coverageRows.map(({ key, s }) => {
                      const acts = actByReport.get(s.id) || [];
                      const rem = remByReport.get(s.id) || [];
                      const cl = rem.filter(clearedByAPerson).length;
                      const od = rem.filter((r) => openPastDue(r, nowMs)).length;
                      const inAt = clockPKT(s.started_at);
                      const outAt = s.closed_at ? clockPKT(s.closed_at) : null;
                      const open = s.status === 'open';
                      return html`<tr class="${safe(od ? 'row-attn' : '')}">
                        <td>${dateShort(key)}</td>
                        <td>
                          <span class="cell-name">${s.shift}</span>
                          <br><span class="caption">${SHIFT_TIME[s.shift] || ''}</span>
                        </td>
                        <td><span class="cell-name">${s.csr_name || missing()}</span></td>
                        <td>${s.profile || missing()}</td>
                        <td class="nowrap">
                          ${inAt || missing()} → ${open ? pill('info', 'still open') : outAt || missing()}
                        </td>
                        <td class="r cell-figure">${actOk ? num(acts.length) : missing()}</td>
                        <td class="r cell-figure">${count(rem.length, remOk)}</td>
                        <td class="r cell-figure">${count(cl, remOk)}</td>
                        <td class="r cell-figure">${remOk && od ? html`<b class="warn">${num(od)}</b>` : count(od, remOk)}</td>
                        <td>
                          ${s.handoff_note
                            ? html`<span class="caption">left a note</span>`
                            : open
                              ? html`<span class="caption">None</span>`
                              : html`<span class="caption">no note</span>`}
                        </td>
                      </tr>`;
                    })
                  )}
                </tbody>
              </table>
              <p class="tablehint" aria-hidden="true">Scroll sideways for more columns →</p>
            </div>`
        : empty(`No shift was opened on ${scope} in this window.`)}
      ${why(
        'What "cleared" counts, and what it refuses to count',
        html`<p>
            <strong>Cleared</strong> is a reminder somebody closed with one of its buttons. It excludes
            <em>auto-cleared</em>, the system noticing a later entry made the follow-up pointless, because
            crediting that to whoever happened to log the next activity rewards the wrong thing and was one of
            the two measurement bugs in the console this page replaces.
          </p>
          <p>
            It also excludes a review ask the hub <em>held</em>. Rule 5 of the spec books "ask for a public
            review" thirty minutes after an order completes; where the buyer is on the late list or carries an
            open dispute, that ask is held and closed as held rather than sent. Those are counted on their own
            below. A held ask is the rule working, not a CSR skipping work.
          </p>`
      )}
    </section>`;

  // ---- the wrap-up each closed shift filed -----------------------------------
  //
  // `checklist` and `handoff_note` were being written by the CSR page, stored on
  // the shift, and read by nobody: the coverage table said "left a note" without
  // ever showing it, and the ticks were invisible. Both this file's own header
  // and db/schema.sql describe the behaviour below as if it already existed.
  //
  // A BLANK COUNT IS NOT ZERO, and that is the whole reason this renders the way
  // it does. The store keeps `true` for "ticked but not counted" and a number
  // for "counted", because "did the briefs, did not count them" and "did none"
  // are different facts and only the second is a problem. `true` prints MISSING
  // (house rule 2); an unticked item prints as not done, which is the one honest
  // zero on the panel. An open shift has not filed a wrap-up yet and is left out
  // rather than shown as having skipped everything.

  const wrapRows = coverageRows.filter(({ s }) => s.status !== 'open');

  const wrapPanel = html`<section class="panel">
      ${panelHead(html`Wrap-up filed, ${num(wrapRows.length)}`, 'typed', 'Typed here')}
      ${!wrapRows.length
        ? empty(`No shift has filed a wrap-up on ${scope} in this window.`)
        : html`<div class="tablewrap tablewrap--capped">
              <table class="table table--wide">
                <thead>
                  <tr>
                    <th>Day</th><th>Shift</th><th>Person</th>
                    ${join(CHECKLIST.map((item) => html`<th class="r">${item.label}</th>`))}
                  </tr>
                </thead>
                <tbody>
                  ${join(
                    wrapRows.map(({ key, s }) => {
                      const ticked = s.checklist && typeof s.checklist === 'object' ? s.checklist : {};
                      return html`<tr>
                        <td>${dateShort(key)}</td>
                        <td><span class="cell-name">${s.shift}</span></td>
                        <td>${s.csr_name || missing()}</td>
                        ${join(
                          CHECKLIST.map((item) => {
                            const v = ticked[item.id];
                            if (v === undefined || v === null || v === false) {
                              return html`<td class="r"><span class="caption">not done</span></td>`;
                            }
                            // Ticked. A number is a count; `true` is a tick with
                            // no count behind it, and that is MISSING, not 0.
                            return html`<td class="r cell-figure">${
                              typeof v === 'number' ? num(v) : item.count ? missing() : pill('ok', 'done')
                            }</td>`;
                          })
                        )}
                      </tr>`;
                    })
                  )}
                </tbody>
              </table>
              <p class="tablehint" aria-hidden="true">Scroll sideways for more columns →</p>
            </div>`}
      ${join(
        wrapRows
          .filter(({ s }) => s.handoff_note)
          .map(
            ({ key, s }) => html`<div class="note" style="margin-top:14px">
              <p class="caption">
                ${dateShort(key)} · ${s.shift} · ${s.csr_name || missing()}
                ${Array.isArray(s.note_shifts) && s.note_shifts.length
                  ? html` · for the ${join(s.note_shifts, ' and ')} shift`
                  : ''}
              </p>
              <p>${s.handoff_note}</p>
            </div>`
          )
      )}
      ${why(
        'Why a ticked box can read MISSING',
        html`<p>
            The wrap-up stores a tick and a count separately. A CSR who ticked
            <em>Briefs created</em> without typing how many has told us the work happened and not how much
            of it. So the cell reads MISSING, because printing <code class="mono">0</code> there would
            report the opposite of what they said. An item never ticked reads <em>not done</em>, which is
            the only figure on this panel that is genuinely a zero.
          </p>
          <p>
            Shifts still open are not listed. A wrap-up is filed at the end, so an open shift has not
            skipped it, it has not reached it.
          </p>`
      )}
    </section>`;

  // ---- what was logged -----------------------------------------------------

  const kindCounts = {};
  // `type`, not `kind`: the loader selects `a.kind AS type`. The `|| a.kind`
  // fallback that used to sit here could never fire and only made the aliased
  // name look optional.
  for (const a of activities) bump(kindCounts, a.type);
  const totalActs = activities.length;

  const kindPanel = html`<section class="panel">
      ${panelHead(
        html`What was logged, ${actOk ? num(totalActs) : missing()}`,
        actOk ? 'typed' : 'missing',
        actOk ? 'Typed here' : 'Entries unreadable'
      )}
      ${!actOk
        ? html`<p class="note note--neg">
            ${glyph('crit')} The entries for this window could not be read. Every shift's entry count above is
            MISSING for the same reason. Anything the team saved is still saved.
          </p>`
        : totalActs === 0
          ? empty('Nothing was logged in this window.')
          : html`<div class="tablewrap">
                <table class="table table--wide">
                  <thead>
                    <tr><th>Activity</th><th class="r">Logged</th><th>Share of the ${num(totalActs)}</th><th class="r">Booked a follow-up</th></tr>
                  </thead>
                  <tbody>
                    ${join(
                      KIND_GROUPS.flatMap((g) => {
                        const kinds = ACTIVITY_KINDS.filter((k) => k.group === g.key && kindCounts[k.key]);
                        if (!kinds.length) return [];
                        return [
                          html`<tr><td colspan="4"><span class="eyebrow">${g.label}</span></td></tr>`,
                          ...kinds
                            .sort((a, b) => (kindCounts[b.key] || 0) - (kindCounts[a.key] || 0))
                            .map((k) => {
                              const n = kindCounts[k.key] || 0;
                              const bookedHere = remOk
                                ? reminders.filter((r) => {
                                    const def = RULES[String(r.rule_key)];
                                    return def && def.on === k.key;
                                  }).length
                                : null;
                              return html`<tr>
                                <td><span class="cell-name">${k.label}</span></td>
                                <td class="r cell-figure">${num(n)}</td>
                                <td>${shareCell(n, totalActs)}</td>
                                <td class="r cell-figure">${bookedHere === null ? missing() : num(bookedHere)}</td>
                              </tr>`;
                            }),
                        ];
                      })
                    )}
                  </tbody>
                </table>
                <p class="tablehint" aria-hidden="true">Scroll sideways for more columns →</p>
              </div>`}
      ${actOk && totalActs > 0
        ? why(
            'Why some shares are a range with no bar',
            html`<p>
                A share is drawn as a bar only where the denominator can carry one. Under
                ${String(MIN_SAMPLE)} entries, or wherever the 95% interval is wider than 15 points, the
                bar is replaced by the interval itself on a hatched track. Four of thirty-four is
                4.7%–26.6%, and that range contains both "a crisis" and "nothing happened"; drawing 11.8% as
                a bar would be this page picking one of them at random.
              </p>
              <p>
                The last column counts reminders booked by that kind of entry across the window. Several
                kinds book nothing at all by design, client conversation, meeting, spam, and a zero there
                is the catalogue working, not a gap.
              </p>`
          )
        : ''}
    </section>`;

  // ---- per person ----------------------------------------------------------

  const byPerson = new Map();
  for (const s of shifts) {
    const name = s.csr_name || null;
    if (!name) continue;
    const row =
      byPerson.get(name) ||
      { name, shifts: 0, profiles: new Set(), acts: 0, booked: 0, cleared: 0, overdue: 0, held: 0 };
    row.shifts += 1;
    if (s.profile) row.profiles.add(s.profile);
    row.acts += (actByReport.get(s.id) || []).length;
    const rem = remByReport.get(s.id) || [];
    row.booked += rem.length;
    row.cleared += rem.filter(clearedByAPerson).length;
    row.overdue += rem.filter((r) => openPastDue(r, nowMs)).length;
    row.held += rem.filter((r) => r.resolution === 'held_no_ask').length;
    byPerson.set(name, row);
  }

  // Anyone who closed a reminder in this window but did not open a shift in it
  // still belongs on the page, reminders follow the profile, so the person who
  // clears one is routinely not the person who booked it. Their "closed by them"
  // column is the honest one; their booked column stays at whatever their own
  // shifts produced, which for a visitor is zero and says so.
  const closedBy = {};
  for (const r of reminders) {
    if (clearedByAPerson(r) && r.resolved_by) bump(closedBy, String(r.resolved_by));
  }
  for (const name of Object.keys(closedBy)) {
    if (!byPerson.has(name)) {
      byPerson.set(name, {
        name,
        shifts: 0,
        profiles: new Set(),
        acts: 0,
        booked: 0,
        cleared: 0,
        overdue: 0,
        held: 0,
        visitor: true,
      });
    }
  }

  const personRows = [...byPerson.values()].sort(
    (a, b) => b.acts - a.acts || b.shifts - a.shifts || a.name.localeCompare(b.name)
  );
  const ratable = personRows.filter((p) => p.booked >= MIN_SAMPLE).length;

  const peoplePanel = html`<section class="panel">
      ${panelHead(html`Per person, ${num(personRows.length)}`, 'typed', 'Typed here')}
      ${personRows.length
        ? html`<div class="tablewrap">
              <table class="table table--wide">
                <thead>
                  <tr>
                    <th>Person</th><th class="r">Shifts</th><th>Profiles</th><th class="r">Entries</th>
                    <th class="r">Booked</th><th class="r">Closed by them</th>
                    <th>Share of their bookings cleared</th><th class="r">Open past due</th>
                  </tr>
                </thead>
                <tbody>
                  ${join(
                    personRows.map((p) => {
                      const closed = closedBy[p.name] || 0;
                      return html`<tr class="${safe(p.overdue ? 'row-attn' : '')}">
                        <td>
                          <span class="cell-name">${p.name}</span>
                          ${p.visitor ? html`<br><span class="caption">no shift of their own in this window</span>` : ''}
                        </td>
                        <td class="r cell-figure">${num(p.shifts)}</td>
                        <td>${p.profiles.size ? join([...p.profiles], ', ') : html`<span class="caption">None</span>`}</td>
                        <td class="r cell-figure">${actOk ? num(p.acts) : missing()}</td>
                        <td class="r cell-figure">${count(p.booked, remOk)}</td>
                        <td class="r cell-figure">${count(closed, remOk)}</td>
                        <td>
                          ${!remOk
                            ? missing()
                            : p.booked === 0
                              ? html`<span class="caption">nothing booked</span>`
                              : shareCell(p.cleared, p.booked, 'pos')}
                        </td>
                        <td class="r cell-figure">${remOk && p.overdue ? html`<b class="warn">${num(p.overdue)}</b>` : count(p.overdue, remOk)}</td>
                      </tr>`;
                    })
                  )}
                </tbody>
              </table>
              <p class="tablehint" aria-hidden="true">Scroll sideways for more columns →</p>
            </div>`
        : empty('Nobody worked a shift on this profile in this window.')}
      <p class="caption">
        ${remOk
          ? ratable === personRows.length && personRows.length > 0
            ? html`Every person here has at least ${String(MIN_SAMPLE)} bookings, so every share is drawn.`
            : html`<b>${num(personRows.length - ratable)}</b> of ${num(personRows.length)}
                ${personRows.length === 1 ? 'person has' : 'people have'} fewer than ${String(MIN_SAMPLE)}
                bookings in this window. Their share shows as an interval on a hatched track and no bar, the
                counts beside it are the part that is safe to read.`
          : 'The reminder ledger could not be read, so no share on this table can be computed.'}
      </p>
      ${why(
        'Why nine entries does not get a percentage',
        html`<p>
            A rate is a claim about what would happen again. On nine bookings the 95% interval spans most of
            the possible answers, so a single figure, 78%, 33%, whatever it comes to, reads as a finding
            while carrying almost no information. Two people compared on such intervals are not being
            compared at all.
          </p>
          <p>
            So the rule is mechanical rather than a judgement call: below ${String(MIN_SAMPLE)}, or wherever
            the interval is wider than 15 points, the bar is suppressed and the interval is printed instead.
            <code class="mono">meter()</code> in <code class="mono">views/layout.js</code> enforces it, this
            page cannot opt out, and neither can the next one.
          </p>
          <p>
            <strong>Closed by them</strong> and <strong>Booked</strong> are deliberately different columns.
            A reminder belongs to the profile, so whoever is covering it when it falls due is usually not
            whoever booked it. Reading one as the other turns a night shift's clean-up into a morning
            shift's backlog.
          </p>`
      )}
    </section>`;

  // ---- the reminder ledger -------------------------------------------------

  const byRule = new Map();
  for (const r of reminders) {
    const key = String(r.rule_key);
    const row = byRule.get(key) || { key, booked: 0, cleared: 0, auto: 0, held: 0, open: 0, overdue: 0 };
    row.booked += 1;
    if (clearedByAPerson(r)) row.cleared += 1;
    if (r.resolution === AUTO_CLEARED) row.auto += 1;
    if (r.resolution === 'held_no_ask') row.held += 1;
    if (r.state !== 'resolved') row.open += 1;
    if (openPastDue(r, nowMs)) row.overdue += 1;
    byRule.set(key, row);
  }
  const ruleRows = [...byRule.values()].sort((a, b) => {
    const an = ruleLabel(a.key).number ?? 99;
    const bn = ruleLabel(b.key).number ?? 99;
    return an - bn || a.key.localeCompare(b.key);
  });

  const ledgerPanel = html`<section class="panel">
      ${panelHead(
        html`Follow-ups booked, ${remOk ? num(booked) : missing()}`,
        remOk ? 'typed' : 'missing',
        remOk ? 'Typed here' : 'Ledger unreadable'
      )}
      ${!remOk
        ? html`<p class="note note--neg">
            ${glyph('crit')} The reminder ledger could not be read. Nothing on this page that counts a
            follow-up is trustworthy right now, and every such figure above says MISSING rather than 0.
          </p>`
        : html`<dl class="stats">
              <div class="stat"><dt>Booked</dt><dd>${num(booked)}</dd></div>
              <div class="stat"><dt>Closed by a person</dt><dd>${num(clearedByPeople)}</dd></div>
              <div class="stat"><dt>Auto-cleared</dt><dd>${num(autoCleared)}<span class="u"> the follow-up already happened</span></dd></div>
              <div class="stat"><dt>Review asks held</dt><dd>${num(heldAsks)}<span class="u"> late or disputed order</span></dd></div>
              <div class="stat"><dt>Still open</dt><dd>${num(stillOpen)}</dd></div>
              <div class="stat"><dt>Open past due</dt><dd>${num(overdue.length)}</dd></div>
            </dl>
            ${ruleRows.length
              ? html`<div class="tablewrap" style="margin-top:20px">
                    <table class="table table--wide">
                      <thead>
                        <tr>
                          <th class="r">Rule</th><th>What it asks for</th><th class="r">Booked</th>
                          <th class="r">Closed</th><th class="r">Auto</th><th class="r">Held</th>
                          <th class="r">Open past due</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${join(
                          ruleRows.map((row) => {
                            const meta = ruleLabel(row.key);
                            return html`<tr class="${safe(row.overdue ? 'row-attn' : '')}">
                              <td class="r cell-figure">${meta.number === null ? missing() : num(meta.number)}</td>
                              <td>
                                <span class="cell-name">${meta.name}</span>
                                ${meta.alert ? html` ${pill('crit', 'standing caution')}` : ''}
                              </td>
                              <td class="r cell-figure">${num(row.booked)}</td>
                              <td class="r cell-figure">${num(row.cleared)}</td>
                              <td class="r cell-figure">${num(row.auto)}</td>
                              <td class="r cell-figure">${row.held ? num(row.held) : html`<span class="caption">None</span>`}</td>
                              <td class="r cell-figure">${row.overdue ? html`<b class="warn">${num(row.overdue)}</b>` : num(0)}</td>
                            </tr>`;
                          })
                        )}
                      </tbody>
                    </table>
                    <p class="tablehint" aria-hidden="true">Scroll sideways for more columns →</p>
                  </div>`
              : empty('No follow-up was booked in this window.')}`}
      ${why(
        'The thirteen rules, and where they live',
        html`<p>
            The rule numbers are the ones in the owner-written spec,
            <code class="mono">REMINDER-LOGICS.md</code>. Some numbers appear as more than one row because a
            number can have stages: rule 9 is a three-step offer chain, and rule 10 is reachable from both a
            delivery and a chat share. The stage is what is booked, so the stage is what is counted.
          </p>
          <p>
            There is one authority for all of it, <code class="mono">lib/reminders.js</code>, and this page
            reads the rule table out of it rather than keeping a second copy. A rule renamed there changes
            this table; a rule renamed only here would be a lie that renders perfectly.
          </p>`
      )}
    </section>`;

  // ---- what is standing right now ------------------------------------------

  const standingPanel = html`<section class="panel">
      ${panelHead(
        html`Owed right now, across all time, ${standingOk ? num(standing.length) : missing()}`,
        standingOk ? 'typed' : 'missing',
        standingOk ? `Typed here · ${scope}` : 'Queue unreadable'
      )}
      ${!standingOk
        ? html`<p class="note note--neg">
            ${glyph('crit')} The open queue could not be read. There may be follow-ups standing on ${scope}
            right now and this page cannot see them.
          </p>`
        : standing.length === 0
          ? empty(`Nothing is open past its due time on ${scope}. Not one buyer is waiting on a booked follow-up.`)
          : html`${standingAlerts.length
                ? html`<p class="note note--neg">
                    ${glyph('crit')} <strong>${num(standingAlerts.length)} standing
                    caution${standingAlerts.length === 1 ? '' : 's'}.</strong> Frustrated and disputed clients
                    do not queue and cannot be snoozed, they sit on the profile until somebody marks them
                    solved. While one stands, no review ask goes to that buyer.
                  </p>`
                : ''}
              <div class="tablewrap tablewrap--capped">
                <table class="table table--wide">
                  <thead>
                    <tr><th>Waiting</th><th>Profile</th><th>Client</th><th>What is owed</th><th>Due</th><th>Booked by</th></tr>
                  </thead>
                  <tbody>
                    ${join(
                      standing.slice(0, 60).map((r) => {
                        const meta = ruleLabel(r.rule_key);
                        return html`<tr class="${safe(r.alert ? 'row-late' : 'row-attn')}">
                          <td class="cell-figure nowrap">${waited(r.due_at, nowMs) || missing()}</td>
                          <td>${r.profile || missing()}</td>
                          <td><span class="cell-name">${r.client || html`<span class="caption">no buyer named</span>`}</span></td>
                          <td>
                            ${r.heading || meta.name}
                            ${r.alert ? html` ${pill('crit', 'caution')}` : ''}
                            ${isSnoozedNow(r, nowMs) ? html` ${pill('info', 'snoozed')}` : ''}
                          </td>
                          <td class="nowrap">${dateTimeShort(r.due_at)}</td>
                          ${/* created_by, NOT booked_by: REMINDER_COLS selects
                                "booked_by AS created_by", so the original name
                                reads undefined and this column printed MISSING
                                over a row that records who booked it. */ ''}
                          <td>${r.created_by || missing()}</td>
                        </tr>`;
                      })
                    )}
                  </tbody>
                </table>
                <p class="tablehint" aria-hidden="true">Scroll sideways for more columns →</p>
              </div>
              ${standing.length > 60
                ? html`<p class="caption">
                    Showing the 60 that have waited longest. ${num(standing.length - 60)} more are behind them.
                  </p>`
                : ''}`}
      <p class="caption">
        This list ignores the window. It is everything open past its due time on ${scope} right now, however
        long ago it was booked, oldest first${standing.length && waited(standing[0].due_at, nowMs) ? html`, the one at the top has waited ${waited(standing[0].due_at, nowMs)}` : ''}.
        A follow-up is not made less owed by falling outside a date filter.
      </p>
    </section>`;

  // ---- the page ------------------------------------------------------------

  const title = !remOk
    ? 'The follow-up ledger could not be read'
    : overdue.length
      ? `${overdue.length} follow-up${overdue.length === 1 ? '' : 's'} booked and still owed`
      : shifts.length
        ? `${shifts.length} shift${shifts.length === 1 ? '' : 's'} covered, nothing overdue`
        : 'No shift was covered in this window';

  return {
    title,
    kicker: `Reports · owner view · ${spanLabel}`,
    ticker: [
      { label: 'Shifts', value: num(shifts.length) },
      { label: 'People', value: num(people.size) },
      { label: 'Entries', value: actOk ? num(activities.length) : missing() },
      { label: 'Booked', value: remOk ? num(booked) : missing() },
      { label: 'Cleared', value: remOk ? num(clearedByPeople) : missing() },
      { label: 'Open past due', value: remOk ? num(overdue.length) : missing(), sub: standingOk ? `${standing.length} all time` : '' },
    ],
    html: html`${lede}
      ${filterBar({ date, days: window, profile, profiles })}
      ${standingPanel}
      ${daysPanel}
      ${coveragePanel}
      ${wrapPanel}
      ${kindPanel}
      ${peoplePanel}
      ${ledgerPanel}
      <div class="btnrow" style="margin-top:26px">
        <a class="btn btn--ghost" href="/reports">Open the shift page</a>
      </div>
      <div class="provenance-bar">
        <span>Every figure on this page is typed by the team, in <code class="mono">shift_report</code>,
          <code class="mono">activity</code> and <code class="mono">reminder</code>. Nothing here is
          recomputed from the engine and nothing here is written back to any sheet.</span>
        <span>Days are Pakistan calendar days, computed in this view rather than in SQL so the Night shift
          is never filed under the previous date.</span>
        <span>Rates follow the house rule: below ${String(MIN_SAMPLE)}, or wider than 15 points, they are an
          interval on a hatched track and never a bar.</span>
      </div>`,
  };
}

export default render;
