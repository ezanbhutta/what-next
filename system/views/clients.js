// views/clients.js, one record per buyer, keyed on the Fiverr username.
//
// WHAT THIS PAGE IS FOR
//
// The order book has 1,053 rows and no concept of a person. The inquiry log
// has 319 rows and its own idea of who is who. This page is the only place the
// two are collapsed onto one identifier, the Fiverr username, so that
// "yasgard" is a client with a history rather than a string that appears in
// two spreadsheets. Everything above the list exists to say the one thing the
// row-level views cannot: 125 of the 912 buyers came back, and they are worth
// $25,845 of a $118,299 book.
//
// WHERE EVERY FIGURE COMES FROM
//
//   orders.jsonl / leads.jsonl   the aggregate. Order counts, lifetime value,
//                                first and last order, review capture, whether
//                                the buyer ever reached the inquiry log, all
//                                of it is a GROUPING of engine rows, computed
//                                here and nowhere else. No SQL sums anything.
//   latest-run.json              only for the open-order picture on a client's
//                                own page (recovery.open_orders), rendered as
//                                published, and for the stale threshold, which
//                                is the engine's number rather than one this
//                                file invented.
//   client_note                  typed, MySQL. Notes, sends and dead-flags.
//   upsell                       typed, MySQL. The stage column, and nothing
//                                else, no money on this page comes from it.
//
// TWO RULES THIS FILE IS CARRYING, LOUDLY
//
//   R6  A client page is exactly where somebody would put an "ask them for a
//       review" button, and a "never reviewed" column is exactly the list they
//       would work down. There is no such affordance here and none may be
//       added: on this data, "never reviewed" and "ordered eight months ago"
//       are the same people, and a review ask on a late or cold order is the
//       most reliable way to turn a private three-star into a public one. The
//       column says what the book says; the note underneath says what not to
//       do with it.
//   R2  A buyer with no priced order has lifetime value MISSING, not $0. A
//       buyer with an unpriced order among priced ones has a FLOOR, and the
//       cell says so. When the typed store is unreachable the notes and upsell
//       columns are MISSING, never "no notes", which during an outage is a
//       claim the hub is in no position to make.
//
// EXPORTED FOR REUSE
//
//   clientRecord(buyer, {orders, leads})  one buyer's whole record, built from
//                                         engine rows only. views/messages.js
//                                         uses this to put a buyer's history
//                                         beside the thread rather than
//                                         re-deriving it from its own join.
//   clientIndex({orders, leads})          every buyer, plus book-wide totals.

import {
  html,
  safe,
  join,
  missing,
  known,
  money,
  num,
  pct,
  days,
  dateShort,
  dateTimeShort,
  glyph,
  pill,
  panelHead,
  why,
  info,
  empty,
} from './layout.js';
import {
  MISSING,
  isMissing,
  pick,
  orders as engineOrders,
  leads as engineLeads,
} from '../lib/data.js';
import { normaliseBuyer } from '../lib/reconcile.js';

// ============================================================================
// 1. THE RECORD, engine rows, grouped. Nothing here reads MySQL.
// ============================================================================

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** An ISO date at the front of a string, or null. Parsed by hand: a DATE turned
 *  into a Date object is midnight in the server's zone and prints a day early
 *  west of it. */
function isoOf(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
}

/**
 * The date an order happened.
 *
 * 7 of 1,053 rows carry no order date and 61 carry no delivery date. Falling
 * back to the delivery date keeps those rows on the timeline instead of
 * silently dropping them out of first/last, and the record counts how often
 * the fallback was used, so a client whose whole history is inferred from
 * delivery dates can say so rather than looking exact.
 */
function orderDate(row) {
  return isoOf(row.order_date) || isoOf(row.delivered_date);
}

/** ISO date as a sortable integer, or null. */
function isoNum(value) {
  const iso = isoOf(value);
  return iso === null ? null : Number(iso.replace(/-/g, ''));
}

/** Whole days between two ISO dates, or null if either is unknown. */
function daysBetween(fromIso, toIso) {
  const a = isoOf(fromIso);
  const b = isoOf(toIso);
  if (!a || !b) return null;
  const ms = Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) -
    Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10));
  return Math.round(ms / 86_400_000);
}

/** The spelling to show a human: the first non-empty one the sources used. The
 *  normalised key is a join artefact and must never be what a CSR is shown. */
function firstSpelling(...rowSets) {
  for (const rows of rowSets) {
    for (const r of rows) {
      const raw = r.client ?? r.buyer;
      if (raw != null && String(raw).trim() !== '') return String(raw).trim();
    }
  }
  return null;
}

/** Order statuses that mean the order has not finished. Same mapping the
 *  orders view uses, and for the same reason: who is waiting is a different
 *  question from whether it is late. */
const OWES = { in_progress: 'us', revision: 'us', delivered: 'them' };
const LIVE_STATUSES = new Set(['in_progress', 'revision', 'delivered']);

function tally(map, key) {
  if (key == null || key === '') return;
  map.set(key, (map.get(key) || 0) + 1);
}

/**
 * Assemble one buyer's record from their rows.
 *
 * `available` says whether each SOURCE was readable. It is not the same as an
 * empty row set: a buyer with no leads and a readable leads file has never
 * inquired, which is a fact; a buyer with no leads and an unreadable file is
 * MISSING, which is not.
 */
