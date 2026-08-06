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

/** Spellings of this profile across the stores. The impressions board writes
 *  "XStudioz", the shift logger writes "X Studioz", and the order sheet has
 *  carried both. Anything comparing them has to know that. */
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
      `closed_by_ceo,created_at&${orFilter('profile', PROFILE_ALIASES)}` +
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
      `logged_by,status,ceo_note,client,project&${orFilter('profile', PROFILE_ALIASES)}` +
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
        `note_for_next,checklist&${orFilter('profile', PROFILE_ALIASES)}` +
        `&date=gte.${from}&date=lte.${to}&order=start_at.asc&limit=400`
    ),
    tryselect(
      'reports',
      `reminders?select=*&${orFilter('profile', PROFILE_ALIASES)}` +
        `&created_at=gte.${from}T00:00:00%2B05:00&created_at=lt.${nextDay(to)}T00:00:00%2B05:00` +
        `&order=created_at.asc&limit=1000`
    ),
    // Deliberately NOT window-scoped. What is owed right now is owed whatever
    // date filter is on screen.
    tryselect(
      'reports',
      `reminders?select=*&${orFilter('profile', PROFILE_ALIASES)}` +
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

// -------------------------------------------------------------- impressions

//: The impressions store still uses the retired programme's name for two of
//: its columns. PostgREST renames a column on the way out, so this one line
//: owns the raw spelling and every row that leaves this module already says
//: `directed`. Nothing downstream can leak it, including code not written yet.
const DIRECTED_COLS = 'directed_orders:vvro_orders,directed_price:vvro_price'; // scrubs-output

/** Daily reach for this profile, newest first. */
export function impressions({ limit = 120 } = {}) {
  return tryselect(
    'impressions',
    `entries?select=date,profile,impressions,clicks,organic_orders,${DIRECTED_COLS},total_orders,` +
      `orders_completed,completed_price,order_queue,total_reviews,success_score,profile_rating,` +
      `cancellations,status,updated_at&${orFilter('profile', PROFILE_ALIASES)}` +
      `&order=date.desc&limit=${limit}`
  );
}

/** Per-gig reach, for the profiles that split it. */
export function gigImpressions({ limit = 200 } = {}) {
  return tryselect(
    'impressions',
    `gig_entries?select=*&order=date.desc&limit=${limit}`
  );
}

export default {
  STORES, PROFILE, PROFILE_ALIASES, ExternalError,
  select, tryselect, shiftReports, shiftActions, mistakes, impressions, gigImpressions,
  ACTION_TYPE_TO_RULE_KEY, CHECKLIST_LABEL_TO_ID,
  checklistInHubVocabulary, shiftInHubVocabulary, actionInHubVocabulary,
  reminderInHubVocabulary, ceoWindow,
};
