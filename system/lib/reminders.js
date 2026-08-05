// lib/reminders.js — the thirteen reminder logics, as pure functions.
//
// WHAT THIS FILE IS
//
// REMINDER-LOGICS.md is owner-authored and authoritative: thirteen rules, each
// with an exact delay, an exact button set, and in two cases a chain. This
// module is that document expressed as data plus the transitions between
// states. Nothing here touches the database, the clock is always passed in,
// and every function returns a value rather than performing an effect — which
// is what makes all thirteen testable without a MySQL server or a fake timer.
//
// The caller (server.js) does the effects: it hands an activity to rulesFor(),
// writes the drafts it gets back through auditedWrite(), and hands the button
// a CSR tapped to resolve()/snooze(), writing the returned row back. If a
// behaviour is missing here it is missing everywhere; if a behaviour is added
// at a call site it holds only for that one call site.
//
// THE SHARED RULES (they apply to every reminder unless a rule says otherwise)
//
//   - Profile-scoped. A reminder belongs to the PROFILE, not the person. It
//     pops for whoever is covering that profile — any shift, any CSR.
//   - Persistent. It never expires on its own. due() will keep returning it
//     until somebody resolves it, however many days late.
//   - Snooze is 5 minutes, and RED alerts (frustrated, disputed) have none.
//   - One reminder per entry per rule. Editing the entry re-checks the rule.
//   - Every action is undoable for 5 seconds.
//   - Spam / not relevant books nothing.
//
// TWO TRAPS THIS MODULE GUARDS
//
//   1. TIME. due_at is stored as MySQL DATETIME holding UTC, which reads back
//      as 'YYYY-MM-DD HH:MM:SS'. Handing that string to `new Date()` parses it
//      as LOCAL time — on a PKT box every reminder would move five hours, and
//      nothing about the number would look wrong. parseAt() is the only
//      sanctioned way to turn a stored value into an instant, and toSqlUtc()
//      the only way back. Never call `new Date(row.due_at)`.
//   2. "IMMEDIATE" IS ZERO, NOT NOW-ISH. Rules 4, 7, 11 and 12 are due the
//      moment the activity is logged. due_at equals the log time exactly, so a
//      reminder booked at 12:00:00.400 is due at 12:00:00.400 — never a second
//      later, which would make it vanish from the page that just booked it.
//
// The retired volume programme is never named. An order's type is Organic or
// Directed; the word the shift logger used is not in this file and must not
// re-enter it.

// ---------------------------------------------------------------- constants

/** Snooze is five minutes. One number, one place. */
export const SNOOZE_MINUTES = 5;

/** Every resolve / snooze / chain advance can be taken back for five seconds. */
export const UNDO_WINDOW_MS = 5_000;

/** Resolution recorded when a later activity made the reminder unnecessary.
 *  It is the one resolution that may be booked again — see alreadyBooked(). */
export const AUTO_CLEARED = 'auto_cleared';

export const REMINDER_STATES = Object.freeze(['pending', 'snoozed', 'resolved']);

/** An order is Organic or Directed. The shift logger's third word is retired. */
export const ORDER_TYPES = Object.freeze(['Organic', 'Directed']);

/** How the order came in — this is what rule 4 keys on. */
export const ORDER_ROUTES = Object.freeze(['Via Chat', 'Direct Order']);

export const FOLLOWUP_ATTEMPTS = Object.freeze(['1st', '2nd', '3rd', '4th+']);

const HOURS = 60;

// ------------------------------------------------------- activity catalogue

/**
 * Everything a CSR can log, ported from the shift logger's catalogue.
 *
 * `books` is documentation that is checked: a test asserts it matches which
 * rules actually fire, so the row saying "Client conversation books nothing"
 * cannot quietly become untrue. The `kind` ENUM in db/schema.sql holds these
 * same keys and a test fails if the two lists drift.
 */
export const ACTIVITY_KINDS = Object.freeze([
  { key: 'inquiry',             label: 'New inquiry',                  group: 'inquiries' },
  { key: 'lead_followup',       label: 'Lead follow-up',               group: 'inquiries' },
  { key: 'client_conversation', label: 'Client conversation',          group: 'inquiries' },
  { key: 'new_order',           label: 'New order',                    group: 'orders' },
  { key: 'order_assigned',      label: 'Order assigned to designer',   group: 'orders' },
  { key: 'files_assigned',      label: 'Files assigned to designer',   group: 'orders' },
  { key: 'order_completed',     label: 'Order completed',              group: 'orders' },
  { key: 'revision_assigned',   label: 'Revision assigned to designer', group: 'revisions' },
  { key: 'project_delivered',   label: 'Project delivered',            group: 'deliveries' },
  { key: 'shared',              label: 'Shared to client (chat)',      group: 'deliveries' },
  { key: 'followup_client',     label: 'Follow-up with client',        group: 'followups' },
  { key: 'followup_designer',   label: 'Follow-up with designer',      group: 'followups' },
  { key: 'update_followup',     label: 'Update follow-up',             group: 'followups' },
  { key: 'upsell',              label: 'Upsell',                       group: 'followups' },
  { key: 'offer',               label: 'Offer',                        group: 'followups' },
  { key: 'custom_reminder',     label: 'Custom reminder',              group: 'followups' },
  { key: 'review_request',      label: 'Review request',               group: 'followups' },
  { key: 'review_received',     label: 'Review received',              group: 'followups' },
  { key: 'meeting',             label: 'Meeting',                      group: 'meetings' },
  { key: 'frustrated',          label: 'Frustrated client',            group: 'problems' },
  { key: 'disputed',            label: 'Disputed client',              group: 'problems' },
  { key: 'extension',           label: 'Extension sent',               group: 'problems' },
  { key: 'spam',                label: 'Spam / not relevant',          group: 'problems' },
]);