function assemble(key, orderRows, leadRows, available, fallbackDisplay = null) {
  const display =
    firstSpelling(orderRows, leadRows) ||
    (fallbackDisplay && String(fallbackDisplay).trim() ? String(fallbackDisplay).trim() : null);

  let total = 0;
  let tips = 0;
  let priced = 0;
  let unpriced = 0;
  let reviews = 0;
  let ratingSum = 0;
  let ratingUntracked = 0;
  let first = null;
  let last = null;
  let datedFromDelivery = 0;
  let undated = 0;
  let live = 0;
  let cancelled = 0;
  let completed = 0;

  const types = new Map();
  const statuses = new Map();
  const csrs = new Map();
  const designers = new Map();
  const industries = new Map();

  for (const r of orderRows) {
    const amount = Number.isFinite(r.amount) ? r.amount : null;
    const tip = Number.isFinite(r.tip) ? r.tip : 0;
    // An order with no amount contributes nothing to the total and is counted
    // instead. A total that treats an unpriced order as $0 is a fabricated
    // number wearing a plausible face.
    if (amount === null) unpriced += 1;
    else {
      total += amount + tip;
      tips += tip;
      priced += 1;
    }

    if (Number.isFinite(r.rating)) {
      reviews += 1;
      ratingSum += r.rating;
    } else if (r.rating_tracked === false) {
      // The sheet did not track ratings for this row, so "no review" is not
      // something the book actually says.
      ratingUntracked += 1;
    }

    tally(types, r.order_type);
    tally(statuses, r.status);
    tally(csrs, r.csr);
    tally(designers, r.logo_designer);
    tally(designers, r.branding_designer);
    tally(industries, r.industry);

    if (LIVE_STATUSES.has(r.status)) live += 1;
    if (r.status === 'cancelled') cancelled += 1;
    if (r.status === 'completed') completed += 1;

    const d = orderDate(r);
    if (d === null) undated += 1;
    else {
      if (isoOf(r.order_date) === null) datedFromDelivery += 1;
      if (first === null || d < first) first = d;
      if (last === null || d > last) last = d;
    }
  }

  let firstLead = null;
  const leadStatuses = new Map();
  let quoted = null;
  let followups = 0;
  for (const r of leadRows) {
    const d = isoOf(r.date);
    if (d !== null && (firstLead === null || d < firstLead)) firstLead = d;
    tally(leadStatuses, r.status);
    if (quoted === null && Number.isFinite(r.quoted)) quoted = r.quoted;
    followups += [r.followup_1, r.followup_2, r.followup_3].filter((f) => f === true).length;
  }

  const reviewState = !available.orders
    ? 'unknown'
    : reviews > 0
      ? 'yes'
      : ratingUntracked > 0
        ? 'unknown'
        : 'no';

  return Object.freeze({
    // identity
    buyer: key,
    display: display === null ? MISSING : display,
    orders_available: available.orders,
    leads_available: available.leads,

    // the rows themselves, for a page that wants to list them
    orders: orderRows,
    leads: leadRows,

    // volume and money
    order_count: available.orders ? orderRows.length : MISSING,
    orders_priced: priced,
    orders_unpriced: unpriced,
    // No priced order among orders that exist means the total is unknown, not
    // zero. No orders at all means zero, which the book does say.
    lifetime_value: !available.orders
      ? MISSING
      : orderRows.length === 0
        ? 0
        : priced === 0
          ? MISSING
          : round2(total),
    value_is_floor: unpriced > 0 && priced > 0,
    tips: priced === 0 ? MISSING : round2(tips),
    repeat: available.orders ? orderRows.length > 1 : MISSING,

    // the timeline
    first_order: first === null ? MISSING : first,
    last_order: last === null ? MISSING : last,
    orders_undated: undated,
    orders_dated_from_delivery: datedFromDelivery,

    // review capture, a count, never a prompt (R6)
    review_count: reviews,
    review_state: reviewState,
    rating_mean: reviews === 0 ? MISSING : round2(ratingSum / reviews),

    // work state
    live_count: live,
    completed_count: completed,
    cancelled_count: cancelled,
    by_type: [...types.entries()].sort((a, b) => b[1] - a[1]),
    by_status: [...statuses.entries()].sort((a, b) => b[1] - a[1]),
    csrs: [...csrs.keys()],
    designers: [...designers.keys()],
    industries: [...industries.keys()],

    // the inquiry side
    lead_count: available.leads ? leadRows.length : MISSING,
    inquired: available.leads ? leadRows.length > 0 : MISSING,
    lead_statuses: [...leadStatuses.entries()],
    first_lead: firstLead === null ? MISSING : firstLead,
    quoted: quoted === null ? MISSING : quoted,
    followups_logged: available.leads ? followups : MISSING,
  });
}

/**
 * One buyer's record, built from engine rows only.
 *
 * Pass rows in to reuse a set you already hold (the client route hands over
 * pre-filtered arrays); omit them and the engine's files are read. A MISSING
 * source arrives as MISSING and comes back out as MISSING, it is never
 * flattened into an empty list.
 *
 * @param {string} buyer  any spelling of the Fiverr username
 * @param {{orders?: object[]|typeof MISSING, leads?: object[]|typeof MISSING}} [sources]
 */
export function clientRecord(buyer, sources = {}) {
  const orderRows = sources.orders === undefined ? engineOrders() : sources.orders;
  const leadRows = sources.leads === undefined ? engineLeads() : sources.leads;
  const key = normaliseBuyer(buyer);
  const available = { orders: !isMissing(orderRows), leads: !isMissing(leadRows) };
  const mine = available.orders ? orderRows.filter((r) => normaliseBuyer(r.client) === key) : [];
  const theirs = available.leads ? leadRows.filter((r) => normaliseBuyer(r.client) === key) : [];
  return assemble(key, mine, theirs, available, buyer);
}

/**
 * Every buyer in both logs, plus the book-wide totals the page leads with.
 *
 * Buyers who only ever inquired are included, they are in the index and out
 * of every "client" total, because a lead who never ordered is a real record
 * and not a client, and conflating the two is how a conversion rate goes
 * wrong.
 */
export function clientIndex(sources = {}) {
  const orderRows = sources.orders === undefined ? engineOrders() : sources.orders;
  const leadRows = sources.leads === undefined ? engineLeads() : sources.leads;
  const available = { orders: !isMissing(orderRows), leads: !isMissing(leadRows) };

  if (!available.orders) {
    return Object.freeze({
      available: false,
      missing_sources: ['orders'],
      records: [],
      byKey: new Map(),
      totals: MISSING,
      unjoinable: MISSING,
    });
  }

  const byOrder = new Map();
  const byLead = new Map();
  let unjoinableOrders = 0;
  let unjoinableLeads = 0;

  for (const r of orderRows) {
    const key = normaliseBuyer(r.client);
    if (key === '') {
      unjoinableOrders += 1;
      continue;
    }
    const bucket = byOrder.get(key);
    if (bucket) bucket.push(r);
    else byOrder.set(key, [r]);
  }
  if (available.leads) {
    for (const r of leadRows) {
      const key = normaliseBuyer(r.client);
      if (key === '') {
        unjoinableLeads += 1;
        continue;
      }
      const bucket = byLead.get(key);
      if (bucket) bucket.push(r);
      else byLead.set(key, [r]);
    }
  }

  const records = [];
  const byKey = new Map();
  for (const key of new Set([...byOrder.keys(), ...byLead.keys()])) {
    const rec = assemble(key, byOrder.get(key) ?? [], byLead.get(key) ?? [], available);
    records.push(rec);
    byKey.set(key, rec);
  }

  const clients = records.filter((r) => r.orders.length > 0);
  const repeats = clients.filter((r) => r.orders.length > 1);
  const singles = clients.filter((r) => r.orders.length === 1);

  const sum = (rows) => {
    let value = 0;
    let priced = 0;
    let unpriced = 0;
    let orders = 0;
    for (const r of rows) {
      orders += r.orders.length;
      priced += r.orders_priced;
      unpriced += r.orders_unpriced;
      if (known(r.lifetime_value)) value += Number(r.lifetime_value);
    }
    return { orders, value: priced === 0 ? MISSING : round2(value), priced, unpriced };
  };

  const all = sum(clients);
  const repeat = sum(repeats);
  const single = sum(singles);

  return Object.freeze({
    available: true,
    missing_sources: available.leads ? [] : ['leads'],
    records,
    byKey,
    totals: Object.freeze({
      buyers: clients.length,
      orders: all.orders,
      lifetime_value: all.value,
      orders_unpriced: all.unpriced,

      repeat_buyers: repeats.length,
      repeat_orders: repeat.orders,
      repeat_value: repeat.value,

      single_buyers: singles.length,
      single_value: single.value,

      orders_rated: clients.reduce((n, r) => n + r.review_count, 0),
      reviewed_buyers: clients.filter((r) => r.review_state === 'yes').length,
      review_state_unknown: clients.filter((r) => r.review_state === 'unknown').length,
      in_inquiry_log: available.leads ? clients.filter((r) => r.leads.length > 0).length : MISSING,
      lead_only_buyers: available.leads ? records.filter((r) => r.orders.length === 0).length : MISSING,
    }),
    unjoinable: Object.freeze({ orders: unjoinableOrders, leads: available.leads ? unjoinableLeads : MISSING }),
  });
}

// ============================================================================
// 2. THE TYPED SIDE, client_note and upsell, joined on the same key
// ============================================================================

/** Stage precedence. "Current" is the furthest a buyer has been taken, with
 *  `lost` below everything: a lost pitch is a state, not progress. */
const STAGE_RANK = { lost: 0, research: 1, pitch: 2, followup: 3, won: 4 };
const STAGE_TONE = { research: 'idle', pitch: 'info', followup: 'warn', won: 'ok', lost: 'idle' };

