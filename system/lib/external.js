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
};
