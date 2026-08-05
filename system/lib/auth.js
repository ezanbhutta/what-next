// lib/auth.js — one shared password to get in, then say who you are.
//
// The model, and why it is this one:
//
//   APP_PASSWORD  proves you are the team.        (a secret)
//   app_user      says which of the team you are. (attribution, not security)
//
// Splitting those two is the point. A single shared login with no name means
// every row in `audit`, every tick in `task_state`, every resolved
// reconciliation says "someone". The finding this whole hub exists for —
// 25 buyers marked Not Placed who had actually ordered — turned on the
// question "who marked this, and when". A system that cannot answer that
// question produces disagreements nobody can settle.
//
// So the name picker is not authentication and is not pretending to be. It is
// a signature on every write. Anyone with the password can sign as anyone;
// that is an accepted trade for a five-person team, and it is written down
// here so nobody later mistakes it for a security boundary.
//
// The session cookie is signed (HMAC-SHA256 over SESSION_SECRET), httpOnly,
// sameSite=lax and secure. It is stateless: no session table, so a restart or
// a database outage does not log the team out mid-shift.
//
// NEVER log a credential — not APP_PASSWORD, not what someone typed, not the
// cookie value. Failed logins are logged as an event, without the attempt.

import crypto from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { query, run, attempt, DbError, unavailableNotice } from './db.js';

export const COOKIE_NAME = 'xs_session';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // a week: a login lasts a work week
const SESSION_REFRESH_AFTER_MS = 12 * 60 * 60 * 1000; // slide the expiry once a day
const TOKEN_VERSION = 'v1';

// ------------------------------------------------------------------ config

/** What is missing before login can work at all. */
/**
 * A one-line description of the configured password that is safe to print:
 * how long it is, and whether the panel added anything. Never the value.
 *
 * This exists because "that password was not accepted" is otherwise a dead
 * end — the operator cannot see what the server holds, so a pasted trailing
 * space is indistinguishable from typing it wrong. Comparing the length you
 * expect against the length the server has settles it in one glance.
 */
export function passwordShape() {
  const raw = process.env.APP_PASSWORD;
  if (typeof raw !== 'string' || raw.length === 0) return 'not set';
  const clean = configuredPassword();
  const notes = [];
  if (raw !== raw.trim()) notes.push('surrounding whitespace was trimmed');
  if (clean && clean.length !== raw.trim().length) notes.push('wrapping quotes were removed');
  return `${clean ? clean.length : 0} characters${notes.length ? ` (${notes.join(', ')})` : ''}`;
}

export function authConfig() {
  const missing = [];
  if (!process.env.SESSION_SECRET) missing.push('SESSION_SECRET');
  if (!process.env.APP_PASSWORD) missing.push('APP_PASSWORD');
  const weak =
    process.env.SESSION_SECRET && process.env.SESSION_SECRET.length < 32
      ? 'SESSION_SECRET is shorter than 32 characters — generate a long random string.'
      : null;
  return { ok: missing.length === 0, missing, warning: weak };
}

export function authConfigured() {
  return authConfig().ok;
}

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s) {
    // No fallback, no generated-at-boot default. A generated secret would make
    // logins work locally and then silently invalidate every cookie on each
    // restart in production — a bug that looks like "the site logs me out".
    throw new Error('SESSION_SECRET is not set — refusing to sign sessions.');
  }
  return s;
}

// Separate derived keys so a cookie signature can never be replayed as a CSRF
// token, or the reverse.
function subkey(label) {
  return crypto.createHmac('sha256', secret()).update(`xstudioz:${label}:${TOKEN_VERSION}`).digest();
}

let insecureCookieWarned = false;

/** Cookie flags. `secure` is on in production, always. */
export function cookieOptions(maxAgeMs = SESSION_TTL_MS) {
  const production = process.env.NODE_ENV === 'production';
  const secure =
    process.env.COOKIE_SECURE === undefined ? production : process.env.COOKIE_SECURE === 'true';
  if (!secure && !insecureCookieWarned) {
    insecureCookieWarned = true;
    console.warn(
      '[auth] cookie secure=false — permitted only for http://localhost development. ' +
        'In production NODE_ENV=production must be set, which turns it back on.'
    );
  }
  return {
    httpOnly: true, // never readable from JavaScript
    secure, // never sent over plain http in production
    sameSite: 'lax', // blocks cross-site POSTs from carrying the session
    path: '/',
    maxAge: maxAgeMs,
  };
}

