// views/inquiries.js, who asked, who converted, which CSR, which shift.
//
// THE HEADLINE IS THE DISAGREEMENT, NOT THE VOLUME.
//
// 319 inquiries is a number anybody can read off the sheet. The thing nobody
// could see is that 25 buyers marked "Not Placed" had already ordered, 27
// orders, $3,628, because the CSR who logs Monday's inquiry never sees
// Thursday's order land. That finding leads the page and every one of the 25
// is a row a human can resolve, which is the only loop this hub runs.
//
// WHAT THIS FILE MAY AND MAY NOT DO
//
//   - It reads leads.jsonl and orders.jsonl through lib/data.js and takes the
//     join itself from lib/reconcile.js. It does not re-derive the referee's
//     numbers; it renders them.
//   - Where it DOES group raw rows (the per-shift and per-CSR tables), it says
//     so in the panel's provenance stamp, because the engine publishes
//     `funnel.by_shift` and `funnel.by_csr` as EMPTY for this window and a
//     grouping of raw rows is not an engine figure.
//   - It never writes to a sheet. The only write on this page is
//     POST /inquiries/resolve, which records what a human decided about a
//     disagreement, never a correction to either source.
//
// R3, SPECIFICALLY
//
// Conversion is drawn as a Wilson band on a stated axis with its denominator
// printed, never as a bare point, including the all-time rates, where n=310
// would technically license a point. Two rates that are meant to be compared
// are drawn on the SAME axis, or the comparison is a drawing trick.
//
// The per-shift and per-CSR splits get NO bar and NO ranking. Morning 12,
// Night 12, Evening 10 in the engine's window; 18 named-CSR rows at the very
// most across the whole log. Those intervals overlap everything. The table
// states counts and the interval and then says, in words, that the sample
// cannot rank people, because a reader who sees a sorted table will rank
// them whatever the footnote says, so the sort order is by volume, never by
// rate.

import {
  html,
  safe,
  join,
  missing,
  money,
  num,
  dateShort,
  rate,
  rangeFigure,
  glyph,
  pill,
  panelHead,
  why,
  info,
  empty,
} from './layout.js';
import { MISSING, isMissing, pick, leads as engineLeads, orders as engineOrders } from '../lib/data.js';
import { normaliseBuyer } from '../lib/reconcile.js';

// ============================================================================
// FILTERS, plain GET state. No JS, so a filtered view is a shareable URL.
// ============================================================================

const LEAD_STATUSES = ['placed', 'not_placed', 'unknown'];

const STATUS_TABS = [
  { key: '', label: 'All' },
  { key: 'placed', label: 'Placed' },
  { key: 'not_placed', label: 'Not placed' },
  { key: 'unknown', label: 'Unknown' },
];

function readFilters(query = {}) {
  const s = (v, max = 60) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const iso = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(s(v)) ? s(v) : '');
  return {
    status: LEAD_STATUSES.includes(s(query.status)) ? s(query.status) : '',
    shift: s(query.shift, 40),
    csr: s(query.csr, 80),
    from: iso(query.from),
    to: iso(query.to),
    q: s(query.q, 80),
    ordered: s(query.ordered) === '1' ? '1' : '',
  };
}