/**
 * Fold the typed rows onto the join key.
 *
 * `client_note.buyer` and `upsell.buyer` hold whatever spelling was typed, so
 * both sides are normalised before they meet the engine's rows. A store that
 * could not be read yields null. NOT an empty map, which would render as
 * "no notes" for all 912 buyers during an outage.
 */
function typedIndex(result, fold) {
  if (!result || result.ok !== true || !Array.isArray(result.rows)) return null;
  const map = new Map();
  for (const row of result.rows) {
    const key = normaliseBuyer(row.buyer);
    if (key === '') continue;
    fold(map, key, row);
  }
  return map;
}

function noteIndex(result) {
  return typedIndex(result, (map, key, row) => {
    const n = Number(row.notes) || 0;
    const at = row.last_note ? String(row.last_note) : null;
    const seen = map.get(key);
    if (seen) {
      seen.notes += n;
      if (at && (!seen.last || at > seen.last)) seen.last = at;
    } else map.set(key, { notes: n, last: at });
  });
}

function upsellIndex(result) {
  return typedIndex(result, (map, key, row) => {
    const bucket = map.get(key);
    if (bucket) bucket.push(row);
    else map.set(key, [row]);
  });
}

/** The furthest-along stage among a buyer's upsell rows. */
function currentStage(rows) {
  if (!rows || rows.length === 0) return null;
  return rows.reduce((best, row) =>
    (STAGE_RANK[row.stage] ?? -1) > (STAGE_RANK[best.stage] ?? -1) ? row : best
  );
}

// ============================================================================
// 3. LIST STATE, plain GET, so a filtered list is a link you can send
// ============================================================================

const PAGE_SIZE = 50;

const SCOPES = {
  '': { label: 'All clients', test: (r) => r.rec.orders.length > 0 },
  repeat: { label: 'Came back', test: (r) => r.rec.orders.length > 1 },
  reviewed: { label: 'Ever reviewed', test: (r) => r.rec.orders.length > 0 && r.rec.review_state === 'yes' },
  inquiry: { label: 'In the inquiry log', test: (r) => r.rec.orders.length > 0 && r.rec.leads.length > 0 },
  never: { label: 'Inquired, never ordered', test: (r) => r.rec.orders.length === 0 && r.rec.leads.length > 0 },
};

const SORTS = {
  value: { label: 'Lifetime value', dir: 'desc', of: (r) => (known(r.rec.lifetime_value) ? Number(r.rec.lifetime_value) : null) },
  orders: { label: 'Orders', dir: 'desc', of: (r) => r.rec.orders.length },
  last: { label: 'Last order', dir: 'desc', of: (r) => isoNum(r.rec.last_order) },
  first: { label: 'First order', dir: 'asc', of: (r) => isoNum(r.rec.first_order) },
  reviews: { label: 'Reviews', dir: 'desc', of: (r) => r.rec.review_count },
  buyer: { label: 'Buyer', dir: 'asc', of: () => null },
};

function readFilters(query = {}) {
  const s = (v, max = 80) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const sort = Object.hasOwn(SORTS, s(query.sort)) ? s(query.sort) : 'value';
  const dir = ['asc', 'desc'].includes(s(query.dir)) ? s(query.dir) : SORTS[sort].dir;
  const page = Math.min(9999, Math.max(1, Number.parseInt(s(query.page), 10) || 1));
  return {
    q: s(query.q),
    scope: Object.hasOwn(SCOPES, s(query.scope)) ? s(query.scope) : '',
    sort,
    dir,
    page,
  };
}

const DEFAULTS = { q: '', scope: '', sort: 'value', dir: 'desc', page: 1 };

function href(filters, overrides = {}) {
  const merged = { ...filters, ...overrides };
  const parts = Object.entries(merged)
    .filter(([k, v]) => v !== '' && v !== null && v !== undefined && String(v) !== String(DEFAULTS[k]))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  return parts.length ? `/clients?${parts.join('&')}` : '/clients';
}

function clientHref(name) {
  return `/clients/${encodeURIComponent(String(name ?? ''))}`;
}

function matches(row, needle) {
  if (!needle) return true;
  const hay = [
    row.rec.buyer,
    isMissing(row.rec.display) ? '' : row.rec.display,
    ...row.rec.orders.map((o) => o.project),
    ...row.rec.industries,
    row.stage ? row.stage.gap : '',
  ]
    .filter((v) => v != null && v !== '')
    .join(' ')
    .toLowerCase();
  return hay.includes(needle.toLowerCase());
}

function sortRows(rows, sort, dir) {
  const spec = SORTS[sort];
  const factor = dir === 'asc' ? 1 : -1;
  return rows.slice().sort((a, b) => {
    if (sort !== 'buyer') {
      const av = spec.of(a);
      const bv = spec.of(b);
      // Unknown sorts last in BOTH directions. A MISSING value is not a small
      // one, and letting it float to the top of an ascending sort would make
      // "we do not know" look like "nothing".
      if (av === null && bv !== null) return 1;
      if (bv === null && av !== null) return -1;
      if (av !== null && bv !== null && av !== bv) return (av - bv) * factor;
    }
    return a.rec.buyer.localeCompare(b.rec.buyer) * (sort === 'buyer' ? factor : 1);
  });
}

// ============================================================================
// 4. RENDER
// ============================================================================

const USD0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

/** Plain-text money for `title` / `kicker`, which are prose, not markup. */
function plainMoney(value) {
  return known(value) ? USD0.format(Number(value)) : 'MISSING';
}

export function render(ctx) {
  const param = ctx.params?.buyer;
  return param ? renderClient(ctx, String(param)) : renderList(ctx);
}

// ------------------------------------------------------------------ the list

function renderList(ctx) {
  const index = clientIndex();

  if (!index.available) {
    return {
      title: 'There is no client list to show',
      kicker: 'Clients',
      html: html`<div class="figure">
          <span class="cap">Buyers</span>
          <strong class="mid">${missing()}</strong>
          <p class="sub">
            <code class="mono">data/orders.jsonl</code> is absent or unreadable. A client record is a
            grouping of that file; without it there is no order count, no lifetime value and no first or
            last order, and this page will not draw a list of zeroes instead.
          </p>
        </div>
        <p class="note note--neg">
          Notes and upsell rows typed into the hub are unaffected, they are still stored and still
          attributed. They are just not shown here, because a client page with no orders on it would be a
          list of names pretending to be a book.
        </p>`,
    };
  }

  const t = index.totals;
  const filters = readFilters(ctx.query || {});
  const notes = noteIndex(ctx.data?.notes);
  const upsells = upsellIndex(ctx.data?.upsell);
  const stale = staleIndex(ctx.run);

  const rows = index.records.map((rec) => {
    const note = notes ? notes.get(rec.buyer) ?? { notes: 0, last: null } : null;
    const stage = upsells ? currentStage(upsells.get(rec.buyer)) : null;
    return {
      rec,
      note,
      notesKnown: notes !== null,
      stage,
      stageKnown: upsells !== null,
      stale: stale.get(rec.buyer) ?? null,
    };
  });

  const scoped = rows.filter((r) => SCOPES[filters.scope].test(r));
  const found = scoped.filter((r) => matches(r, filters.q));
  const sorted = sortRows(found, filters.sort, filters.dir);

  const pages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const page = Math.min(filters.page, pages);
  const start = (page - 1) * PAGE_SIZE;
  const shown = sorted.slice(start, start + PAGE_SIZE);

  const repeatShare = t.buyers > 0 ? t.repeat_buyers / t.buyers : MISSING;
  const moneyShare =
    known(t.repeat_value) && known(t.lifetime_value) && Number(t.lifetime_value) > 0
      ? Number(t.repeat_value) / Number(t.lifetime_value)
      : MISSING;

  return {
    title: `${t.repeat_buyers} of ${t.buyers} buyers came back`,
    kicker: 'Clients',
    ticker: [
      { label: 'Buyers', value: num(t.buyers) },
      { label: 'Came back', value: num(t.repeat_buyers), sub: 'of them' },
      { label: 'Repeat value', value: money(t.repeat_value) },
      { label: 'Lifetime value', value: money(t.lifetime_value), sub: t.orders_unpriced ? 'floor' : '' },
      { label: 'Ever reviewed', value: num(t.reviewed_buyers) },
      { label: 'In the inquiry log', value: num(t.in_inquiry_log) },
    ],
    html: join([
      listLede(t, repeatShare, moneyShare, index),
      listPanel({
        filters,
        rows,
        scoped,
        found,
        sorted,
        shown,
        page,
        pages,
        start,
        index,
        notesDown: notes === null,
        stageDown: upsells === null,
      }),
    ]),
  };
}

