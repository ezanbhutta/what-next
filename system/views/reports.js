// views/reports.js, the CSR half of Reports: a shift, logged from a phone.
//
// WHAT THIS VIEW IS
//
//   The shift logger, rebuilt inside the hub. A CSR opens a shift against a
//   profile, logs what happened as it happens, works the reminders that
//   earlier entries booked, and closes with a note for whoever is next.
//
//   The authority for the reminder behaviour is the owner-written spec,
//   shift-logger/REMINDER-LOGICS.md, thirteen rules, their exact delays and
//   their exact buttons. `RULES` below is that document as data. When the two
//   disagree the document is right and this file is the bug.
//
// WHAT LEADS THE PAGE
//
//   What is DUE NOW, and above even that, the clients who must be handled
//   with care. A CSR opens this mid-shift, on a phone, with a buyer waiting in
//   another tab. The log form is the second thing on the page, not the first,
//   because nothing typed into it is more urgent than a dispute already open.
//
// THE ORIGINAL'S SECURITY MODEL IS NOT REPRODUCED
//
//   The shift logger talked to Supabase from the browser under a wide-open
//   anon policy: anyone holding the publishable key could DELETE every report.
//   Here every write is a POST to this server, through auditedWrite, with the
//   credentials never leaving it. There is no key in the page to steal.
//
// HOUSE RULES THIS FILE IS CARRYING
//
//   R2  Counts are counts. When a read fails the number is MISSING, never 0.
//       "Nothing due" and "we could not ask" are different facts and this page
//       never prints the first when it means the second, that exact bug is
//       what the original shipped, and an all-clear during an outage is the
//       most expensive false statement this section can make.
//   R3  Nothing here is a rate, so nothing here draws a bar or an arrow. The
//       shift tallies are a census of one shift, stated as counts.
//   R4  The retired programme is never named. The order-type control offers
//       Organic and Directed, and `esc()` scrubs anything that gets past that.
//   R6  A review ask never rides on a late or disputed order. Rule 5 of the
//       spec books "ask for a Public Review" 30 minutes after completion; this
//       page HOLDS that reminder, visibly, with the reason and the order's
//       age, whenever the buyer is on the stale-order list or carries an open
//       dispute, and holds it too when the flag list itself could not be read.
//       See `reviewHold`. The reminder is never silently deleted and never
//       silently obeyed.
//   R7  The figure leads. Reasoning goes in the `<details>` underneath it.
//   R9  Inputs are 16px by app.css. Every control here is a `.btn`,
//       `.btn--sm`, `.check-row` or `.field`, all of which are ≥44px on a
//       coarse pointer. No table, so nothing scrolls sideways at 375px.

import { normaliseBuyer } from '../lib/reconcile.js';
import { deskNow, clock } from '../lib/roster.js';

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
  empty,
  known,
} from './layout.js';

// ============================================================================
// 1. THE SHIFT
// ============================================================================

export const SHIFTS = [
  { key: 'Morning', label: 'Morning', time: '9am – 5pm' },
  { key: 'Evening', label: 'Evening', time: '5pm – 1am' },
  { key: 'Night', label: 'Night', time: '1am – 9am' },
];

export const SHIFT_KEYS = SHIFTS.map((s) => s.key);

/** The wrap-up checklist. `id` is the POST value; the label is what is read. */
export const CHECKLIST = [
  { id: 'crm_updated', label: 'CRM updated', count: true },
  { id: 'clickup_cleared', label: 'ClickUp cleared' },
  { id: 'portfolio_updated', label: 'Portfolio updated', count: true },
  { id: 'briefs_created', label: 'Briefs created', count: true },
  { id: 'analytics_checked', label: 'Analytics checked' },
  { id: 'orders_checked', label: 'Checked orders one by one' },
];

// ============================================================================
// 2. THE ACTIVITY CATALOGUE
// ============================================================================
//
// `key` is the stored `type` and the value of the `type` POST field. `name` on
// a field is the key it is stored under inside the entry's JSON detail, and it
// is the POST field name, the same string on purpose, so a field added here
// is one line and cannot be mistyped into something the server silently drops.
//
// Field types: text · textarea · segment · multiselect · select · designer ·
// date · datetime · stars.

// `tone` drives the dot on every chip and every timeline row. It is grouped,
// not per-activity, so a new activity inherits its family's colour and no one
// has to pick one. Colour is never the only signal: the label is always there,
// and problems additionally carry a filled dot rather than a hollow one.
const GROUPS = [
  { key: 'inquiries', label: 'Inquiries', tone: 'info' },
  { key: 'orders', label: 'Orders and projects', tone: 'pos' },
  { key: 'revisions', label: 'Revisions', tone: 'accent' },
  { key: 'deliveries', label: 'Sharing and deliveries', tone: 'info' },
  { key: 'followups', label: 'Follow-ups and sales', tone: 'warn' },
  { key: 'meetings', label: 'Meetings', tone: 'accent' },
  { key: 'problems', label: 'Problems and other', tone: 'neg' },
];

const TONE_OF = Object.fromEntries(GROUPS.map((g) => [g.key, g.tone]));

/** The dot beside an activity label. */
function activityDot(key) {
  const a = ACTIVITY_BY_KEY[key];
  const tone = a ? TONE_OF[a.group] || 'accent' : 'accent';
  return `<span class="act-dot act-dot--${tone}" aria-hidden="true"></span>`;
}

const SERVICES = [
  'Logo Design',
  'Social Media Kit',
  'Stationery Design Kit',
  'Brand Guideline',
  'Logo Animation',
  'PowerPoint Deck',
  'Packaging',
  'Website Design',
  'Post Design',
  'Marketing Materials',
  'Canva',
  'Other',
];

const SHARE_ELEMENTS = [
  'Initial draft',
  'Revision',
  'Final files',
  'Brand guidelines',
  'Social media kit',
  'Stationery',
  'Animation',
  'PowerPoint',
  'Website contents',
  'Other',
];

const ATTEMPTS = ['1st', '2nd', '3rd', '4th+'];

