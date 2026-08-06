// views/messages.js, what this buyer was already told, and what may be said next.
//
// THE ORDER OF THIS PAGE IS THE POINT OF THIS PAGE
//
// Every other section answers a question. This one hands someone a sentence to
// send, which means it is the only section that can do damage by being read
// correctly. So nothing on it is offered before the triage that decides whether
// it may be offered at all:
//
//     1. who this buyer is, and what is open
//     2. the triage, we owe work / they owe a reply / dead
//     3. what may be sent today, in one line
//     4. only then, the talk playbook
//
// A "just checking in" note to a buyer who is waiting on US tells them, in
// writing and with a timestamp, that we have not started. That is how a late
// order becomes a dispute. The only bucket a check-in belongs in is *they owe
// a reply*.
//
// R6. THE REVIEW ASK, AND WHY IT IS REFUSED OUT LOUD
//
// A review ask on a late delivery is the most reliable way to turn a private
// three-star into a public one. So a template that asks for a review is NOT
// silently dropped from the library when the buyer is late or cold, silently
// dropping it teaches nobody, and the next person writes the message by hand.
// It is shown, marked, and the refusal states the order, its age and the
// reason. `reviewGate()` is the whole rule and it fails CLOSED on BOTH of its
// sources: if the engine run cannot be read, or the flag store cannot be read,
// the ask is refused, because "we cannot see a late order" is not "there is no
// late order" and "we cannot see a flag" is not "nobody flagged them".
//
// Every open order has to clear the gate, not just the ones in the two buckets
// somebody remembered. A flag, an unrecorded stage and an unmapped status are
// all refusals, because each of them means the same thing: we cannot show that
// the work landed well, and that is the only ground a review ask stands on.
//
// WHAT THE CSR ACTUALLY BROWSES: THE OWNER'S OWN PLAYBOOK
//
// The `talk` table is Ezan's Client Talk Hub, seeded from his own file and
// edited by him from inside this page. A card is a situation; a turn inside it
// is one exchange: what the buyer says, and the line that goes back. Two axes,
// because a CSR arrives at this page from two different directions:
//
//   by GROUP  questions to ask · upgrade moments · when they say no ·
//             handle these carefully
//   by STAGE  before the order · order starts · while working · they approve ·
//             after delivery
//
// Both are links, not JavaScript. The state of this page is in its URL, so a
// CSR can send another CSR the exact view they are looking at.
//
// THE TWO STORES, AND WHICH HALF FAILS
//
//   data/            the order book, the inquiry log, the engine's open-order
//                    and quote blocks. Read from disk. Survives a DB outage.
//   client_note      every note, send and flag a human typed here. MySQL.
//   talk             the playbook. MySQL, owner-editable.
//
// If MySQL is unreachable the history and the playbook are MISSING and the
// compose forms are closed, a compose box that cannot save is worse than no
// compose box. The triage above them still works, because it is engine data.
//
// R2 · nothing renders 0 for an unknown.  R7 · the figure leads, always.

import {
  html,
  join,
  safe,
  missing,
  money,
  num,
  days,
  dateShort,
  dateTimeShort,
  glyph,
  pill,
  panelHead,
  why,
  info,
  empty,
  rate,
} from './layout.js';
import { MISSING, isMissing, pick } from '../lib/data.js';
import { normaliseBuyer } from '../lib/reconcile.js';
import { applyDueDates } from '../lib/duedates.js';

// ============================================================================
// 1. SMALL SHARED PIECES
// ============================================================================

function buyerHref(name) {
  return `/messages/${encodeURIComponent(String(name ?? ''))}`;
}

function clientHref(name) {
  return `/clients/${encodeURIComponent(String(name ?? ''))}`;
}

/** The identity of one order across the engine's recovery block and the book.
 *  JSON, not a delimiter: no separator character is safe against a free-text
 *  project name somebody typed into a sheet. */
function orderKey(row) {
  return JSON.stringify([row.client ?? null, row.order_date ?? null, row.project ?? null]);
}

/** Whole days between two 'YYYY-MM-DD' strings, or null if either is unusable. */
function daysBetween(fromIso, toIso) {
  const parse = (v) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? ''));
    return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  };
  const a = parse(fromIso);
  const b = parse(toIso);
  if (a === null || b === null) return null;
  return Math.round((b - a) / 86_400_000);
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// ============================================================================
// 2. THE TRIAGE, an open order is not one thing
// ============================================================================

const BUCKETS = {
  us: {
    key: 'us',
    label: 'We owe work',
    glyph: 'crit',
    sub: 'in progress or in revision, the buyer has paid and is waiting on us',
    send: 'Deliver, or send a dated commitment. Never a nudge.',
  },
  them: {
    key: 'them',
    label: 'They owe a reply',
    glyph: 'warn',
    sub: 'delivered, and the buyer has gone quiet',
    send: 'A short, specific check-in. This is the only bucket one belongs in.',
  },
  dead: {
    key: 'dead',
    label: 'Dead',
    glyph: 'idle',
    sub: 'a human looked and called it, flagged in this hub',
    send: 'Nothing. Somebody already closed this by name.',
  },
  unknown: {
    key: 'unknown',
    label: 'Stage not recorded',
    glyph: 'idle',
    sub: 'the order book carries no status for this one',
    send: 'Nothing until somebody establishes what stage it is at.',
  },
};

const OWES_BY_STATUS = {
  in_progress: 'us',
  revision: 'us',
  delivered: 'them',
};