function listLede(t, repeatShare, moneyShare, index) {
  return html`<div class="lede">
      <div class="lede-main">
        <div class="figure">
          <span class="cap">Buyers who ordered more than once</span>
          <strong class="big">${num(t.repeat_buyers)}</strong>
          <p class="sub">
            of ${num(t.buyers)}, <b>${pct(repeatShare)}</b> of the names and <b>${pct(moneyShare)}</b> of
            the money. Their ${num(t.repeat_orders)} orders are worth ${money(t.repeat_value)} against a
            book of ${money(t.lifetime_value)}.
          </p>
        </div>
        ${why(
          'Why this is a floor, and why the repeat basket is smaller',
          html`<p>
              This is a <strong>census of the order book to its last row</strong>, not an estimate from a
              sample, so it carries no interval and gets no bar. It is still a floor in one direction that
              matters: a buyer who has ordered once may order again tomorrow, and the window simply closed
              before they did. The share can only go up as the book grows.
            </p>
            <p>
              The repeat basket is <strong>smaller per order</strong>, not larger:
              ${money(perOrder(t.repeat_value, t.repeat_orders))} against
              ${money(perOrder(t.single_value, t.single_buyers))} for a buyer who ordered once. Repeat
              business here is more orders, not bigger ones, a second logo, a stationery set, a social
              kit. Costing an upsell on the first-order average would overstate it by roughly a fifth.
            </p>
            <p>
              ${num(t.orders_unpriced)} orders in the book carry no amount at all. They are counted in the
              order totals and contribute nothing to the money, so every lifetime value on this page is a
              floor for the buyers who own one, those cells say so.
            </p>`
        )}
      </div>
      <div class="lede-side">
        <div class="figure">
          <span class="cap">Ordered once, then nothing</span>
          <strong class="mid">${num(t.single_buyers)}</strong>
          <p class="sub">
            buyers, worth ${money(t.single_value)}. ${num(t.in_inquiry_log)} of the
            ${num(t.buyers)} clients reached the inquiry log at all; the rest arrived as an order with no
            inquiry behind it.
          </p>
        </div>
        <p class="note note--neg">
          ${glyph('crit')} <b>This is not a review-request list.</b> ${num(t.buyers - t.reviewed_buyers)}
          clients have never left a rating, and most of them last ordered months ago. A review ask on a
          late or cold order is the most reliable way to turn a private three-star into a public one.
          There is no affordance for one anywhere on this page, and none may be added.
        </p>
        ${index.missing_sources.includes('leads')
          ? html`<p class="note note--warn">
              <code class="mono">data/leads.jsonl</code> could not be read, so every "in the inquiry log"
              answer on this page is MISSING rather than no.
            </p>`
          : ''}
      </div>
    </div>`;
}

/** Money per order / per buyer, or MISSING. Never a division by an unknown. */
function perOrder(value, count) {
  if (!known(value) || !known(count) || Number(count) === 0) return MISSING;
  return round2(Number(value) / Number(count));
}

