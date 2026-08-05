// views/money.js — revenue, money sitting still, and the upsell pipeline.
//
// THE ONE SENTENCE THIS PAGE EXISTS TO SAY
//
//   $6,952 earned. $8,007 waiting.
//
// More money is standing still than the agency has booked in five weeks, and
// not one dollar of the standing money needs new traffic, a marketplace lever
// or anybody's permission. So the at-rest figure leads and the earned figure
// sits beside it for scale — that ordering is the finding, not a layout
// preference.
//
// THE DECOMPOSITION IS THE PROOF
//
// A headline nobody can check is a slogan. $8,007 is printed with its two
// parts — stale open orders and quotes that never became orders — their counts,
// their values, and a footer that adds them up and says out loud whether the
// sum matches the engine's own `recovery.total_at_rest`. If it ever stops
// matching, the page says so rather than quietly showing a total that is not
// the sum of the rows above it.
//
// THE THREE WAYS THIS DATA IS NORMALLY READ WRONG
//
//   1. An open order is not one thing. Sorting into "we owe work" / "they owe
//      a reply" / "dead" happens on the Orders page, which owns that split.
//      This page links there and refuses to imply that "chase the 17" is an
//      instruction — a check-in to a buyer who is waiting on US is how a late
//      order becomes a dispute.
//
//   2. Follow-up counts are not a measure of neglect. Quoted leads with no
//      logged follow-up convert far higher than the chased ones, because a
//      follow-up is only ever logged when the buyer did not say yes
//      immediately. The rate that costs the work is the one WITHIN the chased
//      group, and that is the only one this page states as a benchmark.
//
//   3. A take-up rate needs the group that was actually offered something as
//      its denominator. The engine's `economics.upsell_rate` is a census over
//      every order in the window; that is a different quantity and it is
//      labelled as one here. Where the offered group is empty the take-up rate
//      is MISSING — never 0%, which would read as "we asked and they said no".
//
// WHAT COMES FROM WHERE
//
//   run.metrics.economics    revenue, AOV, median, spread, by type, by designer
//   run.recovery             open orders, quotes, the follow-up benchmark
//   run.edge                 the engine's own note on the repeat base
//   upsell (MySQL)           the board. The ONLY thing on this page a human
//                            typed, and the only thing that can be edited here.
//
// `extra_earned` is somebody's estimate of a future sale. It is never added to
// a revenue figure the engine computed, on this page or any other.

import {
  html,
  join,
  safe,
  missing,
  money,
  num,
  pct,
  days,
  dateShort,
  glyph,
  pill,
  panelHead,
  why,
  empty,
  rate,
  rangeFigure,
  known,
} from './layout.js';
import { pick, isMissing } from '../lib/data.js';
import { normaliseBuyer } from '../lib/reconcile.js';

// ============================================================================
// 1. SMALL HELPERS
// ============================================================================

const USD0 = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

/** Plain-text money for `title` / `kicker`, which are prose rather than markup. */
function plainMoney(value) {
  return known(value) ? USD0.format(Number(value)) : 'MISSING';
}

/** A number if it is one, otherwise null. Never a substituted default. */
function n(value) {
  return known(value) ? Number(value) : null;
}

function utcDay(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? ''));
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

/**
 * The span the revenue window covers, inclusive of both end days.
 *
 * Reported in whole days AND in weeks, because the deck says "weeks" and a
 * reader who wants to check it needs the days the rounding came from. Returns
 * null rather than guessing when either end is unreadable — a window with no
 * measurable length gets no week count in the deck at all.
 */
function windowSpan(startIso, endIso) {
  const a = utcDay(startIso);
  const b = utcDay(endIso);
  if (a === null || b === null || b < a) return null;
  const spanDays = Math.round((b - a) / 86_400_000) + 1;
  return { days: spanDays, weeks: Math.max(1, Math.round(spanDays / 7)) };
}

const WEEK_WORDS = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
function weekWord(weeks) {
  return WEEK_WORDS[weeks] || String(weeks);
}

/**
 * Display label for an engine `by_type` key.
 *
 * Known keys get a written label. Anything else is title-cased and handed to
 * the escaping template, which is where the retired programme's internal name
 * is turned into its one permitted label. That is deliberate: this file never
 * writes the retired name, and it does not scrub at the call site either — it
 * lets the single chokepoint do the job, so a key that does not exist yet is
 * handled by the same rule as the ones that do.
 */
const TYPE_LABEL = { organic: 'Organic', unknown: 'Type not recorded' };
function typeLabel(key) {
  const k = String(key ?? '');
  return TYPE_LABEL[k] || (k ? k.charAt(0).toUpperCase() + k.slice(1) : '');
}

/** A share of a KNOWN TOTAL — arithmetic on a census, not a rate on a sample. */
function shareOf(part, whole) {
  const p = n(part);
  const w = n(whole);
  if (p === null || w === null || w === 0) return missing();
  return pct(p / w);
}

function clientHref(buyer) {
  return `/clients/${encodeURIComponent(String(buyer ?? ''))}`;
}

// ============================================================================
// 2. THE UPSELL BOARD — the sheet's three columns, and what settles them
// ============================================================================
//
// The XStudioz sheet runs RESEARCH -> OPPORTUNITY -> SELLING. The `upsell`
// table's stage enum is finer than that, so the mapping is stated here and
// printed on the page rather than being implied by column order.

const COLUMNS = [
  {
    key: 'research',
    column: 'Research',
    tone: 'idle',
    what: 'a buyer worth studying — no gap named yet',
  },
  {
    key: 'pitch',
    column: 'Opportunity',
    tone: 'info',
    what: 'a named gap, and something concrete to offer',
  },
  {
    key: 'followup',
    column: 'Selling',
    tone: 'warn',
    what: 'the offer is with the buyer and the conversation is live',
  },
];

const SETTLED = [
  { key: 'won', label: 'Won', tone: 'ok' },
  { key: 'lost', label: 'Lost', tone: 'crit' },
];

const STAGE_LABEL = {
  research: 'Research',
  pitch: 'Opportunity',
  followup: 'Selling',
  won: 'Won',
  lost: 'Lost',
};

const STAGE_TONE = {
  research: 'idle',
  pitch: 'info',
  followup: 'warn',
  won: 'ok',
  lost: 'crit',
};

const OPEN_STAGES = new Set(['research', 'pitch', 'followup']);

/**
 * Read the typed board.
 *
 * `ok:false` is an outage and `rows:[]` is a fact — they are kept apart all the
 * way to the render, because "nobody is on the board" and "the board could not
 * be read" produce the same empty screen if they are ever merged, and only one
 * of them means there is nothing to do.
 */