export const ACTIVITIES = [
  {
    key: 'inquiry',
    label: 'New inquiry',
    group: 'inquiries',
    fields: [
      { name: 'client', label: 'Fiverr username', type: 'text', required: true },
      { name: 'agenda', label: 'What they want', type: 'text' },
    ],
  },
  {
    key: 'lead_followup',
    label: 'Lead follow-up',
    group: 'inquiries',
    fields: [
      { name: 'client', label: 'Name', type: 'text', required: true },
      { name: 'attempt', label: 'Which follow-up was this?', type: 'segment', options: ATTEMPTS, required: true },
    ],
  },
  {
    key: 'client_conversation',
    label: 'Client conversation',
    group: 'inquiries',
    fields: [
      { name: 'client', label: 'Client', type: 'text', required: true },
      { name: 'kind', label: 'New or existing client', type: 'segment', options: ['New', 'Existing'], required: true },
      { name: 'note', label: 'What was discussed, and how you guided them', type: 'textarea' },
    ],
  },

  {
    key: 'new_order',
    label: 'New order',
    group: 'orders',
    fields: [
      { name: 'client', label: 'Client', type: 'text', required: true },
      { name: 'project', label: 'Project name', type: 'text' },
      {
        name: 'order_via',
        label: 'How the order came in',
        type: 'segment',
        options: ['Via Chat', 'Direct Order'],
        required: true,
        hint: 'A Direct Order books the upsell nudge as well. An order taken in chat does not.',
      },
      { name: 'service', label: 'Services, pick any', type: 'multiselect', options: SERVICES },
      { name: 'service_other', label: 'Other service, please specify', type: 'text', hint: 'Only if you ticked Other above.' },
      { name: 'value', label: 'Price', type: 'text', mode: 'decimal' },
    ],
  },
  {
    key: 'order_assigned',
    label: 'Order assigned to designer',
    group: 'orders',
    fields: [
      { name: 'project', label: 'Project name', type: 'text', required: true },
      {
        name: 'order_type',
        label: 'Order type',
        type: 'segment',
        options: ['Organic', 'Directed'],
        required: true,
        hint: 'Directed is the only label this hub uses for non-organic flow, in every section.',
      },
      { name: 'designer', label: 'Designer', type: 'designer', required: true },
      { name: 'due', label: 'Due date', type: 'date' },
    ],
  },
  {
    key: 'files_assigned',
    label: 'Files assigned to designer',
    group: 'orders',
    fields: [
      { name: 'project', label: 'Project name', type: 'text', required: true },
      { name: 'client', label: 'Client name', type: 'text', required: true },
      { name: 'designer', label: 'Designer', type: 'designer', required: true },
    ],
  },
  {
    key: 'order_completed',
    label: 'Order completed',
    group: 'orders',
    fields: [
      { name: 'client', label: 'Client', type: 'text', required: true },
      { name: 'project', label: 'Project name', type: 'text', required: true },
      { name: 'completion', label: 'How was it completed?', type: 'segment', options: ['Auto-completed', 'By client'] },
      { name: 'completed_on', label: 'Completion date', type: 'date' },
      { name: 'value', label: 'Price', type: 'text', mode: 'decimal' },
    ],
  },

  {
    key: 'revision_assigned',
    label: 'Revision assigned to designer',
    group: 'revisions',
    fields: [
      { name: 'client', label: 'Client', type: 'text', required: true },
      { name: 'project', label: 'Project name', type: 'text' },
      { name: 'designer', label: 'Designer', type: 'designer', required: true },
      {
        name: 'remind_in',
        label: 'Remind me in',
        type: 'text',
        placeholder: '30m · 2h · 1.5h',
        pattern: '\\s*\\d+(\\.\\d+)?\\s*[mMhH]\\s*',
        hint: 'A number and m or h. Leave it blank and the check-in is booked 24 hours out.',
      },
    ],
  },

  {
    key: 'project_delivered',
    label: 'Project delivered',
    group: 'deliveries',
    fields: [
      { name: 'client', label: 'Client', type: 'text', required: true },
      { name: 'project', label: 'Project', type: 'text' },
      { name: 'stage', label: 'What was delivered', type: 'segment', options: ['Initial draft', 'Final files'], required: true },
    ],
  },
  {
    key: 'shared',
    label: 'Shared to client in chat',
    group: 'deliveries',
    fields: [
      { name: 'client', label: 'Client or username', type: 'text', required: true },
      { name: 'project', label: 'Project', type: 'text' },
      { name: 'elements', label: 'What did you share? Pick any', type: 'multiselect', options: SHARE_ELEMENTS, required: true },
      { name: 'other_text', label: 'Other, please specify', type: 'text', hint: 'Only if you ticked Other above.' },
    ],
  },

  {
    key: 'followup_client',
    label: 'Follow-up with client',
    group: 'followups',
    fields: [
      { name: 'client', label: 'Client', type: 'text', required: true },
      { name: 'kind', label: 'Client type', type: 'segment', options: ['Ongoing order', 'Past client'], required: true },
      { name: 'project', label: 'Project name', type: 'text' },
      { name: 'reason', label: 'Reason to follow up', type: 'text' },
      { name: 'attempt', label: 'Which follow-up?', type: 'segment', options: ATTEMPTS },
    ],
  },
  {
    key: 'followup_designer',
    label: 'Follow-up with designer',
    group: 'followups',
    fields: [
      { name: 'project', label: 'Project name', type: 'text', required: true },
      { name: 'designer', label: 'Designer', type: 'designer', required: true },
      { name: 'note', label: 'Note', type: 'text' },
    ],
  },
  {
    key: 'update_followup',
    label: 'Update follow-up',
    group: 'followups',
    fields: [
      { name: 'project', label: 'Project name', type: 'text' },
      { name: 'client', label: 'Client name', type: 'text', required: true },
      { name: 'update_type', label: 'Update type', type: 'segment', options: ['Initial Update', 'Files Update'], required: true },
    ],
  },
  {
    key: 'upsell',
    label: 'Upsell',
    group: 'followups',
    fields: [
      { name: 'client', label: 'Client', type: 'text', required: true },
      { name: 'what', label: 'What was upsold', type: 'text', required: true },
      { name: 'kind', label: 'Client', type: 'segment', options: ['New', 'Old'], required: true },
      { name: 'value', label: 'Price', type: 'text', mode: 'decimal' },
    ],
  },
  {
    key: 'offer',
    label: 'Offer',
    group: 'followups',
    fields: [
      { name: 'client', label: 'Client', type: 'text', required: true },
      { name: 'kind', label: 'New or existing client', type: 'segment', options: ['New', 'Existing'] },
      { name: 'scope', label: 'Scope of work', type: 'text' },
      { name: 'value', label: 'Offer value', type: 'text', mode: 'decimal', required: true },
    ],
  },
  {
    key: 'custom_reminder',
    label: 'Custom reminder',
    group: 'followups',
    fields: [
      { name: 'heading', label: 'Reminder heading', type: 'text', required: true },
      { name: 'note', label: 'Note', type: 'textarea' },
      {
        name: 'remind_at',
        label: 'Remind me on',
        type: 'datetime',
        required: true,
        hint: 'Must be in the future. It pops for this profile at that moment, on whoever is covering it.',
      },
    ],
  },
  {
    key: 'review_request',
    label: 'Review request',
    group: 'followups',
    fields: [
      { name: 'client', label: 'Client name', type: 'text', required: true },
      { name: 'project', label: 'Project name', type: 'text' },
      { name: 'review_type', label: 'Review type', type: 'segment', options: ['Public review', 'Private review'], required: true },
    ],
  },
  {
    key: 'review_received',
    label: 'Review received',
    group: 'followups',
    fields: [
      { name: 'client', label: 'Client name', type: 'text', required: true },
      { name: 'project', label: 'Project name', type: 'text' },
      { name: 'value_rating', label: 'Value of delivery', type: 'stars', required: true },
      { name: 'quality_rating', label: 'Quality of delivery', type: 'stars', required: true },
      { name: 'communication_rating', label: 'Seller communication level', type: 'stars', required: true },
    ],
  },

  {
    key: 'meeting',
    label: 'Meeting',
    group: 'meetings',
    fields: [
      { name: 'client', label: 'Client', type: 'text', required: true },
      { name: 'kind', label: 'Type', type: 'segment', options: ['New', 'Old client'], required: true },
      { name: 'agenda', label: 'What it was about', type: 'text', required: true },
    ],
  },

  {
    key: 'frustrated',
    label: 'Frustrated client',
    group: 'problems',
    fields: [
      { name: 'client', label: 'Client', type: 'text', required: true },
      { name: 'what', label: 'What happened', type: 'textarea', required: true },
      { name: 'project', label: 'Project name', type: 'text' },
    ],
  },
  {
    key: 'disputed',
    label: 'Disputed client',
    group: 'problems',
    fields: [
      { name: 'client', label: 'Client', type: 'text', required: true },
      { name: 'reason', label: 'Reason', type: 'textarea', required: true },
      { name: 'project', label: 'Project name', type: 'text' },
    ],
  },
  {
    key: 'extension',
    label: 'Extension sent',
    group: 'problems',
    fields: [
      { name: 'client', label: 'Client', type: 'text', required: true },
      { name: 'reason', label: 'Reason', type: 'text' },
    ],
  },
  {
    key: 'spam',
    label: 'Spam or not relevant',
    group: 'problems',
    fields: [
      { name: 'client', label: 'Username', type: 'text', required: true },
      { name: 'reason', label: 'Reason', type: 'text' },
    ],
  },
];

export const ACTIVITY_BY_KEY = Object.fromEntries(ACTIVITIES.map((a) => [a.key, a]));

/** The six a CSR reaches for most. One tap from the top of the page. */
const QUICK = ['inquiry', 'client_conversation', 'new_order', 'shared', 'revision_assigned', 'followup_client'];

// ============================================================================
// 3. THE THIRTEEN REMINDER RULES
// ============================================================================
//
// REMINDER-LOGICS.md as data, and the ONLY copy of it. `server.js` imports
// this table to book, cancel and chain, it does not keep its own timings.
// Two tables of thirteen delays is precisely the shape of every bug this repo
// exists to referee: they agree on the day they are written and nowhere else.
//
//   on          the activity that books it (a rule id doubles as its trigger)
//   chained     booked ONLY by a chain button, never by logging
//   delay       minutes from the tap/log to due. A number, or a function of
//               the entry. Returning null means "book nothing", the spec's
//               4th lead follow-up, and the rating below the threshold.
//   when        predicate on the entry; the rule only books when it is true
//   whenText    that predicate in the CSR's words
//   afterText   overrides the derived delay prose when the delay is not a
//               constant. Never hand-written where it could be derived.
//   cancelOn    logging THAT activity for the same client (same profile,
//               still pending) auto-clears this reminder
//   cancelKey   'project', match on the project instead of the client, for a
//               trigger that carries no client of its own
//   cancelMatchProject  require client AND project to match
//   note        what to stamp on the reminder as its context line
//   buttons     the resolve buttons, in the spec's order. The key is what the
//               CEO ledger records as the resolution.
//                 kind 'resolve'  closes it with this key
//                 kind 'snooze'   re-books it `minutes` out ("Next shift" 8h)
//                 kind 'chain'    closes it AND books `next`, timed from the tap
//   alert       a standing red caution box, not a card, and NEVER snoozed
//   review      R6 applies, see reviewHold(). The server must apply the same
//               test before booking; this page applies it again at render,
//               because a buyer can dispute an hour AFTER the ask was booked
//               and only the render-side check catches that one.

export const SNOOZE_MINUTES = 5;
const H = (hours) => hours * 60;

/** "Remind me in" free text → minutes. `30m` · `45 m` · `2h` · `1.5h`.
 *  null when it is not that, which the form's own pattern also rejects. */
export function parseRemindTime(value) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([mh])\s*$/i.exec(String(value ?? ''));
  if (!m) return null;
  const n = Number.parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(m[2].toLowerCase() === 'h' ? n * 60 : n);
}

const detail = (entry, key) => (entry && entry.details ? entry.details[key] : undefined);

const FOLLOWUP_BUTTONS = [
  { key: 'in_discussion', label: 'In discussion', kind: 'resolve' },
  { key: 'followed_up', label: 'Followed up', kind: 'resolve' },
  { key: 'order_taken', label: 'Order taken', kind: 'resolve', primary: true },
];

const UPSELL_BUTTONS = [
  { key: 'no_need', label: 'No need', kind: 'resolve' },
  { key: 'upsell_done', label: 'Upsell done', kind: 'resolve', primary: true },
];

const LEAD_DELAY = { '1st': H(12), '2nd': H(24), '3rd': H(48) };
const LEAD_NEXT = { '1st': '2nd follow-up', '2nd': '3rd follow-up', '3rd': '4th & last follow-up' };

