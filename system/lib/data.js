// lib/data.js, the engine's output, read from disk. Nothing here computes.
//
// SCOPE: this module is the ONLY way the hub reads data/. Everything in that
// directory is produced by the Python growth engine, committed to git, and
// refreshed by deploying. This app never writes it, never recomputes it, and
// never patches a hole in it with a guess.
//
// THE MISSING RULE
//
// A file that is not there is not an empty file, and neither is zero. Those
// are three different facts and they must arrive in three different shapes:
//
//   MISSING   the source is absent, we do not know
//   []        the source is present and holds no rows, we know, it is none
//   0         a number the engine computed and it came out zero
//
// So a reader that cannot find orders.jsonl returns MISSING, not []. Every
// consumer can render it, because `${MISSING}` is the string "MISSING" and
// JSON.stringify(MISSING) is "MISSING". A page that shows "0 orders" during a
// failed deploy is lying with more confidence than one that shows MISSING.
//
// A NOTE ON THE RETIRED PROGRAMME
//
// The engine's raw JSON still carries its internal metric keys, flow.jsonl
// has `vvro_orders`, latest-run.json has `metrics.health.vvro_share_7d`. This
// module deliberately does NOT rewrite them: silently editing engine output
// would make the reader disagree with its own source, which is the exact
// failure this repo exists to referee. The scrub belongs in the single render
// chokepoint that every user-visible string passes through, not here and not
// at any individual call site. Anything that puts a raw engine key on screen
// must go through that escape function.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ----------------------------------------------------------------- MISSING

/**
 * The absent-source sentinel. Frozen, unique, and renderable in every place a
 * value normally goes: string interpolation, JSON, and a truthiness check
 * (`isMissing`, never `!value`. MISSING is an object and therefore truthy,
 * which is on purpose: `value || 0` must not quietly turn it into a number).
 */
export const MISSING = Object.freeze({
  missing: true,
  toString() {
    return 'MISSING';
  },
  toJSON() {
    return 'MISSING';
  },
  [Symbol.toPrimitive](hint) {
    return hint === 'number' ? Number.NaN : 'MISSING';
  },
});

/** True when `value` is the MISSING sentinel. */
export function isMissing(value) {
  return value === MISSING;
}

/** True when `value` is real data, anything that is neither MISSING nor null. */
export function isPresent(value) {
  return value !== MISSING && value !== null && value !== undefined;
}

/**
 * Read a dotted path out of a value, yielding MISSING the moment any step is
 * absent. `pick(run(), 'metrics.health.verdict')` is safe against a missing
 * file, a missing section and a missing key without a chain of `?.` and
 * without ever substituting a default the engine did not produce.
 *
 * `null` is preserved, not converted: the engine writes null to mean "computed
 * and not applicable" (e.g. `decomposition.ctr_now`), which is its own fact.
 */
export function pick(value, dottedPath) {
  if (isMissing(value) || value == null) return MISSING;
  let cursor = value;
  for (const key of String(dottedPath).split('.')) {
    if (cursor == null || typeof cursor !== 'object') return MISSING;
    if (!(key in cursor)) return MISSING;
    cursor = cursor[key];
  }
  return cursor === undefined ? MISSING : cursor;
}

// -------------------------------------------------------------- where data lives

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path of the engine-output directory. Override with XSTUDIOZ_DATA_DIR. */
export function dataDir() {
  return process.env.XSTUDIOZ_DATA_DIR
    ? path.resolve(process.env.XSTUDIOZ_DATA_DIR)
    : path.resolve(HERE, '..', 'data');
}

/** The files this module knows about, and the shape each one yields. */
export const SOURCES = Object.freeze({
  run: { file: 'latest-run.json', kind: 'json' },
  orders: { file: 'orders.jsonl', kind: 'jsonl' },
  leads: { file: 'leads.jsonl', kind: 'jsonl' },
  flow: { file: 'flow.jsonl', kind: 'jsonl' },
  impressions: { file: 'impressions.jsonl', kind: 'jsonl' },
  predictions: { file: 'predictions.jsonl', kind: 'jsonl' },
  calibration: { file: 'calibration.json', kind: 'json' },
});

// ------------------------------------------------------------------- cache
//
// Cached by (mtime, size). The container is long-lived and the files only
// change on deploy, so re-reading 580 KB of JSONL on every request is waste, 
// but a cache that cannot notice a redeploy is worse than no cache, so the
// stat is checked every call. stat is cheap; parsing 1,053 lines is not.

