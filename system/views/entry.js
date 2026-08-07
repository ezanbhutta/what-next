// views/entry.js, the profile's reach. What Fiverr showed, read from the board.
//
// WHAT THIS PAGE USED TO BE, AND WHY IT IS NOT THAT
//
//   A form. Fourteen boxes, filled in every morning by whoever was on shift,
//   writing to `daily_entry`. It was the only page in the hub whose job was to
//   put a number in rather than take one out.
//
//   Nobody is going to fill it in again. The hub stopped being a CSR tool, and
//   the same fourteen numbers are already typed every day into the impressions
//   board, which the team has been using since long before this form existed.
//   Two forms for one set of figures is not redundancy, it is a guarantee that
//   they will disagree, and the one nobody is watching is the one that goes
//   wrong quietly. So the form is gone and this page reads the board.
//
// THE NUMBER THIS PAGE CANNOT BE TRUSTED WITHOUT
//
//   The board is filled in by hand and it falls behind. It is not a feed. So
//   the as-of date is not a footnote here: it is in the masthead, in the
//   banner when the gap is real, and beside every total. A seven-day reach
//   figure whose seven days ended last month is a different claim from the one
//   the label makes, and nothing about the number itself says which it is.
//
// TWO GIGS, ONE ACCOUNT
//
//   The board keeps a row per GIG, and this account has two of them. Flows are
//   added across both; levels are taken from the main gig alone. `lib/
//   external.js` owns that fold and explains why averaging a nine-day-old
//   gig's rating of 0 into a 4.8 is the kind of wrong that reads as fine.
//
// NOTHING HERE WRITES. Not to the board, not to `daily_entry`, not to a sheet.

import {
  html,
  join,
  safe,
  missing,
  money,
  num,
  dateShort,
  dateTextOnly,
  glyph,
  pill,
  panelHead,
  banner,
  why,
  info,
  empty,
  rate,
  statCard,
  statGrid,
  MIN_SAMPLE,
} from './layout.js';

// ============================================================================
// 1. WINDOWS
// ============================================================================
//
// The windows end at the BOARD'S last day, not at today. With the board nine
// days behind, "the last 7 days" measured from today covers seven days it has
// nothing for, and the honest rendering of that is an empty page with a
// banner. That is true and useless. Measured from its own last day the same
// control answers the question the reader is actually asking, and the span is
// printed next to it so nobody has to assume which one it did.

export const WINDOWS = [
  { key: '7', days: 7, label: 'Last 7 days' },
  { key: '30', days: 30, label: 'Last 30 days' },
  { key: '90', days: 90, label: 'Last 90 days' },
];

const DEFAULT_WINDOW = '30';

// ============================================================================
// 2. READING WHAT THE LOADER HANDED OVER
// ============================================================================

/** rows, or null when the read failed. R2: those are different facts. */
function rowsOf(result) {
  if (!result) return null;
  if (Array.isArray(result)) return result;
  if (result.ok === false) return null;
  return Array.isArray(result.rows) ? result.rows : null;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// `at`, not `d`. Every view in this hub names ctx.data `d`, and tests/
// wiring.test.js finds the keys a view reads by scanning for `d.<something>`.
// A local Date called `d` makes that scan report `getTime` and `toISOString`
// as data the loader forgot to supply, which is a real failure pointing at
// nothing.
function shiftIso(iso, deltaDays) {
  if (!iso) return null;
  const at = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(at.getTime())) return null;
  at.setUTCDate(at.getUTCDate() + deltaDays);
  return at.toISOString().slice(0, 10);
}

// ============================================================================
// 3. DERIVED FIGURES, displayed, never stored
// ============================================================================
//
// `strictSum` is deliberately strict: a total with one blank half is MISSING,
// not the half that happens to be filled in. Treating a blank as 0 here would
// manufacture a day of zero directed orders out of a gap in the board.

function strictSum(a, b) {
  return a === null || b === null ? null : a + b;
}

