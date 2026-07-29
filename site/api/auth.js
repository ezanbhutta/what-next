// Server-side auth for the XStudioz daily brief.
//
// Copied verbatim from ezanbhutta/csr-pulse api/auth.js so the suite has ONE
// auth implementation rather than two that drift. Only the cookie name is
// namespaced, so a session on CSR Pulse is not a session here.
//
// The password is read from the APP_PASSWORD environment variable (set in the
// Vercel dashboard) and is NEVER shipped to the browser. On a correct password
// the server sets an httpOnly, Secure, SameSite=Strict session cookie holding a
// short HMAC-signed token — JavaScript in the page can never read it, so an XSS
// bug can't steal the session.
//
// The signing key binds the password to an optional server-only SESSION_SECRET,
// so sessions can be revoked org-wide by rotating SESSION_SECRET in Vercel
// WITHOUT changing the password staff type. (If SESSION_SECRET is unset it falls
// back to the password alone, so nothing breaks before it's configured.)
//
// Routes (single function, POST only, JSON only, same-origin only):
//   { action: 'login', password } -> 200 {ok:true} + Set-Cookie | 401 | 429
//   { action: 'verify' }          -> 200 {ok:true} | 401   (reads the cookie)
//   { action: 'logout' }          -> 200 {ok:true} + clears the cookie
import crypto from 'node:crypto';

// Cap the request body so a giant payload can't burn CPU/memory on every hit.
export const config = { api: { bodyParser: { sizeLimit: '1kb' } } };

const SESSION_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
const COOKIE = '__Host-xsbrief_session';        // __Host- = Secure + Path=/ + no Domain
const MAX_FIELD = 256;                        // reject absurdly long password/token inputs

// ── Token ─────────────────────────────────────────────────────────────────
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();
const signingKey = (password) =>
  process.env.SESSION_SECRET
    ? crypto.createHmac('sha256', process.env.SESSION_SECRET).update(sha256(password)).digest()
    : sha256(password);

const makeToken = (password) => {
  const now = Date.now();
  const payload = b64url(JSON.stringify({ exp: now + SESSION_MS, iat: now, jti: crypto.randomBytes(9).toString('base64url') }));
  const sig = b64url(crypto.createHmac('sha256', signingKey(password)).update(payload).digest());
  return `${payload}.${sig}`;
};

const verifyToken = (token, password) => {
  if (typeof token !== 'string' || token.length > 4096 || !token.includes('.')) return false;
  const [payload, sig] = token.split('.');
  const expected = b64url(crypto.createHmac('sha256', signingKey(password)).update(payload).digest());
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return typeof exp === 'number' && exp > Date.now();
  } catch { return false; }
};

// ── Rate limiting (per-IP) ──────────────────────────────────────────────────
// Best-effort in-memory for the warm instance; durable + cross-instance when
// Upstash REST env vars are set (free tier). Only LOGIN attempts are limited.
const WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILS = 10;
const mem = new Map(); // ip -> number[] (recent failed-attempt timestamps)

const clientIp = (req) =>
  String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
  String(req.headers['x-real-ip'] || '') || 'unknown';

const overLimitMem = (ip) => {
  const now = Date.now();
  const arr = (mem.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  mem.set(ip, arr);
  return arr.length >= MAX_FAILS;
};
const recordFailMem = (ip) => { const arr = mem.get(ip) || []; arr.push(Date.now()); mem.set(ip, arr); };

const pickEnv = (re, exclude) => {
  const k = Object.keys(process.env).find((key) => re.test(key) && (!exclude || !exclude.test(key)));
  return k ? process.env[k] : undefined;
};
async function overLimitKv(ip) {
  const url = pickEnv(/(?:REST_API_URL|REDIS_REST_URL)$/);
  const tok = pickEnv(/(?:REST_API_TOKEN|REDIS_REST_TOKEN)$/, /READ_ONLY/);
  if (!url || !tok) return false;
  try {
    const key = `csrp:rl:${ip}`;
    const r = await fetch(`${url}/incr/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${tok}` } });
    const { result } = await r.json();
    if (result === 1) await fetch(`${url}/expire/${encodeURIComponent(key)}/${Math.ceil(WINDOW_MS / 1000)}`, { headers: { Authorization: `Bearer ${tok}` } });
    return typeof result === 'number' && result > MAX_FAILS;
  } catch { return false; } // never fail-open hard; in-memory still applies
}

// ── Cookies ─────────────────────────────────────────────────────────────────
const cookieFrom = (req, name) => {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
};
const setCookie = (res, value, maxAgeSec) =>
  res.setHeader('Set-Cookie', `${COOKIE}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}`);

// ── Handler ──────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');

  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); res.status(405).json({ ok: false }); return; }

  // Same-origin only (defense-in-depth against cross-site abuse).
  const origin = req.headers.origin;
  if (origin && req.headers.host && origin !== `https://${req.headers.host}`) { res.status(403).json({ ok: false }); return; }

  if (!String(req.headers['content-type'] || '').includes('application/json')) { res.status(415).json({ ok: false }); return; }

  const APP_PASSWORD = process.env.APP_PASSWORD;
  if (!APP_PASSWORD) {
    // Generic to the client; the real reason goes only to server logs.
    console.error('AUTH MISCONFIG: APP_PASSWORD environment variable is not set');
    res.status(503).json({ ok: false });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  if (body.action === 'login') {
    const ip = clientIp(req);
    if (overLimitMem(ip) || await overLimitKv(ip)) {
      res.setHeader('Retry-After', String(Math.ceil(WINDOW_MS / 1000)));
      res.status(429).json({ ok: false });
      return;
    }
    const supplied = String(body.password ?? '');
    const ok = supplied.length <= MAX_FIELD && crypto.timingSafeEqual(sha256(supplied), sha256(APP_PASSWORD));
    if (!ok) {
      recordFailMem(ip);
      await new Promise((r) => setTimeout(r, 350)); // small per-attempt delay
      res.status(401).json({ ok: false });
      return;
    }
    setCookie(res, makeToken(APP_PASSWORD), Math.floor(SESSION_MS / 1000));
    res.status(200).json({ ok: true });
    return;
  }

  if (body.action === 'verify') {
    const ok = verifyToken(cookieFrom(req, COOKIE), APP_PASSWORD);
    res.status(ok ? 200 : 401).json({ ok });
    return;
  }

  if (body.action === 'logout') {
    setCookie(res, '', 0);
    res.status(200).json({ ok: true });
    return;
  }

  res.status(400).json({ ok: false });
}
