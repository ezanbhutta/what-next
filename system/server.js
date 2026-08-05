// server.js — the Express application.
//
// WHAT THIS FILE IS RESPONSIBLE FOR
//
//   routing · sessions · CSRF · section locks · loading each route's material
//   from the two stores · handing it to a view · never letting a failure
//   render as a plausible number.
//
// WHAT IT IS NOT RESPONSIBLE FOR
//
//   Computing anything. Every figure comes from data/ (lib/data.js) or from a
//   row a human typed (MySQL). This file never derives a third copy.
//
// THE TWO STORES, AND WHY A ROUTE TOUCHES BOTH
//
//   data/*.json   engine output, read from disk, works during a database
//                 outage. Most of the hub is this.
//   MySQL         only what a human typed here: ticks, entries, notes,
//                 scores, the reply library, the upsell board.
//
//   So an unreachable database degrades the hub; it does not stop it. Every
//   route that could not read its typed rows says so in a banner and renders
//   the disk-based half. `q()` returns rows:null on failure — never [] — so a
//   view that forgets to check `.ok` throws instead of quietly rendering
//   "nothing to do" during an outage. That failure mode is the reason this
//   repo exists.
//
// EVERY WRITE IS AUDITED, ATOMICALLY
//
//   `auditedWrite()` puts the change and its audit row in one transaction. If
//   the audit cannot be written the change is rolled back. "Who marked this,
//   and when" is the question the whole reconciliation finding turned on, and
//   a write with no answer to it is worth less than no write.

import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';

import {
  tryQuery,
  transaction,
  ping,
  dbStatus,
  dbHealth,
  dbConfigured,
  dbTarget,
  missingEnv,
  DbError,
  unavailableNotice,
} from './lib/db.js';

import {
  attachUser,
  requireAuth,
  requireCsrf,
  attemptLogin,
  claimDevice,
  logout as endLogin,
  loginLimiter,
  listUsers,
  authConfig,
  authConfigured,
  safeNext,
} from './lib/auth.js';

import {
  MISSING,
  isMissing,
  pick,
  run as engineRun,
  orders as engineOrders,
  leads as engineLeads,
  staleness,
  dataStatus,
} from './lib/data.js';

import { reconcile, normaliseBuyer } from './lib/reconcile.js';

import {
  layout,
  errorPage,
  html,
  safe,
  join,
  esc,
  missing,
  money,
  num,
  rate,
  SECTIONS,
  SECTION_BY_KEY,
} from './views/layout.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRODUCTION = process.env.NODE_ENV === 'production';

export const app = express();

// ============================================================================
// 1. PLATFORM
// ============================================================================

// One hop, not `true`. With `true` any client can spoof X-Forwarded-For, every
// login attempt looks like a different address, and the rate limiter is off
// with nothing on screen to say so.
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.set('etag', 'strong');

// A nonce per response, minted before helmet reads the CSP directives.
//
// HEX, not base64, and that is not cosmetic. layout() runs the retired-name
// scrub over the finished document; a base64 nonce can contain the substring
// it rewrites (roughly one response in a million), and the rewrite would edit
// the nonce in the HTML while the CSP header kept the original — the shell's
// scripts would be blocked, giving a white flash to a dark-mode user and a
// dead theme toggle, intermittently and unreproducibly. Hex cannot contain it.
app.use((req, res, next) => {
  res.locals.nonce = crypto.randomBytes(16).toString('hex');
  next();
});

app.use(
  helmet({
    // useDefaults:false — the policy below is the whole policy. A default that
    // silently widens is not a policy anyone can reason about.
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"],
        'base-uri': ["'none'"],
        'object-src': ["'none'"],
        'frame-ancestors': ["'none'"],
        'form-action': ["'self'"],
        // No 'unsafe-inline', no 'unsafe-eval', no external host. The two
        // inline scripts the shell needs (the pre-paint theme stamp and the
        // rail behaviours) carry this nonce.
        'script-src': ["'self'", (req, res) => `'nonce-${res.locals.nonce}'`],
        'script-src-attr': ["'none'"],
        // Stylesheets come from /app.css and nowhere else. Inline style
        // ATTRIBUTES are allowed because the design system positions its range
        // bands and meter fills by writing a custom property per element
        // (style="--lo:15.7%") — that is data, computed per row, and it cannot
        // live in a static file. style-src-attr is the narrow permission for
        // exactly that; inline <style> blocks stay forbidden.
        'style-src': ["'self'"],
        'style-src-attr': ["'unsafe-inline'"],
        // data: is for the paper grain and the favicon, both inlined in the
        // stylesheet/head so the page makes zero network requests off-origin.
        'img-src': ["'self'", 'data:'],
        'font-src': ["'self'"],
        'connect-src': ["'self'"],
        'manifest-src': ["'self'"],
        ...(PRODUCTION ? { 'upgrade-insecure-requests': [] } : {}),
      },
    },
    referrerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    hsts: PRODUCTION ? { maxAge: 15_552_000, includeSubDomains: true } : false,
  })
);

app.use(
  express.static(path.join(HERE, 'public'), {
    index: false,
    dotfiles: 'ignore',
    etag: true,
    maxAge: PRODUCTION ? '1h' : 0,
  })
);

app.use(express.urlencoded({ extended: false, limit: '256kb' }));
app.use(cookieParser());
app.use(attachUser);
app.use(dbHealth());

// The page carries client names, revenue and the dead pipeline. Nothing about
// it should sit in a shared cache or a back-forward buffer.
app.use((req, res, next) => {
  if (req.path !== '/healthz' && !req.path.endsWith('.css')) {
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
  }
  next();
});

/** Express 4 does not catch a rejected promise from a handler. This does. */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ============================================================================
// 2. REQUEST CONTEXT — the shape every view receives
// ============================================================================

const ROLE_RANK = { csr: 0, manager: 1, owner: 2 };

const FLASH_OK = {
  saved: 'The change was written and recorded in the audit log.',
  ticked: 'Checklist updated.',
  entry: "Today's numbers were saved.",
  resolved: 'Marked resolved.',
  note: 'Note added to this client.',
  logged: 'Message logged against this buyer.',
  response: 'Reply library updated.',
  team: 'Weekly review saved.',
  decision: 'Decision recorded.',
  upsell: 'Upsell row updated.',
  access: 'Section access updated.',
};

const FLASH_ERR = {
  invalid: 'Some fields were not accepted. Nothing was written.',
  buyer: 'That buyer username was empty or not recognised.',
  notfound: 'That record no longer exists.',
  db: 'The typed-records database could not be written to. Nothing was saved.',
};

function themeOf(req) {
  return req.cookies?.['xs-theme'] === 'dark' ? 'dark' : 'light';
}

