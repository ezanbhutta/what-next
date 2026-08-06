// lib/external.js, the four places the profile overview reads from.
//
// The hub stopped being a CSR tool. Nobody logs work here any more; Ezan opens
// it to look at the profile. So the data has to come from wherever the team
// actually works, and this is the map of that:
//
//   REPORTS       Supabase `aeytsgipuuyjlbvebhez`, tables reports / actions /
//                 reminders / mistakes. What reports-six-coral.vercel.app
//                 writes. Ten profiles share it; X Studioz is one slice.
//   IMPRESSIONS   Supabase `jkigyrnvlfcwloqtrycu`, tables entries / gig_entries
//                 / gigs / profiles. What impressions-hmi.vercel.app writes.
//   ORDERS        the order workbook, already ingested by the engine into
//                 data/orders.jsonl. Not fetched here.
//   INQUIRIES     the inquiry workbook, already ingested into data/leads.jsonl.
//                 Not fetched here.
//
// TWO THINGS THAT ARE NOT TRUE AND MATTER
//
// The impressions SHEET (1FKLA1af...) is not a live source. Its first tab ends
// 23-Sep-2025 and its second ends 13-Dec-2025, then empty rows. Reading it
// would put eight-month-old numbers on a page labelled today. The live figures
// are in the Supabase above, which the impressions app writes to.
//
// And that store is not current either: X Studioz impressions stop on
// 2026-07-28. Whatever is read from it must carry its own as-of date to the
// screen, because a stale number with today's date on it is worse than no
// number, and this one is stale by more than a week.
//
// READ ONLY, ALWAYS. Nothing here writes to anybody else's system. These are
// other teams' tools and this hub is a reader of them.

const DEFAULT_TIMEOUT_MS = 6000;

/** Where each store lives. Keys come from the environment, never the repo. */
export const STORES = {
  reports: {
    url: process.env.REPORTS_SUPABASE_URL || 'https://aeytsgipuuyjlbvebhez.supabase.co',
    key: process.env.REPORTS_SUPABASE_KEY || '',
    label: 'CSR Shift Logger',
  },
  impressions: {
    url: process.env.IMPRESSIONS_SUPABASE_URL || 'https://jkigyrnvlfcwloqtrycu.supabase.co',
    key: process.env.IMPRESSIONS_SUPABASE_KEY || '',
    label: 'Impressions board',
  },
};

/** The profile this hub is about. One profile, so it is never a form field. */
export const PROFILE = 'X Studioz';

/**
 * THE TWO STORES DO NOT MEAN THE SAME THING BY "PROFILE", AND THAT IS A TRAP.
 *
 * This started as one alias list covering both, on the assumption that the two
 * systems were spelling the same thing differently. They are not.
 *
 * The shift logger's `profile` is an ACCOUNT. Ten of them, and this one is
 * spelled "X Studioz" in all 589 stored reports, with no second spelling.
 *
 * The impressions board's `profile` is a GIG. Its own `profiles` table carries
 * an `account` column precisely because several gigs share one: "XStudioz" and
 * "X_Studioz new gig" are two gigs of this account, exactly as "Dygram",
 * "Dygram PPT" and "Dygram Wordpress" are three of another.
 *
 * So a list that matched both names on the board was not resolving an alias,
 * it was returning two different gigs' rows for the same day and calling them
 * duplicates of each other. Reading that as one profile's history gives two
 * rows per date, and folding it naively gives a profile rating halfway between
 * 4.8 and a brand new gig's 0.
 *
 * They are separated below, and the board's gig list is read from the board
 * rather than guessed here, so a gig added to this account next month arrives
 * on its own.
 */
export const REPORTS_PROFILES = ['X Studioz'];

/** The board's `account` value for this hub's profile. */
export const BOARD_ACCOUNT = 'XStudioz';

/** Kept for the callers that predate the split, and equal to the union. Do not
 *  use it for the board: `boardGigs()` is the honest answer there. */
export const PROFILE_ALIASES = ['X Studioz', 'XStudioz', 'X_Studioz', 'X Studioz new gig', 'X_Studioz new gig'];

export class ExternalError extends Error {
  constructor(message, { store, status = null } = {}) {
    super(message);
    this.name = 'ExternalError';
    this.store = store;
    this.status = status;
    this.unavailable = true;
  }
}

/**
 * One PostgREST read.
 *
 * Returns rows, or throws ExternalError. It never returns [] for a failure:
 * an empty result and an unreachable store are different facts, and every
 * page in this hub renders them differently on purpose.
 */