const STAGE_LABEL = {
  in_progress: 'In progress',
  revision: 'In revision',
  delivered: 'Delivered',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

/**
 * Sort this buyer's open orders into the three buckets.
 *
 * `flagged` is the ONLY source of "dead", nothing in the order book means
 * dead, so nothing here infers it. When the flag store is unreachable
 * `flagged` is null and the dead bucket is unknown rather than empty.
 */
function triage(openRows, bookRows, flagged) {
  const book = new Map();
  if (Array.isArray(bookRows)) for (const r of bookRows) book.set(orderKey(r), r);

  return openRows.map((o) => {
    const match = book.get(orderKey(o)) || null;
    // A recovery amount of 0.0 is ambiguous, either a free order or a null the
    // recovery block flattened. With the book in hand, "priced" is what the
    // book says; without it, an ambiguous figure is MISSING, never $0.
    const priced = match ? Number.isFinite(match.amount) : Number.isFinite(o.amount) && o.amount !== 0;
    // The figure to SHOW is the one that answered "priced". Asking the book and
    // then printing the recovery row's flattened 0.0 is how a $450 order renders
    // as $0 and contributes $0 to the open value, a fabricated number wearing
    // the face of a real one, produced by the very lookup that exists to
    // disambiguate it.
    const amount = match && Number.isFinite(match.amount) ? match.amount : o.amount;
    const owes = flagged === true ? 'dead' : OWES_BY_STATUS[o.status] || 'unknown';
    return {
      ...o,
      matched: match !== null,
      book_available: Array.isArray(bookRows),
      priced,
      shown_amount: priced ? amount : MISSING,
      // The same figure as a plain number, for the totals. Null when unpriced,
      // so nothing downstream can add an unknown in as a zero.
      priced_amount: priced ? amount : null,
      owes,
    };
  });
}

/** One line: what may be sent to this buyer today. Ordered by severity. */
function verdict({ rows, coldQuotes, flagsKnown }) {
  const us = rows.filter((r) => r.owes === 'us');
  const them = rows.filter((r) => r.owes === 'them');
  const dead = rows.filter((r) => r.owes === 'dead');
  const unknown = rows.filter((r) => r.owes === 'unknown');

  if (us.length) {
    return {
      tone: 'crit',
      short: 'Deliver, do not check in',
      long: html`${num(us.length)} open order${us.length === 1 ? '' : 's'} ${us.length === 1 ? 'is' : 'are'}
        waiting on <b>us</b>. A "just checking in" note here tells a buyer who has already paid, in writing
        and with a timestamp, that we have not started. Send work, or send a dated commitment.`,
    };
  }
  if (them.length) {
    return {
      tone: 'warn',
      short: 'A check-in is the right message',
      long: html`${num(them.length)} delivered order${them.length === 1 ? '' : 's'} with no reply. This is
        the one bucket a check-in belongs in, short, specific, and about the work rather than about us.`,
    };
  }
  if (unknown.length) {
    return {
      tone: 'idle',
      short: 'Establish the stage first',
      long: html`${num(unknown.length)} open order${unknown.length === 1 ? '' : 's'} carr${unknown.length === 1 ? 'ies' : 'y'}
        no status in the order book. Nothing can be sorted into a bucket, so nothing should be sent yet.`,
    };
  }
  if (dead.length) {
    return {
      tone: 'idle',
      short: 'Nothing, this was called dead',
      long: html`Every open order here is flagged dead by a person in this hub. Re-opening it is a decision
        somebody makes deliberately, not a message that goes out on a list.`,
    };
  }
  if (coldQuotes.length) {
    return {
      tone: 'warn',
      short: 'A quote follow-up',
      long: html`${num(coldQuotes.length)} quote${coldQuotes.length === 1 ? '' : 's'} never became an order.
        A follow-up on a quote is a sales message, not a service message, and it is never a review ask.`,
    };
  }
  return {
    tone: 'ok',
    short: flagsKnown ? 'Nothing is owed here' : 'Nothing open that we can see',
    long: flagsKnown
      ? html`No open order and no cold quote. Anything sent to this buyer today is a choice, not a debt.`
      : html`No open order and no cold quote, but the flag store is unreachable, so whether anybody had
          already closed this buyer out is ${missing()}.`,
  };
}

// ============================================================================
// 3. R6. THE REVIEW GATE. Fails closed, states its reason.
// ============================================================================

/**
 * Does this reply ask for a review?
 *
 * Deliberately broad. A false positive costs one paragraph of explanation on a
 * template that was safe anyway; a false negative puts a review ask in front of
 * a buyer whose order is 268 days late. Those are not comparable costs.
 */
const REVIEW_ASK =
  /\breviews?\b|\brating\b|\brate\s+(?:us|your|the|this|our)\b|\b\d\s*stars?\b|\bfive[-\s]star\b|\bleave\s+(?:us\s+)?(?:a|your)\b|\bfeedback\s+on\s+fiverr\b/i;

/**
 * The one test, applied to whatever text is about to be offered.
 *
 * It takes the pieces rather than a row, because the same rule has to cover a
 * playbook turn (a line and its instruction) and a card's own guidance, and
 * those are different shapes. A per-shape copy of this regex is a second rule
 * that would agree with the first only on the day it was written.
 */
function asksForReview(...parts) {
  return REVIEW_ASK.test(parts.filter(Boolean).join(' · '));
}

/**
 * May a review request go to this buyer at all?
 *
 * Returns `{ allowed, reasons: [] }`. Every refusal carries the evidence that
 * produced it, an order, an age, a date, because "no" without a number is
 * indistinguishable from a preference.
 *
 * It fails CLOSED on purpose. An unreadable engine run is not "nothing is
 * late"; it is "we cannot see what is late", and the two must not produce the
 * same answer.
 */
function reviewGate({ runOk, quotesKnown, rows, coldQuotes, staleAfter, lastDeliveryAge, hasAnyRecord, flagged }) {
  const reasons = [];

  if (!runOk) {
    reasons.push({
      what: 'The engine run cannot be read',
      detail: html`Without <code class="mono">recovery.open_orders</code> there is no way to tell whether
        this buyer has a late order. That is ${missing()}, not "nothing is late", and a review ask is not
        sent on a MISSING.`,
    });
    return { allowed: false, reasons };
  }

  // The quotes block, on the same terms. `runOk` only vouches for
  // open_orders; the cold-quote check below reads recovery.quotes, and an
  // absent quotes block turned into an empty array reads as "no cold
  // quotes" when the truth is "we cannot tell".
  if (!quotesKnown) {
    reasons.push({
      what: 'Whether this buyer has a dead quote cannot be read',
      detail: html`<code class="mono">recovery.quotes</code> is ${missing()}, so whether this buyer was
        quoted and went cold is unknowable. That is not "no cold quotes", and a review ask is not sent on
        a MISSING.`,
    });
    return { allowed: false, reasons };
  }

  // The flag store, on the same terms as the engine run.
  //
  // A flag is the hub's only record that a person looked at this buyer and
  // called them dead: a dispute, a refund, a buyer nobody wants to hear from
  // again. It has to be read BEFORE the buckets, because `triage()` rewrites
  // every open row's bucket to 'dead' as soon as a flag exists. That emptied
  // the `us` bucket this gate was reading, so flagging a disputed buyer moved
  // the gate from refused to permitted: the act of recording that a buyer is a
  // problem was what unlocked the review ask.
  if (flagged === null) {
    reasons.push({
      what: 'Whether this buyer was closed out cannot be read',
      detail: html`The flag store did not answer, so whether somebody already called this buyer dead is
        ${missing()}. That is not "nobody flagged them", and a review ask is not sent on a MISSING.`,
    });
    return { allowed: false, reasons };
  }

  if (flagged === true) {
    reasons.push({
      what: 'Somebody flagged this buyer in the hub',
      detail: html`A flag is a person recording, by name and with a time, that this buyer is dead: a
        dispute, a refund, or a relationship nobody wants reopened. Asking that buyer to rate us in public
        is the worst available use of the one message they might still read.`,
    });
  }

  if (!hasAnyRecord) {
    reasons.push({
      what: 'No order for this buyer anywhere',
      detail: html`Neither the order book nor the inquiry log carries this username. There is no delivery
        to attach a review request to.`,
    });
  }

  // Past a date we actually promised. The strongest refusal on this page, and
  // it fires whatever the order's age is: an order promised in five days and
  // still open on day six is late, sits nowhere near the stale band, and is
  // exactly the buyer a review ask must not reach.
  const overdue = rows.filter((r) => r.due?.late === true);
  if (overdue.length) {
    const worst = overdue.reduce((a, r) => (toNumber(r.due.days) > toNumber(a.due.days) ? r : a), overdue[0]);
    reasons.push({
      what: html`${num(overdue.length)} order${overdue.length === 1 ? '' : 's'} past the date we promised`,
      detail: html`<b>${worst.project ?? missing()}</b> was promised for ${dateShort(worst.due.due)} and is
        ${days(worst.due.days)} past it. This is the one refusal backed by something we told the buyer
        ourselves; asking them to rate us in public while it is outstanding is how a private three-star
        becomes a public one.`,
    });
  }

  const stale = rows.filter((r) => r.stale === true);
  if (stale.length) {
    const oldest = stale.reduce((a, r) => (toNumber(r.age_days) > toNumber(a.age_days) ? r : a), stale[0]);
    reasons.push({
      what: html`${num(stale.length)} order${stale.length === 1 ? '' : 's'} open past ${days(staleAfter)}`,
      detail: html`The oldest is <b>${oldest.project ?? missing()}</b>, open ${days(oldest.age_days)} in
        status <em>${STAGE_LABEL[oldest.status] || String(oldest.status ?? '').replace(/_/g, ' ')}</em>.
        That is age rather than a missed promise, and it is still a refusal: a review ask on work that has
        been sitting this long is the most reliable way to turn a private three-star into a public one.`,
    });
  }

  const us = rows.filter((r) => r.owes === 'us');
  if (us.length) {
    reasons.push({
      what: html`${num(us.length)} order${us.length === 1 ? '' : 's'} still waiting on us`,
      detail: html`There is nothing finished to review. Asking now asks a buyer to rate work they have not
        received.`,
    });
  }

  // The stage-not-recorded bucket, on the same footing as the other two.
  //
  // `OWES_BY_STATUS` maps three statuses. Anything else, a cancelled order, a
  // blank status, or a spelling the order book starts using next month, lands
  // in `unknown`, and the gate used to walk straight past it: `verdict()` said
  // "establish the stage first" while this said "a review request is
  // permitted", on the same page, about the same order. An order whose stage
  // nobody can name is not evidence that the work landed well.
  const unknown = rows.filter((r) => r.owes === 'unknown');
  if (unknown.length) {
    reasons.push({
      what: html`${num(unknown.length)} open order${unknown.length === 1 ? '' : 's'} with no stage recorded`,
      detail: html`The order book carries no status this page can place for
        ${unknown.length === 1 ? 'it' : 'them'}, so whether the work landed is ${missing()}. A review ask
        needs a finished job behind it, and this cannot be shown to be one.`,
    });
  }

  if (coldQuotes.length) {
    const oldest = coldQuotes.reduce(
      (a, q) => (toNumber(q.age_days) > toNumber(a.age_days) ? q : a),
      coldQuotes[0]
    );
    reasons.push({
      what: html`${num(coldQuotes.length)} quote${coldQuotes.length === 1 ? '' : 's'} that never became an order`,
      detail: html`The oldest was quoted ${days(oldest.age_days)} ago at ${money(oldest.quoted)}. A cold
        lead has bought nothing and has nothing to review; the ask reads as a mistake and costs the
        follow-up.`,
    });
  }

  // The ask needs a delivery it can point at AND a date for it. A null age is
  // not a recent delivery, it is no answer, and the whole question this branch
  // asks is whether the work is recent enough to be worth reviewing.
  //
  // Testing `lastDeliveryAge !== null` first is what made the gate fail OPEN in
  // the two cases it most needed to close: a buyer whose only order carries no
  // usable date (7 order rows in the book have no order date and 61 no delivery
  // date), and a buyer who inquired and never ordered at all, neither has a
  // stale order, an unfinished one or a cold quote, so every other test passed
  // them and the ask was offered on an absent number.
  if (!stale.length && !us.length) {
    if (lastDeliveryAge === null) {
      reasons.push({
        what: 'No dated delivery to attach a review to',
        detail: html`Nothing in the order book under this username carries a date this page can read, so how
          long ago the work landed is ${missing()}. A review ask is not sent on a MISSING, and if there is
          no order here at all, there is nothing delivered to be reviewed.`,
      });
    } else if (lastDeliveryAge > toNumber(staleAfter)) {
      reasons.push({
        what: html`Last delivery here was ${days(lastDeliveryAge)} ago`,
        detail: html`A review request that arrives long after the work is a cold ask. It reminds the buyer of
          a job they have stopped thinking about and invites them to score it from memory.`,
      });
    }
  }

  return { allowed: reasons.length === 0, reasons };
}

// ============================================================================
// 4. TEMPLATES, {username} substituted live
// ============================================================================

const PLACEHOLDER = /\{([a-z0-9_]+)\}/gi;

/**
 * Render a template body with `{username}` filled in.
 *
 * Every placeholder is marked, filled or not. An unfilled `{price}` that looks
 * like ordinary prose is how a literal brace reaches a buyer, so the ones this
 * page cannot fill are listed by name underneath rather than left to be spotted.
 */
function fillTemplate(body, username) {
  const text = String(body ?? '');
  const parts = [];
  const unresolved = new Set();
  let last = 0;

  for (const m of text.matchAll(PLACEHOLDER)) {
    parts.push(text.slice(last, m.index));
    const name = m[1].toLowerCase();
    if (name === 'username' && username) {
      parts.push(html`<span class="var">${username}</span>`);
    } else {
      unresolved.add(m[0]);
      parts.push(html`<span class="var">${m[0]}</span>`);
    }
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));

  return { html: join(parts), unresolved: [...unresolved] };
}

/** The plain-text form that goes into the textarea somebody will actually send. */
function fillPlain(body, username) {
  const text = String(body ?? '');
  return username ? text.replace(/\{username\}/gi, username) : text;
}

// ============================================================================
// 5. THE COMPOSE FORM, every write is audited and carries an author
// ============================================================================

const KINDS = {
  note: { label: 'Note', glyph: 'idle', what: 'kept here, never sent' },
  sent: { label: 'Sent', glyph: 'info', what: 'a message that went to the buyer' },
  flag: { label: 'Flag', glyph: 'crit', what: 'this buyer is dead, it changes the Orders page' },
};

function kindPill(kind) {
  const spec = KINDS[kind];
  return spec ? pill(spec.glyph, spec.label) : missing();
}