// -------------------------------------------------------------- primitives

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/**
 * Constant-time string comparison. Both sides are hashed first so the compare
 * runs over equal-length buffers — timingSafeEqual throws on a length
 * mismatch, and catching that throw would itself leak the length of the real
 * password to anyone who can time a login.
 */
export function timingSafeEqualStr(a, b) {
  const ha = crypto.createHash('sha256').update(String(a ?? ''), 'utf8').digest();
  const hb = crypto.createHash('sha256').update(String(b ?? ''), 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Does this match APP_PASSWORD? Never logs, never echoes the candidate. */
/**
 * The configured password, cleaned of the two things a hosting control panel
 * reliably adds when you paste into it: surrounding whitespace, and a pair of
 * wrapping quotes.
 *
 * Both produce a silent, unexplainable "that password was not accepted" — the
 * value looks correct in the panel, the person types it correctly, and the
 * comparison fails on a character nobody can see. Neither a leading space nor
 * a wrapping quote is plausibly part of a team password someone chose, so
 * accepting the cleaned form costs nothing and removes a failure mode that is
 * genuinely undiagnosable from the outside.
 */
export function configuredPassword() {
  const raw = process.env.APP_PASSWORD;
  if (typeof raw !== 'string') return null;
  let value = raw.trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' || first === "'") && first === last) value = value.slice(1, -1);
  }
  return value.length ? value : null;
}

export function checkPassword(candidate) {
  const expected = configuredPassword();
  if (!expected) return false; // unconfigured means nobody gets in, not everybody
  if (typeof candidate !== 'string' || candidate.length === 0) {
    timingSafeEqualStr('', expected); // keep the timing flat for empty input too
    return false;
  }
  // Trim the typed value too: phone keyboards add a trailing space after
  // autocomplete, and a password whose last character is a space is not a
  // thing anyone chose on purpose.
  return timingSafeEqualStr(candidate.trim(), expected);
}

// ----------------------------------------------------------------- tokens

/** Sign a session payload into a cookie value. */
export function signSession({ name, role, sid, iat, exp }) {
  const payload = { n: name, r: role, s: sid, i: iat, e: exp };
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac('sha256', subkey('session')).update(body).digest());
  return `${TOKEN_VERSION}.${body}.${sig}`;
}

/** Verify and decode a cookie value. Returns the session or null — never a
 *  partially-trusted object. */
export function verifySessionToken(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return null;
  const [, body, sig] = parts;

  let expected;
  try {
    expected = crypto.createHmac('sha256', subkey('session')).update(body).digest();
  } catch {
    return null; // SESSION_SECRET missing — treat every cookie as invalid
  }
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(given, expected)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload?.n || !payload?.e || Date.now() > Number(payload.e)) return null;

  return {
    name: String(payload.n),
    role: String(payload.r || 'csr'),
    sid: String(payload.s || ''),
    issuedAt: Number(payload.i || 0),
    expiresAt: Number(payload.e),
  };
}

// ----------------------------------------------------------------- devices
//
// The password is typed ONCE per device. After that the device carries a
// long-lived signed token and the team walks straight in.
//
// Why a second cookie rather than simply a longer session: the two answer
// different questions. The session says "this browser is signed in right now"
// and expires in a week. The device says "this laptop belongs to Nadir and has
// already proved it knows the password" and lasts a quarter. Keeping them
// separate lets the session refresh on its own cadence, lets the audit trail
// tell a fresh login from a resumed one, and keeps the name out of the weekly
// re-sign. Logging out clears BOTH — see logout() for why it must.
//
// The name is asked once, at device claim, and never again. It is not
// decoration: every tick, note and score is written with an author, and the
// question that started this whole project — "who marked this inquiry Not
// Placed?" — is unanswerable without it.
//
// REVOCATION: the device token is a bearer credential. Anyone holding the
// laptop is inside, which is the trade being asked for and is reasonable for
// an internal tool. To invalidate every device at once — someone leaves, a
// laptop is lost — rotate SESSION_SECRET in the Hostinger environment panel.
// Every device token and every session dies with it.

export const DEVICE_COOKIE = 'xs_device';

const DEVICE_TTL_MS = 90 * 24 * 60 * 60 * 1000; // a quarter
const DEVICE_VERSION = 'd1';

function signDevice({ name, role, did, exp }) {
  const payload = { n: name, r: role, d: did, e: exp };
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac('sha256', subkey('device')).update(body).digest());
  return `${DEVICE_VERSION}.${body}.${sig}`;
}