function listPanel({ filters, rows, scoped, found, sorted, shown, page, pages, start, index, notesDown, stageDown }) {
  const counts = Object.fromEntries(
    Object.entries(SCOPES).map(([key, spec]) => [key, rows.filter(spec.test).length])
  );

  const sortLink = (key, label, extraClass = '') => {
    const active = filters.sort === key;
    const nextDir = active ? (filters.dir === 'asc' ? 'desc' : 'asc') : SORTS[key].dir;
    const arrow = active ? (filters.dir === 'asc' ? ' ↑' : ' ↓') : '';
    return html`<th scope="col"${safe(extraClass ? ` class="${extraClass}"` : '')}
        ${safe(active ? `aria-sort="${filters.dir === 'asc' ? 'ascending' : 'descending'}"` : '')}>
        <a href="${href(filters, { sort: key, dir: nextDir, page: 1 })}">${label}${safe(arrow)}</a>
      </th>`;
  };

  return html`<div class="panel">
      ${panelHead(
        `Every buyer, ${String(index.totals.buyers)} clients`,
        'live',
        'Live · orders.jsonl + leads.jsonl, grouped on the username'
      )}

      <div class="segment" role="group" aria-label="Which buyers to list">
        ${join(
          Object.entries(SCOPES).map(
            ([key, spec]) => html`<a href="${href(filters, { scope: key, page: 1 })}"
                ${safe(filters.scope === key ? 'aria-current="true"' : '')}>${spec.label} ${counts[key]}</a>`
          )
        )}
      </div>

      <form class="toolbar" method="get" action="/clients">
        <span class="search">
          <label class="sr-only" for="cq">Search buyer, project or industry</label>
          <input type="search" id="cq" name="q" value="${filters.q}" placeholder="Buyer, project or industry">
        </span>
        <span class="field">
          <label for="c-sort">Sort by</label>
          <select id="c-sort" name="sort">
            ${join(
              Object.entries(SORTS).map(
                ([key, spec]) => html`<option value="${key}" ${safe(filters.sort === key ? 'selected' : '')}>${spec.label}</option>`
              )
            )}
          </select>
        </span>
        <span class="field">
          <label for="c-dir">Order</label>
          <select id="c-dir" name="dir">
            <option value="desc" ${safe(filters.dir === 'desc' ? 'selected' : '')}>Highest / latest first</option>
            <option value="asc" ${safe(filters.dir === 'asc' ? 'selected' : '')}>Lowest / earliest first</option>
          </select>
        </span>
        ${filters.scope ? html`<input type="hidden" name="scope" value="${filters.scope}">` : ''}
        <button class="btn btn--sm" type="submit">Apply</button>
        ${filters.q || filters.scope || filters.sort !== 'value' || filters.dir !== 'desc'
          ? html`<a class="btn btn--ghost btn--sm" href="/clients">Clear</a>`
          : ''}
        <span class="count">${found.length} of ${scoped.length}</span>
      </form>

      ${shown.length === 0
        ? empty('No buyer matches this search. The book is not empty, this selection is.')
        : html`<div class="tablewrap tablewrap--capped">
              <table class="table table--wide">
                <thead>
                  <tr>
                    ${sortLink('buyer', 'Buyer')}
                    ${sortLink('orders', 'Orders', 'r')}
                    ${sortLink('value', 'Lifetime', 'r')}
                    ${sortLink('first', 'First')}
                    ${sortLink('last', 'Last')}
                    ${sortLink('reviews', 'Review')}
                    <th scope="col">Inquiry log</th>
                    <th scope="col">Upsell stage</th>
                  </tr>
                </thead>
                <tbody>${join(shown.map(listRow))}</tbody>
              </table>
              <p class="tablehint" aria-hidden="true">Scroll sideways for more columns →</p>
            </div>`}

      ${pages > 1
        ? html`<div class="btnrow" style="margin-top:14px">
              ${page > 1
                ? html`<a class="btn btn--ghost btn--sm" href="${href(filters, { page: page - 1 })}">← Previous ${String(PAGE_SIZE)}</a>`
                : ''}
              ${page < pages
                ? html`<a class="btn btn--ghost btn--sm" href="${href(filters, { page: page + 1 })}">Next ${String(PAGE_SIZE)} →</a>`
                : ''}
              <span class="caption">Showing ${String(start + 1)}–${String(start + shown.length)} of ${String(sorted.length)} · page ${String(page)} of ${String(pages)}</span>
            </div>`
        : ''}

      <p class="note note--neg">
        ${glyph('crit')} <b>The review column is a record, not a task.</b> It says what the order book
        holds. Nothing on this page turns "never reviewed" into an ask, because the buyers who never
        reviewed are overwhelmingly the ones who ordered longest ago, and a review request on a cold or
        late order is how a private three-star becomes a public one.
      </p>

      ${notesDown || stageDown
        ? html`<p class="note note--warn">
            The typed-records database is unreachable, so
            ${notesDown && stageDown ? 'the note counts and upsell stages are' : notesDown ? 'the note counts are' : 'the upsell stages are'}
            MISSING rather than none. Every engine figure in this table still stands, they come from disk.
          </p>`
        : ''}

      ${why(
        'How a client record is built, and what it cannot tell you',
        html`<p>
            One record per <strong>normalised Fiverr username</strong>: lowercased, non-alphanumerics
            stripped, so <span class="mono">Nativ_Shaibi</span>, <span class="mono">nativ shaibi</span> and
            <span class="mono">nativ_shaibi</span> are one buyer. The spelling shown is the first one the
            sources actually used, the normalised key is a join artefact and is never what a CSR is shown.
          </p>
          <p>
            ${num(index.unjoinable.orders)} order rows and ${num(index.unjoinable.leads)} inquiry rows
            reduce to nothing under that rule and are in no record at all. Where an inquiry was logged
            under a display name, "Adrian C", "Dami A.", no exact join can ever reach that buyer's
            orders, and this page does not guess: a fuzzy match would attach money to a buyer on the
            strength of a typo. The Inquiries page reports those cases as findings for a human.
          </p>
          <p>
            <strong>First and last are order dates</strong>, falling back to the delivery date where the
            book carries no order date. Lifetime value is amount plus tip, summed over the orders that
            carry a figure only. Neither is recomputed anywhere else in the hub, and neither is stored in
            the database, the numbers here exist in exactly one place, which is the file on disk.
          </p>
          <p>
            What it cannot tell you: whether a one-order buyer is finished with us, what a rating of
            nothing means (${num(index.totals.orders - index.totals.orders_rated)} of
            ${num(index.totals.orders)} orders carry no rating, which is not that many bad experiences),
            or anything at all about a buyer who reached us outside Fiverr.
          </p>`
      )}

      <div class="provenance-bar">
        <span>Counts, money and dates, engine output, grouped from <code class="mono">data/orders.jsonl</code> and <code class="mono">data/leads.jsonl</code>.</span>
        <span>Notes and upsell stage, typed here, joined on the same username.</span>
      </div>
    </div>`;
}

function listRow(row) {
  const r = row.rec;
  const parts = [];
  if (r.orders.length > 1) parts.push(`${r.orders.length} orders`);
  if (row.notesKnown && row.note.notes > 0) parts.push(`${row.note.notes} note${row.note.notes === 1 ? '' : 's'}`);
  if (r.orders.length === 0) parts.push('inquiry only, never ordered');

  // A late order is marked; a repeat buyer is NOT. The row states are a
  // warning vocabulary, putting one on the best clients in the book would
  // colour good news as a problem.
  return html`<tr${safe(row.stale ? ' class="row-late"' : '')}>
      <td>
        <a class="cell-name" href="${clientHref(isMissing(r.display) ? r.buyer : r.display)}">${r.display}</a>
        ${row.stale
          ? html`<span class="cell-sub">an order has been open ${days(row.stale.age_days)}</span>`
          : parts.length
            ? html`<span class="cell-sub">${parts.join(' · ')}</span>`
            : ''}
      </td>
      <td class="r cell-figure">${num(r.orders.length)}${
        r.live_count ? html`<span class="cell-sub">${num(r.live_count)} live</span>` : ''
      }</td>
      <td class="r cell-figure">${money(r.lifetime_value)}${
        r.orders_unpriced
          ? html`<span class="cell-sub">floor · ${num(r.orders_unpriced)} unpriced</span>`
          : ''
      }</td>
      <td>${dateShort(r.first_order, { year: true })}</td>
      <td>${dateShort(r.last_order, { year: true })}</td>
      <td>${reviewCell(r)}</td>
      <td>${inquiryCell(r)}</td>
      <td>${stageCell(row)}</td>
    </tr>`;
}

function reviewCell(r) {
  if (r.review_state === 'unknown') return missing();
  if (r.review_state === 'no') return html`<span class="caption">None on the book</span>`;
  return html`${pill('ok', 'Reviewed')}<span class="cell-sub">${num(r.review_count)} of ${num(r.orders.length)} rated · mean ${num(r.rating_mean, { dp: 1 })}</span>`;
}

function inquiryCell(r) {
  if (isMissing(r.inquired)) return missing();
  if (r.inquired !== true) return html`<span class="caption">No inquiry logged</span>`;
  const statuses = r.lead_statuses.map(([status]) => String(status).replace(/_/g, ' '));
  return html`${pill('info', 'In the log')}<span class="cell-sub">${statuses.join(', ')}</span>`;
}

function stageCell(row) {
  if (!row.stageKnown) return missing();
  if (!row.stage) return html`<span class="caption">Not on the board</span>`;
  const stage = String(row.stage.stage);
  return html`${pill(STAGE_TONE[stage] || 'idle', stage)}${
    row.stage.gap ? html`<span class="cell-sub">${row.stage.gap}</span>` : ''
  }`;
}

/** Every open order the engine marked stale, keyed by the join key. Read from
 *  the run as published, this page does not decide what late means. */
function staleIndex(run) {
  const rows = pick(run, 'recovery.open_orders.orders');
  const map = new Map();
  if (!Array.isArray(rows)) return map;
  for (const row of rows) {
    if (!row || row.stale !== true) continue;
    const key = normaliseBuyer(row.client);
    if (key && !map.has(key)) map.set(key, row);
  }
  return map;
}

// ------------------------------------------------------------- one client