function readBoard(result) {
  if (!result || result.ok !== true || !Array.isArray(result.rows)) {
    return { ok: false, rows: [], byStage: new Map(), open: [], offered: [], won: [] };
  }
  const rows = result.rows;
  const byStage = new Map();
  for (const row of rows) {
    const stage = String(row.stage ?? '');
    const bucket = byStage.get(stage);
    if (bucket) bucket.push(row);
    else byStage.set(stage, [row]);
  }
  return {
    ok: true,
    rows,
    byStage,
    open: rows.filter((r) => OPEN_STAGES.has(String(r.stage))),
    // The offered group is the `asked` column and nothing else. Inferring
    // "they must have been asked" from a won row would quietly widen the
    // denominator with rows nobody recorded an ask against.
    offered: rows.filter((r) => Number(r.asked) === 1),
    won: rows.filter((r) => String(r.stage) === 'won'),
  };
}

/** Settled rows where nobody ticked `asked` — a hole in the record, not a zero. */
function settledWithoutAsk(board) {
  return board.rows.filter(
    (r) => (String(r.stage) === 'won' || String(r.stage) === 'lost') && Number(r.asked) !== 1
  );
}

// ============================================================================
// 3. RENDER
// ============================================================================

export function render(ctx) {
  const run = ctx.run;
  const econ = pick(run, 'metrics.economics');
  const recovery = pick(run, 'recovery');
  const board = readBoard(ctx.data?.upsell);

  // Nothing computed is readable. Say that, and do not draw a money page out of
  // the one store that happens to be up — a revenue figure of MISSING beside a
  // typed board reads as "we earned nothing", which is a lie with a layout.
  if (isMissing(econ) && isMissing(recovery)) {
    return {
      title: 'No money figure can be stated',
      kicker: 'Money',
      deck: html`Revenue and money-at-rest are <em>MISSING</em> — not zero, and not "a quiet month".`,
      html: html`<div class="figure">
          <span class="cap">metrics.economics + recovery</span>
          <strong class="mid">${missing()}</strong>
          <p class="sub">
            <code class="mono">data/latest-run.json</code> is absent or unreadable, so there is no revenue
            figure, no money-at-rest figure and no follow-up benchmark. The upsell board below is typed
            into this hub and is unaffected — but it is a list of intentions, never a revenue number.
          </p>
        </div>
        <p class="note note--neg">
          ${glyph('crit')} Redeploy with the engine's output in <code class="mono">data/</code>, or run the
          engine. Nothing on this page is safe to reconstruct from the order book alone: every figure here
          is scoped to the engine's own window and as-of date, and without the run there is neither.
        </p>
        ${boardPanel(ctx, board, { typical: null })}`,
    };
  }

  // ---- the two headline numbers -------------------------------------------
  const revenue = pick(run, 'metrics.economics.revenue');
  const atRest = pick(run, 'recovery.total_at_rest');
  const staleCount = pick(run, 'recovery.open_orders.stale_count');
  const staleValue = pick(run, 'recovery.open_orders.stale_value');
  const staleAfter = pick(run, 'recovery.open_orders.stale_after_days');
  const quoteCount = pick(run, 'recovery.quotes.count');
  const quoteTotal = pick(run, 'recovery.quotes.total');
  const windowLabel = pick(run, 'window.label');
  const span = windowSpan(pick(run, 'window.start'), pick(run, 'metrics.as_of'));

  const rev = n(revenue);
  const rest = n(atRest);
  const surplus = rev !== null && rest !== null ? rest - rev : null;
  const typical = n(pick(run, 'metrics.economics.median'));

  // "in the five weeks since 1 July 2026" when both ends of the window are
  // readable; the window's own label alone when they are not. The week count is
  // never asserted without the dates it was counted from.
  const bookedIn = span
    ? html`in the ${weekWord(span.weeks)} week${span.weeks === 1 ? '' : 's'} ${
        isMissing(windowLabel) ? 'of the window' : String(windowLabel)
      }`
    : html`${isMissing(windowLabel) ? 'in the current window' : String(windowLabel)}`;

  const deck =
    surplus === null
      ? html`<em>${money(revenue)} earned. ${money(atRest)} waiting.</em> One of the two cannot be stated,
          so the comparison between them is not made here.`
      : surplus > 0
        ? html`<em>${money(revenue)} earned. ${money(atRest)} waiting.</em> More money is standing still
            than the agency has booked ${bookedIn} — ${money(surplus)} more, and none of it needs new
            traffic.`
        : html`<em>${money(revenue)} earned. ${money(atRest)} waiting.</em> The booked figure is ahead of
            the standing one by ${money(Math.abs(surplus))}; the standing money still needs no new traffic.`;

  return {
    title: `${plainMoney(atRest)} standing still against ${plainMoney(revenue)} booked`,
    kicker: 'Money',
    deck,
    ticker: [
      {
        label: 'Earned',
        value: money(revenue),
        sub: isMissing(windowLabel) ? null : String(windowLabel),
      },
      { label: 'Sitting still', value: money(atRest), sub: 'no new traffic needed' },
      {
        label: `Open past ${known(staleAfter) ? String(staleAfter) : '—'} days`,
        value: money(staleValue),
        sub: known(staleCount) ? `${staleCount} orders · floor` : null,
      },
      {
        label: 'Quotes never placed',
        value: money(quoteTotal),
        sub: known(quoteCount) ? `${quoteCount} leads` : null,
      },
      {
        label: 'Typical order',
        value: money(typical),
        sub: known(pick(run, 'metrics.economics.aov'))
          ? `median · mean ${plainMoney(pick(run, 'metrics.economics.aov'))}`
          : 'median',
      },
      {
        label: 'On the upsell board',
        value: board.ok ? num(board.rows.length) : missing(),
        sub: board.ok ? `${board.open.length} still open` : 'typed records unreachable',
      },
    ],
    html: join([
      lede(run, { revenue, atRest, surplus, span, windowLabel }),
      atRestPanel(run),
      followupPanel(run),
      revenuePanel(run),
      boardPanel(ctx, board, { typical }),
      provenance(ctx, board),
    ]),
  };
}

// ============================================================================
// 4. THE LEDE — the standing money, with the booked money beside it for scale
// ============================================================================