export const RULES = {
  // 1
  inquiry: {
    on: 'inquiry',
    delay: 25,
    cancelOn: 'new_order',
    title: (r) => `Send the 1st follow-up to ${who(r)}`,
    buttons: FOLLOWUP_BUTTONS,
  },
  // 2
  lead_followup: {
    on: 'lead_followup',
    delay: (e) => LEAD_DELAY[String(detail(e, 'attempt'))] ?? null,
    afterText: '12 hours after a 1st, 24 after a 2nd, 48 after a 3rd. A 4th books nothing',
    note: (e) => LEAD_NEXT[String(detail(e, 'attempt'))] || '',
    cancelOn: 'new_order',
    title: (r) => `Send the ${r.note || 'next follow-up'} to ${who(r, 'the lead')}`,
    buttons: FOLLOWUP_BUTTONS,
  },
  // 3
  new_order: {
    on: 'new_order',
    delay: 30,
    cancelOn: 'order_assigned',
    cancelKey: 'project',
    title: (r) => `Assign ${possessive(r)} order to a designer`,
    buttons: [
      {
        key: 'next_shift',
        label: 'Next shift',
        kind: 'snooze',
        minutes: 8 * 60,
        hint: 'Will be assigned on the next shift, comes back in 8 hours',
      },
      { key: 'assigned', label: 'Assigned', kind: 'resolve', primary: true, hint: 'Order is with a designer' },
    ],
  },
  // 4
  new_order_upsell: {
    on: 'new_order',
    delay: 0,
    when: (e) => detail(e, 'order_via') === 'Direct Order',
    whenText: 'only for a Direct Order, an order taken in chat books nothing',
    cancelOn: 'upsell',
    title: (r) => `Potential upsell for ${who(r)}, what is missing? Especially a website`,
    buttons: UPSELL_BUTTONS,
  },
  // 5, the rule R6 governs.
  order_completed: {
    on: 'order_completed',
    delay: 30,
    cancelOn: 'review_received',
    review: true,
    title: () => 'Ask the client for a Public Review',
    buttons: [
      { key: 'no_need', label: 'No need', kind: 'resolve' },
      { key: 'msg_sent', label: 'Msg sent', kind: 'resolve' },
      { key: 'review_given', label: 'Review given', kind: 'resolve', primary: true },
    ],
  },
  // 6
  review_received: {
    on: 'review_received',
    delay: H(24),
    when: (e) => {
      const r = Number(detail(e, 'rating'));
      return Number.isFinite(r) && r >= 4.7 && r <= 5;
    },
    whenText: 'only when the average of the three scores is 4.7 to 5.0',
    review: true,
    title: () => 'Ask the client for a Private Review',
    buttons: [{ key: 'msg_sent', label: 'Msg sent', kind: 'resolve', primary: true }],
  },
  // 7
  files_assigned: {
    on: 'files_assigned',
    delay: 0,
    cancelOn: 'upsell',
    title: (r) => `Suggest an upsell to ${who(r)}`,
    buttons: UPSELL_BUTTONS,
  },
  // 8
  revision_assigned: {
    on: 'revision_assigned',
    delay: (e) => parseRemindTime(detail(e, 'remind_in')) ?? H(24),
    afterText: 'the time typed into "Remind me in", blank means 24 hours',
    title: (r) => `Check if ${possessive(r)} revision is done`,
    buttons: [
      { key: 'followup_done', label: 'Follow-up done', kind: 'resolve', hint: 'Checked in with the designer' },
      { key: 'revision_done', label: 'Revision done', kind: 'resolve', primary: true, hint: 'The revision is finished' },
    ],
  },
  // 9, a chain. Each stage is booked only when its button is tapped, and its
  // timer starts from that tap, not from the offer.
  offer: {
    on: 'offer',
    delay: H(2),
    cancelOn: 'new_order',
    title: (r) => `Send the 1st follow-up on the offer to ${who(r)}`,
    buttons: [
      { key: 'order_placed', label: 'Order placed', kind: 'resolve', primary: true, hint: 'Offer converted, the chain ends' },
      { key: 'fu1_done', label: '1st F/U done', kind: 'chain', next: 'offer_fu2', hint: 'Books the 2nd follow-up, 16 hours from now' },
    ],
  },
  offer_fu2: {
    on: 'offer',
    chained: true,
    delay: H(16),
    afterText: '16 hours from the tap that booked it',
    cancelOn: 'new_order',
    title: (r) => `Send the 2nd follow-up on the offer to ${who(r)}`,
    buttons: [
      { key: 'order_placed', label: 'Order placed', kind: 'resolve', primary: true, hint: 'Offer converted, the chain ends' },
      { key: 'fu2_done', label: '2nd F/U done', kind: 'chain', next: 'offer_fu3', hint: 'Books the 3rd follow-up, 36 hours from now' },
    ],
  },
  offer_fu3: {
    on: 'offer',
    chained: true,
    delay: H(36),
    afterText: '36 hours from the tap that booked it',
    cancelOn: 'new_order',
    title: (r) => `Send the 3rd follow-up on the offer to ${who(r)}`,
    buttons: [
      { key: 'order_placed', label: 'Order placed', kind: 'resolve', primary: true, hint: 'Offer converted' },
      { key: 'fu3_done', label: '3rd F/U done', kind: 'resolve', hint: 'The chain ends here, no more reminders for this offer' },
    ],
  },
  // 10
  project_delivered: {
    on: 'project_delivered',
    delay: H(15),
    cancelOn: 'revision_assigned',
    cancelMatchProject: true,
    note: (e) => String(detail(e, 'stage') || ''),
    title: (r) => `Follow up on the ${lower(r.note, 'delivery')} delivered to ${who(r)}`,
    buttons: [
      { key: 'responded', label: 'Responded', kind: 'resolve', hint: 'The client already replied' },
      { key: 'followed_up', label: 'Followed up', kind: 'resolve', primary: true },
    ],
  },
  shared: {
    on: 'shared',
    delay: H(15),
    cancelOn: 'revision_assigned',
    cancelMatchProject: true,
    note: (e) => {
      const picked = detail(e, 'elements');
      const list = Array.isArray(picked) ? picked : picked ? [picked] : [];
      const other = String(detail(e, 'other_text') || '').trim();
      return list.map((x) => (x === 'Other' && other ? other : x)).join(', ');
    },
    title: (r) => `Follow up on the ${lower(r.note, 'items')} shared with ${who(r)}`,
    buttons: [
      { key: 'responded', label: 'Responded', kind: 'resolve', hint: 'The client already replied' },
      { key: 'followed_up', label: 'Followed up', kind: 'resolve', primary: true },
    ],
  },
  // 11
  frustrated: {
    on: 'frustrated',
    alert: true,
    delay: 0,
    note: (e) => String(detail(e, 'what') || ''),
    title: (r) => `${who(r, 'A client')} is frustrated, handle with caution`,
    buttons: [{ key: 'solved', label: 'Solved', kind: 'resolve', primary: true, hint: 'Client calmed, issue fixed, removes the caution' }],
  },
  // 12
  disputed: {
    on: 'disputed',
    alert: true,
    delay: 0,
    note: (e) => String(detail(e, 'reason') || ''),
    title: (r) => `${possessive(r, 'A client')} dispute is OPEN, on the verge of cancelling, treat cautiously`,
    buttons: [{ key: 'solved', label: 'Solved', kind: 'resolve', primary: true, hint: 'Dispute closed, removes the caution' }],
  },
  // 13
  custom_reminder: {
    on: 'custom_reminder',
    // The only rule whose due time is absolute. It is still expressed as a
    // delay so the server has one code path; a time already past returns null
    // and books nothing, which is what the form's own future-only rule says.
    delay: (e) => {
      const t = Date.parse(String(detail(e, 'remind_at') ?? ''));
      if (!Number.isFinite(t)) return null;
      const mins = Math.round((t - Date.now()) / 60000);
      return mins > 0 ? mins : null;
    },
    afterText: 'the date and time you pick',
    heading: (e) => String(detail(e, 'heading') || ''),
    note: (e) => String(detail(e, 'note') || ''),
    title: (r) => r.heading || 'Reminder',
    buttons: [{ key: 'done', label: 'Done', kind: 'resolve', primary: true }],
  },
};

/**
 * The delay prose, derived from the delay wherever it is a constant so the
 * two cannot drift. A rule whose delay depends on the entry states its own
 * `afterText`, which is the only case where the sentence is hand-written.
 */
export function afterText(rule) {
  if (!rule) return null;
  if (rule.afterText) return rule.afterText;
  const m = rule.delay;
  if (typeof m !== 'number') return null;
  if (m === 0) return 'immediately';
  if (m < 60) return `${m} minutes`;
  const hours = m / 60;
  return hours === 1 ? '1 hour' : `${hours} hours`;
}

/**
 * Every rule an activity triggers by being logged. A rule id doubles as its
 * trigger unless it sets `on`; chain stages are booked only by a chain button
 * and never by logging, which is why they are filtered out here and not at
 * each call site.
 */
export function rulesTriggeredBy(activityType) {
  return Object.entries(RULES).filter(([, rule]) => !rule.chained && rule.on === activityType);
}

/** A reminder row whose rule is gone, an older rule set, or a renamed key.
 *  It still has to be clearable, so it gets a stated fallback rather than a
 *  row with no way out of it. */