function renderClient(ctx, param) {
  const rec = clientRecord(param, {
    orders: ctx.data?.orders,
    leads: ctx.data?.leads,
  });
  const label = isMissing(rec.display) ? param : rec.display;

  const notes = ctx.data?.notes;
  const upsellRows = ctx.data?.upsell;
  const recon = ctx.data?.recon;

  // The live queue comes from the run, not from the order book: the engine
  // decides what is open and what is late, and without the run neither is
  // known. `queueKnown` false means MISSING everywhere below, never "nothing
  // open", which during a failed deploy is a claim nobody can support.
  const open = pick(ctx.run, 'recovery.open_orders');
  const queueKnown = !isMissing(open) && Boolean(open) && Array.isArray(open.orders);
  const asOf = queueKnown ? open.as_of : ctx.engine.runDate;
  const staleAfter = queueKnown ? open.stale_after_days : MISSING;
  const openRows = queueKnown ? open.orders.filter((o) => normaliseBuyer(o.client) === rec.buyer) : [];
  const staleRows = openRows.filter((o) => o.stale === true);

  // Nothing in either engine file, under any spelling. That is a fact worth
  // stating plainly rather than drawing an empty history for, and it is only
  // a fact when BOTH files were readable.
  const unknownToEngine =
    rec.orders_available && rec.leads_available && rec.orders.length === 0 && rec.leads.length === 0;

  const sinceLast = daysBetween(rec.last_order, asOf);

  // With the order book unreadable there is no history to describe, and "0
  // orders" would be the page inventing one. Everything above the fold says
  // MISSING until the file comes back.
  const historyKnown = rec.orders_available;
  // Inquired and never ordered. Not a client, and the page must not describe
  // them as one, a $0 lifetime value here is a true zero, but "one order
  // only" would be a sentence about an order that does not exist.
  const leadOnly = historyKnown && rec.orders.length === 0 && rec.leads.length > 0;

  const body = join([
    clientLede(rec, { openRows, staleRows, asOf, staleAfter, sinceLast, unknownToEngine, queueKnown, leadOnly }),
    orderHistory(rec),
    inquiryHistory(rec),
    reconPanel(recon),
    upsellPanel(upsellRows),
    notesPanel(ctx, rec, label, notes, { staleRows, sinceLast, staleAfter }),
  ]);

  return {
    title: !historyKnown
      ? `${label}, the order book could not be read`
      : unknownToEngine
        ? `${label} is not in either log`
        : leadOnly
          ? `${label} inquired and never ordered`
          : `${label}, ${rec.orders.length} order${rec.orders.length === 1 ? '' : 's'}, ${plainMoney(rec.lifetime_value)}`,
    kicker: 'Client',
    ticker: [
      { label: 'Orders', value: historyKnown ? num(rec.orders.length) : missing() },
      { label: 'Lifetime', value: money(rec.lifetime_value), sub: rec.value_is_floor ? 'floor' : '' },
      { label: 'First order', value: dateShort(rec.first_order, { year: true }) },
      { label: 'Last order', value: dateShort(rec.last_order, { year: true }) },
      { label: 'Reviews', value: rec.review_state === 'unknown' ? missing() : num(rec.review_count) },
      { label: 'Open now', value: queueKnown ? num(openRows.length) : missing() },
    ],
    html: body,
  };
}

function clientLede(rec, { openRows, staleRows, asOf, staleAfter, sinceLast, unknownToEngine, queueKnown, leadOnly }) {
  if (!rec.orders_available) {
    return html`<div class="figure">
        <span class="cap">This client's history</span>
        <strong class="mid">${missing()}</strong>
        <p class="sub">
          <code class="mono">data/orders.jsonl</code> could not be read, so there is no order history to
          show and no lifetime value to state. Anything typed against this buyer is still below.
        </p>
      </div>`;
  }

  if (unknownToEngine) {
    return html`<div class="figure">
        <span class="cap">In the order book and the inquiry log</span>
        <strong class="mid">No rows</strong>
        <p class="sub">
          No order and no inquiry carries this username once it is normalised. Either the spelling differs
          from the one the sources use, or this buyer has never been logged under it. Notes typed against
          it are still kept, and still attributed, below.
        </p>
      </div>
      <p class="note note--warn">
        The hub joins on the exact normalised username and never guesses a near match, attaching money to
        a buyer on the strength of a typo is the failure it exists to prevent. Search the list for the
        spelling the sources use.
      </p>`;
  }

  if (leadOnly) {
    const claimsPlaced = rec.lead_statuses.some(([status]) => status === 'placed');
    return html`<div class="lede">
        <div class="lede-main">
          <div class="figure">
            <span class="cap">Orders in the book</span>
            <strong class="big">${num(0)}</strong>
            <p class="sub">
              This username is in the inquiry log ${num(rec.leads.length)} time${rec.leads.length === 1 ? '' : 's'}
, first on ${dateShort(rec.first_lead, { year: true })}, and nowhere in the order book.
              ${known(rec.quoted) ? html`They were quoted ${money(rec.quoted)}.` : 'No quote was recorded.'}
            </p>
          </div>
          ${claimsPlaced
            ? html`<p class="note note--neg">
                ${glyph('crit')} <b>The sheet says this inquiry was placed and the order book has no order
                behind it.</b> That is one of the referee's three findings. It is usually a username typed
                as a display name, or one character out, and the hub never guesses a near match, because
                attaching money to a buyer on the strength of a typo is the failure it exists to prevent.
                Resolve it, by hand, from the Inquiries page.
              </p>`
            : ''}
          ${why(
            'Why a lead with no order still gets a record',
            html`<p>
                Because the alternative is that the only place this person exists is a row in a sheet
                somebody may re-file. A record keyed on the username means the day they do order, the
                order lands against this history rather than starting a new one.
              </p>
              <p>
                Lifetime value is ${money(0)} here and that is a <strong>known zero</strong>, not MISSING:
                the order book was readable and it holds nothing for them.
              </p>`
          )}
        </div>
        <div class="lede-side">
          <div class="figure">
            <span class="cap">What the inquiry log says</span>
            <strong class="mid">${rec.lead_statuses.length
              ? join(rec.lead_statuses.map(([status]) => html`${String(status).replace(/_/g, ' ')}`), ', ')
              : missing()}</strong>
            <p class="sub">
              ${num(rec.followups_logged)} follow-up${rec.followups_logged === 1 ? '' : 's'} logged across
              those rows. A follow-up is logged exactly when the buyer did not say yes immediately, so a
              zero here is not a measure of neglect.
            </p>
          </div>
        </div>
      </div>`;
  }

  const openValue = openRows.reduce((s, o) => s + (Number.isFinite(o.amount) ? o.amount : 0), 0);
  const openUnpriced = openRows.filter((o) => !Number.isFinite(o.amount) || o.amount === 0).length;
  const owes = staleRows.map((o) => OWES[o.status] ?? null);
  const weOwe = owes.filter((x) => x === 'us').length;
  const theyOwe = owes.filter((x) => x === 'them').length;

  return html`<div class="lede">
      <div class="lede-main">
        <div class="figure">
          <span class="cap">Lifetime value</span>
          <strong class="big">${money(rec.lifetime_value)}</strong>
          <p class="sub">
            across <b>${num(rec.orders.length)}</b> orders between ${dateShort(rec.first_order, { year: true })}
            and ${dateShort(rec.last_order, { year: true })}${
              sinceLast === null ? '' : html`, ${days(sinceLast)} before the run date`
            }.
            ${rec.value_is_floor
              ? html`<b>${num(rec.orders_unpriced)} of them carry no amount</b>, so this is a floor.`
              : ''}
            ${rec.cancelled_count ? html`${num(rec.cancelled_count)} were cancelled.` : ''}
          </p>
        </div>
        ${why(
          'What is in this figure, and what is not',
          html`<p>
              Amount plus tip, summed over the orders that carry a figure. Orders with no amount are
              counted in the order total and contribute nothing to the money, which is why an unpriced
              order makes the value a floor rather than quietly rounding it down.
            </p>
            <p>
              ${rec.orders_dated_from_delivery
                ? html`${num(rec.orders_dated_from_delivery)} of these orders carry no order date, so their
                    place on the timeline is the <strong>delivery</strong> date. `
                : ''}
              ${rec.orders_undated
                ? html`${num(rec.orders_undated)} carry no date at all and sit outside first and last
                    entirely. `
                : ''}
              Ages are measured to <strong>${asOf || 'the run date'}</strong>, the engine's own as-of date,
              not to today, so every age here is a floor as well.
            </p>
            <p>
              By type: ${rec.by_type.length
                ? join(
                    rec.by_type.map(([type, n]) => html`${num(n)} ${String(type).replace(/_/g, ' ')}`),
                    ' · '
                  )
                : missing()}. Handled by ${rec.csrs.length ? rec.csrs.join(', ') : missing()}${
                rec.designers.length ? html`, designed by ${rec.designers.join(', ')}` : ''
              }.
            </p>`
        )}
      </div>
      <div class="lede-side">
        <div class="figure">
          <span class="cap">Open right now</span>
          <strong class="mid">${queueKnown ? num(openRows.length) : missing()}</strong>
          <p class="sub">
            ${!queueKnown
              ? html`The run does not carry the open-order block, so what is live for this buyer cannot be
                  stated. It is MISSING, not none.`
              : openRows.length
                ? html`orders holding ${money(openValue)}${
                    openUnpriced ? html` (${num(openUnpriced)} with no amount recorded)` : ''
                  }. ${staleRows.length
                    ? html`<b>${num(staleRows.length)} past ${days(staleAfter)}</b>.`
                    : 'None past the stale threshold.'}`
                : "Nothing of this buyer's is in the live queue."}
          </p>
        </div>
        ${staleRows.length
          ? html`<p class="note note--neg">
              ${glyph('crit')} <b>Sort before you send.</b>
              ${weOwe
                ? html`The ball is with <b>us</b> on ${num(weOwe)} of these, a "just checking in" note to a
                    buyer who has already paid tells them in writing that we have not started. `
                : ''}
              ${theyOwe
                ? html`${num(theyOwe)} are delivered and waiting on the buyer, which is the only bucket a
                    check-in belongs in. `
                : ''}
              No review request rides on any of them.
            </p>`
          : ''}
        <div class="figure">
          <span class="cap">Reviews left</span>
          <strong class="small">${rec.review_state === 'unknown' ? missing() : num(rec.review_count)}</strong>
          <p class="sub">
            ${rec.review_state === 'yes'
              ? html`of ${num(rec.orders.length)} orders, mean ${num(rec.rating_mean, { dp: 1 })} of 5.`
              : rec.review_state === 'no'
                ? html`The book carries no rating for this buyer. That is an absence of a record, not a bad
                    review, and it is <b>not</b> a reason to ask for one.`
                : 'The book does not track ratings for these rows.'}
          </p>
        </div>
      </div>
    </div>`;
}

