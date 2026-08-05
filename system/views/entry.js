// views/entry.js, the daily metrics form. The only page in the hub whose job
// is to put a number INTO the system rather than take one out of it.
//
// WHAT IS TYPED, AND WHAT IS NEVER TYPED
//
//   Typed: the raw cells Fiverr shows, impressions, clicks, orders and their
//   value, queue depth, reviews, ratings, cancellations. Fourteen numbers and
//   an optional per-gig split.
//
//   Never typed: every total and every rate. Click-through, order totals, AOV,
//   directed share, completion ratio and cancellation rate are DERIVED from
//   the raw cells and displayed live. They are not columns in `daily_entry`
//   and they must never become columns: a rate typed by hand cannot be audited
//   later, and a rate that disagrees with its own inputs is how a brief starts
//   lying quietly. One copy of every number, and this form is the copy.
//
// A BLANK IS NULL, NOT ZERO
//
//   Every metric in `daily_entry` is nullable on purpose. "Not recorded" and
//   "recorded as zero" are different facts and the difference decides whether
//   a rate has a denominator at all. So a blank input posts an empty string,
//   `numOrNull` turns it into NULL, and every derived figure that depends on a
//   blank renders MISSING rather than quietly treating it as 0. A total with
//   one blank half is MISSING, not the other half.
//
// R3 LIVES ON THE CLIENT TOO
//
//   The derived rates are recomputed in the browser as you type, so the house
//   rule about small denominators has to hold there as well. `LIVE_JS` carries
//   the same Wilson interval `lib/reconcile.js` computes, and the same test, 
//   n < 30 or an interval wider than 15 points means the figure prints as a
//   RANGE. Four orders out of five is not "80%". The server renders the same
//   values for anyone without JavaScript, and the script recomputes once on
//   load so the two can never drift apart on screen.

import { pick, isMissing } from '../lib/data.js';

import {
  html,
  join,
  safe,
  missing,
  money,
  num,
  dateShort,
  dateTimeShort,
  glyph,
  pill,
  panelHead,
  why,
  empty,
  rate,
  MIN_SAMPLE,
} from './layout.js';

// ============================================================================
// 1. THE FIELDS
// ============================================================================
//
// `name` is the daily_entry column and the POST field name, they are the same
// string on purpose, so a column added to the schema is one line here and
// cannot be mistyped into a silently ignored form field.

const SECTIONS = [
  {
    legend: 'Reach',
    note:
      'Straight off the gig analytics page for the day. Fill these in only when you are not filling ' +
      'in the per-gig split below, because the split wins when it is there.',
    fields: [
      {
        name: 'impressions',
        label: 'Impressions',
        mode: 'numeric',
        help: 'Ignored if any per-gig row below is filled in. The gigs are added up instead.',
      },
      {
        name: 'clicks',
        label: 'Clicks',
        mode: 'numeric',
        help: 'Ignored if any per-gig row below is filled in. The gigs are added up instead.',
      },
    ],
  },
  {
    legend: 'Orders taken',
    note: 'Split by how the order arrived. Type 0 where none arrived, 0 is a measurement, a blank is not.',
    fields: [
      { name: 'organic_orders', label: 'Organic orders', mode: 'numeric' },
      { name: 'organic_value', label: 'Organic value', mode: 'decimal', kind: 'money' },
      { name: 'directed_orders', label: 'Directed orders', mode: 'numeric' },
      { name: 'directed_value', label: 'Directed value', mode: 'decimal', kind: 'money' },
    ],
  },
  {
    legend: 'Delivery',
    note: 'What closed today, and what did not survive.',
    fields: [
      { name: 'orders_completed', label: 'Orders completed', mode: 'numeric' },
      { name: 'completed_value', label: 'Completed value', mode: 'decimal', kind: 'money' },
      { name: 'orders_in_queue', label: 'Orders in queue', mode: 'numeric' },
      { name: 'cancellations', label: 'Cancellations', mode: 'numeric' },
      { name: 'cancelled_value', label: 'Cancelled value', mode: 'decimal', kind: 'money' },
    ],
  },
  {
    legend: 'Standing',
    note: 'The four figures Fiverr shows on the level page.',
    fields: [
      { name: 'total_reviews', label: 'Total reviews', mode: 'numeric' },
      {
        name: 'profile_rating',
        label: 'Profile rating',
        mode: 'decimal',
        help: 'A number only, never "5 star". The unit suffix has silently voided hundreds of real ratings before.',
      },
      { name: 'success_score', label: 'Success score', mode: 'numeric', help: 'Whole number, 1–10.' },
      { name: 'inquiries_received', label: 'Inquiries received', mode: 'numeric', help: 'How many people messaged that day. A count, not a percentage.' },
    ],
  },
];