function shortMoney(value) {
  if (value === null || value === undefined || isMissing(value) || !Number.isFinite(Number(value))) {
    return null;
  }
  const n = Number(value);
  return n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${Math.round(n)}`;
}

/** The six standing figures. Every one goes through a formatter that renders
 *  MISSING as MISSING — none of them can print a zero it did not compute. */
function defaultTicker(run, stale) {
  const verdict = pick(run, 'metrics.health.verdict');
  const breached = pick(run, 'metrics.health.breached');
  const inquiries = pick(run, 'metrics.funnel.inquiries');
  const placed = pick(run, 'metrics.funnel.placed');
  const conv = rate(placed, inquiries);

  return [
    {
      label: 'Organic health',
      value: isMissing(verdict) ? missing() : html`${String(verdict)}`,
      sub: breached === true ? 'constraint breached' : breached === false ? 'not breached' : null,
    },
    {
      label: 'Money at rest',
      value: money(pick(run, 'recovery.total_at_rest')),
      sub: 'no new traffic needed',
    },
    {
      label: 'Open past 60 days',
      value: num(pick(run, 'recovery.open_orders.stale_count')),
      sub: shortMoney(pick(run, 'recovery.open_orders.stale_value')),
    },
    {
      label: 'Revenue',
      value: money(pick(run, 'metrics.economics.revenue')),
      sub: isMissing(pick(run, 'window.label')) ? null : String(pick(run, 'window.label')),
    },
    {
      label: 'Inquiry conversion',
      value: conv.ok ? conv.html : missing(),
      sub: conv.ok ? (conv.small ? `Wilson 95% · n=${conv.n}` : `n=${conv.n}`) : null,
    },
    {
      label: 'Engine run',
      value: isMissing(stale.run_date) ? missing() : html`${String(stale.run_date)}`,
      sub: stale.ok ? stale.label : 'not readable',
    },
  ];
}

function navFor(run, sectionKey, access) {
  const tags = {
    today: Array.isArray(pick(run, 'tasks')) ? String(pick(run, 'tasks').length) : null,
    orders: isMissing(pick(run, 'recovery.open_orders.open_count'))
      ? null
      : String(pick(run, 'recovery.open_orders.open_count')),
    inquiries: isMissing(pick(run, 'recovery.quotes.count'))
      ? null
      : String(pick(run, 'recovery.quotes.count')),
    money: shortMoney(pick(run, 'recovery.total_at_rest')),
  };
  return SECTIONS.map((s, i) => ({
    ...s,
    keycap: String(i + 1),
    tag: tags[s.key] || null,
    current: s.key === sectionKey,
    locked: access.lockedKeys.has(s.key),
  }));
}

/**
 * THE CONTEXT OBJECT. This is the contract a view module is written against.
 * See the header of views/layout.js for the return shape a view owes back.
 */
function buildCtx(req, res, sectionKey, { access = null, headline = null, chrome = null } = {}) {
  const run = engineRun();
  const stale = staleness();
  const acc = access || { ok: true, lockedKeys: new Set(), map: new Map(), error: null };

  const ctx = {
    // --- who and where -----------------------------------------------------
    user: req.user || null,
    section: sectionKey,
    path: req.path,
    params: { ...req.params },
    query: { ...req.query },
    csrfToken: res.locals.csrfToken || '',
    nonce: res.locals.nonce,
    theme: themeOf(req),
    chrome,
    headline,

    // --- engine data (computed elsewhere, read-only, may be MISSING) --------
    run,
    engine: {
      ok: !isMissing(run),
      staleness: stale,
      runDate: isMissing(stale.run_date) ? null : stale.run_date,
      stale: !stale.fresh,
    },

    // --- typed data (this route's MySQL rows, plus route-specific joins) ----
    data: {},
    db: dbStatus(),
    dbNotice: null,

    // --- chrome ------------------------------------------------------------
    nav: navFor(run, sectionKey, acc),
    ticker: defaultTicker(run, stale),
    notices: [],
    flash: {
      ok: FLASH_OK[String(req.query.ok || '')] || null,
      error: FLASH_ERR[String(req.query.error || '')] || null,
    },
    runDateLabel: isMissing(stale.run_date) ? 'no engine run' : `Run ${stale.run_date}`,
    engineLabel: stale.ok ? stale.label : 'engine data MISSING',
  };

  if (chrome === 'minimal') {
    ctx.nav = [];
    ctx.ticker = [];
  }

  // Two things every page must say out loud rather than imply.
  if (!ctx.engine.ok) {
    ctx.notices.push({
      level: 'crit',
      title: 'The engine run could not be read.',
      body: html`Every computed figure on this page is MISSING, not zero. ${
        stale.exists ? 'latest-run.json is present but unreadable' : 'latest-run.json is not in data/'
      } — the last deploy did not carry it, or the engine did not run. Nothing typed into the hub is affected.`,
    });
  } else if (ctx.engine.stale) {
    ctx.notices.push({
      level: 'warn',
      title: `Engine data is ${String(stale.label)}.`,
      body: html`These figures describe ${String(stale.run_date)}, not today. The daily run has not landed since then; treat every computed number as of that date.`,
    });
  }
  if (!acc.ok) {
    ctx.notices.push({
      level: 'warn',
      title: 'Section locks could not be read.',
      body: 'The database is unreachable, so the hub cannot tell which sections are restricted. Restricted sections are closed to everyone but the owner until it answers.',
    });
  }
  return ctx;
}

/** Attach the outage banner after the route's loaders have run. */
function noteDbOutage(ctx) {
  if (!ctx.dbNotice) return;
  ctx.notices.push({
    level: 'crit',
    title: 'Typed records unavailable.',
    body: ctx.dbNotice,
  });
}

/**
 * A read that a page can render around.
 *
 * On failure it returns `rows:null` — deliberately not `[]`. An empty array is
 * a fact about the data ("nobody has typed anything"); an outage is a fact
 * about the system. A view that treats them the same prints "all caught up"
 * during an outage, which is the exact bug the shift logger ships today.
 */
function makeQ(ctx) {
  return async function q(sql, params = []) {
    const r = await tryQuery(sql, params);
    if (r.ok) return { ok: true, rows: r.rows, notice: null };
    if (!ctx.dbNotice) ctx.dbNotice = r.notice;
    return { ok: false, rows: null, notice: r.notice };
  };
}

// ============================================================================
// 3. SECTION ACCESS — data, not code, so locking never needs a deploy
// ============================================================================

let accessCache = { at: 0, value: null };
const ACCESS_TTL_MS = 15_000;

async function readAccess() {
  const now = Date.now();
  if (accessCache.value && now - accessCache.at < ACCESS_TTL_MS) return accessCache.value;

  const r = await tryQuery(
    'SELECT section, min_role, locked_by, locked_at, reason FROM section_access'
  );
  const value = r.ok
    ? {
        ok: true,
        error: null,
        map: new Map(r.rows.map((row) => [row.section, row])),
        lockedKeys: new Set(r.rows.filter((row) => row.min_role !== 'csr').map((row) => row.section)),
      }
    : {
        ok: false,
        error: r.error,
        notice: r.notice,
        map: new Map(),
        // Unknown lock list. Every section is treated as restricted below, so
        // marking them all locked in the rail is the honest rendering.
        lockedKeys: new Set(SECTIONS.map((s) => s.key)),
      };
  accessCache = { at: now, value };
  return value;
}

function invalidateAccess() {
  accessCache = { at: 0, value: null };
}

/**
 * Gate a section.
 *
 * A section absent from `section_access` is open — a section should be visibly
 * locked, never invisibly missing, so a CSR who cannot open Money is told it
 * is restricted rather than left thinking the hub is broken.
 *
 * When the lock list cannot be read at all, everything closes except for the
 * owner. Failing open would hand Money to a CSR on the strength of a database
 * outage; failing closed for everyone would lock out the whole team from
 * sections that read entirely from disk. The owner keeps working, everyone
 * else is told plainly why they cannot.
 */
function gate(sectionKey) {
  return wrap(async (req, res, next) => {
    const access = await readAccess();
    req.access = access;
    const role = req.user?.role || 'csr';
    const rank = ROLE_RANK[role] ?? 0;

    if (!access.ok) {
      if (rank >= ROLE_RANK.owner) return next();
      return renderLocked(req, res, sectionKey, null, access);
    }
    const rule = access.map.get(sectionKey);
    if (!rule) return next();
    if (rank >= (ROLE_RANK[rule.min_role] ?? 0)) return next();
    return renderLocked(req, res, sectionKey, rule, access);
  });
}

function renderLocked(req, res, sectionKey, rule, access) {
  const ctx = buildCtx(req, res, sectionKey, { access, headline: 'This section is restricted' });
  const label = SECTION_BY_KEY[sectionKey]?.label || sectionKey;
  const body = rule
    ? html`<div class="figure">
          <span class="cap">Restricted</span>
          <strong class="mid">${label}</strong>
          <p class="sub">
            This section is open to <b>${String(rule.min_role)}</b> and above. You are signed in as
            <b>${req.user?.name || 'nobody'}</b> (${req.user?.role || 'unknown role'}).
          </p>
        </div>
        <dl class="stats">
          <div class="stat"><dt>Locked by</dt><dd>${rule.locked_by || missing()}</dd></div>
          <div class="stat"><dt>Locked on</dt><dd>${rule.locked_at ? String(rule.locked_at).slice(0, 10) : missing()}</dd></div>
          <div class="stat"><dt>Minimum role</dt><dd>${String(rule.min_role)}</dd></div>
        </dl>
        ${rule.reason ? html`<p class="note">${rule.reason}</p>` : ''}
        <p class="note">Ezan can change this from inside the hub. Nothing is hidden from the rail — a locked section says it is locked.</p>`
    : html`<div class="figure">
          <span class="cap">Restricted — lock list unreadable</span>
          <strong class="mid">${label}</strong>
          <p class="sub">
            The database that holds the section locks is unreachable, so the hub cannot tell whether you
            are allowed in. It closes rather than guesses. This is MISSING, not "denied".
          </p>
        </div>
        <p class="note note--warn">${access?.notice || 'Database unreachable.'}</p>`;

  res.status(403).send(layout(ctx, { title: 'Restricted', kicker: label, html: body }));
}

// ============================================================================
// 4. VIEW LOADING
// ============================================================================
//
// Views are imported on first use, not at boot. Nine section modules are
// written independently; a boot-time static import means one unfinished file
// takes the whole hub down, including the eight sections that are ready. A
// module that is not there yet renders as a stated gap.

const viewCache = new Map();

async function loadView(key) {
  if (viewCache.has(key)) return viewCache.get(key);
  if (!SECTION_BY_KEY[key]) throw new Error(`No such section: ${key}`);

  let mod = null;
  try {
    mod = await import(new URL(`./views/${key}.js`, import.meta.url).href);
  } catch (err) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
    mod = null; // genuinely not written yet — distinct from written and broken
  }
  const render = typeof mod?.render === 'function' ? mod.render : typeof mod?.default === 'function' ? mod.default : null;
  const entry = { module: mod, render };
  viewCache.set(key, entry);
  return entry;
}

function notBuiltYet(key) {
  const s = SECTION_BY_KEY[key];
  return {
    title: `${s.label} is not built yet`,
    kicker: s.label,
    html: html`<div class="figure">
        <span class="cap">Section</span>
        <strong class="mid">views/${key}.js</strong>
        <p class="sub">
          The route, its data and its permissions are live; the view module has not been written. Nothing
          is broken and nothing is missing from the data — this page simply has no renderer yet.
        </p>
      </div>
      <p class="note">It answers one question: <b>${s.question}</b>.</p>`,
  };
}

/** GET one section: gate, load its material, hand it to the view. */
function page(key, loader) {
  return wrap(async (req, res) => {
    const ctx = buildCtx(req, res, key, { access: req.access });
    const q = makeQ(ctx);
    if (loader) ctx.data = (await loader(ctx, q, req)) || {};
    noteDbOutage(ctx);

    const view = await loadView(key);
    const result = view.render ? await view.render(ctx) : notBuiltYet(key);
    res.send(layout(ctx, result));
  });
}

// ============================================================================
// 5. WHAT EACH SECTION LOADS
// ============================================================================
//
// Only typed rows and route-specific joins. Not one of these queries
// recomputes a figure the engine already published.

const loaders = {
  async today(ctx, q) {
    const runDate = ctx.engine.runDate;
    const ticks = runDate
      ? await q('SELECT task_id, done, done_by, done_at FROM task_state WHERE run_date = ?', [runDate])
      : { ok: true, rows: [] };
    return {
      runDate,
      ticks,
      // {taskId: row} for the checklist, or null when the store is unreachable.
      byTask: ticks.ok ? Object.fromEntries(ticks.rows.map((r) => [r.task_id, r])) : null,
    };
  },

  async entry(ctx, q) {
    const date = isoDateParam(ctx.query.date) || todayIso();
    return {
      date,
      entries: await q('SELECT * FROM daily_entry WHERE entry_date = ? ORDER BY profile', [date]),
      gigs: await q('SELECT * FROM daily_entry_gig WHERE entry_date = ? ORDER BY profile, gig', [date]),
      recent: await q(
        'SELECT entry_date, COUNT(*) AS profiles, MAX(updated_at) AS updated ' +
          'FROM daily_entry GROUP BY entry_date ORDER BY entry_date DESC LIMIT 21'
      ),
      profiles: profilesFromEngine(),
    };
  },

  async inquiries(ctx, q) {
    return {
      report: reconcile(), // the referee — engine rows only, no MySQL
      tracked: await q(
        'SELECT * FROM reconciliation ORDER BY resolved ASC, amount DESC, first_seen ASC'
      ),
    };
  },

  async orders(ctx, q) {
    return {
      flags: await q(
        "SELECT buyer, COUNT(*) AS n, MAX(at) AS last_at FROM client_note WHERE kind = 'flag' GROUP BY buyer"
      ),
    };
  },

  async clients(ctx, q) {
    return {
      notes: await q(
        'SELECT buyer, COUNT(*) AS notes, MAX(at) AS last_note FROM client_note GROUP BY buyer'
      ),
      upsell: await q('SELECT buyer, stage, gap, owner, next_step FROM upsell'),
    };
  },

  async client(ctx, q, req) {
    const buyer = String(req.params.buyer || '').slice(0, 120);
    const key = normaliseBuyer(buyer);
    const allOrders = engineOrders();
    const allLeads = engineLeads();

    return {
      buyer,
      // The engine's own rows for this username. A grouping of published data,
      // not a second computation of anything the engine already totalled.
      orders: isMissing(allOrders) ? MISSING : allOrders.filter((r) => normaliseBuyer(r.client) === key),
      leads: isMissing(allLeads) ? MISSING : allLeads.filter((r) => normaliseBuyer(r.client) === key),
      notes: await q('SELECT * FROM client_note WHERE buyer = ? ORDER BY at DESC LIMIT 200', [buyer]),
      upsell: await q('SELECT * FROM upsell WHERE buyer = ? ORDER BY updated_at DESC', [buyer]),
      recon: await q('SELECT * FROM reconciliation WHERE buyer = ?', [buyer]),
      responses: await q(
        'SELECT id, name, category FROM response WHERE active = 1 ORDER BY category, name'
      ),
    };
  },

  async messages(ctx, q) {
    return {
      sent: await q(
        'SELECT n.id, n.buyer, n.at, n.author, n.kind, n.body, n.response_id, r.name AS response_name ' +
          'FROM client_note n LEFT JOIN response r ON r.id = n.response_id ' +
          "WHERE n.kind IN ('sent','flag') ORDER BY n.at DESC LIMIT 300"
      ),
      responses: await q(
        'SELECT id, name, body, category FROM response WHERE active = 1 ORDER BY category, name'
      ),
    };
  },

  async responses(ctx, q) {
    return {
      rows: await q('SELECT * FROM response ORDER BY active DESC, category IS NULL, category, name'),
    };
  },

  async team(ctx, q) {
    return {
      weeks: await q('SELECT * FROM team_week ORDER BY week_ending DESC, person ASC LIMIT 300'),
      people: await q('SELECT name, role, active FROM app_user ORDER BY role, name'),
      decisions: await q('SELECT * FROM decision ORDER BY decided_on DESC, id DESC LIMIT 100'),
    };
  },

  async money(ctx, q) {
    return {
      upsell: await q(
        "SELECT * FROM upsell ORDER BY FIELD(stage,'pitch','followup','research','won','lost'), updated_at DESC"
      ),
    };
  },
};

/** Profile names, taken from the engine's own flow rows — never a hand-kept
 *  second list of profiles that can drift from the data. */
function profilesFromEngine() {
  const rows = engineRun();
  const flowProfiles = new Set();
  const primary = pick(rows, 'metrics.profile');
  if (!isMissing(primary) && primary) flowProfiles.add(String(primary));
  const orders = engineOrders();
  if (!isMissing(orders)) {
    for (const r of orders) if (r?.profile) flowProfiles.add(String(r.profile));
  }
  return [...flowProfiles].sort();
}

// ============================================================================
// 6. GET ROUTES
// ============================================================================

for (const s of SECTIONS) {
  const loaderKey = s.key;
  app.get(s.href, requireAuth, gate(s.key), page(s.key, loaders[loaderKey]));
}

// One buyer. Same section, same lock, its own material.
app.get('/clients/:buyer', requireAuth, gate('clients'), (req, res, next) => {
  const buyer = String(req.params.buyer || '').trim();
  if (!buyer || !normaliseBuyer(buyer)) return res.redirect(302, '/clients?error=buyer');
  return page('clients', loaders.client)(req, res, next);
});

// ============================================================================
// 7. WRITES
// ============================================================================

/**
 * One transaction: the change and the audit row together.
 *
 * If the audit insert fails the change rolls back. That is the point — a
 * silently unattributed write is worth less than no write, because it becomes
 * a number nobody can settle an argument about six months later.
 */
async function auditedWrite(req, action, detail, fn) {
  const who = req.user?.name ? String(req.user.name).slice(0, 80) : null;
  return transaction(async (t) => {
    const value = await fn(t);
    await t.run('INSERT INTO audit (who, action, detail) VALUES (?, ?, ?)', [
      who,
      String(action).slice(0, 80),
      detail === null || detail === undefined ? null : JSON.stringify(detail).slice(0, 60_000),
    ]);
    return value;
  });
}

// ---- field readers.  A BLANK IS NULL, NEVER ZERO. --------------------------
//
// daily_entry makes every metric nullable on purpose: a blank means "not
// recorded", which is a different fact from 0, and the difference decides
// whether a rate has a denominator at all. `numOrNull('')` returning 0 would
// quietly manufacture a day of zero impressions.

const str = (v, max = 255) => {
  const s = String(v ?? '').trim();
  return s === '' ? null : s.slice(0, max);
};
const numOrNull = (v) => {
  const s = String(v ?? '').trim();
  if (s === '') return null;
  const n = Number(s.replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const intOrNull = (v) => {
  const n = numOrNull(v);
  return n === null ? null : Math.round(n);
};
const isoDateParam = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) ? String(v) : null);
const oneOf = (v, allowed) => (allowed.includes(String(v ?? '')) ? String(v) : null);
const checked = (v) => (v === 'on' || v === '1' || v === 'true' ? 1 : 0);
const todayIso = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** Post/Redirect/Get. `back` is validated so a form cannot bounce off-site,
 *  and the message is a CODE, not free text — nothing a client sends is ever
 *  rendered back into the page. */
function done(req, res, fallback, code = 'saved', kind = 'ok') {
  const to = safeNext(req.body?.back, fallback);
  const sep = to.includes('?') ? '&' : '?';
  res.redirect(303, `${to}${sep}${kind}=${encodeURIComponent(code)}`);
}

const write = (sectionKey, fallback, handler) => [
  requireAuth,
  gate(sectionKey),
  requireCsrf,
  wrap(async (req, res) => {
    const outcome = await handler(req, res);
    if (res.headersSent) return;
    if (outcome && outcome.error) return done(req, res, fallback, outcome.error, 'error');
    done(req, res, fallback, outcome?.ok || 'saved');
  }),
];

// ---- Today: the checklist --------------------------------------------------

app.post(
  '/today/task',
  ...write('today', '/', async (req) => {
    const runDate = isoDateParam(req.body.run_date);
    const taskId = str(req.body.task_id, 120);
    if (!runDate || !taskId) return { error: 'invalid' };
    const doneFlag = checked(req.body.done);

    await auditedWrite(req, 'task_tick', { run_date: runDate, task_id: taskId, done: doneFlag }, (t) =>
      t.run(
        'INSERT INTO task_state (run_date, task_id, done, done_by, done_at) VALUES (?, ?, ?, ?, ?) ' +
          'ON DUPLICATE KEY UPDATE done = VALUES(done), done_by = VALUES(done_by), done_at = VALUES(done_at)',
        [runDate, taskId, doneFlag, doneFlag ? req.user.name : null, doneFlag ? new Date() : null]
      )
    );
    return { ok: 'ticked' };
  })
);

// ---- Daily entry -----------------------------------------------------------

const ENTRY_INT = [
  'impressions',
  'clicks',
  'organic_orders',
  'directed_orders',
  'orders_completed',
  'orders_in_queue',
  'total_reviews',
  'success_score',
  'cancellations',
];
const ENTRY_DEC = [
  'organic_value',
  'directed_value',
  'completed_value',
  'msg_ratio',
  'profile_rating',
  'cancelled_value',
];

app.post(
  '/entry',
  ...write('entry', '/entry', async (req) => {
    const date = isoDateParam(req.body.entry_date);
    const profile = str(req.body.profile, 80);
    if (!date || !profile) return { error: 'invalid' };

    const cols = ['entry_date', 'profile'];
    const vals = [date, profile];
    for (const c of ENTRY_INT) {
      cols.push(c);
      vals.push(intOrNull(req.body[c]));
    }
    for (const c of ENTRY_DEC) {
      cols.push(c);
      vals.push(numOrNull(req.body[c]));
    }
    cols.push('entered_by');
    vals.push(req.user.name);

    const updates = cols
      .filter((c) => c !== 'entry_date' && c !== 'profile')
      .map((c) => `${c} = VALUES(${c})`)
      .join(', ');

    // Per-gig impressions arrive as parallel arrays from repeated inputs.
    const gigNames = [].concat(req.body.gig_name || []);
    const gigImps = [].concat(req.body.gig_impressions || []);
    const gigClicks = [].concat(req.body.gig_clicks || []);

    await auditedWrite(
      req,
      'daily_entry',
      { entry_date: date, profile, gigs: gigNames.filter(Boolean).length },
      async (t) => {
        await t.run(
          `INSERT INTO daily_entry (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) ` +
            `ON DUPLICATE KEY UPDATE ${updates}`,
          vals
        );
        for (let i = 0; i < gigNames.length; i++) {
          const gig = str(gigNames[i], 160);
          if (!gig) continue;
          await t.run(
            'INSERT INTO daily_entry_gig (entry_date, profile, gig, impressions, clicks) VALUES (?, ?, ?, ?, ?) ' +
              'ON DUPLICATE KEY UPDATE impressions = VALUES(impressions), clicks = VALUES(clicks)',
            [date, profile, gig, intOrNull(gigImps[i]), intOrNull(gigClicks[i])]
          );
        }
      }
    );
    return { ok: 'entry' };
  })
);

// ---- Inquiries: resolve a disagreement -------------------------------------
//
// The hub never edits the inquiry sheet or the order book. It records what a
// human decided about a disagreement, and who decided it.

app.post(
  '/inquiries/resolve',
  ...write('inquiries', '/inquiries', async (req) => {
    const buyer = str(req.body.buyer, 120);
    const finding = oneOf(req.body.finding, [
      'marked_lost_but_ordered',
      'marked_won_no_order',
      'order_without_inquiry',
    ]);
    if (!buyer || !finding) return { error: 'invalid' };

    const firstSeen = isoDateParam(req.body.first_seen) || todayIso();
    const amount = numOrNull(req.body.amount);
    const resolution = str(req.body.resolution, 4000);
    const resolved = checked(req.body.resolved);

    await auditedWrite(req, 'reconcile_resolve', { buyer, finding, resolved }, (t) =>
      t.run(
        'INSERT INTO reconciliation (buyer, finding, first_seen, amount, resolved, resolved_by, resolved_at, resolution) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?) ' +
          'ON DUPLICATE KEY UPDATE resolved = VALUES(resolved), resolved_by = VALUES(resolved_by), ' +
          'resolved_at = VALUES(resolved_at), resolution = VALUES(resolution), amount = VALUES(amount)',
        [
          buyer,
          finding,
          firstSeen,
          amount,
          resolved,
          resolved ? req.user.name : null,
          resolved ? new Date() : null,
          resolution,
        ]
      )
    );
    return { ok: 'resolved' };
  })
);

// ---- Clients: notes and flags ---------------------------------------------

app.post(
  '/clients/:buyer/note',
  ...write('clients', '/clients', async (req) => {
    const buyer = str(req.params.buyer, 120);
    const body = str(req.body.body, 8000);
    const kind = oneOf(req.body.kind, ['note', 'sent', 'flag']) || 'note';
    if (!buyer || !body) return { error: 'invalid' };
    const responseId = intOrNull(req.body.response_id);

    await auditedWrite(req, 'client_note', { buyer, kind, chars: body.length }, async (t) => {
      await t.run(
        'INSERT INTO client_note (buyer, author, kind, body, response_id) VALUES (?, ?, ?, ?, ?)',
        [buyer, req.user.name, kind, body, responseId]
      );
      // A logged send is the only thing that moves a reply's use count, so the
      // library's "uses" figure means "times actually sent", not "times opened".
      if (kind === 'sent' && responseId) {
        await t.run('UPDATE response SET uses = uses + 1 WHERE id = ?', [responseId]);
      }
    });
    return { ok: 'note' };
  })
);

// ---- Messages: log what a buyer was told -----------------------------------

app.post(
  '/messages',
  ...write('messages', '/messages', async (req) => {
    const buyer = str(req.body.buyer, 120);
    const body = str(req.body.body, 8000);
    if (!buyer || !body) return { error: 'buyer' };
    const responseId = intOrNull(req.body.response_id);

    await auditedWrite(req, 'message_logged', { buyer, response_id: responseId }, async (t) => {
      await t.run(
        "INSERT INTO client_note (buyer, author, kind, body, response_id) VALUES (?, ?, 'sent', ?, ?)",
        [buyer, req.user.name, body, responseId]
      );
      if (responseId) await t.run('UPDATE response SET uses = uses + 1 WHERE id = ?', [responseId]);
    });
    return { ok: 'logged' };
  })
);

// ---- Responses: the reply library ------------------------------------------

app.post(
  '/responses',
  ...write('responses', '/responses', async (req) => {
    const id = intOrNull(req.body.id);
    const name = str(req.body.name, 120);
    const body = str(req.body.body, 60_000);
    if (!name || !body) return { error: 'invalid' };
    const whenToUse = str(req.body.when_to_use, 4000);
    const category = str(req.body.category, 60);

    await auditedWrite(req, id ? 'response_update' : 'response_create', { id, name }, (t) =>
      id
        ? t.run(
            'UPDATE response SET name = ?, body = ?, when_to_use = ?, category = ? WHERE id = ?',
            [name, body, whenToUse, category, id]
          )
        : t.run(
            "INSERT INTO response (name, body, when_to_use, category, source) VALUES (?, ?, ?, ?, 'hub') " +
              'ON DUPLICATE KEY UPDATE body = VALUES(body), when_to_use = VALUES(when_to_use), category = VALUES(category)',
            [name, body, whenToUse, category]
          )
    );
    return { ok: 'response' };
  })
);

app.post(
  '/responses/toggle',
  ...write('responses', '/responses', async (req) => {
    const id = intOrNull(req.body.id);
    if (!id) return { error: 'invalid' };
    const active = checked(req.body.active);
    await auditedWrite(req, 'response_toggle', { id, active }, (t) =>
      t.run('UPDATE response SET active = ? WHERE id = ?', [active, id])
    );
    return { ok: 'response' };
  })
);

// ---- Team: the weekly review ----------------------------------------------
//
// self_score is asked before manager_score, per the team-review sheet's own
// step 1. Both are stored so the GAP is the coaching signal.

app.post(
  '/team',
  ...write('team', '/team', async (req) => {
    const week = isoDateParam(req.body.week_ending);
    const person = str(req.body.person, 80);
    if (!week || !person) return { error: 'invalid' };

    const selfScore = intOrNull(req.body.self_score);
    const managerScore = intOrNull(req.body.manager_score);
    const inRange = (v) => v === null || (v >= 1 && v <= 5);
    if (!inRange(selfScore) || !inRange(managerScore)) return { error: 'invalid' };

    await auditedWrite(
      req,
      'team_week',
      { week_ending: week, person, self: selfScore, manager: managerScore },
      (t) =>
        t.run(
          'INSERT INTO team_week (week_ending, person, self_score, manager_score, note, promise, prev_promise_done, recorded_by) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?) ' +
            'ON DUPLICATE KEY UPDATE self_score = VALUES(self_score), manager_score = VALUES(manager_score), ' +
            'note = VALUES(note), promise = VALUES(promise), prev_promise_done = VALUES(prev_promise_done), ' +
            'recorded_by = VALUES(recorded_by)',
          [
            week,
            person,
            selfScore,
            managerScore,
            str(req.body.note, 8000),
            str(req.body.promise, 2000),
            oneOf(req.body.prev_promise_done, ['yes', 'half', 'no']),
            req.user.name,
          ]
        )
    );
    return { ok: 'team' };
  })
);

app.post(
  '/team/decision',
  ...write('team', '/team', async (req) => {
    const id = intOrNull(req.body.id);
    const what = str(req.body.what, 8000);
    const decidedOn = isoDateParam(req.body.decided_on) || todayIso();
    const wasRight = oneOf(req.body.was_right, ['yes', 'no', 'partly', 'pending']) || 'pending';

    if (id) {
      await auditedWrite(req, 'decision_update', { id, was_right: wasRight }, (t) =>
        t.run('UPDATE decision SET actual = ?, was_right = ? WHERE id = ?', [
          str(req.body.actual, 8000),
          wasRight,
          id,
        ])
      );
    } else {
      if (!what) return { error: 'invalid' };
      await auditedWrite(req, 'decision_create', { decided_on: decidedOn }, (t) =>
        t.run(
          'INSERT INTO decision (decided_on, what, expected, actual, was_right, author) VALUES (?, ?, ?, ?, ?, ?)',
          [decidedOn, what, str(req.body.expected, 8000), str(req.body.actual, 8000), wasRight, req.user.name]
        )
      );
    }
    return { ok: 'decision' };
  })
);

// ---- Money: the upsell board ------------------------------------------------

app.post(
  '/money/upsell',
  ...write('money', '/money', async (req) => {
    const buyer = str(req.body.buyer, 120);
    if (!buyer) return { error: 'buyer' };
    const gap = str(req.body.gap, 120) || '';
    const stage = oneOf(req.body.stage, ['research', 'pitch', 'followup', 'won', 'lost']) || 'research';

    await auditedWrite(req, 'upsell_save', { buyer, gap, stage }, (t) =>
      t.run(
        'INSERT INTO upsell (buyer, business, gap, sell_first, stage, asked, result, extra_earned, owner, next_step) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
          'ON DUPLICATE KEY UPDATE business = VALUES(business), sell_first = VALUES(sell_first), ' +
          'stage = VALUES(stage), asked = VALUES(asked), result = VALUES(result), ' +
          'extra_earned = VALUES(extra_earned), owner = VALUES(owner), next_step = VALUES(next_step)',
        [
          buyer,
          str(req.body.business, 160),
          gap,
          str(req.body.sell_first, 120),
          stage,
          checked(req.body.asked),
          str(req.body.result, 160),
          numOrNull(req.body.extra_earned),
          str(req.body.owner, 80) || req.user.name,
          str(req.body.next_step, 4000),
        ]
      )
    );
    return { ok: 'upsell' };
  })
);

// ---- Section locks (owner only) --------------------------------------------

app.post(
  '/access',
  requireAuth,
  requireCsrf,
  wrap(async (req, res) => {
    if (req.user.role !== 'owner') {
      res.status(403);
      throw new Error('Only the owner can change section access.');
    }
    const section = oneOf(req.body.section, SECTIONS.map((s) => s.key));
    const minRole = oneOf(req.body.min_role, ['csr', 'manager', 'owner']);
    if (!section || !minRole) return done(req, res, '/team', 'invalid', 'error');

    await auditedWrite(req, 'section_lock', { section, min_role: minRole }, (t) =>
      minRole === 'csr'
        ? t.run('DELETE FROM section_access WHERE section = ?', [section])
        : t.run(
            'INSERT INTO section_access (section, min_role, locked_by, locked_at, reason) VALUES (?, ?, ?, ?, ?) ' +
              'ON DUPLICATE KEY UPDATE min_role = VALUES(min_role), locked_by = VALUES(locked_by), ' +
              'locked_at = VALUES(locked_at), reason = VALUES(reason)',
            [section, minRole, req.user.name, new Date(), str(req.body.reason, 200)]
          )
    );
    invalidateAccess();
    done(req, res, '/team', 'access');
  })
);

// ============================================================================
// 8. LOGIN / LOGOUT
// ============================================================================
//
// APP_PASSWORD proves you are the team. The name says which of the team you
// are. The name picker is a SIGNATURE on every write, not a security boundary,
// and lib/auth.js says so in as many words — do not let a later reader mistake
// it for one.

function loginPage(req, res, { error = null } = {}) {
  const ctx = buildCtx(req, res, null, { headline: 'Sign in', chrome: 'minimal' });
  const cfg = authConfig();
  const nextTo = safeNext(req.query.next, '/');

  const body = html`<div class="lede">
      <div class="lede-main">
        <form method="post" action="/login" class="stack">
          <input type="hidden" name="next" value="${nextTo}">
          <div class="field">
            <label for="password">Team password <span class="req">*</span></label>
            <input id="password" name="password" type="password" autocomplete="current-password" autofocus required>
            <p class="field-error">${error || ''}</p>
            <p class="field-hint">Asked once on this device. After that it remembers you.</p>
          </div>
          <div class="form-actions">
            <button class="btn" type="submit">Sign in</button>
          </div>
        </form>
      </div>
      <div class="lede-side">
        <p class="caption">This page carries client names, revenue and the dead pipeline. It is not indexed and it is not public.</p>
        ${!cfg.ok
          ? html`<p class="note note--neg">Login is not configured on this server — ${cfg.missing.join(' and ')} not set. Nobody can sign in until they are.</p>`
          : ''}
        ${cfg.warning ? html`<p class="note note--warn">${cfg.warning}</p>` : ''}
      </div>
    </div>`;

  return layout(ctx, { title: 'Sign in', kicker: 'XStudioz hub', html: body });
}

// Step two, on a new device only: who is holding it. Asked once, then never
// again — but not optional, because an unsigned tick is a tick nobody can be
// asked about, and that is the failure this whole hub was built to fix.
function claimPage(req, res, { error = null, users = null, usersError = null } = {}) {
  const ctx = buildCtx(req, res, null, { headline: 'Who is on this device?', chrome: 'minimal' });
  const nextTo = safeNext(req.query.next, '/');

  const picker =
    users && users.length
      ? html`<select id="name" name="name" required autofocus>
          <option value="">Choose your name…</option>
          ${join(users.map((u) => html`<option value="${u.name}">${u.name} · ${u.role}</option>`))}
        </select>`
      : html`<input id="name" name="name" autocomplete="username" required autofocus>`;

  const body = html`<div class="lede">
      <div class="lede-main">
        <form method="post" action="/claim" class="stack">
          <input type="hidden" name="next" value="${nextTo}">
          <div class="field">
            <label for="name">Your name <span class="req">*</span></label>
            ${picker}
            <p class="field-error">${error || ''}</p>
            <p class="field-hint">
              Asked once for this browser. Your name signs every tick, note and score you write —
              it is attribution, not a second password.
            </p>
          </div>
          <div class="form-actions">
            <button class="btn" type="submit">Remember this device</button>
          </div>
        </form>
      </div>
      <div class="lede-side">
        <p class="caption">Sign out at any time to hand this device to someone else — that is the one thing that makes it ask again.</p>
        ${usersError ? html`<p class="note note--warn">${usersError}</p>` : ''}
      </div>
    </div>`;

  return layout(ctx, { title: 'Who is on this device?', kicker: 'XStudioz hub', html: body });
}

async function usersOrNotice() {
  try {
    return { users: await listUsers(), usersError: null };
  } catch (err) {
    if (!(err instanceof DbError)) throw err;
    // An empty dropdown reads as "nobody works here". Say what happened.
    return { users: null, usersError: `${unavailableNotice(err)} You can still type your name.` };
  }
}

app.get(
  '/login',
  wrap(async (req, res) => {
    // attachUser has already resumed the session from a remembered device, so
    // reaching this page at all means this browser is genuinely new.
    if (req.user) return res.redirect(302, safeNext(req.query.next, '/'));
    res.send(loginPage(req, res, {}));
  })
);

app.get(
  '/claim',
  wrap(async (req, res) => {
    if (req.user) return res.redirect(302, safeNext(req.query.next, '/'));
    res.send(claimPage(req, res, await usersOrNotice()));
  })
);

app.post(
  '/claim',
  wrap(async (req, res) => {
    const result = await claimDevice({ req, res, name: String(req.body.name || '').slice(0, 80) });
    if (result.ok) return res.redirect(303, safeNext(req.body.next, '/'));
    const { users, usersError } = await usersOrNotice();
    // Expired proof means the password must be typed again — do not leave them
    // on a form that cannot succeed.
    if (result.reason === 'expired') {
      return res.status(401).send(loginPage(req, res, { error: result.message }));
    }
    res.status(result.reason === 'db_unavailable' ? 503 : 401)
      .send(claimPage(req, res, { error: result.message, users, usersError }));
  })
);

app.post(
  '/login',
  loginLimiter,
  wrap(async (req, res) => {
    const result = await attemptLogin({ req, res, password: req.body.password });

    // Password accepted on a device nobody has claimed yet — one more step.
    if (result.ok && result.needsName) {
      const to = encodeURIComponent(safeNext(req.body.next, '/'));
      return res.redirect(303, `/claim?next=${to}`);
    }
    if (result.ok) return res.redirect(303, safeNext(req.body.next, '/'));

    // 4xx so the limiter counts the attempt — it skips successful requests.
    res
      .status(result.reason === 'not_configured' ? 503 : 401)
      .send(loginPage(req, res, { error: result.message }));
  })
);

app.post(
  '/logout',
  requireCsrf,
  wrap(async (req, res) => {
    await endLogin({ req, res });
    res.redirect(303, '/login');
  })
);

// A GET must not log anyone out — an <img src="/logout"> anywhere would do it.
app.get('/logout', (req, res) => {
  const ctx = buildCtx(req, res, null, { headline: 'Sign out', chrome: 'minimal' });
  res.send(
    layout(ctx, {
      title: 'Sign out',
      kicker: 'Session',
      html: html`<form method="post" action="/logout">
          <input type="hidden" name="_csrf" value="${ctx.csrfToken}">
          <p class="deck">Sign out of the hub on this device?</p>
          <div class="btnrow"><button class="btn" type="submit">Sign out</button>
          <a class="btn btn--ghost" href="/">Stay signed in</a></div>
        </form>`,
    })
  );
});

// ============================================================================
// 9. HEALTH
// ============================================================================
//
// Two independent facts, never merged into one boolean:
//   the engine data on disk  — without it there is nothing to render
//   MySQL                    — without it the hub degrades but still works
//
// So an unreachable database is `degraded` and still 200: the deploy is fine
// and the pages that read from disk are correct. A missing run file is `down`
// and 503, because every computed figure is then MISSING.

app.get(
  '/healthz',
  wrap(async (req, res) => {
    const data = dataStatus();
    const runSource = data.sources.find((s) => s.name === 'run');
    const engineReadable = runSource?.readable === true;
    const probe = dbConfigured() ? await ping() : { ok: false, error: null };
    const detailed = Boolean(req.user) || !PRODUCTION;

    const body = {
      ok: engineReadable && probe.ok,
      status: !engineReadable ? 'down' : probe.ok ? 'ok' : 'degraded',
      now: new Date().toISOString(),
      uptime_s: Math.round(process.uptime()),
      db: {
        configured: dbConfigured(),
        reachable: probe.ok,
        missing_env: missingEnv(),
        error_code: probe.error?.code ?? null,
        // Host and database name are withheld from an unauthenticated caller.
        ...(detailed ? { target: dbTarget() } : {}),
      },
      auth: { configured: authConfigured(), missing: authConfig().missing },
      engine: {
        readable: engineReadable,
        run_date: data.staleness.run_date,
        age_days: data.staleness.age_days,
        fresh: data.staleness.fresh,
        stale_after_days: data.staleness.stale_after_days,
        parse_errors: data.parse_errors,
        missing_sources: data.missing,
        sources: data.sources.map((s) => ({
          name: s.name,
          file: s.file,
          readable: s.readable,
          rows: s.rows,
          parse_errors: s.parse_errors,
        })),
        ...(detailed ? { dir: data.dir } : {}),
      },
    };

    res.setHeader('Cache-Control', 'no-store');
    res.status(engineReadable ? 200 : 503).json(body);
  })
);

// ============================================================================
// 10. NOT FOUND, AND THINGS THAT BROKE
// ============================================================================

app.use((req, res) => {
  const ctx = buildCtx(req, res, null, { headline: 'No such page', chrome: req.user ? null : 'minimal' });
  res.status(404).send(
    errorPage(ctx, {
      status: 404,
      heading: 'No such page',
      what: html`Nothing is served at <b>${req.path}</b>. If you followed a link from inside the hub, that link is wrong and worth reporting.`,
    })
  );
});

/**
 * The last stop. It says what broke and never shows a stack — a stack trace in
 * a browser is a map of the server for anyone who can reach the login page,
 * and it tells the person who hit the error nothing they can act on.
 */
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = res.statusCode >= 400 && res.statusCode < 600 ? res.statusCode : 500;
  const ref = crypto.randomBytes(4).toString('hex');

  console.error(`[error] ref=${ref} ${req.method} ${req.originalUrl} status=${status}`);
  console.error(err?.stack || err);

  let heading = 'Something broke on the server';
  let what = html`The page could not be built. Nothing was saved and no existing record was changed.`;
  let reason = null;

  if (err instanceof DbError) {
    heading = err.unavailable ? 'The typed-records database is unreachable' : 'A database query failed';
    what = err.unavailable
      ? html`Everything typed into the hub — ticks, entries, notes, scores — could not be read or written. The engine's figures are unaffected and every page that reads from <code class="mono">data/</code> still works.`
      : html`The query behind this page was rejected. That is a bug in the hub, not an outage, and it needs a developer.`;
    reason = unavailableNotice(err);
  } else if (status === 403) {
    heading = 'That form was not accepted';
    what = html`${err?.message || 'This form expired or came from somewhere else. Reload the page and try again.'}`;
  } else if (status === 404) {
    heading = 'No such page';
    what = html`Nothing is served at <b>${req.path}</b>.`;
  }

  try {
    const ctx = buildCtx(req, res, null, {
      headline: heading,
      chrome: req.user ? null : 'minimal',
    });
    res.status(status).send(
      errorPage(ctx, {
        status,
        heading,
        what,
        why: reason,
        next: html`<span class="caption">Reference <code class="mono">${ref}</code> — quote it if you report this.</span>`,
      })
    );
  } catch (renderErr) {
    // The shell itself failed. Plain text, still no stack.
    console.error(`[error] ref=${ref} the error page also failed to render`);
    console.error(renderErr?.stack || renderErr);
    res
      .status(status)
      .type('text/plain')
      .send(`Something broke on the server and the error page could not be built.\nReference ${ref}.`);
  }
});

