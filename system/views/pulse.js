// views/pulse.js, the order book as performance: who delivered what, and what
// the buyer said about it.
//
// WHY THIS IS A SEPARATE PAGE FROM THE THREE THAT ALREADY READ THIS SHEET
//
//   `/orders` answers "what is live and what is late": a queue, ageing bands,
//   the work in front of us. `/money` answers "what came in and what is stuck".
//   `/clients` answers "what is the history with this buyer".
//
//   None of them answers the question this one is for, which is the question
//   CSR Pulse exists to answer: how did the delivered work go, and who did it.
//   Completions, ratings, and the split by person. Nothing here is a second
//   computation of a figure another page already states; it is a different cut
//   of the same rows.
//
// THE TWO MEASUREMENT TRAPS IN THIS PARTICULAR DATA
//
//   1. THE DENOMINATORS ARE TINY AND THE TEMPTATION IS A LEADERBOARD.
//      On current data one person has 52 completions in the window and eight
//      people have between one and six. A table sorted by count, with a
//      percentage beside each, reads as a ranking of ability and is mostly a
//      ranking of how many shifts somebody worked. So every rate here goes
//      through `rate()`/`meter()`, which draw a bar only when the figure can
//      carry one and a 95% range on a hatched track when it cannot, and the
//      count it came from is printed beside it always.
//
//      Note that BOTH causes of a range appear in this data and the caption
//      says which. Nine of the fifteen people have fewer than five deliveries,
//      which is not enough to state a rate. The person with fifty-two has
//      enough and her interval is still about twenty-five points wide, which
//      is a different sentence and the same conclusion: show the range.
//
//   2. A MISSING RATING IS A REAL ANSWER, NOT A GAP IN THE RECORDS.
//      Every completed row in this book carries `rating_tracked`, which is the
//      ingest saying the source had a rating column to read. So a blank rating
//      on a tracked row means the buyer left no public review, which is a fact
//      about the order. That is what makes a capture rate computable at all,
//      and it is why an UNtracked row is excluded from the denominator rather
//      than counted as a miss: those two look identical on screen and only one
//      of them is somebody's fault.
//
// HOUSE RULE 6 IS LOAD-BEARING ON THIS PAGE, AND IT IS THE REASON THERE ARE NO
// ACTIONS ON IT.
//
//   This page names the orders that came back under five stars, because Ezan
//   cannot act on what he cannot see. It offers nothing to do about them, and
//   that is deliberate: the only things anyone can do about a public rating on
//   Fiverr are against its terms, and a button here would be an invitation to
//   do one of them. It is a page for reading.
//
// READ ONLY. Nothing on this page writes, to the sheet or to anything else.

import { isMissing } from '../lib/data.js';

import {
  html,
  join,
  safe,
  missing,
  money,
  num,
  rate,
  meter,
  glyph,
  pill,
  panelHead,
  banner,
  why,
  info,
  empty,
  dateShort,
  statCard,
  statGrid,
  MIN_SAMPLE,
} from './layout.js';

// ============================================================================
// 1. THE WINDOW
// ============================================================================
//
// `since` is Ezan's own instruction, and it is the default rather than the
// only option: use June onward, discard what came before. CSR Pulse itself
// shows everything from 1 May, so the two will not agree on a total unless the
// window is on screen. It is in the kicker and in every panel head.

export const WINDOWS = [
  { key: '7', days: 7, label: 'Last 7 days' },
  { key: '30', days: 30, label: 'Last 30 days' },
  { key: '90', days: 90, label: 'Last 90 days' },
  { key: 'june', days: null, from: '2026-06-01', label: 'Since June' },
];

const DEFAULT_WINDOW = '30';

// ============================================================================
// 2. READING THE BOOK
// ============================================================================

