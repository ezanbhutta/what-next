// views/team.js — the weekly review, and the decisions log.
//
// WHAT THIS PAGE IS
//
//   The client's own weekly sheet, mirrored row for row: one record per person
//   per week carrying a self score, a manager score, a note, a promise for next
//   week, and whether last week's promise was kept.
//
// THE SEQUENCE IS THE POINT, SO THE PAGE ENFORCES IT
//
//   The self score is asked FIRST. The manager score field stays DISABLED until
//   the self score exists. That is step 1 of how they run the review and it is
//   the entire reason both numbers are stored: a manager score entered first is
//   a verdict, and a self score typed underneath one is an argument with it.
//   Ask the person, then answer them, and the DIFFERENCE is what you coach on.
//
//   So this page leads with the GAP and not with the score. Two people who both
//   said 3 and were both given 3 need nothing from anybody. A 5 against a 3 is a
//   conversation — in one direction or the other, and which direction is the
//   finding.
//
//   The lock is a PROCESS rule, not a security boundary, and the page says so
//   rather than implying otherwise. It survives with JavaScript off: a row whose
//   self score has not been saved renders its manager field disabled from the
//   server, which makes the review a genuine two-step exactly as their sheet
//   describes it. With JavaScript on, picking a self score unlocks the manager
//   field in place so a single sitting still works.
//
// THE SCALE IS PRINTED, INCLUDING THE PART EVERYONE SKIPS
//
//   1 very bad · 2 below normal · 3 NORMAL · 4 good · 5 excellent.
//
//   Their sheet says in as many words: do not give a 4 just to make someone
//   happy. A team averaging 4.2 has stopped measuring anything, and the first
//   casualty is the gap this page is built around — you cannot see a
//   disagreement between two numbers that are both pinned to the ceiling. The
//   word "normal" is drawn on 3 every time the scale appears.
//
// THE DISCREPANCY THIS PAGE REFUSES TO HIDE
//
//   The review programme and the people doing the work are not the same set,
//   and nobody had put the two lists side by side. It is the same shape as the
//   finding that started this repo — two systems, each holding part of the
//   truth, neither aware of the other — so it is reported here rather than
//   quietly reconciled. The names and counts are computed live from the `csr`
//   column of the engine's own files against `app_user`; nothing is hard-coded,
//   so the panel keeps telling the truth after somebody is hired or leaves.
//
// WHERE THE NUMBERS COME FROM
//
//   team_week, decision, app_user   typed here, MySQL. The only writes.
//   orders.jsonl, leads.jsonl       engine output on disk. The `csr` column is
//                                   COUNTED — no figure the engine published is
//                                   recomputed.
//   calibration.json                the engine's own scored forecasts, shown
//                                   beside the decisions log because it answers
//                                   the same question about the same person.
//
// HOUSE RULES THIS FILE IS CARRYING
//
//   R2  A database that did not answer is MISSING. A table nobody has typed
//       into is EMPTY. They are different facts and they render differently —
//       and only one of them leaves the forms open.
//   R3  Promise-kept and decision-hit rates are proportions on single-figure
//       denominators, so they print as ranges and draw no bar. The 1–5 marks
//       and the score means are NOT rates: they are a census of the people who
//       were reviewed, on a scale with known bounds, so marks are legitimate
//       there and the captions say which kind of number each one is.
//   R7  Every figure leads. The scale, the gap, the roster mismatch and the
//       decision record are figures; their reasoning is in `<details>` beneath.

import {
  html,
  join,
  safe,
  missing,
  num,
  num as count,
  dateShort,
  dateTimeShort,
  glyph,
  pill,
  panelHead,
  why,
  empty,
  rate,
  known,
  MIN_SAMPLE,
} from './layout.js';

import {
  isMissing,
  pick,
  orders as engineOrders,
  leads as engineLeads,
  calibration as engineCalibration,
} from '../lib/data.js';

// ============================================================================
// 1. THE SCALE — their words, not a paraphrase
// ============================================================================

const SCALE = Object.freeze([
  { n: 1, word: 'Very bad' },
  { n: 2, word: 'Below normal' },
  { n: 3, word: 'Normal' },
  { n: 4, word: 'Good' },
  { n: 5, word: 'Excellent' },
]);

const SCALE_WORD = Object.fromEntries(SCALE.map((s) => [s.n, s.word]));

const PROMISE = Object.freeze([
  { value: 'yes', label: 'Kept', tone: 'ok' },
  { value: 'half', label: 'Half kept', tone: 'warn' },
  { value: 'no', label: 'Not kept', tone: 'crit' },
]);

const PROMISE_BY_VALUE = Object.fromEntries(PROMISE.map((p) => [p.value, p]));

const VERDICT = Object.freeze([
  { value: 'yes', label: 'Right', tone: 'ok' },
  { value: 'partly', label: 'Partly', tone: 'warn' },
  { value: 'no', label: 'Wrong', tone: 'crit' },
  { value: 'pending', label: 'Not yet known', tone: 'idle' },
]);

const VERDICT_BY_VALUE = Object.fromEntries(VERDICT.map((v) => [v.value, v]));

// ============================================================================
// 2. SMALL HELPERS
// ============================================================================

/** A q() result → rows, `null` on outage, `undefined` when the loader skipped it.
 *  The three cases are kept apart deliberately: `[]` is a fact about the data,
 *  `null` is a fact about the system, and a page that conflates them tells a
 *  manager the week is unscored during a database outage. */
function rowsOf(result) {
  if (!result) return undefined;
  return result.ok ? result.rows || [] : null;
}

/** A DATE column back to 'YYYY-MM-DD'. mysql2 hands back a Date at LOCAL
 *  midnight, and `toISOString()` on that prints the day before anywhere west of
 *  UTC — a quiet off-by-one that would file a review under the wrong week. */
