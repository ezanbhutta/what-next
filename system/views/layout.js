// views/layout.js, the shell every section is rendered into, and the small
// set of helpers every section shares.
//
// ============================================================================
// THE VIEW MODULE CONTRACT
// ============================================================================
//
//   views/<name>.js   export function render(ctx) -> string | Safe | Result
//
// A view returns the INSIDE of the section slot. It never returns a <head>, a
// <body>, the rail, or the masthead, those belong to this file, so that a
// change to the frame is one edit and not nine.
//
//   Result = {
//     html:    string | Safe        the section body (required). A plain string
//                                   here is treated as MARKUP, not text, it is
//                                   your output. Escape the DATA you put in it
//                                   with esc() or the html`` tag.
//     title?:  string               <h2> in the .slug, the finding, not the
//                                   section name. "17 orders past 60 days"
//     kicker?: string               small caps above it; defaults to the
//                                   section label
//     deck?:   string | Safe        one serif sentence stating the finding.
//                                   "$6,952 earned. $8,007 waiting."
//                                   title / kicker / deck are PROSE: a plain
//                                   string is escaped. Use html`` for markup.
//     slug?:   false                suppress the .slug entirely
//     ticker?: Array<{label, value, sub?}>   replace the six standing figures
//     head?:   string | Safe        extra <head> content (rare)
//   }
//
// ESCAPING, read this before writing a view.
//
// `esc()` is the single chokepoint. It escapes HTML *and* scrubs the retired
// programme's internal names out of every user-visible string. That scrub is
// here, and only here, on purpose: the leak is never prose someone wrote, it
// is a raw engine key (`vvro_share_7d`, `by_type.vvro`) reaching a renderer
// through a data path nobody thought about. Scrubbing at a call site fixes the
// one you noticed. Scrubbing at the chokepoint holds for the ones you have not
// written yet. `layout()` runs the scrub a second time over the finished
// document as a net for anything that bypassed esc.
//
// Prefer the `html` tagged template: every interpolation is escaped unless it
// is `safe(...)`, another `html` result, or an array of those. MISSING renders
// itself as the MISSING chip, so `${pick(run, 'metrics.economics.aov')}` is
// safe against an absent engine file with no `if` at all.
//
// HOUSE RULES THIS FILE ENFORCES
//   R2  MISSING is a rendered thing (`missing()`), never a blank, never 0.
//   R3  `rate()` returns a RANGE below MIN_SAMPLE. `meter()` refuses to draw a
//       bar under n<30 and renders the suppressed track instead.
//   R4  `esc()` scrubs the retired names. Do not undo it, do not route around it.
//   R5  Dark mode is the explicit toggle only. The pre-paint script is the
//       first child of <body>. There is no prefers-color-scheme anywhere.
//   R7  The figure leads. `.slug` → `.deck` → figures → `<details>`.

import { MISSING, isMissing } from '../lib/data.js';
import { wilson, MIN_SAMPLE } from '../lib/reconcile.js';
import { clock } from '../lib/roster.js';

export { MIN_SAMPLE };

// ============================================================================
// 1. ESCAPING, SCRUBBING, TEMPLATES
// ============================================================================

/** A string that is already HTML and must not be escaped again. */
export class Safe {
  constructor(value) {
    this.value = String(value);
  }
  toString() {
    return this.value;
  }
}

/** Mark a string as pre-rendered HTML. Use it only on markup you built here. */
export function safe(value) {
  return value instanceof Safe ? value : new Safe(value ?? '');
}

/**
 * R4. The retired volume programme has exactly one permitted label.
 *
 * No word boundaries: the threat is `vvro_share_7d` and `by_type.vvro`, raw
 * engine keys arriving through a data path that did not exist when this was
 * written. No English word contains either substring, so a blanket replace is
 * safe and a bounded one is not.
 */
const RETIRED = /vvro|inorganic/gi; // scrubs-output: the one line allowed to name them

/**
 * Em dashes, same chokepoint. The hub's own templates were cleaned by hand,
 * but engine prose arrives through data paths (task titles, rationales,
 * steps in latest-run.json) and CSR-typed sheet notes, and both use the em
 * dash freely. Two jobs for one character, handled separately:
 *
 *   - a value that IS just the dash is a placeholder meaning "no value";
 *     converting it to punctuation once broke seven table cells, so it
 *     renders as "None"
 *   - a dash inside prose is a clause break, and reads as a comma
 */
const DASH_ONLY = /^\s*—+\s*$/; // reads-input: matches the character to remove it
const DASH_IN_PROSE = /\s*—\s*/g; // reads-input: matches the character to remove it