function strictRatio(numerator, denominator) {
  if (numerator === null || denominator === null || denominator === 0) return null;
  return numerator / denominator;
}

/**
 * Add one column across days, and say how many days it covers.
 *
 * THIS RETURNED MISSING AT FIRST, AND THAT WAS THE WRONG ANSWER.
 *
 * The rule everywhere else in this hub is that a total with one unknown part
 * is unknown, because a smaller number wearing a bigger label is the one
 * arithmetic error nothing on the page shows. That is right for a day, where
 * the parts are two gigs of one figure.
 *
 * Over a month it is not. One blank cell in one column on one day turned every
 * headline on the page to MISSING: 105,324 real impressions across 26 days
 * thrown away to avoid printing them under a label that says 30. The reader
 * learns nothing, and the figure they cannot see is the one they came for.
 *
 * So the denominator comes with the number instead of replacing it. "105,324
 * across 26 of 30 days" is true, and it is the same protection: whatever else
 * a reader does with that, they cannot mistake it for a complete month.
 *
 * `n` is days that carried the column, NOT days on the board. A day the board
 * holds with this cell blank counts towards neither.
 */
function columnTotal(rows, key) {
  let total = null;
  let n = 0;
  for (const r of rows) {
    const v = numberOrNull(r[key]);
    if (v === null) continue;
    total = (total ?? 0) + v;
    n += 1;
  }
  return { total, n };
}

/** The days a window figure covers, for the line under it. Empty when it
 *  covers all of them, so the common case stays quiet. */
function coverageNote(got, windowDays) {
  if (!got || got.total === null) return '';
  return got.n === windowDays ? '' : `${got.n} of ${windowDays} days`;
}

function tickerCard(label, got, fmt, windowDays) {
  return {
    label,
    value: got.total === null ? missing() : fmt(got.total),
    sub: coverageNote(got, windowDays),
  };
}

/** How a window total prints: the figure, and the days it actually covers. */
function totalCard(field, got, windowDays) {
  const complete = got.n === windowDays;
  return statCard(
    field.label,
    got.total === null ? missing() : field.kind === 'money' ? money(got.total) : num(got.total),
    {
      sub:
        got.total === null
          ? 'No day in this window carried it'
          : complete
            ? `All ${windowDays} days`
            : `Across ${got.n} of ${windowDays} days`,
      tone: complete || got.total === null ? '' : 'warn',
    }
  );
}

/**
 * Every rate this page states, from a set of raw figures.
 *
 * R3 lives in `rate()`: under MIN_SAMPLE, or wider than 15 points, it comes
 * back as an interval on a hatched track rather than a number with a bar. Four
 * orders out of five is not "80%".
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
    ordersTaken,
    valueTaken,
    cards: [
      { label: 'Click-through', ...ctrCell },
      {
        label: 'Orders taken',
        value: ordersTaken === null ? missing() : num(ordersTaken),
        note: 'Organic and directed added',
      },
      {
        label: 'Value taken',
        value: valueTaken === null ? missing() : money(valueTaken),
        note: 'Organic and directed added',
      },
      {
        label: 'Directed share',
        ...(v.directed_orders === null || ordersTaken === null || !share.ok
          ? { value: missing(), note: 'Both order counts needed' }
          : rateCell(share, 'orders')),
      },
      {
        label: 'AOV taken',
        value: aovTaken === null ? missing() : money(aovTaken),
        note: ordersTaken === null ? 'Value and orders needed' : `Mean across ${ordersTaken} orders`,
      },
      {
        label: 'AOV completed',
        value: aovDone === null ? missing() : money(aovDone),
        note:
          v.orders_completed === null
            ? 'Completed value and count needed'
            : `Mean across ${v.orders_completed} completed`,
      },
      {
        label: 'Completion ratio',
        value: completion === null ? missing() : html`${num(completion, { dp: 2 })}×`,
        note: 'Completed divided by taken. It can exceed 1, so it is not a proportion and no interval applies.',
      },
      {
        label: 'Cancellation rate',
        ...(v.cancellations === null || cancelDenominator === null || !cancel.ok
          ? { value: missing(), note: 'Completed and cancelled both needed' }
          : rateCell(cancel, 'closed orders')),
      },
    ],
  };
}

/** The raw columns a reach row carries, in the order they belong on screen. */
const RAW_FIELDS = [
  { key: 'impressions', label: 'Impressions', kind: 'count' },
  { key: 'clicks', label: 'Clicks', kind: 'count' },
  { key: 'organic_orders', label: 'Organic orders', kind: 'count' },
  { key: 'organic_value', label: 'Organic value', kind: 'money' },
  { key: 'directed_orders', label: 'Directed orders', kind: 'count' },
  { key: 'directed_value', label: 'Directed value', kind: 'money' },
  { key: 'orders_completed', label: 'Orders completed', kind: 'count' },
  { key: 'completed_value', label: 'Completed value', kind: 'money' },
  { key: 'inquiries_received', label: 'Inquiries', kind: 'count' },
  { key: 'cancellations', label: 'Cancellations', kind: 'count' },
  { key: 'cancelled_value', label: 'Cancelled value', kind: 'money' },
];