// ============================================================================
// 11. START
// ============================================================================

const PORT = Number(process.env.PORT || 3000);

/**
 * Bring the schema up to date on boot.
 *
 * This runs here rather than as a deploy step because the target is Hostinger
 * shared hosting: there is no shell, and the only thing that ever executes is
 * `npm start`. A migration nobody can run is a migration that never runs, and
 * the first symptom would be every typed record failing against tables that
 * were never created.
 *
 * Safe to repeat: schema.sql is CREATE TABLE IF NOT EXISTS throughout and the
 * seed inserts only names it does not already find.
 *
 * A failure here must NOT stop the server. The engine-data pages — Today,
 * Orders, Inquiries, Money — read from disk and are still completely valid
 * without a database. Refusing to boot would take away the pages that work in
 * order to punish the ones that do not.
 */
async function prepareDatabase() {
  if (!dbConfigured()) return;
  const hush = () => {};
  try {
    const { migrate } = await import('./db/migrate.js');
    const { created, drift } = await migrate({ log: hush });
    console.log(
      created.length
        ? `[boot] schema: created ${created.length} table(s) — ${created.join(', ')}`
        : '[boot] schema: up to date'
    );
    // Drift means a table exists but is missing a column this build expects.
    // CREATE TABLE IF NOT EXISTS cannot fix that, so it must be said out loud
    // rather than discovered later as a column-not-found on someone's save.
    if (drift.length) {
      console.warn(`[boot] schema DRIFT — ${drift.length} table(s) missing expected columns:`);
      for (const d of drift) console.warn(`[boot]   ${d.table}: ${(d.missing || []).join(', ')}`);
    }
  } catch (err) {
    console.error(`[boot] schema migration FAILED — ${err.message}`);
    console.error('[boot] typed records will not work until this is fixed. Engine pages are unaffected.');
    return;
  }
  try {
    const { seed } = await import('./db/seed.js');
    const { users } = await seed({ log: hush });
    if (users?.inserted?.length) {
      console.log(`[boot] seed: added ${users.inserted.length} user(s) — ${users.inserted.join(', ')}`);
    }
  } catch (err) {
    console.error(`[boot] seed failed — ${err.message}`);
  }
}