const ORPHAN_RULE = {
  on: null,
  after: null,
  title: (r) => r.heading || 'Follow up',
  orphan: true,
  buttons: [{ key: 'closed', label: 'Close it', kind: 'resolve', primary: true }],
};

const ruleFor = (rem) => RULES[String(rem?.rule ?? '')] || ORPHAN_RULE;

/**
 * WHAT A REMINDER IS CALLED, the stored heading, always.
 *
 * `lib/reminders.js` writes `heading` at booking time from the entry's own
 * detail, and that string is what REMINDER-LOGICS.md specifies, what the audit
 * row carries, and what the owner's ledger prints. Re-deriving it here from the
 * columns that survived into the queue produced a DIFFERENT sentence on four of
 * the thirteen rules, because the two rule tables were written from the same
 * spec on different days:
 *
 *   rule 2   the engine books "Send the 2nd follow-up" after a 1st is logged;
 *            this file rebuilt it from `note`, the engine's `body` column,
 *            which reads "1st follow-up logged", and told the CSR to send the
 *            1st again. The wrong follow-up, on the rule whose entire content
 *            is which follow-up comes next.
 *   rules 5,6 hardcoded "the client" and dropped the buyer the engine had.
 *   rule 10  printed the project name where the delivered ITEM belongs
 *            ("the india draft" for what was booked as "the initial draft").
 *
 * A card is a title plus buttons; if the title can drift from the rule that
 * booked it, the buttons are answering a different question than the sentence
 * above them. So the rule table keeps its delays, buttons and prose, the
 * things the log form needs before a reminder exists, and stops being a second
 * opinion about what an existing one says. `title()` is the fallback for a row
 * with no heading, which the NOT NULL column means is only ever an orphan.
 */
function titleOf(rem) {
  const stored = String(rem?.heading ?? '').trim();
  return stored || ruleFor(rem).title(rem);
}

function who(rem, fallback = 'the client') {
  const name = String(rem?.client ?? '').trim();
  return name || fallback;
}

function possessive(rem, fallback = 'the') {
  const name = String(rem?.client ?? '').trim();
  return name ? `${name}’s` : fallback === 'the' ? 'the' : `${fallback}’s`;
}

function lower(value, fallback) {
  const s = String(value ?? '').trim();
  return s ? s.toLowerCase() : fallback;
}

/** What logging this activity will book. Read off RULES so the form and the
 *  reminder can never describe different behaviour. */
function booksFor(activityKey) {
  return rulesTriggeredBy(activityKey).map(([id, rule]) => ({
    id,
    after: afterText(rule),
    when: rule.whenText || null,
    alert: Boolean(rule.alert),
  }));
}

// ============================================================================
// 4. SMALL HELPERS
// ============================================================================

/** A q() result → rows array, `null` on outage, `undefined` when not loaded.
 *  The three are different facts and this page never collapses them. */
function rowsOf(result) {
  if (!result) return undefined;
  return result.ok ? result.rows || [] : null;
}

function firstRow(result) {
  const rows = rowsOf(result);
  return Array.isArray(rows) ? rows[0] || null : rows;
}

function toMs(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  const t = Date.parse(String(value).replace(' ', 'T'));
  return Number.isFinite(t) ? t : null;
}

/**
 * How long a reminder has been waiting. The phrasing is deliberate: the
 * reminder waits, it is not overdue. Time is information here, never an
 * accusation, and a CSR reading a red "3h LATE" mid-shift starts hiding work
 * from the log rather than logging it.
 *
 * Returns null rather than a guess when either clock is unreadable.
 */
