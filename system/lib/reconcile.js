// lib/reconcile.js — the referee. Where the inquiry sheet and the order book
// disagree, and by how much.
//
// WHY THIS FILE EXISTS
//
// Five systems each hold a third of the truth and they contradict each other.
// The hub does not add a sixth opinion — it joins the two authoritative logs
// on the one identifier that is stable in both, and reports the disagreements
// without editing either side. Nothing in here writes anywhere.
//
// The finding that started the build, reproduced by this module on every run:
// 25 buyers the CSRs marked "Not Placed" had in fact ordered — 27 orders worth
// $3,628 — and 5 marked won had no order behind them. Real conversion is 29.4%
// against the 22.9% the sheet reports. Nobody was wrong on purpose. The CSR who
// logs Monday's inquiry never sees Thursday's order land.
//
// THE JOIN KEY
//
// The Fiverr username. The engine writes it as `client` on both orders.jsonl
// and leads.jsonl; the hub calls it `buyer` everywhere, matching db/schema.sql.
// It is normalised by lowercasing and stripping every non-alphanumeric
// character, so `Nativ_Shaibi`, `nativ shaibi` and `nativ_shaibi` are one buyer.
// The display form kept alongside is the first spelling actually seen, because
// the normalised key is a join artefact and must never be what a CSR is shown.
//
// WHAT THIS MODULE REFUSES TO DO
//
//   - It does not decide who is right. A disagreement is reported, resolved by
//     a human, and tracked in the `reconciliation` table. That is the loop.
//   - It does not invent a value. An order with no amount contributes nothing
//     to a total and is counted in `orders_without_value` instead, so a total
//     is never quietly short by an unknown amount without saying so.
//   - It does not turn a small denominator into a point estimate. Every rate
//     carries a Wilson interval and a `too_few_to_call` flag; the renderer
//     shows the range whenever that flag is set.

import {
  MISSING,
  isMissing,
  orders as loadOrders,
  leads as loadLeads,
} from './data.js';

/** Minimum denominator before a rate may be drawn as a point rather than a range. */
export const MIN_SAMPLE = 30;

/** The three findings, matching the ENUM in db/schema.sql. Order is display order. */
export const FINDINGS = Object.freeze([
  'marked_lost_but_ordered',
  'marked_won_no_order',
  'order_without_inquiry',
]);

/** A lead in any of these states counts as claimed-won by the sheet. */
const PLACED_STATUSES = new Set(['placed']);

// --------------------------------------------------------------- the key

/**
 * Normalise a Fiverr username into a join key: lowercase, alphanumerics only.
 * Returns '' for anything that reduces to nothing — such a row cannot be
 * joined and is counted as unjoinable rather than lumped under a blank buyer.
 */
export function normaliseBuyer(value) {
  if (value == null) return '';
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

// ------------------------------------------------------------- small maths

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Wilson score interval for a binomial proportion. Used for every rate this
 * module reports, including the big ones: an interval on n=310 is narrow and
 * costs nothing, and it means no consumer ever has to ask whether a particular
 * rate happens to be point-safe.
 */
export function wilson(successes, trials, z = 1.96) {
  if (!Number.isFinite(trials) || trials <= 0) return [MISSING, MISSING];
  const p = successes / trials;
  const z2 = z * z;
  const denom = 1 + z2 / trials;
  const centre = p + z2 / (2 * trials);
  const spread = z * Math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials);
  return [
    Math.max(0, roundRate((centre - spread) / denom)),
    Math.min(1, roundRate((centre + spread) / denom)),
  ];
}

/**
 * Rates keep six decimals, not the two or three anyone displays.
 *
 * That is not false precision — it is the opposite. 91/310 rounded to 4dp is
 * 0.2935, and a renderer asking for one decimal of a percentage then gets
 * "29.3%" from a true 29.4%. Rounding twice moves a number. Round once, at the
 * point of display, and let this layer carry the digits.
 */
function roundRate(n) {
  return Math.round((n + Number.EPSILON) * 1e6) / 1e6;
}

function rate(successes, trials) {
  if (!Number.isFinite(trials) || trials <= 0) {
    return { n: successes, d: trials || 0, rate: MISSING, ci: [MISSING, MISSING], too_few_to_call: true };
  }
  return {
    n: successes,
    d: trials,
    rate: roundRate(successes / trials),
    ci: wilson(successes, trials),
    too_few_to_call: trials < MIN_SAMPLE,
  };
}