if (process.env.NODE_ENV !== 'test') {
  const cfg = authConfig();
  if (!cfg.ok) {
    console.warn(`[boot] ${cfg.missing.join(' and ')} not set — nobody can sign in until they are.`);
  }
  if (cfg.warning) console.warn(`[boot] ${cfg.warning}`);
  if (!dbConfigured()) {
    console.warn(
      `[boot] database not configured (missing ${missingEnv().join(', ')}) — typed records are unavailable; ` +
        'the engine-data pages still work.'
    );
  }
  const st = staleness();
  console.log(
    `[boot] engine data: ${st.ok ? `run ${st.run_date}, ${st.label}` : 'MISSING — latest-run.json not readable'}`
  );

  // Listen FIRST, migrate after.
  //
  // These were the other way round and it took the site down with a 503. The
  // schema work opens a MySQL connection, and an unreachable or slow database
  // makes that await hang for its full connect timeout — during which the
  // process is alive but nothing is bound to the port, so the proxy in front
  // has nobody to talk to and returns 503.
  //
  // That inverted the whole design. Today, Orders and Inquiries read from
  // disk and owe the database nothing; letting a database they never touch
  // decide whether they are reachable is precisely the coupling this app was
  // built to avoid. Bind the port, then prepare the schema in the background,
  // and let the DB-backed pages report their own unavailability the way they
  // already know how.
  app.listen(PORT, () => {
    console.log(`[boot] xstudioz hub listening on :${PORT} (${PRODUCTION ? 'production' : 'development'})`);
  });

  prepareDatabase().catch((err) => {
    console.error(`[boot] database preparation errored — ${err.message}`);
  });
}

export default app;
