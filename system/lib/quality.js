// lib/quality.js, what is wrong in the order sheet, and what it is worth.
//
// WHY THIS EXISTS
//
// The order workbook stays authoritative: CSRs work orders there all day and
// moving that would be disruptive. The consequence is that the hub cannot fix
// order data, it can only report on it. So this module finds rows a human
// has to go and correct at source, and puts a value on each so the worst one
// is obvious.
//
// It is not hypothetical. `economics()` used to count any row with a price as
// revenue, which put $4,350 of CANCELLED work and $5,885 of unaccepted work
// into the reported figure, 9.6% above what had been earned. That is fixed,
// but the underlying rows are still wrong in the sheet, and nothing was
// telling anyone. A number that silently excludes bad rows is only half the
// job; the other half is naming them so they get fixed.
//
// EVERY CHECK IS A QUESTION SOMEONE CAN ACT ON. A flag that cannot be
// resolved by editing one cell does not belong here, it is analysis, and it
// belongs in a view.

const ACTIVE = new Set(['revision', 'in_progress', 'delivered', 'new', 'rev_sent', 'on_hold']);

/** Days an order may sit in an active status before it is worth a look. */
export const STUCK_AFTER_DAYS = 30;

function asDate(value) {
  if (!value) return null;
  const d = new Date(String(value).slice(0, 10));
  return Number.isNaN(d.getTime()) ? null : d;
}

function daysBetween(from, to) {
  return Math.floor((to - from) / 86_400_000);
}

function amountOf(order) {
  const n = Number(order?.amount);
  return Number.isFinite(n) ? n : 0;
}

/**
 * The checks, in the order they should be read.
 *
 * `severity` is about consequence, not tidiness:
 *   high, the row is changing a number someone is acting on
 *   medium, work may be stuck, or money may have quietly gone
 *   low, the row is incomplete but nothing downstream is wrong yet
 *
 * `fix` is deliberately a sentence about the SHEET, not the hub. Nobody can
 * resolve any of these from inside this app, and pretending otherwise would
 * waste the reader's time.
 */
export const CHECKS = [
  {
    id: 'no_status',
    label: 'No status',
    severity: 'high',
    why:
      'Revenue counts only orders the buyer accepted. A row with no status cannot be ' +
      'shown to be accepted, so it is excluded, its value is missing from every total.',
    fix: 'Set the status in the order sheet: completed, cancelled, or whichever stage it is at.',
    test: (o) => !o.status,
  },
  {
    id: 'stuck',
    label: 'In flight over 30 days',
    severity: 'high',
    why:
      'The order is still open in a working status a month after it was placed. Either it ' +
      'is genuinely stuck and the buyer is waiting, or it finished and nobody closed it.',
    fix: 'Check the order on Fiverr. Complete it, or find out what it is waiting on.',
    test: (o, today) => {
      if (!ACTIVE.has(String(o.status || ''))) return false;
      const placed = asDate(o.order_date);
      return placed ? daysBetween(placed, today) > STUCK_AFTER_DAYS : false;
    },
  },
  {
    id: 'cancelled_with_value',
    label: 'Cancelled, but still carries a value',
    severity: 'medium',
    why:
      'These are not revenue and are no longer counted as such. They are listed because the ' +
      'total is worth knowing: it is what was agreed and then lost, and a rising number here ' +
      'is a different problem from a falling order count.',
    fix: 'Nothing to correct if the cancellation is real. Read the total, not the rows.',
    test: (o) => String(o.status) === 'cancelled' && amountOf(o) > 0,
  },
  {
    id: 'delivered_not_completed',
    label: 'Delivered but never completed',
    severity: 'medium',
    why:
      'On Fiverr a delivery is not money, the buyer has to accept it. A row sitting at ' +
      'delivered has either not been accepted yet, or was accepted and never updated here.',
    fix: 'Check whether the buyer accepted. If they did, set it to completed.',
    test: (o) => String(o.status) === 'delivered',
  },
  {
    id: 'no_order_date',
    label: 'No order date',
    severity: 'medium',
    why:
      'Without a date the order cannot be placed in any window, so it is invisible to every ' +
      'per-month, per-week and run-rate figure on this site.',
    fix: 'Add the date the order was placed.',
    test: (o) => !o.order_date,
  },
  {
    id: 'no_amount',
    label: 'No amount',
    severity: 'low',
    why:
      'The order counts toward volume but contributes nothing to revenue or AOV, which pulls ' +
      'the average down without anyone seeing why.',
    fix: 'Add what the buyer paid.',
    test: (o) => !amountOf(o),
  },
  {
    id: 'no_client',
    label: 'No buyer username',
    severity: 'low',
    why:
      'The Fiverr username is the only key joining an order to its inquiry, its history and ' +
      'its upsell state. A row without one cannot be connected to anything.',
    fix: 'Add the buyer’s Fiverr username.',
    test: (o) => !String(o.client || '').trim(),
  },
];

/**
 * Run every check over the order book.
 *
 * Returns groups in severity order, each with its rows, count and value, plus
 * a total of DISTINCT rows, one order failing three checks is one row to go
 * and look at, not three, and summing the group counts would overstate the
 * work by a factor nobody would notice.
 */
export function inspect(orders, { today = new Date() } = {}) {
  const list = Array.isArray(orders) ? orders : [];
  const groups = [];
  const flagged = new Set();

  for (const check of CHECKS) {
    const rows = [];
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      let hit = false;
      try {
        hit = check.test(o, today);
      } catch {
        hit = false; // a malformed row must not take the whole page down
      }
      if (!hit) continue;
      rows.push(o);
      flagged.add(o.client ? `${o.client}|${o.order_date}|${i}` : `#${i}`);
    }
    groups.push({
      ...check,
      rows,
      count: rows.length,
      value: rows.reduce((sum, o) => sum + amountOf(o), 0),
    });
  }

  const rank = { high: 0, medium: 1, low: 2 };
  groups.sort((a, b) => rank[a.severity] - rank[b.severity] || b.value - a.value);

  return {
    groups: groups.filter((g) => g.count > 0),
    clean: groups.every((g) => g.count === 0),
    rowsChecked: list.length,
    rowsFlagged: flagged.size,
    totalValue: groups.reduce((s, g) => s + g.value, 0),
    checkedAt: today,
  };
}