function href(filters, overrides = {}) {
  const merged = { ...filters, ...overrides };
  const parts = Object.entries(merged)
    .filter(([, v]) => v !== '' && v !== null && v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  return parts.length ? `/inquiries?${parts.join('&')}` : '/inquiries';
}

function anyFilter(f) {
  return Object.values(f).some((v) => v !== '');
}

function matches(row, f, orderedBuyers) {
  if (f.status && (row.status ?? '') !== f.status) return false;
  if (f.shift) {
    const shift = row.shift ?? '';
    if (f.shift === '__none' ? shift !== '' : shift !== f.shift) return false;
  }
  if (f.csr) {
    const csr = row.csr ?? '';
    if (f.csr === '__none' ? csr !== '' : csr !== f.csr) return false;
  }
  if (f.from && !(typeof row.date === 'string' && row.date >= f.from)) return false;
  if (f.to && !(typeof row.date === 'string' && row.date <= f.to)) return false;
  if (f.ordered === '1' && !orderedBuyers.has(normaliseBuyer(row.client))) return false;
  if (f.q) {
    const needle = f.q.toLowerCase();
    const hay = [row.client, row.country, row.note, row.csr, row.service]
      .filter((v) => v != null)
      .join(' ')
      .toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}

// ============================================================================
// SMALL SHARED RENDERERS
// ============================================================================

/**
 * The link to one buyer.
 *
 * Prefer the NORMALISED key wherever a finding carries one: the client route
 * normalises whatever it is given, so `adrianc` reaches the same record as
 * "Adrian C" and cannot be broken by a space, a capital or a stray dot in the
 * spelling somebody typed into the sheet.
 */
function clientHref(name) {
  return `/clients/${encodeURIComponent(String(name ?? ''))}`;
}

const STATUS_PILL = {
  placed: ['ok', 'Placed'],
  not_placed: ['idle', 'Not placed'],
  unknown: ['warn', 'Unknown'],
};

function statusPill(status) {
  const spec = STATUS_PILL[status];
  if (!spec) return missing();
  return pill(spec[0], spec[1]);
}

/** Follow-ups logged on a row. `null` on all three is MISSING, not "F0". */
function followupDepth(row) {
  const flags = [row.followup_1, row.followup_2, row.followup_3];
  if (flags.every((v) => v == null)) return MISSING;
  return flags.filter((v) => v === true).length;
}

/**
 * The interval, always, next to the counts.
 *
 * `rate()` decides whether the headline text may be a single number; this
 * prints the Wilson bounds underneath it either way, so no row on this page
 * ever shows a rate without showing how wide it is.
 */
function rateCell(k, n) {
  const r = rate(k, n);
  if (!r.ok) return missing();
  const f = (x) => `${(x * 100).toFixed(1)}%`;
  // The counts lead, because they are exact. The rate goes underneath in the
  // form `rate()` licensed: a range where the interval is too wide to call, a
  // point plus its interval where it is not. Never both forms of the same
  // range, and never a rate without its denominator standing next to it.
  const under = r.small
    ? `95% ${r.text}`
    : r.lo === null
      ? r.text
      : `${r.text} · 95% ${f(r.lo)}–${f(r.hi)}`;
  return html`<span class="num">${String(k)}</span> of <span class="num">${String(n)}</span>
    <span class="cell-sub mono">${under}</span>`;
}

/** Group rows by a key, counting the sheet's claim and the order book's proof. */
function groupBy(rows, keyOf, orderedBuyers) {
  const map = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    let bucket = map.get(key);
    if (!bucket) map.set(key, (bucket = { key, n: 0, placed: 0, ordered: 0, quoted: 0, quotedKnown: 0 }));
    bucket.n += 1;
    if (row.status === 'placed') bucket.placed += 1;
    if (orderedBuyers.has(normaliseBuyer(row.client))) bucket.ordered += 1;
    if (Number.isFinite(row.quoted)) {
      bucket.quoted += row.quoted;
      bucket.quotedKnown += 1;
    }
  }
  // Sorted by VOLUME, never by rate. A table sorted by rate is a ranking
  // whatever the caption says, and these denominators cannot carry one.
  return [...map.values()].sort((a, b) => b.n - a.n || (a.key < b.key ? -1 : 1));
}

// ============================================================================
// THE VIEW
// ============================================================================

export function render(ctx) {
  const report = ctx.data?.report ?? null;
  const tracked = ctx.data?.tracked ?? null;
  const leadRows = engineLeads();
  const orderRows = engineOrders();

  // A source that is absent is not a source that is empty. Say which one.
  if (!report || report.available !== true) {
    const absent = report?.missing_sources?.length ? report.missing_sources.join(' and ') : 'the engine files';
    return {
      title: 'The inquiry join cannot be made',
      kicker: 'Inquiries',
      html: html`<div class="figure">
          <span class="cap">Referee unavailable</span>
          <strong class="mid">${missing()}</strong>
          <p class="sub">
            The referee joins the inquiry log to the order book on the Fiverr username. It refuses to
            run when either side is absent: reconciling 1,053 orders against "no inquiry file" would
            report 912 buyers who never inquired, which is a confident falsehood.
          </p>
        </div>
        <p class="note note--neg">Absent: <b>${absent}</b>. This is a broken deploy or a run that did not land, not an empty log.</p>`,
    };
  }

  const summary = report.summary;
  const conversion = report.conversion;
  const lost = report.findings.marked_lost_but_ordered;
  const wonNoOrder = report.findings.marked_won_no_order;
  const noInquiry = report.findings.order_without_inquiry;

  // Resolution state is TYPED, not computed. When the store is unreachable the
  // ticks are MISSING, an unticked box during an outage reads as "nobody has
  // dealt with this", which is a fact the hub does not have.
  const resolvedBy = tracked?.ok
    ? new Map(tracked.rows.map((r) => [`${normaliseBuyer(r.buyer)}::${r.finding}`, r]))
    : null;

  const orderedBuyers = new Set(
    isMissing(orderRows) ? [] : orderRows.map((r) => normaliseBuyer(r.client)).filter(Boolean)
  );

  const filters = readFilters(ctx.query || {});
  const allLeads = isMissing(leadRows) ? [] : leadRows;
  const filtered = allLeads.filter((r) => matches(r, filters, orderedBuyers));

  const lostKeys = new Set(lost.map((f) => f.buyer));

  // The engine scores a window, not the whole log. Both are shown, because the
  // window is the sample its conversion figure is computed on and it is far too
  // small to carry a per-person split, which is the point being made.
  const windowStart = pick(ctx.run, 'window.start');
  const windowLabel = pick(ctx.run, 'window.label');
  const windowLeads =
    typeof windowStart === 'string'
      ? allLeads.filter((r) => typeof r.date === 'string' && r.date >= windowStart)
      : null;

  return {
    title: `${summary.not_placed_but_ordered} buyers marked Not Placed had already ordered`,
    kicker: 'Inquiries',
    ticker: [
      { label: 'Inquiries logged', value: num(summary.leads), sub: 'rows' },
      { label: 'Distinct buyers', value: num(summary.lead_buyers), sub: 'the denominator' },
      { label: 'Sheet says placed', value: num(summary.marked_placed) },
      { label: 'Order book says', value: num(summary.actually_ordered), sub: 'ordered' },
      { label: 'Written off, then paid', value: money(summary.not_placed_but_ordered_value, { cents: false }) },
      { label: 'Won with no order', value: num(summary.placed_no_order) },
    ],
    html: join([
      lede(summary, conversion),
      identity(summary),
      findingsPanel(lost, resolvedBy, ctx),
      wonNoOrderPanel(wonNoOrder, resolvedBy),
      windowFunnel(ctx),
      splitPanel('By shift', 'shift', groupBy(allLeads, (r) => r.shift ?? '', orderedBuyers), filters, {
        label: windowLabel,
        groups: windowLeads ? groupBy(windowLeads, (r) => r.shift ?? '', orderedBuyers) : null,
      }),
      splitPanel('By CSR', 'csr', groupBy(allLeads, (r) => r.csr ?? '', orderedBuyers), filters, {
        label: windowLabel,
        groups: windowLeads ? groupBy(windowLeads, (r) => r.csr ?? '', orderedBuyers) : null,
      }),
      noInquiryPanel(summary, noInquiry),
      logPanel(leadRows, filtered, filters, lostKeys, orderedBuyers),
    ]),
  };
}

// ---------------------------------------------------------------- 1. the lede

function lede(summary, conversion) {
  const unpriced = summary.not_placed_but_ordered_unpriced;

  return html`<div class="lede">
      <div class="lede-main">
        <div class="figure">
          <span class="cap">Written off, then ordered anyway</span>
          <strong class="big">${money(summary.not_placed_but_ordered_value, { cents: false })}</strong>
          <p class="sub">
            <b>${num(summary.not_placed_but_ordered)} buyers</b> the CSRs marked
            <b>Not Placed</b> placed <b>${num(summary.not_placed_but_ordered_orders)} orders</b> between
            them.${unpriced
              ? html` ${num(unpriced)} of those orders carry no amount in the order book, so this figure is a
                floor, not a total.`
              : ''}
          </p>
        </div>
        ${why(
          'Why nobody was wrong',
          html`<p>
              The inquiry log and the order book are kept by different people at different times. A CSR
              logs Monday's inquiry and closes it; the order lands on Thursday under the same Fiverr
              username and nothing walks back to the earlier row. Neither record is a lie, they simply
              never meet.
            </p>
            <p>
              The join is on the username, normalised to lowercase alphanumerics, so
              <span class="mono">Nativ_Shaibi</span>, <span class="mono">nativ shaibi</span> and
              <span class="mono">nativ_shaibi</span> are one buyer. Nothing is fuzzy-matched: a near-miss
              would attach money to a buyer on the strength of a typo, which is the exact link this page
              exists to check.
            </p>
            <p>
              <strong>This page never edits either source.</strong> Ticking a row records what a human
              decided, in the hub's own store, with their name on it.
            </p>`
        )}
      </div>

      <div class="lede-side">
        <div class="figure">
          <span class="cap">Gap between the sheet and the order book</span>
          <strong class="mid">${num(conversion.gap_points, { dp: 1 })} points</strong>
          <p class="sub">
            Both rates below sit on the same axis and the same denominator, 
            <b>${num(conversion.denominator)} ${conversion.denominator_basis}</b>. A buyer who asked twice
            is one chance to convert, not two.
          </p>
        </div>

        <div class="stack-sm">
          <p class="eyebrow">What the sheet claims</p>
          ${rangeFigure({
            k: conversion.claimed_placed,
            n: conversion.denominator,
            axisMin: 0,
            axisMax: 0.5,
            note: 'leads marked placed',
          })}

          <p class="eyebrow">What the order book proves</p>
          ${rangeFigure({
            k: conversion.true_converted,
            n: conversion.denominator,
            axisMin: 0,
            axisMax: 0.5,
            note: 'buyers who ever ordered',
          })}

          ${info(`Drawn as bands, not points, on one shared axis. Two rates compared on two axes is a drawing trick, and a point estimate hides the width that decides whether the gap is real.`)}
        </div>
      </div>
    </div>`;
}

// ------------------------------------------------------- 2. the identity check

function identity(s) {
  const neither = s.lead_buyers - s.placed_and_ordered - s.placed_no_order - s.not_placed_but_ordered;
  const sums = s.placed_and_ordered + s.placed_no_order + s.not_placed_but_ordered + neither === s.lead_buyers;

  return html`<div class="panel">
      ${panelHead('Every inquiring buyer, once', 'live', 'Live · leads.jsonl ⋈ orders.jsonl')}
      <div class="stack-sm">
      <dl class="stats">
        <div class="stat">
          <dt>Agreed, placed and ordered</dt>
          <dd>${num(s.placed_and_ordered)}</dd>
        </div>
        <div class="stat">
          <dt>Marked won, no order</dt>
          <dd class="warn">${num(s.placed_no_order)}</dd>
        </div>
        <div class="stat">
          <dt>Marked lost, ordered</dt>
          <dd class="neg">${num(s.not_placed_but_ordered)}</dd>
        </div>
        <div class="stat">
          <dt>Neither claimed nor ordered</dt>
          <dd>${num(neither)}</dd>
        </div>
        <div class="stat">
          <dt>Distinct inquiring buyers</dt>
          <dd>${num(s.lead_buyers)}</dd>
        </div>
      </dl>
      <p class="caption">
        ${glyph(sums ? 'ok' : 'crit')}
        ${num(s.placed_and_ordered)} + ${num(s.placed_no_order)} + ${num(s.not_placed_but_ordered)} +
        ${num(neither)} = ${num(s.lead_buyers)}.
        ${sums
          ? 'The four buckets are exclusive and exhaustive, so nothing is double-counted and nothing is unaccounted for.'
          : 'These do not sum. Treat every figure on this page as suspect and check the join.'}
      </p>
      </div>
    </div>`;
}

// ------------------------------------------------- 3. the 25 rows to resolve

function findingsPanel(rows, resolvedBy, ctx) {
  const total = rows.length;
  const dbDown = resolvedBy === null;

  return html`<div class="panel">
      ${panelHead(
        `Marked lost, ordered anyway, ${total} buyers`,
        dbDown ? 'missing' : 'typed',
        dbDown ? 'Resolution state MISSING' : 'Typed · reconciliation'
      )}
      <p class="note">
        Each row is one buyer to settle: check what actually happened, then record it here. The tick is
        the hub's own record of a human decision, <b>the inquiry sheet and the order book are never
        touched</b>.
      </p>
      ${dbDown
        ? html`<p class="note note--neg">
            The typed-records store is unreachable, so whether these were already resolved is
            ${missing()}, not "no". The boxes are disabled rather than shown empty, because an empty
            box would be a fact the hub does not have.
          </p>`
        : ''}
      ${total === 0
        ? empty('No buyer marked Not Placed appears in the order book. That is a fact, not a missing figure.')
        : html`<ol class="tasks">${join(rows.map((f) => findingRow(f, resolvedBy, dbDown, ctx)))}</ol>`}
    </div>`;
}

function findingRow(f, resolvedBy, dbDown, ctx) {
  const stored = dbDown ? null : resolvedBy.get(`${f.buyer}::${f.finding}`) || null;
  const isDone = !dbDown && stored?.resolved === 1;
  const inputId = `res-${f.finding}-${f.buyer}`;

  return html`<li class="task${safe(isDone ? ' is-done' : '')}">
      <form method="post" action="/inquiries/resolve">
        <input type="hidden" name="_csrf" value="${ctx.csrfToken}">
        <input type="hidden" name="back" value="/inquiries">
        <input type="hidden" name="buyer" value="${f.buyer}">
        <input type="hidden" name="finding" value="${f.finding}">
        <input type="hidden" name="first_seen" value="${isMissing(f.first_seen) ? '' : f.first_seen}">
        <input type="hidden" name="amount" value="${isMissing(f.total_value) ? '' : String(f.total_value)}">

        <label class="task-row" for="${inputId}">
          <span class="chk">
            <input type="checkbox" id="${inputId}" name="resolved" value="1"
                   ${safe(isDone ? 'checked' : '')} ${safe(dbDown ? 'disabled' : '')}>
          </span>
          <span class="task-body">
            <span class="task-head">
              <span class="task-title">${f.buyer_display}</span>
              ${money(f.total_value)}
            </span>
            <span class="task-meta">
              <span class="amt">${num(f.order_count)} order${safe(f.order_count === 1 ? '' : 's')}</span>
              <span>inquired ${dateShort(f.first_lead_date)}</span>
              <span>ordered ${dateShort(f.first_order_date)}</span>
              ${f.csr && !isMissing(f.csr) ? html`<span class="owner">${f.csr}</span>` : ''}
              ${f.logged_as_display_name ? pill('warn', 'Logged as a name') : ''}
              ${dbDown ? pill('idle', 'State MISSING') : isDone ? pill('ok', 'Resolved') : pill('crit', 'Open')}
            </span>
          </span>
        </label>

        <div class="task-extra">
          <div class="field">
            <label for="${inputId}-note">What was decided</label>
            <textarea id="${inputId}-note" name="resolution" rows="2"
                      placeholder="e.g. order confirmed, inquiry row was closed early, logged with the CSR"
                      ${safe(dbDown ? 'disabled' : '')}>${stored?.resolution || ''}</textarea>
            <p class="field-hint">
              Stored against <span class="mono">${f.buyer}</span> in the hub, with your name and the time.
            </p>
          </div>
          <div class="btnrow">
            <button class="btn btn--sm" type="submit" ${safe(dbDown ? 'disabled aria-disabled="true"' : '')}>
              Save this row
            </button>
            <a class="btn btn--ghost btn--sm" href="${clientHref(f.buyer)}">Open this client</a>
          </div>
          ${why(
            'The evidence for this row',
            html`<ul>
                <li>Inquiry log status: <b>${join(f.lead_status.map((s) => html`${s}`), ', ')}</b> across ${num(f.lead_rows)} logged row${safe(f.lead_rows === 1 ? '' : 's')}.</li>
                <li>Quoted at the time: ${money(f.quoted)}.</li>
                <li>Orders found under this username: ${num(f.order_count)}, of which ${num(f.orders_priced)} carry an amount${f.orders_without_value ? html` and ${num(f.orders_without_value)} do not` : ''}.</li>
                <li>First contact ${dateShort(f.first_lead_date, { year: true })}; first order ${dateShort(f.first_order_date, { year: true })}.</li>
                ${f.logged_as_display_name
                  ? html`<li>
                      <strong>This buyer was logged under a typed name, not a Fiverr username.</strong> The
                      join that found these orders came from another row for the same buyer; treat the
                      match as evidence to check, not as settled.
                    </li>`
                  : ''}
              </ul>
              ${stored?.resolved_by
                ? html`<p>Resolved by <strong>${stored.resolved_by}</strong>${stored.resolved_at ? html` on ${dateShort(String(stored.resolved_at).slice(0, 10))}` : ''}.</p>`
                : ''}`
          )}
        </div>
      </form>
    </li>`;
}

// ------------------------------------------------ 4. marked won, no order

function wonNoOrderPanel(rows, resolvedBy) {
  const dbDown = resolvedBy === null;
  const displayNamed = rows.filter((r) => r.logged_as_display_name).length;

  return html`<div class="panel">
      ${panelHead(`Marked won, no order behind it, ${rows.length}`, 'live', 'Live · leads.jsonl ⋈ orders.jsonl')}
      ${rows.length === 0
        ? empty('Every lead marked placed has an order behind it.')
        : html`<div class="tablewrap">
              <table class="table table--wide">
                <thead>
                  <tr>
                    <th scope="col">Buyer as logged</th>
                    <th scope="col">Inquired</th>
                    <th scope="col" class="r">Quoted</th>
                    <th scope="col">CSR</th>
                    <th scope="col">Why no order was found</th>
                    <th scope="col">State</th>
                  </tr>
                </thead>
                <tbody>
                  ${join(
                    rows.map((f) => {
                      const stored = dbDown ? null : resolvedBy.get(`${f.buyer}::${f.finding}`) || null;
                      return html`<tr class="row-attn">
                          <td><span class="cell-name">${f.buyer_display}</span>
                            <span class="cell-sub mono">${f.buyer}</span></td>
                          <td>${dateShort(f.first_lead_date)}</td>
                          <td class="r cell-figure">${money(f.quoted)}</td>
                          <td>${f.csr}</td>
                          <td>${
                            f.logged_as_display_name
                              ? 'Logged as a typed name, not a Fiverr username, no exact join can reach this buyer.'
                              : 'Username-shaped, and no order carries it. Either the order is under a different account or the win was logged early.'
                          }</td>
                          <td>${dbDown ? missing() : stored?.resolved === 1 ? pill('ok', 'Resolved') : pill('warn', 'Open')}</td>
                        </tr>`;
                    })
                  )}
                </tbody>
              </table>
              <p class="tablehint" aria-hidden="true">Scroll sideways for more columns →</p>
            </div>`}
      ${why(
        'Why these are not simply corrected',
        html`<p>
            ${num(displayNamed)} of ${num(rows.length)} were logged as a typed display name, "Adrian C",
            "Andrew", and a display name cannot be joined to anything. The rest are username-shaped and
            still find nothing.
          </p>
          <p>
            <strong>Nothing here is fuzzy-matched.</strong> A username one character from a real one is
            exactly the case where guessing attaches somebody else's money to this buyer. The hub reports
            "this cannot be joined, and here is why"; a human decides, and the decision is recorded
            against the buyer with their name on it.
          </p>`
      )}
    </div>`;
}

// ------------------------------------------------ 5. the engine's own window

function windowFunnel(ctx) {
  const get = (path) => pick(ctx.run, path);

  const n = get('metrics.funnel.inquiries');
  const k = get('metrics.funnel.placed');
  const label = get('window.label');
  const tooFew = get('metrics.funnel.too_few_to_call');
  const pipeline = get('metrics.funnel.pipeline_value');
  const quotedMean = get('metrics.funnel.quoted_mean');

  const usable = !isMissing(n) && !isMissing(k) && Number.isFinite(n) && Number.isFinite(k) && n > 0;

  return html`<div class="panel">
      ${panelHead(
        `The engine's window, ${isMissing(label) ? 'window MISSING' : String(label)}`,
        isMissing(n) ? 'missing' : 'live',
        'Live · latest-run.json · metrics.funnel'
      )}
      ${usable
        ? html`<div class="stack">
            <div class="figure">
              <span class="cap">Conversion in the window</span>
              <strong class="mid">${num(k)} of ${num(n)}</strong>
              <p class="sub">
                ${tooFew === true
                  ? html`The engine flags this itself: the interval is wider than it will call. <b>This is a
                      range and nothing else.</b> It contains "conversion collapsed" and "nothing
                      happened" at the same time.`
                  : 'Stated with its interval and its denominator.'}
              </p>
            </div>
            ${rangeFigure({ k, n, axisMin: 0, axisMax: 0.3, note: 'window conversion' })}
            <dl class="stats">
              <div class="stat"><dt>Pipeline value in window</dt><dd>${money(pipeline)}</dd></div>
              <div class="stat"><dt>Mean quote</dt><dd>${money(quotedMean)}</dd></div>
              <div class="stat"><dt>Denominator</dt><dd>${num(n)} <span class="u">inquiries</span></dd></div>
            </dl>
          </div>`
        : html`<div class="figure">
            <span class="cap">Window funnel</span>
            <strong class="mid">${missing()}</strong>
            <p class="sub">The run does not carry <span class="mono">metrics.funnel</span>. Nothing is substituted for it.</p>
          </div>`}
    </div>`;
}