function composeForm({ ctx, buyer, id = 'compose', back = null, prefill = '', open = false }) {
  return html`<form method="post" action="/messages" class="stack-sm">
      <input type="hidden" name="_csrf" value="${ctx.csrfToken}">
      <input type="hidden" name="buyer" value="${buyer}">
      <input type="hidden" name="back" value="${back || buyerHref(buyer)}">
      <div class="field">
        <label for="${id}-body">What was said <span class="req">*</span></label>
        <textarea id="${id}-body" name="body" required rows="7">${prefill}</textarea>
        <p class="field-hint">
          Logged against <b>${buyer}</b> with your name and the time. This hub does not send anything, 
          it records what you sent, so the next person can see it.
        </p>
      </div>
      <div class="field">
        <label for="${id}-kind">What kind of entry</label>
        <select id="${id}-kind" name="kind">
          ${join(
            Object.entries(KINDS).map(
              ([k, spec]) => html`<option value="${k}" ${safe(k === (open ? 'note' : 'sent') ? 'selected' : '')}>
                  ${spec.label}, ${spec.what}
                </option>`
            )
          )}
        </select>
        <p class="field-hint">
          <b>Flag</b> is not a label. It is the only source of the <em>dead</em> bucket on the Orders page,
          so flagging moves this buyer's open orders out of the chase list for everyone.
        </p>
      </div>
      <div class="form-actions">
        <button class="btn" type="submit">Log it against ${buyer}</button>
        <span class="form-status">Nothing is written until you press this.</span>
      </div>
    </form>`;
}

function composeClosed(notice) {
  return html`<p class="note note--neg">
      ${glyph('crit')} <b>Logging is closed while the typed-records database is unreachable.</b>
      ${notice || 'Nothing typed here could be saved, and a box that silently loses a message is worse than no box.'}
      The triage above still stands, it reads from <code class="mono">data/</code> and owes the database
      nothing.
    </p>`;
}

// ============================================================================
// 5b. THE TALK PLAYBOOK, the owner's own words
// ============================================================================

/** The stages an order passes through, in order. `all` is not a stage, it is
 *  "every stage", and a card carrying it is offered at all of them. */
const STAGES = [
  { key: 'inquiry', step: 'Step 1', label: 'Before order' },
  { key: 'kickoff', step: 'Step 2', label: 'Order starts' },
  { key: 'working', step: 'Step 3', label: 'While working' },
  { key: 'approved', step: 'Step 4', label: 'They approve' },
  { key: 'delivered', step: 'Step 5', label: 'After delivery' },
];
const STAGE_BY_KEY = Object.fromEntries(STAGES.map((s) => [s.key, s]));
const STAGE_KEYS = STAGES.map((s) => s.key);

/** How a card reads. NOT derived from its group: one card filed under "when
 *  they say no" is a buying signal, and painting it red because of where it
 *  lives would tell the CSR to back off at the moment the buyer said yes. */
const CARD_KIND = {
  ask: { glyph: 'ok', word: 'Ask this' },
  stop: { glyph: 'crit', word: 'They pushed back' },
  care: { glyph: 'warn', word: 'Careful here' },
};

/**
 * A JSON column, whatever mysql2 handed back.
 *
 * The driver parses a JSON column into a real value on most builds and returns
 * the raw string on some. A view that assumed one of those renders an empty
 * playbook against a full table, at HTTP 200, and looks exactly like a page
 * whose owner has not written anything yet.
 */