function isoOf(value) {
  if (!value) return null;
  if (value instanceof Date) {
    const p = (n) => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${p(value.getMonth() + 1)}-${p(value.getDate())}`;
  }
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(value));
  return m ? m[1] : null;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Shift an ISO date by whole days without touching a timezone. */
function shiftIso(iso, deltaDays) {
  if (!ISO.test(String(iso || ''))) return null;
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + deltaDays * 86_400_000).toISOString().slice(0, 10);
}

/** Day of week, 0=Sunday, computed in UTC so it cannot drift with the server. */
function weekdayOf(iso) {
  if (!ISO.test(String(iso || ''))) return null;
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

const DAY_NAME = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Today, in the server's own calendar. A review week is about now, not about
 *  the engine's run date — the engine can be three days behind and this week is
 *  still this week. */
function todayIso() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** The most recent `dow` on or before `iso`. */
function lastWeekdayOnOrBefore(iso, dow) {
  const have = weekdayOf(iso);
  if (have === null) return null;
  return shiftIso(iso, -((have - dow + 7) % 7));
}

/** A stored score → 1–5, or null. Anything outside the scale is null rather
 *  than clamped: a 7 in this column is a bug to see, not a 5 to render. */
function scoreOf(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
}

function meanOf(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  return list.reduce((a, b) => a + b, 0) / list.length;
}

/** Name equality for the roster join: trimmed, case-folded, inner whitespace
 *  collapsed. Nothing fuzzier. "Hasnain" and "hasnain " are one person;
 *  "Hasnain" and "Husnain" are two, and guessing otherwise would attach one
 *  person's 228 orders to another's review. */
function nameKey(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** A signed figure. The sign carries the direction in text, so the colour is
 *  never doing the work on its own (G1). */
function signed(value, { dp = 1, unit = '' } = {}) {
  if (!known(value)) return missing();
  const n = Number(value);
  const cls = n > 0 ? 'pos' : n < 0 ? 'neg' : 'flat';
  const sign = n > 0 ? '+' : n < 0 ? '−' : '±';
  return html`<span class="num ${cls}">${sign}${Math.abs(n).toFixed(dp)}${unit}</span>`;
}

/** Plain text for `title` / `kicker`, which are prose and not markup. */
function plainSigned(value, dp = 1) {
  if (!known(value)) return 'MISSING';
  const n = Number(value);
  return `${n > 0 ? '+' : n < 0 ? '−' : '±'}${Math.abs(n).toFixed(dp)}`;
}

// ============================================================================
// 3. THE 1–5 MARKS
// ============================================================================
//
// Five cells on a scale with known bounds, filled to the score. This is not a
// bar and R3 does not apply to it: a bar claims a proportion of a whole that
// was estimated from a sample, and a score of 3 is not an estimate of anything
// — it is the value itself, on an axis that is printed beside it. Self is the
// grey fill, manager is the accent fill, both defined in app.css for exactly
// this component.

function scoreMarks(value, kind) {
  const n = scoreOf(value);
  if (n === null) return missing();
  const fill = kind === 'manager' ? 'is-on' : 'is-self';
  const marks = join(SCALE.map((s) => html`<i class="${s.n <= n ? fill : ''}"></i>`));
  return html`<span class="score" role="img"
      aria-label="${kind === 'manager' ? 'Manager score' : 'Self score'} ${String(n)} of 5, ${SCALE_WORD[n]}">${marks}</span>
    <span class="caption"> ${String(n)} ${SCALE_WORD[n]}</span>`;
}

// ============================================================================
// 4. THE WEEK
// ============================================================================

/**
 * Group the typed rows by week, newest first.
 *
 * Each week carries its own means and its own paired gap. A "pair" is a person
 * with BOTH scores: a gap needs two numbers and a week where three people
 * self-scored and one was manager-scored has exactly one gap, not four.
 */
function groupWeeks(rows) {
  const byWeek = new Map();
  for (const row of rows) {
    const week = isoOf(row.week_ending);
    if (!week) continue;
    if (!byWeek.has(week)) byWeek.set(week, []);
    byWeek.get(week).push({ ...row, week, person: String(row.person ?? '') });
  }

  const weeks = [...byWeek.entries()]
    .map(([week, people]) => {
      const selfs = people.map((p) => scoreOf(p.self_score)).filter((n) => n !== null);
      const managers = people.map((p) => scoreOf(p.manager_score)).filter((n) => n !== null);
      const pairs = people
        .map((p) => ({ person: p.person, self: scoreOf(p.self_score), manager: scoreOf(p.manager_score) }))
        .filter((p) => p.self !== null && p.manager !== null)
        .map((p) => ({ ...p, gap: p.self - p.manager }));

      const promiseAnswered = people.filter((p) => PROMISE_BY_VALUE[String(p.prev_promise_done)]);
      const promiseKept = promiseAnswered.filter((p) => p.prev_promise_done === 'yes');

      return {
        week,
        people: people.sort((a, b) => a.person.localeCompare(b.person)),
        selfMean: meanOf(selfs),
        managerMean: meanOf(managers),
        selfN: selfs.length,
        managerN: managers.length,
        pairs,
        gapMean: meanOf(pairs.map((p) => p.gap)),
        widest: pairs.slice().sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap))[0] || null,
        promiseAnswered: promiseAnswered.length,
        promiseKept: promiseKept.length,
      };
    })
    .sort((a, b) => (a.week < b.week ? 1 : a.week > b.week ? -1 : 0));

  return weeks;
}

/**
 * Which week to show, and which weekday a week ends on.
 *
 * The weekday is INFERRED from what has already been recorded rather than
 * assumed. If their week ends on a Saturday, the second review teaches this
 * page that and every default afterwards lands on a Saturday. With nothing
 * recorded yet it falls back to Saturday and says so on screen, so a wrong
 * guess is visible and one edit away instead of silently filing week one under
 * the wrong date.
 */
function chooseWeek(weeks, requested) {
  const today = todayIso();
  const recorded = weeks.length ? weeks[0].week : null;
  const dow = recorded === null ? 6 : weekdayOf(recorded);
  const current = lastWeekdayOnOrBefore(today, dow) || today;

  const wanted = ISO.test(String(requested || '')) ? String(requested) : null;
  const selected = wanted || recorded || current;

  return { selected, current, dow, inferred: recorded !== null, today };
}

function weekNav(selected, current, weeks, dow, inferred) {
  const recent = weeks.slice(0, 5);
  return html`<form method="get" action="/team" class="toolbar">
      <div class="search">
        <label class="sr-only" for="pick-week">Week ending</label>
        <input id="pick-week" type="date" name="week" value="${selected}">
      </div>
      <button class="btn btn--ghost btn--sm" type="submit">Go to week</button>
      <div class="segment" role="group" aria-label="Move a week">
        <a href="/team?week=${safe(encodeURIComponent(shiftIso(selected, -7) || ''))}">← Previous week</a>
        <a href="/team?week=${safe(encodeURIComponent(shiftIso(selected, 7) || ''))}">Next week →</a>
      </div>
      ${recent.length
        ? html`<div class="segment" role="group" aria-label="Weeks already recorded">
            ${join(
              recent.map(
                (w) => html`<a href="/team?week=${safe(encodeURIComponent(w.week))}"
                    ${safe(w.week === selected ? 'aria-current="true"' : '')}>${dateShort(w.week)}</a>`
              )
            )}
          </div>`
        : ''}
      <span class="count">
        Week ending ${DAY_NAME[dow] || 'MISSING'}${inferred ? '' : ' (assumed)'}${
          selected === current ? ' · this week' : ''
        }
      </span>
    </form>`;
}

// ============================================================================
// 5. THE LEDE — the gap, and the scale
// ============================================================================

function gapFigure(week, dbUp) {
  if (!dbUp) {
    return html`<div class="figure">
        <span class="cap">Self against manager</span>
        <strong class="big">${missing()}</strong>
        <p class="sub">
          The typed-records database did not answer, so no score can be read and none is invented. This is
          MISSING, not "nobody was scored" — an unscored week and an unreachable one look identical from a
          phone, and only one of them means somebody skipped the review.
        </p>
      </div>`;
  }

  const pairs = week ? week.pairs : [];
  if (!week || pairs.length === 0) {
    return html`<div class="figure">
        <span class="cap">Self against manager</span>
        <strong class="big">0<span class="caption"> paired scores</span></strong>
        <p class="sub">
          ${week && week.people.length
            ? html`<b>${num(week.people.length)}</b> ${week.people.length === 1 ? 'person has' : 'people have'} a
                record this week, but no one has both a self score and a manager score yet, and a gap needs two
                numbers. Enter the self scores first — that is step 1, and it is what unlocks the manager field.`
            : html`Nothing has been recorded for this week. That is a fact about the review, not about the
                database: the table answered and holds no row for this week ending.`}
        </p>
      </div>`;
  }

  const widest = week.widest;
  return html`<div class="figure">
      <span class="cap">Self minus manager, mean of ${String(pairs.length)} paired score${pairs.length === 1 ? '' : 's'}</span>
      <strong class="big">${signed(week.gapMean, { dp: 1 })}</strong>
      <p class="sub">
        ${week.gapMean > 0
          ? html`People are marking themselves <b>above</b> the manager's mark. That is the direction worth
              talking about: it says the standard being applied on each side is not the same one.`
          : week.gapMean < 0
            ? html`People are marking themselves <b>below</b> the manager's mark. Chronic under-marking hides
                good work and is its own coaching problem, in the opposite direction.`
            : html`Self and manager marks agree on average this week. Agreement is the goal, not the ceiling —
                check the individual rows, because two large gaps in opposite directions also average to zero.`}
        ${widest
          ? html` The widest single gap is <b>${widest.person}</b>: self ${num(widest.self)} against manager
              ${num(widest.manager)}.`
          : ''}
      </p>
    </div>
    ${why(
      'Why the gap, and not the score',
      html`<p>
          The score on its own is nearly uninformative — everyone drifts to 4, and a column of 4s cannot be
          acted on. The <strong>difference</strong> between what someone says about their week and what their
          manager says about the same week is a specific, checkable disagreement, and it is the thing a
          one-to-one can actually be about.
        </p>
        <p>
          <strong>This is a mean, not a rate.</strong> It is the average of
          ${num(pairs.length)} complete pairs — a census of the people who were reviewed this week, not an
          estimate drawn from a sample of them — so it carries no confidence interval and nothing here draws a
          bar. Rates on this page (promises kept, decisions called right) are a different kind of number and
          are printed as ranges, because they are proportions on single-figure denominators.
        </p>
        <p>
          A pair means one person with <em>both</em> numbers. ${num(week.selfN)} self score${week.selfN === 1 ? '' : 's'}
          and ${num(week.managerN)} manager score${week.managerN === 1 ? '' : 's'} were recorded this week; only
          ${num(pairs.length)} of those line up into a gap.
        </p>`
    )}`;
}

function scaleFigure() {
  return html`<div class="figure">
      <span class="cap">The scale</span>
      <strong class="mid">3 = normal</strong>
      <p class="sub">
        Not a disappointment. <b>Normal</b> is what a good week looks like, and it is where most marks should
        sit. Do not give a 4 just to make someone happy — a 4 that was not earned costs you the only signal
        this review produces.
      </p>
    </div>
    <dl class="stats">
      ${join(
        // The number is the figure and the word is its label, so the number
        // takes the `dd` — the serif, tabular slot the design system gives to
        // every figure on the page — and the word takes the `dt`.
        SCALE.map(
          (s) => html`<div class="stat">
            <dt>${s.word}</dt>
            <dd>${String(s.n)}</dd>
            ${s.n === 3 ? html`<span class="caption">The default. Aim here.</span>` : ''}
          </div>`
        )
      )}
    </dl>`;
}

// ============================================================================
// 6. THE REVIEW FORM — one per person, self score first
// ============================================================================

/** The self / manager selects. A blank option exists and is not "0": leaving a
 *  score unset stores NULL, which means "not scored", and that is a different
 *  fact from a 1. */
function scoreSelect({ id, name, value, disabled, roleLocked = false, describedBy }) {
  const current = scoreOf(value);
  return html`<select id="${id}" name="${name}"
      ${safe(disabled ? 'disabled' : '')}
      ${safe(roleLocked ? 'data-role-locked="1"' : '')}
      ${safe(describedBy ? `aria-describedby="${describedBy}"` : '')}>
      <option value="" ${safe(current === null ? 'selected' : '')}>Not scored</option>
      ${join(
        SCALE.map(
          (s) => html`<option value="${String(s.n)}" ${safe(current === s.n ? 'selected' : '')}>
              ${String(s.n)} · ${s.word}
            </option>`
        )
      )}
    </select>`;
}

/**
 * One person's row for the selected week.
 *
 * `locked` is the sequencing rule: no stored self score means the manager field
 * is disabled from the server, so the two-step survives with JavaScript off.
 * `outOfSequence` is the case the rule is supposed to make impossible — a
 * manager score with no self score behind it. It is never hidden and never
 * quietly deleted: the field is left open so it can be corrected, and the row
 * says what happened.
 *
 * A DISABLED CONTROL IS NOT SUBMITTED, WHICH IS HOW A LOCK ERASES DATA.
 *
 * The form carries every column and the write is an upsert that sets each one
 * from what was posted, so a field the browser omits is stored as NULL. The
 * role lock therefore had a hole with teeth: a CSR opening their own row to
 * edit a note saw the manager's score rendered and greyed, and saving the note
 * posted no `manager_score` at all — wiping the manager's mark, under the
 * CSR's name in the audit log. The lock is meant to stop a score being
 * ENTERED, never to delete one already there. So whenever the select is
 * disabled and a score exists, a hidden input carries the stored value back
 * unchanged. The sequence lock needs no mirror: it only ever engages when the
 * manager score is already null, and null round-tripping to null is correct.
 */
function personForm(person, row, { week, csrfToken, backTo, canScoreManager, isSelf }) {
  const self = scoreOf(row?.self_score);
  const manager = scoreOf(row?.manager_score);
  const outOfSequence = self === null && manager !== null;
  const locked = self === null && !outOfSequence;
  const managerDisabled = locked || !canScoreManager;
  const idBase = `p-${nameKey(person).replace(/[^a-z0-9]/g, '') || 'x'}`;

  const managerHint = !canScoreManager
    ? html`This is the manager's step. You are signed in with a CSR role, so the field is closed here — the
        hub records who made every write, and a score with the wrong name on it is worse than a missing one.`
    : locked
      ? html`Locked until the self score is saved. That is step 1 of the review and the reason both numbers
          exist — a manager mark entered first is a verdict, and a self mark typed under one is an argument
          with it.`
      : html`Now answer it. Mark the week you saw, not the one you were told about.`;

  return html`<form method="post" action="/team" data-review>
      <input type="hidden" name="_csrf" value="${csrfToken}">
      <input type="hidden" name="week_ending" value="${week}">
      <input type="hidden" name="person" value="${person}">
      <input type="hidden" name="back" value="${backTo}">

      <fieldset class="form-section">
        <legend>
          ${person}${isSelf ? ' — you' : ''}
          ${outOfSequence ? pill('warn', 'Out of sequence') : self !== null && manager !== null ? pill('ok', 'Both scores in') : self !== null ? pill('info', 'Awaiting manager') : pill('idle', 'Not started')}
        </legend>

        ${outOfSequence
          ? html`<p class="note note--warn">
              This row carries a manager score with no self score behind it, which the sequence is meant to
              prevent. The field is left open rather than wiped — ask for the self mark, enter it, and the two
              will line up into a gap.
            </p>`
          : ''}

        <div class="form-grid form-grid--two">
          <div class="field">
            <label for="${idBase}-self">Step 1 · Self score <span class="req">*</span></label>
            ${scoreSelect({ id: `${idBase}-self`, name: 'self_score', value: self, disabled: false, describedBy: `${idBase}-self-h` })}
            <p class="field-hint" id="${idBase}-self-h">
              Asked first, always. 3 is normal.
            </p>
          </div>

          <div class="field">
            <label for="${idBase}-mgr">Step 2 · Manager score</label>
            ${scoreSelect({
              id: `${idBase}-mgr`,
              name: 'manager_score',
              value: manager,
              disabled: managerDisabled,
              roleLocked: !canScoreManager,
              describedBy: `${idBase}-mgr-h`,
            })}
            ${managerDisabled && manager !== null
              ? html`<input type="hidden" name="manager_score" value="${String(manager)}">`
              : ''}
            <p class="field-hint" id="${idBase}-mgr-h">${managerHint}</p>
          </div>

          <div class="field">
            <label for="${idBase}-prev">Last week's promise</label>
            <select id="${idBase}-prev" name="prev_promise_done">
              <option value="" ${safe(!PROMISE_BY_VALUE[String(row?.prev_promise_done)] ? 'selected' : '')}>Not answered</option>
              ${join(
                PROMISE.map(
                  (p) => html`<option value="${p.value}" ${safe(row?.prev_promise_done === p.value ? 'selected' : '')}>${p.label}</option>`
                )
              )}
            </select>
            <p class="field-hint">Blank means nobody answered, which is not the same as "not kept".</p>
          </div>

          <div class="field">
            <label for="${idBase}-promise">Promise for next week</label>
            <textarea id="${idBase}-promise" name="promise" rows="3"
              placeholder="One thing, checkable next Friday.">${row?.promise ?? ''}</textarea>
            <p class="field-hint">If it cannot be answered yes or no in seven days, it is a wish.</p>
          </div>
        </div>

        <div class="field">
          <label for="${idBase}-note">Note</label>
          <textarea id="${idBase}-note" name="note" rows="3"
            placeholder="What actually happened this week.">${row?.note ?? ''}</textarea>
          <p class="field-hint">
            The note is what makes the score reviewable six months later. A number with no note is a mood.
          </p>
        </div>

        <div class="form-actions">
          <button class="btn" type="submit">Save ${person}</button>
          <span class="form-status">
            ${row
              ? html`Last saved by ${row.recorded_by || missing()} · ${dateTimeShort(row.updated_at)}`
              : 'Nothing recorded for this person this week.'}
          </span>
        </div>
      </fieldset>
    </form>`;
}

/** Enable the manager field the moment a self score is chosen — and put it back
 *  when the self score is cleared, so the stored pair can never end up with a
 *  manager mark and no self mark behind it. Without JavaScript the server has
 *  already rendered the same lock and the review is a genuine two-step. */
const REVIEW_JS = `
(function(){
  'use strict';
  var forms = document.querySelectorAll('form[data-review]');
  Array.prototype.forEach.call(forms, function(form){
    // querySelector, NOT form.elements: a role-locked row carries a hidden
    // input mirroring the stored manager score, so form.elements['manager_score']
    // is a RadioNodeList there and every property read below would throw.
    var self = form.querySelector('select[name="self_score"]');
    var mgr  = form.querySelector('select[name="manager_score"]');
    if (!self || !mgr) return;
    // A field the SERVER locked for a ROLE, not for the sequence, stays locked.
    if (mgr.getAttribute('data-role-locked') === '1') return;
    function sync(){
      var has = String(self.value || '') !== '';
      mgr.disabled = !has;
      if (!has) mgr.value = '';
      var hint = document.getElementById(mgr.getAttribute('aria-describedby') || '');
      if (hint) hint.textContent = has
        ? 'Unlocked. Now answer it \\u2014 mark the week you saw, not the one you were told about.'
        : 'Locked until the self score is entered. That is step 1 of the review.';
    }
    self.addEventListener('change', sync);
    self.addEventListener('input', sync);
  });
})();
`;

// ============================================================================
// 7. THE WEEK'S TABLE
// ============================================================================

function weekTable(week, roster) {
  if (!week || week.people.length === 0) {
    return empty('No review has been recorded for this week ending. The forms above are how it starts.');
  }

  const rosterKeys = new Set((roster || []).map((p) => nameKey(p.name)));

  const rows = join(
    week.people.map((p) => {
      const self = scoreOf(p.self_score);
      const manager = scoreOf(p.manager_score);
      const gap = self !== null && manager !== null ? self - manager : null;
      const promise = PROMISE_BY_VALUE[String(p.prev_promise_done)] || null;
      const offRoster = roster && !rosterKeys.has(nameKey(p.person));

      return html`<tr class="${gap !== null && Math.abs(gap) >= 2 ? 'row-attn' : ''}">
        <td>
          <span class="cell-name">${p.person}</span>
          ${offRoster ? html`<span class="cell-sub">not in the current programme</span>` : ''}
        </td>
        <td>${scoreMarks(p.self_score, 'self')}</td>
        <td>${scoreMarks(p.manager_score, 'manager')}</td>
        <td class="r cell-figure">${gap === null ? missing() : signed(gap, { dp: 0 })}</td>
        <td>${promise ? pill(promise.tone, promise.label) : missing()}</td>
        <td>
          ${p.note ? html`<span class="cell-sub">${p.note}</span>` : html`<span class="cell-sub">${missing()}</span>`}
          ${p.promise ? html`<span class="cell-sub">→ ${p.promise}</span>` : ''}
        </td>
        <td><span class="cell-sub">${p.recorded_by || missing()}</span></td>
      </tr>`;
    })
  );

  return html`<div class="tablewrap">
      <table class="table table--wide">
        <thead>
          <tr>
            <th>Person</th><th>Self</th><th>Manager</th><th class="r">Gap</th>
            <th>Last promise</th><th>Note &amp; next promise</th><th>Recorded by</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="tablehint" aria-hidden="true">Scroll sideways for more columns →</p>
    </div>
    <p class="caption">
      Grey marks are the self score, accent marks are the manager's. A gap of two points or more is flagged on
      the row — not because it is wrong, but because two people looking at the same week and landing two points
      apart is the conversation this review exists to produce.
    </p>`;
}

// ============================================================================
// 8. HISTORY — one row per week
// ============================================================================

function historyTable(weeks, selected) {
  if (weeks.length === 0) return empty('No week has been recorded yet.');

  const rows = join(
    weeks.map((w) => {
      const kept = rate(w.promiseKept, w.promiseAnswered);
      return html`<tr class="${w.week === selected ? 'row-attn' : ''}">
        <td>
          <a href="/team?week=${safe(encodeURIComponent(w.week))}">${dateShort(w.week, { year: true })}</a>
          <span class="cell-sub">${String(w.people.length)} recorded</span>
        </td>
        <td class="r cell-figure">${w.selfMean === null ? missing() : num(w.selfMean, { dp: 1 })}</td>
        <td class="r cell-figure">${w.managerMean === null ? missing() : num(w.managerMean, { dp: 1 })}</td>
        <td class="r cell-figure">${w.gapMean === null ? missing() : signed(w.gapMean, { dp: 1 })}</td>
        <td class="r">${String(w.pairs.length)}</td>
        <td>
          ${kept.ok ? kept.html : missing()}
          <span class="cell-sub">${kept.ok ? `${w.promiseKept} of ${w.promiseAnswered} answered` : 'nobody answered'}</span>
        </td>
      </tr>`;
    })
  );

  return html`<div class="tablewrap tablewrap--capped">
      <table class="table">
        <thead>
          <tr>
            <th>Week ending</th><th class="r">Mean self</th><th class="r">Mean manager</th>
            <th class="r">Mean gap</th><th class="r">Pairs</th><th>Promises kept</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="tablehint" aria-hidden="true">Scroll sideways for more columns →</p>
    </div>
    <p class="caption">
      Means are a census of whoever was reviewed that week, so they carry no interval. The promise-kept column
      IS a rate, on a denominator of the people who answered the question at all, so it prints as a Wilson
      range below n=${String(MIN_SAMPLE)} — which, on a team this size, is every week.
    </p>`;
}

// ============================================================================
// 9. THE ROSTER MISMATCH
// ============================================================================
//
// Counted live from the `csr` column of the engine's two files. This is a
// count of published rows, not a recomputation of anything the engine
// published, and it is the only honest way to answer "who is actually doing
// the work" — the review sheet cannot answer it, because the review sheet is
// one of the two lists that disagree.

function engineWorkload() {
  const orders = engineOrders();
  const leads = engineLeads();
  const map = new Map();
  // Rows whose `csr` cell is empty. Counted rather than dropped: a workload
  // table whose parts quietly fall short of the order book is the same failure
  // as a money total that silently omits the unpriced orders.
  const unattributed = { orders: 0, inquiries: 0 };

  const bump = (raw, field, dateRaw) => {
    const key = nameKey(raw);
    if (!key) {
      unattributed[field] += 1;
      return;
    }
    if (!map.has(key)) {
      map.set(key, { key, display: String(raw).trim(), orders: 0, inquiries: 0, first: null, last: null });
    }
    const entry = map.get(key);
    entry[field] += 1;
    const date = isoOf(dateRaw);
    if (date) {
      if (entry.first === null || date < entry.first) entry.first = date;
      if (entry.last === null || date > entry.last) entry.last = date;
    }
  };

  if (!isMissing(orders)) for (const row of orders) bump(row?.csr, 'orders', row?.order_date);
  if (!isMissing(leads)) for (const row of leads) bump(row?.csr, 'inquiries', row?.date);

  return {
    map,
    unattributed,
    ordersAvailable: !isMissing(orders),
    leadsAvailable: !isMissing(leads),
    orderRows: isMissing(orders) ? null : orders.length,
    leadRows: isMissing(leads) ? null : leads.length,
  };
}

function rosterPanel(people, workload) {
  const available = workload.ordersAvailable || workload.leadsAvailable;

  if (people === null) {
    return html`<section class="panel">
        ${panelHead('Who is in the programme, and who is doing the work', 'missing', 'app_user unreachable')}
        <div class="figure">
          <span class="cap">The review roster</span>
          <strong class="mid">${missing()}</strong>
          <p class="sub">
            The roster lives in <code class="mono">app_user</code> and the database did not answer, so the two
            lists cannot be put side by side. The engine's side of the comparison is still readable — see the
            names below — but which of them are reviewed is unknown, and unknown is not "none".
          </p>
        </div>
        ${available ? workloadTable([...workload.map.values()].sort(byWork), null) : ''}
      </section>`;
  }

  const active = people.filter((p) => Number(p.active) === 1);
  const retired = people.filter((p) => Number(p.active) !== 1);
  const activeKeys = new Set(active.map((p) => nameKey(p.name)));
  const retiredByKey = new Map(retired.map((p) => [nameKey(p.name), p]));

  const inProgramme = active.map((p) => {
    const found = workload.map.get(nameKey(p.name));
    return {
      name: p.name,
      role: p.role,
      orders: found ? found.orders : 0,
      inquiries: found ? found.inquiries : 0,
      first: found ? found.first : null,
      last: found ? found.last : null,
      invisible: !found,
    };
  });

  const outside = [...workload.map.values()]
    .filter((w) => !activeKeys.has(w.key))
    .map((w) => ({ ...w, retired: retiredByKey.has(w.key) }))
    .sort(byWork);

  const invisible = inProgramme.filter((p) => p.invisible);
  const outsideOrders = outside.reduce((n, w) => n + w.orders, 0);
  const insideOrders = inProgramme.reduce((n, w) => n + w.orders, 0);

  return html`<section class="panel">
      ${panelHead(
        'Who is in the programme, and who is doing the work',
        available ? 'live' : 'missing',
        available ? 'Typed roster · engine csr column' : 'Engine files unreadable'
      )}

      <div class="figure">
        <span class="cap">Orders handled by people nobody reviews</span>
        <strong class="mid">${available ? num(outsideOrders) : missing()}</strong>
        <p class="sub">
          ${available
            ? html`<b>${num(outside.length)}</b> name${outside.length === 1 ? '' : 's'} appear in the order book or
                the inquiry log and are not in the weekly review, between them handling ${num(outsideOrders)}
                orders — against ${num(insideOrders)} handled by the ${num(inProgramme.length)} people who are
                reviewed every week.
                ${invisible.length
                  ? html` In the other direction,
                      ${invisible.length === 1
                        ? html`one person is reviewed weekly and appears`
                        : html`<b>${num(invisible.length)}</b> people are reviewed weekly and appear`}
                      nowhere in the engine's data at all:
                      ${join(invisible.map((p) => html`<b>${p.name}</b>`), ', ')}.`
                  : ''}
                ${workload.unattributed.orders || workload.unattributed.inquiries
                  ? html` A further ${num(workload.unattributed.orders)} orders and
                      ${num(workload.unattributed.inquiries)} inquiries carry no CSR at all and belong to nobody
                      in either column.`
                  : ''}`
            : html`Neither <code class="mono">orders.jsonl</code> nor <code class="mono">leads.jsonl</code> could
                be read, so the comparison cannot be made. The roster below is what the hub knows; the other
                half of the answer is MISSING.`}
        </p>
      </div>

      ${why(
        'What this is, and what it is not',
        html`<p>
            This is the same shape as the finding that started this build: two systems each holding part of the
            truth, neither aware of the other. The review sheet is one list of names; the <code class="mono">csr</code>
            column of the order book and the inquiry log is another; they were never compared because nobody
            owned both.
          </p>
          <p>
            <strong>It is not an accusation and it does not resolve itself.</strong> A name in the data and not
            in the review may be a former colleague, an agency partner, another team, or a different spelling of
            somebody who is reviewed. A name in the review and not in the data may work entirely off-platform.
            The hub reports the disagreement and records what a human decides about it; it never edits a name to
            make two lists agree, because that is how the disagreement stops being visible without stopping
            being true.
          </p>
          <p>
            Matching is exact on the trimmed, case-folded name and nothing looser. One character of fuzziness
            would attach one person's order history to another's weekly score, which is a worse error than the
            one it would paper over.
          </p>`
      )}

      <div class="block">
        <h3>In the review programme</h3>
        <div class="tablewrap">
          <table class="table table--narrow">
            <thead>
              <tr><th>Person</th><th>Role</th><th class="r">Orders</th><th class="r">Inquiries</th><th>Seen in the data</th></tr>
            </thead>
            <tbody>
              ${join(
                inProgramme.map(
                  (p) => html`<tr class="${p.invisible ? 'row-attn' : ''}">
                    <td><span class="cell-name">${p.name}</span></td>
                    <td>${p.role}</td>
                    <td class="r cell-figure">${available ? num(p.orders) : missing()}</td>
                    <td class="r cell-figure">${available ? num(p.inquiries) : missing()}</td>
                    <td>
                      ${!available
                        ? missing()
                        : p.invisible
                          ? pill('warn', 'Never')
                          : html`${dateShort(p.first, { year: true })} – ${dateShort(p.last, { year: true })}`}
                    </td>
                  </tr>`
                )
              )}
            </tbody>
          </table>
          <p class="tablehint" aria-hidden="true">Scroll sideways for more columns →</p>
        </div>
      </div>

      ${available
        ? html`<div class="block">
            <h3>Doing the work, not in the programme</h3>
            ${outside.length ? workloadTable(outside, retiredByKey) : empty('Everyone in the data is reviewed.')}
            <p class="caption">
              "Retired here" means the name exists in <code class="mono">app_user</code> and was deactivated —
              deliberately kept rather than deleted, because deleting a name orphans every order attributed to
              it and makes the past unexplainable. "Not known here" means the name appears in the engine's data
              and has never been added to the hub at all.
            </p>
          </div>`
        : ''}
    </section>`;
}

function byWork(a, b) {
  if (b.orders !== a.orders) return b.orders - a.orders;
  if (b.inquiries !== a.inquiries) return b.inquiries - a.inquiries;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

function workloadTable(rows, retiredByKey) {
  return html`<div class="tablewrap tablewrap--capped">
      <table class="table table--narrow">
        <thead>
          <tr><th>Name in the data</th><th class="r">Orders</th><th class="r">Inquiries</th><th>Active</th><th>Known here</th></tr>
        </thead>
        <tbody>
          ${join(
            rows.map(
              (w) => html`<tr>
                <td><span class="cell-name">${w.display}</span></td>
                <td class="r cell-figure">${num(w.orders)}</td>
                <td class="r cell-figure">${num(w.inquiries)}</td>
                <td><span class="cell-sub">${dateShort(w.first, { year: true })} – ${dateShort(w.last, { year: true })}</span></td>
                <td>
                  ${retiredByKey === null
                    ? missing()
                    : retiredByKey.has(w.key)
                      ? pill('idle', 'Retired here')
                      : pill('warn', 'Not known here')}
                </td>
              </tr>`
            )
          )}
        </tbody>
      </table>
      <p class="tablehint" aria-hidden="true">Scroll sideways for more columns →</p>
    </div>`;
}

// ============================================================================
// 10. THE DECISIONS LOG
// ============================================================================
//
// What I decided · what I expected · what happened · was I right. Four columns,
// and the fourth is the only one that ever changes a habit.

function decisionsPanel(decisions, { csrfToken, backTo, today }) {
  if (decisions === null) {
    return html`<section class="panel">
        ${panelHead('Decisions — was I right', 'missing', 'decision unreachable')}
        <div class="figure">
          <span class="cap">Decisions on the record</span>
          <strong class="mid">${missing()}</strong>
          <p class="sub">
            The typed-records database did not answer. The log is unreadable, not empty, and the form is closed
            rather than shown: a form that cannot read what is already there is a form that overwrites it blind.
          </p>
        </div>
      </section>`;
  }

  const rows = decisions.map((d) => ({ ...d, iso: isoOf(d.decided_on), verdict: String(d.was_right || 'pending') }));
  const yes = rows.filter((d) => d.verdict === 'yes').length;
  const no = rows.filter((d) => d.verdict === 'no').length;
  const partly = rows.filter((d) => d.verdict === 'partly').length;
  const pending = rows.filter((d) => d.verdict === 'pending').length;
  const called = rate(yes, yes + no);

  const table = rows.length
    ? html`<div class="tablewrap tablewrap--capped">
        <table class="table table--wide">
          <thead>
            <tr><th>Decided</th><th>What I decided</th><th>What I expected</th><th>What happened</th><th>Was I right</th></tr>
          </thead>
          <tbody>
            ${join(
              rows.map((d) => {
                const v = VERDICT_BY_VALUE[d.verdict] || VERDICT_BY_VALUE.pending;
                return html`<tr class="${d.verdict === 'no' ? 'row-late' : ''}">
                  <td>
                    ${dateShort(d.iso, { year: true })}
                    <span class="cell-sub">${d.author || missing()}</span>
                  </td>
                  <td><span class="cell-name">${d.what}</span></td>
                  <td>${d.expected ? html`<span class="cell-sub">${d.expected}</span>` : missing()}</td>
                  <td>${d.actual ? html`<span class="cell-sub">${d.actual}</span>` : missing()}</td>
                  <td>${pill(v.tone, v.label)}</td>
                </tr>`;
              })
            )}
          </tbody>
        </table>
        <p class="tablehint" aria-hidden="true">Scroll sideways for more columns →</p>
      </div>`
    : empty('Nothing has been logged yet. The first entry is the cheapest one you will ever make.');

  const newForm = html`<form method="post" action="/team/decision">
      <input type="hidden" name="_csrf" value="${csrfToken}">
      <input type="hidden" name="back" value="${backTo}">
      <fieldset class="form-section">
        <legend>Log a decision</legend>
        <div class="form-grid form-grid--two">
          <div class="field">
            <label for="d-on">Decided on</label>
            <input id="d-on" type="date" name="decided_on" value="${today}">
            <p class="field-hint">The day the call was made, not the day it was written down.</p>
          </div>
          <div class="field">
            <label for="d-right">Was I right</label>
            <select id="d-right" name="was_right">
              ${join(
                VERDICT.map(
                  (v) => html`<option value="${v.value}" ${safe(v.value === 'pending' ? 'selected' : '')}>${v.label}</option>`
                )
              )}
            </select>
            <p class="field-hint">Almost always "not yet known" at the moment of deciding. That is the point.</p>
          </div>
        </div>
        <div class="field">
          <label for="d-what">What I decided <span class="req">*</span></label>
          <textarea id="d-what" name="what" rows="3" placeholder="One decision, in one sentence."></textarea>
        </div>
        <div class="field">
          <label for="d-expected">What I expected</label>
          <textarea id="d-expected" name="expected" rows="3"
            placeholder="What should be true if this was the right call, and by when."></textarea>
          <p class="field-hint">
            If you cannot say what would prove it wrong, it is not a prediction and it cannot be scored later.
          </p>
        </div>
        <div class="form-actions">
          <button class="btn" type="submit">Log it</button>
          <span class="form-status">Written with your name against it.</span>
        </div>
      </fieldset>
    </form>`;

  const resolveForm = rows.length
    ? html`<form method="post" action="/team/decision">
        <input type="hidden" name="_csrf" value="${csrfToken}">
        <input type="hidden" name="back" value="${backTo}">
        <fieldset class="form-section">
          <legend>Say what happened</legend>
          <div class="form-grid form-grid--two">
            <div class="field">
              <label for="r-id">Which decision <span class="req">*</span></label>
              <select id="r-id" name="id">
                ${join(
                  rows.map(
                    (d) => html`<option value="${String(d.id)}">
                        ${d.iso || 'undated'} · ${String(d.what || '').slice(0, 70)}
                      </option>`
                  )
                )}
              </select>
              <p class="field-hint">${String(pending)} still open.</p>
            </div>
            <div class="field">
              <label for="r-right">Was I right</label>
              <select id="r-right" name="was_right">
                ${join(VERDICT.map((v) => html`<option value="${v.value}">${v.label}</option>`))}
              </select>
            </div>
          </div>
          <div class="field">
            <label for="r-actual">What happened</label>
            <textarea id="r-actual" name="actual" rows="3" placeholder="What actually happened, and how you know."></textarea>
            <p class="field-hint">
              This replaces whatever is already in the row for that decision. The original decision and the
              expectation are never overwritten — only the outcome is.
            </p>
          </div>
          <div class="form-actions">
            <button class="btn btn--ghost" type="submit">Record the outcome</button>
          </div>
        </fieldset>
      </form>`
    : '';

  return html`<section class="panel">
      ${panelHead('Decisions — was I right', 'typed', 'Typed here · MySQL')}
      <div class="lede">
        <div class="lede-main">
          <div class="figure">
            <span class="cap">Called right, of the decisions with a clear answer</span>
            <strong class="big">${called.ok ? called.html : missing()}</strong>
            <p class="sub">
              <b>${num(yes)}</b> right and <b>${num(no)}</b> wrong out of ${num(rows.length)} logged.
              ${num(partly)} came out partly, and ${num(pending)} ${pending === 1 ? 'has' : 'have'} no answer
              yet.
            </p>
          </div>
          ${why(
            'Why "partly" is not in that number, and why it is a range',
            html`<p>
                <strong>Partly is excluded from the denominator, not scored as a half.</strong> A half-right
                outcome is not a coin landing on its edge — it is usually a decision that was never sharp
                enough to be scored, and folding it in at 0.5 would let vague calls quietly improve the record.
                It is counted and shown separately so the vagueness stays visible.
              </p>
              <p>
                The figure is a <strong>range</strong> because it is a rate on a denominator far under
                ${String(MIN_SAMPLE)}. At this size the honest interval spans most of the axis, and a single
                point estimate would read as a track record it has not earned yet. It narrows by logging more
                decisions, not by rounding.
              </p>`
          )}
        </div>
        <div class="lede-side">${calibrationFigure()}</div>
      </div>
      ${table}
      ${newForm}
      ${resolveForm}
    </section>`;
}

/**
 * The engine's own scorecard, beside the human one.
 *
 * It belongs here because it answers the same question about the same person:
 * the engine states a confidence on every forecast, resolves it on a date, and
 * records what actually happened. Its medium-confidence band is the most useful
 * thing on this page — stated confidence and realised accuracy are not the same
 * number, and knowing that is the whole reason for a "was I right" column.
 */
function calibrationFigure() {
  const cal = engineCalibration();
  const bands = pick(cal, 'by_confidence');
  if (isMissing(bands) || !bands || typeof bands !== 'object') {
    return html`<div class="figure">
        <span class="cap">The engine's own record</span>
        <strong class="mid">${missing()}</strong>
        <p class="sub">
          <code class="mono">calibration.json</code> could not be read, so the engine's realised accuracy is
          unknown. Nothing typed on this page is affected.
        </p>
      </div>`;
  }

  const order = ['high', 'medium', 'low'];
  const rowsOut = order
    .filter((k) => bands[k] && Number.isFinite(Number(bands[k].n)) && Number(bands[k].n) > 0)
    .map((k) => {
      const band = bands[k];
      const n = Number(band.n);
      // k is reconstructed as realised × n. The engine stores the fraction and
      // the denominator; this recovers the integer it came from exactly, and it
      // is stated here rather than presented as if it had been published.
      const hits = Math.round(Number(band.realised) * n);
      return { key: k, n, nominal: Number(band.nominal), realised: Number(band.realised), hits, r: rate(hits, n) };
    });

  const medium = rowsOut.find((r) => r.key === 'medium') || rowsOut[0] || null;

  return html`<div class="figure">
      <span class="cap">
        ${medium
          ? html`What the engine's ${medium.key}-confidence forecasts actually did`
          : "The engine's own record"}
      </span>
      <strong class="mid">${medium && medium.r.ok ? medium.r.html : missing()}</strong>
      <p class="sub">
        ${medium
          ? html`They claimed <b>${num(medium.nominal * 100, { dp: 0 })}%</b> and landed inside the stated
              interval that often, across ${num(medium.n)} resolved forecasts. Stated confidence is a claim;
              realised accuracy is a measurement, and the two are allowed to disagree until enough of them
              resolve. That gap is the same one the column on the left exists to find in a person.`
          : 'No confidence band has enough resolved forecasts to report.'}
      </p>
    </div>
    ${rowsOut.length
      ? html`<dl class="stats">
          ${join(
            rowsOut.map(
              (r) => html`<div class="stat">
                <dt>${r.key} · said ${String(Math.round(r.nominal * 100))}%</dt>
                <dd>${r.r.ok ? r.r.html : missing()}</dd>
                <span class="caption">${String(r.hits)} of ${String(r.n)} resolved</span>
              </div>`
            )
          )}
        </dl>`
      : ''}
    ${why(
      'Where these come from, and how to read them',
      html`<p>
          The engine writes every forecast to a ledger with a resolution date and a metric path, resolves
          whatever is due on each run, and scores it. Interval widths for future forecasts are derived from
          the realised coverage above, so stated confidence converges on real accuracy instead of on
          confidence.
        </p>
        <p>
          The hit counts are recovered as realised × n from the engine's own published fraction and
          denominator — an exact reconstruction of the integer behind them, stated so that nobody mistakes it
          for a figure the engine emitted directly. Each band is a rate on a small denominator, so each one
          prints as a range.
        </p>
        <p>
          <strong>A miss that changes nothing is a wasted miss.</strong> That applies to the column on the
          left as much as to the ledger on the right: the point of writing down what you expected is to be
          told, later and specifically, that you were wrong about it.
        </p>`
    )}`;
}

// ============================================================================
// 11. SECTION ACCESS — owner only, and it is the one lock that is enforced
// ============================================================================

function accessPanel(ctx) {
  if (ctx.user?.role !== 'owner') return '';

  const sections = ctx.nav || [];
  // `undefined` (the loader does not select section_access today) and `null`
  // (it did and the database refused) are both "this page cannot state the
  // minimum role" — collapsed here so the column never contradicts the State
  // column beside it by printing "csr" next to "Restricted".
  const stored = rowsOf(ctx.data?.access) ?? null;
  const byKey = new Map((stored || []).map((r) => [String(r.section), r]));
  const backTo = '/team';

  return html`<section class="panel">
      ${panelHead('Section access', 'typed', 'Typed here · MySQL · owner only')}
      <div class="figure">
        <span class="cap">Sections restricted to a manager or the owner</span>
        <strong class="mid">${num(sections.filter((s) => s.locked).length)}<span class="caption"> of ${String(sections.length)}</span></strong>
        <p class="sub">
          This page carries every score, every note and every promise the team has made about each other. It is
          the most likely section to want closed, and closing it takes a row in a table rather than a deploy.
        </p>
      </div>

      <div class="tablewrap">
        <table class="table table--narrow">
          <thead><tr><th>Section</th><th>State</th><th>Minimum role</th></tr></thead>
          <tbody>
            ${join(
              sections.map((s) => {
                const rule = byKey.get(s.key) || null;
                return html`<tr class="${s.locked ? 'row-attn' : ''}">
                  <td><span class="cell-name">${s.label}</span><span class="cell-sub">${s.href}</span></td>
                  <td>${s.locked ? pill('warn', 'Restricted') : pill('ok', 'Open to everyone')}</td>
                  <td>
                    ${rule
                      ? html`${rule.min_role}
                          <span class="cell-sub">by ${rule.locked_by || missing()} · ${dateShort(isoOf(rule.locked_at))}</span>`
                      : stored === null
                        ? html`${s.locked ? 'above csr' : 'csr'}<span class="cell-sub">exact role not loaded on this page</span>`
                        : 'csr'}
                  </td>
                </tr>`;
              })
            )}
          </tbody>
        </table>
        <p class="tablehint" aria-hidden="true">Scroll sideways for more columns →</p>
      </div>

      <form method="post" action="/access">
        <input type="hidden" name="_csrf" value="${ctx.csrfToken}">
        <input type="hidden" name="back" value="${backTo}">
        <fieldset class="form-section">
          <legend>Change who may open a section</legend>
          <div class="form-grid form-grid--two">
            <div class="field">
              <label for="a-section">Section</label>
              <select id="a-section" name="section">
                ${join(
                  sections.map(
                    (s) => html`<option value="${s.key}" ${safe(s.key === 'team' ? 'selected' : '')}>${s.label}</option>`
                  )
                )}
              </select>
            </div>
            <div class="field">
              <label for="a-role">Minimum role</label>
              <select id="a-role" name="min_role">
                <option value="csr">csr — open to everyone who can sign in</option>
                <option value="manager">manager — managers and the owner</option>
                <option value="owner">owner — Ezan only</option>
              </select>
              <p class="field-hint">Setting csr removes the restriction entirely.</p>
            </div>
          </div>
          <div class="field">
            <label for="a-reason">Reason</label>
            <input id="a-reason" name="reason" type="text" maxlength="200"
              placeholder="Shown on the locked page, so nobody thinks the hub is broken.">
          </div>
          <div class="form-actions">
            <button class="btn" type="submit">Apply</button>
            <span class="form-status">A locked section still appears in the rail, marked LOCKED.</span>
          </div>
        </fieldset>
      </form>

      ${why(
        'Why a locked section is still visible',
        html`<p>
            A section that vanishes makes people think the hub is broken and file a bug. A section that says it
            is restricted, who restricted it and why, answers the question before it is asked. That is the same
            reason a missing figure renders MISSING instead of disappearing.
          </p>
          <p>
            This is the one restriction on this page that the server actually enforces. The manager-score lock
            above is a <em>process</em> rule: it shapes the order the review is done in, and every write here
            carries the name of whoever made it — the hub attributes rather than prevents, and it says so
            rather than implying a boundary it does not have.
          </p>`
      )}
    </section>`;
}

// ============================================================================
// 12. RENDER
// ============================================================================

export function render(ctx) {
  const weeksRows = rowsOf(ctx.data?.weeks);
  const peopleRows = rowsOf(ctx.data?.people);
  const decisionRows = rowsOf(ctx.data?.decisions);

  const dbUp = Array.isArray(weeksRows);
  const weeks = dbUp ? groupWeeks(weeksRows) : [];
  const { selected, current, dow, inferred, today } = chooseWeek(weeks, ctx.query?.week);
  const week = weeks.find((w) => w.week === selected) || null;

  const roster = Array.isArray(peopleRows) ? peopleRows.filter((p) => Number(p.active) === 1) : null;
  const canScoreManager = ['manager', 'owner'].includes(ctx.user?.role || '');
  const backTo = `/team?week=${encodeURIComponent(selected)}`;
  const workload = engineWorkload();

  // Everyone who should have a row this week: the current roster, widened by
  // anyone already recorded against this week. Never narrower than what exists —
  // a person taken off the roster mid-quarter must not make their own saved
  // review disappear from the week it belongs to.
  const names = [];
  const seen = new Set();
  for (const p of roster || []) {
    const key = nameKey(p.name);
    if (key && !seen.has(key)) {
      seen.add(key);
      names.push(String(p.name));
    }
  }
  for (const row of week?.people || []) {
    const key = nameKey(row.person);
    if (key && !seen.has(key)) {
      seen.add(key);
      names.push(row.person);
    }
  }

  const rowFor = (person) =>
    (week?.people || []).find((r) => nameKey(r.person) === nameKey(person)) || null;

  const reviewed = week ? week.people.filter((p) => scoreOf(p.self_score) !== null).length : 0;
  const keptRate = week ? rate(week.promiseKept, week.promiseAnswered) : rate(0, 0);

  // ---- the forms, or the reason there are none ------------------------------

  const forms = !dbUp
    ? html`<p class="note note--neg">
        ${glyph('crit')} <strong>The review is closed while the typed-records database is unreachable.</strong>
        It cannot be shown filled in, and a blank form that saves would overwrite a real week with nothing.
        Everything on this page that reads from <code class="mono">data/</code> is unaffected.
      </p>`
    : names.length === 0
      ? empty(
          'There is nobody to review: no active person is recorded in app_user, and nobody has been scored for this week.'
        )
      : join(
          names.map((person) =>
            personForm(person, rowFor(person), {
              week: selected,
              csrfToken: ctx.csrfToken,
              backTo,
              canScoreManager,
              isSelf: nameKey(person) === nameKey(ctx.user?.name),
            })
          )
        );

  // ---- the page -------------------------------------------------------------

  const body = html`${weekNav(selected, current, weeks, dow, inferred)}

    <div class="lede">
      <div class="lede-main">${gapFigure(week, dbUp)}</div>
      <div class="lede-side">${scaleFigure()}</div>
    </div>

    <section class="panel">
      ${panelHead(
        html`The review — week ending ${dateShort(selected, { year: true })}`,
        dbUp ? 'typed' : 'missing',
        dbUp ? 'Typed here · MySQL' : 'team_week unreachable'
      )}
      ${roster === null && dbUp
        ? html`<p class="note note--warn">
            The roster in <code class="mono">app_user</code> could not be read, so this week shows only the
            people already recorded against it. Somebody missing from the list is missing from the read, not
            necessarily from the team.
          </p>`
        : ''}
      <p class="note">
        ${glyph('info')} <strong>Self score first, every time.</strong> The manager field stays locked until the
        self score is in, because the value of this review is the difference between two independent answers to
        the same question — and a mark that was allowed to see the other one first is not independent.
      </p>
      ${forms}
    </section>

    <section class="panel">
      ${panelHead(
        html`Self against manager — ${dateShort(selected)}`,
        dbUp ? 'typed' : 'missing',
        dbUp ? 'Typed here · MySQL' : 'team_week unreachable'
      )}
      ${dbUp ? weekTable(week, roster) : empty('MISSING — the store did not answer.')}
    </section>

    <section class="panel">
      ${panelHead('Every week recorded', dbUp ? 'typed' : 'missing', dbUp ? 'Typed here · MySQL' : 'team_week unreachable')}
      ${dbUp
        ? historyTable(weeks, selected)
        : html`<p class="note note--neg">The history is MISSING, not empty. Nothing has been lost — it could not be read.</p>`}
    </section>

    ${rosterPanel(peopleRows === undefined ? null : peopleRows, workload)}

    ${decisionsPanel(decisionRows === undefined ? null : decisionRows, {
      csrfToken: ctx.csrfToken,
      backTo,
      today,
    })}

    ${accessPanel(ctx)}

    <div class="provenance-bar">
      <span>Scores, notes, promises and decisions — typed here, stored in <code class="mono">team_week</code> and <code class="mono">decision</code>.</span>
      <span>Order and inquiry counts — engine output, read from <code class="mono">data/</code>.</span>
      <span>Every save carries the name of whoever made it.</span>
    </div>

    <script nonce="${ctx.nonce}">${safe(REVIEW_JS)}</script>`;

  // ---- the slug: the finding, not the section name --------------------------

  const title = !dbUp
    ? 'The weekly review could not be read'
    : week && week.pairs.length
      ? `Self scores run ${plainSigned(week.gapMean)} against the manager's, on ${week.pairs.length} paired score${week.pairs.length === 1 ? '' : 's'}`
      : week && week.people.length
        ? `${week.people.length} recorded this week, no pair to compare yet`
        : 'No review recorded for this week';

  return {
    title,
    kicker: dbUp ? `Week ending ${selected}` : 'Team · store unreachable',
    deck: html`The score is not the signal. The <em>gap</em> between what someone says about their week and
      what their manager says about it is — and 3 is normal.`,
    ticker: [
      { label: 'Week ending', value: dateShort(selected, { year: true }), sub: selected === current ? 'this week' : null },
      {
        label: 'Self-scored',
        value: dbUp ? html`${count(reviewed)} / ${count(names.length)}` : missing(),
        sub: roster === null ? 'roster MISSING' : 'in the programme',
      },
      { label: 'Mean self', value: dbUp && week && week.selfMean !== null ? num(week.selfMean, { dp: 1 }) : missing(), sub: 'of 5' },
      { label: 'Mean manager', value: dbUp && week && week.managerMean !== null ? num(week.managerMean, { dp: 1 }) : missing(), sub: 'of 5' },
      { label: 'Mean gap', value: dbUp && week ? signed(week.gapMean, { dp: 1 }) : missing(), sub: 'self − manager' },
      {
        label: 'Promises kept',
        value: dbUp && keptRate.ok ? keptRate.html : missing(),
        sub: dbUp && keptRate.ok ? `${keptRate.k} of ${keptRate.n} answered` : 'nobody answered',
      },
    ],
    html: body,
  };
}

export default render;
