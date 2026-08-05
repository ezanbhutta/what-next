// lib/db.js — MySQL pool, query helpers, and honest failure.
//
// SCOPE: this connection reaches exactly one database — the hub's own MySQL,
// which holds only what a human typed. Nothing computed lives here. If you
// are about to write SQL that recomputes a number the Python engine already
// produced, stop and read it from data/ instead (lib/data.js).
//
// THE FAILURE RULE
//
// When MySQL is unreachable these helpers throw, loudly, with a flag saying
// the store is unavailable. They never return [] and let the caller carry on.
// The shift logger shows "all caught up" during an outage for exactly that
// reason: an empty result and an unreachable database are indistinguishable
// downstream, so a page renders reassurance it has no evidence for. An empty
// array is a fact about the data. An outage is a fact about the system. They
// must not arrive in the same shape.
//
// Two ways to call, and the choice is the whole design:
//   query()/queryOne()/run()  throw on failure — use when the page cannot
//                             honestly render without the answer.
//   tryQuery()/attempt()      return {ok:false, error} — use when the page
//                             can render around the hole, and then it MUST
//                             say the hole is there (unavailableNotice()).
// There is deliberately no third option that quietly yields nothing.

import mysql from 'mysql2/promise';

// ------------------------------------------------------------------ errors

export class DbError extends Error {
  constructor(message, { code = null, unavailable = false, cause = null, sql = null } = {}) {
    super(redact(message));
    this.name = 'DbError';
    this.code = code;
    // `unavailable` = the store could not be reached or entered at all.
    // False means MySQL answered and rejected us — that is a bug in our SQL,
    // not an outage, and it should reach the developer, not a status banner.
    this.unavailable = unavailable;
    this.sql = sql;
    if (cause) this.cause = cause;
  }
}

export class DbConfigError extends DbError {
  constructor(missing) {
    super(
      `Database is not configured — missing environment variable(s): ${missing.join(', ')}. ` +
        'Set them in the Hostinger Web App environment panel (or .env locally).',
      { code: 'DB_NOT_CONFIGURED', unavailable: true }
    );
    this.name = 'DbConfigError';
    this.missing = missing;
  }
}

// Connection-level codes: the store was not reached, or would not let us in.
// Access-denied and unknown-database are included on purpose — from a page's
// point of view "wrong credentials" is the same event as "server is down":
// no data, and nobody should pretend otherwise.
const UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ECONNRESET',
  'PROTOCOL_CONNECTION_LOST',
  'PROTOCOL_SEQUENCE_TIMEOUT',
  'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR',
  'POOL_CLOSED',
  'ER_CON_COUNT_ERROR',
  'ER_ACCESS_DENIED_ERROR',
  'ER_DBACCESS_DENIED_ERROR',
  'ER_BAD_DB_ERROR',
  'ER_LOCK_WAIT_TIMEOUT',
]);

// Transient enough that one immediate retry is honest rather than hopeful:
// a pooled socket that died between checkout and use.
const RETRYABLE_CODES = new Set([
  'ECONNRESET',
  'EPIPE',
  'PROTOCOL_CONNECTION_LOST',
  'ER_LOCK_DEADLOCK',
]);

// ------------------------------------------------------------- redaction

// Never log a credential. mysql2 errors do not normally quote the password,
// but a stack, a DSN in a message or a careless template literal can, and one
// leak into a log file is permanent. Everything that becomes a DbError
// message goes through here first.
export function redact(text) {
  let out = String(text ?? '');
  for (const name of ['DB_PASSWORD', 'SESSION_SECRET', 'APP_PASSWORD']) {
    const secret = process.env[name];
    if (secret && secret.length >= 4) {
      out = out.split(secret).join(`[${name} redacted]`);
    }
  }
  // Credentials embedded in a URI: mysql://user:pass@host/db
  return out.replace(/(\w+:\/\/[^:@\s]+:)[^@\s]+@/g, '$1[redacted]@');
}

// ------------------------------------------------------------------ config

const REQUIRED_ENV = ['DB_NAME', 'DB_USER', 'DB_PASSWORD'];

/** Which required env vars are absent. DB_PASSWORD may be set to an empty
 *  string deliberately; it may not be left undefined, because there is no
 *  default password anywhere in this codebase and there never will be. */
export function missingEnv() {
  return REQUIRED_ENV.filter((k) => process.env[k] === undefined || process.env[k] === null);
}

export function dbConfigured() {
  return missingEnv().length === 0;
}

/** Connection facts that are safe to print: never the user, never the password. */
export function dbTarget() {
  return {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    database: process.env.DB_NAME || null,
  };
}

// ------------------------------------------------------------------- pool

let pool = null;
let poolSignature = null;

const status = {
  configured: false,
  ok: null, // null = never tried
  lastOkAt: null,
  lastFailAt: null,
  lastError: null, // { code, message } — already redacted
};