export function scrub(text) {
  const s = String(text);
  const dashless = DASH_ONLY.test(s) ? 'None' : s.replace(DASH_IN_PROSE, ', ');
  return dashless.replace(RETIRED, (match) => {
    if (match === match.toUpperCase()) return 'DIRECTED';
    if (match[0] === match[0].toUpperCase()) return 'Directed';
    return 'directed';
  });
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * THE CHOKEPOINT. Every user-visible string goes through here: HTML-escaped,
 * then scrubbed. Returns a plain string (not Safe) so it cannot be
 * accidentally re-marked as trusted.
 */
export function esc(value) {
  if (value === null || value === undefined || value === false) return '';
  if (isMissing(value)) return 'MISSING';
  return scrub(String(value)).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/** Escape for an attribute value. Same rules; named separately so intent reads. */
export const attr = esc;

function renderValue(value) {
  if (value === null || value === undefined || value === false || value === '') return '';
  if (value instanceof Safe) return value.value;
  if (isMissing(value)) return missing().value;
  if (Array.isArray(value)) return value.map(renderValue).join('');
  return esc(value);
}

/**
 * Auto-escaping template tag.
 *   html`<td class="cell-name">${buyer}</td>`
 * Interpolations are escaped unless Safe / html / an array of those. MISSING
 * renders as the MISSING chip. null, undefined and false render as nothing.
 */
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += renderValue(values[i]) + strings[i + 1];
  return new Safe(out);
}

/** Join fragments with a separator, escaping anything that is not already Safe. */
export function join(list, separator = '') {
  return new Safe((list || []).map(renderValue).join(separator));
}

// ============================================================================
// 2. VALUE FORMATTERS. R2: absent is MISSING, never zero, never a guess
// ============================================================================

/** The rendered form of "we do not know". */
export function missing(label = 'MISSING') {
  return new Safe(`<span class="missing">${esc(label)}</span>`);
}

/** True when a value can be shown as a number at all. */
export function known(value) {
  if (value === null || value === undefined || value === '') return false;
  if (isMissing(value)) return false;
  return Number.isFinite(Number(value));
}

const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const usd2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Money. Accepts a number OR the string mysql2 returns for DECIMAL, the pool
 * keeps DECIMAL as a string on purpose so exactness survives the trip, and
 * formatting is the edge where it becomes a float, once.
 */
/**
 * Money. Whole dollars unless the call site asks for cents.
 *
 * It used to decide per value: cents when the number had a fraction, none
 * when it did not. That put $78.94 and $1,905 in the same column, so the
 * decimal points never lined up and a column of figures could not be read
 * down. Nobody chasing a late order needs the 94 cents.
 *
 * `{cents: true}` is for the places the cents are the point: a tip, an
 * invoice line, an amount someone will reconcile against Fiverr.
 */
export function money(value, { cents = false } = {}) {
  if (!known(value)) return missing();
  return new Safe(`<span class="num">${esc((cents ? usd2 : usd0).format(Number(value)))}</span>`);
}

/** A count. */
export function num(value, { dp = 0 } = {}) {
  if (!known(value)) return missing();
  const n = Number(value);
  return new Safe(
    `<span class="num">${esc(n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp }))}</span>`
  );
}

/** A fraction 0–1 rendered as a percentage. `pct(0.1176)` → 11.8% */
export function pct(fraction, { dp = 1 } = {}) {
  if (!known(fraction)) return missing();
  return new Safe(`<span class="num">${esc((Number(fraction) * 100).toFixed(dp))}%</span>`);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'YYYY-MM-DD' (or a Date) → '04 Aug'. Parsed by hand: a DATE turned into a
 *  Date object is midnight in the server's zone and prints a day early west
 *  of it. */
export function dateShort(value, { year = false } = {}) {
  if (!value || isMissing(value)) return missing();
  const iso = value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return missing();
  const label = `${m[3]} ${MONTHS[Number(m[2]) - 1]}${year ? ` ${m[1]}` : ''}`;
  return new Safe(`<span class="nowrap">${esc(label)}</span>`);
}

/** 'YYYY-MM-DD HH:MM:SS' or a Date → '04 Aug 09:14'. */
export function dateTimeShort(value) {
  if (!value || isMissing(value)) return missing();
  const d = value instanceof Date ? value : new Date(String(value).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return missing();
  const p = (n) => String(n).padStart(2, '0');
  return new Safe(
    `<span class="nowrap">${esc(`${p(d.getDate())} ${MONTHS[d.getMonth()]} ${p(d.getHours())}:${p(d.getMinutes())}`)}</span>`
  );
}

/** "268 days" / "1 day" / MISSING. */
export function days(n, { word = 'day' } = {}) {
  if (!known(n)) return missing();
  const v = Math.round(Number(n));
  return new Safe(`<span class="num">${esc(v)}</span> ${esc(word)}${v === 1 ? '' : 's'}`);
}

// ============================================================================
// 3. RATES. R3: a rate on a small denominator is a RANGE, never a point
// ============================================================================

/**
 * Widest Wilson interval that may still be stated as a single number.
 *
 * This is the engine's own `funnel.max_interval_width`, deliberately the same
 * value: two systems disagreeing about when a rate is callable is exactly the
 * class of problem this repo exists to referee.
 */
export const MAX_INTERVAL_WIDTH = 0.15;

/**
 * The honest text form of k of n.
 *
 *   rate(4, 34)   → "4.7%–26.6%"
 *   rate(612, 900)→ "68.0%"
 *
 * `small`, meaning "do not state this as one number", is true when the
 * denominator is under MIN_SAMPLE **or** the interval is wider than
 * MAX_INTERVAL_WIDTH. Both tests are needed and n≥30 alone is not enough: 4 of
 * 34 clears the denominator rule and still spans 4.7%–26.6%, an interval that
 * contains both "crisis" and "nothing happened". Printing 11.8% there is the
 * precise failure the house rule was written about. Nothing may draw a bar or
 * a trend arrow while `small` is true, see `meter()`.
 */
export function rate(successes, trials, { dp = 1, force = null } = {}) {
  const k = Number(successes);
  const n = Number(trials);
  if (!Number.isFinite(k) || !Number.isFinite(n) || n <= 0) {
    return { ok: false, small: true, point: null, lo: null, hi: null, n: 0, k: 0, html: missing() };
  }
  const ci = wilson(k, n);
  const lo = isMissing(ci?.[0]) ? null : ci[0];
  const hi = isMissing(ci?.[1]) ? null : ci[1];
  const point = k / n;
  const wide = lo !== null && hi !== null && hi - lo > MAX_INTERVAL_WIDTH;
  const small = force === null ? n < MIN_SAMPLE || wide : force;
  const f = (x) => `${(x * 100).toFixed(dp)}%`;
  const text =
    small && lo !== null && hi !== null ? `${f(lo)}–${f(hi)}` : f(point);
  return {
    ok: true,
    small,
    wide,
    n,
    k,
    point,
    lo,
    hi,
    text,
    html: new Safe(`<span class="num">${esc(text)}</span>`),
  };
}

/**
 * The `.range` figure, a band and a point drawn on a STATED axis.
 *
 * Every element is positioned by its real value on the axis printed in the
 * caption. The prototype laid the labels out with space-between while the band
 * sat at its true percentages, so the axis the labels implied and the axis the
 * band was drawn on were different axes and the picture lied about its own
 * numbers. Pass values; this computes positions.
 *
 * @param {{k:number, n:number, axisMin?:number, axisMax?:number, note?:string, dp?:number}} spec
 *        k/n are counts; axis bounds are FRACTIONS (0.3 = 30%).
 */
export function rangeFigure({ k, n, axisMin = 0, axisMax = null, note = null, dp = 1 }) {
  const r = rate(k, n, { dp });
  if (!r.ok || r.lo === null || r.hi === null) return missing();

  // The smallest nice bound that CONTAINS the interval, no decorative
  // headroom. Padding above the top of the interval shrinks the band on the
  // track and makes a wide, uncertain rate look tighter than it is, which is
  // the one thing this component exists to prevent.
  const max = axisMax === null ? niceCeil(Math.max(r.hi, r.point)) : axisMax;
  const span = max - axisMin || 1;
  const at = (v) => `${(((v - axisMin) / span) * 100).toFixed(1)}%`;
  const f = (v) => `${(v * 100).toFixed(dp)}%`;

  return html`<figure class="range">
      <div class="range-track">
        <div class="range-band" style="--lo:${safe(at(r.lo))};--hi:${safe(at(r.hi))}"></div>
        <div class="range-point" style="--at:${safe(at(r.point))}"></div>
      </div>
      <div class="range-axis">
        <span class="range-tick range-tick--first range-tick--optional" style="--at:0%">${f(axisMin)}</span>
        <span class="range-tick" style="--at:${safe(at(r.lo))}">${f(r.lo)}</span>
        <span class="range-tick" style="--at:${safe(at(r.hi))}">${f(r.hi)}</span>
        <span class="range-tick range-tick--last range-tick--optional" style="--at:100%">${f(max)}</span>
      </div>
      <figcaption class="range-axis-note">Axis ${f(axisMin)}–${f(max)} · Wilson 95% · n=${String(n)}${note ? ` · ${note}` : ''}</figcaption>
    </figure>`;
}

function niceCeil(x) {
  if (!Number.isFinite(x) || x <= 0) return 0.1;
  if (x >= 1) return 1;
  const steps = [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.75, 1];
  return steps.find((s) => s >= x) ?? 1;
}

/**
 * A proportion of a known whole.
 *
 * R3 is enforced here rather than trusted: under MIN_SAMPLE this returns the
 * suppressed track, hatched, no fill, with the interval as the value. There
 * is no argument that makes it draw a bar on n<30.
 */
export function meter({ value, total, tone = '', label = null, dp = 1 }) {
  const r = rate(value, total, { dp });
  if (!r.ok) return missing();
  if (r.small) {
    return html`<div class="meter meter--suppressed" role="img"
        aria-label="${label || 'Rate'} ${r.text}, interval too wide to draw at n=${String(r.n)}">
        <span class="meter-track"></span>
        <span class="meter-val">${r.text}</span>
      </div>`;
  }
  const fill = tone ? ` meter-fill--${tone}` : '';
  return html`<div class="meter" role="img" aria-label="${label || 'Rate'} ${r.text} of ${String(r.n)}">
      <span class="meter-track"><span class="meter-fill${safe(fill)}" style="--pct:${safe(`${(r.point * 100).toFixed(1)}%`)}"></span></span>
      <span class="meter-val">${r.text}</span>
    </div>`;
}

// ============================================================================
// 4. STATUS COMPONENTS, shape AND colour, never colour alone
// ============================================================================

// The five shapes are circle / triangle / diamond / ring / square and NO TWO
// STATUSES MAY SHARE ONE, see the glyph block in app.css, which documents the
// same table. `info` was drawn as a circle here, which is byte-identical to
// `ok`: in greyscale, on a projector, or to a deuteranope an info glyph drawn
// as a circle IS an ok glyph, and the colour was doing all the work alone.
const GLYPHS = {
  ok: '<circle cx="5.5" cy="5.5" r="4"/>',
  warn: '<path d="M5.5 1 10.2 9.6H.8Z"/>',
  crit: '<path d="M5.5 .8 10.2 5.5 5.5 10.2.8 5.5Z"/>',
  idle: '<circle cx="5.5" cy="5.5" r="3.6" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  info: '<rect x="1.9" y="1.9" width="7.2" height="7.2" rx="1.4"/>',
};

/** A status shape. Never render one without an adjacent word, see `pill`. */
export function glyph(kind = 'idle') {
  const shape = GLYPHS[kind] || GLYPHS.idle;
  return new Safe(
    `<svg class="glyph glyph--${esc(kind)}" viewBox="0 0 11 11" aria-hidden="true">${shape}</svg>`
  );
}

/** glyph + word. The word is not optional; a glyph alone is a decoration. */
export function pill(kind, label) {
  return html`<span class="pill pill--${safe(esc(kind))}">${glyph(kind)}${label}</span>`;
}

/**
 * Provenance stamp. Every panel says where its figures came from, in the head,
 * before the reader reaches a number.
 *   kind: 'live'    engine JSON on disk
 *         'typed'   a row a human entered into MySQL
 *         'sample'  placeholder, dashed, must never read as fact
 *         'missing' the source is absent
 */
export function stamp(kind, text) {
  return html`<span class="stamp stamp--${safe(esc(kind))}">${text}</span>`;
}

/** The header row of a panel, carrying its own provenance. */
/**
 * A panel's title bar, with an optional explanation folded behind an icon.
 *
 * The fourth argument is where a panel's reasoning goes now. It used to sit in
 * a <p class="caption"> underneath, and there were seventy-one of those across
 * the views: every one written to stop a number being misread, and every one
 * adding a paragraph to a page that is meant to be read at a glance.
 *
 * Beside the title it costs nothing until somebody hovers it, and it lands in
 * the one place a reader is already looking when they wonder what a panel is.
 */
/**
 * A stat card in the shape the impressions board and CSR Pulse use: a small
 * uppercase label, one large tabular figure, and at most one line under it.
 *
 * `note` puts the explanation behind a hover icon on the label rather than in
 * a paragraph below, so a row of these stays a row of figures.
 */
export function statCard(label, value, { sub = null, tone = '', badge = null, note = null } = {}) {
  return html`<div class="statcard">
      <p class="k">
        <span>${label}${note ? info(note) : ''}</span>
        ${badge ? html`<span class="badge badge--${safe(tone || 'info')}" aria-hidden="true">${badge}</span>` : ''}
      </p>
      <strong class="v ${safe(tone)}">${value}</strong>
      ${sub ? html`<p class="n">${sub}</p>` : ''}
    </div>`;
}

/** A row of stat cards. */
export function statGrid(cards) {
  return html`<div class="statgrid">${join(cards)}</div>`;
}

export function panelHead(title, stampKind, stampText, note = null) {
  const variant = stampKind === 'sample' ? 'sample' : stampKind === 'missing' ? 'missing' : 'live';
  return html`<div class="panel-head panel-head--${safe(variant)}">
      <h3>${title}${note ? info(note) : ''}</h3>${stampKind ? stamp(stampKind, stampText) : ''}
    </div>`;
}

/** A page-level banner. level: 'info' | 'warn' | 'crit'. */
export function banner(level, title, body) {
  const cls = level === 'crit' ? ' banner--crit' : level === 'warn' ? ' banner--warn' : '';
  const kind = level === 'crit' ? 'crit' : level === 'warn' ? 'warn' : 'info';
  return html`<div class="banner${safe(cls)}" role="${level === 'info' ? 'status' : 'alert'}">
      ${glyph(kind)}<div><strong>${title}</strong> ${body}</div>
    </div>`;
}

/** A `<details>` block. R7: this is where reasoning goes, never above a figure. */
/**
 * A hover/tap explanation, folded behind an icon.
 *
 * THE PROBLEM THIS SOLVES, MEASURED
 *
 * 4,772 words of prose rendered across these views: a caption under every
 * panel, a sub paragraph under every figure. Every one of them was written to
 * stop somebody misreading a number, and every one of them made the page
 * harder to read, which is the same failure by a different route.
 *
 * The reasoning still has to be reachable, because most of it is load-bearing
 * (why a rate is a range, why money-at-rest ignores the window, why a review
 * ask is refused). So it moves behind this: one 15px icon, the text on hover
 * for a mouse and on tap for a phone, and nothing occupying the page until
 * somebody asks.
 *
 * `<details>`-free on purpose. A details block still takes a line, still
 * pushes the next figure down, and reads as content. This does not.
 */
export function info(text, { label = 'Why' } = {}) {
  const body = String(text ?? '').trim();
  if (!body) return '';
  return html`<span class="info" tabindex="0" role="note"
      aria-label="${label}: ${body}"><span aria-hidden="true">i</span><span
      class="info-pop">${body}</span></span>`;
}

export function why(summary, body) {
  return html`<details><summary>${summary}</summary><div class="details-body">${body}</div></details>`;
}

/** An empty result. Says it is empty, which is a fact, unlike MISSING. */
export function empty(text) {
  return html`<p class="empty">${text}</p>`;
}

// ============================================================================
// 5. THE SECTIONS
// ============================================================================
//
// Order here IS the rail order and IS the 1–9 keyboard shortcut. `question` is
// the masthead headline: each section answers exactly one, and if a section
// cannot state its question in a line it is doing two jobs.

export const SECTIONS = Object.freeze([
  { key: 'today', href: '/', label: 'Today', group: 'Now',
    question: 'What do I do now, and who owns it',
    icon: '<path d="M3 4.5h12M3 9h12M3 13.5h7"/><path d="M12.2 13.4l1.5 1.5 2.6-3"/>' },
  { key: 'entry', href: '/entry', label: 'Daily entry', group: 'Now',
    question: 'Type what Fiverr showed today',
    icon: '<path d="M3 3h9l3 3v9H3z"/><path d="M6 8h6M6 11h4"/>' },
  { key: 'inquiries', href: '/inquiries', label: 'Inquiries', group: 'The work',
    question: 'Who asked, who converted, which CSR, which shift',
    icon: '<path d="M15.5 11.5a1.5 1.5 0 0 1-1.5 1.5H6l-3.5 3V4a1.5 1.5 0 0 1 1.5-1.5h10A1.5 1.5 0 0 1 15.5 4z"/>' },
  { key: 'orders', href: '/orders', label: 'Orders', group: 'The work',
    question: 'What is live, what stage, what is late',
    icon: '<path d="M2.5 5.5 9 2.5l6.5 3v7L9 15.5l-6.5-3z"/><path d="M2.5 5.5 9 8.6l6.5-3.1M9 8.6v6.9"/>' },
  { key: 'clients', href: '/clients', label: 'Clients', group: 'The work',
    question: 'One record per buyer, history, value, what we owe',
    icon: '<circle cx="9" cy="6" r="2.8"/><path d="M3.5 15.5a5.5 5.5 0 0 1 11 0"/>' },
  { key: 'messages', href: '/messages', label: 'Messages', group: 'Words',
    question: 'What this buyer was already told',
    icon: '<path d="M2.5 4.5h13v9h-13z"/><path d="m2.5 5 6.5 5 6.5-5"/>' },
  { key: 'responses', href: '/responses', label: 'Responses', group: 'Words',
    question: 'The reply library, searchable',
    icon: '<path d="M4 3.5h10v11l-5-2.6-5 2.6z"/><path d="M6.5 7h5"/>' },
  { key: 'team', href: '/team', label: 'Team', group: 'People & money',
    question: 'Weekly 1–5 scoring, self against manager, promises kept',
    icon: '<circle cx="6.5" cy="6" r="2.4"/><circle cx="12.5" cy="7" r="2"/><path d="M2.5 15a4.2 4.2 0 0 1 8 0M11 15a3.6 3.6 0 0 1 4.5-3.3"/>' },
  { key: 'money', href: '/money', label: 'Money', group: 'People & money',
    question: 'Revenue, money sitting still, upsell pipeline',
    icon: '<path d="M9 2.5v13"/><path d="M12.5 5.4C11.7 4.4 10.5 4 9 4 6.9 4 5.6 4.9 5.6 6.3c0 3.2 7 1.6 7 5 0 1.5-1.4 2.5-3.6 2.5-1.7 0-3-.5-3.8-1.6"/>' },
  { key: 'reports', href: '/reports', label: 'Reports', group: 'People & money',
    question: 'Who is on shift, what they logged, and what is still owed a follow-up',
    icon: '<path d="M3.5 15.5V8.5M7.2 15.5V4.5M10.8 15.5v-5M14.5 15.5v-9"/><path d="M2.5 15.5h13"/>' },
  // Last on purpose. This is a weekly job for Ezan with the order sheet open
  // beside him, not something a CSR opens mid-shift, and putting it higher
  // would push the daily work down for everyone who does not own it.
  { key: 'errors', href: '/errors', label: 'Errors', group: 'People & money',
    question: 'Rows in the order sheet that cannot be true',
    icon: '<path d="M9 2.8 16.2 15H1.8z"/><path d="M9 7v3.4M9 12.6v.1"/>' },
  // The six owner-written documents. Last because it is the only section that
  // is not about today: nothing here changes when the engine runs, and nobody
  // opens it as part of a shift. They come to it when they need one rule.
  { key: 'handbook', href: '/handbook', label: 'Handbook', group: 'People & money',
    question: 'What the rule is, in the owner’s own words',
    icon: '<path d="M3.5 3.5h5A2.5 2.5 0 0 1 11 6v9a2 2 0 0 0-2-1.6H3.5z"/><path d="M14.5 3.5h-3A2.5 2.5 0 0 0 9 6v9a2 2 0 0 1 2-1.6h3.5z"/>' },
]);

// The keycap is PRINTED on every rail link, so every keycap has to work. The
// handler in SHELL_JS reads ONE character, which leaves exactly ten usable
// keys, so the tenth section is '0', not '10'. A two-character keycap renders
// perfectly and does nothing: an affordance advertising a shortcut the page
// does not have, which is worse than printing no keycap at all.
const KEYCAPS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

export const SECTION_BY_KEY = Object.freeze(
  Object.fromEntries(SECTIONS.map((s, i) => [s.key, { ...s, keycap: KEYCAPS[i] || '' }]))
);

// ============================================================================
// 6. THE SHELL
// ============================================================================

/** The pre-paint theme script. MUST be the first child of <body>.
 *
 *  Authority order: localStorage → the server's cookie → light. It stamps
 *  <html data-theme> before any markup paints, so a dark-mode user never gets
 *  the white flash, and it mirrors the choice into a cookie so the SERVER can
 *  stamp the same value on the next request and there is nothing to flash at
 *  all. There is no prefers-color-scheme here and none in app.css: the OS does
 *  not get a vote, only the toggle does. */
const THEME_BOOT =
  "try{var d=document.documentElement,t=localStorage.getItem('xs-theme');" +
  "if(t!=='dark'&&t!=='light'){t=d.getAttribute('data-theme')==='dark'?'dark':'light';localStorage.setItem('xs-theme',t);}" +
  "d.setAttribute('data-theme',t);" +
  "document.cookie='xs-theme='+t+';path=/;max-age=31536000;samesite=lax'+(location.protocol==='https:'?';secure':'');" +
  "}catch(e){document.documentElement.setAttribute('data-theme','light');}";

/** Everything else the shell needs on the client. Three small behaviours, no
 *  framework, no dependencies, and nothing that touches the data. */
const SHELL_JS = `
(function(){
  'use strict';
  var root = document.documentElement;

  // --- theme toggle: the ONLY thing that changes the palette -----------
  var toggle = document.getElementById('theme-toggle');
  if (toggle) toggle.addEventListener('click', function(){
    var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    toggle.setAttribute('aria-pressed', next === 'dark' ? 'true' : 'false');
    try {
      localStorage.setItem('xs-theme', next);
      document.cookie = 'xs-theme=' + next + ';path=/;max-age=31536000;samesite=lax' +
        (location.protocol === 'https:' ? ';secure' : '');
    } catch (e) {}
  });

  // --- 1-9 and 0 section shortcuts: the keycap is printed, so it must work ---
  document.addEventListener('keydown', function(e){
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    var t = e.target;
    if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
    if (e.key.length !== 1 || e.key < '0' || e.key > '9') return;
    var link = document.querySelector('.nav-link[data-key="' + e.key + '"]');
    if (link && link.getAttribute('href')) { e.preventDefault(); location.href = link.getAttribute('href'); }
  });

  // --- progressive enhancement for tick-and-save forms ------------------
  // A checkbox that saves needs a round trip. With JS the change submits;
  // without it the form's own submit button is still there and still works.
  document.addEventListener('change', function(e){
    var form = e.target && e.target.form;
    if (!form || !form.hasAttribute('data-autosubmit')) return;
    if (form.dataset.submitting === '1') return;
    form.dataset.submitting = '1';
    if (form.requestSubmit) form.requestSubmit(); else form.submit();
  });
  Array.prototype.forEach.call(document.querySelectorAll('[data-autosubmit] .js-submit'), function(b){
    b.hidden = true;
  });
})();

/* ---- quick replies drawer ------------------------------------------------
   Loads once, on first open. A failure closes with a sentence rather than an
   empty list: an empty library and an unreadable one are different facts, and
   only one of them means "write it yourself". */
(function(){
  var openBtn=document.getElementById('replies-open'),
      panel=document.getElementById('replies-panel'),
      closeBtn=document.getElementById('replies-close'),
      list=document.getElementById('replies-list'),
      q=document.getElementById('replies-q');
  if(!openBtn||!panel||!list) return;
  var all=null, kind='', loaded=false;

  function esc(t){ var d=document.createElement('div'); d.textContent=t==null?'':String(t); return d.innerHTML; }

  function badge(src){
    return src==='fiverr'
      ? '<span class="rep-badge rep-badge--fiverr">In Fiverr</span>'
      : '<span class="rep-badge">Hub only</span>';
  }

  function draw(){
    var needle=(q&&q.value||'').trim().toLowerCase();
    var rows=(all||[]).filter(function(r){
      if(kind && r.kind!==kind) return false;
      if(!needle) return true;
      return ((r.name||'')+' '+(r.when_to_use||'')+' '+(r.body||'')+' '+(r.category||''))
        .toLowerCase().indexOf(needle)>=0;
    });
    if(!rows.length){ list.innerHTML='<p class="caption">Nothing matches that.</p>'; return; }
    list.innerHTML=rows.map(function(r){
      return '<article class="rep">'
        +'<div class="rep-top">'+badge(r.source)+'<span class="rep-cat">'+esc(r.category||'')+'</span></div>'
        +'<h4>'+esc(r.name)+'</h4>'
        +(r.when_to_use?'<p class="rep-when">'+esc(r.when_to_use)+'</p>':'')
        +'<p class="rep-body">'+esc(r.body)+'</p>'
        +'<button class="btn btn--sm rep-copy" type="button" data-body="'+esc(r.body)+'">Copy</button>'
        +'</article>';
    }).join('');
  }

  function load(){
    if(loaded) return;
    loaded=true;
    fetch('/api/replies',{credentials:'same-origin',headers:{'x-requested-with':'XMLHttpRequest'}})
      .then(function(r){ if(!r.ok) throw 0; return r.json(); })
      .then(function(d){ all=d.replies||[]; draw(); })
      .catch(function(){
        loaded=false;
        list.innerHTML='<p class="note note--neg">The reply library could not be read. '
          +'That is unknown, not empty, so do not assume there is no saved line for this.</p>';
      });
  }

  function show(on){
    panel.hidden=!on;
    openBtn.setAttribute('aria-expanded',on?'true':'false');
    document.body.classList.toggle('replies-on',on);
    if(on){ load(); if(q) q.focus(); }
  }
  openBtn.addEventListener('click',function(){ show(panel.hidden); });
  if(closeBtn) closeBtn.addEventListener('click',function(){ show(false); });
  document.addEventListener('keydown',function(e){ if(e.key==='Escape'&&!panel.hidden) show(false); });
  if(q) q.addEventListener('input',draw);

  panel.addEventListener('click',function(e){
    var seg=e.target.closest('[data-kind]');
    if(seg){
      kind=seg.getAttribute('data-kind')||'';
      panel.querySelectorAll('[data-kind]').forEach(function(b){
        b.setAttribute('aria-current', b===seg ? 'true' : 'false');
      });
      draw(); return;
    }
    var copy=e.target.closest('.rep-copy');
    if(copy){
      var text=copy.getAttribute('data-body')||'';
      var done=function(){ var was=copy.textContent; copy.textContent='Copied';
        setTimeout(function(){ copy.textContent=was; },1200); };
      if(navigator.clipboard&&navigator.clipboard.writeText){
        navigator.clipboard.writeText(text).then(done,function(){});
      } else {
        var ta=document.createElement('textarea'); ta.value=text; document.body.appendChild(ta);
        ta.select(); try{ document.execCommand('copy'); done(); }catch(err){} ta.remove();
      }
    }
  });
})();
`;

const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' fill='%2317456E'/%3E%3Cpath d='M3 4h10M3 8h10M3 12h6' stroke='%23F6F3EB' stroke-width='1.6'/%3E%3C/svg%3E";

function navRail(ctx) {
  const groups = [];
  for (const item of ctx.nav || []) {
    let g = groups.find((x) => x.name === item.group);
    if (!g) groups.push((g = { name: item.group, items: [] }));
    g.items.push(item);
  }

  const links = groups.map(
    (g) => html`<p class="nav-group">${g.name}</p>${join(
        g.items.map(
          (item) => html`<a class="nav-link" href="${item.href}" data-key="${item.keycap}"
              ${safe(item.current ? 'aria-current="page"' : '')}
              ${safe(item.locked ? 'data-locked="1"' : '')}>
              <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.4"
                   stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${safe(item.icon)}</svg>
              <span class="lab">${item.label}</span>
              ${item.locked ? html`<span class="tag" title="Restricted">LOCKED</span>` : item.tag ? html`<span class="tag">${item.tag}</span>` : ''}
              <span class="keycap" aria-hidden="true">${item.keycap}</span>
            </a>`
        )
      )}`
  );

  // Signed out on the login page itself, the footer would offer a link to the
  // page you are already on. `chrome:'minimal'` is how a route says "frame
  // only": flag, no nav, no footer.
  // On a SHARED laptop the person is the volatile part, so it says whose shift
  // it is and offers the switch first. "Sign out" there means "my shift is
  // over", it clears the person and leaves the laptop trusted, so the next
  // CSR taps their name instead of fetching Ezan to type the password.
  const shared = ctx.device?.shared === true;
  const who = ctx.user
    ? html`<p class="caption">
          ${shared ? html`This shift: <strong>${ctx.user.name}</strong>` : html`Signed in as <strong>${ctx.user.name}</strong>`}
          · ${ctx.user.role}
        </p>
        ${shared
          ? html`<a class="btn btn--ghost btn--sm btn--block" href="/who">Not you? Switch</a>`
          : ''}
        <form method="post" action="/logout">
          <input type="hidden" name="_csrf" value="${ctx.csrfToken}">
          <button class="btn btn--ghost btn--sm btn--block" type="submit">
            ${shared ? 'End my shift' : 'Sign out'}
          </button>
        </form>`
    : ctx.chrome === 'minimal'
      ? ''
      : html`<a class="btn btn--ghost btn--sm btn--block" href="/login">Sign in</a>`;

  return html`<nav class="rail" aria-label="Sections">
      <div class="flag">
        <span class="flag-word">X<b>Studioz</b></span>
        <span class="flag-sub">Management hub</span>
      </div>
      <div class="nav">${join(links)}</div>
      <div class="rail-foot">
        <button class="theme-toggle" id="theme-toggle" type="button"
                aria-pressed="${ctx.theme === 'dark' ? 'true' : 'false'}">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
            <circle cx="8" cy="8" r="3.2"/><path d="M8 .8v2M8 13.2v2M.8 8h2M13.2 8h2M2.9 2.9l1.4 1.4M11.7 11.7l1.4 1.4M13.1 2.9l-1.4 1.4M4.3 11.7l-1.4 1.4"/>
          </svg>
          <span class="t-light theme-label">Dark</span>
          <span class="t-dark theme-label">Light</span>
          <span class="sr-only">Switch colour scheme</span>
        </button>
        ${who}
      </div>
    </nav>`;
}

/**
 * Three standing figures. A view may replace them, or refuse them outright by
 * returning `ticker: false`.
 *
 * It was six, and six was the single largest object in the app: two columns
 * over three rows, about 316px, sitting above every page's own lead figure.
 * Three of Today's six were restated as full figures 300px lower down, and
 * four of Entry's six were the literal contents of the inputs beneath them.
 *
 * Three is now the cap, and `false` is honoured. It could not be before:
 * `custom && custom.length` is falsy for `false`, so a view asking for no
 * ticker got the default six anyway.
 */
function tickerRow(ctx, custom) {
  if (custom === false) return '';
  const cells = custom && custom.length ? custom : ctx.ticker || [];
  if (!cells.length) return '';
  return html`<dl class="ticker">${join(
      cells.slice(0, 3).map(
        (c) => html`<div class="tick"><dt>${c.label}</dt><dd>${c.value}${
            c.sub ? html` <small>${c.sub}</small>` : ''
          }</dd></div>`
      )
    )}</dl>`;
}

/**
 * Who holds the desk right now, in one line under the dateline.
 *
 * One line, because the masthead is already the most crowded part of the page
 * and this is orientation rather than a figure. It answers the question a CSR
 * opening the hub mid-shift actually has: is this mine, and who else is on.
 *
 * When one person is alone it says so. That is not decoration: the roster's
 * own risk section accepts 75 hours a week at single cover, and a lone name
 * printed like a full desk hides a risk somebody signed off on knowingly.
 */
function deskLine(ctx) {
  const desk = ctx.desk;
  if (!desk) return '';

  const who = desk.names.length
    ? join(
        desk.on.map((p) => html`<b>${p.name}</b>`),
        ', '
      )
    : missing('nobody rostered');

  const next = desk.next
    ? html`<span class="dot">·</span><span>hands over at ${clock(desk.next.hour)}, ${desk.next.what}</span>`
    : '';

  return html`<p class="dateline desk${desk.alone ? ' desk-thin' : ''}">
    <span>${desk.label}</span><span class="dot">·</span>
    <span>on the desk ${who}${desk.alone ? html`, on their own` : ''}</span>${next}
  </p>`;
}

function noticeStack(ctx) {
  const out = (ctx.notices || []).map((n) => banner(n.level || 'info', n.title, n.body));
  if (ctx.flash?.ok) out.unshift(banner('info', 'Saved.', ctx.flash.ok));
  if (ctx.flash?.error) out.unshift(banner('crit', 'Not saved.', ctx.flash.error));
  return join(out);
}

/**
 * Wrap a view's result in the shell.
 *
 * @param {object} ctx    the request context (see server.js `buildCtx`)
 * @param {string|Safe|{html,title,kicker,deck,slug,ticker,head}} result
 * @returns {string} a complete HTML document
 */
/**
 * The quick replies, on every page.
 *
 * The moment a CSR needs a line is the moment they are looking at an order or
 * an inquiry, not at the Responses page. So the library follows them, one tap
 * from anywhere, searchable, with the body ready to copy.
 *
 * EVERY REPLY SAYS WHERE IT LIVES, and that is the point of the badge. A line
 * saved in Fiverr can be reached from Fiverr's own reply box in two taps; a
 * line that exists only here has to be copied from here. Without the mark a
 * CSR either hunts for something in Fiverr that was never there, or retypes
 * something that was. Fiverr has no API for its saved replies, so the answer
 * is typed by a person and read by everything else.
 *
 * The list loads on first open, not on page render. Most loads never open it.
 */
function repliesDrawer(ctx) {
  return html`<button class="replies-open" id="replies-open" type="button"
      aria-controls="replies-panel" aria-expanded="false"
      title="Quick replies">
      <span aria-hidden="true">&#9998;</span><span>Replies</span>
    </button>
    <aside class="replies" id="replies-panel" hidden aria-label="Quick replies">
      <header class="replies-head">
        <strong>Quick replies</strong>
        <button class="replies-close" id="replies-close" type="button" aria-label="Close">&times;</button>
      </header>
      <div class="replies-tools">
        <label class="sr-only" for="replies-q">Search replies</label>
        <input id="replies-q" type="search" placeholder="Search what they asked" autocomplete="off">
        <div class="segment segment--sm" role="group" aria-label="Kind of reply">
          <button type="button" data-kind="" aria-current="true">All</button>
          <button type="button" data-kind="quick">Templates</button>
          <button type="button" data-kind="case">Cases</button>
        </div>
      </div>
      <div class="replies-list" id="replies-list">
        <p class="caption">Loading the library…</p>
      </div>
      <p class="caption replies-foot">
        Sending from a buyer's page logs it against them. Copying from here does not, so log the decision
        if it changes what happens next.
      </p>
    </aside>`;
}

export function layout(ctx, result) {
  const view = result instanceof Safe || typeof result === 'string' ? { html: result } : result || {};

  // `html` and `head` ARE the section's markup, a view that builds a string by
  // concatenation is emitting HTML, so escaping its own output would render the
  // tags as visible text. Escaping applies to the DATA a view interpolates, and
  // `esc`/`html` are where that happens.
  //
  // `title`, `kicker` and `deck` are the opposite: they are prose, and they are
  // the fields most likely to carry a buyer's name straight from the join. A
  // plain string there stays escaped. A view that genuinely needs markup in a
  // deck says so with html`` or safe(), which is exactly the right amount of
  // friction for the one field where a client name meets a template.
  const bodyHtml = typeof view.html === 'string' ? safe(view.html) : view.html;
  const headExtra = typeof view.head === 'string' ? safe(view.head) : view.head;
  const section = SECTION_BY_KEY[ctx.section] || null;
  const pageTitle = [view.title || section?.label, 'XStudioz hub'].filter(Boolean).join(' · ');

  // ONE title, not four.
  //
  // The shell used to print the section's question as an h1, the view's title
  // as an h2, the section label again as a kicker beside it, and then a deck
  // paragraph. On Today that was: "What do I do now, and who owns it" / "12
  // tasks, and $7,627 that needs no new traffic" / "TODAY" / "$7,627 is
  // sitting still." Four blocks, one fact, roughly 200px, all of it in front
  // of the first number on the page.
  //
  // The section question is not news to somebody who just clicked that tab,
  // and the kicker repeats the tab they clicked. Both are gone. What is left
  // is the view's own title, once.
  const slug = view.slug === false ? '' : html`<div class="slug"><h2>${view.title || section?.label || 'XStudioz'}</h2></div>`;

  // The deck is deliberately dropped.
  //
  // All 30 of them restated a figure that appears below them, which is a
  // paragraph in front of a number: the exact inversion the house style
  // bans. Ignoring it at the shell rather than deleting 30 call sites means
  // one change fixes fourteen pages, and a view that still returns a deck is
  // wrong but not broken. `test_no_view_returns_a_deck` pins it so the field
  // does not creep back through a copied template.

  const doc = html`<!doctype html>
<html lang="en" data-theme="${ctx.theme === 'dark' ? 'dark' : 'light'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow,noarchive">
<meta name="referrer" content="same-origin">
<title>${pageTitle}</title>
<link rel="icon" href="${safe(FAVICON)}">
<link rel="stylesheet" href="/app.css">
${headExtra || ''}
</head>
<body>
<script nonce="${ctx.nonce}">${safe(THEME_BOOT)}</script>
<a class="sr-only" href="#main">Skip to content</a>
<div class="frame">
${navRail(ctx)}
<main class="sheet" id="main">
  <header class="masthead">
    <div class="masthead-top">
      <h1 class="sr-only">${ctx.headline || section?.question || 'XStudioz management hub'}</h1>
      <p class="dateline">
        <span>${ctx.runDateLabel}</span><span class="dot">·</span>
        <span>${ctx.engineLabel}</span><span class="dot">·</span>
        <span>${ctx.user ? ctx.user.name : 'not signed in'}</span>${ctx.device?.shared && ctx.user ? html`<span class="dot">·</span><a href="/who">not you?</a>` : ''}
      </p>
      ${deskLine(ctx)}
    </div>
    ${tickerRow(ctx, view.ticker)}
  </header>
  ${noticeStack(ctx)}
  <section class="view">
    ${slug}${bodyHtml || ''}
  </section>
</main>
</div>
<div class="grain" aria-hidden="true"></div>
${ctx.user ? repliesDrawer(ctx) : ''}
<script nonce="${ctx.nonce}">${safe(SHELL_JS)}</script>
</body>
</html>`;

  // The second pass. `esc` already scrubbed everything that went through it;
  // this catches anything a view built by hand and marked Safe. Two layers,
  // because the first one only protects the paths somebody remembered.
  return scrub(doc.value);
}

/**
 * The error page. Says what broke and what to do about it. Never a stack
 * trace, never an error code on its own, never a blank 500, a page that does
 * not say what happened is indistinguishable from a page that lost the data.
 */
export function errorPage(ctx, { status = 500, heading, what, why: reason = null, next = null }) {
  const body = html`<div class="figure">
      <span class="cap">HTTP ${String(status)}</span>
      <strong class="mid">${heading}</strong>
      <p class="sub">${what}</p>
    </div>
    ${reason ? html`<p class="note note--warn">${reason}</p>` : ''}
    ${next ? html`<div class="btnrow" style="margin-top:22px">${next}</div>` : ''}
    <div class="btnrow" style="margin-top:22px">
      <a class="btn btn--ghost" href="/">Back to Today</a>
    </div>`;

  return layout(ctx, { title: heading, kicker: 'Something broke', slug: true, html: body });
}

export default {
  Safe,
  safe,
  html,
  join,
  esc,
  attr,
  scrub,
  missing,
  known,
  money,
  num,
  pct,
  dateShort,
  dateTimeShort,
  days,
  rate,
  rangeFigure,
  meter,
  glyph,
  pill,
  stamp,
  panelHead,
  banner,
  why,
  empty,
  SECTIONS,
  SECTION_BY_KEY,
  MIN_SAMPLE,
  layout,
  errorPage,
};