// ------------------------------------- 6. shift and CSR, counts, never a rank

function splitPanel(title, kind, groups, filters, scoped = { label: MISSING, groups: null }) {
  const named = groups.filter((g) => g.key !== '');
  const blank = groups.find((g) => g.key === '') || null;
  const total = groups.reduce((n, g) => n + g.n, 0);
  const attributed = named.reduce((n, g) => n + g.n, 0);
  const biggest = named.length ? named[0].n : 0;

  // Nothing to group. Whether that is an absent log or an empty one is a
  // distinction the caller holds and the log panel below already states, so
  // this renders no panel rather than a second, vaguer version of it.
  if (!total) return '';

  return html`<div class="panel">
      ${panelHead(title, 'live', 'Grouped from leads.jsonl, not an engine figure')}

      <p class="note note--warn">
        ${glyph('warn')} <b>This table cannot rank anybody and is not sorted as if it could.</b>
        The largest group here is ${num(biggest)} inquiries. Every interval below overlaps every other
        one, so any ordering you read into it is noise. Rows are sorted by volume; there is deliberately
        no bar, no arrow and no "best" column.
      </p>

      <div class="tablewrap">
        <table class="table">
          <thead>
            <tr>
              <th scope="col">${kind === 'csr' ? 'CSR' : 'Shift'}</th>
              <th scope="col" class="r">Inquiries</th>
              <th scope="col" class="r">Sheet says placed</th>
              <th scope="col" class="r">Buyer ever ordered</th>
              <th scope="col" class="r">Quoted</th>
            </tr>
          </thead>
          <tbody>
            ${join(
              named.map(
                (g) => html`<tr>
                    <td>
                      <a class="cell-name" href="${href(filters, { [kind]: g.key })}">${g.key}</a>
                    </td>
                    <td class="r cell-figure">${num(g.n)}</td>
                    <td class="r">${rateCell(g.placed, g.n)}</td>
                    <td class="r">${rateCell(g.ordered, g.n)}</td>
                    <td class="r cell-figure">${g.quotedKnown ? money(g.quoted) : missing()}
                      <span class="cell-sub">${num(g.quotedKnown)} of ${num(g.n)} quoted</span></td>
                  </tr>`
              )
            )}
            ${blank
              ? html`<tr class="row-cleared">
                  <td><a href="${href(filters, { [kind]: '__none' })}">${missing()}</a>
                    <span class="cell-sub">not recorded on the row</span></td>
                  <td class="r cell-figure">${num(blank.n)}</td>
                  <td class="r">${rateCell(blank.placed, blank.n)}</td>
                  <td class="r">${rateCell(blank.ordered, blank.n)}</td>
                  <td class="r cell-figure">${blank.quotedKnown ? money(blank.quoted) : missing()}
                    <span class="cell-sub">${num(blank.quotedKnown)} of ${num(blank.n)} quoted</span></td>
                </tr>`
              : ''}
          </tbody>
        </table>
      </div>

      <p class="caption">
        ${num(attributed)} of ${num(total)} inquiries carry a ${kind === 'csr' ? 'CSR' : 'shift'}.
        ${kind === 'csr' && blank
          ? html`The ${num(blank.n)} with none are not a person's column, they are the column nobody filled
              in, and they hold most of the log.`
          : ''}
      </p>

      ${scoped.groups ? windowSplit(kind, scoped) : ''}

      ${why(
        'Why no bar is drawn here',
        html`<p>
            A bar invites a comparison, and a comparison needs a denominator that can carry one. Below
            about thirty observations the Wilson interval on a conversion rate is wider than the whole
            spread between the groups, so the picture would show a difference the data cannot support.
          </p>
          <p>
            "Buyer ever ordered" counts inquiry <strong>rows</strong> whose buyer appears anywhere in the
            order book, including orders placed months later, and including a buyer who appears on more
            than one row. The referee counts each buyer once, so these columns will not add up to its
            figures and are not meant to. They are here to show that the sheet's "placed" column is the
            lower one in every single group, which is the finding; they are not here to score anybody.
          </p>`
      )}
    </div>`;
}