const cache = new Map();

/** Drop every cached parse. Exported for tests and for a manual refresh route. */
export function clearCache() {
  cache.clear();
}

function statOf(file) {
  try {
    const s = fs.statSync(file);
    return s.isFile() ? s : null;
  } catch {
    return null;
  }
}

/**
 * Split JSONL into records, tolerating blank lines and a trailing newline.
 *
 * A line that will not parse is NOT silently dropped into the void: it is
 * counted and kept in `errors`, because a reader that quietly loses rows
 * under-reports and the under-report looks exactly like a real number. The
 * count reaches the UI through dataStatus().
 */
function parseJsonl(text) {
  const rows = [];
  const errors = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    try {
      rows.push(JSON.parse(line));
    } catch (err) {
      errors.push({ line: i + 1, message: err.message, preview: line.slice(0, 120) });
    }
  }
  return { rows, errors };
}

/**
 * Load one named source. Returns a record describing what happened, the
 * public readers below unwrap it. Never throws for a missing file; that is a
 * fact to report, not an exception to handle. A file that exists but is
 * corrupt DOES surface as an error, because that is a broken deploy and
 * somebody has to be told.
 */
function load(name) {
  const spec = SOURCES[name];
  if (!spec) throw new Error(`Unknown engine source: ${name}`);

  const file = path.join(dataDir(), spec.file);
  const stat = statOf(file);

  if (!stat) {
    const record = {
      name,
      file,
      exists: false,
      value: MISSING,
      errors: [],
      mtime: null,
      bytes: 0,
      rows: MISSING,
    };
    cache.set(name, { key: null, record });
    return record;
  }

  const key = `${stat.mtimeMs}:${stat.size}`;
  const hit = cache.get(name);
  if (hit && hit.key === key) return hit.record;

  let record;
  try {
    const text = fs.readFileSync(file, 'utf8');
    if (spec.kind === 'json') {
      record = {
        name,
        file,
        exists: true,
        value: JSON.parse(text),
        errors: [],
        mtime: stat.mtime,
        bytes: stat.size,
        rows: MISSING,
      };
    } else {
      const { rows, errors } = parseJsonl(text);
      record = {
        name,
        file,
        exists: true,
        value: rows,
        errors,
        mtime: stat.mtime,
        bytes: stat.size,
        rows: rows.length,
      };
    }
  } catch (err) {
    // Present but unreadable. MISSING is the honest answer for the value, and
    // the error rides along so the page can say why rather than just blanking.
    record = {
      name,
      file,
      exists: true,
      value: MISSING,
      errors: [{ line: null, message: err.message, preview: null }],
      mtime: stat.mtime,
      bytes: stat.size,
      rows: MISSING,
    };
  }

  cache.set(name, { key, record });
  return record;
}

/** The raw load record for a source, file path, mtime, parse errors, value. */
export function source(name) {
  return load(name);
}

// ----------------------------------------------------------------- readers

/** The whole daily run object, or MISSING. Read fields with `pick()`. */
export function run() {
  return load('run').value;
}

/** Order rows (1,053 on current data), `[]` if genuinely empty, or MISSING. */
export function orders() {
  return load('orders').value;
}

/** Inquiry rows (319 on current data), `[]` if genuinely empty, or MISSING. */
export function leads() {
  return load('leads').value;
}

/** Daily order-flow rows, `[]` if genuinely empty, or MISSING. */
export function flow() {
  return load('flow').value;
}

/** Daily impression/click rows, `[]` if genuinely empty, or MISSING. */
export function impressions() {
  return load('impressions').value;
}

/** The forecast ledger, `[]` if genuinely empty, or MISSING. */
export function predictions() {
  return load('predictions').value;
}

/** Forecast calibration by metric and confidence band, or MISSING. */
export function calibration() {
  return load('calibration').value;
}

// --------------------------------------------------------------- staleness

const DEFAULT_STALE_AFTER_DAYS = 2;