function buildPool() {
  const missing = missingEnv();
  if (missing.length) throw new DbConfigError(missing);

  const target = dbTarget();
  return mysql.createPool({
    host: target.host,
    port: target.port,
    database: target.database,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,

    waitForConnections: true,
    connectionLimit: Number(process.env.DB_POOL_SIZE || 8),
    maxIdle: Number(process.env.DB_POOL_SIZE || 8),
    idleTimeout: 60_000,
    queueLimit: 0,
    connectTimeout: 10_000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10_000,

    // Off deliberately. Every statement is sent on its own; db/migrate.js
    // splits schema.sql itself. With this on, one stray `;` in a form value
    // turns a query into two.
    multipleStatements: false,

    // DATE columns come back as 'YYYY-MM-DD' strings, not JS Dates. A DATE
    // parsed into a Date is midnight in the server's zone, and printing it
    // anywhere east or west of that silently shifts run_date and entry_date
    // by a day — a whole day of entries landing on the wrong row.
    dateStrings: ['DATE'],

    // DECIMAL stays a string. Money is DECIMAL(10,2) in the schema; turning
    // it into a float here would be this repo reintroducing rounding drift
    // into the one place that is supposed to be exact. Format at the edge.
    decimalNumbers: false,

    charset: 'utf8mb4_general_ci',
    timezone: 'Z',
  });
}

/** The shared pool. Throws DbConfigError if the environment is incomplete. */
export function getPool() {
  const target = dbTarget();
  const signature = `${target.host}:${target.port}/${target.database}/${process.env.DB_USER}`;
  if (pool && poolSignature !== signature) {
    // Env changed under us (tests, a reload). Drop the stale pool rather than
    // keep answering from a connection to the old database.
    const stale = pool;
    pool = null;
    stale.end().catch(() => {});
  }
  if (!pool) {
    pool = buildPool();
    poolSignature = signature;
  }
  status.configured = true;
  return pool;
}

export async function closePool() {
  if (!pool) return;
  const p = pool;
  pool = null;
  poolSignature = null;
  await p.end().catch(() => {});
}

// ------------------------------------------------------------- error shape

function wrap(err, sql) {
  if (err instanceof DbError) return err;
  const code = err?.code || err?.errno || null;
  const unavailable = UNAVAILABLE_CODES.has(code);
  const wrapped = new DbError(err?.sqlMessage || err?.message || 'Unknown database error', {
    code,
    unavailable,
    cause: err,
    sql: sql ? String(sql).slice(0, 300) : null,
  });
  return wrapped;
}

function noteOk() {
  status.configured = true;
  status.ok = true;
  status.lastOkAt = new Date();
  status.lastError = null;
}

function noteFail(err) {
  status.configured = dbConfigured();
  status.ok = false;
  status.lastFailAt = new Date();
  status.lastError = { code: err.code, message: err.message, unavailable: err.unavailable };
  const t = dbTarget();
  // Host, port, database and error code only. No user, no password, no params.
  console.error(
    `[db] ${err.unavailable ? 'UNAVAILABLE' : 'ERROR'} ${err.code || '-'} ` +
      `target=${t.host}:${t.port}/${t.database ?? '-'} :: ${err.message}`
  );
}

/** Current health, for the masthead banner. `ok:null` means never queried. */
export function dbStatus() {
  return {
    configured: dbConfigured(),
    missingEnv: missingEnv(),
    ok: status.ok,
    lastOkAt: status.lastOkAt,
    lastFailAt: status.lastFailAt,
    lastError: status.lastError,
    target: dbTarget(),
  };
}

/** The sentence a page prints when it could not read. Say the store is down;
 *  never let the absence read as "nothing to do". */
export function unavailableNotice(err) {
  if (err instanceof DbConfigError) {
    return 'Database not configured — typed records cannot be read or saved. This is MISSING, not zero.';
  }
  return (
    'Database unreachable — typed records (ticks, notes, scores, entries) could not be read. ' +
    'What is shown below is MISSING, not zero, and nothing was saved.'
  );
}

// --------------------------------------------------------------- querying

async function exec(sql, params, { retry = true } = {}) {
  const p = getPool(); // throws DbConfigError when env is incomplete
  try {
    const [result, fields] = await p.execute(sql, params);
    noteOk();
    return [result, fields];
  } catch (err) {
    const wrapped = wrap(err, sql);
    if (retry && RETRYABLE_CODES.has(wrapped.code)) {
      // One retry, no backoff: this is a dead pooled socket, not a busy server.
      try {
        const [result, fields] = await p.execute(sql, params);
        noteOk();
        return [result, fields];
      } catch (err2) {
        const wrapped2 = wrap(err2, sql);
        noteFail(wrapped2);
        throw wrapped2;
      }
    }
    noteFail(wrapped);
    throw wrapped;
  }
}

/** SELECT → array of rows. Throws DbError on any failure. Never returns []
 *  because of an outage; [] here always means "the query matched nothing". */