/**
 * The same split, restricted to the window the engine actually scores.
 *
 * This is the table the whole "cannot rank people" warning is really about:
 * a dozen inquiries per shift, one or two conversions each. It is shown rather
 * than hidden, because the alternative is somebody computing it themselves in
 * a spreadsheet with no interval attached to it at all.
 */
function windowSplit(kind, scoped) {
  const named = scoped.groups.filter((g) => g.key !== '');
  const blank = scoped.groups.find((g) => g.key === '') || null;
  const rows = blank ? named.concat(blank) : named;
  const total = scoped.groups.reduce((n, g) => n + g.n, 0);
  if (!total) return '';

  return html`<div class="block">
      <h3>${isMissing(scoped.label) ? 'The engine window' : `The engine window, ${String(scoped.label)}`}</h3>
      <div class="tablewrap">
        <table class="table table--narrow">
          <thead>
            <tr>
              <th scope="col">${kind === 'csr' ? 'CSR' : 'Shift'}</th>
              <th scope="col" class="r">Inquiries</th>
              <th scope="col" class="r">Sheet says placed</th>
            </tr>
          </thead>
          <tbody>
            ${join(
              rows.map(
                (g) => html`<tr>
                    <td>${g.key === '' ? missing() : html`<span class="cell-name">${g.key}</span>`}</td>
                    <td class="r cell-figure">${num(g.n)}</td>
                    <td class="r">${rateCell(g.placed, g.n)}</td>
                  </tr>`
              )
            )}
          </tbody>
        </table>
      </div>
      <p class="note note--warn">
        ${glyph('warn')} ${num(total)} inquiries split ${num(rows.length)} ways. Every interval here spans
        most of the possible range. <b>This is not a scoreboard and it cannot be made into one by
        sorting it.</b> It is here so that the number nobody should act on is at least visible with its
        denominator attached.
      </p>
    </div>`;
}