function orderHistory(rec) {
  if (!rec.orders_available) return '';
  if (rec.orders.length === 0) {
    return html`<div class="panel">
        ${panelHead('Order history', 'live', 'Live · orders.jsonl')}
        ${empty('No order in the book carries this username. If they inquired, the inquiry is below.')}
      </div>`;
  }

  const rows = rec.orders
    .slice()
    .sort((a, b) => String(orderDate(b) ?? '').localeCompare(String(orderDate(a) ?? '')));

  return html`<div class="panel">
      ${panelHead(
        `Order history, ${String(rec.orders.length)} order${rec.orders.length === 1 ? '' : 's'}`,
        'live',
        'Live · orders.jsonl'
      )}
      <div class="tablewrap">
        <table class="table table--wide">
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Project</th>
              <th scope="col">Type</th>
              <th scope="col">Status</th>
              <th scope="col" class="r">Amount</th>
              <th scope="col" class="r">Tip</th>
              <th scope="col" class="r">Rating</th>
              <th scope="col">Designer</th>
              <th scope="col">CSR</th>
            </tr>
          </thead>
          <tbody>
            ${join(
              rows.map((o) => {
                const d = orderDate(o);
                const priced = Number.isFinite(o.amount);
                const people = [o.logo_designer, o.branding_designer].filter(Boolean);
                const rowClass = o.status === 'cancelled' ? 'row-late' : LIVE_STATUSES.has(o.status) ? 'row-attn' : '';
                return html`<tr${safe(rowClass ? ` class="${rowClass}"` : '')}>
                    <td>
                      ${d === null ? missing() : dateShort(d, { year: true })}
                      ${d !== null && isoOf(o.order_date) === null
                        ? html`<span class="cell-sub">delivery date, no order date in the book</span>`
                        : ''}
                    </td>
                    <td><span class="cell-name">${o.project ?? missing()}</span>${
                      o.industry ? html`<span class="cell-sub">${o.industry}</span>` : ''
                    }</td>
                    <td>${o.order_type == null ? missing() : String(o.order_type).replace(/_/g, ' ')}</td>
                    <td>${o.status == null ? missing() : String(o.status).replace(/_/g, ' ')}</td>
                    <td class="r cell-figure">${priced ? money(o.amount) : missing()}</td>
                    <td class="r cell-figure">${Number.isFinite(o.tip) && o.tip > 0 ? money(o.tip) : ''}</td>
                    <td class="r cell-figure">${Number.isFinite(o.rating) ? num(o.rating, { dp: 1 }) : missing()}</td>
                    <td>${people.length ? people.join(', ') : missing()}</td>
                    <td>${o.csr ?? missing()}</td>
                  </tr>`;
              })
            )}
          </tbody>
        </table>
        <p class="tablehint" aria-hidden="true">Scroll sideways for more columns →</p>
      </div>
      ${info(`Every row as the engine published it. A blank tip is a tip of nothing; a MISSING rating is no rating recorded, which is not a rating of zero and not a complaint.`)}
    </div>`;
}