const ALL_FIELDS = SECTIONS.flatMap((s) => s.fields);

// ============================================================================
// 2. VALUE PLUMBING
// ============================================================================

/** A q() result → rows array, `null` on outage, `undefined` when not loaded. */
function rowsOf(result) {
  if (!result) return undefined;
  return result.ok ? result.rows || [] : null;
}

/**
 * A DATE column back to 'YYYY-MM-DD'.
 *
 * mysql2 hands back a Date at LOCAL midnight; `toISOString()` on that prints
 * the day before anywhere west of UTC, which is exactly the class of quiet
 * off-by-one this hub exists to catch. Local components, always.
 */
function isoOf(value) {
  if (!value) return null;
  if (value instanceof Date) {
    const p = (n) => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${p(value.getMonth() + 1)}-${p(value.getDate())}`;
  }
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(value));
  return m ? m[1] : null;
}

/** Shift an ISO date by whole days without touching a timezone. */
function shiftIso(iso, deltaDays) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + deltaDays * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** A stored cell → a number, or null. DECIMAL arrives as a string from mysql2. */
function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** What goes in the input's `value`. Null stays EMPTY, never "0". */
function inputValue(value) {
  const n = numberOrNull(value);
  if (n === null) return '';
  return String(n);
}

// ============================================================================
// 3. DERIVED FIGURES, displayed, never stored
// ============================================================================
//
// `sum` is deliberately strict: a total with one blank half is MISSING, not
// the half that happens to be filled in. Treating a blank as 0 here would
// manufacture a day of zero directed orders out of a CSR's coffee break.

function strictSum(a, b) {
  return a === null || b === null ? null : a + b;
}

function strictRatio(numerator, denominator) {
  if (numerator === null || denominator === null || denominator === 0) return null;
  return numerator / denominator;
}

/**
 * The server-rendered fallback for the derived strip.
 *
 * Anyone without JavaScript sees these and they are correct. With JavaScript,
 * `LIVE_JS` recomputes the identical set on load and on every keystroke, so
 * what is on screen always describes what is in the boxes.
 */
function derived(v) {
  const ordersTaken = strictSum(v.organic_orders, v.directed_orders);
  const valueTaken = strictSum(v.organic_value, v.directed_value);
  const ctr = rate(v.clicks, v.impressions);
  const share = rate(v.directed_orders, ordersTaken);
  const cancelDenominator = strictSum(v.orders_completed, v.cancellations);
  const cancel = rate(v.cancellations, cancelDenominator);
  const aovTaken = strictRatio(valueTaken, ordersTaken);
  const aovDone = strictRatio(v.completed_value, v.orders_completed);
  const completion = strictRatio(v.orders_completed, ordersTaken);

  const rateCell = (r, denominatorLabel) =>
    !r.ok
      ? { value: missing(), note: 'Both figures needed' }
      : {
          value: r.html,
          note: r.small
            ? `Wilson 95% · n=${r.n} ${denominatorLabel} · too few to state as one number`
            : `n=${r.n} ${denominatorLabel}`,
        };

  const ctrCell =
    v.clicks === null || v.impressions === null || !ctr.ok
      ? { value: missing(), note: 'Impressions and clicks both needed' }
      : rateCell(ctr, 'impressions');

  return {
    ctr: ctrCell,
    stats: [
      {
        id: 'd-orders',
        label: 'Orders taken',
        value: ordersTaken === null ? missing() : num(ordersTaken),
        note: 'Organic + directed',
      },
      {
        id: 'd-value',
        label: 'Value taken',
        value: valueTaken === null ? missing() : money(valueTaken),
        note: 'Organic + directed',
      },
      {
        id: 'd-share',
        label: 'Directed share',
        ...(v.directed_orders === null || ordersTaken === null || !share.ok
          ? { value: missing(), note: 'Both order counts needed' }
          : rateCell(share, 'orders')),
      },
      {
        id: 'd-aov',
        label: 'AOV taken',
        value: aovTaken === null ? missing() : money(aovTaken),
        note: ordersTaken === null ? 'Value and orders needed' : `Mean across ${ordersTaken} orders`,
      },
      {
        id: 'd-aov-done',
        label: 'AOV completed',
        value: aovDone === null ? missing() : money(aovDone),
        note:
          v.orders_completed === null
            ? 'Completed value and count needed'
            : `Mean across ${v.orders_completed} completed`,
      },
      {
        id: 'd-completion',
        label: 'Completion ratio',
        value: completion === null ? missing() : html`${num(completion, { dp: 2 })}×`,
        note: 'Completed ÷ taken. Can exceed 1, not a proportion, so no interval applies.',
      },
      {
        id: 'd-cancel',
        label: 'Cancellation rate',
        ...(v.cancellations === null || cancelDenominator === null || !cancel.ok
          ? { value: missing(), note: 'Completed and cancelled both needed' }
          : rateCell(cancel, 'closed orders')),
      },
    ],
  };
}

// The client half. Same arithmetic, same R3 test, same wording.
const LIVE_JS = `
(function(){
  'use strict';
  var form = document.getElementById('entry-form');
  if (!form) return;

  var MISS = '<span class="missing">MISSING</span>';
  var nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  var nf2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  function val(name){
    var el = form.elements[name];
    if (!el || el.length) return null;
    var s = String(el.value == null ? '' : el.value).replace(/[$,\\s]/g, '').trim();
    if (s === '') return null;
    var n = Number(s);
    return isFinite(n) ? n : null;
  }
  function usd(n){ return n == null ? null : '$' + (Number.isInteger(n) ? nf0.format(n) : nf2.format(n)); }
  function cnt(n){ return n == null ? null : nf0.format(n); }
  function sum(a, b){ return (a == null || b == null) ? null : a + b; }
  function ratio(a, b){ return (a == null || b == null || b === 0) ? null : a / b; }

  // Wilson 95%, the same interval lib/reconcile.js computes on the server.
  function wilson(k, n){
    var p = k / n, z2 = 3.8416;
    var denom = 1 + z2 / n;
    var centre = p + z2 / (2 * n);
    var spread = 1.96 * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
    return [Math.max(0, (centre - spread) / denom), Math.min(1, (centre + spread) / denom)];
  }
  // R3. A rate on a small denominator is a RANGE, never a point.
  function rateOf(k, n){
    if (k == null || n == null || n <= 0) return null;
    var ci = wilson(k, n), lo = ci[0], hi = ci[1];
    var small = n < ${MIN_SAMPLE} || (hi - lo) > 0.15;
    return {
      text: small ? (lo * 100).toFixed(1) + '\\u2013' + (hi * 100).toFixed(1) + '%' : ((k / n) * 100).toFixed(1) + '%',
      note: small ? 'Wilson 95% \\u00b7 n=' + n + ' \\u00b7 too few to state as one number' : 'n=' + n
    };
  }
  function put(id, text, note){
    var el = document.getElementById(id);
    if (el) { if (text == null) el.innerHTML = MISS; else el.textContent = text; }
    var n = document.getElementById(id + '-n');
    if (n) n.textContent = note == null ? '' : note;
  }
  function putRate(id, r, blank, unit){
    if (r == null) { put(id, null, blank); return; }
    put(id, r.text, r.note + (unit ? ' ' + unit : ''));
  }

  function recompute(){
    var imp = val('impressions'), clk = val('clicks');
    var oo = val('organic_orders'), do_ = val('directed_orders');
    var ov = val('organic_value'), dv = val('directed_value');
    var oc = val('orders_completed'), cv = val('completed_value');
    var cx = val('cancellations');

    var taken = sum(oo, do_);
    var takenValue = sum(ov, dv);
    var closed = sum(oc, cx);

    putRate('d-ctr', rateOf(clk, imp), 'Impressions and clicks both needed', 'impressions');
    put('d-orders', cnt(taken), 'Organic + directed');
    put('d-value', usd(takenValue), 'Organic + directed');
    putRate('d-share', rateOf(do_, taken), 'Both order counts needed', 'orders');
    put('d-aov', usd(ratio(takenValue, taken)), taken == null ? 'Value and orders needed' : 'Mean across ' + taken + ' orders');
    put('d-aov-done', usd(ratio(cv, oc)), oc == null ? 'Completed value and count needed' : 'Mean across ' + oc + ' completed');
    var comp = ratio(oc, taken);
    put('d-completion', comp == null ? null : comp.toFixed(2) + '\\u00d7',
        'Completed \\u00f7 taken. Can exceed 1, not a proportion, so no interval applies.');
    putRate('d-cancel', rateOf(cx, closed), 'Completed and cancelled both needed', 'closed orders');
  }

  form.addEventListener('input', recompute);
  form.addEventListener('change', recompute);
  recompute();
})();
`;

// ============================================================================
// 4. PIECES
// ============================================================================

/** One field, with the previous entry's figure printed underneath it. */
function fieldBlock(field, { saved, previous, previousIso, previousState }) {
  const id = `f-${field.name}`;
  const value = inputValue(saved ? saved[field.name] : null);
  const prevRaw = previous ? previous[field.name] : null;
  const prevNumber = numberOrNull(prevRaw);

  let hint;
  if (previousState === 'unknown') {
    hint = html`Previous entry ${missing()}`;
  } else if (previousState === 'none') {
    hint = html`No earlier entry for this profile`;
  } else if (prevNumber === null) {
    hint = html`${dateShort(previousIso)} · ${missing('not recorded')}`;
  } else {
    hint = html`${dateShort(previousIso)} · ${field.kind === 'money' ? money(prevNumber) : num(prevNumber, { dp: Number.isInteger(prevNumber) ? 0 : 2 })}`;
  }

  return html`<div class="field">
      <label for="${id}">${field.label}</label>
      <input id="${id}" name="${field.name}" type="text" inputmode="${field.mode}"
             value="${value}" autocomplete="off" spellcheck="false">
      <p class="field-hint">${hint}</p>
      ${field.help ? html`<p class="field-hint">${field.help}</p>` : ''}
    </div>`;
}

/** The per-gig split. Rows are (entry_date, profile, gig), see the caption. */
function gigRows(saved, suggested) {
  const rows = [];
  const seen = new Set();

  for (const row of saved) {
    const name = String(row.gig ?? '');
    if (!name || seen.has(name)) continue;
    seen.add(name);
    rows.push({ gig: name, impressions: inputValue(row.impressions), clicks: inputValue(row.clicks) });
  }
  for (const name of suggested) {
    if (!name || seen.has(name)) continue;
    seen.add(name);
    rows.push({ gig: name, impressions: '', clicks: '' });
  }
  // One spare row when there is already something to edit, two when the split
  // has never been filled in. Each row is three stacked fields at 375px, so
  // spare rows are not free.
  const spares = rows.length ? 1 : 2;
  for (let i = 0; i < spares; i++) rows.push({ gig: '', impressions: '', clicks: '' });

  return join(
    rows.map(
      (row, i) => html`<div class="form-grid">
        <div class="field">
          <label for="g${safe(String(i))}-name">Gig</label>
          <input id="g${safe(String(i))}-name" name="gig_name" type="text" value="${row.gig}" autocomplete="off">
        </div>
        <div class="field">
          <label for="g${safe(String(i))}-imp">Impressions</label>
          <input id="g${safe(String(i))}-imp" name="gig_impressions" type="text" inputmode="numeric" value="${row.impressions}" autocomplete="off">
        </div>
        <div class="field">
          <label for="g${safe(String(i))}-clk">Clicks</label>
          <input id="g${safe(String(i))}-clk" name="gig_clicks" type="text" inputmode="numeric" value="${row.clicks}" autocomplete="off">
        </div>
      </div>`
    )
  );
}

/** What the engine last saw. Not a hint under a field, a separate provenance. */
function engineSide(run) {
  const capturedOn = pick(run, 'metrics.gig.captured_on');
  const rows = [
    ['Impressions, 7-day mean', num(pick(run, 'metrics.gig.impressions_7d_ma'))],
    ['Reviews total', num(pick(run, 'metrics.gig.reviews_total'))],
    ['Rating from the star histogram', num(pick(run, 'metrics.gig.rating'), { dp: 2 })],
    ['Success score', num(pick(run, 'metrics.gig.success_score'))],
    ['Orders in queue', num(pick(run, 'metrics.gig.orders_in_queue'))],
  ];
  return html`<section class="panel">
      ${panelHead(
        'What the engine last saw',
        'live',
        html`Live · gig capture ${isMissing(capturedOn) ? missing() : dateShort(capturedOn)}`
      )}
      <dl class="stats">
        ${join(rows.map(([label, value]) => html`<div class="stat"><dt>${label}</dt><dd>${value}</dd></div>`))}
      </dl>
      <p class="caption">
        These are the engine's figures from its own capture, not defaults for the boxes above. If what Fiverr
        shows you today disagrees with one of them by a lot, type what Fiverr shows and say so, the gap is
        the finding, and overwriting it hides the finding.
      </p>
    </section>`;
}

// ============================================================================
// 5. RENDER
// ============================================================================

export function render(ctx) {
  const d = ctx.data || {};
  const date = d.date || null;
  const entries = rowsOf(d.entries);
  const gigs = rowsOf(d.gigs);
  const recent = rowsOf(d.recent);
  const previousAll = rowsOf(d.previous);
  const previousGigsAll = rowsOf(d.previousGigs);

  const dbUp = Array.isArray(entries);

  // Profiles: the engine's list, widened by anything already typed. Never a
  // hand-kept second list, and never narrower than what exists in the table.
  const profileSet = new Set((d.profiles || []).map(String));
  for (const row of entries || []) if (row.profile) profileSet.add(String(row.profile));
  for (const row of previousAll || []) if (row.profile) profileSet.add(String(row.profile));
  const profiles = [...profileSet].sort();

  const wanted = String(ctx.query?.profile || '');
  const profile = profiles.includes(wanted) ? wanted : profiles[0] || '';

  const saved = dbUp ? entries.find((r) => String(r.profile) === profile) || null : null;

  // "Yesterday" is whatever the most recent earlier entry actually is, and the
  // hint prints its real date rather than claiming it was yesterday.
  let previous = null;
  let previousIso = null;
  let previousState = 'unknown';
  if (previousAll === null) {
    previousState = 'unknown';
  } else if (Array.isArray(previousAll)) {
    const mine = previousAll
      .filter((r) => String(r.profile) === profile)
      .sort((a, b) => String(isoOf(b.entry_date)).localeCompare(String(isoOf(a.entry_date))));
    previous = mine[0] || null;
    previousIso = previous ? isoOf(previous.entry_date) : null;
    previousState = previous ? 'have' : 'none';
  }

  const values = Object.fromEntries(
    ALL_FIELDS.map((f) => [f.name, numberOrNull(saved ? saved[f.name] : null)])
  );
  const view = derived(values);

  const savedGigs = Array.isArray(gigs) ? gigs.filter((r) => String(r.profile) === profile) : [];
  // Where the reach on this row came from. server.js sums the gig split and
  // throws the typed total away whenever one gig is named, so a saved split is
  // proof the stored impressions are a sum and not something anyone typed.
  const reachSource = savedGigs.length ? `summed from ${savedGigs.length} gig${savedGigs.length === 1 ? '' : 's'}` : 'as typed';
  const suggestedGigs = Array.isArray(previousGigsAll)
    ? previousGigsAll.filter((r) => String(r.profile) === profile).map((r) => String(r.gig))
    : [];

  const backTo = `/entry?date=${encodeURIComponent(date || '')}&profile=${encodeURIComponent(profile)}`;

  // ---- chrome above the form -----------------------------------------------

  const dateNav = html`<form method="get" action="/entry" class="toolbar">
      <div class="search">
        <label class="sr-only" for="pick-date">Entry date</label>
        <input id="pick-date" type="date" name="date" value="${date}">
      </div>
      <input type="hidden" name="profile" value="${profile}">
      <button class="btn btn--ghost btn--sm" type="submit">Go to date</button>
      <div class="segment">
        <a href="/entry?date=${safe(encodeURIComponent(shiftIso(date, -1) || ''))}&amp;profile=${safe(encodeURIComponent(profile))}">← Previous day</a>
        <a href="/entry?date=${safe(encodeURIComponent(shiftIso(date, 1) || ''))}&amp;profile=${safe(encodeURIComponent(profile))}">Next day →</a>
      </div>
      <span class="count">${dateShort(date, { year: true })}</span>
    </form>
    <p class="caption">
      Everything on this page is for ${dateShort(date, { year: true })}, not today.
      Fiverr publishes a day's impressions the following day, so the form opens on yesterday.
    </p>`;

  const profileNav =
    profiles.length > 1
      ? html`<div class="segment" role="group" aria-label="Profile">
          ${join(
            profiles.map(
              (p) => html`<a href="/entry?date=${safe(encodeURIComponent(date || ''))}&amp;profile=${safe(encodeURIComponent(p))}"
                  ${safe(p === profile ? 'aria-current="true"' : '')}>${p}</a>`
            )
          )}
        </div>`
      : '';

  // ---- the lede: the one derived figure that leads -------------------------

  const savedAt = saved ? saved.updated_at : null;
  const lede = html`<div class="lede">
      <div class="lede-main">
        <div class="figure">
          <span class="cap">Click-through rate</span>
          <strong class="big" id="d-ctr">${view.ctr.value}</strong>
          <p class="caption" id="d-ctr-n">${view.ctr.note}</p>
          <p class="sub">
            Type the two raw numbers. The rate is derived on screen and is not a column in the database, 
            there is exactly one copy of it and it is computed from the cells above it.
          </p>
        </div>
        ${why(
          'Why the raw cells and never the summary',
          html`<p>
              Every derived number in this hub is computed from the two or three raw cells it depends on. A
              rate typed by hand cannot be audited later, and a rate that disagrees with its own inputs is
              how a brief starts lying quietly. It is the same reason this database holds nothing the engine
              already computes.
            </p>
            <p>
              <strong>A blank is not a zero.</strong> Leave a box empty and it is stored as NULL, meaning
              "not recorded", a different fact from "recorded as none". Any total or rate that depends on a
              blank renders MISSING rather than treating the gap as zero, so a skipped box can never inflate
              a denominator or invent a day of no reach.
            </p>
            <p>
              Rates on small denominators print as a <strong>range</strong>, not a point. Four orders out of
              five is not "80%", with n that small the honest interval spans most of the axis, and the
              range says so. The threshold is n &lt; ${String(MIN_SAMPLE)} or an interval wider than 15
              points, the same test the engine applies.
            </p>`
        )}
      </div>
      <div class="lede-side">
        <div class="figure">
          <span class="cap">This day, this profile</span>
          <strong class="mid">${saved ? dateTimeShort(savedAt) : dbUp ? 'Not logged' : missing()}</strong>
          <p class="sub">
            ${!dbUp
              ? html`${pill('crit', 'Store unreachable')} The typed-records database did not answer, so the hub
                  cannot show what is already saved for this day and will not let you overwrite it blind.`
              : saved
                ? html`${pill('ok', 'Saved')} Entered by <b>${saved.entered_by || missing()}</b>. Saving again
                    updates the same row, one row per profile per day, keyed on both.`
                : html`${pill('warn', 'Nothing recorded yet')} No row exists for
                    ${dateShort(date)} on <b>${profile || missing()}</b>.`}
          </p>
        </div>
      </div>
    </div>`;

  // ---- the form ------------------------------------------------------------

  const fieldSections = join(
    SECTIONS.map(
      (section) => html`<fieldset class="form-section">
        <legend>${section.legend}</legend>
        <div class="form-grid">
          ${join(
            section.fields.map((f) =>
              fieldBlock(f, { saved, previous, previousIso, previousState })
            )
          )}
        </div>
        <p class="caption">${section.note}</p>
      </fieldset>`
    )
  );

  const form = dbUp
    ? html`<form id="entry-form" method="post" action="/entry">
        <input type="hidden" name="_csrf" value="${ctx.csrfToken}">
        <input type="hidden" name="entry_date" value="${date}">
        <input type="hidden" name="back" value="${backTo}">
        ${profiles.length
          ? html`<input type="hidden" name="profile" value="${profile}">`
          : html`<div class="field">
              <label for="f-profile">Profile <span class="req">*</span></label>
              <input id="f-profile" name="profile" type="text" value="" autocomplete="off">
              <p class="field-hint">
                No profile name reached the hub from the engine, so type the one this row belongs to.
              </p>
            </div>`}

        ${fieldSections}

        <fieldset class="form-section">
          <legend>Per gig, optional</legend>
          ${gigRows(savedGigs, suggestedGigs)}
          <p class="caption">
            Optional, and only worth filling when the gig-level split is actually visible. Rows are keyed on
            the gig NAME, so retyping a name creates a second row rather than renaming the first. Leave a row
            blank to ignore it.
          </p>
          <p class="caption">
            <strong>Name one gig here and this becomes the profile's reach.</strong> Impressions and clicks
            above are then ignored and the rows below are added up instead, because asking for the parts and
            the total is two copies of one number and two copies drift. So fill in every gig you have, not
            just the one you were looking at: a partial split silently turns into the whole profile's reach,
            and the click-through rate starts describing a subset. A row with a name and a blank number makes
            the total MISSING rather than a partial sum.
          </p>
        </fieldset>

        <div class="form-actions">
          <button class="btn" type="submit">Save ${dateShort(date)}</button>
          <span class="form-status">Nothing is written until you press save. Saving overwrites this day's row for this profile.</span>
        </div>
      </form>`
    : html`<p class="note note--neg">
        ${glyph('crit')} <strong>The form is closed while the typed-records database is unreachable.</strong>
        It cannot be shown filled in, and an empty form that saves would overwrite a real day with blanks.
        Everything on the pages that read from <code class="mono">data/</code> is unaffected.
      </p>`;

  // ---- derived strip -------------------------------------------------------

  const derivedStrip = html`<section class="panel">
      ${panelHead('Derived, displayed, never stored', 'typed', 'From the boxes above')}
      <dl class="stats">
        ${join(
          view.stats.map(
            // A <div> grouping dt/dd is the one wrapper a <dl> permits, so the
            // per-figure note is a <span> rather than a <p>, same rendering,
            // valid content model.
            (s) => html`<div class="stat">
              <dt>${s.label}</dt>
              <dd id="${s.id}">${s.value}</dd>
              <span class="caption" id="${s.id}-n">${s.note}</span>
            </div>`
          )
        )}
      </dl>
      <p class="caption">
        None of these is a column in <code class="mono">daily_entry</code>. Each is computed from the raw
        cells in the form and recomputed as you type. A figure that depends on an empty box reads MISSING.
      </p>
    </section>`;

  // ---- the rest of the day, and the days before it -------------------------

  const otherProfiles =
    dbUp && entries.length
      ? html`<section class="panel">
          ${panelHead(html`Saved for ${dateShort(date)}`, 'typed', 'Typed here · MySQL')}
          <div class="tablewrap">
            <table class="table table--narrow">
              <thead>
                <tr><th>Profile</th><th class="r">Impressions</th><th class="r">Orders taken</th><th class="r">Completed value</th><th>Entered by</th></tr>
              </thead>
              <tbody>
                ${join(
                  entries.map((row) => {
                    const taken = strictSum(
                      numberOrNull(row.organic_orders),
                      numberOrNull(row.directed_orders)
                    );
                    return html`<tr>
                      <td><span class="cell-name">${row.profile}</span></td>
                      <td class="r cell-figure">${numberOrNull(row.impressions) === null ? missing() : num(row.impressions)}</td>
                      <td class="r cell-figure">${taken === null ? missing() : num(taken)}</td>
                      <td class="r cell-figure">${numberOrNull(row.completed_value) === null ? missing() : money(row.completed_value)}</td>
                      <td>${row.entered_by || missing()}</td>
                    </tr>`;
                  })
                )}
              </tbody>
            </table>
            <p class="tablehint" aria-hidden="true">Scroll sideways for more columns →</p>
          </div>
        </section>`
      : dbUp
        ? html`<section class="panel">
            ${panelHead(html`Saved for ${dateShort(date)}`, 'typed', 'Typed here · MySQL')}
            ${empty('No profile has been logged for this date yet.')}
          </section>`
        : '';

  const history =
    Array.isArray(recent) && recent.length
      ? html`<section class="panel">
          ${panelHead('Recently logged days', 'typed', 'Typed here · MySQL')}
          <div class="tablewrap">
            <table class="table table--narrow">
              <thead><tr><th>Date</th><th class="r">Profiles</th><th>Last touched</th><th></th></tr></thead>
              <tbody>
                ${join(
                  recent.map((row) => {
                    const iso = isoOf(row.entry_date);
                    return html`<tr${safe(iso === date ? ' class="row-attn"' : '')}>
                      <td><span class="cell-name">${dateShort(iso, { year: true })}</span></td>
                      <td class="r cell-figure">${num(row.profiles)}</td>
                      <td>${dateTimeShort(row.updated)}</td>
                      <td class="r"><a href="/entry?date=${safe(encodeURIComponent(iso || ''))}&amp;profile=${safe(encodeURIComponent(profile))}">Open</a></td>
                    </tr>`;
                  })
                )}
              </tbody>
            </table>
            <p class="tablehint" aria-hidden="true">Scroll sideways for more columns →</p>
          </div>
          <p class="caption">A gap in this list is a day nobody logged. It is not a day of zero reach.</p>
        </section>`
      : '';

  const body = html`${dateNav}${profileNav}
    ${lede}
    <section class="panel">
      ${panelHead(
        html`Today's figures, ${profile || missing()}`,
        'typed',
        html`Typed here · MySQL · one row per profile per day`
      )}
      ${form}
    </section>
    ${derivedStrip}
    ${engineSide(ctx.run)}
    ${otherProfiles}
    ${history}
    <script nonce="${ctx.nonce}">${safe(LIVE_JS)}</script>`;

  return {
    // Three states, not two. Every other cell on this page already separates
    // "not logged" from "we cannot tell", the saved stamp, the form, the
    // ticker, and the headline was the one place that collapsed them, which
    // is where it does the most damage: during an outage it told whoever
    // opened the page that today had not been entered, when the honest answer
    // was that the table could not be read.
    title: saved
      ? `${dateShortText(date)} is logged for ${profile}`
      : dbUp
        ? `${dateShortText(date)} is not logged yet`
        : `Whether ${dateShortText(date)} is logged cannot be read`,
    kicker: profile ? `Daily entry · ${profile}` : 'Daily entry',
    ticker: [
      { label: 'Entry date', value: dateShort(date, { year: true }), sub: profile || null },
      {
        label: 'This row',
        value: saved ? 'Saved' : dbUp ? 'Not logged' : missing(),
        sub: saved && saved.entered_by ? String(saved.entered_by) : null,
      },
      // `reachSource` and not a flat 'as typed': the server ignores the typed
      // reach boxes whenever a per-gig split was saved, so on those days this
      // figure is the SUM of the rows below and captioning it "as typed" tells
      // the reader the one thing about it that is not true.
      { label: 'Impressions', value: values.impressions === null ? missing() : num(values.impressions), sub: reachSource },
      { label: 'Clicks', value: values.clicks === null ? missing() : num(values.clicks), sub: reachSource },
      { label: 'Orders taken', value: view.stats[0].value, sub: 'derived' },
      { label: 'Value taken', value: view.stats[1].value, sub: 'derived' },
    ],
    html: body,
  };
}

/** Plain text form of a date, for `title`, which is prose, not markup. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function dateShortText(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? `${m[3]} ${MONTHS[Number(m[2]) - 1]}` : 'This day';
}

export default render;