function waitedFor(due, now) {
  const a = toMs(due);
  const b = toMs(now);
  if (a === null || b === null) return null;
  const mins = Math.floor((b - a) / 60000);
  if (mins < 1) return 'ready now';
  if (mins < 60) return `waiting ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `waiting ${hours}h`;
  return `waiting ${Math.floor(hours / 24)}d`;
}

/** Clock time, for "comes back at 4:35pm". PKT is the team's clock. */
function clockPKT(value) {
  const ms = toMs(value);
  if (ms === null) return null;
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Karachi',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(new Date(ms));
  } catch {
    return null;
  }
}

const activityLabel = (key) => ACTIVITY_BY_KEY[String(key ?? '')]?.label || null;

/** The one-line context under a reminder's title. Nothing invented: every
 *  part is omitted when it is absent rather than filled with a placeholder.
 *
 *  `note` is the engine's `body`, and several rules already open it with the
 *  order ref, rule 7's is "Foxtrot Set · Designer: Nadir". Printing the
 *  generic `Project:` part as well read "Project: Foxtrot Set · Foxtrot Set ·
 *  Designer: Nadir", which looks like two different projects at a glance. The
 *  note is the rule's own sentence and wins; the generic part fills in only
 *  where the rule left the project out. */
function reminderMeta(rem, rule) {
  const note = String(rem.note ?? '').trim();
  const project = String(rem.project ?? '').trim();
  const noteNamesProject =
    project !== '' &&
    note
      .split('·')
      .map((s) => s.trim())
      .includes(project);

  const bits = [
    rule.on ? activityLabel(rule.on) : null,
    rem.client || null,
    project && !noteNamesProject ? `Project: ${project}` : null,
    note || null,
  ].filter(Boolean);
  return bits;
}

// ============================================================================
// 5. R6. THE REVIEW-ASK REFEREE
// ============================================================================
//
// Rule 5 of the spec books a Public Review ask 30 minutes after an order is
// completed, and rule 6 of this hub forbids a review ask on a late or disputed
// order. Both are right. They collide on exactly one buyer at a time, and this
// is where the collision is settled.
//
// `flagged` is a map from the join key (the normalised Fiverr username) to the
// reason that buyer must not be asked, a stale order out of the engine's
// recovery block, or an open dispute logged on this very page. A HELD reminder
// still shows: it is named, the reason is stated with the order's age, and it
// can be closed without the ask. It is never deleted (the CSR would never know
// the completion was logged) and never obeyed (the whole point).
//
// The third state is the one that matters most. When `flagged` is null the
// list could not be read at all, and every review ask is held: a review ask we
// cannot prove is safe is precisely the one this rule exists for.

function reviewHold(rem, rule, flagged) {
  if (!rule.review) return null;
  if (flagged === null || flagged === undefined) {
    return { unknown: true };
  }
  const key = normaliseBuyer(rem.client);
  if (!key) return null;
  return flagged.get(key) || null;
}

function holdReason(hold) {
  if (!hold) return '';
  if (hold.unknown) {
    return html`The late-and-disputed list could not be read, so the hub cannot prove this buyer is safe to
      ask. It holds the ask rather than guessing. This is MISSING, not "clear".`;
  }
  const reason = String(hold.reason || '').toLowerCase();
  if (reason === 'disputed') {
    return html`This buyer has an open dispute logged on ${dateShort(hold.since)}. A review ask into an open
      dispute is how a private complaint becomes a public one.`;
  }
  if (reason === 'frustrated') {
    return html`This buyer is flagged frustrated, logged on ${dateShort(hold.since)} and not yet marked
      solved. Ask after it is solved, not before.`;
  }
  return html`This buyer has an order open ${days(hold.age_days)}${known(hold.amount) ? html` at ${money(hold.amount)}` : ''}, which
    is one of the stale orders counted on Today. A review ask on a late delivery is the most reliable way to
    turn a private three-star into a public one.`;
}

// ============================================================================
// 6. FORM FIELDS
// ============================================================================

const fieldId = (activityKey, name) => `f-${activityKey}-${name}`;

function fieldBlock(activity, field) {
  const id = fieldId(activity.key, field.name);
  const req = field.required ? html`<span class="req" aria-hidden="true">*</span>` : '';
  const hint = field.hint ? html`<p class="field-hint">${field.hint}</p>` : '';
  const required = field.required && field.type !== 'multiselect' ? safe('required') : '';

  if (field.type === 'segment' || field.type === 'multiselect') {
    const multi = field.type === 'multiselect';
    return html`<fieldset class="field">
        <legend class="field-label">${field.label} ${req}</legend>
        ${join(
          (field.options || []).map(
            (opt, i) => html`<label class="check-row">
              <input type="${multi ? 'checkbox' : 'radio'}" name="${field.name}"
                     value="${opt}"
                     ${safe(!multi && field.required && i === 0 ? 'required' : '')}>
              <span class="check-label">${opt}</span>
            </label>`
          )
        )}
        ${hint}
      </fieldset>`;
  }

  if (field.type === 'stars') {
    return html`<div class="field">
        <label for="${id}">${field.label} ${req}</label>
        <select id="${id}" name="${field.name}" ${required}>
          <option value="">Not given</option>
          ${join([5, 4, 3, 2, 1].map((n) => html`<option value="${String(n)}">${String(n)} of 5</option>`))}
        </select>
        ${hint}
      </div>`;
  }

  if (field.type === 'designer') {
    // A free-text name with a datalist rather than a closed select: the design
    // roster lives in another system, and a select built from a stale copy of
    // it silently blocks a real designer from being recorded.
    return html`<div class="field">
        <label for="${id}">${field.label} ${req}</label>
        <input id="${id}" name="${field.name}" type="text" list="reports-designers"
               autocomplete="off" spellcheck="false" ${required}>
        ${hint}
      </div>`;
  }

  if (field.type === 'textarea') {
    return html`<div class="field">
        <label for="${id}">${field.label} ${req}</label>
        <textarea id="${id}" name="${field.name}" rows="3" ${required}></textarea>
        ${hint}
      </div>`;
  }

  const type = field.type === 'date' ? 'date' : field.type === 'datetime' ? 'datetime-local' : 'text';
  const mode = field.mode ? html` inputmode="${field.mode}"` : '';
  const placeholder = field.placeholder ? html` placeholder="${field.placeholder}"` : '';
  const pattern = field.pattern ? html` pattern="${field.pattern}"` : '';

  return html`<div class="field">
      <label for="${id}">${field.label} ${req}</label>
      <input id="${id}" name="${field.name}" type="${type}"${mode}${placeholder}${pattern}
             autocomplete="off" spellcheck="false" ${required}>
      ${hint}
    </div>`;
}

/** The chooser. Six chips for the six that get used, then the whole catalogue
 *  behind one disclosure, so the common case is one tap and the rare case is
 *  two, and neither buries the reminders above it. */
function activityChooser(open) {
  const link = (key) => `/reports?log=${encodeURIComponent(key)}`;

  const quick = html`<div class="segment" role="group" aria-label="Log an activity">
      ${join(
        QUICK.map((key) => {
          const a = ACTIVITY_BY_KEY[key];
          if (!a) return '';
          return html`<a href="${safe(link(key))}" ${safe(open === key ? 'aria-current="true"' : '')}>${safe(activityDot(key))}${a.label}</a>`;
        })
      )}
    </div>`;

  const all = join(
    GROUPS.map((g) => {
      const items = ACTIVITIES.filter((a) => a.group === g.key);
      if (!items.length) return '';
      return html`<p class="eyebrow" style="margin-top:14px">${g.label}</p>
        <div class="segment" role="group" aria-label="${g.label}">
          ${join(
            items.map(
              (a) => html`<a href="${safe(link(a.key))}" ${safe(open === a.key ? 'aria-current="true"' : '')}>${safe(activityDot(a.key))}${a.label}</a>`
            )
          )}
        </div>`;
    })
  );

  return html`${quick}${why(`All ${ACTIVITIES.length} activities`, all)}`;
}

function activityForm(activity, { csrfToken, reportId, backTo }) {
  const books = booksFor(activity.key);
  const bookNote = books.length
    ? html`<p class="caption">
        Saving this books
        ${join(
          books.map(
            (b) => html`<strong>${b.alert ? 'a standing caution' : 'a reminder'}</strong>, ${b.after || missing('when')}${b.when ? html`, ${b.when}` : ''}`
          ),
          ', and '
        )}. It belongs to the profile, so it pops for whoever is covering it, on any shift.
      </p>`
    : html`<p class="caption">This one books no reminder. It is logged for the record.</p>`;

  return html`<form method="post" action="/reports/activity">
      <input type="hidden" name="_csrf" value="${csrfToken}">
      ${reportId === null || reportId === undefined
        ? ''
        : html`<input type="hidden" name="report_id" value="${String(reportId)}">`}
      <input type="hidden" name="type" value="${activity.key}">
      <input type="hidden" name="back" value="${backTo}">
      <fieldset class="form-section">
        <legend>${activity.label}</legend>
        ${bookNote}
        <div class="form-grid">${join(activity.fields.map((f) => fieldBlock(activity, f)))}</div>
        ${activity.key === 'review_received'
          ? html`<p class="caption">
              The overall rating is the average of the three scores and is computed on save. It is never
              typed, so it cannot disagree with the scores it comes from. An average of 4.7 to 5.0 books the
              private-review ask 24 hours later; anything lower books nothing.
            </p>`
          : ''}
      </fieldset>
      <div class="form-actions">
        <button class="btn" type="submit">Save this entry</button>
        <a class="btn btn--ghost" href="${backTo}">Cancel</a>
        <span class="form-status">Nothing is stored until you save.</span>
      </div>
    </form>`;
}

// ============================================================================
// 7. THE RED CAUTION BLOCK
// ============================================================================
//
// Frustrated and disputed clients are not cards in the queue. They are a
// standing block at the top of the page that every shift sees until someone
// marks it solved, and there is no snooze button on them at all, not a
// disabled one, not a hidden one. A caution you can dismiss for five minutes
// is a caution nobody reads.

function alertBlock(alerts, { csrfToken, backTo }) {
  if (!alerts.length) return '';

  return html`<section class="block" aria-labelledby="reports-care">
      <h3 id="reports-care">${glyph('crit')} Handle with care, ${num(alerts.length)}</h3>
      ${join(
        alerts.map((rem) => {
          const rule = ruleFor(rem);
          const meta = [
            rem.project ? `Project: ${rem.project}` : null,
            rem.created_by ? `Logged by ${rem.created_by}` : null,
          ].filter(Boolean);
          return html`<div class="note note--neg">
            <strong>${titleOf(rem)}</strong>
            ${rem.note ? html`<p>${rem.note}</p>` : ''}
            ${meta.length ? html`<p class="caption">${join(meta, ' · ')} · ${dateTimeShort(rem.created_at)}</p>` : ''}
            <form method="post" action="/reports/reminder" class="btnrow" style="margin-top:10px">
              <input type="hidden" name="_csrf" value="${csrfToken}">
              <input type="hidden" name="reminder_id" value="${String(rem.id)}">
              <input type="hidden" name="back" value="${backTo}">
              ${join(
                rule.buttons.map(
                  (b) => html`<button class="btn btn--sm" type="submit" name="button" value="${b.key}"
                      ${b.hint ? html`title="${b.hint}"` : ''}>${b.label}</button>`
                )
              )}
            </form>
          </div>`;
        })
      )}
      <p class="caption" style="margin-top:12px">
        These stay on the profile across every shift until someone marks them solved. They cannot be snoozed.
        While one is standing, no review ask goes to that buyer, the hub holds it and says so.
      </p>
    </section>`;
}

// ============================================================================
// 8. ONE DUE REMINDER
// ============================================================================

function reminderCard(rem, { csrfToken, backTo, now, flagged }) {
  const rule = ruleFor(rem);
  const hold = reviewHold(rem, rule, flagged);
  const waited = waitedFor(rem.due_at, now);
  const meta = reminderMeta(rem, rule);

  // A held review ask keeps one button and loses the rest. Nothing that could
  // be read as "send it anyway" is rendered, the CSR's only move is to close
  // it without asking, and the close is recorded as exactly that.
  const buttons = hold
    ? [{ key: 'held_no_ask', label: 'Close without asking', kind: 'resolve', primary: true }]
    : rule.buttons;

  const actions = html`<form method="post" action="/reports/reminder" class="btnrow">
      <input type="hidden" name="_csrf" value="${csrfToken}">
      <input type="hidden" name="reminder_id" value="${String(rem.id)}">
      <input type="hidden" name="back" value="${backTo}">
      <button class="btn btn--ghost btn--sm" type="submit" name="button" value="snooze"
              title="Hides it for ${String(SNOOZE_MINUTES)} minutes, then it comes back">Snooze ${String(SNOOZE_MINUTES)} min</button>
      ${join(
        buttons.map(
          (b) => html`<button class="btn${safe(b.primary ? '' : ' btn--ghost')} btn--sm" type="submit"
              name="button" value="${b.key}" ${b.hint ? html`title="${b.hint}"` : ''}>${b.label}</button>`
        )
      )}
    </form>`;

  return html`<li class="snippet">
      <div class="snippet-head">
        <h4>${titleOf(rem)}</h4>
        ${waited ? html`<span class="uses">${waited}</span>` : html`<span class="uses">${missing('when')}</span>`}
      </div>
      ${meta.length ? html`<p class="caption">${join(meta, ' · ')}</p>` : ''}
      ${hold
        ? html`<p class="note note--neg">
            ${pill('crit', 'Do not send')} ${holdReason(hold)}
            <span class="caption"> The completion is still logged and still counted; only the ask is held.</span>
          </p>`
        : ''}
      ${rule.orphan
        ? html`<p class="note note--warn">
            This reminder was booked by a rule that no longer exists, so its own buttons are gone. It can
            still be closed. Its rule was <code class="mono">${String(rem.rule)}</code>.
          </p>`
        : ''}
      <div class="snippet-actions">${actions}</div>
    </li>`;
}

// ============================================================================
// 9. RENDER
// ============================================================================

export function render(ctx) {
  const d = ctx.data || {};
  const csrfToken = ctx.csrfToken;

  const reportResult = d.report;
  const report = firstRow(reportResult);
  const reportRows = rowsOf(reportResult);

  // ---- the store is down: say which fact is missing, and stop -------------
  //
  // This is the branch the original got wrong. With Supabase unreachable its
  // reminder list resolved to [] and the dashboard printed "All caught up", 
  // a calm, confident, false all-clear over an unknown number of open
  // disputes. An outage is a fact about the system, never a fact about the
  // work, and the two must not render the same.
  if (reportRows === null) {
    return {
      title: 'The shift log cannot be read',
      kicker: 'Reports',
      html: html`<div class="figure">
          <span class="cap">Due now</span>
          <strong class="big">${missing()}</strong>
          <p class="sub">
            The typed-records database did not answer, so the hub cannot tell whether you have a shift open,
            which reminders are waiting on this profile, or whether a client is flagged. It will not show an
            empty queue, because an empty queue and an unreadable one look identical from a phone.
          </p>
        </div>
        <p class="note note--neg">
          ${glyph('crit')} <strong>Nothing is lost.</strong> Every entry already saved is saved. Logging is
          closed until the store answers rather than accepting entries it cannot attach to a shift. Everything
          on the pages that read from <code class="mono">data/</code> is unaffected.
        </p>`,
    };
  }

  const profiles = Array.isArray(d.profiles) ? d.profiles : [];

  // ---- no shift open ------------------------------------------------------
  //
  // This used to return openShiftView() and stop: nothing could be logged
  // until a shift was opened here. That was right when this page WAS the
  // shift-report system. It is not any more — the shift report is the
  // universal system across all ten profiles and it stays there, and what
  // this hub wants is the work: every inquiry, follow-up and conversation,
  // logged as it happens.
  //
  // So logging is always open. The roster already knows which shift this hour
  // is and who should be on it, and the signed-in name says who actually is,
  // so nothing here needs to be typed or chosen first.
  if (!report) {
    return logOnlyView(ctx, { csrfToken, date: d.date, d });
  }

  // ---- a shift is open ----------------------------------------------------

  const backTo = '/reports';
  const now = d.now;

  const dueRows = rowsOf(d.due);
  const waitingRows = rowsOf(d.waiting);
  const handledRows = rowsOf(d.handled);
  const activityRows = rowsOf(d.activities);
  const handoff = firstRow(d.handoff);

  const flagged =
    d.flagged === null || d.flagged === undefined
      ? null
      : d.flagged instanceof Map
        ? d.flagged
        : new Map(Object.entries(d.flagged));

  const due = Array.isArray(dueRows) ? dueRows : [];
  const alerts = due.filter((r) => ruleFor(r).alert);
  const queue = due.filter((r) => !ruleFor(r).alert);
  const dueUnknown = dueRows === null;

  const openLog = ACTIVITY_BY_KEY[String(ctx.query.log ?? '')] || null;

  // ---- the lede -----------------------------------------------------------

  const nextWaiting = Array.isArray(waitingRows) && waitingRows.length ? waitingRows[0] : null;
  const nextAt = nextWaiting ? clockPKT(nextWaiting.due_at) : null;

  const lede = html`<div class="lede">
      <div class="lede-main">
        <div class="figure">
          <span class="cap">Due now on ${report.profile}</span>
          <strong class="big">${dueUnknown ? missing() : num(queue.length)}</strong>
          <p class="sub">
            ${dueUnknown
              ? html`The reminder queue could not be read. This is MISSING, not an empty queue, do not treat
                  this page as an all-clear.`
              : alerts.length
                ? html`<b>${num(alerts.length)}</b> client${alerts.length === 1 ? '' : 's'} to handle with care
                    first, then ${queue.length ? html`<b>${num(queue.length)}</b> follow-up${queue.length === 1 ? '' : 's'} ready when you are.` : 'nothing else waiting.'}`
                : queue.length
                  ? html`Ready when you are, one at a time, and they will wait.
                      ${nextAt ? html`Nothing else is due until ${nextAt}.` : ''}`
                  : html`Nothing waiting on ${report.profile}.
                      ${Array.isArray(waitingRows) && waitingRows.length
                        ? html`<b>${num(waitingRows.length)}</b> reminder${waitingRows.length === 1 ? '' : 's'} scheduled${nextAt ? html`, the next at ${nextAt}` : ''}.`
                        : ''}`}
          </p>
        </div>
        ${why(
          'How a reminder decides it is yours',
          html`<p>
              A reminder belongs to the <strong>profile</strong>, not to the person who booked it. It pops for
              whoever is covering that profile at the time, on any shift, and it stays on screen until someone
              closes it with one of its buttons. It never expires by itself.
            </p>
            <p>
              Snooze is ${String(SNOOZE_MINUTES)} minutes and it is on every ordinary reminder. It is not on a
              red caution, those clear only when someone marks them solved. Logging one activity books at most
              one reminder from each rule, and several rules can fire on the same entry.
            </p>
            <p>
              <strong>No review ask rides on a late or disputed order.</strong> The completion reminder is
              held, named and explained rather than deleted, so nobody has to remember the rule at the moment
              it matters. Where the flag list itself cannot be read, the ask is held too, an ask this hub
              cannot prove is safe is the one the rule was written about.
            </p>`
        )}
      </div>
      <div class="lede-side">
        <div class="figure">
          <span class="cap">Your shift</span>
          <strong class="mid">${report.shift}</strong>
          <p class="sub">
            ${report.csr_name} on <b>${report.profile}</b>, in since
            ${clockPKT(report.started_at) || dateTimeShort(report.started_at)}.
            ${Array.isArray(activityRows)
              ? html` <b>${num(activityRows.length)}</b> entr${activityRows.length === 1 ? 'y' : 'ies'} logged`
              : html` Entries logged ${missing()}`}${Array.isArray(handledRows)
              ? html`, <b>${num(handledRows.length)}</b> reminder${handledRows.length === 1 ? '' : 's'} handled.`
              : '.'}
          </p>
        </div>
        <p class="caption">
          Counts of one shift, not rates. There is no denominator here to take a percentage of, so nothing on
          this page draws a bar or an arrow.
        </p>
        ${ctx.user && (ctx.user.role === 'manager' || ctx.user.role === 'owner')
          ? html`<div class="btnrow" style="margin-top:14px">
              <a class="btn btn--ghost btn--sm" href="/reports/ceo">What the shifts produced →</a>
            </div>`
          : ''}
      </div>
    </div>`;

  // ---- the incoming handoff note ------------------------------------------

  const handoffBlock = handoff
    ? html`<section class="block">
        <h3>Note from the last shift</h3>
        <p class="caption">
          Left by ${handoff.csr_name || missing()} · ${dateTimeShort(handoff.finished_at)} · for the
          ${report.shift} shift
        </p>
        <p class="note">${handoff.handoff_note}</p>
        <form method="post" action="/reports/handoff" class="btnrow" style="margin-top:12px">
          <input type="hidden" name="_csrf" value="${csrfToken}">
          <input type="hidden" name="report_id" value="${String(report.id)}">
          <input type="hidden" name="note_report_id" value="${String(handoff.id)}">
          <input type="hidden" name="back" value="${backTo}">
          <button class="btn" type="submit">Noted</button>
        </form>
        <p class="caption" style="margin-top:8px">
          Marking it read tells the last shift their note landed. A note aimed at two shifts has to be read by
          both, the other one still sees it as unread.
        </p>
      </section>`
    : '';

  // ---- what is due --------------------------------------------------------

  const queueBlock = html`<section class="panel">
      ${panelHead(
        html`Due now, ${dueUnknown ? missing() : num(queue.length)}`,
        dueUnknown ? 'missing' : 'typed',
        dueUnknown ? 'Queue unreadable' : html`Typed here · ${report.profile}`
      )}
      ${dueUnknown
        ? html`<p class="note note--neg">
            ${glyph('crit')} <strong>The reminder queue could not be read.</strong> There may be reminders due
            on ${report.profile} right now and the hub cannot see them. Treat this as unknown, not as clear.
          </p>`
        : queue.length
          ? html`<ul class="stack-sm">
              ${join(queue.map((rem) => reminderCard(rem, { csrfToken, backTo, now, flagged })))}
            </ul>`
          : empty(
              alerts.length
                ? 'No ordinary reminders due. The cautions above still stand.'
                : `Nothing due on ${report.profile}. Enjoy the calm.`
            )}
      ${Array.isArray(waitingRows) && waitingRows.length
        ? why(
            `${waitingRows.length} scheduled, not due yet`,
            html`<ul class="steps">
              ${join(
                waitingRows.slice(0, 12).map((rem) => {
                  const at = clockPKT(rem.due_at);
                  const snoozed = toMs(rem.snoozed_until) !== null;
                  return html`<li>
                    ${titleOf(rem)}
                    <span class="caption">, ${snoozed ? 'snoozed until' : 'due'} ${at || dateTimeShort(rem.due_at)}</span>
                  </li>`;
                })
              )}
            </ul>
            ${waitingRows.length > 12
              ? html`<p class="caption">${num(waitingRows.length - 12)} more, further out.</p>`
              : ''}`
          )
        : ''}
    </section>`;

  // ---- handled this shift, with an undo -----------------------------------
  //
  // The spec asks for five seconds of undo on every reminder action. A toast
  // needs JavaScript and disappears; this is the same promise kept in a way
  // that survives a page load, a dropped connection and a locked screen, the
  // ones you cleared, with the button you tapped, and a way back.

  const handledBlock =
    Array.isArray(handledRows) && handledRows.length
      ? html`<section class="panel">
          ${panelHead(html`Handled this shift, ${num(handledRows.length)}`, 'typed', 'Typed here')}
          <ul class="stack-sm">
            ${join(
              handledRows.map((rem) => {
                const rule = ruleFor(rem);
                const label =
                  rule.buttons.find((b) => b.key === rem.resolution)?.label ||
                  (rem.resolution === 'held_no_ask'
                    ? 'Closed without asking'
                    : rem.resolution === 'auto_cleared'
                      ? 'Cleared by a later entry'
                      : String(rem.resolution || 'closed'));
                return html`<li class="snippet">
                  <div class="snippet-head">
                    <h4>${titleOf(rem)}</h4>
                    <span class="uses">${clockPKT(rem.resolved_at) || dateTimeShort(rem.resolved_at)}</span>
                  </div>
                  <p class="caption">${label} · ${rem.resolved_by || missing()}</p>
                  <div class="snippet-actions">
                    <form method="post" action="/reports/reminder/undo" class="btnrow">
                      <input type="hidden" name="_csrf" value="${csrfToken}">
                      <input type="hidden" name="reminder_id" value="${String(rem.id)}">
                      <input type="hidden" name="back" value="${backTo}">
                      <button class="btn btn--ghost btn--sm" type="submit">Undo</button>
                    </form>
                  </div>
                </li>`;
              })
            )}
          </ul>
          <p class="caption">
            A mis-tap is never final. Undo puts the reminder back where it was; if the tap advanced a chain,
            the stage it booked goes with it.
          </p>
        </section>`
      : '';

  // ---- log an activity ----------------------------------------------------

  const logBlock = html`<section class="panel">
      ${panelHead('Log what just happened', 'typed', 'Typed here')}
      ${activityChooser(openLog?.key || null)}
      ${openLog
        ? activityForm(openLog, { csrfToken, reportId: report.id, backTo })
        : html`<p class="caption" style="margin-top:14px">
            Pick what happened and its form opens here. Two taps and a save, the reminders it books appear
            above, on this profile, for whoever is covering it when they come due.
          </p>`}
      <datalist id="reports-designers">
        ${join((Array.isArray(d.designers) ? d.designers : []).map((n) => html`<option value="${n}"></option>`))}
      </datalist>
    </section>`;

  // ---- this shift's timeline ----------------------------------------------

  const timelineBlock = html`<section class="panel">
      ${panelHead(
        html`This shift, ${Array.isArray(activityRows) ? num(activityRows.length) : missing()}`,
        Array.isArray(activityRows) ? 'typed' : 'missing',
        Array.isArray(activityRows) ? 'Typed here' : 'Entries unreadable'
      )}
      ${!Array.isArray(activityRows)
        ? html`<p class="note note--neg">
            ${glyph('crit')} The entries for this shift could not be read. Anything you saved is still saved, 
            this list is MISSING, not empty.
          </p>`
        : activityRows.length
          ? html`<ul class="stack-sm">
              ${join(
                activityRows.map(
                  (a) => html`<li class="snippet">
                    <div class="snippet-head">
                      <h4>${activityLabel(a.type) || String(a.type)}</h4>
                      <span class="uses">${clockPKT(a.created_at) || dateTimeShort(a.created_at)}</span>
                    </div>
                    <p class="caption">
                      ${join([a.client || null, a.project ? `Project: ${a.project}` : null, a.summary || null].filter(Boolean), ' · ') || 'No detail'}
                    </p>
                    <div class="snippet-actions">
                      <form method="post" action="/reports/activity/remove" class="btnrow">
                        <input type="hidden" name="_csrf" value="${csrfToken}">
                        <input type="hidden" name="activity_id" value="${String(a.id)}">
                        <input type="hidden" name="back" value="${backTo}">
                        <button class="btn btn--ghost btn--sm" type="submit">Remove</button>
                      </form>
                    </div>
                  </li>`
                )
              )}
            </ul>`
          : empty('Nothing logged yet this shift.')}
      <p class="caption">
        Removing an entry also clears the reminders it booked, that is the point of removing it. A reminder
        someone has already closed stays closed.
      </p>
    </section>`;

  // ---- wrap up ------------------------------------------------------------

  // Saving the note without closing has to come back with the ticks still
  // ticked and the target shifts still chosen. A form that quietly forgets
  // half of itself on every save teaches people not to use the save button,
  // and then the note only ever gets written in the last thirty seconds of a
  // shift, which is exactly when it gets written badly.
  const savedChecks = report.checklist && typeof report.checklist === 'object' ? report.checklist : {};
  const savedShifts = Array.isArray(report.note_shifts)
    ? report.note_shifts
    : SHIFT_KEYS.filter((k) => k !== report.shift);

  const wrapBlock = html`<section class="panel">
      ${panelHead('Wrap up and hand over', 'typed', 'Typed here')}
      <form method="post" action="/reports/close">
        <input type="hidden" name="_csrf" value="${csrfToken}">
        <input type="hidden" name="report_id" value="${String(report.id)}">
        <input type="hidden" name="back" value="${backTo}">

        <fieldset class="form-section">
          <legend>What you got done</legend>
          ${join(
            CHECKLIST.map(
              (item) => html`<label class="check-row">
                  <input type="checkbox" name="check" value="${item.id}"
                         ${safe(savedChecks[item.id] ? 'checked' : '')}>
                  <span class="check-label">${item.label}</span>
                </label>
                ${item.count
                  ? html`<div class="field">
                      <label for="c-${item.id}">${item.label}, how many</label>
                      <input id="c-${item.id}" name="count_${item.id}" type="text" inputmode="numeric"
                             value="${savedChecks[`count_${item.id}`] ?? ''}" autocomplete="off">
                      <p class="field-hint">Optional. A blank is "not counted", which is not the same as none.</p>
                    </div>`
                  : ''}`
            )
          )}
        </fieldset>

        <fieldset class="form-section">
          <legend>Note for the next shift</legend>
          <div class="field">
            <label for="handoff-note">What the next person needs to know</label>
            <textarea id="handoff-note" name="handoff_note" rows="4"
                      placeholder="Pending bits, client moods, anything half-finished…">${report.handoff_note || ''}</textarea>
            <p class="field-hint">Saved with the shift. It pops for the shifts you pick below, once each.</p>
          </div>
          <fieldset class="field">
            <legend class="field-label">Which shifts should read it?</legend>
            ${join(
              SHIFTS.filter((s) => s.key !== report.shift).map(
                (s) => html`<label class="check-row">
                  <input type="checkbox" name="note_shift" value="${s.key}"
                         ${safe(savedShifts.includes(s.key) ? 'checked' : '')}>
                  <span class="check-label">${s.label} <span class="caption">${s.time}</span></span>
                </label>`
              )
            )}
          </fieldset>
        </fieldset>

        <div class="form-actions">
          <button class="btn btn--ghost" type="submit" name="intent" value="save">Save the note, stay open</button>
          <button class="btn" type="submit" name="intent" value="close">Close the shift</button>
        </div>
      </form>
      ${handoff
        ? html`<p class="note note--warn">
            ${glyph('warn')} There is an unread note from the last shift above. Read it and mark it noted
            before closing, it was written for you.
          </p>`
        : ''}
      <p class="caption">
        Closing the shift does not close its reminders. They belong to ${report.profile} and carry over to
        whoever is covering it next, which is the whole point of them.
      </p>
    </section>`;

  const kicker = dueUnknown
    ? `${report.profile} · due MISSING`
    : `${report.profile} · ${report.shift} shift`;

  return {
    title: dueUnknown
      ? `The queue on ${report.profile} could not be read`
      : alerts.length
        ? `${alerts.length} client${alerts.length === 1 ? '' : 's'} to handle with care on ${report.profile}`
        : queue.length
          ? `${queue.length} reminder${queue.length === 1 ? '' : 's'} due on ${report.profile}`
          : `Nothing due on ${report.profile}`,
    kicker,
    ticker: [
      { label: 'Due now', value: dueUnknown ? missing() : num(queue.length) },
      { label: 'Handle with care', value: dueUnknown ? missing() : num(alerts.length) },
      { label: 'Logged this shift', value: Array.isArray(activityRows) ? num(activityRows.length) : missing() },
      { label: 'Handled', value: Array.isArray(handledRows) ? num(handledRows.length) : missing() },
      { label: 'Profile', value: report.profile },
      { label: 'Shift', value: report.shift, sub: clockPKT(report.started_at) || '' },
    ],
    html: html`${lede}
      ${alertBlock(alerts, { csrfToken, backTo })}
      ${handoffBlock}
      ${queueBlock}
      ${handledBlock}
      ${logBlock}
      ${timelineBlock}
      ${wrapBlock}
      <div class="provenance-bar">
        <span>Every figure on this page is typed here, in <code class="mono">shift_report</code>,
          <code class="mono">shift_activity</code> and <code class="mono">shift_reminder</code>.</span>
        <span>The late-and-disputed list that holds a review ask is the engine's
          <code class="mono">recovery.open_orders</code> joined to the cautions logged above.</span>
        <span>Nothing here is written back to any sheet, and no credential reaches this page.</span>
      </div>`,
  };
}

// ============================================================================
// 10. OPENING A SHIFT
// ============================================================================
//
// The name is not a field. It is whoever is signed in, and it is the reason
// this half of the section needs no roster: an attributed write already knows
// who made it. What is chosen is the profile being covered and the shift being
// worked, the two things that decide which reminders are yours.

/**
 * The page when no shift is open in this hub, which is the normal case.
 *
 * Everything a CSR does is logged from here. There is no "open a shift" step,
 * because the shift report lives in the universal system shared by all ten
 * profiles, and asking somebody to declare a shift twice before recording one
 * inquiry is how a log stops being kept.
 *
 * The roster supplies the context the entry needs: which shift this hour is,
 * and who should be on it. The signed-in name supplies who actually is. If
 * those two disagree the page says so — quietly, as information, not as an
 * error, because covering somebody else's shift is a normal Tuesday and the
 * log should record it rather than argue about it.
 */
/**
 * What this person has logged, and how many.
 *
 * A log with no visible record of what went into it asks somebody to type into
 * a void. The count is the reassurance and the list is the proof, and both
 * answer the question a CSR actually has mid-shift: did that save, and what
 * have I already done.
 *
 * Scoped to the AUTHOR and the last sixteen hours, which is a shift plus a
 * handover, so it is this person's own work and not a stranger's from
 * yesterday.
 */
function timelineBlock(d, me) {
  const rows = rowsOf(d?.activities);
  const unreadable = rows === null;
  const list = Array.isArray(rows) ? rows : [];

  return html`<section class="panel">
      ${panelHead(
        html`Logged this shift, ${unreadable ? missing() : num(list.length)}`,
        unreadable ? 'missing' : 'typed',
        me ? html`${me}, last 16 hours` : 'this shift'
      )}
      ${unreadable
        ? html`<p class="note note--neg">
            ${glyph('crit')} The log could not be read, so this is ${missing()} rather than none.
          </p>`
        : list.length
          ? html`<ul class="tl">
              ${join(
                list.slice(0, 25).map((r) => {
                  const a = ACTIVITY_BY_KEY[String(r.type)];
                  return html`<li class="tl-row">
                      <span class="tl-time">${clockPKT(r.created_at)}</span>
                      ${safe(activityDot(String(r.type)))}
                      <span class="tl-what">${a ? a.label : String(r.type ?? '')}</span>
                      <span class="tl-who">${r.client || ''}</span>
                    </li>`;
                })
              )}
            </ul>`
          : empty('Nothing logged yet. The first thing you do, tap it above.')}
    </section>`;
}

function logOnlyView(ctx, { csrfToken, date, d }) {
  const desk = deskNow();
  const me = ctx.user?.name || null;
  const rostered = desk.names || [];
  const onRoster = me ? rostered.includes(me) : false;
  const openLog = ctx.query?.log ? ACTIVITY_BY_KEY[String(ctx.query.log)] : null;
  const backTo = '/reports';
  const now = d?.now || new Date();

  // THE QUEUE IS THE OTHER HALF OF LOGGING, AND IT NEARLY SHIPPED WITHOUT IT.
  //
  // Logging an inquiry books a follow-up. If the page that does the logging
  // does not also show what is due, reminders are written and never seen, and
  // the system quietly becomes a write-only log. Reminders are profile-scoped
  // on purpose, so they belong to whoever is at the desk, shift or no shift.
  const dueRows = rowsOf(d?.due);
  const dueUnknown = dueRows === null;
  const due = Array.isArray(dueRows) ? dueRows : [];
  const alerts = due.filter((r) => ruleFor(r).alert);
  const queue = due.filter((r) => !ruleFor(r).alert);
  const flagged =
    d?.flagged === null || d?.flagged === undefined
      ? null
      : d.flagged instanceof Map
        ? d.flagged
        : new Map(Object.entries(d.flagged));

  const queueBlock = html`<section class="panel">
      ${panelHead(
        html`Due now, ${dueUnknown ? missing() : num(queue.length)}`,
        dueUnknown ? 'missing' : 'typed',
        dueUnknown ? 'Queue unreadable' : 'Typed here'
      )}
      ${dueUnknown
        ? html`<p class="note note--neg">
            ${glyph('crit')} <strong>The reminder queue could not be read.</strong> There may be reminders
            due right now and the hub cannot see them. Treat this as unknown, not as clear.
          </p>`
        : queue.length
          ? html`<ul class="stack-sm">
              ${join(queue.map((rem) => reminderCard(rem, { csrfToken, backTo, now, flagged })))}
            </ul>`
          : empty(
              alerts.length
                ? 'No ordinary reminders due. The cautions above still stand.'
                : 'Nothing due. Enjoy the calm.'
            )}
    </section>`;

  const context = html`<div class="figure">
      <span class="cap">On the desk now</span>
      <strong class="mid">${rostered.length ? rostered.join(', ') : missing()}</strong>
      <p class="sub">
        ${desk.label}, ${desk.day}.
        ${me
          ? onRoster
            ? html`You are on the roster for this hour, so anything you log is filed under
                <b>${me}</b> and this shift.`
            : html`The roster does not have <b>${me}</b> on right now. That is fine and it is
                logged as it is. Covering someone is normal, and the entry records who actually did
                the work rather than who was scheduled to.`
          : ''}
      </p>
    </div>`;

  const body = html`${context}
    ${why(
      'Why there is no shift to open here',
      html`<p>
          The shift report is one system shared by every profile, and it stays there. This hub wants
          the work: every inquiry, follow-up, conversation, order and delivery, logged as it happens.
        </p>
        <p>
          Nothing below needs a shift to be declared first. Your name comes from being signed in, so
          an entry cannot be filed under a misspelling, and the shift is whatever the roster says this
          hour is. Both are recorded on the row.
        </p>`
    )}
    ${alerts.length ? alertBlock(alerts, { csrfToken, backTo }) : ''}
    ${queueBlock}
    <h2 class="sec">Log what you just did</h2>
    ${activityChooser(openLog?.key || null)}
    ${timelineBlock(d, me)}
    ${openLog
      ? activityForm(openLog, { csrfToken, reportId: null, backTo: '/reports' })
      : html`<p class="caption">Pick what happened. Each one asks only for what it needs.</p>`}`;

  return {
    title: 'Log',
    kicker: 'Reports',
    ticker: [
      { label: 'Due now', value: dueUnknown ? missing() : String(queue.length),
        sub: alerts.length ? `${alerts.length} need care` : 'reminders' },
      { label: 'On the desk', value: String(desk.depth), sub: desk.alone ? 'one person' : 'people' },
      { label: 'Next handover', value: desk.next ? clock(desk.next.hour) : missing(),
        sub: desk.next ? desk.next.what : 'PKT' },
    ],
    html: body,
  };
}

function openShiftView(ctx, { csrfToken, profiles, shiftNow, date }) {
  const suggested = SHIFT_KEYS.includes(String(shiftNow)) ? String(shiftNow) : null;

  const profileField = profiles.length
    ? html`<div class="field">
        <label for="open-profile">Profile you are covering <span class="req" aria-hidden="true">*</span></label>
        <select id="open-profile" name="profile" required>
          <option value="">Choose a profile…</option>
          ${join(profiles.map((p) => html`<option value="${p}">${p}</option>`))}
        </select>
        <p class="field-hint">Reminders belong to the profile. Pick the one you are actually on.</p>
      </div>`
    : html`<div class="field">
        <label for="open-profile">Profile you are covering <span class="req" aria-hidden="true">*</span></label>
        <input id="open-profile" name="profile" type="text" autocomplete="off" required>
        <p class="field-hint">
          No profile list reached the hub from the engine, so type the one you are on. The spelling matters, 
          it is what the reminders key on.
        </p>
      </div>`;

  const body = html`<div class="figure">
      <span class="cap">Your shift</span>
      <strong class="mid">Not open yet</strong>
      <p class="sub">
        Nothing can be logged and no reminder can be worked until a shift is open, because both belong to a
        profile and a shift is what says which one. Two choices and you are in.
      </p>
    </div>

    <section class="panel">
      ${panelHead('Open a shift', 'typed', 'Typed here')}
      <form method="post" action="/reports/open">
        <input type="hidden" name="_csrf" value="${csrfToken}">
        <input type="hidden" name="back" value="/reports">

        <div class="field">
          <span class="field-label">Signed in as</span>
          <p class="note" style="margin-top:0">
            <strong>${ctx.user ? ctx.user.name : missing()}</strong>, the shift is logged against this name and
            every entry on it is attributed to it. There is no name field, so there is nothing to mistype.
          </p>
        </div>

        ${profileField}

        <fieldset class="field">
          <legend class="field-label">Shift <span class="req" aria-hidden="true">*</span></legend>
          ${join(
            SHIFTS.map(
              (s) => html`<label class="check-row">
                <input type="radio" name="shift" value="${s.key}" ${safe(s.key === suggested ? 'checked' : '')} required>
                <span class="check-label">
                  ${s.label} <span class="caption">${s.time} PKT</span>
                  ${s.key === suggested ? pill('info', 'Live now') : ''}
                </span>
              </label>`
            )
          )}
          ${suggested
            ? ''
            : html`<p class="field-hint">
                The clock could not be read, so no shift is pre-picked. Choose the one you are working.
              </p>`}
        </fieldset>

        <div class="form-actions">
          <button class="btn" type="submit">Start my shift</button>
          <span class="form-status">${date ? html`${dateShort(date, { year: true })} · Pakistan time` : missing()}</span>
        </div>
      </form>
      ${why(
        'What opening a shift actually does',
        html`<p>
            It creates one open row for you against that profile for the day. If you already have one open it
            is picked up rather than duplicated, so a reload, a dead battery or a switched phone never splits
            a shift into two half-reports.
          </p>
          <p>
            It does not create any reminder and it does not clear any. Reminders belong to the profile and
            were booked by whatever was logged before you arrived, possibly by somebody else, possibly on a
            different shift. They are waiting for whoever covers it, which, once you press this, is you.
          </p>`
      )}
    </section>`;

  return {
    title: 'No shift open',
    kicker: 'Reports',
    ticker: [
      { label: 'Shift', value: 'Not open' },
      { label: 'Signed in', value: ctx.user ? ctx.user.name : missing() },
      { label: 'Date', value: date ? dateShort(date) : missing() },
      { label: 'Profiles', value: profiles.length ? num(profiles.length) : missing() },
    ],
    html: body,
  };
}

export default render;