/** Earliest of a list of date strings, ignoring nulls. MISSING if none survive. */
function earliest(dates) {
  const clean = dates.filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d));
  if (clean.length === 0) return MISSING;
  return clean.reduce((a, b) => (a <= b ? a : b)).slice(0, 10);
}

// --------------------------------------------------------------- indexing

/**
 * Group rows by normalised buyer.
 * @returns {{byBuyer: Map<string, object[]>, unjoinable: object[]}}
 */
function groupByBuyer(rows) {
  const byBuyer = new Map();
  const unjoinable = [];
  for (const row of rows) {
    const key = normaliseBuyer(row.client ?? row.buyer);
    if (key === '') {
      unjoinable.push(row);
      continue;
    }
    const bucket = byBuyer.get(key);
    if (bucket) bucket.push(row);
    else byBuyer.set(key, [row]);
  }
  return { byBuyer, unjoinable };
}

/**
 * A Fiverr username is lowercase and unbroken: `thisguy07`, `nativ_shaibi`,
 * `dcleanglobe`. So a value that starts with a capital or contains a space —
 * "Adrian C", "Berkay", "Dami A." — is a display name someone typed, and NO
 * exact join can ever reach that buyer's orders. 28 inquiry rows are like this
 * and only 3 orders are, which is what you would expect: the order book is
 * exported, the inquiry log is hand-entered under time pressure.
 *
 * This is reported as a property of the row and NEVER used to guess a match.
 * Four of the five "marked won, no order" cases are exactly this, and a fifth
 * sits one character from a real username (`alanzfs` against the order book's
 * `alanzfss`). Fuzzy-matching those would attach money to a buyer on the
 * strength of a typo — inventing the very link this module exists to check.
 * The finding says "this cannot be joined, and here is why"; a human decides.
 */
const USERNAME_SHAPED = /^[a-z0-9][a-z0-9_-]*$/;

function loggedAsDisplayName(rows) {
  for (const r of rows) {
    const raw = r.client ?? r.buyer;
    if (raw == null) continue;
    if (!USERNAME_SHAPED.test(String(raw).trim())) return true;
  }
  return false;
}

/** The spelling to show a human: the first non-empty one the sources used. */
function displayName(rows) {
  for (const r of rows) {
    const raw = r.client ?? r.buyer;
    if (raw != null && String(raw).trim() !== '') return String(raw).trim();
  }
  return MISSING;
}

/**
 * Money and volume for one buyer's orders.
 *
 * `total_value` is order amount plus tip, summing only the orders that carry a
 * figure. Orders with no amount are counted separately — a total that silently
 * treats an unpriced order as $0 is a fabricated number wearing a plausible
 * face. When NO order carries a figure the total is MISSING, not 0.
 */
function valueOf(rows) {
  let total = 0;
  let priced = 0;
  let withoutValue = 0;
  for (const o of rows) {
    const amount = Number.isFinite(o.amount) ? o.amount : null;
    const tip = Number.isFinite(o.tip) ? o.tip : 0;
    if (amount === null) {
      withoutValue += 1;
      continue;
    }
    total += amount + tip;
    priced += 1;
  }
  return {
    order_count: rows.length,
    total_value: priced === 0 ? MISSING : round2(total),
    orders_priced: priced,
    orders_without_value: withoutValue,
  };
}

function sumValues(entries) {
  let total = 0;
  let orders = 0;
  let priced = 0;
  let withoutValue = 0;
  for (const e of entries) {
    orders += e.order_count;
    priced += e.orders_priced;
    withoutValue += e.orders_without_value;
    if (!isMissing(e.total_value)) total += e.total_value;
  }
  return {
    buyers: entries.length,
    orders,
    total_value: priced === 0 ? MISSING : round2(total),
    orders_priced: priced,
    orders_without_value: withoutValue,
  };
}

/** Findings sort by money at stake, then volume, then name — stable across runs. */
function byStake(a, b) {
  const av = isMissing(a.total_value) ? -1 : a.total_value;
  const bv = isMissing(b.total_value) ? -1 : b.total_value;
  if (bv !== av) return bv - av;
  if (b.order_count !== a.order_count) return b.order_count - a.order_count;
  return a.buyer < b.buyer ? -1 : a.buyer > b.buyer ? 1 : 0;
}