/** Verify a device cookie. Returns {name, role, did} or null — never partial. */
export function verifyDeviceToken(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== DEVICE_VERSION) return null;
  const [, body, sig] = parts;

  let expected;
  try {
    expected = crypto.createHmac('sha256', subkey('device')).update(body).digest();
  } catch {
    return null; // SESSION_SECRET missing — no device is trusted
  }
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(given, expected)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload?.n || !payload?.e || Date.now() > Number(payload.e)) return null;

  return {
    name: String(payload.n),
    role: String(payload.r || 'csr'),
    did: String(payload.d || ''),
    expiresAt: Number(payload.e),
  };
}

export function readDevice(req) {
  return verifyDeviceToken(readCookie(req, DEVICE_COOKIE));
}

/** Bind this browser to a person. Called once, after the name step. */
export function rememberDevice(res, { name, role = 'csr' }) {
  const device = {
    name,
    role,
    did: crypto.randomBytes(12).toString('base64url'),
    exp: Date.now() + DEVICE_TTL_MS,
  };
  res.cookie(DEVICE_COOKIE, signDevice(device), cookieOptions(DEVICE_TTL_MS));
  return device;
}

export function forgetDevice(res) {
  res.clearCookie(DEVICE_COOKIE, { ...cookieOptions(0), maxAge: undefined });
}

function readCookie(req, name) {
  if (req.cookies && typeof req.cookies[name] === 'string') return req.cookies[name];
  // Works whether or not cookie-parser is mounted.
  const header = req.headers?.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

// ---------------------------------------------------------------- sessions

/** Issue a cookie for this person. */
export function startSession(res, { name, role = 'csr' }) {
  const now = Date.now();
  const session = {
    name,
    role,
    sid: crypto.randomBytes(16).toString('base64url'),
    iat: now,
    exp: now + SESSION_TTL_MS,
  };
  res.cookie(COOKIE_NAME, signSession(session), cookieOptions(SESSION_TTL_MS));
  return { name, role, sid: session.sid, issuedAt: session.iat, expiresAt: session.exp };
}

/** The current session, or null. Cookie is the authority: a database outage
 *  must not silently sign the team out. */
export function readSession(req) {
  return verifySessionToken(readCookie(req, COOKIE_NAME));
}

export function endSession(res) {
  res.clearCookie(COOKIE_NAME, { ...cookieOptions(0), maxAge: undefined });
}

// -------------------------------------------------------------------- CSRF

/** Token bound to this session, for forms. Empty string when logged out. */
export function csrfToken(req) {
  const session = req.user || readSession(req);
  if (!session?.sid) return '';
  return b64url(crypto.createHmac('sha256', subkey('csrf')).update(session.sid).digest());
}

/**
 * Middleware for write routes. sameSite=lax already stops a cross-site POST
 * from carrying the cookie; this is the second lock, and it costs one hidden
 * input. Reads `_csrf` from the body or `x-csrf-token` from the headers.
 */
export function requireCsrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const expected = csrfToken(req);
  const given = req.body?._csrf || req.get?.('x-csrf-token') || '';
  if (expected && given && timingSafeEqualStr(given, expected)) return next();
  res.status(403);
  return next(new Error('This form expired or came from somewhere else. Reload the page and retry.'));
}

// ------------------------------------------------------------- rate limits

/**
 * Per-IP limit on login attempts. Successful logins are not counted, so a
 * working team is never locked out by its own usage.
 *
 * server.js must set `app.set('trust proxy', 1)` behind Hostinger's proxy —
 * one hop, not `true`. With `true`, any client can spoof X-Forwarded-For and
 * every attempt looks like a different address, which turns this limiter off
 * without any visible sign that it is off.
 */
export function makeLoginLimiter({ windowMs = 10 * 60 * 1000, max = 8 } = {}) {
  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests: true, // the route must answer 4xx on a bad attempt
    message: 'Too many login attempts. Wait ten minutes and try again.',
    handler(req, res, _next, options) {
      console.warn(`[auth] login rate limit hit from ${req.ip}`);
      res.status(options.statusCode).send(options.message);
    },
  });
}

/** Default limiter — mount on the login POST route. */
export const loginLimiter = makeLoginLimiter();

// ------------------------------------------------------------------ people

/** Active team members, for the name picker. Throws DbError if MySQL is
 *  unreachable — the login page then says so instead of showing an empty
 *  dropdown that reads like "nobody works here". */