// ------------------------------------------ 7. orders with no inquiry at all

function noInquiryPanel(summary, rows) {
  const top = rows.slice(0, 8);
  return html`<div class="panel">
      ${panelHead('Ordered without ever inquiring', 'live', 'Live · orders.jsonl ⋈ leads.jsonl')}
      <dl class="stats">
        <div class="stat"><dt>Buyers</dt><dd>${num(summary.orders_without_inquiry_buyers)}</dd></div>
        <div class="stat"><dt>Orders</dt><dd>${num(summary.orders_without_inquiry_orders)}</dd></div>
        <div class="stat"><dt>Value</dt><dd>${money(summary.orders_without_inquiry_value)}</dd></div>
        <div class="stat"><dt>Buyers in the inquiry log</dt><dd>${num(summary.lead_buyers)} <span class="u">of ${String(summary.order_buyers)}</span></dd></div>
      </dl>
      <p class="note">
        <b>This is a scope statement, not a task list.</b> The inquiry log covers
        ${num(summary.lead_buyers)} of the ${num(summary.order_buyers)} buyers in the order book. Most
        orders simply arrive without a logged conversation, so this number describes what the log is,
        not what anybody failed to do, and it is the reason every rate on this page states its
        denominator.
      </p>
      ${why(
        `The eight largest, by value`,
        html`<div class="tablewrap">
            <table class="table table--narrow">
              <thead><tr><th scope="col">Buyer</th><th scope="col" class="r">Orders</th><th scope="col" class="r">Value</th><th scope="col">First seen</th></tr></thead>
              <tbody>
                ${join(
                  top.map(
                    (f) => html`<tr>
                        <td><a class="cell-name" href="${clientHref(f.buyer)}">${f.buyer_display}</a></td>
                        <td class="r cell-figure">${num(f.order_count)}</td>
                        <td class="r cell-figure">${money(f.total_value)}</td>
                        <td>${dateShort(f.first_order_date)}</td>
                      </tr>`
                  )
                )}
              </tbody>
            </table>
          </div>`
      )}
    </div>`;
}

