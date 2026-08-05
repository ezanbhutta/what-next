// views/orders.js, what is live, what stage, what is late.
//
// THE ONE THING THIS PAGE EXISTS TO PREVENT
//
// "17 orders are past 60 days, chase them" is the instruction that turns a late
// order into a dispute. An open order is not one thing. Before any message goes
// out it has to be sorted into:
//
//     we owe work      the buyer is waiting on US. A "just checking in" note
//                      here tells someone who has already paid that we have
//                      not started, and hands them the timestamp to prove it.
//     they owe a reply the work is delivered and the buyer has gone quiet. This
//                      is the ONLY bucket a check-in belongs in.
//     dead             a human has looked and called it. Nothing in the order
//                      book says this, so it is never inferred here.
//
// So the decomposition is the headline of the stale bucket, its parts sum
// exactly to the engine's own stale total, and the warning is printed at the
// point of use, directly above the queue, where somebody is about to act, 
// not in a footnote nobody scrolls to.
//
// AND: no review request is attached to anything on this page. These are late
// or cold orders and a review ask on a late delivery is the most reliable way
// to turn a private three-star into a public one. There is no affordance for
// it here and none may be added.
//
// WHERE THE NUMBERS COME FROM
//
//   run.recovery.open_orders   the engine's own figures: open_count,
//                              open_value, bands, stale_count, stale_value,
//                              and a row per open order with its age. These
//                              are RENDERED, never recomputed.
//   orders.jsonl               the order book behind the queue, joined row for
//                              row on (client, order_date, project) so the
//                              queue can show what the engine's recovery block
//                              had to flatten, specifically that four open
//                              orders carry NO amount at all, which the
//                              recovery block reports as 0.0. A $0 that is
//                              really "unpriced" is exactly the fabricated
//                              number rule 2 is about, so the row says MISSING
//                              and the total says "floor".
//   client_note kind='flag'    typed, MySQL. The only source of "dead".

import {
  html,
  safe,
  join,
  missing,
  money,
  num,
  days,
  dateShort,
  glyph,
  pill,
  panelHead,
  why,
  empty,
} from './layout.js';
import { MISSING, isMissing, pick, orders as engineOrders } from '../lib/data.js';
import { normaliseBuyer } from '../lib/reconcile.js';

// ============================================================================
// STAGES, shape first, colour second (G1)
// ============================================================================

const STAGE = {
  in_progress: { glyph: 'ok', label: 'In progress', owes: 'us' },
  revision: { glyph: 'warn', label: 'In revision', owes: 'us' },
  delivered: { glyph: 'idle', label: 'Delivered', owes: 'them' },
  completed: { glyph: 'ok', label: 'Completed', owes: null },
  cancelled: { glyph: 'crit', label: 'Cancelled', owes: null },
};

function stagePill(status) {
  const spec = STAGE[status];
  if (!spec) return missing();
  return pill(spec.glyph, spec.label);
}

const BANDS = ['0-7', '8-30', '31-60', '60+'];

// ============================================================================
// FILTERS
// ============================================================================

function readFilters(query = {}) {
  const s = (v, max = 60) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  return {
    band: BANDS.includes(s(query.band)) ? s(query.band) : '',
    stage: Object.keys(STAGE).includes(s(query.stage)) ? s(query.stage) : '',
    owes: ['us', 'them', 'dead'].includes(s(query.owes)) ? s(query.owes) : '',
    csr: s(query.csr, 80),
    designer: s(query.designer, 80),
    q: s(query.q, 80),
  };
}