function lede(run, { revenue, atRest, surplus, span, windowLabel }) {
  const staleCount = pick(run, 'recovery.open_orders.stale_count');
  const staleValue = pick(run, 'recovery.open_orders.stale_value');
  const staleAfter = pick(run, 'recovery.open_orders.stale_after_days');
  const quoteCount = pick(run, 'recovery.quotes.count');
  const quoteTotal = pick(run, 'recovery.quotes.total');
  const orders = pick(run, 'metrics.economics.n_orders');
  const priced = pick(run, 'metrics.economics.n_priced');
  const aov = pick(run, 'metrics.economics.aov');
  const median = pick(run, 'metrics.economics.median');
  const unpricedInWindow =
    known(orders) && known(priced) ? Number(orders) - Number(priced) : null;

  return html`<div class="lede">
      <div class="lede-main">
        <div class="figure">
          <span class="cap">Money sitting still</span>
          <strong class="big">${money(atRest)}</strong>
          <p class="sub">
            <b>${num(staleCount)}</b> orders open longer than ${days(staleAfter)} hold
            ${money(staleValue)}, and <b>${num(quoteCount)}</b> quotes that never became orders hold
            ${money(quoteTotal)}. ${surplus !== null && surplus > 0
              ? html`That is <b>${money(surplus)}</b> more than the agency booked
                  ${isMissing(windowLabel) ? 'in the window' : String(windowLabel)}.`
              : ''}
          </p>
        </div>
        ${why(
          'What the two numbers are, and why they are not the same kind of number',
          html`<p>
              <strong>Earned</strong> is closed business inside the engine's window:
              ${isMissing(windowLabel) ? 'the current window' : String(windowLabel)}${
                span ? html`, ${num(span.days)} days` : ''
              }. <strong>Sitting still</strong> is not scoped to any window — it is every open order past
              ${days(staleAfter)} and every quote still unplaced, however old. Comparing them says one
              thing only, and it is the thing worth saying: the pile nobody is working is bigger than the
              pile everybody is.
            </p>
            <p>
              Neither figure is a forecast and neither is a target. ${money(atRest)} is not money that will
              arrive; it is money that has already been agreed to or already been quoted, sitting where
              somebody stopped. Some of it is dead. What makes it worth leading with is that recovering
              any of it needs no new traffic, no marketplace lever and nobody's permission.
            </p>`
        )}
      </div>
      <div class="lede-side">
        <div class="figure">
          <span class="cap">Earned ${isMissing(windowLabel) ? '' : String(windowLabel)}</span>
          <strong class="mid">${money(revenue)}</strong>
          <p class="sub">
            across <b>${num(orders)}</b> orders. Typical order ${money(median)} — the median; the mean is
            ${money(aov)}.
            ${unpricedInWindow
              ? html` ${num(unpricedInWindow)} of those orders carries no amount at all, so the revenue is
                  a floor.`
              : ''}
          </p>
        </div>
        <p class="note">
          ${glyph('info')} The median is the honest "typical". One $800 order in this window pulls the mean
          to ${money(aov)}, and every pool costed on the mean inherits that single order.
        </p>
      </div>
    </div>`;
}

// ============================================================================
// 5. MONEY AT REST — decomposed, and added back up in front of the reader
// ============================================================================