function inquiryHistory(rec) {
  if (!rec.leads_available) {
    return html`<div class="panel">
        ${panelHead('In the inquiry log', 'missing', 'leads.jsonl absent')}
        <div class="figure">
          <span class="cap">Inquiries</span>
          <strong class="mid">${missing()}</strong>
          <p class="sub">
            <code class="mono">data/leads.jsonl</code> is not readable, so whether this buyer ever reached
            the inquiry log cannot be answered. It is MISSING, not no.
          </p>
        </div>
      </div>`;
  }

  if (rec.leads.length === 0) {
    return html`<div class="panel">
        ${panelHead('In the inquiry log', 'live', 'Live · leads.jsonl')}
        ${empty('No inquiry was ever logged for this username, the order arrived without one.')}
        ${info(`That is one of the referee's three findings, and it is common: most of the book never passed through the inquiry sheet at all. It is not evidence that a CSR missed anything.`)}
      </div>`;
  }

  const rows = rec.leads
    .slice()
    .sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));

  return html`<div class="panel">
      ${panelHead(
        `In the inquiry log, ${String(rec.leads.length)} row${rec.leads.length === 1 ? '' : 's'}`,
        'live',
        'Live · leads.jsonl'
      )}
      <div class="tablewrap">
        <table class="table">
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Status</th>
              <th scope="col" class="r">Quoted</th>
              <th scope="col">Country</th>
              <th scope="col">Shift</th>
              <th scope="col">CSR</th>
              <th scope="col" class="r">Follow-ups</th>
            </tr>
          </thead>
          <tbody>
            ${join(
              rows.map((l) => {
                const chased = [l.followup_1, l.followup_2, l.followup_3].filter((f) => f === true).length;
                return html`<tr>
                    <td>${dateShort(l.date, { year: true })}</td>
                    <td>${l.status == null ? missing() : String(l.status).replace(/_/g, ' ')}</td>
                    <td class="r cell-figure">${Number.isFinite(l.quoted) ? money(l.quoted) : missing()}</td>
                    <td>${l.country ?? missing()}</td>
                    <td>${l.shift ?? missing()}</td>
                    <td>${l.csr ?? missing()}</td>
                    <td class="r cell-figure">${num(chased)}</td>
                  </tr>`;
              })
            )}
          </tbody>
        </table>
      </div>
      ${why(
        'What the follow-up count does and does not mean',
        html`<p>
            A follow-up is logged exactly when the buyer did not say yes immediately, so a quoted lead with
            <em>no</em> logged follow-up converts far higher than one with three. That is selection, not
            neglect. The only honest number is the conversion <strong>within</strong> the followed-up
            group, which the engine publishes and the Today page states; never read a zero here as a
            missed job.
          </p>
          <p>
            Where the order book and this log disagree about the same buyer, the disagreement is a finding
            on the Inquiries page with a human's name against its resolution. This page reports both sides
            and edits neither.
          </p>`
      )}
    </div>`;
}

function reconPanel(recon) {
  if (!recon) return '';
  if (recon.ok !== true) {
    return html`<div class="panel">
        ${panelHead('Reconciliation', 'missing', 'typed records unreachable')}
        <p class="note note--warn">
          Whether this disagreement was already resolved is MISSING, the typed-records database did not
          answer. It is not "unresolved".
        </p>
      </div>`;
  }
  if (recon.rows.length === 0) return '';

  return html`<div class="panel">
      ${panelHead('What a human decided about this buyer', 'typed', 'Typed · reconciliation')}
      <div class="tablewrap">
        <table class="table table--narrow">
          <thead>
            <tr>
              <th scope="col">Finding</th>
              <th scope="col">First seen</th>
              <th scope="col" class="r">Amount</th>
              <th scope="col">State</th>
            </tr>
          </thead>
          <tbody>
            ${join(
              recon.rows.map(
                (row) => html`<tr>
                    <td><span class="cell-name">${String(row.finding).replace(/_/g, ' ')}</span>${
                      row.resolution ? html`<span class="cell-sub">${row.resolution}</span>` : ''
                    }</td>
                    <td>${dateShort(row.first_seen, { year: true })}</td>
                    <td class="r cell-figure">${row.amount == null ? missing() : money(row.amount)}</td>
                    <td>${Number(row.resolved) === 1
                      ? html`${pill('ok', 'Resolved')}<span class="cell-sub">${row.resolved_by || missing()} · ${dateTimeShort(row.resolved_at)}</span>`
                      : pill('warn', 'Open')}</td>
                  </tr>`
              )
            )}
          </tbody>
        </table>
      </div>
      ${info(`Resolve these from the Inquiries page. Nothing here edits the inquiry sheet or the order book, it records what somebody decided, and who decided it.`)}
    </div>`;
}

function upsellPanel(upsell) {
  if (!upsell) return '';
  if (upsell.ok !== true) {
    return html`<div class="panel">
        ${panelHead('Upsell', 'missing', 'typed records unreachable')}
        <p class="note note--warn">This buyer's upsell stage is MISSING, not "not on the board".</p>
      </div>`;
  }
  if (upsell.rows.length === 0) {
    return html`<div class="panel">
        ${panelHead('Upsell', 'typed', 'Typed · upsell')}
        ${empty('Nobody has put this buyer on the upsell board.')}
        ${info(`The board lives on the Money page; rows are keyed on this same username.`)}
      </div>`;
  }

  return html`<div class="panel">
      ${panelHead('Upsell', 'typed', 'Typed · upsell')}
      <div class="tablewrap">
        <table class="table table--narrow">
          <thead>
            <tr>
              <th scope="col">Gap</th>
              <th scope="col">Stage</th>
              <th scope="col">Owner</th>
              <th scope="col">Next step</th>
            </tr>
          </thead>
          <tbody>
            ${join(
              upsell.rows.map(
                (row) => html`<tr>
                    <td><span class="cell-name">${row.gap || missing()}</span>${
                      row.business ? html`<span class="cell-sub">${row.business}</span>` : ''
                    }</td>
                    <td>${pill(STAGE_TONE[row.stage] || 'idle', String(row.stage))}</td>
                    <td>${row.owner || missing()}</td>
                    <td>${row.next_step || missing()}</td>
                  </tr>`
              )
            )}
          </tbody>
        </table>
      </div>
      ${info(`Stage and next step are typed on the Money page. No money on this client page comes from this table, extra_earned is somebody's estimate of a future sale, and it is never added to a lifetime value the order book computed.`)}
    </div>`;
}

function notesPanel(ctx, rec, label, notes, { staleRows, sinceLast, staleAfter }) {
  const cold = known(sinceLast) && known(staleAfter) && Number(sinceLast) > Number(staleAfter);

  const list =
    !notes || notes.ok !== true
      ? html`<p class="note note--neg">
          ${glyph('crit')} <b>The notes could not be read.</b> This buyer's history of notes, logged sends
          and flags is MISSING, not empty. Nothing is lost; the database did not answer.
        </p>`
      : notes.rows.length === 0
        ? empty('Nothing has been written about this buyer yet.')
        : join(
            notes.rows.map(
              (n) => html`<div class="msg">
                  <p class="from is-us">
                    ${n.author || missing()} · ${dateTimeShort(n.at)} · ${String(n.kind)}
                    ${n.response_id ? html` · from the reply library` : ''}
                  </p>
                  <p>${n.body}</p>
                </div>`
            )
          );

  return html`<div class="panel">
      ${panelHead('Notes, sends and flags', 'typed', 'Typed · client_note')}
      ${list}

      ${staleRows.length || cold
        ? html`<p class="note note--neg">
            ${glyph('crit')} <b>Before writing anything to this buyer.</b>
            ${staleRows.length
              ? html`An order of theirs has been open past ${days(staleAfter)}. `
              : html`Their last order was ${days(sinceLast)} ago. `}
            No message from this page asks for a review, on a late or a cold order that is the surest way
            to turn a private three-star into a public one. If the ball is with us, deliver or send a dated
            commitment; a nudge is not a substitute for either.
          </p>`
        : ''}

      <form method="post" action="${clientHref(label)}/note" class="stack">
        <input type="hidden" name="_csrf" value="${ctx.csrfToken}">
        <input type="hidden" name="back" value="${ctx.path}">
        <div class="form-grid form-grid--two">
          <div class="field">
            <label for="note-kind">What is this</label>
            <select id="note-kind" name="kind">
              <option value="note">A note, something we learned</option>
              <option value="sent">A send, what this buyer was told</option>
              <option value="flag">A flag, this order is dead</option>
            </select>
            <p class="field-hint">
              A flag is the only thing in the hub that can call an order dead. It moves this buyer's open
              orders into the dead bucket on the Orders page, under your name.
            </p>
          </div>
        </div>
        <div class="field">
          <label for="note-body">The note <span class="req">*</span></label>
          <textarea id="note-body" name="body" required
                    placeholder="What was said, what they asked for, what we owe them"></textarea>
          <p class="field-hint">Stored against <span class="mono">${label}</span> with your name and the time.</p>
        </div>
        <div class="form-actions">
          <button class="btn" type="submit">Save against this client</button>
          <a class="btn btn--ghost" href="/clients">Back to every client</a>
        </div>
      </form>

      <div class="provenance-bar">
        <span>History above, engine output, read from disk.</span>
        <span>Notes, typed here, keyed on <code class="mono">${label}</code> exactly as spelled.</span>
      </div>
    </div>`;
}

export default { render, clientRecord, clientIndex };