const iso = (value) => {
  const s = String(value ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
};

const numberOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/** Sum a column over rows, and say how many rows carried it. A blank amount is
 *  an order whose price nobody recorded, which is not an order worth nothing. */
function sumOf(rows, key) {
  let total = 0;
  let n = 0;
  for (const r of rows) {
    const v = numberOrNull(r[key]);
    if (v === null) continue;
    total += v;
    n += 1;
  }
  return { total: n ? total : null, n, blanks: rows.length - n };
}

/** Mean, or null. Never 0 for an empty set: "no orders" has no average. */
const meanOf = (sum, n) => (sum === null || !n ? null : sum / n);

/** The person a row belongs to. An unnamed CSR is its own bucket rather than
 *  being dropped, because dropping it makes the column totals disagree with
 *  the panel above and nothing says why. */
const personOf = (r) => (String(r.csr ?? '').trim() || null);

// ============================================================================
// 3. THE PAGE
// ============================================================================

export function render(ctx) {
  const d = ctx.data || {};
  const book = d.book;
  const windowKey = WINDOWS.some((w) => w.key === String(d.window)) ? String(d.window) : DEFAULT_WINDOW;
  const windowDef = WINDOWS.find((w) => w.key === windowKey);
  const today = iso(d.today) || null;

  // ---- the book is unreadable ----------------------------------------------
  if (isMissing(book) || !Array.isArray(book)) {
    return {
      title: 'The order book cannot be read',
      kicker: 'Pulse',
      ticker: [],
      html: html`${banner(
        'crit',
        'data/orders.jsonl is not readable.',
        html`Every figure on this page is a cut of that file, so there is nothing to show. The order sheet
          itself is untouched: this hub only ever reads it, and the engine writes the file on each run.`
      )}
      ${empty('No orders could be loaded.')}`,
    };
  }

  const from =
    windowDef.from ||
    (today && windowDef.days
      ? new Date(Date.parse(`${today}T00:00:00Z`) - (windowDef.days - 1) * 86400000)
          .toISOString()
          .slice(0, 10)
      : null);

  const spanLabel = from
    ? `${dateShort(from)} to ${today ? dateShort(today, { year: true }) : 'today'}`
    : 'all time';

  // COMPLETIONS ARE DATED BY DELIVERY, ORDERS TAKEN BY ORDER DATE.
  //
  // They are two different events and bucketing both by one column is how a
  // completion rate ends up describing orders that had not been delivered yet
  // when the window closed. Each is filtered on its own date.
  const inWindow = (value) => {
    const day = iso(value);
    return day !== null && (!from || day >= from) && (!today || day <= today);
  };

  const taken = book.filter((r) => inWindow(r.order_date));
  const completed = book.filter((r) => r.status === 'completed' && inWindow(r.delivered_date));
  const cancelled = book.filter((r) => r.status === 'cancelled' && inWindow(r.order_date));

  const takenValue = sumOf(taken, 'amount');
  const completedValue = sumOf(completed, 'amount');
  const aov = meanOf(completedValue.total, completedValue.n);

  // ---- reviews --------------------------------------------------------------
  //
  // The denominator is completions the source TRACKS a rating for. An untracked
  // row is not a buyer who stayed silent, it is a row this hub cannot see the
  // answer for, and the two render identically if they share a denominator.
  const trackable = completed.filter((r) => r.rating_tracked === true);
  const rated = trackable.filter((r) => numberOrNull(r.rating) !== null);
  const untracked = completed.length - trackable.length;
  const capture = rate(rated.length, trackable.length);
  const ratingMean = meanOf(
    rated.reduce((a, r) => a + Number(r.rating), 0),
    rated.length
  );

  const stars = new Map();
  for (const r of rated) {
    const v = Number(r.rating);
    const bucket = v >= 4.75 ? '5' : v >= 4 ? '4 to 4.7' : v >= 3 ? '3 to 3.9' : 'under 3';
    stars.set(bucket, (stars.get(bucket) || 0) + 1);
  }
  const STAR_ORDER = ['5', '4 to 4.7', '3 to 3.9', 'under 3'];
  const belowFive = rated.filter((r) => Number(r.rating) < 4.75);

  // ---- window bar -----------------------------------------------------------

  const windowBar = html`<div class="toolbar">
      <div class="segment">
        ${join(
          WINDOWS.map(
            (w) => html`<a href="/pulse?window=${safe(w.key)}"
                ${safe(w.key === windowKey ? 'aria-current="true"' : '')}>${w.label}</a>`
          )
        )}
      </div>
      <span class="count">${spanLabel}</span>
    </div>`;

  // ---- completions ----------------------------------------------------------

  const completionsPanel = html`<section class="panel">
      ${panelHead(
        html`Delivered, ${num(completed.length)}`,
        'live',
        `orders.jsonl · ${spanLabel}`,
        'Dated by the day the work was delivered, not the day the order came in. The two are different events and one window cannot hold both honestly.'
      )}
      ${!completed.length
        ? empty(`Nothing was delivered between ${spanLabel}.`)
        : html`${statGrid([
            statCard('Delivered', num(completed.length), { sub: 'orders marked completed' }),
            statCard('Value delivered', completedValue.total === null ? missing() : money(completedValue.total), {
              sub: completedValue.blanks
                ? `${completedValue.blanks} of ${completed.length} carried no price`
                : `All ${completed.length} carried a price`,
              tone: completedValue.blanks ? 'warn' : '',
            }),
            statCard('AOV delivered', aov === null ? missing() : money(aov), {
              sub: `Mean across the ${completedValue.n} that carried a price`,
            }),
            statCard('Taken', num(taken.length), { sub: 'orders placed in the window' }),
            statCard('Value taken', takenValue.total === null ? missing() : money(takenValue.total), {
              sub: takenValue.blanks ? `${takenValue.blanks} carried no price` : 'every order priced',
            }),
            statCard('Cancelled', num(cancelled.length), {
              sub: 'by order date',
              tone: cancelled.length ? 'warn' : '',
            }),
          ])}`}
      ${why(
        'Why delivered and taken are not compared as a ratio here',
        html`<p>
            An order taken in the last week of the window has usually not been delivered inside it, and one
            delivered in the first week was usually taken before it started. Dividing the two counts gives a
            figure that moves with the window's length rather than with anything the team did.
            <em>/money</em> holds the revenue picture, which is the question that ratio is usually reached
            for.
          </p>`
      )}
    </section>`;

  // ---- reviews --------------------------------------------------------------

  const reviewsPanel = html`<section class="panel">
      ${panelHead(
        html`Reviews left, ${num(rated.length)} of ${num(trackable.length)} delivered`,
        'live',
        `orders.jsonl · ${spanLabel}`,
        'A blank rating on a row the source tracks means the buyer left no public review. That is an answer, and it is what makes this a rate rather than a guess.'
      )}
      ${!trackable.length
        ? empty('No delivered order in this window has a rating column behind it.')
        : html`${statGrid([
              statCard('Review capture', capture.ok ? capture.html : missing(), {
                sub: capture.ok
                  ? capture.small
                    ? `Wilson 95% · n=${capture.n} delivered · too few to state as one number`
                    : `n=${capture.n} delivered`
                  : 'Needs delivered orders with a rating column',
              }),
              statCard('Mean rating', ratingMean === null ? missing() : num(ratingMean, { dp: 2 }), {
                sub: rated.length
                  ? `Across the ${rated.length} that left one`
                  : 'Nobody left a rating in this window',
              }),
              statCard('Under five stars', num(belowFive.length), {
                sub: belowFive.length ? 'named below' : 'none in this window',
                tone: belowFive.length ? 'warn' : '',
              }),
              statCard('No rating column', num(untracked), {
                sub: untracked ? 'excluded from the rate above' : 'every delivered order was trackable',
              }),
            ])}
            ${stars.size
              ? html`<div class="tablewrap">
                  <table class="table">
                    <thead><tr><th>Rating</th><th class="r">Orders</th><th>Share of the ${num(rated.length)}</th></tr></thead>
                    <tbody>
                      ${join(
                        STAR_ORDER.filter((b) => stars.has(b)).map((bucket) => {
                          const n = stars.get(bucket);
                          return html`<tr>
                            <td><span class="cell-name">${bucket}</span></td>
                            <td class="r cell-figure">${num(n)}</td>
                            <td>${meter({ value: n, total: rated.length, tone: bucket === '5' ? 'ok' : 'warn' })}</td>
                          </tr>`;
                        })
                      )}
                    </tbody>
                  </table>
                </div>`
              : ''}
            ${belowFive.length
              ? html`<div class="tablewrap" style="margin-top:18px">
                  <table class="table table--wide">
                    <thead><tr><th>Delivered</th><th>Buyer</th><th>Project</th><th>CSR</th><th class="r">Rating</th><th class="r">Value</th></tr></thead>
                    <tbody>
                      ${join(
                        [...belowFive]
                          .sort((a, b) => Number(a.rating) - Number(b.rating))
                          .map(
                            (r) => html`<tr class="row-attn">
                              <td>${iso(r.delivered_date) ? dateShort(r.delivered_date) : missing()}</td>
                              <td><span class="cell-name">${r.client || missing()}</span></td>
                              <td>${r.project || missing()}</td>
                              <td>${personOf(r) || missing()}</td>
                              <td class="r cell-figure">${num(Number(r.rating), { dp: 1 })}</td>
                              <td class="r cell-figure">${numberOrNull(r.amount) === null ? missing() : money(r.amount)}</td>
                            </tr>`
                          )
                      )}
                    </tbody>
                  </table>
                </div>`
              : ''}`}
      ${why(
        'What this page will not offer to do about a low rating',
        html`<p>
            Nothing. There is no button here, and there is not going to be one. Every route from a public
            rating back to a better public rating runs through asking the buyer to change or withdraw it,
            and that is against Fiverr's terms. The account is worth more than any order on this table.
          </p>
          <p>
            The orders are named because a pattern in them is worth knowing about, and because a 2-star
            that nobody looked at is a 2-star nobody learned anything from. What follows is a conversation
            about the work, not about the review.
          </p>`
      )}
    </section>`;

  // ---- per person -----------------------------------------------------------
  //
  // Deliveries are attributed to the CSR on the row, which is who handled the
  // order, not who drew it. The designer split is its own panel underneath for
  // the same reason: one row carries both, and merging them into one table
  // invites reading a designer's name as the reason for a rating.

  const people = new Map();
  const bump = (name, field, by = 1) => {
    const key = name ?? '(nobody named)';
    if (!people.has(key)) {
      people.set(key, { name: key, taken: 0, delivered: 0, value: 0, priced: 0, rated: 0, trackable: 0, ratingSum: 0 });
    }
    people.get(key)[field] += by;
  };
  for (const r of taken) bump(personOf(r), 'taken');
  for (const r of completed) {
    const name = personOf(r);
    bump(name, 'delivered');
    const amount = numberOrNull(r.amount);
    if (amount !== null) {
      bump(name, 'value', amount);
      bump(name, 'priced');
    }
    if (r.rating_tracked === true) {
      bump(name, 'trackable');
      const rating = numberOrNull(r.rating);
      if (rating !== null) {
        bump(name, 'rated');
        bump(name, 'ratingSum', rating);
      }
    }
  }
  const peopleRows = [...people.values()].sort((a, b) => b.delivered - a.delivered || b.value - a.value);

  const peoplePanel = html`<section class="panel">
      ${panelHead(
        html`Per CSR, ${num(peopleRows.length)}`,
        'live',
        `orders.jsonl · ${spanLabel}`,
        'Every rate carries the count it came from. Below the house threshold there is no percentage and no bar, because a rate over six orders is not a measurement of anybody.'
      )}
      ${!peopleRows.length
        ? empty('Nobody is named on an order in this window.')
        : html`<div class="tablewrap tablewrap--capped">
              <table class="table table--wide">
                <thead>
                  <tr>
                    <th>CSR</th><th class="r">Taken</th><th class="r">Delivered</th>
                    <th class="r">Value</th><th class="r">AOV</th>
                    <th class="r">Reviews left</th><th>Capture</th><th class="r">Mean rating</th>
                  </tr>
                </thead>
                <tbody>
                  ${join(
                    peopleRows.map((p) => {
                      const personCapture = rate(p.rated, p.trackable);
                      const personAov = meanOf(p.priced ? p.value : null, p.priced);
                      const personRating = meanOf(p.rated ? p.ratingSum : null, p.rated);
                      return html`<tr>
                        <td><span class="cell-name">${p.name}</span></td>
                        <td class="r cell-figure">${num(p.taken)}</td>
                        <td class="r cell-figure">${num(p.delivered)}</td>
                        <td class="r cell-figure">${p.priced ? money(p.value) : missing()}</td>
                        <td class="r cell-figure">${personAov === null ? missing() : money(personAov)}</td>
                        <td class="r cell-figure">${num(p.rated)} of ${num(p.trackable)}</td>
                        <td>
                          ${!personCapture.ok
                            ? html`<span class="caption">nothing delivered to rate</span>`
                            : html`${meter({ value: p.rated, total: p.trackable, tone: 'ok', label: `${p.name} review capture` })}
                              ${personCapture.small
                                ? html`<span class="caption">${
                                    personCapture.n < MIN_SAMPLE
                                      ? `95% range, only ${personCapture.n} delivered`
                                      : `95% range, ${personCapture.n} delivered`
                                  }</span>`
                                : ''}`}
                        </td>
                        <td class="r cell-figure">${personRating === null ? missing() : num(personRating, { dp: 2 })}</td>
                      </tr>`;
                    })
                  )}
                </tbody>
              </table>
              <p class="tablehint" aria-hidden="true">Scroll sideways for more columns →</p>
            </div>`}
      ${why(
        'Why most of the Capture column is a range on a hatched track',
        html`<p>
            Because most of these rows cannot carry a single number. On current data one person has more
            deliveries in a month than the next eight put together, and a percentage beside a count of four
            reads as a measurement of that person when it is mostly a measurement of how many shifts they
            worked.
          </p>
          <p>
            There are two reasons a row shows a range, and the caption says which. Under
            ${String(MIN_SAMPLE)} deliveries there is not enough to state a rate at all. Above it a rate
            can still be too uncertain to draw: half of fifty-two is a real measurement and its 95%
            interval is still about twenty-five points wide, so the range is the honest figure and the bar
            would be a decoration over it. Either way the interval is shown rather than withheld.
          </p>
          <p>
            The counts are exact and they are the honest comparison. <em>Taken</em> and <em>Delivered</em>
            will not match for anybody: an order taken in the last week of the window is usually delivered
            after it closes.
          </p>`
      )}
    </section>`;

  // ---- per designer ---------------------------------------------------------

  const designers = new Map();
  for (const r of completed) {
    for (const field of ['logo_designer', 'branding_designer']) {
      const name = String(r[field] ?? '').trim();
      if (!name) continue;
      if (!designers.has(name)) designers.set(name, { name, delivered: 0, rated: 0, ratingSum: 0 });
      const row = designers.get(name);
      row.delivered += 1;
      const rating = numberOrNull(r.rating);
      if (rating !== null) {
        row.rated += 1;
        row.ratingSum += rating;
      }
    }
  }
  const designerRows = [...designers.values()].sort((a, b) => b.delivered - a.delivered);

  const designerPanel = html`<section class="panel">
      ${panelHead(
        html`Per designer, ${num(designerRows.length)}`,
        'live',
        `orders.jsonl · ${spanLabel}`,
        'One order can carry a logo designer and a branding designer, so these counts add up to more than the number of orders. It is a count of involvements, not of orders.'
      )}
      ${!designerRows.length
        ? empty('No delivered order in this window names a designer.')
        : html`<div class="tablewrap tablewrap--capped">
              <table class="table">
                <thead><tr><th>Designer</th><th class="r">Delivered on</th><th class="r">Reviews left</th><th class="r">Mean rating</th></tr></thead>
                <tbody>
                  ${join(
                    designerRows.map((g) => {
                      const mean = meanOf(g.rated ? g.ratingSum : null, g.rated);
                      return html`<tr>
                        <td><span class="cell-name">${g.name}</span></td>
                        <td class="r cell-figure">${num(g.delivered)}</td>
                        <td class="r cell-figure">${num(g.rated)}</td>
                        <td class="r cell-figure">${mean === null ? missing() : num(mean, { dp: 2 })}</td>
                      </tr>`;
                    })
                  )}
                </tbody>
              </table>
            </div>`}
      ${info(
        'A mean rating here is not a judgement of the designer. The buyer rates the order, and the order is a brief, a CSR, a turnaround and a drawing. This column says which work came back rated highly, not why.'
      )}
    </section>`;

  // ---- the log --------------------------------------------------------------

  const logRows = [...completed].sort((a, b) => String(b.delivered_date).localeCompare(String(a.delivered_date)));

  const logPanel = html`<section class="panel">
      ${panelHead(
        html`The delivered orders, ${num(logRows.length)}`,
        'live',
        `orders.jsonl · ${spanLabel}`,
        'Newest delivery first. This is the row the figures above are computed from, so anything that looks wrong can be traced to its order here and then to the sheet.'
      )}
      ${!logRows.length
        ? empty('Nothing to list.')
        : html`<div class="tablewrap tablewrap--capped">
              <table class="table table--wide">
                <thead>
                  <tr>
                    <th>Delivered</th><th>Buyer</th><th>Project</th><th>Type</th>
                    <th>CSR</th><th>Designer</th><th class="r">Value</th><th class="r">Rating</th>
                  </tr>
                </thead>
                <tbody>
                  ${join(
                    logRows.map((r) => {
                      const rating = numberOrNull(r.rating);
                      return html`<tr>
                        <td>${iso(r.delivered_date) ? dateShort(r.delivered_date) : missing()}</td>
                        <td><span class="cell-name">${r.client || missing()}</span></td>
                        <td>${r.project || missing()}</td>
                        <td>${r.order_type === 'organic' ? pill('ok', 'Organic') : r.order_type ? pill('info', 'Directed') : missing()}</td>
                        <td>${personOf(r) || missing()}</td>
                        <td>${r.logo_designer || r.branding_designer || html`<span class="caption">None named</span>`}</td>
                        <td class="r cell-figure">${numberOrNull(r.amount) === null ? missing() : money(r.amount)}</td>
                        <td class="r cell-figure">${rating === null ? html`<span class="caption">no review</span>` : num(rating, { dp: 1 })}</td>
                      </tr>`;
                    })
                  )}
                </tbody>
              </table>
              <p class="tablehint" aria-hidden="true">Scroll sideways for more columns →</p>
            </div>`}
    </section>`;

  // ---- what the page leads with ---------------------------------------------

  const title = !completed.length
    ? `Nothing delivered between ${spanLabel}`
    : belowFive.length
      ? `${completed.length} delivered, ${belowFive.length} came back under five stars`
      : `${completed.length} delivered, every review five stars`;

  return {
    title,
    kicker: `Pulse · the order book · ${spanLabel}`,
    ticker: [
      { label: 'Delivered', value: num(completed.length) },
      { label: 'Value', value: completedValue.total === null ? missing() : money(completedValue.total) },
      { label: 'AOV', value: aov === null ? missing() : money(aov) },
      { label: 'Taken', value: num(taken.length) },
      {
        label: 'Reviews left',
        value: num(rated.length),
        sub: trackable.length ? `of ${trackable.length} delivered` : '',
      },
      {
        label: 'Under five',
        value: num(belowFive.length),
        sub: rated.length ? `of ${rated.length} rated` : '',
      },
    ],
    html: html`${windowBar}
      ${completionsPanel}
      ${reviewsPanel}
      ${peoplePanel}
      ${designerPanel}
      ${logPanel}
      <div class="provenance-bar">
        <span>Every figure on this page is a cut of <code class="mono">data/orders.jsonl</code>, which the
          engine writes from the order sheet on each run. The sheet is never written to from here.</span>
        <span>Deliveries are dated by delivery and orders taken by order date, because they are two
          different events and one window cannot hold both honestly.</span>
        <span>Rates follow the house rule: below ${String(MIN_SAMPLE)}, or wider than 15 points, they are an
          interval on a hatched track and never a bar. Most rows in the per-CSR table are under it.</span>
      </div>`,
  };
}

export default render;