export async function listUsers({ includeInactive = false } = {}) {
  const sql = includeInactive
    ? 'SELECT name, role, active FROM app_user ORDER BY role, name'
    : 'SELECT name, role, active FROM app_user WHERE active = 1 ORDER BY role, name';
  return query(sql);
}

export async function findUser(name) {
  const rows = await query('SELECT name, role, active FROM app_user WHERE name = ? LIMIT 1', [
    String(name ?? ''),
  ]);
  return rows[0] || null;
}

/** Append to `audit`. Best effort: an audit failure must not lose the write
 *  the user just made, but it is never swallowed silently either. */
export async function recordAudit(who, action, detail = null) {
  const result = await attempt(() =>
    run('INSERT INTO audit (who, action, detail) VALUES (?, ?, ?)', [
      who ? String(who).slice(0, 80) : null,
      String(action).slice(0, 80),
      detail === null || detail === undefined ? null : JSON.stringify(detail),
    ])
  );
  if (!result.ok) {
    console.error(`[auth] audit write failed (${action}): ${result.error.message}`);
  }
  return result.ok;
}

// ------------------------------------------------------------------- login

/**
 * Try to log in. Returns a discriminated result; the caller renders it.
 *   {ok:true,  user}
 *   {ok:false, reason, message}   reason ∈ not_configured | db_unavailable |
 *                                 unknown_name | bad_password
 *
 * The route must respond with a 4xx status on ok:false so `loginLimiter`
 * counts the attempt.
 */
export async function attemptLogin({ req, res, password }) {
  const cfg = authConfig();
  if (!cfg.ok) {
    return {
      ok: false,
      reason: 'not_configured',
      message: `Login is not configured — ${cfg.missing.join(' and ')} not set on the server.`,
    };
  }

  if (!checkPassword(password)) {
    // The event, never the attempt. No password material reaches a log.
    console.warn(`[auth] failed login from ${req?.ip ?? 'unknown ip'}`);
    await recordAudit(null, 'login_failed', { reason: 'bad_password', ip: req?.ip ?? null });
    return { ok: false, reason: 'bad_password', message: 'That password was not accepted.' };
  }

  // Known device: straight in, no second step, no name asked. This is the path
  // almost every login takes after the first one.
  const device = readDevice(req);
  if (device) {
    const session = startSession(res, { name: device.name, role: device.role });
    await recordAudit(device.name, 'login', { ip: req?.ip ?? null, device: device.did });
    return { ok: true, user: session };
  }

  // New device. The password is proven; carry that proof in a short-lived
  // signed cookie so the name step does not have to re-post the password in a
  // hidden field, and so a stale name form cannot be replayed tomorrow.
  res.cookie(PENDING_COOKIE, signPending(), cookieOptions(PENDING_TTL_MS));
  return { ok: true, needsName: true };
}

const PENDING_COOKIE = 'xs_pending';
const PENDING_TTL_MS = 5 * 60 * 1000;

function signPending() {
  const exp = Date.now() + PENDING_TTL_MS;
  const body = b64url(JSON.stringify({ e: exp }));
  const sig = b64url(crypto.createHmac('sha256', subkey('pending')).update(body).digest());
  return `p1.${body}.${sig}`;
}

function verifyPending(token) {
  if (typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'p1') return false;
  let expected;
  try {
    expected = crypto.createHmac('sha256', subkey('pending')).update(parts[1]).digest();
  } catch {
    return false;
  }
  const given = Buffer.from(parts[2], 'base64url');
  if (given.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(given, expected)) return false;
  try {
    const { e } = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return Date.now() <= Number(e);
  } catch {
    return false;
  }
}

/**
 * Second and final step on a new device: say who is using it.
 *
 * Asked exactly once per device, then never again. Without it every row this
 * person writes is signed by nobody, and "who marked this inquiry Not Placed"
 * — the question that produced the $3,628 finding — has no answer.
 */