export async function query(sql, params = []) {
  const [rows] = await exec(sql, params);
  return Array.isArray(rows) ? rows : [];
}

/** SELECT → first row or null. Throws DbError on failure. */
export async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows.length ? rows[0] : null;
}

/** SELECT one column of one row, or null. */
export async function queryValue(sql, params = []) {
  const row = await queryOne(sql, params);
  if (!row) return null;
  const keys = Object.keys(row);
  return keys.length ? row[keys[0]] : null;
}

/** INSERT/UPDATE/DELETE → {insertId, affectedRows, changedRows}. Throws. */
export async function run(sql, params = []) {
  const [result] = await exec(sql, params);
  return {
    insertId: result?.insertId ?? null,
    affectedRows: result?.affectedRows ?? 0,
    changedRows: result?.changedRows ?? 0,
  };
}

/** DDL and anything else that cannot take placeholders (mysql2's prepared
 *  path rejects some statements). Used by db/migrate.js. Throws. */
export async function raw(sql) {
  const p = getPool();
  try {
    const [result] = await p.query(sql);
    noteOk();
    return result;
  } catch (err) {
    const wrapped = wrap(err, sql);
    noteFail(wrapped);
    throw wrapped;
  }
}

// ---------------------------------------------------------- transactions

/**
 * Run several writes as one. `fn` receives {query, queryOne, queryValue, run,
 * connection} bound to a single connection. Rolls back on any throw and
 * rethrows — a partial write is a number nobody can trust later.
 */
export async function transaction(fn) {
  const p = getPool();
  let conn;
  try {
    conn = await p.getConnection();
  } catch (err) {
    const wrapped = wrap(err, null);
    noteFail(wrapped);
    throw wrapped;
  }
  const bound = {
    connection: conn,
    async query(sql, params = []) {
      try {
        const [rows] = await conn.execute(sql, params);
        return Array.isArray(rows) ? rows : [];
      } catch (err) {
        throw wrap(err, sql);
      }
    },
    async queryOne(sql, params = []) {
      const rows = await bound.query(sql, params);
      return rows.length ? rows[0] : null;
    },
    async queryValue(sql, params = []) {
      const row = await bound.queryOne(sql, params);
      if (!row) return null;
      const keys = Object.keys(row);
      return keys.length ? row[keys[0]] : null;
    },
    async run(sql, params = []) {
      try {
        const [result] = await conn.execute(sql, params);
        return {
          insertId: result?.insertId ?? null,
          affectedRows: result?.affectedRows ?? 0,
          changedRows: result?.changedRows ?? 0,
        };
      } catch (err) {
        throw wrap(err, sql);
      }
    },
  };
  try {
    await conn.beginTransaction();
    const value = await fn(bound);
    await conn.commit();
    noteOk();
    return value;
  } catch (err) {
    try {
      await conn.rollback();
    } catch {
      /* the connection is already gone; the transaction dies with it */
    }
    const wrapped = wrap(err, null);
    noteFail(wrapped);
    throw wrapped;
  } finally {
    conn.release();
  }
}

// ------------------------------------------------- explicit degraded reads

/**
 * The only sanctioned way to carry on without the database.
 * Returns {ok:true, rows} or {ok:false, error, notice} — a shape the caller
 * cannot mistake for data. Renderers must print `notice` when ok is false.
 */
export async function tryQuery(sql, params = []) {
  try {
    return { ok: true, rows: await query(sql, params) };
  } catch (error) {
    return { ok: false, error, notice: unavailableNotice(error) };
  }
}

/** Same contract around any db-touching function. */
export async function attempt(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    if (error instanceof DbError) return { ok: false, error, notice: unavailableNotice(error) };
    throw error; // not a database problem — do not disguise it as one
  }
}

/** Cheap liveness probe. Returns {ok, error}; also refreshes dbStatus(). */
export async function ping() {
  try {
    await query('SELECT 1 AS ok');
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Express middleware: refresh health for the masthead and hang the status on
 * res.locals. Does NOT block the request — a page that needs the database
 * says so itself; a page that does not (everything read from data/) still
 * works during an outage, which is most of the hub.
 */
export function dbHealth({ intervalMs = 15_000 } = {}) {
  let lastCheck = 0;
  let inFlight = null;
  return async function dbHealthMiddleware(req, res, next) {
    const now = Date.now();
    if (dbConfigured() && now - lastCheck > intervalMs && !inFlight) {
      lastCheck = now;
      inFlight = ping().finally(() => {
        inFlight = null;
      });
      await inFlight.catch(() => {});
    }
    res.locals.db = dbStatus();
    next();
  };
}

export default {
  DbError,
  DbConfigError,
  getPool,
  closePool,
  query,
  queryOne,
  queryValue,
  run,
  raw,
  transaction,
  tryQuery,
  attempt,
  ping,
  dbStatus,
  dbHealth,
  dbConfigured,
  dbTarget,
  missingEnv,
  unavailableNotice,
  redact,
};