function atRestPanel(run) {
  const open = pick(run, 'recovery.open_orders');
  const quotes = pick(run, 'recovery.quotes');
  const atRest = pick(run, 'recovery.total_at_rest');

  if (isMissing(open) && isMissing(quotes)) {
    return html`<div class="panel">
        ${panelHead('Money sitting still', 'missing', 'recovery block absent')}
        <div class="figure">
          <span class="cap">recovery.open_orders + recovery.quotes</span>
          <strong class="mid">${missing()}</strong>
          <p class="sub">
            The run carries no recovery block, so the standing money cannot be decomposed and is not shown
            split. This is an incomplete run, not an empty pile.
          </p>
        </div>
      </div>`;
  }

  const staleCount = n(pick(run, 'recovery.open_orders.stale_count'));
  const staleValue = n(pick(run, 'recovery.open_orders.stale_value'));
  const quoteCount = n(pick(run, 'recovery.quotes.count'));
  const quoteTotal = n(pick(run, 'recovery.quotes.total'));
  const staleAfter = pick(run, 'recovery.open_orders.stale_after_days');

  const partsCount =
    staleCount === null || quoteCount === null ? null : staleCount + quoteCount;
  const partsValue =
    staleValue === null || quoteTotal === null ? null : staleValue + quoteTotal;
  const total = n(atRest);
  const sumsExactly =
    partsValue !== null && total !== null && Math.abs(partsValue - total) < 0.005;

  // How much of the stale bucket carries no amount. The engine counts an
  // unpriced order as 0.0, so the value is a floor — and saying "floor" is only
  // meaningful if the page can say how many rows made it one.
  const openRows = pick(run, 'recovery.open_orders.orders');
  const staleRows = Array.isArray(openRows) ? openRows.filter((r) => r && r.stale === true) : null;
  const staleUnpriced = staleRows
    ? staleRows.filter((r) => !Number.isFinite(r.amount) || r.amount === 0).length
    : null;

  const untouchedCount = pick(run, 'recovery.quotes.untouched_count');
  const untouchedValue = pick(run, 'recovery.quotes.untouched_value');

  return html`<div class="panel">
      ${panelHead(
        html`${money(atRest)} is sitting in two piles`,
        'live',
        'Live · recovery.open_orders + recovery.quotes'
      )}

      <div class="tablewrap">
        <table class="table">
          <thead>
            <tr>
              <th scope="col">Pile</th>
              <th scope="col" class="r">Count</th>
              <th scope="col" class="r">Value</th>
              <th scope="col">What it is, and who owns it</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <a class="cell-name" href="/orders?band=60%2B">${glyph('crit')} Open orders past
                  ${known(staleAfter) ? String(staleAfter) : '—'} days</a>
                ${staleUnpriced
                  ? html`<span class="cell-sub">${num(staleUnpriced)} of them carry no amount</span>`
                  : ''}
              </td>
              <td class="r cell-figure">${num(staleCount)}</td>
              <td class="r cell-figure">${money(staleValue)}${
                staleUnpriced ? html`<span class="cell-sub">floor</span>` : ''
              }</td>
              <td>
                Paid work that has not closed. <strong>Sort before you send</strong> — the Orders page
                splits these into <em>we owe work</em>, <em>they owe a reply</em> and <em>dead</em>, and
                only the middle one takes a check-in.
              </td>
            </tr>
            <tr>
              <td>
                <a class="cell-name" href="/inquiries">${glyph('warn')} Quotes that never became
                  orders</a>
                ${known(untouchedCount)
                  ? html`<span class="cell-sub">${num(untouchedCount)} with no follow-up logged</span>`
                  : ''}
              </td>
              <td class="r cell-figure">${num(quoteCount)}</td>
              <td class="r cell-figure">${money(quoteTotal)}</td>
              <td>
                A price was given and nothing came back. ${known(untouchedValue)
                  ? html`${money(untouchedValue)} of it sits with leads nobody followed up.`
                  : ''}
                Ezan owns this pile.
              </td>
            </tr>
          </tbody>
          <tfoot>
            <tr>
              <td>Sitting still</td>
              <td class="r cell-figure">${num(partsCount)}</td>
              <td class="r cell-figure">${money(partsValue)}</td>
              <td>
                ${glyph(sumsExactly ? 'ok' : 'crit')}
                ${sumsExactly
                  ? html`Adds up exactly to the engine's ${money(atRest)}.`
                  : partsValue === null || total === null
                    ? html`<b class="neg">One of the two piles is MISSING</b>, so the total above cannot be
                        checked against the engine's own ${money(atRest)}.`
                    : html`<b class="neg">Does not match the engine's ${money(atRest)}.</b> Trust the
                        engine's figure and check the join before acting on either row.`}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <p class="note note--neg">
        ${glyph('crit')} <b>No review request attaches to any of this work.</b> Every row above is a late
        order or a cold quote, and a review ask on a late delivery is the most reliable way to turn a
        private three-star into a public one. There is no affordance for it on this page and none may be
        added.
      </p>

      ${quotesTable(run)}

      ${why(
        'Why the piles are not interchangeable, and what each one costs to work',
        html`<p>
            <strong>An open order is not one thing.</strong> Before a single message goes out, each one is
            sorted into <em>we owe work</em>, <em>they owe a reply</em>, or <em>dead</em>. A "just checking
            in" note sent to a buyer who is waiting on us tells them, in writing and with a timestamp,
            that we have not started. That is how a late order becomes a dispute — so the count of 17 is
            never an instruction to send 17 messages. The
            <a href="/orders?band=60%2B">Orders page</a> owns that split and proves it sums to the same
            ${money(pick(run, 'recovery.open_orders.stale_value'))}.
          </p>
          <p>
            ${staleUnpriced === null
              ? html`The run does not carry the individual open orders, so how much of
                  ${money(pick(run, 'recovery.open_orders.stale_value'))} rests on orders with no recorded
                  amount is ${missing()}. Treat it as a floor until it can be checked.`
              : staleUnpriced > 0
                ? html`<strong>${num(staleUnpriced)} of the stale orders carry no amount at all</strong>,
                    and the engine counts an unpriced order as zero.
                    ${money(pick(run, 'recovery.open_orders.stale_value'))} is therefore a floor, not a
                    total — the pile is at least that big and cannot be smaller.`
                : html`Every stale order carries an amount, so
                    ${money(pick(run, 'recovery.open_orders.stale_value'))} is a total rather than a
                    floor.`}
          </p>
          <p>
            The quote pile is the cheaper of the two to work and the one with no dispute risk attached: a
            buyer who never ordered cannot be made late. It is also the pile where the follow-up numbers
            are read backwards most often — see the benchmark directly below.
          </p>`
      )}
    </div>`;
}

/**
 * The quotes themselves.
 *
 * Deliberately NOT highlighted by follow-up count. Marking the untouched rows
 * as the urgent ones would print the exact inference the benchmark below
 * exists to refute — that a missing follow-up is a missing effort. They are
 * ordered by money, which is the only ordering that survives that objection.
 */
function quotesTable(run) {
  const rows = pick(run, 'recovery.quotes.quotes');
  if (!Array.isArray(rows)) {
    return html`<p class="note note--warn">
        The individual quotes are ${missing()} from this run, so only the totals above can be shown.
      </p>`;
  }
  if (rows.length === 0) {
    return empty('The engine found no unplaced quotes. That is a fact about the pipeline, not a gap.');
  }

  const sorted = [...rows].sort((a, b) => (Number(b.quoted) || 0) - (Number(a.quoted) || 0));

  return html`<div class="block">
      <h3>Every unplaced quote, largest first</h3>
      <div class="tablewrap tablewrap--capped">
        <table class="table table--wide table--zebra">
          <thead>
            <tr>
              <th scope="col">Buyer</th>
              <th scope="col" class="r">Quoted</th>
              <th scope="col" class="r">Age</th>
              <th scope="col" class="r">Follow-ups logged</th>
              <th scope="col">CSR</th>
              <th scope="col">Country</th>
              <th scope="col">Note on the lead</th>
            </tr>
          </thead>
          <tbody>
            ${join(
              sorted.map(
                (q) => html`<tr>
                    <td>
                      <a class="cell-name" href="${clientHref(q.client)}">${q.client}</a>
                      <span class="cell-sub">quoted ${dateShort(q.date)}</span>
                    </td>
                    <td class="r cell-figure">${money(q.quoted)}</td>
                    <td class="r cell-figure">${days(q.age_days)}</td>
                    <td class="r cell-figure">${num(q.followups)}</td>
                    <td>${q.csr || missing()}</td>
                    <td>${q.country || missing()}</td>
                    <td>${q.note || missing()}</td>
                  </tr>`
              )
            )}
          </tbody>
        </table>
        <p class="tablehint" aria-hidden="true">Scroll sideways for more columns →</p>
      </div>
      <p class="caption">
        Ordered by value, not by follow-up count. A quote with no logged follow-up is not a neglected one
        and this table does not colour it as though it were — the reason is the benchmark below. Ages are
        measured to ${dateShort(pick(run, 'recovery.quotes.as_of'))}, the engine's run date, so every one
        is a floor.
      </p>
    </div>`;
}

// ============================================================================
// 6. THE FOLLOW-UP BENCHMARK — the number that is read backwards
// ============================================================================

function followupPanel(run) {
  const bench = pick(run, 'recovery.followup_benchmark');
  if (isMissing(bench) || !bench) {
    return html`<div class="panel">
        ${panelHead('What chasing a quote is worth', 'missing', 'recovery.followup_benchmark absent')}
        <p class="note note--warn">
          The follow-up benchmark is ${missing()} from this run, so the cost of chasing the quote pile
          cannot be stated. Do not substitute the raw split of placed-versus-not by follow-up count: on
          this data that comparison points the wrong way for a reason that has nothing to do with effort.
        </p>
      </div>`;
  }

  const followedN = n(bench.followed_n);
  const followedPlaced = n(bench.followed_placed);
  const neverN = n(bench.never_n);
  const neverPlaced = n(bench.never_placed);

  const chased = rate(followedPlaced, followedN);
  const unchased = rate(neverPlaced, neverN);

  return html`<div class="panel">
      ${panelHead(
        'What chasing a quote is actually worth',
        'live',
        'Live · recovery.followup_benchmark'
      )}

      <div class="figure">
        <span class="cap">Conversion within the group that was chased</span>
        <strong class="mid">${chased.ok ? chased.html : missing()}</strong>
        <p class="sub">
          ${num(followedPlaced)} of the <b>${num(followedN)}</b> quoted leads anyone followed up went on to
          place. ${chased.ok && chased.small
            ? html`On ${num(followedN)} leads that is a range, not a number — the interval below is the
                honest width of it.`
            : ''}
          This is the rate the chase is costed on.
        </p>
      </div>

      ${chased.ok && followedN !== null
        ? rangeFigure({ k: followedPlaced, n: followedN, note: 'chased leads only' })
        : ''}

      <div class="tablewrap">
        <table class="table table--narrow">
          <thead>
            <tr>
              <th scope="col">Group</th>
              <th scope="col" class="r">Leads</th>
              <th scope="col" class="r">Placed</th>
              <th scope="col" class="r">Conversion</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><span class="cell-name">Followed up at least once</span></td>
              <td class="r cell-figure">${num(followedN)}</td>
              <td class="r cell-figure">${num(followedPlaced)}</td>
              <td class="r cell-figure">${chased.ok ? chased.html : missing()}</td>
            </tr>
            <tr>
              <td>
                <span class="cell-name">No follow-up logged</span>
                <span class="cell-sub">not the same as "nobody tried"</span>
              </td>
              <td class="r cell-figure">${num(neverN)}</td>
              <td class="r cell-figure">${num(neverPlaced)}</td>
              <td class="r cell-figure">${unchased.ok ? unchased.html : missing()}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <p class="note note--neg">
        ${glyph('crit')} <b>Do not read the second row as evidence that chasing hurts.</b> A follow-up is
        logged exactly when the buyer did <em>not</em> say yes immediately. Every lead who agreed on the
        first message lands in the bottom row by construction, which is why it converts higher — the split
        measures when the log gets written, not how well anyone sold. The number that costs the work is the
        one <em>within</em> the chased group, and it is the figure at the top of this panel.
      </p>

      ${why(
        'What this benchmark can and cannot settle',
        html`<p>
            No bar is drawn on either row and no arrow sits beside them. The chased group is
            ${num(followedN)} leads; on a denominator that size a single extra placement moves the point
            estimate by several percentage points, and a picture that hides that would be more confident
            than the data.
          </p>
          <p>
            Neither row is a controlled comparison. The two groups were not assigned — a CSR decides who to
            chase, and that decision is made knowing something about the lead. Any difference between the
            rows therefore contains selection as well as effect, in an unknown mix. The only clean way to
            get the effect size is to chase a randomly chosen half of the next batch and compare, which is
            a cheap experiment on ${num(neverN)} untouched leads and has not been run yet.
          </p>
          <p>
            What the top figure <em>is</em> good for: costing the work. At
            ${chased.ok ? chased.html : missing()} within the chased group, working the
            ${money(pick(run, 'recovery.quotes.total'))} quote pile has an expected value that can be
            compared against the hours it takes. That comparison does not need the causal question
            answered.
          </p>`
      )}
    </div>`;
}

// ============================================================================
// 7. WHERE THE REVENUE CAME FROM
// ============================================================================

function revenuePanel(run) {
  const econ = pick(run, 'metrics.economics');
  if (isMissing(econ) || !econ) {
    return html`<div class="panel">
        ${panelHead('Where the revenue came from', 'missing', 'metrics.economics absent')}
        <p class="note note--warn">
          The economics block is ${missing()} from this run. No revenue, average or spread is shown —
          rather than a zero that would read as a month with no orders.
        </p>
      </div>`;
  }

  const revenue = n(econ.revenue);
  const orders = econ.n_orders;
  const priced = econ.n_priced;
  const windowLabel = pick(run, 'window.label');

  const byType = econ.by_type && typeof econ.by_type === 'object' ? Object.entries(econ.by_type) : [];
  const typeRows = byType
    .map(([key, v]) => ({ key, ...v }))
    .sort((a, b) => (Number(b.revenue) || 0) - (Number(a.revenue) || 0));
  const typeSum = typeRows.reduce((acc, r) => acc + (Number(r.revenue) || 0), 0);
  const typeMatches = revenue !== null && Math.abs(typeSum - revenue) < 0.005;

  const byDesigner = Array.isArray(econ.by_designer) ? econ.by_designer : [];
  const designerSum = byDesigner.reduce((acc, r) => acc + (Number(r.revenue) || 0), 0);
  const designerOrders = byDesigner.reduce((acc, r) => acc + (Number(r.n) || 0), 0);
  const unattributedValue = revenue === null ? null : revenue - designerSum;
  const unattributedOrders = known(priced) ? Number(priced) - designerOrders : null;

  return html`<div class="panel">
      ${panelHead(
        html`Where ${money(econ.revenue)} came from`,
        'live',
        html`Live · metrics.economics · ${isMissing(windowLabel) ? 'window MISSING' : String(windowLabel)}`
      )}

      <dl class="stats">
        <div class="stat">
          <dt>Revenue</dt>
          <dd>${money(econ.revenue)}</dd>
        </div>
        <div class="stat">
          <dt>Orders</dt>
          <dd>${num(orders)}</dd>
        </div>
        <div class="stat">
          <dt>Median order</dt>
          <dd>${money(econ.median)}</dd>
        </div>
        <div class="stat">
          <dt>Mean order</dt>
          <dd>${money(econ.aov)}</dd>
        </div>
        <div class="stat">
          <dt>Middle half</dt>
          <dd>${money(econ.q1)}<span class="u"> to </span>${money(econ.q3)}</dd>
        </div>
        <div class="stat">
          <dt>Tips</dt>
          <dd>${money(econ.tip_total)}</dd>
        </div>
      </dl>

      <p class="caption">
        ${known(orders) && known(priced) && Number(orders) !== Number(priced)
          ? html`${num(Number(orders) - Number(priced))} of the ${num(orders)} orders in this window carry
              no amount, so the revenue is a floor: it is at least ${money(econ.revenue)} and cannot be
              less.`
          : html`All ${num(orders)} orders in this window carry an amount.`}
        The middle half of orders sits between ${money(econ.q1)} and ${money(econ.q3)}; the mean is above
        the median because a small number of large orders pull it there.
      </p>

      ${typeRows.length
        ? html`<div class="block">
            <h3>By how the order arrived</h3>
            <div class="tablewrap">
              <table class="table table--narrow">
                <thead>
                  <tr>
                    <th scope="col">Source</th>
                    <th scope="col" class="r">Orders</th>
                    <th scope="col" class="r">Revenue</th>
                    <th scope="col" class="r">Share</th>
                    <th scope="col" class="r">Average order</th>
                  </tr>
                </thead>
                <tbody>
                  ${join(
                    typeRows.map(
                      (r) => html`<tr>
                          <td><span class="cell-name">${typeLabel(r.key)}</span></td>
                          <td class="r cell-figure">${num(r.n)}</td>
                          <td class="r cell-figure">${money(r.revenue)}</td>
                          <td class="r cell-figure">${shareOf(r.revenue, revenue)}</td>
                          <td class="r cell-figure">${Number(r.n) ? money(r.aov) : missing()}</td>
                        </tr>`
                    )
                  )}
                </tbody>
                <tfoot>
                  <tr>
                    <td>All priced orders</td>
                    <td class="r cell-figure">${num(priced)}</td>
                    <td class="r cell-figure">${money(typeSum)}</td>
                    <td class="r cell-figure">${shareOf(typeSum, revenue)}</td>
                    <td class="r cell-figure"></td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <p class="caption">
              ${typeMatches
                ? html`${glyph('ok')} The rows add up exactly to ${money(econ.revenue)}.`
                : html`${glyph('crit')} The rows do not add up to ${money(econ.revenue)}; trust the
                    headline figure and check the classification.`}
              Shares are of a known total, not rates estimated from a sample, so they carry no interval.
            </p>
            ${why(
              'What this split does and does not license',
              html`<p>
                  These are orders <strong>already booked</strong>. The directed-volume controller is
                  switched off as policy, so nothing here is a lever to pull and there is no volume
                  instruction on this page — the split is history, and its use is to show what each kind of
                  order is worth when it does arrive.
                </p>
                <p>
                  The gap in average order value between the two sources is the part worth acting on, and
                  the action it points at is price, not volume: the same trust base aimed at larger work.
                  Reading it as an argument to add volume would also breach the organic-flow constraint,
                  which is a hard constraint and not a preference.
                </p>`
            )}
          </div>`
        : ''}

      ${byDesigner.length
        ? html`<div class="block">
            <h3>By designer</h3>
            <div class="tablewrap">
              <table class="table table--narrow">
                <thead>
                  <tr>
                    <th scope="col">Designer</th>
                    <th scope="col" class="r">Orders</th>
                    <th scope="col" class="r">Revenue</th>
                    <th scope="col" class="r">Average order</th>
                  </tr>
                </thead>
                <tbody>
                  ${join(
                    byDesigner.map(
                      (d) => html`<tr>
                          <td><span class="cell-name">${d.name}</span></td>
                          <td class="r cell-figure">${num(d.n)}</td>
                          <td class="r cell-figure">${money(d.revenue)}</td>
                          <td class="r cell-figure">${money(d.aov)}</td>
                        </tr>`
                    )
                  )}
                  ${unattributedOrders
                    ? html`<tr>
                        <td>
                          <span class="cell-name">No designer recorded</span>
                          <span class="cell-sub">present in the revenue, absent from the rows above</span>
                        </td>
                        <td class="r cell-figure">${num(unattributedOrders)}</td>
                        <td class="r cell-figure">${money(unattributedValue)}</td>
                        <td class="r cell-figure">${missing()}</td>
                      </tr>`
                    : ''}
                </tbody>
                <tfoot>
                  <tr>
                    <td>All priced orders</td>
                    <td class="r cell-figure">${num(priced)}</td>
                    <td class="r cell-figure">${money(econ.revenue)}</td>
                    <td class="r cell-figure">${money(econ.aov)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <p class="caption">
              ${unattributedOrders
                ? html`The "no designer recorded" row is the remainder between the named rows and the
                    headline revenue, shown rather than dropped — without it the table would appear to
                    account for ${money(designerSum)} of ${money(econ.revenue)} while looking complete.`
                : html`The named rows account for the whole of ${money(econ.revenue)}.`}
              Average order per designer is not a performance ranking: designers are not assigned work at
              random, and the spread between them is mostly which orders they were given.
            </p>
          </div>`
        : ''}
    </div>`;
}

// ============================================================================
// 8. THE UPSELL PIPELINE
// ============================================================================

function boardPanel(ctx, board, { typical }) {
  const run = ctx.run;
  const back = '/money';

  // ---- the pool -----------------------------------------------------------
  //
  // open rows x the typical order value, halved. Every term is printed beside
  // it so the arithmetic can be checked in one glance, and the label says
  // ceiling because the calculation assumes every open row closes — which no
  // pipeline has ever done.
  const openCount = board.ok ? board.open.length : null;
  const pool =
    openCount === null || typical === null ? null : (openCount * typical) / 2;

  // ---- take-up, on the only denominator that means anything ---------------
  const offeredN = board.ok ? board.offered.length : null;
  const tookUp = board.ok ? board.offered.filter((r) => String(r.stage) === 'won').length : null;
  const takeup = offeredN ? rate(tookUp, offeredN) : { ok: false, small: true, html: missing() };
  const orphanSettled = board.ok ? settledWithoutAsk(board) : [];

  const engineUpsellRate = pick(run, 'metrics.economics.upsell_rate');
  const engineUpsellDenom = pick(run, 'metrics.economics.upsell_denominator');
  const engineWithUpsell =
    known(engineUpsellRate) && known(engineUpsellDenom)
      ? Math.round(Number(engineUpsellRate) * Number(engineUpsellDenom))
      : null;
  const leadsWithAttempt = pick(run, 'metrics.funnel.upsell_lift.with_upsell.n');

  const wonExtra = board.ok
    ? board.won.reduce((acc, r) => acc + (Number(r.extra_earned) || 0), 0)
    : null;
  const wonExtraTyped = board.ok ? board.won.filter((r) => known(r.extra_earned)).length : 0;

  return html`<div class="panel">
      ${panelHead(
        'The upsell pipeline',
        board.ok ? 'typed' : 'missing',
        board.ok ? 'Typed · upsell' : 'Typed records unreachable'
      )}

      ${board.ok
        ? ''
        : html`<p class="note note--neg">
            ${glyph('crit')} <b>The board could not be read.</b> Every figure in this section is MISSING —
            not zero, and not "nobody is on the board". The database did not answer; nothing typed has been
            lost.
          </p>`}

      <div class="cols cols--two">
        <div>
          <div class="figure">
            <span class="cap">Pool on the board — a ceiling, not a forecast</span>
            <strong class="mid">${pool === null ? missing() : money(pool)}</strong>
            <p class="sub">
              ${openCount === null
                ? html`The count of open rows is MISSING, so no pool can be computed.`
                : html`<b>${num(openCount)}</b> open row${openCount === 1 ? '' : 's'} ×
                    ${money(typical)} typical order ÷ 2.`}
            </p>
          </div>
        </div>
        <div class="col-rule">
          <div class="figure">
            <span class="cap">Take-up, within the group actually offered</span>
            <strong class="mid">${takeup.ok ? takeup.html : missing()}</strong>
            <p class="sub">
              ${offeredN
                ? html`<b>${num(tookUp)}</b> of the <b>${num(offeredN)}</b> rows marked <em>asked</em> came
                    back won.${takeup.small
                      ? html` On a denominator of ${num(offeredN)} that is a range, not a point — and no
                          bar is drawn on it.`
                      : ''}`
                : board.ok
                  ? html`No row on the board is marked <em>asked</em>, so this rate has no denominator. It
                      is MISSING — <b>not 0%</b>, which would say we offered and were turned down.`
                  : html`The board is unreadable, so the offered group cannot be counted.`}
            </p>
          </div>
        </div>
      </div>

      ${why(
        'How the pool is computed, and why it is a ceiling',
        html`<p>
            ${openCount === null
              ? 'The arithmetic is open rows × the typical order value ÷ 2.'
              : ''}
            <strong>Open rows</strong> are the ones still in Research, Opportunity or Selling — won and
            lost are settled and contribute nothing. <strong>Typical order</strong> is the median of the
            window, ${money(typical)}, not the mean ${money(pick(run, 'metrics.economics.aov'))}: a single
            $800 order sits in this window and costing a pipeline on the mean would quietly build that one
            order into every row.
          </p>
          <p>
            The halving is the only thing in the figure that is not measured, and it is there because the
            unhalved number assumes every open row closes at a full typical order — which is a ceiling
            twice over. Even halved this is <strong>not a forecast</strong>.
            ${takeup.ok
              ? html`The measured take-up is ${takeup.html} on ${num(offeredN)} offered rows${
                  takeup.small
                    ? ' — an interval that spans almost the whole scale, so substituting it for the ÷ 2 would swap a stated ceiling for a false precision'
                    : ', and it is now narrow enough to replace the ÷ 2 with'
                }.`
              : html`There is no measured take-up on this board to multiply by yet, so nothing here is
                  calibrated against a single observed outcome. When the <em>asked</em> column has a real
                  denominator, replace the ÷ 2 with the measured take-up and the figure stops being a
                  ceiling and becomes an estimate.`}
          </p>`
      )}

      <p class="note note--warn">
        ${glyph('warn')} <b>The engine's upsell rate is a different quantity, and it is not this one.</b>
        ${engineWithUpsell === null
          ? html`It is ${missing()} in this run.`
          : html`It reports <b>${num(engineWithUpsell)}</b> of ${num(engineUpsellDenom)} orders in the
              window as carrying an upsell.`}
        Its denominator is <em>every order</em>, including all the buyers nobody ever offered anything to,
        so it measures how often an upsell happened — not how often one was accepted when it was put.
        ${known(leadsWithAttempt)
          ? html` The inquiry log records ${num(leadsWithAttempt)} leads with an upsell attempt against
              them, so there is no offered group on that side either.`
          : ''}
      </p>

      ${orphanSettled.length
        ? html`<p class="note note--warn">
            ${num(orphanSettled.length)} row${orphanSettled.length === 1 ? ' is' : 's are'} marked won or
            lost without <em>asked</em> ticked. They sit outside the take-up denominator above, because a
            settled row is not evidence of an ask that nobody recorded. Tick <em>asked</em> on them and the
            denominator corrects itself.
          </p>`
        : ''}

      ${stageBoard(board)}

      ${board.ok && board.won.length
        ? html`<p class="caption">
            ${num(board.won.length)} won row${board.won.length === 1 ? '' : 's'} carr${
              board.won.length === 1 ? 'ies' : 'y'
            } ${wonExtraTyped ? money(wonExtra) : missing()} of typed <code class="mono">extra_earned</code>.
            That figure is somebody's note of a sale, not an engine measurement, and it is never added to
            the ${money(pick(run, 'metrics.economics.revenue'))} above. Revenue has exactly one source and
            this is not it.
          </p>`
        : ''}

      ${repeatBaseNote(run)}

      ${rowsList(ctx, board, back)}

      ${why('Put someone on the board, or add a new gap', newRowForm(ctx, back))}
    </div>`;
}

/** The sheet's three columns, in its order, with the stage each one maps to. */
function stageBoard(board) {
  return html`<div class="block">
      <h3>Research → Opportunity → Selling</h3>
      <div class="cols cols--three">
        ${join(
          COLUMNS.map((col) => {
            const rows = board.ok ? board.byStage.get(col.key) || [] : null;
            return html`<div>
              <div class="figure">
                <span class="cap">${col.column}</span>
                <strong class="small">${rows === null ? missing() : num(rows.length)}</strong>
                <p class="sub">${col.what}</p>
              </div>
              <p class="caption">stage <code class="mono">${col.key}</code></p>
              ${rows === null
                ? ''
                : rows.length === 0
                  ? html`<p class="caption">Nobody is in this column.</p>`
                  : html`<ul class="steps">
                      ${join(
                        rows
                          .slice(0, 12)
                          .map(
                            (r) => html`<li>
                                <a href="${clientHref(r.buyer)}">${r.buyer}</a>
                                ${r.gap ? html` — ${r.gap}` : ''}
                              </li>`
                          )
                      )}
                    </ul>`}
              ${rows && rows.length > 12
                ? html`<p class="caption">and ${num(rows.length - 12)} more in the table below.</p>`
                : ''}
            </div>`;
          })
        )}
      </div>
      <p class="caption">
        The columns are the XStudioz sheet's own flow. The board's stages map onto them as
        ${join(
          COLUMNS.map(
            (c) => html`<code class="mono">${c.key}</code> → ${c.column}`
          ),
          ' · '
        )}, and
        ${join(
          SETTLED.map((s) => html`<code class="mono">${s.key}</code>`),
          ' / '
        )}
        are settled rather than columns. That mapping is written down here because a reader who assumes it
        from the column order will get <em>Selling</em> and <em>Won</em> the wrong way round.
      </p>
    </div>`;
}

/** The engine's own note on why this board is worth filling. Rendered, not restated. */
function repeatBaseNote(run) {
  const edges = pick(run, 'edge');
  if (!Array.isArray(edges)) return '';
  const repeat = edges.find((e) => e && e.id === 'repeat_base');
  if (!repeat) return '';
  return why(
    'Why the board is worth filling — the engine’s own note',
    html`<p><strong>${repeat.title}</strong></p>
      <p>${repeat.detail}</p>
      <p class="caption">
        Quoted from <code class="mono">latest-run.json</code> without restatement. The figures in it are
        all-time and are not the window figures above; the two are not comparable and are not compared.
      </p>`
  );
}

// ---------------------------------------------------------------- the rows

function rowsList(ctx, board, back) {
  if (!board.ok) return '';
  if (board.rows.length === 0) {
    return html`<div class="block">
        <h3>Every row on the board</h3>
        ${empty('Nobody has been put on the upsell board yet.')}
        <p class="caption">
          That is a fact about the board, not about the clients — the order book has repeat buyers on it
          either way. Add the first row below.
        </p>
      </div>`;
  }

  return html`<div class="block">
      <h3>Every row on the board — ${String(board.rows.length)}</h3>
      ${join(board.rows.map((row) => rowArticle(ctx, row, back)))}
    </div>`;
}

function rowArticle(ctx, row, back) {
  const stage = String(row.stage ?? '');
  const key = normaliseBuyer(row.buyer);

  return html`<article class="snippet">
      <div class="snippet-head">
        <h4>${key ? html`<a href="${clientHref(row.buyer)}">${row.buyer}</a>` : row.buyer}</h4>
        ${pill(STAGE_TONE[stage] || 'idle', STAGE_LABEL[stage] || stage || 'stage MISSING')}
        ${Number(row.asked) === 1 ? pill('info', 'Asked') : ''}
        <span class="uses">${row.updated_at ? dateShort(row.updated_at) : missing()}</span>
      </div>
      <p class="caption">
        ${row.business ? html`${row.business} · ` : ''}Gap ${row.gap || missing()} · Sell first
        ${row.sell_first || missing()} · Owner ${row.owner || missing()}
        ${known(row.extra_earned) ? html` · Typed extra ${money(row.extra_earned)}` : ''}
      </p>
      ${row.next_step ? html`<p class="snippet-body">${row.next_step}</p>` : ''}
      ${row.result ? html`<p class="caption">Result — ${row.result}</p>` : ''}
      ${why('Edit this row', rowForm(ctx, row, back))}
    </article>`;
}

// ---------------------------------------------------------------- the forms
//
// Both forms carry EVERY column. The write is an upsert on (buyer, gap) and it
// updates every field from the values posted, so a form that omitted a field
// would blank it on save — a partial form here silently deletes somebody's
// next step.

function stageSelect(id, value) {
  const current = String(value ?? '');
  return html`<select id="${safe(id)}" name="stage">
      ${join(
        [...COLUMNS.map((c) => ({ key: c.key, label: `${STAGE_LABEL[c.key]} (${c.column})` })), ...SETTLED].map(
          (opt) => html`<option value="${opt.key}" ${safe(current === opt.key ? 'selected' : '')}>${
              opt.label || STAGE_LABEL[opt.key]
            }</option>`
        )
      )}
    </select>`;
}

function rowForm(ctx, row, back) {
  const id = `u${String(row.id ?? normaliseBuyer(row.buyer))}`;
  return html`<form method="post" action="/money/upsell" class="stack-sm">
      <input type="hidden" name="_csrf" value="${ctx.csrfToken}">
      <input type="hidden" name="back" value="${back}">
      <div class="form-grid form-grid--two">
        <div class="field">
          <label for="${safe(id)}-buyer">Fiverr username <span class="req">*</span></label>
          <input id="${safe(id)}-buyer" name="buyer" value="${row.buyer ?? ''}" maxlength="120" required>
          <p class="field-hint">The join key. Changing it moves the row to a different buyer.</p>
        </div>
        <div class="field">
          <label for="${safe(id)}-gap">Gap</label>
          <input id="${safe(id)}-gap" name="gap" value="${row.gap ?? ''}" maxlength="120">
          <p class="field-hint">
            Buyer + gap is the key. Editing this creates a second row rather than renaming this one.
          </p>
        </div>
        <div class="field">
          <label for="${safe(id)}-business">Business</label>
          <input id="${safe(id)}-business" name="business" value="${row.business ?? ''}" maxlength="160">
        </div>
        <div class="field">
          <label for="${safe(id)}-sell">Sell first</label>
          <input id="${safe(id)}-sell" name="sell_first" value="${row.sell_first ?? ''}" maxlength="120">
        </div>
        <div class="field">
          <label for="${safe(id)}-stage">Stage</label>
          ${stageSelect(`${id}-stage`, row.stage)}
        </div>
        <div class="field">
          <label for="${safe(id)}-owner">Owner</label>
          <input id="${safe(id)}-owner" name="owner" value="${row.owner ?? ''}" maxlength="80">
          <p class="field-hint">Blank saves it under your name.</p>
        </div>
        <div class="field">
          <label for="${safe(id)}-result">Result</label>
          <input id="${safe(id)}-result" name="result" value="${row.result ?? ''}" maxlength="160">
        </div>
        <div class="field">
          <label for="${safe(id)}-extra">Extra earned</label>
          <input id="${safe(id)}-extra" name="extra_earned" inputmode="decimal"
                 value="${row.extra_earned ?? ''}">
          <p class="field-hint">Typed, never added to engine revenue. Blank stays blank, not zero.</p>
        </div>
      </div>
      <div class="field">
        <label for="${safe(id)}-next">Next step</label>
        <textarea id="${safe(id)}-next" name="next_step" rows="2">${row.next_step ?? ''}</textarea>
      </div>
      <label class="check-row">
        <input type="checkbox" name="asked" value="1" ${safe(Number(row.asked) === 1 ? 'checked' : '')}>
        <span class="check-label">
          The upsell was actually put to this buyer
          <span class="field-hint">This tick is the take-up denominator. Nothing else counts as an ask.</span>
        </span>
      </label>
      <div class="form-actions">
        <button class="btn" type="submit">Save this row</button>
        <span class="form-status">Saved against your name in the audit log.</span>
      </div>
    </form>`;
}

function newRowForm(ctx, back) {
  return html`<form method="post" action="/money/upsell" class="stack-sm">
      <input type="hidden" name="_csrf" value="${ctx.csrfToken}">
      <input type="hidden" name="back" value="${back}">
      <div class="form-grid form-grid--two">
        <div class="field">
          <label for="new-buyer">Fiverr username <span class="req">*</span></label>
          <input id="new-buyer" name="buyer" maxlength="120" required placeholder="dcleanglobe">
          <p class="field-hint">
            The username, not the display name — it is what joins this row to the order book.
          </p>
        </div>
        <div class="field">
          <label for="new-gap">Gap</label>
          <input id="new-gap" name="gap" maxlength="120" placeholder="No stationery set">
          <p class="field-hint">
            Buyer + gap is the key: saving the same pair again <b>updates</b> that row rather than adding
            a second one.
          </p>
        </div>
        <div class="field">
          <label for="new-business">Business</label>
          <input id="new-business" name="business" maxlength="160" placeholder="Cleaning franchise, UK">
        </div>
        <div class="field">
          <label for="new-sell">Sell first</label>
          <input id="new-sell" name="sell_first" maxlength="120" placeholder="Brand guidelines">
        </div>
        <div class="field">
          <label for="new-stage">Stage</label>
          ${stageSelect('new-stage', 'research')}
        </div>
        <div class="field">
          <label for="new-owner">Owner</label>
          <input id="new-owner" name="owner" maxlength="80">
          <p class="field-hint">Blank saves it under your name.</p>
        </div>
      </div>
      <div class="field">
        <label for="new-next">Next step</label>
        <textarea id="new-next" name="next_step" rows="2"
                  placeholder="What happens next, and when"></textarea>
      </div>
      <label class="check-row">
        <input type="checkbox" name="asked" value="1">
        <span class="check-label">
          The upsell has already been put to this buyer
          <span class="field-hint">Leave unticked until it has. This tick is the take-up denominator.</span>
        </span>
      </label>
      <p class="note note--neg">
        ${glyph('crit')} A row here is never a reason to message a buyer whose order is late or cold. Check
        the <a href="/orders?band=60%2B">open queue</a> first — and no upsell message carries a review
        request with it.
      </p>
      <div class="form-actions">
        <button class="btn" type="submit">Add to the board</button>
      </div>
    </form>`;
}

// ============================================================================
// 9. PROVENANCE — which store each figure on this page came from
// ============================================================================

function provenance(ctx, board) {
  return html`<div class="provenance-bar">
      <span>Revenue and money at rest — engine output, read from
        <code class="mono">data/latest-run.json</code>.</span>
      <span>The upsell board — typed here, stored in <code class="mono">upsell</code>, keyed on the Fiverr
        username.</span>
      <span>${board.ok
        ? html`Board readable.`
        : html`Board ${missing()} — the typed store did not answer.`}</span>
      <span>No figure on this page exists in both stores.</span>
    </div>`;
}

export default { render };