// -------------------------------------------------------- 8. the whole log

function logPanel(leadRows, filtered, filters, lostKeys, orderedBuyers) {
  if (isMissing(leadRows)) {
    return html`<div class="panel">
        ${panelHead('Every inquiry', 'missing', 'leads.jsonl absent')}
        <div class="figure">
          <span class="cap">The inquiry log</span>
          <strong class="mid">${missing()}</strong>
          ${info(`data/leads.jsonl is not readable. That is not an empty log, no row count, no conversion and no shift split can be stated from here.`)}
        </div>
      </div>`;
  }

  const shifts = [...new Set(leadRows.map((r) => r.shift).filter(Boolean))].sort();
  const csrs = [...new Set(leadRows.map((r) => r.csr).filter(Boolean))].sort();

  return html`<div class="panel">
      ${panelHead('Every inquiry', 'live', `Live · leads.jsonl · ${leadRows.length} rows`)}

      <div class="segment" role="group" aria-label="Filter by status">
        ${join(
          STATUS_TABS.map(
            (t) => html`<a href="${href(filters, { status: t.key })}"
                ${safe(filters.status === t.key ? 'aria-current="true"' : '')}>${t.label}</a>`
          )
        )}
        <a href="${href(filters, { ordered: filters.ordered === '1' ? '' : '1' })}"
           ${safe(filters.ordered === '1' ? 'aria-current="true"' : '')}>Buyer ordered</a>
      </div>

      <form class="toolbar" method="get" action="/inquiries">
        <span class="search">
          <label class="sr-only" for="q">Search buyer, country or note</label>
          <input type="search" id="q" name="q" value="${filters.q}" placeholder="Buyer, country or note">
        </span>
        <span class="field">
          <label for="f-shift">Shift</label>
          <select id="f-shift" name="shift">
            <option value="">Any</option>
            ${join(
              shifts.map((s) => html`<option value="${s}" ${safe(filters.shift === s ? 'selected' : '')}>${s}</option>`)
            )}
            <option value="__none" ${safe(filters.shift === '__none' ? 'selected' : '')}>Not recorded</option>
          </select>
        </span>
        <span class="field">
          <label for="f-csr">CSR</label>
          <select id="f-csr" name="csr">
            <option value="">Any</option>
            ${join(
              csrs.map((c) => html`<option value="${c}" ${safe(filters.csr === c ? 'selected' : '')}>${c}</option>`)
            )}
            <option value="__none" ${safe(filters.csr === '__none' ? 'selected' : '')}>Not recorded</option>
          </select>
        </span>
        <span class="field">
          <label for="f-from">From</label>
          <input type="date" id="f-from" name="from" value="${filters.from}">
        </span>
        <span class="field">
          <label for="f-to">To</label>
          <input type="date" id="f-to" name="to" value="${filters.to}">
        </span>
        ${filters.status ? html`<input type="hidden" name="status" value="${filters.status}">` : ''}
        ${filters.ordered ? html`<input type="hidden" name="ordered" value="${filters.ordered}">` : ''}
        <button class="btn btn--sm" type="submit">Apply</button>
        ${anyFilter(filters) ? html`<a class="btn btn--ghost btn--sm" href="/inquiries">Clear</a>` : ''}
        <span class="count">${filtered.length} of ${leadRows.length}</span>
      </form>

      ${completeness(leadRows)}

      ${filtered.length === 0
        ? empty('No inquiry matches these filters. The log is not empty, this selection is.')
        : html`<div class="tablewrap tablewrap--capped">
              <table class="table table--wide table--zebra">
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col">Buyer</th>
                    <th scope="col">Country</th>
                    <th scope="col">Sheet says</th>
                    <th scope="col">Shift</th>
                    <th scope="col">CSR</th>
                    <th scope="col" class="r">Quoted</th>
                    <th scope="col" class="c">Follow-ups</th>
                  </tr>
                </thead>
                <tbody>
                  ${join(filtered.map((row) => logRow(row, lostKeys, orderedBuyers)))}
                </tbody>
              </table>
              <p class="tablehint" aria-hidden="true">Scroll sideways for more columns →</p>
            </div>`}

      ${info(`Rows marked ordered anyway are the referee's finding shown where the mistake was made. Filters are in the URL, so a filtered view is a link you can send. The buyer's own note, where one was typed, sits under their name.`)}
    </div>`;
}