export const ACTIVITY_KIND_KEYS = Object.freeze(ACTIVITY_KINDS.map((a) => a.key));
const KIND_BY_KEY = Object.freeze(Object.fromEntries(ACTIVITY_KINDS.map((a) => [a.key, a])));

export const activityLabel = (kind) => KIND_BY_KEY[kind]?.label ?? null;

// -------------------------------------------------------------------- error

/** Thrown rather than swallowed. A reminder that silently fails to book is a
 *  follow-up nobody ever hears about again, which is the failure this whole
 *  section exists to prevent. */
export class ReminderError extends Error {
  constructor(message, code = 'REMINDER_ERROR') {
    super(message);
    this.name = 'ReminderError';
    this.code = code;
  }
}

// ------------------------------------------------------------------- time

/**
 * Turn a stored value into epoch milliseconds.
 *
 * Accepts a Date, a number, an ISO string, or the 'YYYY-MM-DD HH:MM:SS' form
 * MySQL returns for DATETIME. That last one is the whole reason this exists:
 * `new Date('2026-08-05 14:00:00')` is 14:00 LOCAL, and every DATETIME in
 * these tables is UTC.
 */
export function parseAt(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const s = String(value).trim();
  // A bare 'YYYY-MM-DD HH:MM:SS' (or with a 'T' and no zone) is UTC here.
  const bare = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)$/.exec(s);
  const t = Date.parse(bare ? `${bare[1]}T${bare[2]}Z` : s);
  return Number.isFinite(t) ? t : null;
}

/** Epoch ms → the 'YYYY-MM-DD HH:MM:SS' UTC form a DATETIME column takes. */
export function toSqlUtc(ms) {
  const t = parseAt(ms);
  if (t === null) throw new ReminderError(`Not a time: ${ms}`, 'BAD_TIME');
  return new Date(t).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * "Remind me in" free text → minutes. Accepts 30m · 45 m · 2h · 5 H · 1.5h.
 * Returns null for anything else, including blank — rule 8 turns that null
 * into its stated 24-hour default rather than guessing here.
 */
export function parseRemindIn(value) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([mh])\s*$/i.exec(String(value ?? ''));
  if (!m) return null;
  const n = Number.parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(m[2].toLowerCase() === 'h' ? n * 60 : n);
}

// -------------------------------------------------------------- small parts

/** The buyer join key: lowercase, alphanumerics only. Identical to the rule in
 *  lib/reconcile.js, so `Nativ_Shaibi`, `nativ shaibi` and `nativ_shaibi` are
 *  one buyer here too. The display spelling is never replaced by it. */
