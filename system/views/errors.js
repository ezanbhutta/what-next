// views/errors.js, rows in the order sheet that need a human.
//
// WHY THIS PAGE IS SEPARATE FROM ORDERS
//
// The order workbook stays authoritative. That was a deliberate choice: the
// CSRs work orders there all day and moving that would be disruptive. The
// consequence is that this hub cannot correct order data, only report on it, 
// so the corrections need somewhere to live that is not mixed in with the
// work itself. Orders answers "what is live and what is late". This page
// answers "what does the sheet say that cannot be true".
//
// The distinction matters because the audiences differ. A CSR reads Orders
// during a shift. This page is Ezan's, once a week, with the sheet open in
// another tab.
//
// WHY IT MATTERS AT ALL
//
// Revenue used to count any row carrying a price, which put $4,350 of
// cancelled work and $5,885 of unaccepted work into the reported figure, 
// 9.6% above what had been earned. The arithmetic is fixed. The rows are
// still wrong in the sheet, and until this page existed nothing said so.
// Excluding a bad row keeps the total honest; naming it is what gets it
// fixed.

import { orders as engineOrders } from '../lib/data.js';
import { inspect, STUCK_AFTER_DAYS } from '../lib/quality.js';
import { html, join, esc, money, num, safe } from './layout.js';

const SEVERITY_GLYPH = {
  // Shape as well as colour, these three are the whole vocabulary of the
  // page, and hue alone fails on a printout and for a colourblind reader.
  high: { cls: 'glyph--crit', name: 'Fix first' },
  medium: { cls: 'glyph--warn', name: 'Worth a look' },
  low: { cls: 'glyph--info', name: 'Incomplete' },
};

function severityChip(severity) {
  const s = SEVERITY_GLYPH[severity] || SEVERITY_GLYPH.low;
  return html`<span class="pill ${safe(s.cls)}">${s.name}</span>`;
}

/** One row of the sheet, identified well enough to find it again. */
function rowLine(order) {
  return html`<tr>
    <td class="cell-name">${order.client || safe('<span class="missing">no username</span>')}</td>
    <td class="cell-sub">${order.order_date || safe('<span class="missing">no date</span>')}</td>
    <td class="cell-sub">${order.status || safe('<span class="missing">no status</span>')}</td>
    <td class="cell-figure">${order.amount ? money(order.amount) : safe('<span class="missing">None</span>')}</td>
  </tr>`;
}

function group(g) {
  // Ten rows, then a count. The point of the page is to make someone open the
  // sheet, not to reproduce it, and a 24-row table nobody scrolls is how a
  // list stops being read at all.
  const shown = g.rows.slice(0, 10);
  const hidden = g.count - shown.length;

  return html`<section class="block">
    <div class="panel-head">
      <h3>${g.label}</h3>
      ${severityChip(g.severity)}
    </div>

    <p class="figure">
      <span class="big">${num(g.count)}</span>
      <span class="cap">${g.count === 1 ? 'row' : 'rows'}${g.value ? safe(` · ${money(g.value)}`) : ''}</span>
    </p>

    <p class="caption">${g.why}</p>

    <div class="tablewrap">
      <table class="table table--zebra">
        <thead>
          <tr><th>Buyer</th><th>Ordered</th><th>Status</th><th class="cell-figure">Amount</th></tr>
        </thead>
        <tbody>${join(shown.map(rowLine))}</tbody>
      </table>
    </div>
    ${hidden > 0 ? html`<p class="tablehint">${num(hidden)} more not shown. Open the sheet and filter.</p>` : ''}

    <details>
      <summary>What to do</summary>
      <div class="details-body"><p>${g.fix}</p></div>
    </details>
  </section>`;
}

export function render(ctx) {
  const book = engineOrders();
  const report = inspect(book, { today: new Date() });

  if (!book.length) {
    return {
      title: 'The order book could not be read',
      html: html`<section class="block">
        <p class="caption">
          The engine's order file is absent or unreadable, so this page cannot tell a healthy
          sheet from an empty one. It is deliberately not reporting "no problems found".
        </p>
      </section>`,
    };
  }

  if (report.clean) {
    return {
      title: 'Nothing to fix',
      html: html`<section class="block">
        <p class="caption">
          Checked for missing status, missing amount, missing date, missing buyer, orders in
          flight over ${num(STUCK_AFTER_DAYS)} days, and deliveries never marked complete.
        </p>
      </section>`,
    };
  }

  const worst = report.groups[0];

  return {
    kicker: 'Order sheet',
    title: `${report.rowsFlagged} rows need a human`,
    // The headline states the finding, not the section name. The value is the
    // reason to care: these rows are moving numbers people act on.

    html: html`
      <p class="note">
        This hub reads the order sheet and never writes to it, so none of these can be
        corrected here, every fix happens in the sheet. They are listed worst first, by
        what they are worth rather than by how many there are.
      </p>

      ${join(report.groups.map(group))}

      <details>
        <summary>Why a row can fail more than one check</summary>
        <div class="details-body">
          <p>
            An order with no status and no date fails both, but it is still one row to go and
            look at. The headline counts distinct rows, ${num(report.rowsFlagged)}, while the
            groups below sum to more than that. Adding the group counts together would
            overstate the work, and nobody would notice it had.
          </p>
        </div>
      </details>`,
  };
}