/**
 * What the log does not hold.
 *
 * Printed BEFORE the table, because the table is about to show several hundred
 * MISSING chips and a reader who meets them without warning reads them as a
 * rendering fault instead of as the finding. Those cells are not blank and
 * they are not zero: the field was never filled in, and on `quoted` that is
 * the difference between a pipeline figure and a floor.
 */
function completeness(rows) {
  const n = rows.length;
  const gaps = [
    ['no quote', rows.filter((r) => !Number.isFinite(r.quoted)).length],
    ['no CSR', rows.filter((r) => !r.csr).length],
    ['no country', rows.filter((r) => !r.country).length],
    ['no shift', rows.filter((r) => !r.shift).length],
  ].filter(([, k]) => k > 0);
  if (!gaps.length) return '';

  return html`<p class="note note--warn">
      ${glyph('warn')} Of ${num(n)} rows:
      ${join(
        gaps.map(([label, k]) => html`<b>${num(k)}</b> ${label}`),
        ', '
      )}. Those cells read ${missing()} rather than blank or 0, a quote that was never recorded is not a
      quote of nothing, and it is why every value on this page is stated as a floor.
    </p>`;
}

function logRow(row, lostKeys, orderedBuyers) {
  const key = normaliseBuyer(row.client);
  const contradicted = lostKeys.has(key);
  const ordered = orderedBuyers.has(key);
  const depth = followupDepth(row);

  return html`<tr class="${safe(contradicted ? 'row-attn' : '')}">
      <td>${dateShort(row.date)}</td>
      <td>
        <a class="cell-name" href="${clientHref(row.client)}">${row.client}</a>
        ${contradicted
          ? html`<span class="cell-sub">${pill('crit', 'Ordered anyway')}</span>`
          : ordered && row.status !== 'placed'
            ? html`<span class="cell-sub">buyer appears in the order book</span>`
            : ''}
        ${row.note ? html`<span class="cell-sub">${row.note}</span>` : ''}
      </td>
      <td>${row.country ?? missing()}</td>
      <td>${statusPill(row.status)}</td>
      <td>${row.shift ?? missing()}</td>
      <td>${row.csr ?? missing()}</td>
      <td class="r cell-figure">${money(row.quoted)}</td>
      <td class="c">${isMissing(depth) ? missing() : html`<span class="mono">F${String(depth)}</span>`}</td>
    </tr>`;
}

export default { render };