// -------------------------------------------------------------- the referee

/**
 * Join inquiries to orders and report every disagreement.
 *
 * @param {{orders?: object[], leads?: object[]}} [input] Inject rows to test
 *        or to reconcile a subset; omit to read the engine's committed files.
 * @returns {object} report — see `available`, `summary`, `conversion`,
 *          `findings`, `counts`, `unjoinable`.
 */
export function reconcile(input = {}) {
  const orderRows = input.orders ?? loadOrders();
  const leadRows = input.leads ?? loadLeads();

  // A missing source is not an empty source. Reconciling 1,053 orders against
  // "no inquiry file" would report 912 buyers who never inquired, which is a
  // confident falsehood. Refuse, and say which side is absent.
  if (isMissing(orderRows) || isMissing(leadRows)) {
    return Object.freeze({
      available: false,
      missing_sources: [
        isMissing(orderRows) ? 'orders' : null,
        isMissing(leadRows) ? 'leads' : null,
      ].filter(Boolean),
      summary: MISSING,
      conversion: MISSING,
      findings: Object.freeze({
        marked_lost_but_ordered: MISSING,
        marked_won_no_order: MISSING,
        order_without_inquiry: MISSING,
      }),
      counts: MISSING,
      unjoinable: MISSING,
    });
  }

  const o = groupByBuyer(orderRows);
  const l = groupByBuyer(leadRows);

  const markedLostButOrdered = [];
  const markedWonNoOrder = [];
  const orderWithoutInquiry = [];

  let markedPlaced = 0;
  let actuallyOrdered = 0;
  let placedAndOrdered = 0;

  for (const [buyer, leadsFor] of l.byBuyer) {
    const ordersFor = o.byBuyer.get(buyer) ?? [];
    const hasOrder = ordersFor.length > 0;
    // One buyer can appear in the inquiry log more than once. If ANY of those
    // rows says placed, the sheet is claiming the win — that is the claim this
    // module checks, and it keeps a re-inquiry from erasing an earlier win.
    const claimsPlaced = leadsFor.some((row) => PLACED_STATUSES.has(row.status));

    if (claimsPlaced) markedPlaced += 1;
    if (hasOrder) actuallyOrdered += 1;
    if (claimsPlaced && hasOrder) placedAndOrdered += 1;

    const firstLead = earliest(leadsFor.map((r) => r.date));
    const firstOrder = earliest(ordersFor.flatMap((r) => [r.order_date, r.delivered_date]));

    if (!claimsPlaced && hasOrder) {
      markedLostButOrdered.push({
        buyer,
        buyer_display: displayName(leadsFor.length ? leadsFor : ordersFor),
        finding: 'marked_lost_but_ordered',
        first_seen: earliest([
          isMissing(firstLead) ? null : firstLead,
          isMissing(firstOrder) ? null : firstOrder,
        ]),
        first_lead_date: firstLead,
        first_order_date: firstOrder,
        lead_status: leadsFor.map((r) => r.status ?? MISSING),
        lead_rows: leadsFor.length,
        logged_as_display_name: loggedAsDisplayName(leadsFor),
        quoted: leadsFor.map((r) => r.quoted).find((q) => Number.isFinite(q)) ?? MISSING,
        csr: leadsFor.map((r) => r.csr).find((c) => c) ?? MISSING,
        ...valueOf(ordersFor),
      });
    }

    if (claimsPlaced && !hasOrder) {
      markedWonNoOrder.push({
        buyer,
        buyer_display: displayName(leadsFor),
        finding: 'marked_won_no_order',
        first_seen: firstLead,
        first_lead_date: firstLead,
        first_order_date: MISSING,
        lead_status: leadsFor.map((r) => r.status ?? MISSING),
        lead_rows: leadsFor.length,
        logged_as_display_name: loggedAsDisplayName(leadsFor),
        quoted: leadsFor.map((r) => r.quoted).find((q) => Number.isFinite(q)) ?? MISSING,
        csr: leadsFor.map((r) => r.csr).find((c) => c) ?? MISSING,
        order_count: 0,
        // No order means no revenue to total — that is a known zero, not a hole.
        total_value: 0,
        orders_priced: 0,
        orders_without_value: 0,
      });
    }
  }

  for (const [buyer, ordersFor] of o.byBuyer) {
    if (l.byBuyer.has(buyer)) continue;
    const firstOrder = earliest(ordersFor.flatMap((r) => [r.order_date, r.delivered_date]));
    orderWithoutInquiry.push({
      buyer,
      buyer_display: displayName(ordersFor),
      finding: 'order_without_inquiry',
      first_seen: firstOrder,
      first_lead_date: MISSING,
      first_order_date: firstOrder,
      lead_status: [],
      lead_rows: 0,
      logged_as_display_name: loggedAsDisplayName(ordersFor),
      quoted: MISSING,
      csr: ordersFor.map((r) => r.csr).find((c) => c) ?? MISSING,
      ...valueOf(ordersFor),
    });
  }

  markedLostButOrdered.sort(byStake);
  markedWonNoOrder.sort(byStake);
  orderWithoutInquiry.sort(byStake);

  const leadBuyers = l.byBuyer.size;

  // Conversion, both ways.
  //
  // Denominator is distinct inquiring buyers, not inquiry rows: a buyer who
  // asked twice is one chance to convert, not two, and counting rows would
  // deflate both rates by the same invisible amount.
  //
  //   claimed  — what the sheet says: buyers with a lead marked placed.
  //   true     — what the order book proves: buyers who ever ordered.
  const claimed = rate(markedPlaced, leadBuyers);
  const truth = rate(actuallyOrdered, leadBuyers);
  const gap =
    isMissing(truth.rate) || isMissing(claimed.rate)
      ? MISSING
      : roundRate(truth.rate - claimed.rate);

  const lostSummary = sumValues(markedLostButOrdered);
  const wonSummary = sumValues(markedWonNoOrder);
  const noInquirySummary = sumValues(orderWithoutInquiry);

  return Object.freeze({
    available: true,
    missing_sources: [],

    summary: Object.freeze({
      leads: leadRows.length,
      orders: orderRows.length,
      lead_buyers: leadBuyers,
      order_buyers: o.byBuyer.size,

      marked_placed: markedPlaced,
      actually_ordered: actuallyOrdered,
      placed_and_ordered: placedAndOrdered,
      placed_no_order: markedPlaced - placedAndOrdered,
      not_placed_but_ordered: actuallyOrdered - placedAndOrdered,

      // The headline: money the sheet had already written off.
      not_placed_but_ordered_orders: lostSummary.orders,
      not_placed_but_ordered_value: lostSummary.total_value,
      not_placed_but_ordered_unpriced: lostSummary.orders_without_value,

      orders_without_inquiry_buyers: noInquirySummary.buyers,
      orders_without_inquiry_orders: noInquirySummary.orders,
      orders_without_inquiry_value: noInquirySummary.total_value,
    }),

    conversion: Object.freeze({
      denominator: leadBuyers,
      denominator_basis: 'distinct inquiring buyers',
      claimed_placed: markedPlaced,
      claimed_rate: claimed.rate,
      claimed_ci: claimed.ci,
      true_converted: actuallyOrdered,
      true_rate: truth.rate,
      true_ci: truth.ci,
      gap: gap,
      gap_points: isMissing(gap) ? MISSING : roundRate(gap * 100),
      too_few_to_call: truth.too_few_to_call,
      min_sample: MIN_SAMPLE,
    }),

    findings: Object.freeze({
      marked_lost_but_ordered: Object.freeze(markedLostButOrdered),
      marked_won_no_order: Object.freeze(markedWonNoOrder),
      order_without_inquiry: Object.freeze(orderWithoutInquiry),
    }),

    counts: Object.freeze({
      marked_lost_but_ordered: lostSummary,
      marked_won_no_order: wonSummary,
      order_without_inquiry: noInquirySummary,
    }),

    // Rows whose username reduced to nothing. They joined to neither side and
    // are excluded from every denominator above; if this is not zero, the
    // ingest changed shape and somebody needs to know.
    unjoinable: Object.freeze({
      orders: o.unjoinable.length,
      leads: l.unjoinable.length,
    }),
  });
}

/** One finding set by name, for a route that renders a single table. */
export function findings(name, input = {}) {
  if (!FINDINGS.includes(name)) throw new Error(`Unknown finding: ${name}`);
  return reconcile(input).findings[name];
}

export default { reconcile, findings, normaliseBuyer, wilson, FINDINGS, MIN_SAMPLE };