export async function claimDevice({ req, res, name }) {
  if (!verifyPending(readCookie(req, PENDING_COOKIE))) {
    return { ok: false, reason: 'expired', message: 'That took too long — enter the password again.' };
  }

  let user;
  try {
    user = await findUser(name);
  } catch (error) {
    if (error instanceof DbError) {
      // Do NOT fall back to letting them in on the password alone. An
      // unattributed session is exactly the thing this design exists to
      // prevent, and "the database was down" is not a reason to write rows
      // signed by nobody.
      return { ok: false, reason: 'db_unavailable', message: unavailableNotice(error) };
    }
    throw error;
  }

  if (!user || !user.active) {
    return { ok: false, reason: 'unknown_name', message: 'Pick your name from the list.' };
  }

  const device = rememberDevice(res, { name: user.name, role: user.role });
  res.clearCookie(PENDING_COOKIE, { ...cookieOptions(0), maxAge: undefined });
  const session = startSession(res, { name: user.name, role: user.role });
  await recordAudit(user.name, 'device_claimed', { ip: req?.ip ?? null, device: device.did });
  return { ok: true, user: session };
}

export async function logout({ req, res }) {
  const session = readSession(req);
  endSession(res);
  // The device must go too. attachUser resumes a session from a valid device
  // cookie, so clearing only the session would sign the person back in on
  // their very next request and make the logout button do nothing visible.
  // Logging out is the one deliberate way to hand a laptop to someone else.
  forgetDevice(res);
  if (session?.name) await recordAudit(session.name, 'logout', null);
  return { ok: true };
}

// -------------------------------------------------------------- middleware

/**
 * Populate req.user / res.locals.user from the cookie. Never blocks. Slides
 * the expiry once a day so an active person is not thrown out mid-week.
 */
export function attachUser(req, res, next) {
  let session = readSession(req);

  // No session, but this device already proved the password and said who it
  // belongs to — resume silently. This is what makes the password a one-time
  // thing: the session lasts a week, the device lasts a quarter, and only the
  // device expiring ever puts the login form back in front of anyone.
  //
  // Safe because the device cookie is HMAC-signed with the same secret as the
  // session and carries its own expiry; an unsigned or stale one verifies to
  // null and this does nothing.
  if (!session) {
    const device = readDevice(req);
    if (device) session = startSession(res, { name: device.name, role: device.role });
  }

  req.user = session;
  res.locals.user = session;
  res.locals.csrfToken = session ? csrfToken(req) : '';
  if (session && Date.now() - session.issuedAt > SESSION_REFRESH_AFTER_MS) {
    // Re-sign in place, keeping the same sid. A fresh sid would invalidate the
    // CSRF token already rendered into whatever form the person has open, so
    // the refresh would silently break the page they are typing into.
    const now = Date.now();
    const refreshed = {
      name: session.name,
      role: session.role,
      sid: session.sid,
      iat: now,
      exp: now + SESSION_TTL_MS,
    };
    res.cookie(COOKIE_NAME, signSession(refreshed), cookieOptions(SESSION_TTL_MS));
    req.user = {
      name: refreshed.name,
      role: refreshed.role,
      sid: refreshed.sid,
      issuedAt: refreshed.iat,
      expiresAt: refreshed.exp,
    };
    res.locals.user = req.user;
  }
  next();
}

/** Gate a route. Redirects browsers to /login, answers 401 to fetch/XHR. */
export function requireAuth(req, res, next) {
  if (req.user) return next();
  const session = readSession(req);
  if (session) {
    req.user = session;
    res.locals.user = session;
    return next();
  }
  const wantsJson =
    req.get?.('x-requested-with') === 'XMLHttpRequest' ||
    (req.get?.('accept') || '').includes('application/json');
  if (wantsJson) return res.status(401).json({ error: 'not_authenticated' });
  const next_ = encodeURIComponent(req.originalUrl || '/');
  return res.redirect(302, `/login?next=${next_}`);
}

/** Gate a route by role, e.g. requireRole('owner','manager'). */
export function requireRole(...roles) {
  const allowed = new Set(roles.flat());
  return function roleGate(req, res, next) {
    if (!req.user) return requireAuth(req, res, next);
    if (allowed.has(req.user.role)) return next();
    res.status(403);
    return next(new Error(`This section is for ${[...allowed].join(' or ')}.`));
  };
}

/** Where a login should land, without letting `next` bounce off-site. */
export function safeNext(value, fallback = '/') {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return fallback;
  return value;
}

export default {
  COOKIE_NAME,
  authConfig,
  authConfigured,
  cookieOptions,
  checkPassword,
  timingSafeEqualStr,
  signSession,
  verifySessionToken,
  startSession,
  readSession,
  endSession,
  csrfToken,
  requireCsrf,
  makeLoginLimiter,
  loginLimiter,
  listUsers,
  findUser,
  recordAudit,
  attemptLogin,
  logout,
  attachUser,
  requireAuth,
  requireRole,
  safeNext,
};