function jsonColumn(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

/** One `talk` row into the shape this page renders. */
function readCard(row) {
  const stage = jsonColumn(row.stage, []);
  const stages = (Array.isArray(stage) ? stage : []).map(String);
  const turns = (Array.isArray(jsonColumn(row.turns, [])) ? jsonColumn(row.turns, []) : []).filter(
    (t) => t && t.h && t.s
  );
  const chips = jsonColumn(row.chips, []);

  return {
    id: Number(row.id),
    slug: row.slug ?? null,
    heading: String(row.heading ?? ''),
    group: String(row.group ?? ''),
    kind: CARD_KIND[String(row.kind)] ? String(row.kind) : 'ask',
    // An empty stage list means every stage, never no stage. A card nobody can
    // reach through any tab is a card that has been deleted without anyone
    // deciding to delete it.
    stages: stages.length ? stages : ['all'],
    chips: (Array.isArray(chips) ? chips : []).map(String),
    title: String(row.title ?? ''),
    sub: row.sub ? String(row.sub) : null,
    turns,
    active: Number(row.active) === 1,
    sort: Number(row.sort) || 0,
    source: String(row.source ?? ''),
    author: row.author ?? null,
    updated_at: row.updated_at ?? null,
  };
}

function cardAtStage(card, stage) {
  return stage === 'all' || card.stages.includes('all') || card.stages.includes(stage);
}

/** Everything about a card, lowercased once, for the search box. */
function cardHaystack(card) {
  return [
    card.title,
    card.sub,
    card.heading,
    ...card.chips,
    ...card.turns.flatMap((t) => [t.h, t.s, t.u, t.w]),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/** The filter state lives in the URL, so a CSR can send another CSR this view. */
function talkFilters(query) {
  const stage = STAGE_KEYS.includes(String(query?.stage)) ? String(query.stage) : 'all';
  const group = String(query?.g ?? '').slice(0, 24);
  const needle = String(query?.q ?? '').slice(0, 80);
  return { stage, group, needle };
}

/**
 * The URL of one view of the playbook.
 *
 * `hash` is FALSE for anything that goes into a form's `back` field, and that
 * is not cosmetic. Every write redirects with `${back}${sep}ok=<code>`, so a
 * back value carrying `#talk` produces `/messages/x#talk?ok=logged`: the query
 * string lands inside the fragment, the server never sees it, and the "Saved"
 * banner silently never appears. The write succeeded and the page says nothing,
 * which is the one outcome a form must never produce.
 */
function talkHref(buyer, filters, patch = {}, { hash = true } = {}) {
  const next = { ...filters, ...patch };
  const params = new URLSearchParams();
  if (next.stage && next.stage !== 'all') params.set('stage', next.stage);
  if (next.group) params.set('g', next.group);
  if (next.needle) params.set('q', next.needle);
  const qs = params.toString();
  return `${buyerHref(buyer)}${qs ? `?${qs}` : ''}${hash ? '#talk' : ''}`;
}

/**
 * Which stage this buyer is actually at, from the triage rather than a guess.
 *
 * It is a SUGGESTION with a link, not a default. Silently pre-filtering the
 * playbook to one stage would hide the other four behind a decision the page
 * made on the CSR's behalf, and the buyer in front of them is the one case that
 * does not fit the pattern often enough to matter.
 */
function suggestStage({ rows, coldQuotes, hasOrders }) {
  if (rows.some((r) => r.owes === 'us')) return 'working';
  if (rows.some((r) => r.owes === 'them')) return 'delivered';
  if (coldQuotes.length) return 'inquiry';
  if (hasOrders) return 'delivered';
  return 'inquiry';
}

/** The stage rail and the group rail. Links, so the state is shareable. */
function talkRails(buyer, filters, groups, counts) {
  const stageRail = html`<div class="segment" role="group" aria-label="Which stage of the order">
      <a href="${talkHref(buyer, filters, { stage: 'all' })}"
         ${safe(filters.stage === 'all' ? 'aria-current="true"' : '')}>Every stage</a>
      ${join(
        STAGES.map(
          (s) => html`<a href="${talkHref(buyer, filters, { stage: s.key })}"
              ${safe(filters.stage === s.key ? 'aria-current="true"' : '')}>${s.label}</a>`
        )
      )}
    </div>`;

  const groupRail = html`<div class="segment" role="group" aria-label="Which kind of moment">
      <a href="${talkHref(buyer, filters, { group: '' })}"
         ${safe(filters.group === '' ? 'aria-current="true"' : '')}>All ${num(counts.total)}</a>
      ${join(
        groups.map(
          (g) => html`<a href="${talkHref(buyer, filters, { group: g.key })}"
              ${safe(filters.group === g.key ? 'aria-current="true"' : '')}>${g.heading}</a>`
        )
      )}
    </div>`;

  return html`${stageRail}${groupRail}`;
}

/** One exchange: what the buyer said, and the line that goes back. */
function turnBlock({ ctx, buyer, card, turn, index, gate, canWrite, backTo }) {
  const filled = fillTemplate(turn.s, buyer);
  const isAsk = asksForReview(turn.s, turn.u, turn.w);
  const refused = isAsk && !gate.allowed;

  return html`<div class="msg talk-turn">
      <p class="from">They say</p>
      <p class="snippet-body">${turn.h}</p>

      <p class="from is-us">${refused ? 'You would send, and this one is refused' : 'You send'}</p>
      <p class="snippet-body">${filled.html}</p>

      ${filled.unresolved.length
        ? html`<p class="caption">
            ${num(filled.unresolved.length)} placeholder${filled.unresolved.length === 1 ? '' : 's'}
            this page cannot fill,
            ${join(filled.unresolved.map((p) => html`<code class="mono">${p}</code>`), ' · ')}. Fill
            ${filled.unresolved.length === 1 ? 'it' : 'them'} by hand before sending; a literal brace in a
            buyer's inbox is the message that gets screenshotted.
          </p>`
        : ''}

      ${turn.u ? html`<p class="caption"><b>Opens</b> ${turn.u}</p>` : ''}
      ${turn.w ? html`<p class="note note--warn">${glyph('warn')} ${turn.w}</p>` : ''}

      ${refused
        ? html`<p class="note note--neg">
              ${glyph('crit')} <b>This line asks for a review, and it is refused for ${buyer}.</b>
              A review ask on a late or cold order is the most reliable way to turn a private three-star
              into a public one, and a public one cannot be taken back.
            </p>
            <ul class="steps">
              ${join(gate.reasons.map((x) => html`<li><strong>${x.what}</strong>, ${x.detail}</li>`))}
            </ul>
            <p class="caption">
              ${card.turns.length > 1 ? 'The other lines on this card are still fine to send. ' : ''}Clear
              the order first and this line becomes available on its own, nobody has to override anything.
            </p>`
        : canWrite
          ? why(
              isAsk ? 'Send this review request, and log it' : 'Send this, and log it',
              composeForm({
                ctx,
                buyer,
                id: `talk-${card.id}-${index}`,
                back: backTo,
                prefill: fillPlain(turn.s, buyer),
              })
            )
          : html`${info(`Logging is closed, the typed-records database is unreachable, so this line can be copied but not recorded.`)}`}
    </div>`;
}

function talkCard({ ctx, buyer, card, gate, canWrite, isOwner, filters, groups }) {
  const spec = CARD_KIND[card.kind];
  const backTo = talkHref(buyer, filters, {}, { hash: false });
  // The card's own guidance, as opposed to its lines. "Give it, and ask for the
  // review in the same message" is an instruction that has to be withheld on a
  // late order even when not one of the lines underneath mentions a review.
  const guidanceAsks = asksForReview(card.title, card.sub);
  const guidanceRefused = guidanceAsks && !gate.allowed;
  // Whether any LINE on this card is refused, which is a different question
  // from whether the card's guidance is. "Give it, and ask for the review in
  // the same message" is an instruction to write a sentence that is not in the
  // card, so pointing at a refusal underneath would point at nothing and read
  // as the page contradicting itself.
  const linesRefused = !gate.allowed && card.turns.some((t) => asksForReview(t.s, t.u, t.w));

  return html`<article class="snippet" id="talk-${String(card.id)}">
      <div class="snippet-head">
        <h4>${card.title}</h4>
        ${pill(spec.glyph, spec.word)}
        ${join(card.chips.map((c) => pill('idle', c)), ' ')}
        ${card.active ? '' : pill('idle', 'Switched off')}
        ${card.turns.length ? '' : pill('crit', 'No line in it')}
        <span class="uses">${num(card.turns.length)} ${card.turns.length === 1 ? 'reply' : 'replies'}</span>
      </div>

      ${card.sub ? html`<p class="caption">${card.sub}</p>` : ''}

      ${card.turns.length
        ? ''
        : html`<p class="note note--warn">
            ${glyph('warn')} <b>This card carries no exchange, so there is nothing to send from it.</b>
            Nobody but you is shown it. A turn needs both halves, what the buyer says and the line that
            goes back; one without the other is not stored.
          </p>`}

      ${guidanceRefused
        ? html`<p class="note note--neg">
            ${glyph('crit')} <b>The note on this card tells you to ask for a review. Do not, for
            ${buyer}.</b> The rest of the card stands, and the ask does not.
            ${linesRefused
              ? html`The reasons are printed on the refused line below.`
              : html`No line here carries the ask, so nothing below is blocked, this is a warning about the
                  sentence you would have added yourself.
                  ${num(gate.reasons.length)} reason${gate.reasons.length === 1 ? '' : 's'}:
                  ${join(gate.reasons.map((x) => x.what), '; ')}.`}
          </p>`
        : ''}

      ${join(
        card.turns.map((turn, i) =>
          turnBlock({ ctx, buyer, card, turn, index: i, gate, canWrite, backTo })
        )
      )}

      <p class="caption">
        Offered at ${card.stages.includes('all')
          ? 'every stage'
          : join(
              card.stages.map((s) => html`<b>${STAGE_BY_KEY[s]?.label ?? s}</b>`),
              ', '
            )}.
        ${card.source === 'playbook'
          ? 'From the Client Talk Hub.'
          : html`Written here by ${card.author ?? missing()}.`}
        Last changed ${card.updated_at ? dateTimeShort(card.updated_at) : missing()}.
      </p>

      ${isOwner ? talkOwnerTools({ ctx, card, back: backTo, groups }) : ''}
    </article>`;
}

// ---- the owner's editor ----------------------------------------------------
//
// Rendered for role `owner` and for nobody else. That is the courtesy; the
// rule is in server.js, which refuses the POST whatever the page rendered. A
// hidden form has never been a permission.

const TURN_SLOTS = 2; // blank rows offered under whatever the card already has

// Every input id is scoped by the card it belongs to. Several editors are open
// on one page, and a duplicated id points every `for=` at the first one on the
// page: the label reads correctly, and tapping it focuses somebody else's box.
function turnFields(turn, index, scope) {
  const n = `${scope}-${index}`;
  return html`<fieldset class="field">
      <legend class="field-label">Exchange ${String(index + 1)}</legend>
      <div class="form-grid form-grid--two">
        <div class="field">
          <label for="th-${safe(n)}">What the buyer says</label>
          <input id="th-${safe(n)}" name="turn_h" maxlength="400" value="${turn?.h ?? ''}">
        </div>
        <div class="field">
          <label for="tu-${safe(n)}">What it opens</label>
          <input id="tu-${safe(n)}" name="turn_u" maxlength="200" value="${turn?.u ?? ''}">
        </div>
      </div>
      <div class="field">
        <label for="ts-${safe(n)}">The line that goes back</label>
        <textarea id="ts-${safe(n)}" name="turn_s" rows="4" maxlength="4000">${turn?.s ?? ''}</textarea>
        <p class="field-hint">
          Leave <code class="mono">{username}</code> exactly as it is. This page fills it from whichever
          buyer is open. Typing a name makes the line usable for one person only.
        </p>
      </div>
      <div class="field">
        <label for="tw-${safe(n)}">The warning on this line</label>
        <input id="tw-${safe(n)}" name="turn_w" maxlength="600" value="${turn?.w ?? ''}">
        <p class="field-hint">Shown in amber under the line. Blank for most.</p>
      </div>
    </fieldset>`;
}

function talkForm({ ctx, card, back, groups }) {
  const id = card ? String(card.id) : 'new';
  const turns = [...(card?.turns ?? []), ...Array.from({ length: TURN_SLOTS }, () => null)];

  return html`<form method="post" action="/messages/talk" class="stack-sm">
      <input type="hidden" name="_csrf" value="${ctx.csrfToken}">
      <input type="hidden" name="back" value="${back}">
      ${card ? html`<input type="hidden" name="id" value="${id}">` : ''}

      <div class="field">
        <label for="tt-${safe(id)}">The situation <span class="req">*</span></label>
        <input id="tt-${safe(id)}" name="title" maxlength="200" required value="${card?.title ?? ''}">
        <p class="field-hint">What the CSR is looking for. Write it the way they would think of it.</p>
      </div>

      <div class="field">
        <label for="ts2-${safe(id)}">Why it works</label>
        <textarea id="ts2-${safe(id)}" name="sub" rows="2" maxlength="2000">${card?.sub ?? ''}</textarea>
      </div>

      <div class="form-grid form-grid--two">
        <div class="field">
          <label for="tg-${safe(id)}">Group key <span class="req">*</span></label>
          <input id="tg-${safe(id)}" name="group" maxlength="24" required
                 list="talk-groups-${safe(id)}" value="${card?.group ?? ''}">
          <datalist id="talk-groups-${safe(id)}">
            ${join(groups.map((g) => html`<option value="${g.key}">${g.heading}</option>`))}
          </datalist>
          <p class="field-hint">
            ${groups.length
              ? html`Existing: ${join(groups.map((g) => html`<code class="mono">${g.key}</code>`), ' · ')}.
                  A new key starts a new section.`
              : 'A short key such as ask or obj. A new key starts a new section.'}
          </p>
        </div>
        <div class="field">
          <label for="thd-${safe(id)}">Section heading <span class="req">*</span></label>
          <input id="thd-${safe(id)}" name="heading" maxlength="80" required value="${card?.heading ?? ''}">
          <p class="field-hint">The words above the group, such as "When they say no".</p>
        </div>
      </div>

      <div class="form-grid form-grid--two">
        <div class="field">
          <label for="tk-${safe(id)}">How it reads</label>
          <select id="tk-${safe(id)}" name="kind">
            ${join(
              Object.entries(CARD_KIND).map(
                ([k, s]) => html`<option value="${k}" ${safe(k === (card?.kind ?? 'ask') ? 'selected' : '')}>
                    ${s.word}
                  </option>`
              )
            )}
          </select>
          <p class="field-hint">
            Not the same as the group. A buying signal filed under objections still reads as go.
          </p>
        </div>
        <div class="field">
          <label for="tc-${safe(id)}">Chips</label>
          <input id="tc-${safe(id)}" name="chips" maxlength="160"
                 value="${(card?.chips ?? []).join(', ')}">
          <p class="field-hint">Comma separated, up to four. Where it came from, or why it matters.</p>
        </div>
      </div>

      <fieldset class="field">
        <legend class="field-label">When it is offered</legend>
        ${join(
          STAGES.map(
            (s) => html`<label class="check-row">
              <input type="checkbox" name="stage" value="${s.key}"
                     ${safe((card?.stages ?? []).includes(s.key) ? 'checked' : '')}>
              <span class="check-label">${s.step}, ${s.label}</span>
            </label>`
          )
        )}
        <p class="field-hint">
          None ticked means every stage, never none. A card behind no tab at all is one nobody can find.
        </p>
      </fieldset>

      <div class="field">
        <label for="tso-${safe(id)}">Sort</label>
        <input id="tso-${safe(id)}" name="sort" inputmode="numeric" maxlength="6"
               value="${card ? String(card.sort) : ''}">
        <p class="field-hint">Low first. The import numbers in tens, so there is room between any two.</p>
      </div>

      ${join(turns.map((t, i) => turnFields(t, i, id)))}

      <div class="form-actions">
        <button class="btn" type="submit">${card ? 'Save this card' : 'Add this card'}</button>
        <span class="form-status">
          Written with your name against it, in one transaction with the audit row.
        </span>
      </div>
    </form>`;
}

function talkOwnerTools({ ctx, card, back, groups }) {
  return html`<div class="btnrow snippet-actions">
      <form method="post" action="/messages/talk/toggle">
        <input type="hidden" name="_csrf" value="${ctx.csrfToken}">
        <input type="hidden" name="id" value="${String(card.id)}">
        <input type="hidden" name="active" value="${card.active ? '0' : '1'}">
        <input type="hidden" name="back" value="${back}">
        <button class="btn btn--sm ${safe(card.active ? 'btn--danger' : '')}" type="submit">
          ${card.active ? 'Switch this card off' : 'Switch it back on'}
        </button>
      </form>
      <span class="form-status">Kept either way. Nothing here is ever deleted.</span>
    </div>
    ${why('Edit this card', talkForm({ ctx, card, back, groups }))}`;
}

function talkPanel({ ctx, buyer, cards, gate, canWrite, isOwner, filters, dbNotice, suggested }) {
  if (!cards) {
    return html`<section class="panel" id="talk">
        ${panelHead('What to say', 'missing', 'talk table unreadable')}
        <div class="figure">
          <span class="cap">Lines available</span>
          <strong class="mid">${missing()}</strong>
          <p class="sub">
            The typed-records database is unreachable, so the playbook cannot be listed and nothing can be
            logged. It is MISSING, not empty. Writing a message from memory because the list did not load
            is exactly the failure this hub exists to stop.
          </p>
        </div>
        ${composeClosed(dbNotice)}
      </section>`;
  }

  // Switched-off cards are readable by the owner, because he is the one who
  // switches them back on. Nobody else is offered a line somebody withdrew.
  // A card with no usable exchange has nothing to send and is not offered. The
  // owner still sees it, marked, because he is the only person who can put a
  // line back into it, and hiding a broken card from him is how it stays broken.
  const visible = cards.filter((c) => (c.active && c.turns.length > 0) || isOwner);
  // Only ever non-zero for the owner, and it is why his count of cards is
  // higher than the number on the "all" tab. Saying it is cheaper than letting
  // him wonder which figure is wrong.
  const offCount = visible.filter((c) => !c.active).length;
  // Built from what is VISIBLE, not from what is active. A group whose every
  // card the owner switched off would otherwise vanish from the rail, and the
  // cards inside it would be unreachable by the only person who can switch
  // them back on.
  const groups = [];
  for (const card of visible) {
    let g = groups.find((x) => x.key === card.group);
    if (!g) groups.push((g = { key: card.group, heading: card.heading, n: 0 }));
    g.n += 1;
  }

  const needle = filters.needle.trim().toLowerCase();
  const shown = visible.filter(
    (c) =>
      cardAtStage(c, filters.stage) &&
      (!filters.group || c.group === filters.group) &&
      (!needle || cardHaystack(c).includes(needle))
  );

  const byGroup = [];
  for (const card of shown) {
    let g = byGroup.find((x) => x.key === card.group);
    if (!g) byGroup.push((g = { key: card.group, heading: card.heading, cards: [] }));
    g.cards.push(card);
  }

  const stageLabel = filters.stage === 'all' ? 'every stage' : STAGE_BY_KEY[filters.stage].label;
  const turnsShown = shown.reduce((n, c) => n + c.turns.length, 0);

  return html`<section class="panel" id="talk">
      ${panelHead(
        html`What to say to ${buyer}, ${num(turnsShown)} line${turnsShown === 1 ? '' : 's'} at ${stageLabel}`,
        'typed',
        'Typed · talk · the owner writes these'
      )}

      <p class="caption">
        This buyer looks like <b>${STAGE_BY_KEY[suggested].step}, ${STAGE_BY_KEY[suggested].label}</b> from
        the triage above.
        ${filters.stage === suggested
          ? 'That is the stage you are on.'
          : html`<a href="${talkHref(buyer, filters, { stage: suggested })}">Show that stage</a>.`}
        It is a suggestion, not a filter, the buyer in front of you is the one who does not fit.
      </p>

      ${talkRails(buyer, filters, groups, { total: visible.length })}

      <form class="toolbar" method="get" action="${buyerHref(buyer)}">
        ${filters.stage !== 'all' ? html`<input type="hidden" name="stage" value="${filters.stage}">` : ''}
        ${filters.group ? html`<input type="hidden" name="g" value="${filters.group}">` : ''}
        <span class="search">
          <label class="sr-only" for="tq">Search what the buyer just said</label>
          <input type="search" id="tq" name="q" value="${filters.needle}"
                 placeholder="Type what they just said: vector, expensive, later, free, print">
        </span>
        <button class="btn btn--sm" type="submit">Find</button>
        ${filters.needle || filters.group || filters.stage !== 'all'
          ? html`<a class="btn btn--ghost btn--sm" href="${buyerHref(buyer)}#talk">Reset</a>`
          : ''}
        <span class="count">${String(shown.length)} of ${String(visible.length)} cards${
          offCount ? `, ${offCount} switched off` : ''
        }</span>
      </form>

      ${gate.allowed || shown.length === 0
        ? ''
        : html`<p class="note note--neg">
            ${glyph('crit')} <b>Any line here that asks for a review is refused for ${buyer}.</b> It is
            shown rather than hidden, with the reason and the evidence printed on it, because a line that
            quietly disappears gets written from memory next time and gets it wrong.
          </p>`}

      ${byGroup.length === 0
        ? empty(
            visible.length === 0
              ? 'The playbook is empty. That is the table answering none, not a failure to read it. Run npm run seed:talk to load the Client Talk Hub.'
              : 'Nothing in the playbook matches that stage, group and search together. The playbook is not empty, this selection is.'
          )
        : join(
            byGroup.map(
              (g) => html`<h3 class="eyebrow talk-group">${g.heading}</h3>
                ${join(
                  g.cards.map((card) =>
                    talkCard({ ctx, buyer, card, gate, canWrite, isOwner, filters, groups })
                  )
                )}`
            )
          )}

      ${isOwner
        ? why(
            'Add a card to the playbook',
            html`${info(`Owner only. It goes live on every buyer the moment you save it, and it is stored as written here rather than in the file, so re-importing the Client Talk Hub cannot overwrite it.`)}
              ${talkForm({ ctx, card: null, back: talkHref(buyer, filters, {}, { hash: false }), groups })}`
          )
        : ''}

      <div class="provenance-bar">
        <span>Every line, typed by the owner, stored in <code class="mono">talk</code>.</span>
        <span><code class="mono">{username}</code> filled live from the join key.</span>
        <span>Nothing is sent from here. Sending is logged, by name, underneath.</span>
      </div>
    </section>`;
}

// ============================================================================
// 6. THE PICKER, no buyer chosen yet
// ============================================================================

/**
 * Who is worth opening.
 *
 * Union of three populations, in the order they matter: buyers with a late
 * order, buyers with a cold quote, buyers somebody has already written to.
 * Ranked by the first list they appear on, a stale order outranks a recent
 * note, because the point of this page is the message that has not been sent.
 */
function buildDirectory({ openRows, quoteRows, noteRows }) {
  const map = new Map();

  const touch = (raw) => {
    const key = normaliseBuyer(raw);
    if (!key) return null;
    let row = map.get(key);
    if (!row) {
      row = {
        key,
        display: String(raw).trim(),
        open: 0,
        stale: 0,
        oldest: null,
        quotes: 0,
        quoted: 0,
        notes: null,
        sent: null,
        flags: null,
        last_at: null,
      };
      map.set(key, row);
    }
    return row;
  };

  for (const o of openRows) {
    const row = touch(o.client);
    if (!row) continue;
    row.open += 1;
    if (o.stale === true) row.stale += 1;
    const age = toNumber(o.age_days);
    if (row.oldest === null || age > row.oldest) row.oldest = age;
  }

  for (const qrow of quoteRows) {
    const row = touch(qrow.client);
    if (!row) continue;
    row.quotes += 1;
    row.quoted += Number.isFinite(qrow.quoted) ? qrow.quoted : 0;
    const age = toNumber(qrow.age_days);
    if (row.oldest === null || age > row.oldest) row.oldest = age;
  }

  if (Array.isArray(noteRows)) {
    for (const n of noteRows) {
      const row = touch(n.buyer);
      if (!row) continue;
      row.notes = toNumber(n.notes);
      row.sent = toNumber(n.sent);
      row.flags = toNumber(n.flags);
      row.last_at = n.last_at ?? null;
    }
  }

  const rank = (r) => (r.stale ? 0 : r.open ? 1 : r.quotes ? 2 : 3);
  return [...map.values()].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    if ((b.oldest ?? -1) !== (a.oldest ?? -1)) return (b.oldest ?? -1) - (a.oldest ?? -1);
    return String(b.last_at ?? '').localeCompare(String(a.last_at ?? ''));
  });
}

function directoryRow(row, { notesKnown, staleAfter }) {
  const marks = [];
  if (row.stale) marks.push(pill('crit', staleAfter ? `${row.stale} past ${staleAfter}d` : `${row.stale} stale`));
  else if (row.open) marks.push(pill('warn', `${row.open} open`));
  if (row.quotes) marks.push(pill('idle', `${row.quotes} cold quote${row.quotes === 1 ? '' : 's'}`));
  if (notesKnown && row.flags) marks.push(pill('crit', 'Flagged dead'));

  const snip = notesKnown
    ? row.notes
      ? html`${num(row.notes)} logged · ${num(row.sent)} sent${row.oldest !== null ? html` · oldest thing here ${days(row.oldest)}` : ''}`
      : html`Nothing has ever been logged for this buyer${row.oldest !== null ? html` · oldest thing here ${days(row.oldest)}` : ''}`
    : html`Message history ${missing()}, the typed store is unreachable`;

  return html`<li class="thread">
      <a class="thread-btn thread-link" href="${buyerHref(row.display)}">
        <span class="thread-lines">
          <span class="who">${row.display}</span>
          <span class="snip">${snip}</span>
        </span>
        <span class="when">${
          notesKnown ? (row.last_at ? dateTimeShort(row.last_at) : 'never') : missing()
        }</span>
      </a>
      ${marks.length ? html`<p class="caption">${join(marks, ' ')}</p>` : ''}
    </li>`;
}

/**
 * What is waiting behind a buyer, said on the picker.
 *
 * Counts only. No line from the playbook appears here, because no line can be
 * chosen before a buyer is, and a page that showed one would be inviting
 * somebody to send it blind.
 */
function playbookNote(groups) {
  if (!groups) {
    return html`<p class="note note--warn">
        The talk playbook is ${missing()}. The typed-records database is unreachable, so how many lines are
        waiting behind a buyer cannot be read. It is not zero lines.
      </p>`;
  }
  if (!groups.length) {
    return html`<p class="note note--warn">
        The talk playbook is empty. That is the table answering none, not a failure to read it. Load the
        Client Talk Hub with <code class="mono">npm run seed:talk</code>.
      </p>`;
  }
  const total = groups.reduce((n, g) => n + toNumber(g.cards), 0);
  return html`<p class="note">
      ${glyph('info')} <b>${num(total)} cards</b> in the talk playbook, across
      ${join(groups.map((g) => html`<b>${g.heading}</b>`), ', ')}. Open a buyer to browse them by stage,
      with <code class="mono">{username}</code> filled in.
    </p>`;
}

function pickerView(ctx, { directory, notesKnown, open, quotes, staleAfter, needle, badBuyer, talkGroups }) {
  const filtered = needle
    ? directory.filter((r) => r.key.includes(normaliseBuyer(needle)) || r.display.toLowerCase().includes(needle.toLowerCase()))
    : directory;
  const shown = filtered.slice(0, 60);

  const staleBuyers = directory.filter((r) => r.stale).length;
  const quoteBuyers = directory.filter((r) => r.quotes).length;
  // With no run there is no stale line to name, and naming one anyway would be
  // a threshold this page invented.
  const staleLabel = staleAfter === null || staleAfter === undefined ? 'the stale line' : `${staleAfter} days`;

  const body = html`${badBuyer
      ? html`<p class="note note--neg">
          ${glyph('crit')} <b>That username did not reduce to a join key.</b> Everything client-shaped in
          this hub is keyed on the Fiverr username, and a value that is empty once punctuation is stripped
          cannot be joined to an order or an inquiry. Pick a buyer from the list instead.
        </p>`
      : ''}

    <div class="lede">
      <div class="lede-main">
        <div class="figure">
          <span class="cap">Buyers with an order past ${staleLabel}</span>
          <strong class="big">${isMissing(open) ? missing() : num(staleBuyers)}</strong>
          <p class="sub">
            and <b>${isMissing(quotes) ? missing() : num(quoteBuyers)}</b> more whose quote never became an
            order. Not one of them gets the same message, which is why this page will not open a compose
            box until a buyer is chosen.
          </p>
        </div>
        ${why(
          'Why there is no "message everyone" on this page',
          html`<p>
              An open order is not one thing. Before a single message goes out, each one is sorted into
              <em>we owe work</em>, <em>they owe a reply</em>, or <em>dead</em>. The same sentence sent to
              all three is right for one of them and damaging for another: a "just checking in" note to a
              buyer who is waiting on us tells them, in writing and with a timestamp, that we have not
              started.
            </p>
            <p>
              The sort here is by what is unresolved, not by who was written to last. A buyer with a late
              order and no logged message is at the top precisely because there is nothing in the history
              to see.
            </p>`
        )}
      </div>
      <div class="lede-side">
        <div class="figure">
          <span class="cap">Before any message</span>
          <strong class="mid">Triage first</strong>
          ${info(`Open a buyer and the page leads with their triage. The talk playbook sits underneath it, and a line that asks for a review is refused, with the order and its age printed, whenever that buyer is late or cold.`)}
        </div>
        <p class="note note--neg">
          ${glyph('crit')} <b>No review ask rides on a late or cold order.</b> It is the most reliable way
          to turn a private three-star into a public one, and it is not recoverable once it is public.
        </p>
        ${playbookNote(talkGroups)}
      </div>
    </div>

    <section class="panel">
      ${panelHead(
        html`Pick a buyer, ${num(filtered.length)} of ${num(directory.length)}`,
        notesKnown ? 'live' : 'missing',
        notesKnown ? 'Live · engine rows + typed notes' : 'History MISSING · typed store unreachable'
      )}

      <form class="toolbar" method="get" action="/messages">
        <span class="search">
          <label class="sr-only" for="mq">Search buyer username</label>
          <input type="search" id="mq" name="q" value="${needle}" placeholder="Fiverr username">
        </span>
        <button class="btn btn--sm" type="submit">Find</button>
        ${needle ? html`<a class="btn btn--ghost btn--sm" href="/messages">Clear</a>` : ''}
        <span class="count">${String(shown.length)} shown</span>
      </form>

      ${shown.length === 0
        ? empty(
            directory.length === 0
              ? 'No buyer has an open order, a cold quote or a logged message. That is a fact about the data, not a failure to load it.'
              : 'No buyer matches that search. The list is not empty, this selection is.'
          )
        : html`<ul class="thread-list">${join(shown.map((r) => directoryRow(r, { notesKnown, staleAfter })))}</ul>`}

      ${filtered.length > shown.length
        ? html`<p class="caption">
            ${num(filtered.length - shown.length)} more match. Narrow the search rather than scrolling, the
            order of this list is the order the work is in.
          </p>`
        : ''}

      <div class="provenance-bar">
        <span>Open orders and quotes, engine output, <code class="mono">latest-run.json</code>.</span>
        <span>Message counts, typed here, <code class="mono">client_note</code>.</span>
        <span>Buyers join on the Fiverr username, normalised.</span>
      </div>
    </section>`;

  return {
    title: 'Pick a buyer before writing anything',
    kicker: 'Messages',
    html: body,
  };
}

// ============================================================================
// 7. THE BUYER VIEW
// ============================================================================

function triagePanel({ rows, flagsKnown, open, buyer, coldQuotes }) {
  const orderRows = join(
    rows.map((r) => {
      const spec = BUCKETS[r.owes] || BUCKETS.unknown;
      const rowClass = r.stale === true ? 'row-late' : r.owes === 'us' ? 'row-attn' : '';
      return html`<tr class="${safe(rowClass)}">
          <td>
            <span class="cell-name">${r.project ?? missing()}</span>
            <span class="cell-sub">ordered ${dateShort(r.order_date)}${
              r.stale === true ? html` · past ${String(open.stale_after_days)} days` : ''
            }</span>
          </td>
          <td>${STAGE_LABEL[r.status] ? String(STAGE_LABEL[r.status]) : missing()}</td>
          <td class="r cell-figure">${days(r.age_days)}</td>
          <td class="r cell-figure">${money(r.shown_amount)}${
            r.priced
              ? ''
              : html`<span class="cell-sub">${
                  !r.book_available
                    ? 'book unreadable, cannot confirm'
                    : r.matched
                      ? 'no amount in the book'
                      : 'no matching row in the book'
                }</span>`
          }</td>
          <td>${pill(spec.glyph, spec.label)}</td>
          <td>${spec.send}</td>
        </tr>`;
    })
  );

  return html`<section class="panel">
      ${panelHead(
        html`Triage, ${num(rows.length)} open order${rows.length === 1 ? '' : 's'} for ${buyer}`,
        flagsKnown ? 'live' : 'missing',
        flagsKnown
          ? html`Live · recovery.open_orders · as of ${dateShort(open.as_of)}`
          : 'Dead bucket MISSING · flags unreadable'
      )}

      <p class="note note--neg">
        ${glyph('crit')} <b>Sort before you send.</b> The only bucket a check-in belongs in is
        <b>they owe a reply</b>. A "just checking in" note to a buyer who is waiting on us tells someone who
        has already paid, in writing and with a timestamp, that we have not started, and that is how a
        late order becomes a dispute.
      </p>

      ${rows.length === 0
        ? empty('No open order for this buyer. That is the order book saying none, not a failure to read it.')
        : html`<div class="tablewrap">
              <table class="table table--wide">
                <thead>
                  <tr>
                    <th scope="col">Project</th>
                    <th scope="col">Stage</th>
                    <th scope="col" class="r">Age</th>
                    <th scope="col" class="r">Amount</th>
                    <th scope="col">Who is waiting</th>
                    <th scope="col">What may be sent</th>
                  </tr>
                </thead>
                <tbody>${orderRows}</tbody>
              </table>
              <p class="tablehint" aria-hidden="true">Scroll sideways for more columns →</p>
            </div>`}

      ${coldQuotes.length
        ? html`<div class="tablewrap">
            <table class="table table--narrow">
              <thead>
                <tr>
                  <th scope="col">Quoted</th>
                  <th scope="col" class="r">Amount</th>
                  <th scope="col" class="r">Age</th>
                  <th scope="col" class="r">Follow-ups</th>
                  <th scope="col">Note on the quote</th>
                </tr>
              </thead>
              <tbody>
                ${join(
                  coldQuotes.map(
                    (qrow) => html`<tr>
                        <td><span class="cell-name">${dateShort(qrow.date)}</span></td>
                        <td class="r cell-figure">${money(qrow.quoted)}</td>
                        <td class="r cell-figure">${days(qrow.age_days)}</td>
                        <td class="r cell-figure">${num(qrow.followups)}</td>
                        <td>${qrow.note ?? missing()}</td>
                      </tr>`
                  )
                )}
              </tbody>
            </table>
          </div>`
        : ''}

      ${flagsKnown
        ? ''
        : html`<p class="note note--warn">
            The <b>dead</b> bucket is ${missing()}, not empty. Nothing in the order book means dead, so it
            comes from human flags in this hub, and the flag store is unreachable. Any row above may in
            fact already have been closed by somebody.
          </p>`}

      ${why(
        'How each order lands in a bucket, and the one that is not in the data',
        html`<ul>
            <li>
              <strong>We owe work</strong>, the book says <span class="mono">in_progress</span> or
              <span class="mono">revision</span>. The buyer has paid and is waiting.
            </li>
            <li>
              <strong>They owe a reply</strong>, <span class="mono">delivered</span>, no acceptance and no
              response. The only bucket where a polite check-in is the right message.
            </li>
            <li>
              <strong>Dead</strong>, nothing in the order book means dead, so nothing here infers it. An
              order is dead when somebody flagged the buyer in this hub, by name and with a timestamp. Log
              a flag below to do that.
            </li>
          </ul>
          <p>
            Ages are measured to <strong>${String(open.as_of)}</strong>, the engine's run date, not to
            today. Every age here is therefore a floor: the order is at least this old and older by however
            many days have passed since the run.
          </p>`
      )}
    </section>`;
}

function historyPanel({ notes, buyer, dbNotice }) {
  if (!notes) {
    return html`<section class="panel">
        ${panelHead(`Everything ever logged for ${buyer}`, 'missing', 'client_note unreadable')}
        <div class="figure">
          <span class="cap">Entries on record</span>
          <strong class="mid">${missing()}</strong>
          <p class="sub">
            The typed-records database is unreachable. This is MISSING, not "nothing was ever said to this
            buyer", and the difference decides whether the next message repeats one they already had.
          </p>
        </div>
        ${dbNotice ? html`<p class="note note--warn">${dbNotice}</p>` : ''}
      </section>`;
  }

  if (notes.length === 0) {
    return html`<section class="panel">
        ${panelHead(`Everything ever logged for ${buyer}`, 'typed', 'Typed · client_note · 0 rows')}
        ${empty(
          'Nothing has ever been logged for this buyer here. The table answered; it is genuinely none. Anything sent before this hub existed is not in it.'
        )}
      </section>`;
  }

  return html`<section class="panel">
      ${panelHead(
        html`Everything ever logged for ${buyer}, ${num(notes.length)}`,
        'typed',
        'Typed · client_note'
      )}
      ${join(
        notes.map((n) => {
          const kind = String(n.kind || 'note');
          const spellingDiffers =
            normaliseBuyer(n.buyer) === normaliseBuyer(buyer) && String(n.buyer).trim() !== String(buyer).trim();
          return html`<div class="msg">
              <p class="from ${safe(kind === 'sent' ? 'is-us' : '')}">
                ${kindPill(kind)} ${n.author || missing()} · ${dateTimeShort(n.at)}
                ${n.response_name ? html` · from <b>${n.response_name}</b>` : ''}
                ${spellingDiffers ? html` · logged as <code class="mono">${n.buyer}</code>` : ''}
              </p>
              <p class="snippet-body">${n.body}</p>
            </div>`;
        })
      )}
      ${info(`Newest first. Every row carries the name of whoever wrote it, an unattributed note is a note nobody can be asked about six months later, which is the question this whole hub was built around.`)}
    </section>`;
}

function ordersPanel({ orders, buyer }) {
  if (isMissing(orders)) {
    return html`<section class="panel">
        ${panelHead(`Order history, ${buyer}`, 'missing', 'orders.jsonl absent')}
        <div class="figure">
          <span class="cap">Orders on record</span>
          <strong class="mid">${missing()}</strong>
          ${info(`data/orders.jsonl is not readable, so this buyer's history cannot be listed. It is not an empty history.`)}
        </div>
      </section>`;
  }

  if (orders.length === 0) {
    return html`<section class="panel">
        ${panelHead(`Order history, ${buyer}`, 'live', 'Live · orders.jsonl · 0 rows')}
        ${empty('This username has never ordered. The order book answered; it is genuinely none.')}
      </section>`;
  }

  const sorted = [...orders].sort((a, b) =>
    String(b.order_date ?? b.delivered_date ?? '').localeCompare(String(a.order_date ?? a.delivered_date ?? ''))
  );
  const priced = sorted.filter((r) => Number.isFinite(r.amount));
  const total = priced.reduce((n, r) => n + r.amount + (Number.isFinite(r.tip) ? r.tip : 0), 0);
  const rated = sorted.filter((r) => Number.isFinite(r.rating));

  return html`<section class="panel">
      ${panelHead(
        html`Order history, ${num(sorted.length)} order${sorted.length === 1 ? '' : 's'}`,
        'live',
        'Live · orders.jsonl'
      )}
      <dl class="stats">
        <div class="stat"><dt>Orders</dt><dd>${num(sorted.length)}</dd></div>
        <div class="stat"><dt>Value</dt><dd>${priced.length ? money(total) : missing()}</dd></div>
        <div class="stat"><dt>Unpriced</dt><dd>${num(sorted.length - priced.length)}</dd></div>
        <div class="stat"><dt>Ratings left</dt><dd>${num(rated.length)}</dd></div>
      </dl>
      <div class="tablewrap">
        <table class="table table--wide">
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Project</th>
              <th scope="col">Stage</th>
              <th scope="col" class="r">Amount</th>
              <th scope="col" class="r">Rating</th>
              <th scope="col">Designer</th>
              <th scope="col">CSR</th>
            </tr>
          </thead>
          <tbody>
            ${join(
              sorted.map(
                (r) => html`<tr>
                    <td>
                      <span class="cell-name">${dateShort(r.order_date ?? r.delivered_date)}</span>
                      ${r.delivered_date
                        ? html`<span class="cell-sub">delivered ${dateShort(r.delivered_date)}</span>`
                        : ''}
                    </td>
                    <td>${r.project ?? missing()}</td>
                    <td>${STAGE_LABEL[r.status] ? String(STAGE_LABEL[r.status]) : missing()}</td>
                    <td class="r cell-figure">${
                      Number.isFinite(r.amount) ? money(r.amount) : missing()
                    }${Number.isFinite(r.tip) ? html`<span class="cell-sub">+${money(r.tip)} tip</span>` : ''}</td>
                    <td class="r cell-figure">${Number.isFinite(r.rating) ? num(r.rating, { dp: 1 }) : missing()}</td>
                    <td>${r.logo_designer ?? r.branding_designer ?? missing()}</td>
                    <td>${r.csr ?? missing()}</td>
                  </tr>`
              )
            )}
          </tbody>
        </table>
        <p class="tablehint" aria-hidden="true">Scroll sideways for more columns →</p>
      </div>
      ${info(`A blank rating is "no review recorded", not a bad one. An order with no amount contributes nothing to the value above and is counted separately, so the total is never quietly short by an unknown amount.`)}
    </section>`;
}

function leadsPanel({ leads, buyer, benchmark }) {
  if (isMissing(leads)) {
    return html`<section class="panel">
        ${panelHead(`Inquiry history, ${buyer}`, 'missing', 'leads.jsonl absent')}
        <div class="figure">
          <span class="cap">Inquiries on record</span>
          <strong class="mid">${missing()}</strong>
          <p class="sub"><code class="mono">data/leads.jsonl</code> is not readable.</p>
        </div>
      </section>`;
  }

  if (leads.length === 0) {
    return html`<section class="panel">
        ${panelHead(`Inquiry history, ${buyer}`, 'live', 'Live · leads.jsonl · 0 rows')}
        ${empty(
          'No inquiry was ever logged under this username. That is common and not itself a finding, 28 inquiry rows carry a typed display name that can never be joined to an order.'
        )}
      </section>`;
  }

  const followed = rate(pick(benchmark, 'followed_placed'), pick(benchmark, 'followed_n'));

  return html`<section class="panel">
      ${panelHead(
        html`Inquiry history, ${num(leads.length)} logged`,
        'live',
        'Live · leads.jsonl'
      )}
      <div class="tablewrap">
        <table class="table">
          <thead>
            <tr>
              <th scope="col">Asked</th>
              <th scope="col">Status on the sheet</th>
              <th scope="col" class="r">Quoted</th>
              <th scope="col" class="r">Follow-ups</th>
              <th scope="col">Shift</th>
              <th scope="col">CSR</th>
            </tr>
          </thead>
          <tbody>
            ${join(
              leads.map((l) => {
                const followups = [l.followup_1, l.followup_2, l.followup_3].filter(Boolean).length;
                return html`<tr>
                    <td><span class="cell-name">${dateShort(l.date)}</span>${
                      l.country ? html`<span class="cell-sub">${l.country}</span>` : ''
                    }</td>
                    <td>${l.status ? String(l.status).replace(/_/g, ' ') : missing()}</td>
                    <td class="r cell-figure">${Number.isFinite(l.quoted) ? money(l.quoted) : missing()}</td>
                    <td class="r cell-figure">${num(followups)}</td>
                    <td>${l.shift ?? missing()}</td>
                    <td>${l.csr ?? missing()}</td>
                  </tr>`;
              })
            )}
          </tbody>
        </table>
      </div>
      ${why(
        'Read the follow-up column the right way round',
        html`<p>
            A low follow-up count on a placed lead is not evidence that chasing is unnecessary. A follow-up
            is logged exactly when the buyer did <em>not</em> say yes immediately, so the never-followed-up
            group is full of people who were always going to order.
          </p>
          <p>
            The number that means anything is conversion <em>within</em> the group that was actually chased:
            ${followed.ok ? followed.html : missing()} of
            <strong>${num(pick(benchmark, 'followed_n'))}</strong> chased leads placed.
            ${followed.ok && followed.small
              ? html`That is stated as a Wilson 95% interval because n is too small to call as one number.`
              : ''}
            Never quote the raw split as if chasing were harmful.
          </p>`
      )}
    </section>`;
}

// ============================================================================
// 8. RENDER
// ============================================================================

export function render(ctx) {
  const run = ctx.run;
  const open = pick(run, 'recovery.open_orders');
  const quotes = pick(run, 'recovery.quotes');
  const benchmark = pick(run, 'recovery.followup_benchmark');

  const runOk = !isMissing(open) && open && Array.isArray(open.orders);
  const openRows = runOk ? open.orders : [];
  // Known and empty are different answers: [] from a readable block means
  // "no quotes", [] standing in for an unreadable one would mean the gate
  // below treats MISSING as "no cold quotes" and fails open.
  const quotesKnown = !isMissing(quotes) && Boolean(quotes) && Array.isArray(quotes.quotes);
  const quoteRows = quotesKnown ? quotes.quotes : [];
  const staleAfter = runOk ? open.stale_after_days : null;

  const buyerRaw = String(ctx.data?.buyer ?? '').trim();
  const key = ctx.data?.buyerKey || normaliseBuyer(buyerRaw);

  const notesQ = ctx.data?.notes ?? null;
  const talkQ = ctx.data?.talk ?? null;
  const directoryQ = ctx.data?.directory ?? null;

  // ---- no buyer chosen: the picker, and nothing that could be sent ---------
  if (!key) {
    const directory = buildDirectory({
      openRows,
      quoteRows,
      noteRows: directoryQ?.ok ? directoryQ.rows : null,
      staleAfter,
    });
    return pickerView(ctx, {
      directory,
      notesKnown: directoryQ?.ok === true,
      open,
      quotes,
      staleAfter,
      needle: typeof ctx.query?.q === 'string' ? ctx.query.q.slice(0, 80) : '',
      badBuyer: Boolean(buyerRaw) && !key,
      talkGroups: talkQ?.ok ? talkQ.rows : null,
    });
  }

  // ---- one buyer ----------------------------------------------------------
  const bookOrders = ctx.data?.orders ?? MISSING;
  const bookLeads = ctx.data?.leads ?? MISSING;
  const notes = notesQ?.ok ? notesQ.rows : null;
  // The playbook is null when the table could not be read, which is MISSING,
  // and an empty array when the table answered none, which is a fact. The
  // panel prints those two differently and must never conflate them.
  const cards = talkQ?.ok ? talkQ.rows.map(readCard) : null;
  const canWrite = Boolean(notesQ?.ok);
  const isOwner = ctx.user?.role === 'owner';
  const filters = talkFilters(ctx.query);

  // The display spelling: the first one a source actually used, never the
  // normalised join key, that key is a join artefact and no CSR should ever
  // see it.
  const firstOf = (rows, field) => {
    if (!Array.isArray(rows)) return null;
    for (const r of rows) {
      const v = r?.[field];
      if (v != null && String(v).trim() !== '') return String(v).trim();
    }
    return null;
  };
  const buyer =
    firstOf(isMissing(bookOrders) ? null : bookOrders, 'client') ||
    firstOf(isMissing(bookLeads) ? null : bookLeads, 'client') ||
    firstOf(openRows.filter((o) => normaliseBuyer(o.client) === key), 'client') ||
    buyerRaw;

  const flagged = notes === null ? null : notes.some((n) => String(n.kind) === 'flag');
  const mine = openRows.filter((o) => normaliseBuyer(o.client) === key);
  // The promised dates, attached before triage's output reaches the gate.
  // `ctx.data.due` is null when the table could not be read, and applyDueDates
  // turns that into `unknown` on every row rather than into "not late", so a
  // database outage cannot open the gate.
  const rows = applyDueDates(
    triage(mine, isMissing(bookOrders) ? null : bookOrders, flagged),
    ctx.data?.due ?? null,
    runOk ? open.as_of : null
  ).rows;
  const coldQuotes = quoteRows.filter((qrow) => normaliseBuyer(qrow.client) === key);

  const orderList = isMissing(bookOrders) ? MISSING : bookOrders;
  const leadList = isMissing(bookLeads) ? MISSING : bookLeads;
  const hasAnyRecord =
    (Array.isArray(orderList) && orderList.length > 0) || (Array.isArray(leadList) && leadList.length > 0);

  const lastDelivery = Array.isArray(orderList)
    ? orderList
        .map((r) => r.delivered_date ?? r.order_date)
        .filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d))
        .sort()
        .pop() || null
    : null;
  const lastDeliveryAge = runOk && lastDelivery ? daysBetween(lastDelivery, open.as_of) : null;

  const gate = reviewGate({
    runOk,
    quotesKnown,
    rows,
    coldQuotes,
    staleAfter,
    lastDeliveryAge,
    hasAnyRecord,
    flagged,
  });
  const call = verdict({ rows, coldQuotes, flagsKnown: flagged !== null });

  const staleCount = rows.filter((r) => r.stale === true).length;
  const oldest = rows.reduce((a, r) => Math.max(a, toNumber(r.age_days)), 0);
  const openValuePriced = rows.filter((r) => r.priced);
  // `priced_amount`, not `amount`: the book's figure where the book is what
  // decided the row was priced. See triage().
  const openValue = openValuePriced.reduce((n, r) => n + toNumber(r.priced_amount), 0);

  const lede = html`<div class="lede">
      <div class="lede-main">
        <div class="figure">
          <span class="cap">Open orders for ${buyer}</span>
          <strong class="big">${runOk ? num(rows.length) : missing()}</strong>
          <p class="sub">
            ${runOk
              ? html`<b>${num(rows.filter((r) => r.owes === 'us').length)}</b> waiting on us,
                  <b>${num(rows.filter((r) => r.owes === 'them').length)}</b> waiting on them,
                  ${flagged === null
                    ? html`dead ${missing()}`
                    : html`<b>${num(rows.filter((r) => r.owes === 'dead').length)}</b> dead`}.
                  ${staleCount
                    ? html`${num(staleCount)} past ${days(open.stale_after_days)}.`
                    : 'None past the stale line.'}
                  ${openValuePriced.length
                    ? html`They hold ${money(openValue)}${
                        openValuePriced.length < rows.length
                          ? html`, a floor, since ${num(rows.length - openValuePriced.length)} carr${
                              rows.length - openValuePriced.length === 1 ? 'ies' : 'y'
                            } no amount`
                          : ''
                      }.`
                    : ''}`
              : html`The engine run cannot be read, so the number of open orders is ${missing()}, not zero.
                  Nothing on this page may be sent on the strength of a figure that is absent.`}
          </p>
        </div>
        ${why(
          'An open order is not one thing',
          html`<p>
              Before a single message goes out, each open order is sorted into <em>we owe work</em>,
              <em>they owe a reply</em>, or <em>dead</em>. The same sentence is right for one of those and
              damaging for another. A "just checking in" note sent to a buyer who is waiting on us hands
              them a timestamped admission that we have not started.
            </p>
            <p>
              <strong>Dead is not in the order book.</strong> It is a call a person made in this hub, by
              name and with a time. Nothing here infers it from a status, an age or a silence.
            </p>`
        )}
      </div>
      <div class="lede-side">
        <div class="figure">
          <span class="cap">What may be sent today</span>
          <strong class="mid">${call.short}</strong>
          <p class="sub">${call.long}</p>
        </div>
        ${gate.allowed
          ? html`<p class="note">
              ${glyph('ok')} <b>A review request is permitted for this buyer.</b> Nothing is late, nothing is
              owed, and the last delivery is recent. That is the only combination that clears it.
            </p>`
          : html`<p class="note note--neg">
              ${glyph('crit')} <b>No review request goes to ${buyer}.</b> A review ask on a late or cold
              order is the most reliable way to turn a private three-star into a public one.
            </p>
            ${gate.reasons.length
              ? html`<ul class="steps">
                    ${join(gate.reasons.map((x) => html`<li><strong>${x.what}</strong>, ${x.detail}</li>`))}
                  </ul>`
              : ''}`}
      </div>
    </div>`;

  const composePanel = html`<section class="panel">
      ${panelHead(
        html`Log a decision about ${buyer}`,
        canWrite ? 'typed' : 'missing',
        canWrite ? 'Typed · client_note' : 'client_note unwritable'
      )}
      ${canWrite
        ? html`${composeForm({ ctx, buyer, prefill: '', open: true })}
            ${info(`This is not a transcript, and nobody should type one. Fiverr already holds every message. What is worth a line here is the handful of things Fiverr will not tell the next person: what was agreed, what was promised, what to avoid saying, and why a buyer is being handled the way they are. If a note would not change what somebody does next, it does not need writing.`)}
            ${info(`Sending a line from the playbook above logs itself, so the common case costs nothing. This box is for the rest. Every write carries your name through the audit log in the same transaction; if the attribution cannot be written, neither is the note.`)}`
        : composeClosed(ctx.dbNotice)}
    </section>`;

  const staleLine = staleCount
    ? `${staleCount} order${staleCount === 1 ? '' : 's'} past ${open.stale_after_days} days`
    : rows.length
      ? `${rows.length} open, none past ${open.stale_after_days} days`
      : 'nothing open';

  return {
    title: `${buyer}, ${runOk ? staleLine : 'open orders MISSING'}`,
    kicker: 'Messages',
    ticker: [
      { label: 'Open orders', value: runOk ? num(rows.length) : missing() },
      {
        label: 'Oldest open',
        value: rows.length ? num(oldest) : missing(),
        sub: rows.length ? 'days, as of the run' : 'nothing open',
      },
      {
        label: 'Open value',
        value: openValuePriced.length ? money(openValue) : missing(),
        sub: openValuePriced.length < rows.length ? 'floor' : null,
      },
      { label: 'Cold quotes', value: quoteRows.length || coldQuotes.length ? num(coldQuotes.length) : missing() },
      { label: 'Logged here', value: notes === null ? missing() : num(notes.length) },
      {
        label: 'Review ask',
        value: gate.allowed ? pill('ok', 'Permitted') : pill('crit', 'Refused'),
        sub: gate.allowed ? null : `${gate.reasons.length} reason${gate.reasons.length === 1 ? '' : 's'}`,
      },
    ],
    html: join([
      html`<nav class="caption" aria-label="This buyer">
        <a href="/messages">← every buyer</a> · <a href="${clientHref(buyer)}">${buyer}'s client record</a>
      </nav>`,
      lede,
      runOk
        ? triagePanel({ rows, flagsKnown: flagged !== null, open, buyer, coldQuotes })
        : html`<section class="panel">
            ${panelHead('Triage', 'missing', 'recovery.open_orders absent')}
            <div class="figure">
              <span class="cap">Open orders</span>
              <strong class="mid">${missing()}</strong>
              <p class="sub">
                The engine's run does not carry the open-order block, so no order can be sorted into
                <em>we owe work</em>, <em>they owe a reply</em> or <em>dead</em>. Until it can, every reply
                below is a guess about who is waiting, and the review requests are refused outright.
              </p>
            </div>
          </section>`,
      talkPanel({
        ctx,
        buyer,
        cards,
        gate,
        canWrite,
        isOwner,
        filters,
        dbNotice: ctx.dbNotice,
        suggested: suggestStage({
          rows,
          coldQuotes,
          hasOrders: Array.isArray(orderList) && orderList.length > 0,
        }),
      }),
      composePanel,
      historyPanel({ notes, buyer, dbNotice: ctx.dbNotice }),
      ordersPanel({ orders: orderList, buyer }),
      leadsPanel({ leads: leadList, buyer, benchmark }),
    ]),
  };
}

export default { render };