export function buyerKey(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

const detailOf = (a) => (a && typeof a.detail === 'object' && a.detail !== null ? a.detail : {});
const txt = (v, max = 200) => {
  const s = String(v ?? '').trim();
  return s === '' ? null : s.slice(0, max);
};
const orderRefOf = (a) => txt(a?.order_ref ?? detailOf(a).project, 160);
const clientName = (a) => txt(a?.client ?? detailOf(a).client, 120);
/** Who the reminder names when no username was typed. Not a fabricated buyer —
 *  a placeholder in a sentence, and client/client_key stay null underneath. */
const who = (a) => clientName(a) || 'the client';
const joinBody = (...parts) => parts.map((p) => txt(p, 400)).filter(Boolean).join(' · ') || null;

/**
 * The star average behind rule 6, to one decimal.
 *
 * It is rounded BEFORE the 4.7 test on purpose: 5 + 5 + 4 is 4.666…, the app
 * stores and shows 4.7, and a rule that read the unrounded number would refuse
 * a review the CSR can see qualifying on screen.
 */
export function ratingAverage(detail = {}) {
  const direct = Number(detail.rating);
  if (Number.isFinite(direct) && direct > 0) return Math.round(direct * 10) / 10;
  const parts = [detail.value_rating, detail.quality_rating, detail.communication_rating].map(Number);
  if (!parts.every((n) => Number.isFinite(n) && n > 0)) return null;
  return Math.round((parts.reduce((a, b) => a + b, 0) / parts.length) * 10) / 10;
}

/**
 * May we ask this buyer for a public review?
 *
 * House rule 5: never attach a review request to a late or cold order. Rule 5
 * of the spec books exactly that ask on completion, so the two meet here. The
 * flags come from the caller — the engine's late-order set, or a frustrated /
 * disputed activity already logged against this buyer on this profile — and
 * `detail.late` / `detail.disputed` on the completion entry itself.
 *
 * A review ask on a late delivery is the most reliable way to turn a private
 * 3-star into a public one, so this is a suppression, not a delay: nothing is
 * booked at all.
 */
export function reviewAskAllowed(activity, ctx = {}) {
  const d = detailOf(activity);
  const flags = ctx.flags || {};
  return !(d.late || d.disputed || d.frustrated || flags.late || flags.disputed || flags.frustrated);
}

// ----------------------------------------------------------------- buttons

const B = (key, label, extra = {}) => Object.freeze({ key, label, kind: 'resolve', variant: 'subtle', ...extra });

/** The snooze every non-alert reminder carries. Appended by buttonsFor(); no
 *  rule lists it, so no rule can forget it and none can hand one to an alert. */
export const SNOOZE_BUTTON = Object.freeze({
  key: 'snooze',
  label: 'Snooze',
  kind: 'snooze',
  minutes: SNOOZE_MINUTES,
  variant: 'ghost',
  hint: `Back in ${SNOOZE_MINUTES} minutes`,
});

const FOLLOWUP_BUTTONS = Object.freeze([
  B('in_discussion', 'In discussion'),
  B('followed_up', 'Followed up', { variant: 'solid' }),
  B('order_taken', 'Order taken', { variant: 'ok' }),
]);

const UPSELL_BUTTONS = Object.freeze([
  B('no_need', 'No need'),
  B('upsell_done', 'Upsell done', { variant: 'ok' }),
]);

const DELIVERY_BUTTONS = Object.freeze([
  B('responded', 'Responded', { hint: 'The client already replied' }),
  B('followed_up', 'Followed up', { variant: 'ok' }),
]);

const SOLVED_BUTTONS = Object.freeze([
  B('solved', 'Solved', { variant: 'ok', hint: 'Removes the caution' }),
]);

// ------------------------------------------------------------------- rules

/**
 * The thirteen logics.
 *
 * Keyed by `rule_key` — the exact stage — because rule 9 is a three-step chain
 * and rule 10 is reachable from two activities. `rule` is the number in
 * REMINDER-LOGICS.md, and that is what the CEO ledger groups by.
 *
 *   on        the activity that books it
 *   when      condition on the logged entry; re-checked when the entry is edited
 *   delay     minutes from the log (or, for a chain stage, from the tap)
 *   cancelOn  logging THAT activity for the same buyer clears this reminder
 *   cancelBy  what has to match: 'client' (default), 'order_ref', or 'both'
 *   chained   booked only by a chain button, never by logging
 *   alert     standing RED caution box: no snooze, only its button clears it
 */
export const RULES = Object.freeze({
  // 1 · New inquiry → 25 min → send the 1st follow-up.
  inquiry_followup: {
    rule: 1,
    on: 'inquiry',
    delay: () => 25,
    cancelOn: 'new_order', // they converted — no need to chase
    heading: (a) => `Send the 1st follow-up to ${who(a)}`,
    body: (a) => joinBody('New inquiry', detailOf(a).agenda),
    buttons: FOLLOWUP_BUTTONS,
  },

  // 2 · Lead follow-up → the next one, 12h / 24h / 48h out. A 4th+ ends it.
  lead_followup_next: {
    rule: 2,
    on: 'lead_followup',
    when: (a) => ['1st', '2nd', '3rd'].includes(detailOf(a).attempt),
    delay: (a) => ({ '1st': 12 * HOURS, '2nd': 24 * HOURS, '3rd': 48 * HOURS })[detailOf(a).attempt],
    cancelOn: 'new_order',
    heading: (a) => `Send the ${NEXT_ATTEMPT[detailOf(a).attempt]} follow-up to ${who(a)}`,
    body: (a) => joinBody(`${detailOf(a).attempt} follow-up logged`, detailOf(a).note),
    buttons: FOLLOWUP_BUTTONS,
  },

  // 3 · New order → 30 min → assign it to a designer.
  order_assign: {
    rule: 3,
    on: 'new_order',
    delay: () => 30,
    cancelOn: 'order_assigned',
    cancelBy: 'order_ref', // that activity is keyed by the project, not a buyer
    heading: (a) => `Assign ${possessive(clientName(a))} order to a designer`,
    body: (a) => joinBody(orderRefOf(a), serviceList(a), detailOf(a).value && `Price: ${detailOf(a).value}`),
    buttons: [
      // "Next shift" is a snooze, not a resolution: the order still is not
      // assigned, so the reminder has to come back rather than close.
      Object.freeze({
        key: 'next_shift',
        label: 'Next shift',
        kind: 'snooze',
        minutes: 8 * HOURS,
        variant: 'subtle',
        hint: 'Will assign on the next shift — reminds again in 8 hours',
      }),
      B('assigned', 'Assigned', { variant: 'ok', hint: 'Order assigned to a designer' }),
    ],
  },

  // 4 · New order marked Direct Order → immediately → potential upsell.
  //     A Via Chat order books rule 3 only; a Direct Order books 3 and 4.
  order_upsell: {
    rule: 4,
    on: 'new_order',
    when: (a) => detailOf(a).order_via === 'Direct Order',
    delay: () => 0,
    cancelOn: 'upsell',
    heading: (a) => `Potential upsell for ${who(a)} — what's missing? Especially a Website`,
    body: (a) => joinBody('Direct Order', serviceList(a)),
    buttons: UPSELL_BUTTONS,
  },

  // 5 · Order completed → 30 min → ask for a Public Review.
  //     Suppressed entirely on a late or disputed order (house rule 5).
  completed_public_review: {
    rule: 5,
    on: 'order_completed',
    when: (a, ctx) => reviewAskAllowed(a, ctx),
    delay: () => 30,
    cancelOn: 'review_received', // they already left one — no point asking
    heading: (a) => `Ask ${who(a)} for a Public Review`,
    body: (a) => joinBody(orderRefOf(a), detailOf(a).completion),
    buttons: [
      B('no_need', 'No need'),
      B('msg_sent', 'Msg sent', { variant: 'solid' }),
      B('review_given', 'Review given', { variant: 'ok' }),
    ],
  },

  // 6 · Review received averaging 4.7-5.0 → exactly 24h → ask for a Private
  //     Review. Any lower average books nothing.
  review_private_ask: {
    rule: 6,
    on: 'review_received',
    when: (a) => {
      const avg = ratingAverage(detailOf(a));
      return avg !== null && avg >= 4.7 && avg <= 5;
    },
    delay: () => 24 * HOURS,
    heading: (a) => `Ask ${who(a)} for a Private Review`,
    body: (a) => joinBody(orderRefOf(a), `${ratingAverage(detailOf(a))}★ average`),
    buttons: [B('msg_sent', 'Msg sent', { variant: 'ok' })],
  },

  // 7 · Files assigned to the designer → immediately → suggest an upsell.
  files_upsell: {
    rule: 7,
    on: 'files_assigned',
    delay: () => 0,
    cancelOn: 'upsell',
    heading: (a) => `Suggest an upsell to ${who(a)}`,
    body: (a) => joinBody(orderRefOf(a), detailOf(a).designer && `Designer: ${detailOf(a).designer}`),
    buttons: UPSELL_BUTTONS,
  },

  // 8 · Revision assigned → after the typed time, blank means 24h → is it done?
  revision_check: {
    rule: 8,
    on: 'revision_assigned',
    delay: (a) => parseRemindIn(detailOf(a).remind_in) ?? 24 * HOURS,
    heading: (a) => `Check if ${possessive(clientName(a), 'the')} revision is done`,
    body: (a) => joinBody(orderRefOf(a), detailOf(a).designer && `Designer: ${detailOf(a).designer}`),
    buttons: [
      B('followup_done', 'Follow-up done', { hint: 'Checked in with the designer' }),
      B('revision_done', 'Revision done', { variant: 'ok', hint: 'The revision is finished' }),
    ],
  },

  // 9 · Offer → 2h → a three-stage, button-driven chain. Each next stage is
  //     booked only when the button is tapped, and its timer starts from the
  //     tap, not from the offer. "Order placed" ends the chain at any stage,
  //     as does logging a new order for that buyer.
  offer_fu1: {
    rule: 9,
    on: 'offer',
    chain_step: 1,
    delay: () => 2 * HOURS,
    cancelOn: 'new_order',
    heading: (a) => `Send the 1st follow-up on the offer to ${who(a)}`,
    body: (a) => joinBody(detailOf(a).scope, detailOf(a).value && `Offer value: ${detailOf(a).value}`),
    buttons: [
      B('order_placed', 'Order placed', { variant: 'ok', hint: 'Offer converted — no more reminders' }),
      Object.freeze({
        key: 'fu1_done', label: '1st F/U done', kind: 'chain', next: 'offer_fu2',
        variant: 'solid', hint: 'Books the 2nd follow-up reminder (16h)',
      }),
    ],
  },
  offer_fu2: {
    rule: 9,
    on: 'offer',
    chained: true,
    chain_step: 2,
    delay: () => 16 * HOURS,
    cancelOn: 'new_order',
    heading: (a) => `Send the 2nd follow-up on the offer to ${who(a)}`,
    body: (a) => joinBody(detailOf(a).scope, detailOf(a).value && `Offer value: ${detailOf(a).value}`),
    buttons: [
      B('order_placed', 'Order placed', { variant: 'ok', hint: 'Offer converted — no more reminders' }),
      Object.freeze({
        key: 'fu2_done', label: '2nd F/U done', kind: 'chain', next: 'offer_fu3',
        variant: 'solid', hint: 'Books the 3rd follow-up reminder (36h)',
      }),
    ],
  },
  offer_fu3: {
    rule: 9,
    on: 'offer',
    chained: true,
    chain_step: 3,
    delay: () => 36 * HOURS,
    cancelOn: 'new_order',
    heading: (a) => `Send the 3rd follow-up on the offer to ${who(a)}`,
    body: (a) => joinBody(detailOf(a).scope, detailOf(a).value && `Offer value: ${detailOf(a).value}`),
    buttons: [
      B('order_placed', 'Order placed', { variant: 'ok', hint: 'Offer converted' }),
      B('fu3_done', '3rd F/U done', { variant: 'solid', hint: 'Chain ends — no more reminders for this offer' }),
    ],
  },

  // 10 · Project delivered OR shared in chat → 15h → follow up on that item.
  //      Cleared by a revision on the SAME buyer AND the SAME project: the
  //      client came back with a revision, so the follow-up is not needed.
  delivery_followup: {
    rule: 10,
    on: 'project_delivered',
    delay: () => 15 * HOURS,
    cancelOn: 'revision_assigned',
    cancelBy: 'both',
    heading: (a) => `Follow up on the ${itemDelivered(a)} delivered to ${who(a)}`,
    body: (a) => joinBody(orderRefOf(a)),
    buttons: DELIVERY_BUTTONS,
  },
  shared_followup: {
    rule: 10,
    on: 'shared',
    delay: () => 15 * HOURS,
    cancelOn: 'revision_assigned',
    cancelBy: 'both',
    heading: (a) => `Follow up on the ${itemShared(a)} shared with ${who(a)}`,
    body: (a) => joinBody(orderRefOf(a)),
    buttons: DELIVERY_BUTTONS,
  },

  // 11 · Frustrated client → immediately, as a standing RED caution box.
  //      No snooze. Persists across every shift until someone taps Solved.
  frustrated_alert: {
    rule: 11,
    on: 'frustrated',
    alert: true,
    delay: () => 0,
    heading: (a) => `${who(a)} is frustrated — handle with caution`,
    body: (a) => joinBody(detailOf(a).what, orderRefOf(a)),
    buttons: SOLVED_BUTTONS,
  },

  // 12 · Disputed client → the same standing RED caution box.
  disputed_alert: {
    rule: 12,
    on: 'disputed',
    alert: true,
    delay: () => 0,
    heading: (a) => `${who(a)}'s dispute is OPEN — on the verge of cancelling, treat cautiously`,
    body: (a) => joinBody(detailOf(a).reason, orderRefOf(a)),
    buttons: SOLVED_BUTTONS,
  },

  // 13 · Custom reminder → whatever heading, note and moment the CSR chose.
  //      Not automatic: they created it on purpose, for what the rules miss.
  custom: {
    rule: 13,
    on: 'custom_reminder',
    delay: (a, ctx) => {
      const at = parseAt(detailOf(a).remind_at);
      if (at === null) {
        // Never guess a time the CSR did not choose. A custom reminder that
        // quietly lands twelve hours from now is worse than a rejected form:
        // they believe it is set for Tuesday morning and it is not.
        throw new ReminderError(
          'Custom reminder needs a date and time ("remind_at"). Nothing was booked.',
          'MISSING_REMIND_AT'
        );
      }
      // A time already past is due now, not negative-minutes in the past.
      return Math.max(0, Math.round((at - nowOf(ctx)) / 60_000));
    },
    heading: (a) => {
      const h = txt(detailOf(a).heading, 200);
      if (!h) throw new ReminderError('Custom reminder needs a heading. Nothing was booked.', 'MISSING_HEADING');
      return h;
    },
    body: (a) => joinBody(detailOf(a).note),
    buttons: [B('done', 'Done', { variant: 'ok' })],
  },
});

export const RULE_KEYS = Object.freeze(Object.keys(RULES));

/** The thirteen numbers, ascending. Rule 9 has three stages and rule 10 two
 *  entry points, so there are more keys than numbers. */
export const RULE_NUMBERS = Object.freeze([...new Set(RULE_KEYS.map((k) => RULES[k].rule))].sort((a, b) => a - b));

const NEXT_ATTEMPT = Object.freeze({ '1st': '2nd', '2nd': '3rd', '3rd': '4th & last' });

function possessive(name, fallback = 'the new') {
  return name ? `${name}'s` : fallback;
}
function serviceList(a) {
  const d = detailOf(a);
  const list = Array.isArray(d.service) ? d.service : d.service ? [d.service] : [];
  const named = list.map((s) => (s === 'Other' ? txt(d.service_other) || 'Other' : s)).filter(Boolean);
  return named.length ? named.join(', ') : null;
}
function itemDelivered(a) {
  return (txt(detailOf(a).stage) || 'delivery').toLowerCase();
}
function itemShared(a) {
  const d = detailOf(a);
  const list = Array.isArray(d.elements) ? d.elements : d.elements ? [d.elements] : [];
  const named = list.map((s) => (s === 'Other' ? txt(d.other_text) || 'Other' : s)).filter(Boolean);
  return (named.length ? named.join(', ') : 'items').toLowerCase();
}
const nowOf = (ctx) => (ctx && ctx.now !== undefined ? parseAt(ctx.now) ?? Date.now() : Date.now());

/** The rule definitions a given activity can book, chain stages excluded. */
export function rulesForKind(kind) {
  return RULE_KEYS.filter((k) => !RULES[k].chained && RULES[k].on === kind).map((k) => ({ key: k, ...RULES[k] }));
}

// ------------------------------------------------------------------ booking

/**
 * One reminder per entry per rule.
 *
 * The one exception is the reason this is a function and not a UNIQUE index:
 * a reminder that was AUTO-CLEARED may be booked again — an edit that makes
 * the rule true once more should restore it. A reminder a HUMAN resolved must
 * never come back, or every edit resurrects work they already finished.
 */
export function alreadyBooked(existing, activityId, ruleKey) {
  // Without an entry id there is nothing to be the same entry AS, so nothing
  // is a duplicate. Treating two id-less entries as one would silently drop
  // the second CSR's reminder.
  if (activityId === null || activityId === undefined || activityId === '') return false;
  return (existing || []).some(
    (r) =>
      String(r.rule_key) === ruleKey &&
      String(r.activity_id ?? '') === String(activityId ?? '') &&
      !(r.state === 'resolved' && r.resolution === AUTO_CLEARED)
  );
}

/**
 * What logging this activity books.
 *
 * @param {object} activity  {id, report_id, profile, kind, client, order_ref, detail, at, author}
 * @param {object} ctx       {now, existing, flags}
 *   now      – the clock, epoch ms or any parseAt() value. Defaults to Date.now().
 *   existing – reminders already booked against this entry (for the one-per-rule check).
 *   flags    – {late, disputed, frustrated} about this order, from the caller.
 * @returns {Array} reminder rows ready to INSERT. Empty for spam and for every
 *   other activity that books nothing — that emptiness is a fact, not a failure.
 */
export function rulesFor(activity, ctx = {}) {
  if (!activity || !activity.kind) throw new ReminderError('activity.kind is required', 'NO_KIND');
  if (!ACTIVITY_KIND_KEYS.includes(activity.kind)) {
    throw new ReminderError(`Unknown activity kind: ${activity.kind}`, 'UNKNOWN_KIND');
  }
  // A reminder with no profile is unroutable: it belongs to the profile, and
  // there is nobody to pop it for. Fail here rather than write an orphan.
  const profile = txt(activity.profile, 80);
  if (!profile) throw new ReminderError('activity.profile is required — reminders are profile-scoped', 'NO_PROFILE');

  const now = nowOf(ctx);
  const bookedAt = parseAt(activity.at) ?? now;
  const existing = ctx.existing || [];

  const out = [];
  for (const def of rulesForKind(activity.kind)) {
    if (def.when && !def.when(activity, ctx)) continue;
    if (alreadyBooked(existing, activity.id, def.key)) continue;
    const minutes = def.delay(activity, { ...ctx, now: bookedAt });
    if (!Number.isFinite(minutes)) {
      throw new ReminderError(`Rule ${def.rule} produced no delay for ${activity.kind}`, 'NO_DELAY');
    }
    out.push(draft(def, activity, profile, bookedAt + minutes * 60_000));
  }
  return out;
}

function draft(def, activity, profile, dueMs) {
  const client = clientName(activity);
  return {
    report_id: activity.report_id ?? null,
    activity_id: activity.id ?? null,
    rule: def.rule,
    rule_key: def.key,
    chain_step: def.chain_step ?? 1,
    profile,
    client,
    client_key: client ? buyerKey(client) : null,
    order_ref: orderRefOf(activity),
    due_at: toSqlUtc(dueMs),
    heading: def.heading(activity),
    body: def.body ? def.body(activity) : null,
    alert: def.alert ? 1 : 0,
    state: 'pending',
    resolution: null,
    snoozed_until: null,
    resolved_by: null,
    resolved_at: null,
    booked_by: txt(activity.author, 80),
  };
}

// -------------------------------------------------------------- what shows

export const isAlert = (reminder) => Boolean(reminder?.alert) || Boolean(RULES[reminder?.rule_key]?.alert);

/** Red alerts have no snooze. That is the whole difference between a caution
 *  box and a reminder card, and it is checked here rather than in the view. */
export const canSnooze = (reminder) => !isAlert(reminder);

/** The buttons this reminder shows, in order. Snooze is appended by this
 *  function so no rule can omit it and no alert can acquire one. */
export function buttonsFor(reminder) {
  const def = RULES[reminder?.rule_key];
  if (!def) throw new ReminderError(`Unknown rule_key: ${reminder?.rule_key}`, 'UNKNOWN_RULE');
  return def.alert ? [...def.buttons] : [...def.buttons, SNOOZE_BUTTON];
}

/** Is this one on screen right now? Persistent by design: once due it stays
 *  due, however long ago, until somebody resolves it. */
export function isDue(reminder, now = Date.now()) {
  if (!reminder || reminder.state === 'resolved') return false;
  const t = nowOf({ now });
  const due = parseAt(reminder.due_at);
  if (due === null || due > t) return false;
  const snoozed = parseAt(reminder.snoozed_until);
  return !(snoozed !== null && snoozed > t);
}

/**
 * What shows now, for a profile's queue.
 *
 * Alerts first — they are standing caution boxes and outrank any card — then
 * oldest due first, so the most overdue thing is the thing at the top.
 */
export function due(reminders, now = Date.now()) {
  const t = nowOf({ now });
  return (reminders || [])
    .filter((r) => isDue(r, t))
    .sort((a, b) => {
      const alertDiff = Number(isAlert(b)) - Number(isAlert(a));
      if (alertDiff) return alertDiff;
      return (parseAt(a.due_at) ?? 0) - (parseAt(b.due_at) ?? 0);
    });
}

/** Split what is due into the red boxes and the ordinary cards. */
export function partitionDue(reminders, now = Date.now()) {
  const list = due(reminders, now);
  return { alerts: list.filter(isAlert), cards: list.filter((r) => !isAlert(r)) };
}

/** Booked, not yet due — the "scheduled" column of the CEO ledger. */
export function scheduled(reminders, now = Date.now()) {
  const t = nowOf({ now });
  return (reminders || [])
    .filter((r) => r.state !== 'resolved' && !isDue(r, t))
    .sort((a, b) => (parseAt(a.due_at) ?? 0) - (parseAt(b.due_at) ?? 0));
}

// ------------------------------------------------------- state transitions

/** The undo token every transition returns. Five seconds, then it is final. */
function undoToken(previous, booked, label, now) {
  return Object.freeze({
    label,
    at: now,
    expires_at: now + UNDO_WINDOW_MS,
    reminder: previous,
    booked: booked || null,
  });
}

export const undoable = (token, now = Date.now()) => Boolean(token) && nowOf({ now }) <= token.expires_at;

/**
 * Take back a resolve / snooze / chain advance.
 * @returns {{reminder: object, cancel: Array}} the row to write back, and any
 *   chain stage booked by the action that must be cancelled with it.
 */
export function applyUndo(token, now = Date.now()) {
  if (!token) throw new ReminderError('Nothing to undo', 'NO_UNDO');
  if (!undoable(token, now)) {
    throw new ReminderError('The 5-second undo window has passed', 'UNDO_EXPIRED');
  }
  return { reminder: token.reminder, cancel: token.booked ? [token.booked] : [] };
}

function assertOpen(reminder) {
  if (!reminder) throw new ReminderError('No reminder given', 'NO_REMINDER');
  if (reminder.state === 'resolved') {
    throw new ReminderError('That reminder is already resolved', 'ALREADY_RESOLVED');
  }
}

/**
 * Snooze. Five minutes by default; rule 3's "Next shift" passes 8 hours.
 * Refuses on a red alert — frustrated and disputed do not go away for a while.
 */
export function snooze(reminder, { now = Date.now(), minutes = SNOOZE_MINUTES } = {}) {
  assertOpen(reminder);
  if (!canSnooze(reminder)) {
    throw new ReminderError('A red alert cannot be snoozed — only Solved clears it', 'SNOOZE_FORBIDDEN');
  }
  const t = nowOf({ now });
  const next = { ...reminder, state: 'snoozed', snoozed_until: toSqlUtc(t + minutes * 60_000) };
  return { reminder: next, booked: null, undo: undoToken(reminder, null, 'Snoozed', t) };
}

/**
 * Resolve with the button a CSR tapped.
 *
 * Three button kinds, one function, because the CSR taps one row of buttons
 * and should not care which kind it was:
 *   resolve  closes it, recording WHICH button as the resolution
 *   snooze   re-books it that far out (rule 3's "Next shift", or Snooze itself)
 *   chain    closes it AND books the next stage, timed from this tap
 *
 * @returns {{reminder, booked, undo}} booked is the next chain stage or null.
 */
export function resolve(reminder, buttonKey, { now = Date.now(), by = null } = {}) {
  assertOpen(reminder);
  const button = buttonsFor(reminder).find((b) => b.key === buttonKey);
  if (!button) {
    throw new ReminderError(`Rule ${reminder.rule} has no button "${buttonKey}"`, 'UNKNOWN_BUTTON');
  }
  const t = nowOf({ now });

  if (button.kind === 'snooze') return snooze(reminder, { now: t, minutes: button.minutes ?? SNOOZE_MINUTES });

  const next = {
    ...reminder,
    state: 'resolved',
    resolution: button.key,
    resolved_by: txt(by, 80),
    resolved_at: toSqlUtc(t),
    snoozed_until: null,
  };

  let booked = null;
  if (button.kind === 'chain') {
    const stage = RULES[button.next];
    if (!stage) throw new ReminderError(`Chain button points at unknown rule ${button.next}`, 'UNKNOWN_RULE');
    // The next stage is timed FROM THE TAP, not from the original offer.
    booked = draft(
      { key: button.next, ...stage },
      {
        id: reminder.activity_id,
        report_id: reminder.report_id,
        profile: reminder.profile,
        client: reminder.client,
        order_ref: reminder.order_ref,
        detail: {},
        author: by,
      },
      reminder.profile,
      t + stage.delay() * 60_000
    );
    // The chain carries the original wording forward; the offer's scope and
    // value live on the entry, not on this tap.
    booked.body = reminder.body;
  }

  return { reminder: next, booked, undo: undoToken(reminder, booked, button.label, t) };
}

// ----------------------------------------------------------- auto-clearing

function matches(rule, reminder, activity) {
  if (reminder.profile !== txt(activity.profile, 80)) return false;
  const key = buyerKey(clientName(activity));
  const ref = orderRefOf(activity);
  switch (rule.cancelBy) {
    case 'order_ref':
      // The trigger has no buyer of its own (an assignment is keyed by project).
      // With no project there is nothing to confirm against, so nothing clears.
      return Boolean(ref) && reminder.order_ref === ref;
    case 'both':
      return Boolean(key) && Boolean(ref) && reminder.client_key === key && reminder.order_ref === ref;
    default:
      return Boolean(key) && reminder.client_key === key;
  }
}

/**
 * Logging an activity can make a pending reminder pointless — they converted,
 * the upsell happened, the review already landed, the client came back with a
 * revision. Those clear themselves rather than asking a CSR to close work they
 * never needed to do.
 *
 * Recorded as resolution 'auto_cleared', which is also the one resolution an
 * edit may re-book over.
 *
 * @returns {Array<{reminder, previous, rule_key}>} rows to write back.
 */
export function autoClears(activity, reminders, { now = Date.now(), by = null } = {}) {
  const t = nowOf({ now });
  const out = [];
  for (const r of reminders || []) {
    if (r.state === 'resolved') continue;
    const rule = RULES[r.rule_key];
    if (!rule || rule.cancelOn !== activity.kind) continue;
    if (!matches(rule, r, activity)) continue;
    out.push({
      rule_key: r.rule_key,
      previous: r,
      reminder: {
        ...r,
        state: 'resolved',
        resolution: AUTO_CLEARED,
        resolved_by: txt(by, 80),
        resolved_at: toSqlUtc(t),
        snoozed_until: null,
      },
    });
  }
  return out;
}

/**
 * Editing an entry re-checks its rules.
 *
 * A threshold newly met books the reminder; one no longer met clears it; one
 * still met has its wording brought back into step, because a reminder naming
 * the wrong buyer is worse than none. Resolved reminders are left alone —
 * re-opening finished work is not a correction.
 *
 * @returns {{book: Array, clear: Array, update: Array}}
 */
export function recheck(activity, reminders, ctx = {}) {
  const mine = (reminders || []).filter((r) => String(r.activity_id ?? '') === String(activity.id ?? ''));
  const now = nowOf(ctx);
  const book = [];
  const clear = [];
  const update = [];

  for (const def of rulesForKind(activity.kind)) {
    const open = mine.find((r) => r.rule_key === def.key && r.state !== 'resolved');
    const stillTrue = !def.when || def.when(activity, ctx);

    if (!stillTrue) {
      if (open) {
        clear.push({
          rule_key: def.key,
          previous: open,
          reminder: {
            ...open,
            state: 'resolved',
            resolution: AUTO_CLEARED,
            resolved_by: txt(ctx.by, 80),
            resolved_at: toSqlUtc(now),
          },
        });
      }
      continue;
    }
    if (open) {
      const client = clientName(activity);
      update.push({
        ...open,
        client,
        client_key: client ? buyerKey(client) : null,
        order_ref: orderRefOf(activity),
        heading: def.heading(activity),
        body: def.body ? def.body(activity) : null,
      });
    } else if (!alreadyBooked(mine, activity.id, def.key)) {
      book.push(...rulesFor({ ...activity, kind: activity.kind }, { ...ctx, existing: mine }).filter((d) => d.rule_key === def.key));
    }
  }
  return { book, clear, update };
}

export default {
  RULES,
  RULE_KEYS,
  RULE_NUMBERS,
  ACTIVITY_KINDS,
  ACTIVITY_KIND_KEYS,
  SNOOZE_MINUTES,
  SNOOZE_BUTTON,
  UNDO_WINDOW_MS,
  AUTO_CLEARED,
  ORDER_TYPES,
  ORDER_ROUTES,
  FOLLOWUP_ATTEMPTS,
  ReminderError,
  rulesFor,
  rulesForKind,
  alreadyBooked,
  due,
  isDue,
  partitionDue,
  scheduled,
  buttonsFor,
  isAlert,
  canSnooze,
  snooze,
  resolve,
  autoClears,
  recheck,
  applyUndo,
  undoable,
  parseAt,
  toSqlUtc,
  parseRemindIn,
  ratingAverage,
  reviewAskAllowed,
  buyerKey,
  activityLabel,
};