/** Standing figures. Never added up, here or anywhere: see REACH_LEVELS. */
const LEVEL_FIELDS = [
  { key: 'orders_in_queue', label: 'In the queue' },
  { key: 'total_reviews', label: 'Reviews, lifetime' },
  { key: 'success_score', label: 'Success score' },
  { key: 'profile_rating', label: 'Profile rating', dp: 2 },
];

const cell = (row, field) => {
  const v = numberOrNull(row[field.key]);
  if (v === null) return missing();
  return field.kind === 'money' ? money(v) : num(v);
};

// ============================================================================
// 4. THE PAGE
// ============================================================================

export function render(ctx) {
  const d = ctx.data || {};
  const days = rowsOf(d.days);
  const asOf = d.asOf || { ok: false, date: null, daysOld: null, notice: null };
  const gigs = rowsOf(d.gigs);
  const windowKey = WINDOWS.some((w) => w.key === String(d.window)) ? String(d.window) : DEFAULT_WINDOW;
  const windowDef = WINDOWS.find((w) => w.key === windowKey);

  // ---- the board is unreachable --------------------------------------------
  //
  // Every figure on this page comes from one store. With that store down there
  // is nothing to show and nothing to derive, and a page of empty panels would
  // read as a quiet month rather than as an outage.
  if (days === null) {
    return {
      title: 'The impressions board cannot be read',
      kicker: 'Reach',
      ticker: [],
      html: html`${banner(
        'crit',
        'The impressions board did not answer.',
        // The reason comes from the read that failed, not from a `notice` the
        // loader has to remember to mirror alongside it. A second copy of the
        // reason is a second thing to forget, and forgetting it renders as an
        // outage with no cause printed.
        html`${d.days?.notice || asOf.notice || 'No reason was given.'} Nothing on this page can be shown until it
          does. Whatever the team has entered is still safely in the board; this hub only reads it.`
      )}
      ${empty('No reach figures could be loaded.')}`,
    };
  }

  const latest = days[0] || null;
  const latestIso = latest ? String(latest.entry_date) : null;

  // ---- how far behind the board is -----------------------------------------
  //
  // Two days is the working tolerance, not a guess: Fiverr publishes a day's
  // figures around midday the next day, so the board is legitimately one day
  // behind at all times and briefly two. Past that it is not lag, it is a gap
  // nobody has filled in, and it is the first thing on the page.
  const stale = asOf.ok && asOf.daysOld !== null && asOf.daysOld > 2;
  const staleBanner = !asOf.ok
    ? banner(
        'warn',
        'The board would not say how current it is.',
        html`${asOf.notice || 'The freshness check failed.'} The figures below may be right. Nothing here
          can confirm how recent they are, so read them as undated.`
      )
    : stale
      ? banner(
          'warn',
          html`These figures stop on ${dateShort(asOf.date, { year: true })}, ${num(asOf.daysOld)} days ago.`,
          html`Nothing below describes the last ${num(asOf.daysOld)} days, whatever a window is labelled.
            The board is filled in by hand and it has not been filled in since. Orders and money on the
            other pages come from the order sheet and are current to yesterday, so the two will not agree
            and should not be read against each other until this catches up.`
        )
      : '';

  // ---- windows --------------------------------------------------------------

  const spanFrom = latestIso ? shiftIso(latestIso, -(windowDef.days - 1)) : null;
  const inWindow = spanFrom ? days.filter((r) => String(r.entry_date) >= spanFrom) : [];
  const spanLabel =
    spanFrom && latestIso
      ? `${dateTextOnly(spanFrom)} to ${dateTextOnly(latestIso, { year: true })}`
      : 'no days';

  const windowBar = html`<div class="toolbar">
      <div class="segment">
        ${join(
          WINDOWS.map(
            (w) => html`<a href="/entry?window=${safe(w.key)}"
                ${safe(w.key === windowKey ? 'aria-current="true"' : '')}>${w.label}</a>`
          )
        )}
      </div>
      <span class="count">${spanLabel} · ${num(inWindow.length)} of ${num(windowDef.days)} days filled in</span>
    </div>`;

  // ---- the latest day -------------------------------------------------------

  const latestValues = latest
    ? Object.fromEntries([...RAW_FIELDS, ...LEVEL_FIELDS].map((f) => [f.key, numberOrNull(latest[f.key])]))
    : {};
  const latestDerived = derived(latestValues);

  const latestPanel = html`<section class="panel">
      ${panelHead(
        latestIso
          ? html`The last day the board has, ${dateShort(latestIso, { year: true })}`
          : 'The last day the board has',
        latestIso ? 'typed' : 'missing',
        latestIso ? `Impressions board · ${latest.gigs?.length === 1 ? '1 gig' : `${latest.gigs?.length ?? 0} gigs`}` : 'No day on the board',
        'One day, exactly as the team entered it, with the rates this hub works out from it. Nothing on this card is stored.'
      )}
      ${!latest
        ? empty('The board holds no day at all for this account.')
        : html`${statGrid(
              RAW_FIELDS.map((f) => statCard(f.label, cell(latest, f)))
            )}
            ${statGrid(latestDerived.cards.map((c) => statCard(c.label, c.value, { sub: c.note })))}
            <div class="statgrid" style="margin-top:18px">
              ${join(
                LEVEL_FIELDS.map((f) => {
                  const v = numberOrNull(latest[f.key]);
                  return statCard(f.label, v === null ? missing() : num(v, { dp: f.dp || 0 }), {
                    sub: 'Standing figure, never added up',
                  });
                })
              )}
            </div>`}
      ${why(
        'Why the standing figures sit apart',
        html`<p>
            Impressions, clicks and orders are things that <em>happened</em> during the day, so two days of
            them add up and so do two gigs. The four below are what the account stood at when the day
            ended. <em>Reviews, lifetime</em> reads 1,546 one day and 1,553 the next because it is a running
            total, and a week of it added together comes to about eleven thousand reviews, which this
            business has never had.
          </p>
          <p>
            Nothing in a row says which kind a column is, and the wrong sum looks every bit as reasonable
            as the right one. So the two kinds are separated in
            <code class="mono">lib/external.js</code> and the separation is carried through to here.
          </p>`
      )}
    </section>`;

  // ---- the window -----------------------------------------------------------

  const totals = Object.fromEntries(RAW_FIELDS.map((f) => [f.key, columnTotal(inWindow, f.key)]));
  const gapDays = windowDef.days - inWindow.length;

  // A RATE ACROSS A WINDOW IS ONLY HONEST WHEN BOTH SIDES COVER THE SAME DAYS.
  //
  // Click-through from 26 days of impressions over 24 days of clicks is not a
  // click-through rate, it is a ratio of two different months, and it lands
  // between the plausible ones so nothing about it looks wrong. So each
  // derived figure is computed from the totals only where its inputs agree on
  // their day count, and reads MISSING where they do not.
  const agreed = (...keys) => {
    const ns = keys.map((k) => totals[k]?.n ?? 0);
    return ns.every((n) => n === ns[0] && n > 0);
  };
  const forRates = Object.fromEntries(
    RAW_FIELDS.map((f) => [f.key, totals[f.key].total])
  );
  if (!agreed('clicks', 'impressions')) { forRates.clicks = null; forRates.impressions = null; }
  if (!agreed('organic_orders', 'directed_orders')) {
    forRates.organic_orders = null;
    forRates.directed_orders = null;
  }
  if (!agreed('organic_value', 'directed_value')) {
    forRates.organic_value = null;
    forRates.directed_value = null;
  }
  if (!agreed('orders_completed', 'cancellations')) forRates.cancellations = null;
  const windowDerived = derived(forRates);

  const windowPanel = html`<section class="panel">
      ${panelHead(
        html`${windowDef.label}, ${num(inWindow.length)} ${inWindow.length === 1 ? 'day' : 'days'} on the board`,
        inWindow.length ? 'typed' : 'missing',
        inWindow.length ? `Impressions board · ${spanLabel}` : 'Nothing in this window',
        'Totals add strictly: one day missing a column makes that column MISSING for the window rather than a smaller number wearing a bigger label.'
      )}
      ${!inWindow.length
        ? empty(`The board holds no day between ${spanLabel}.`)
        : html`${gapDays > 0
              ? html`<p class="note note--warn">
                  ${glyph('warn')} ${num(gapDays)} of these ${num(windowDef.days)} days ${gapDays === 1 ? 'is' : 'are'}
                  not on the board. Any column blank on one of the filled-in days reads MISSING for the whole
                  window rather than being added up around the gap.
                </p>`
              : ''}
            ${statGrid(RAW_FIELDS.map((f) => totalCard(f, totals[f.key], windowDef.days)))}
            ${statGrid(windowDerived.cards.map((c) => statCard(c.label, c.value, { sub: c.note })))}`}
    </section>`;

  // ---- day by day -----------------------------------------------------------

  const tablePanel = html`<section class="panel">
      ${panelHead(
        html`Day by day, ${num(inWindow.length)}`,
        inWindow.length ? 'typed' : 'missing',
        inWindow.length ? 'Impressions board' : 'Nothing in this window',
        'Newest first. A day the board does not hold is not a row here, because it is not a day of zero reach.'
      )}
      ${!inWindow.length
        ? empty('No day to list.')
        : html`<div class="tablewrap tablewrap--capped">
              <table class="table table--wide">
                <thead>
                  <tr>
                    <th>Day</th>
                    ${join(RAW_FIELDS.map((f) => html`<th class="r">${f.label}</th>`))}
                    <th class="r">Rating</th>
                  </tr>
                </thead>
                <tbody>
                  ${join(
                    inWindow.map((r) => {
                      const rating = numberOrNull(r.profile_rating);
                      return html`<tr>
                        <td><span class="cell-name">${dateShort(r.entry_date)}</span></td>
                        ${join(RAW_FIELDS.map((f) => html`<td class="r cell-figure">${cell(r, f)}</td>`))}
                        <td class="r cell-figure">${rating === null ? missing() : num(rating, { dp: 2 })}</td>
                      </tr>`;
                    })
                  )}
                </tbody>
              </table>
              <p class="tablehint" aria-hidden="true">Scroll sideways for more columns →</p>
            </div>`}
    </section>`;

  // ---- the gig split --------------------------------------------------------

  const gigPanel = html`<section class="panel">
      ${panelHead(
        html`Gigs on this account, ${gigs === null ? missing() : num(gigs.length)}`,
        gigs === null ? 'missing' : 'typed',
        gigs === null ? 'Gig list unreadable' : 'Impressions board',
        'Read from the board rather than kept here, so a gig launched next month arrives on its own instead of going missing from every total.'
      )}
      ${gigs === null
        ? html`<p class="note note--neg">
            ${glyph('crit')} The board's gig list could not be read, so the totals above may be one gig short
            and there is no way to tell from here which.
          </p>`
        : !gigs.length
          ? empty('The board lists no gig under this account.')
          : html`<ul class="plainlist">
              ${join(
                gigs.map((g) => {
                  const contributed = inWindow.reduce((acc, day) => {
                    const part = (day.gigs || []).find((p) => p.gig === g.name);
                    const v = part ? numberOrNull(part.impressions) : null;
                    return v === null ? acc : acc + v;
                  }, 0);
                  return html`<li>
                    <strong>${g.name}</strong>
                    ${g.main ? pill('ok', 'main gig') : pill('info', 'second gig')}
                    ${g.active ? '' : pill('warn', 'inactive')}
                    <span class="caption"> ${num(contributed)} impressions in this window</span>
                  </li>`;
                })
              )}
            </ul>`}
      ${why(
        'Why the rating is not an average of the two',
        html`<p>
            Reach adds across gigs. A rating does not. The second gig here is days old and the board
            records its rating and review count as <code class="mono">0</code>, which is the import's way of
            writing <em>none yet</em>. Averaged into the main gig's 4.8 that gives 2.4, and added to its
            review count it gives a number of reviews nobody has. So flows are added and levels are taken
            from the main gig alone, never combined.
          </p>`
      )}
    </section>`;

  // ---- what the page leads with --------------------------------------------

  const title = !latest
    ? 'The board holds nothing for this account'
    : stale
      ? `Reach stops ${asOf.daysOld} days ago, on ${dateTextOnly(asOf.date, { year: true })}`
      : `${latestDerived.ordersTaken === null ? 'Reach' : `${latestDerived.ordersTaken} orders`} on ${dateTextOnly(latestIso, { year: true })}`;

  return {
    title,
    kicker: `Reach · impressions board · ${spanLabel}`,
    ticker: [
      tickerCard('Impressions', totals.impressions, num, windowDef.days),
      tickerCard('Clicks', totals.clicks, num, windowDef.days),
      {
        label: 'Orders taken',
        value: windowDerived.ordersTaken === null ? missing() : num(windowDerived.ordersTaken),
        sub: coverageNote(totals.organic_orders, windowDef.days),
      },
      {
        label: 'Value taken',
        value: windowDerived.valueTaken === null ? missing() : money(windowDerived.valueTaken),
        sub: coverageNote(totals.organic_value, windowDef.days),
      },
      tickerCard('Inquiries', totals.inquiries_received, num, windowDef.days),
      {
        label: 'Board as of',
        value: asOf.date ? dateShort(asOf.date) : missing(),
        sub: asOf.daysOld === null ? '' : asOf.daysOld === 0 ? 'today' : `${asOf.daysOld} days ago`,
      },
    ],
    html: html`${staleBanner}
      ${windowBar}
      ${latestPanel}
      ${windowPanel}
      ${tablePanel}
      ${gigPanel}
      <div class="provenance-bar">
        <span>Every figure on this page is typed by the team into the impressions board, and read from it
          here. This hub does not write to it, and the form that used to live on this page is gone: two
          places to type one number is a guarantee they will disagree.</span>
        <span>Windows end on the board's own last day rather than on today, so a label means the days it
          says. The span is printed beside the control.</span>
        <span>Rates follow the house rule: below ${String(MIN_SAMPLE)}, or wider than 15 points, they are an
          interval on a hatched track and never a bar.</span>
      </div>`,
  };
}

export default render;