export async function select(storeKey, path, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const store = STORES[storeKey];
  if (!store) throw new ExternalError(`unknown store ${storeKey}`, { store: storeKey });
  if (!store.key) {
    throw new ExternalError(
      `${store.label} has no API key configured. Set ${storeKey.toUpperCase()}_SUPABASE_KEY.`,
      { store: storeKey }
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${store.url}/rest/v1/${path}`, {
      headers: { apikey: store.key, Authorization: `Bearer ${store.key}` },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new ExternalError(`${store.label} answered ${res.status}`, { store: storeKey, status: res.status });
    }
    return await res.json();
  } catch (err) {
    if (err instanceof ExternalError) throw err;
    const why = err?.name === 'AbortError' ? `did not answer within ${timeoutMs}ms` : err.message;
    throw new ExternalError(`${store.label} ${why}`, { store: storeKey });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A read that reports its own failure instead of throwing.
 *
 * `{ok:true, rows}` or `{ok:false, notice}`. Same contract the MySQL helpers
 * use, so a view treats an unreachable external store exactly as it treats an
 * unreachable local one: as MISSING, never as zero.
 */
export async function tryselect(storeKey, path, opts) {
  try {
    return { ok: true, rows: await select(storeKey, path, opts), notice: null };
  } catch (err) {
    return { ok: false, rows: null, notice: err.message };
  }
}

const orFilter = (col, values) =>
  `${col}=in.(${values.map((v) => `"${String(v).replace(/"/g, '')}"`).join(',')})`;

// ------------------------------------------------------------------ reports

/** Shift reports for this profile, newest first. */
export function shiftReports({ limit = 60 } = {}) {
  return tryselect(
    'reports',
    `reports?select=id,csr_name,shift,profile,date,start_at,finish_at,status,note_for_next,` +
      `closed_by_ceo,created_at&${orFilter('profile', REPORTS_PROFILES)}` +
      `&order=date.desc,start_at.desc&limit=${limit}`
  );
}

/** What was logged during those shifts. */
export function shiftActions({ limit = 400 } = {}) {
  return tryselect(
    'reports',
    `actions?select=id,report_id,type,client,details,created_at` +
      `&order=created_at.desc&limit=${limit}`
  );
}

/** Mistakes recorded against this profile. */
export function mistakes({ limit = 60 } = {}) {
  return tryselect(
    'reports',
    `mistakes?select=id,person,category,severity,description,happened_on,shift,profile,` +
      `logged_by,status,ceo_note,client,project&${orFilter('profile', REPORTS_PROFILES)}` +
      `&order=happened_on.desc&limit=${limit}`
  );
}

// ------------------------------------------------- reports, in hub vocabulary
//
// THE SECOND SEAM, AND WHY IT IS HERE RATHER THAN IN THE VIEW.
//
// `views/reports-ceo.js` was written against the shift logger's column names
// and the hub's tables use different ones, so server.js already owns a
// translation (REPORT_COLS / REMINDER_COLS / RULE_KEY_TO_VIEW). That seam was
// for MySQL. This one is for the store the CSRs actually write to, and it maps
// the same vocabulary from the other direction.
//
// Everything below returns rows the view can read with no changes to the view.
// That is the point: the page did not get a new data source so much as its old
// one moved house, and a view that has to know which house it is is a view
// that will be wrong the next time it moves.

/** The logger's `action_type` → the rule key `lib/reminders.js` stores.
 *
 *  The exact inverse of RULE_KEY_TO_VIEW in server.js, and `wiring.test.js`
 *  asserts that in both directions. A stage renamed on either side fails the
 *  suite rather than rendering as a nameless reminder with no buttons. */
export const ACTION_TYPE_TO_RULE_KEY = Object.freeze({
  inquiry: 'inquiry_followup',
  lead_followup: 'lead_followup_next',
  new_order: 'order_assign',
  new_order_upsell: 'order_upsell',
  order_completed: 'completed_public_review',
  review_received: 'review_private_ask',
  files_assigned: 'files_upsell',
  revision_assigned: 'revision_check',
  offer: 'offer_fu1',
  offer_fu2: 'offer_fu2',
  offer_fu3: 'offer_fu3',
  project_delivered: 'delivery_followup',
  shared: 'shared_followup',
  frustrated: 'frustrated_alert',
  disputed: 'disputed_alert',
  custom_reminder: 'custom',
});

/** The logger writes a wrap-up keyed by the item's LABEL; the hub reads it
 *  keyed by id. Six items, spelled here once.
 *
 *  Matching is on the label squashed to letters, so the logger's
 *  "Briefs Created" and the hub's "Briefs created" are the same box. A test
 *  asserts every id in `views/reports.js` CHECKLIST appears here: an item
 *  added there and forgotten here would render as "not done" on every shift
 *  that ticked it, which is a wrong figure rather than a missing one. */
export const CHECKLIST_LABEL_TO_ID = Object.freeze({
  crmupdated: 'crm_updated',
  clickupcleared: 'clickup_cleared',
  portfolioupdated: 'portfolio_updated',
  briefscreated: 'briefs_created',
  analyticschecked: 'analytics_checked',
  checkedordersonebyone: 'orders_checked',
});

const squashLabel = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

const EMPTY_SET = new Set();

// The logger stores a count beside its tick, under the same label with this
// suffix, as a STRING. "Ticked, and here is how many" and "ticked, no count"
// are different facts and the view prints the second as MISSING, so a count
// that fails to parse must fall back to the tick and never to zero.
// The dashes are escapes, not literals, because the house style bans an em
// dash in this repo's own source and the test that enforces it reads bytes.
// This one is not ours to spell: it is a character inside somebody else's
// column name, and it has to match exactly or every count is dropped.
const COUNT_SUFFIX = /\s*[\u2014\u2013-]\s*count$/i;

/**
 * One logger wrap-up → the `{id: true | number}` shape the view reads.
 *
 * `__shifts` is not a checklist item; it is who the handover note was aimed
 * at, which the logger keeps inside the same blob. It is lifted out by
 * `inHubVocabulary` and never counted as a box.
 */
export function checklistInHubVocabulary(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const counts = new Map();
  const ticks = new Map();
  for (const [key, value] of Object.entries(raw)) {
    if (key === '__shifts') continue;
    const isCount = COUNT_SUFFIX.test(key);
    const id = CHECKLIST_LABEL_TO_ID[squashLabel(key.replace(COUNT_SUFFIX, ''))];
    if (!id) continue; // an item this hub does not know about, left alone
    if (isCount) {
      const n = Number(String(value).trim());
      if (String(value).trim() !== '' && Number.isFinite(n)) counts.set(id, n);
    } else {
      ticks.set(id, value);
    }
  }

  const out = {};
  for (const [id, ticked] of ticks) {
    if (ticked === true) out[id] = counts.has(id) ? counts.get(id) : true;
    else out[id] = Boolean(ticked);
  }
  // A count filed against a box nobody ticked is still evidence the work
  // happened. Dropping it would print "not done" over a typed number.
  for (const [id, n] of counts) if (!(id in out)) out[id] = n;
  return out;
}

/** One logger shift report → the shape `views/reports-ceo.js` reads. */
export function shiftInHubVocabulary(row) {
  const shifts = Array.isArray(row?.checklist?.__shifts) ? row.checklist.__shifts : null;
  return {
    id: row.id,
    csr_name: row.csr_name,
    profile: row.profile,
    shift: row.shift,
    started_at: row.start_at,
    closed_at: row.finish_at,
    status: row.status,
    handoff_note: row.note_for_next || null,
    note_shifts: shifts,
    checklist: checklistInHubVocabulary(row.checklist),
  };
}

/** One logged action → the shape the shift timeline reads. `details` is the
 *  logger's free JSON; the project lives inside it. `author` is not on the row
 *  at all — the person is a property of the shift — so it is filled in from
 *  the report by `ceoWindow` and left null here rather than guessed. */
export function actionInHubVocabulary(row) {
  const detail = row?.details && typeof row.details === 'object' ? row.details : {};
  return {
    id: row.id,
    report_id: row.report_id,
    type: row.type,
    client: row.client || null,
    project: detail.project || null,
    created_at: row.created_at,
    author: null,
    detail,
  };
}

/** One logger reminder → the shape the queue panels read.
 *
 *  `alert` is derived, not stored: the logger has no such column, and the two
 *  stages that carry a standing caution are a property of the rule rather than
 *  of the row. `alertKeys` is passed in by the caller so this module does not
 *  import the rule table and the rule table stays the one definition of it. */
export function reminderInHubVocabulary(row, alertKeys = EMPTY_SET) {
  const type = String(row?.action_type ?? '');
  // An unmapped type is left as-is on purpose. The view's rule lookup misses,
  // prints the raw name and offers no buttons, which is the honest rendering
  // of "the logger booked a stage this hub has never heard of". Blanking it
  // would hide a real reminder somebody is waiting on.
  const ruleKey = ACTION_TYPE_TO_RULE_KEY[type] || type;
  return {
    id: row.id,
    report_id: null,
    activity_id: row.action_id,
    rule_key: ruleKey,
    rule: type,
    profile: row.profile,
    client: row.client || null,
    client_key: squashLabel(row.client),
    project: row.project || null,
    due_at: row.due_at,
    heading: row.heading || '',
    note: row.note || '',
    alert: alertKeys.has(ruleKey),
    state: row.status,
    resolution: row.resolution || null,
    snoozed_until: row.snoozed_until,
    resolved_by: row.resolved_by || null,
    resolved_at: row.resolved_at,
    created_by: row.csr_name || null,
    created_at: row.created_at,
  };
}

/** PostgREST wants an `in.(…)` list; an EMPTY one is a syntax error, so the
 *  caller has to short-circuit rather than send it. */
const idList = (ids) => `(${ids.map((id) => `"${String(id).replace(/"/g, '')}"`).join(',')})`;

/**
 * Everything the owner's Reports view needs for a window of days.
 *
 * `from`/`to` are Pakistan calendar days, inclusive, and they are matched
 * against the logger's own `date` column rather than against a timestamp
 * range. That column is the day the SHIFT belongs to, which for a Night shift
 * starting at 01:36 is not the day its clock time falls in. Checked against
 * all 589 stored reports: the logger's `date` and the PKT day of `start_at`
 * agree on every one, so the view's own bucketing lands them in the same place.
 *
 * Each of the four comes back as `{ok, rows, notice}`, the same contract the
 * MySQL helpers use, so an unreachable logger renders as MISSING and never as
 * a quiet zero.
 */
export async function ceoWindow({ from, to, alertKeys = EMPTY_SET } = {}) {
  const fail = (notice) => ({ ok: false, rows: null, notice });
  const okRows = (rows) => ({ ok: true, rows, notice: null });

  const [reports, booked, standing] = await Promise.all([
    tryselect(
      'reports',
      `reports?select=id,csr_name,shift,profile,date,start_at,finish_at,status,` +
        `note_for_next,checklist&${orFilter('profile', REPORTS_PROFILES)}` +
        `&date=gte.${from}&date=lte.${to}&order=start_at.asc&limit=400`
    ),
    tryselect(
      'reports',
      `reminders?select=*&${orFilter('profile', REPORTS_PROFILES)}` +
        `&created_at=gte.${from}T00:00:00%2B05:00&created_at=lt.${nextDay(to)}T00:00:00%2B05:00` +
        `&order=created_at.asc&limit=1000`
    ),
    // Deliberately NOT window-scoped. What is owed right now is owed whatever
    // date filter is on screen.
    tryselect(
      'reports',
      `reminders?select=*&${orFilter('profile', REPORTS_PROFILES)}` +
        `&status=neq.resolved&due_at=lte.${new Date().toISOString()}` +
        `&order=due_at.asc&limit=200`
    ),
  ]);

  const shifts = reports.ok ? okRows(reports.rows.map(shiftInHubVocabulary)) : reports;

  // Actions carry no profile of their own; they hang off a report. So the
  // report ids have to be in hand before they can be asked for, and if the
  // reports read failed there is nothing to ask with — which is an unreadable
  // activity list, not an empty one.
  let activities;
  if (!reports.ok) {
    activities = fail(reports.notice);
  } else if (!reports.rows.length) {
    activities = okRows([]);
  } else {
    const byReport = new Map(reports.rows.map((r) => [r.id, r.csr_name]));
    const got = await tryselect(
      'reports',
      `actions?select=id,report_id,type,client,details,created_at` +
        `&report_id=in.${idList(reports.rows.map((r) => r.id))}` +
        `&order=created_at.asc&limit=4000`
    );
    activities = got.ok
      ? okRows(
          got.rows.map((a) => ({
            ...actionInHubVocabulary(a),
            author: byReport.get(a.report_id) ?? null,
          }))
        )
      : got;
  }

  const inVocab = (res) =>
    res.ok ? okRows(res.rows.map((r) => reminderInHubVocabulary(r, alertKeys))) : res;

  return {
    shifts,
    activities,
    reminders: inVocab(booked),
    standing: inVocab(standing),
  };
}

function nextDay(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// ------------------------------------------------------- the impressions board
//
// The board's `entries` table and this hub's `daily_entry` hold the same
// seventeen numbers under different names, so the whole column translation is
// a PostgREST select list: the store renames them on the way out and a row
// arrives already spelled the way the hub reads it.
//
// Doing it in the query rather than in a map function is deliberate. Two of
// these names are ones nobody is allowed to print and one is a name this hub
// already worked out was wrong. Renamed once, at the boundary, no later code
// has a chance to reach for the raw spelling, including code not written yet.

const REACH_COLS = [
  'entry_date:date',
  'gig:profile',
  'impressions',
  'clicks',
  'organic_orders',
  'organic_value:organic_price',
  //: The two retired-programme columns, renamed on the way out. This line owns
  //: the raw spelling and nothing downstream ever sees it.
  'directed_orders:vvro_orders', // scrubs-output
  'directed_value:vvro_price', // scrubs-output
  'total_orders',
  'orders_completed',
  'completed_value:completed_price',
  'orders_in_queue:order_queue',
  'total_reviews',
  // THE BOARD STILL CALLS THIS `msg_ratio`, AND IT IS NOT A RATIO.
  //
  // This hub renamed the same field months ago after finding out what it
  // holds: a COUNT of inquiries that arrived, not a percentage. See the
  // comment on `daily_entry.inquiries_received` in db/schema.sql. Stored as a
  // percent, 4 inquiries reads as 4%, and nothing about the number looks
  // wrong. The board itself has not been touched, because it is not this hub's
  // to touch, so the correction happens here on the way in.
  'inquiries_received:msg_ratio',
  'success_score',
  'profile_rating',
  'cancellations',
  'cancelled_value:cancel_price',
  'entered_by',
  'status',
  'updated_at',
].join(',');

/**
 * WHICH COLUMNS MAY BE ADDED UP, AND WHICH MAY NEVER BE.
 *
 * A FLOW happened during the day: impressions served, orders placed, money
 * taken. Two gigs' flows add up, and so do two days'.
 *
 * A LEVEL is a standing figure the day happened to end on: how many orders are
 * in the queue, how many reviews the gig has collected in its life, what
 * Fiverr currently rates it. `total_reviews` reads 1,546 one day and 1,553 the
 * next because it is a running total, so a week of it summed comes to about
 * eleven thousand reviews, which is a number this business has never had.
 *
 * That is the whole reason for this table. Both kinds are plain integers in
 * the same row and nothing about either says which it is, so the sum looks
 * exactly as reasonable as the level does.
 */
export const REACH_FLOWS = Object.freeze([
  'impressions',
  'clicks',
  'organic_orders',
  'organic_value',
  'directed_orders',
  'directed_value',
  'total_orders',
  'orders_completed',
  'completed_value',
  'inquiries_received',
  'cancellations',
  'cancelled_value',
]);

export const REACH_LEVELS = Object.freeze([
  'orders_in_queue',
  'total_reviews',
  'success_score',
  'profile_rating',
]);

/**
 * The gigs of this account, from the board's own `profiles` table.
 *
 * Read rather than hardcoded so a gig launched next month arrives by itself
 * instead of silently going missing from every total. `main` is the gig whose
 * name is the account name, which is the board's own convention: `xstudioz`
 * against `gig-x-studioz-new-gig`, `dygram` against `gig-dygram-ppt`.
 */
export async function boardGigs() {
  const got = await tryselect(
    'impressions',
    `profiles?select=id,name,account,active&account=eq.${encodeURIComponent(BOARD_ACCOUNT)}&order=sort.asc`
  );
  if (!got.ok) return got;
  return {
    ok: true,
    rows: got.rows.map((r) => ({ ...r, main: r.name === r.account })),
    notice: null,
  };
}

/**
 * Every gig-day the board holds for this account, in `daily_entry` vocabulary.
 *
 * One row per gig per day, newest first, `gig` naming which. Checked against
 * the store: 305 XStudioz rows on 305 distinct days, so the board really does
 * keep one row per gig per day and a day nobody filled in is simply absent.
 * That absence is the point. It is not a zero and the view has to say so.
 */
export async function reachRows({ from, to } = {}) {
  const gigs = await boardGigs();
  if (!gigs.ok) return gigs;
  const names = gigs.rows.map((g) => g.name);
  if (!names.length) return { ok: true, rows: [], notice: null };

  const range = [];
  if (from) range.push(`&date=gte.${from}`);
  if (to) range.push(`&date=lte.${to}`);
  return tryselect(
    'impressions',
    `entries?select=${REACH_COLS}&${orFilter('profile', names)}` +
      `${range.join('')}&order=date.desc&limit=1000`
  );
}

/** Strict addition. A blank part means an unknown whole, never a smaller sum:
 *  the same rule the daily form has always used on its per-gig split. */
function strictAdd(values) {
  let total = null;
  for (const v of values) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    total = (total ?? 0) + n;
  }
  return total;
}

/**
 * The gig-days folded into account-days.
 *
 * Flows are added across the account's gigs. Levels are taken from the MAIN
 * gig and never combined, because the second gig here is nine days old and
 * carries a profile rating of 0, which is the sheet import's way of writing
 * "none yet". Averaged in, it turns a 4.8 into a 2.4; added up, it turns a
 * review count into fiction. Neither reads as wrong on the page.
 *
 * Each day keeps its `gigs` array so the split stays visible rather than being
 * a claim the reader has to take on trust.
 */
export async function reachDays({ from, to } = {}) {
  const got = await reachRows({ from, to });
  if (!got.ok) return got;
  const gigs = await boardGigs();
  const mainName = gigs.ok ? (gigs.rows.find((g) => g.main)?.name ?? null) : null;

  const byDay = new Map();
  for (const row of got.rows) {
    const day = String(row.entry_date);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(row);
  }

  const rows = [...byDay.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([day, parts]) => {
      const out = { entry_date: day, gigs: parts };
      for (const col of REACH_FLOWS) out[col] = strictAdd(parts.map((p) => p[col]));
      // The main gig's row if it filed one that day; otherwise no level is
      // known for the day, which is MISSING rather than the other gig's zero.
      const main = parts.find((p) => p.gig === mainName) || null;
      for (const col of REACH_LEVELS) out[col] = main ? main[col] : null;
      out.entered_by = main?.entered_by ?? parts[0]?.entered_by ?? null;
      out.updated_at = main?.updated_at ?? parts[0]?.updated_at ?? null;
      return out;
    });

  return { ok: true, rows, notice: null };
}

/**
 * The most recent day the board has for this account, and how old it is.
 *
 * EVERY REACH FIGURE ON A SCREEN HAS TO CARRY THIS.
 *
 * The board is filled in by hand by whoever is on shift, and it falls behind.
 * At the time of writing it stops on 2026-07-28 while the order sheet is
 * current to yesterday, so a page printing both without saying which is which
 * invites somebody to read a July impression count as today's. A stale number
 * under a fresh date is worse than a missing one, because the missing one gets
 * chased.
 *
 * `ok:false` when the board cannot be read at all, which is a different fact
 * again and renders differently.
 */
export async function reachAsOf({ today = null } = {}) {
  const gigs = await boardGigs();
  if (!gigs.ok) return { ok: false, date: null, daysOld: null, notice: gigs.notice };
  const names = gigs.rows.map((g) => g.name);
  if (!names.length) {
    return { ok: true, date: null, daysOld: null, enteredBy: null, updatedAt: null, notice: null };
  }

  const got = await tryselect(
    'impressions',
    `entries?select=date,updated_at,entered_by&${orFilter('profile', names)}&order=date.desc&limit=1`
  );
  if (!got.ok) return { ok: false, date: null, daysOld: null, notice: got.notice };
  const row = got.rows[0] || null;
  if (!row) {
    return { ok: true, date: null, daysOld: null, enteredBy: null, updatedAt: null, notice: null };
  }

  const asOf = String(row.date);
  const ref = today || new Date().toISOString().slice(0, 10);
  const daysOld = Math.round(
    (Date.parse(`${ref}T00:00:00Z`) - Date.parse(`${asOf}T00:00:00Z`)) / 86400000
  );
  return {
    ok: true,
    date: asOf,
    daysOld: Number.isFinite(daysOld) ? daysOld : null,
    enteredBy: row.entered_by || null,
    updatedAt: row.updated_at || null,
    notice: null,
  };
}

export default {
  STORES, PROFILE, PROFILE_ALIASES, ExternalError,
  select, tryselect, shiftReports, shiftActions, mistakes,
  ACTION_TYPE_TO_RULE_KEY, CHECKLIST_LABEL_TO_ID,
  checklistInHubVocabulary, shiftInHubVocabulary, actionInHubVocabulary,
  reminderInHubVocabulary, ceoWindow,
  REPORTS_PROFILES, BOARD_ACCOUNT, REACH_FLOWS, REACH_LEVELS,
  boardGigs, reachRows, reachDays, reachAsOf,
};