function href(filters, overrides = {}) {
  const merged = { ...filters, ...overrides };
  const parts = Object.entries(merged)
    .filter(([, v]) => v !== '' && v !== null && v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  return parts.length ? `/orders?${parts.join('&')}` : '/orders';
}

function anyFilter(f) {
  return Object.values(f).some((v) => v !== '');
}

function clientHref(name) {
  return `/clients/${encodeURIComponent(String(name ?? ''))}`;
}

// ============================================================================
// THE QUEUE, the engine's rows, joined back to the order book
// ============================================================================

/**
 * The identity of one order across the two files.
 *
 * JSON, not a delimiter: a project called "A | B" and a project called "A" for
 * a buyer called "B" must not collide, and no separator character is safe
 * against a free-text field somebody types into a sheet.
 */
function orderKey(row) {
  return JSON.stringify([row.client ?? null, row.order_date ?? null, row.project ?? null]);
}

/**
 * Build the working row set.
 *
 * Every figure comes from the engine's recovery block. The ONLY thing taken
 * from orders.jsonl is whether the order carries an amount at all, because the
 * recovery block writes 0.0 where the book holds null and a rendered "$0"
 * would be a price nobody quoted.
 */
function buildQueue(engineRows, bookRows, flagged) {
  const bookAvailable = !isMissing(bookRows);
  const book = new Map();
  if (bookAvailable) {
    for (const r of bookRows) {
      book.set(orderKey(r), r);
    }
  }

  return engineRows.map((o) => {
    const match = book.get(orderKey(o)) || null;
    // With the book in hand, "priced" is exactly what the book says. Without
    // it, a recovery amount of 0.0 is ambiguous, it is either a free order or
    // a null the recovery block flattened, and an ambiguous figure is MISSING.
    const priced = match ? Number.isFinite(match.amount) : Number.isFinite(o.amount) && o.amount !== 0;
    const isFlagged = flagged ? flagged.has(normaliseBuyer(o.client)) : false;
    const stage = STAGE[o.status] || null;

    return {
      ...o,
      book_available: bookAvailable,
      matched: match !== null,
      priced,
      // MISSING, not 0. The engine's total still counts it as zero and the
      // total says so out loud rather than being quietly adjusted here.
      shown_amount: priced ? o.amount : MISSING,
      flagged: isFlagged,
      owes: isFlagged ? 'dead' : stage ? stage.owes : null,
      order_type: match ? match.order_type : MISSING,
      delivered_date: match ? match.delivered_date : MISSING,
    };
  });
}

function matches(row, f) {
  if (f.band && row.band !== f.band) return false;
  if (f.stage && row.status !== f.stage) return false;
  if (f.owes && row.owes !== f.owes) return false;
  if (f.csr && (row.csr ?? '') !== (f.csr === '__none' ? '' : f.csr)) return false;
  if (f.designer && (row.designer ?? '') !== (f.designer === '__none' ? '' : f.designer)) return false;
  if (f.q) {
    const needle = f.q.toLowerCase();
    const hay = [row.client, row.project, row.designer, row.csr]
      .filter((v) => v != null)
      .join(' ')
      .toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}

function sumValue(rows) {
  let total = 0;
  let priced = 0;
  let unpriced = 0;
  for (const r of rows) {
    if (r.priced) {
      total += Number(r.amount) || 0;
      priced += 1;
    } else {
      unpriced += 1;
    }
  }
  return { count: rows.length, total, priced, unpriced };
}

// ============================================================================
// THE VIEW
// ============================================================================

export function render(ctx) {
  const run = ctx.run;
  const open = pick(run, 'recovery.open_orders');
  const bookRows = engineOrders();
  const flags = ctx.data?.flags ?? null;

  const flagged = flags?.ok
    ? new Set(flags.rows.map((r) => normaliseBuyer(r.buyer)).filter(Boolean))
    : null;

  if (isMissing(open) || !open || !Array.isArray(open.orders)) {
    return {
      title: 'The live queue cannot be read',
      kicker: 'Orders',
      html: html`<div class="figure">
          <span class="cap">recovery.open_orders</span>
          <strong class="mid">${missing()}</strong>
          <p class="sub">
            The engine's run does not carry the open-order block. That is a run that did not land or a
            deploy that did not carry <span class="mono">data/latest-run.json</span>, it is not an empty
            queue, and this page will not print one.
          </p>
        </div>
        <p class="note note--neg">
          Nothing else on this page is safe to derive from the order book alone: the age of an order is
          measured against the engine's own as-of date, not today's, and without the run there is no
          as-of date.
        </p>`,
    };
  }

  const queue = buildQueue(open.orders, bookRows, flagged);
  const stale = queue.filter((r) => r.stale === true);
  const filters = readFilters(ctx.query || {});
  const filtered = queue.filter((r) => matches(r, filters));

  const split = {
    us: stale.filter((r) => r.owes === 'us'),
    them: stale.filter((r) => r.owes === 'them'),
    dead: stale.filter((r) => r.owes === 'dead'),
    unknown: stale.filter((r) => r.owes === null),
  };

  const oldest = queue.reduce((a, r) => (Number.isFinite(r.age_days) && r.age_days > a ? r.age_days : a), 0);
  const unpricedOpen = queue.filter((r) => !r.priced).length;

  return {
    title: `${open.stale_count} of ${open.open_count} live orders are past ${open.stale_after_days} days`,
    kicker: 'Orders',
    ticker: [
      { label: 'Live orders', value: num(open.open_count) },
      { label: 'Open value', value: money(open.open_value) },
      { label: `Past ${open.stale_after_days} days`, value: num(open.stale_count) },
      { label: 'Sitting still', value: money(open.stale_value), sub: 'floor' },
      { label: 'Oldest', value: num(oldest), sub: 'days' },
      { label: 'Open, unpriced', value: num(unpricedOpen), sub: 'no amount' },
    ],
    html: join([
      lede(open, split, unpricedOpen),
      decomposition(open, split, flags),
      bandsPanel(open),
      queuePanel(open, queue, filtered, filters, flagged === null),
      bookPanel(bookRows, open),
    ]),
  };
}

// ---------------------------------------------------------------- 1. the lede

function lede(open, split, unpricedOpen) {
  const usValue = sumValue(split.us);
  return html`<div class="lede">
      <div class="lede-main">
        <div class="figure">
          <span class="cap">Open past ${String(open.stale_after_days)} days</span>
          <strong class="big">${num(open.stale_count)}</strong>
          <p class="sub">
            orders, holding <b>${money(open.stale_value)}</b>. The ball is with
            <b>us</b> on ${num(split.us.length)} of them
            ${split.them.length ? html`and with the buyer on ${num(split.them.length)}` : ''}.
          </p>
        </div>
        ${why(
          'Why the count comes before the money',
          html`<p>
              ${money(open.stale_value)} is the engine's figure and it counts an order with no recorded
              amount as zero. ${unpricedOpen
                ? html`<strong>${String(unpricedOpen)} of the ${String(open.open_count)} open orders carry no
                    amount in the order book at all</strong>, so the money at rest is a floor, not a total.`
                : ''}
              The count is the number that is exactly right, which is why it is the big one.
            </p>
            <p>
              Ages are measured to <strong>${String(open.as_of)}</strong>, the engine's run date, not to
              today. Every age on this page is therefore a floor as well: an order is at least as old as
              the number shown, and older by however many days have passed since the run.
            </p>`
        )}
      </div>
      <div class="lede-side">
        <div class="figure">
          <span class="cap">Waiting on us</span>
          <strong class="mid">${usValue.priced === 0 && usValue.count ? missing() : money(usValue.total)}</strong>
          <p class="sub">
            across ${num(usValue.count)} order${safe(usValue.count === 1 ? '' : 's')} where the buyer has
            already paid and the work has not landed.
            ${usValue.unpriced ? html` ${num(usValue.unpriced)} of them carry no amount.` : ''}
          </p>
        </div>
        <p class="note note--neg">
          ${glyph('crit')} <b>Do not send a check-in to this bucket.</b> A "just checking in" note to a
          buyer who is waiting on us tells them, in writing and with a timestamp, that we have not
          started. That is how a late order becomes a dispute. Deliver, or send a dated commitment, 
          never a nudge.
        </p>
      </div>
    </div>`;
}

// ------------------------------------------- 2. the decomposition, and the sum

function decomposition(open, split, flags) {
  const rows = [
    {
      key: 'us',
      label: 'We owe work',
      sub: 'in progress or in revision, the buyer is waiting on us',
      glyph: 'crit',
      rows: split.us,
    },
    {
      key: 'them',
      label: 'They owe a reply',
      sub: 'delivered, and the buyer has gone quiet',
      glyph: 'warn',
      rows: split.them,
    },
    {
      key: 'dead',
      label: 'Dead',
      sub: 'a human looked and called it, flagged in the hub',
      glyph: 'idle',
      rows: split.dead,
    },
  ];
  if (split.unknown.length) {
    rows.push({
      key: '',
      label: 'Stage not recorded',
      sub: 'the order book carries no status for these',
      glyph: 'idle',
      rows: split.unknown,
    });
  }

  const totals = sumValue(split.us.concat(split.them, split.dead, split.unknown));
  const countMatches = totals.count === open.stale_count;
  const valueMatches = Math.abs(totals.total - Number(open.stale_value)) < 0.005;
  const dbDown = !flags || flags.ok !== true;

  return html`<div class="panel">
      ${panelHead(
        `The ${String(open.stale_count)} stale orders are three different problems`,
        dbDown ? 'missing' : 'live',
        dbDown ? 'Dead bucket MISSING · flags unreadable' : 'Live · recovery.open_orders + typed flags'
      )}

      <div class="tablewrap">
        <table class="table">
          <thead>
            <tr>
              <th scope="col">Bucket</th>
              <th scope="col" class="r">Orders</th>
              <th scope="col" class="r">Value</th>
              <th scope="col">What it means</th>
            </tr>
          </thead>
          <tbody>
            ${join(
              rows.map((b) => {
                const v = sumValue(b.rows);
                // With the flag store down there is no dead bucket to report, 
                // and 0 would be a claim. An empty count here would say "nobody
                // has called anything dead", which is precisely the fact the hub
                // has just lost access to.
                const unknown = b.key === 'dead' && dbDown;
                return html`<tr>
                    <td>
                      ${b.key
                        ? html`<a class="cell-name" href="${href({}, { owes: b.key })}">${glyph(b.glyph)} ${b.label}</a>`
                        : html`<span class="cell-name">${glyph(b.glyph)} ${b.label}</span>`}
                    </td>
                    <td class="r cell-figure">${unknown ? missing() : num(v.count)}</td>
                    <td class="r cell-figure">${
                      unknown ? missing() : v.priced === 0 && v.count ? missing() : money(v.total)
                    }${
                      !unknown && v.unpriced ? html`<span class="cell-sub">${num(v.unpriced)} unpriced</span>` : ''
                    }</td>
                    <td>${unknown ? 'The flag store is unreachable, so this cannot be counted.' : b.sub}</td>
                  </tr>`;
              })
            )}
          </tbody>
          <tfoot>
            <tr>
              <td>Stale total</td>
              <td class="r cell-figure">${num(totals.count)}</td>
              <td class="r cell-figure">${money(totals.total)}</td>
              <td>
                ${glyph(countMatches && valueMatches ? 'ok' : 'crit')}
                ${countMatches && valueMatches
                  ? dbDown
                    ? html`The buckets above sum to the engine's ${num(open.stale_count)} /
                        ${money(open.stale_value)}, but with the dead bucket ${missing()}, some of them
                        may in fact be dead.`
                    : html`Sums exactly to the engine's ${num(open.stale_count)} / ${money(open.stale_value)}.`
                  : html`<b class="neg">Does not match the engine's ${num(open.stale_count)} /
                      ${money(open.stale_value)}.</b> Trust the engine's figure and check the join.`}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <p class="note note--neg">
        ${glyph('crit')} <b>Sort before you send.</b> The only bucket a check-in belongs in is
        <b>they owe a reply</b>. Sending one to a buyer who is waiting on us is how a late order becomes
        a dispute, and none of these orders gets a review request attached to it, ever: a review ask on
        a late delivery is the surest way to turn a private three-star into a public one.
      </p>

      ${dbDown
        ? html`<p class="note note--warn">
            The <b>dead</b> bucket is ${missing()}, not zero. It is the one call the order book cannot
            make, so it comes from human flags in the hub, and the flag store is unreachable. Any of the
            rows above may in fact be dead.
          </p>`
        : ''}

      ${why(
        'How each order lands in a bucket',
        html`<ul>
            <li>
              <strong>We owe work</strong>, the order book says <span class="mono">in_progress</span> or
              <span class="mono">revision</span>. The buyer has paid and is waiting.
            </li>
            <li>
              <strong>They owe a reply</strong>, <span class="mono">delivered</span>, no acceptance and
              no response. This is the only bucket where a polite check-in is the right message.
            </li>
            <li>
              <strong>Dead</strong>, nothing in the order book means dead, so nothing here infers it. An
              order is dead when somebody flagged the buyer in this hub, by name and with a timestamp.
              Flag one from its client page.
            </li>
          </ul>
          <p>
            The three buckets are exclusive and the row above proves they sum to the engine's own stale
            total. If that check ever fails, the split is wrong and the engine's figure is the one to
            trust.
          </p>`
      )}
    </div>`;
}

// ------------------------------------------------------------- 3. the age bands

function bandsPanel(open) {
  const bands = open.bands || {};
  let count = 0;
  let value = 0;
  for (const key of BANDS) {
    count += Number(bands[key]?.count) || 0;
    value += Number(bands[key]?.value) || 0;
  }
  const ok = count === open.open_count && Math.abs(value - Number(open.open_value)) < 0.005;

  return html`<div class="panel">
      ${panelHead('How long each open order has been open', 'live', 'Live · recovery.open_orders.bands')}
      <div class="tablewrap">
        <table class="table table--narrow">
          <thead>
            <tr>
              <th scope="col">Age band</th>
              <th scope="col" class="r">Orders</th>
              <th scope="col" class="r">Value</th>
              <th scope="col"></th>
            </tr>
          </thead>
          <tbody>
            ${join(
              BANDS.map((key) => {
                const b = bands[key];
                const late = key === '60+';
                return html`<tr class="${safe(late ? 'row-late' : '')}">
                    <td>
                      <a class="cell-name" href="${href({}, { band: key })}">${key} days</a>
                    </td>
                    <td class="r cell-figure">${b ? num(b.count) : missing()}</td>
                    <td class="r cell-figure">${b ? money(b.value) : missing()}</td>
                    <td>${late ? pill('crit', 'Stale') : ''}</td>
                  </tr>`;
              })
            )}
          </tbody>
          <tfoot>
            <tr>
              <td>All open</td>
              <td class="r cell-figure">${num(open.open_count)}</td>
              <td class="r cell-figure">${money(open.open_value)}</td>
              <td>${glyph(ok ? 'ok' : 'crit')} ${ok ? 'Bands sum to the total.' : 'Bands do not sum to the total.'}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p class="caption">
        Measured as of ${dateShort(open.as_of)}, the engine's run date, not today. Stale is anything past
        ${num(open.stale_after_days)} days.
      </p>
    </div>`;
}

// -------------------------------------------------------------- 4. the queue

function queuePanel(open, queue, filtered, filters, flagsDown) {
  const csrs = [...new Set(queue.map((r) => r.csr).filter(Boolean))].sort();
  const designers = [...new Set(queue.map((r) => r.designer).filter(Boolean))].sort();

  return html`<div class="panel">
      ${panelHead(
        `The live queue, ${String(open.open_count)} orders`,
        'live',
        `Live · recovery.open_orders · as of ${String(open.as_of)}`
      )}

      <div class="segment" role="group" aria-label="Filter the queue">
        <a href="${href(filters, { owes: '', band: '', stage: '' })}"
           ${safe(!filters.owes && !filters.band && !filters.stage ? 'aria-current="true"' : '')}>Everything</a>
        <a href="${href(filters, { owes: 'us', band: '', stage: '' })}"
           ${safe(filters.owes === 'us' ? 'aria-current="true"' : '')}>${glyph('crit')} We owe work</a>
        <a href="${href(filters, { owes: 'them', band: '', stage: '' })}"
           ${safe(filters.owes === 'them' ? 'aria-current="true"' : '')}>${glyph('warn')} They owe a reply</a>
        <a href="${href(filters, { owes: 'dead', band: '', stage: '' })}"
           ${safe(filters.owes === 'dead' ? 'aria-current="true"' : '')}>${glyph('idle')} Dead</a>
        <a href="${href(filters, { band: '60+', owes: '' })}"
           ${safe(filters.band === '60+' ? 'aria-current="true"' : '')}>Past 60 days</a>
      </div>

      <form class="toolbar" method="get" action="/orders">
        <span class="search">
          <label class="sr-only" for="oq">Search buyer or project</label>
          <input type="search" id="oq" name="q" value="${filters.q}" placeholder="Buyer or project">
        </span>
        <span class="field">
          <label for="f-stage">Stage</label>
          <select id="f-stage" name="stage">
            <option value="">Any</option>
            ${join(
              ['in_progress', 'revision', 'delivered'].map(
                (s) => html`<option value="${s}" ${safe(filters.stage === s ? 'selected' : '')}>${STAGE[s].label}</option>`
              )
            )}
          </select>
        </span>
        <span class="field">
          <label for="f-designer">Designer</label>
          <select id="f-designer" name="designer">
            <option value="">Any</option>
            ${join(
              designers.map(
                (d) => html`<option value="${d}" ${safe(filters.designer === d ? 'selected' : '')}>${d}</option>`
              )
            )}
            <option value="__none" ${safe(filters.designer === '__none' ? 'selected' : '')}>Not assigned</option>
          </select>
        </span>
        <span class="field">
          <label for="f-ocsr">CSR</label>
          <select id="f-ocsr" name="csr">
            <option value="">Any</option>
            ${join(
              csrs.map((c) => html`<option value="${c}" ${safe(filters.csr === c ? 'selected' : '')}>${c}</option>`)
            )}
            <option value="__none" ${safe(filters.csr === '__none' ? 'selected' : '')}>Not assigned</option>
          </select>
        </span>
        ${filters.band ? html`<input type="hidden" name="band" value="${filters.band}">` : ''}
        ${filters.owes ? html`<input type="hidden" name="owes" value="${filters.owes}">` : ''}
        <button class="btn btn--sm" type="submit">Apply</button>
        ${anyFilter(filters) ? html`<a class="btn btn--ghost btn--sm" href="/orders">Clear</a>` : ''}
        <span class="count">${filtered.length} of ${queue.length}</span>
      </form>

      ${filtered.length === 0
        ? empty('No open order matches these filters. The queue is not empty, this selection is.')
        : html`<div class="tablewrap tablewrap--capped">
              <table class="table table--wide">
                <thead>
                  <tr>
                    <th scope="col">Buyer</th>
                    <th scope="col">Project</th>
                    <th scope="col">Stage</th>
                    <th scope="col" class="r">Age</th>
                    <th scope="col" class="r">Amount</th>
                    <th scope="col">Designer</th>
                    <th scope="col">CSR</th>
                    <th scope="col">Who is waiting</th>
                  </tr>
                </thead>
                <tbody>${join(filtered.map(queueRow))}</tbody>
              </table>
              <p class="tablehint" aria-hidden="true">Scroll sideways for more columns →</p>
            </div>`}

      <p class="caption">
        Ordered as the engine published them: oldest first. Age is in days as of ${dateShort(open.as_of)}.
        Filters live in the URL, so a filtered queue is a link you can send to whoever owns it.
        ${flagsDown
          ? html`<b>The dead filter is empty because the flag store is unreachable</b>, not because
              nothing is dead, and every row's "who is waiting" is therefore the order book's answer
              only.`
          : ''}
      </p>
    </div>`;
}

function queueRow(row) {
  const rowClass = row.stale === true ? 'row-late' : row.owes === 'us' ? 'row-attn' : '';
  const waiting =
    row.owes === 'us'
      ? pill('crit', 'Us')
      : row.owes === 'them'
        ? pill('warn', 'Them')
        : row.owes === 'dead'
          ? pill('idle', 'Dead, flagged')
          : missing();

  return html`<tr class="${safe(rowClass)}">
      <td>
        <a class="cell-name" href="${clientHref(row.client)}">${row.client}</a>
        ${row.stale === true ? html`<span class="cell-sub">past 60 days · ordered ${dateShort(row.order_date)}</span>` : ''}
      </td>
      <td>${row.project ?? missing()}</td>
      <td>${stagePill(row.status)}</td>
      <td class="r cell-figure">${days(row.age_days)}</td>
      <td class="r cell-figure">${money(row.shown_amount)}${
        row.priced
          ? ''
          : html`<span class="cell-sub">${
              !row.book_available
                ? 'book unreadable, cannot confirm'
                : row.matched
                  ? 'no amount in the book'
                  : 'no matching row in the book'
            }</span>`
      }</td>
      <td>${row.designer ?? missing()}</td>
      <td>${row.csr ?? missing()}</td>
      <td>${waiting}</td>
    </tr>`;
}

// ------------------------------------------------- 5. the book behind the queue

function bookPanel(bookRows, open) {
  if (isMissing(bookRows)) {
    return html`<div class="panel">
        ${panelHead('The book behind the queue', 'missing', 'orders.jsonl absent')}
        <div class="figure">
          <span class="cap">Order book</span>
          <strong class="mid">${missing()}</strong>
          <p class="sub">
            <span class="mono">data/orders.jsonl</span> is not readable, so nothing can be said about the
            orders that are not in the live queue. The queue above still stands: it comes from the run.
          </p>
        </div>
      </div>`;
  }

  const byStatus = new Map();
  let noStatus = 0;
  for (const r of bookRows) {
    if (r.status == null) {
      noStatus += 1;
      continue;
    }
    byStatus.set(r.status, (byStatus.get(r.status) || 0) + 1);
  }
  const ordered = [...byStatus.entries()].sort((a, b) => b[1] - a[1]);

  return html`<div class="panel">
      ${panelHead('The book behind the queue', 'live', `Live · orders.jsonl · ${bookRows.length.toLocaleString('en-US')} rows`)}
      <dl class="stats">
        ${join(
          ordered.map(
            ([status, n]) => html`<div class="stat">
                <dt>${STAGE[status]?.label || status}</dt>
                <dd>${num(n)}</dd>
              </div>`
          )
        )}
        <div class="stat">
          <dt>Status not recorded</dt>
          <dd>${num(noStatus)}</dd>
        </div>
      </dl>
      <p class="caption">
        Counts of rows in the order book, grouped, not an engine figure. The engine's own revenue and
        rating figures are scoped to its window and live on the Money page; nothing here restates them.
        ${noStatus
          ? html`${num(noStatus)} rows carry no status at all: they are neither in the queue nor counted as
              finished, and they are shown here rather than quietly dropped into "completed".`
          : ''}
      </p>
      <p class="caption">
        The live queue above is ${num(open.open_count)} of these ${num(bookRows.length)}.
      </p>
    </div>`;
}

export default { render };