function utcMidnight(value) {
  if (value instanceof Date) {
    return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/**
 * How old the run is.
 *
 * Age is measured in whole UTC days between the run's own `today` field and
 * now, not from the file's mtime, because a redeploy touches every file and
 * would make a three-day-old run look minutes fresh. The mtime is reported
 * alongside so the two can be compared when they disagree, which is itself a
 * signal: a new mtime with an old run date means the engine did not run.
 *
 * Returns `run_date: MISSING` and `age_days: MISSING` when there is no run
 * file. It never guesses an age, and `fresh` is false whenever age is unknown.
 *
 * @param {{now?: Date, staleAfterDays?: number}} [opts]
 */
/**
 * The date of the newest SOURCE record the run actually saw, dug out of the
 * self-check's data_freshness result.
 *
 * A run is only as fresh as its inputs. The engine can run today against
 * sheets nobody updated since Saturday, and it says so, but it says so in
 * prose inside a self-check result, which no consumer reads. Meanwhile the
 * run's own `today` field is genuinely today, so a page trusting that shows a
 * confident "fresh" badge over four-day-old numbers.
 *
 * That is precisely the failure this repo exists to prevent, so the age below
 * is measured from this date when it is available.
 */
function newestSourceRecord(runValue) {
  const results = runValue?.selfcheck?.results;
  if (!Array.isArray(results)) return null;
  for (const r of results) {
    if (r?.name !== 'data_freshness') continue;
    const text = String(r.detail ?? r.message ?? '');
    const m = text.match(/newest record is (\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
  }
  return null;
}

export function staleness({ now = new Date(), staleAfterDays = DEFAULT_STALE_AFTER_DAYS } = {}) {
  const record = load('run');
  const runValue = record.exists && !isMissing(record.value) ? record.value : null;
  const generatedOn = runValue ? pick(runValue, 'today') : MISSING;
  const sourceDate = runValue ? newestSourceRecord(runValue) : null;

  // Age is measured from the data, not from the run that read it. Falling back
  // to the run date only when the source date is unavailable keeps this honest
  // for older run files that predate the self-check field.
  const runDate = sourceDate ?? generatedOn;

  const base = {
    ok: false,
    file: record.file,
    exists: record.exists,
    run_date: MISSING,
    // What the engine WROTE, as distinct from what it READ. When these two
    // disagree the gap is the story: a run generated today off Saturday's
    // sheets means the intake is broken, not that the numbers are current.
    generated_on: isMissing(generatedOn) ? MISSING : generatedOn,
    source_date: sourceDate ?? MISSING,
    age_measured_from: sourceDate ? 'newest source record' : 'run date',
    generated_at: record.mtime ? record.mtime.toISOString() : MISSING,
    age_days: MISSING,
    age_hours: MISSING,
    fresh: false,
    stale_after_days: staleAfterDays,
    label: 'MISSING',
  };

  if (isMissing(runDate) || runDate == null) {
    base.label = record.exists ? 'run file unreadable' : 'no run file';
    return Object.freeze(base);
  }

  const runMs = utcMidnight(runDate);
  const nowMs = utcMidnight(now);
  if (runMs === null || nowMs === null) {
    base.run_date = runDate;
    base.label = 'run date unparseable';
    return Object.freeze(base);
  }

  const ageDays = Math.round((nowMs - runMs) / 86_400_000);
  const ageHours = Math.round((now.getTime() - runMs) / 3_600_000);

  return Object.freeze({
    ...base,
    ok: true,
    run_date: runDate,
    age_days: ageDays,
    age_hours: ageHours,
    fresh: ageDays <= staleAfterDays,
    label:
      ageDays <= 0 ? "today's run" : ageDays === 1 ? '1 day old' : `${ageDays} days old`,
  });
}

// ------------------------------------------------------------------ status

/**
 * One row per source: present or not, how many rows, how many unreadable
 * lines. This is what a health panel renders, and what makes a half-broken
 * deploy visible instead of arriving as quietly smaller numbers.
 */
export function dataStatus() {
  const sources = Object.keys(SOURCES).map((name) => {
    const r = load(name);
    return {
      name,
      file: path.basename(r.file),
      exists: r.exists,
      rows: r.rows,
      bytes: r.bytes,
      parse_errors: r.errors.length,
      readable: !isMissing(r.value),
    };
  });
  return {
    dir: dataDir(),
    sources,
    all_present: sources.every((s) => s.readable),
    missing: sources.filter((s) => !s.readable).map((s) => s.name),
    parse_errors: sources.reduce((n, s) => n + s.parse_errors, 0),
    staleness: staleness(),
  };
}

export default {
  MISSING,
  isMissing,
  isPresent,
  pick,
  dataDir,
  SOURCES,
  source,
  clearCache,
  run,
  orders,
  leads,
  flow,
  impressions,
  predictions,
  calibration,
  staleness,
  dataStatus,
};
