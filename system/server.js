// server.js, the Express application.
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
//   the disk-based half. `q()` returns rows:null on failure, never [], so a
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
import compression from 'compression';

import {
  tryQuery,
  transaction,
  query,
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
  passwordShape,
  authConfigured,
  safeNext,
  shareDevice,
  switchPerson,
  SHIFT_TTL_MS,
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
import { deskNow, shiftBand } from './lib/roster.js';
import { loadDueDates, setDueDate, clearDueDate } from './lib/duedates.js';

// The six owner-written documents. Read from data/handbook/, parsed out of
// plain text, and never written to. Nothing here touches the database.
import {
  documents as handbookDocuments,
  document as handbookDocument,
  search as handbookSearch,
} from './lib/handbook.js';

// The thirteen reminder logics, as code. server.js does not decide when a
// follow-up is owed, it asks this module and writes down the answer inside
// the same transaction as the entry that caused it.
import {
  RULES as REMINDER_RULES,
  ACTIVITY_KIND_KEYS,
  ORDER_TYPES,
  ORDER_ROUTES,
  FOLLOWUP_ATTEMPTS,
  SNOOZE_MINUTES,
  AUTO_CLEARED,
  ReminderError,
  rulesFor,
  autoClears,
  resolve as resolveReminder,
  canHoldReviewAsk,
  buttonsFor,
  buyerKey,
  parseRemindIn,
  parseAt,
  toSqlUtc,
  ratingAverage,
} from './lib/reminders.js';

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

// The stores the team actually works in. Nothing here writes; see the header
// of lib/external.js for which system owns which number.
import {
  ceoWindow,
  reachDays,
  reachAsOf,
  boardGigs,
  PROFILE as EXTERNAL_PROFILE,
} from './lib/external.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRODUCTION = process.env.NODE_ENV === 'production';

export const app = express();

// ============================================================================
// 1. PLATFORM
// ============================================================================

// One hop, not `true`. With `true` any client can spoof X-Forwarded-For, every
// login attempt looks like a different address, and the rate limiter is off
// with nothing on screen to say so.
// Compress before anything writes a body.
//
// Measured without it: / was 56 KB, /clients 53 KB, /money 57 KB and
// /inquiries 340 KB, all sent uncompressed even when the browser asked for
// gzip. Server render time was 12-71ms, so none of the slowness was compute;
// it was payload, over a phone connection. Server-rendered HTML is extremely
// repetitive markup and compresses about 8:1, so this is the single biggest
// thing available and it costs one line.
//
// It must be mounted BEFORE express.static and before the routes, because
// compression works by wrapping res.write/res.end, middleware registered
// after a response has already been written cannot compress it.
app.use(compression({
  threshold: 1024,          // below this the gzip header costs more than it saves
  // Honour an explicit opt-out. Nothing does this today, but a future
  // streaming or server-sent-events route would need it and would otherwise
  // buffer invisibly.
  filter: (req, res) => (res.getHeader('x-no-compression') ? false : compression.filter(req, res)),
}));

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.set('etag', 'strong');

// A nonce per response, minted before helmet reads the CSP directives.
//
// HEX, not base64, and that is not cosmetic. layout() runs the retired-name
// scrub over the finished document; a base64 nonce can contain the substring
// it rewrites (roughly one response in a million), and the rewrite would edit
// the nonce in the HTML while the CSP header kept the original, the shell's
// scripts would be blocked, giving a white flash to a dark-mode user and a
// dead theme toggle, intermittently and unreproducibly. Hex cannot contain it.
app.use((req, res, next) => {
  res.locals.nonce = crypto.randomBytes(16).toString('hex');
  next();
});

app.use(
  helmet({
    // useDefaults:false, the policy below is the whole policy. A default that
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
        // (style="--lo:15.7%"), that is data, computed per row, and it cannot
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
// 2. REQUEST CONTEXT, the shape every view receives
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
  talk: 'Talk playbook card saved. It is live on every buyer from now.',
  talk_on: 'Card switched back on. It is offered again.',
  talk_off: 'Card switched off. It is kept, and nobody is offered it.',
  team: 'Weekly review saved.',
  decision: 'Decision recorded.',
  upsell: 'Upsell row updated.',
  access: 'Section access updated.',
  in_fiverr: 'Marked as saved in Fiverr. The team will see that badge everywhere this reply appears.',
  hub_only: 'Marked as living only in this hub. Paste it rather than looking for it in Fiverr.',
  due_set: 'Promised date recorded. The order sheet was not touched.',
  due_cleared: 'Promised date removed. That order now reads as no promise recorded, which is not the same as on time.',

  // Reports. Each names what was written, because "Saved." over a form that
  // books follow-ups does not say whether any were booked.
  shift_open: 'Your shift is open. Anything you log now belongs to this profile.',
  logged_activity: 'Entry saved, and every reminder it books was booked with it.',
  removed_activity: 'Entry removed, along with the reminders nobody had answered yet.',
  reminder_done: 'Reminder closed.',
  reminder_held: 'Closed without asking. No review request was sent, the order is late or disputed.',
  reminder_already: 'Somebody else had already closed that one. Nothing changed.',
  reminder_undone: 'Put back. If that tap had advanced a chain, the stage it booked went with it.',
  handoff_read: 'Marked read. The shift that wrote it can see it landed.',
  shift_saved: 'Handover note saved. Your shift is still open.',
  shift_closed: 'Shift closed. Its reminders stay on the profile for whoever is next.',
};

const FLASH_ERR = {
  invalid: 'Some fields were not accepted. Nothing was written.',
  buyer: 'That buyer username was empty or not recognised.',
  date: 'A promised date has to be a real date. Nothing was written.',
  notfound: 'That record no longer exists.',
  forbidden: 'Only Ezan can change the talk playbook. Nothing was written.',
  talk:
    'A card needs a heading, a group, a title and at least one full exchange: what the buyer says AND ' +
    'the line that goes back. Nothing was written.',
  db: 'The typed-records database could not be written to. Nothing was saved.',
  noshift: 'You have no shift open, so there is nothing to log against. Nothing was written.',
  reminder:
    'That entry would have booked a reminder the rules could not build, most often a custom reminder ' +
    'with no date and time on it. The entry was NOT saved, because an entry that books nothing is the ' +
    'failure this section exists to prevent.',
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
 *  MISSING as MISSING, none of them can print a zero it did not compute. */
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
    // The layout renders the masthead differently on a shared desk: whose
    // shift it is, and a switch, because on a shared laptop "who am I" is the
    // part that changes seven times a day.
    device: req.device || null,
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
    // Who holds the desk, from the roster. Computed per request rather than
    // cached: the answer changes on the hour and a stale one is worse than
    // none, because it names somebody who has gone home.
    desk: deskNow(),
  };

  if (chrome === 'minimal') {
    ctx.nav = [];
    ctx.ticker = [];
    ctx.desk = null;
  }

  // Two things every page must say out loud rather than imply.
  if (!ctx.engine.ok) {
    ctx.notices.push({
      level: 'crit',
      title: 'The engine run could not be read.',
      body: html`Every computed figure on this page is MISSING, not zero. ${
        stale.exists ? 'latest-run.json is present but unreadable' : 'latest-run.json is not in data/'
      }, the last deploy did not carry it, or the engine did not run. Nothing typed into the hub is affected.`,
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
 * On failure it returns `rows:null`, deliberately not `[]`. An empty array is
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
// 3. SECTION ACCESS, data, not code, so locking never needs a deploy
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
 * A section absent from `section_access` is open, a section should be visibly
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

/**
 * A floor in code, on top of whatever `section_access` says.
 *
 * `gate()` alone cannot express "this page inside an open section is manager
 * only", because a section with no row is open and a row is a thing a person
 * has to remember to insert. This raises the bar and never lowers it: if the
 * section is already locked higher, the higher one still applies.
 *
 * It renders the same locked page as `gate()` so a person who cannot open it
 * is told the same way, by the same page, with the same reason.
 */
function atLeast(minRole, sectionKey) {
  return (req, res, next) => {
    const rank = ROLE_RANK[req.user?.role || 'csr'] ?? 0;
    if (rank >= (ROLE_RANK[minRole] ?? 0)) return next();
    return renderLocked(req, res, sectionKey, {
      min_role: minRole,
      locked_by: 'the hub itself',
      locked_at: null,
      reason:
        'This page reports on named people, how many entries each logged and how much they left open. ' +
        'It is restricted in code rather than by a setting, so there is no row anybody can forget to add.',
    }, req.access);
  };
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
        <p class="note">Ezan can change this from inside the hub. Nothing is hidden from the rail, a locked section says it is locked.</p>`
    : html`<div class="figure">
          <span class="cap">Restricted, lock list unreadable</span>
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

async function loadView(key, sectionKey = key) {
  if (viewCache.has(key)) return viewCache.get(key);
  if (!SECTION_BY_KEY[sectionKey]) throw new Error(`No such section: ${sectionKey}`);

  let mod = null;
  try {
    mod = await import(new URL(`./views/${key}.js`, import.meta.url).href);
  } catch (err) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
    mod = null; // genuinely not written yet, distinct from written and broken
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
          is broken and nothing is missing from the data, this page simply has no renderer yet.
        </p>
      </div>
      <p class="note">It answers one question: <b>${s.question}</b>.</p>`,
  };
}

/**
 * GET one section: gate, load its material, hand it to the view.
 *
 * `view` names a module other than the section's own. Reports has two halves
 * that share one rail entry, one lock and one set of tables, and they are two
 * files because "log my shift" and "read what the shifts produced" are two
 * pages, not two modes of one. The section key still decides the chrome, so
 * both halves highlight Reports in the rail and answer its question.
 */
function page(key, loader, { view = key } = {}) {
  return wrap(async (req, res) => {
    const ctx = buildCtx(req, res, key, { access: req.access });
    const q = makeQ(ctx);
    if (loader) ctx.data = (await loader(ctx, q, req)) || {};
    noteDbOutage(ctx);

    const mod = await loadView(view, key);
    const result = mod.render ? await mod.render(ctx) : notBuiltYet(key);
    res.send(layout(ctx, result));
  });
}

// ============================================================================
// 5. WHAT EACH SECTION LOADS
// ============================================================================
//
// Only typed rows and route-specific joins. Not one of these queries
// recomputes a figure the engine already published.
//
// EXPORTED so tests/wiring.test.js can run each one against a stub `q` and
// check it supplies every `ctx.data` key its view actually reads. That is not
// a hypothetical: this table and views/ are written separately, and three of
// them had already drifted apart. Messages was handed `sent` while its view
// read `buyer`, `directory`, `orders` and `leads`, so the per-buyer half of
// the section could not be reached at all, and the picker was the only thing
// anyone had ever seen. Nothing about that renders as an error. The page is
// 200, the shell is correct, and the missing half simply never appears.

export const loaders = {
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

  // ---- Reach: what Fiverr showed, from the impressions board ---------------
  //
  // This was the daily form's loader, five SELECTs against `daily_entry` and
  // `daily_entry_gig`. Both tables are still there and neither is ever getting
  // another row: the team types these fourteen numbers into the impressions
  // board every day and has done for longer than this hub has existed.
  //
  // The window is deep enough for the longest control on the page and no
  // deeper, and it is measured back from the board's OWN last day rather than
  // from today, because the board runs behind and a window measured from today
  // can miss every day it holds. `reachAsOf` is fetched separately and first:
  // it is the one figure the view refuses to render without.
  async entry(ctx, q, req) {
    const asOf = await reachAsOf();
    const end = asOf.date || pktToday(new Date());
    const from = shiftIsoDay(end, -120);
    const [days, gigs] = await Promise.all([reachDays({ from, to: end }), boardGigs()]);
    return {
      window: REACH_WINDOWS.has(String(req?.query?.window)) ? String(req.query.window) : '30',
      asOf,
      days,
      gigs,
      notice: days.ok ? null : days.notice,
    };
  },

  async inquiries(ctx, q) {
    return {
      report: reconcile(), // the referee, engine rows only, no MySQL
      tracked: await q(
        'SELECT * FROM reconciliation ORDER BY resolved ASC, amount DESC, first_seen ASC'
      ),
    };
  },

  // ---- Pulse: the delivered work, and what buyers said about it -----------
  //
  // No database at all. This is a cut of the order book the engine already
  // ingests, so the section keeps working through an outage that takes out
  // everything typed, and it cannot disagree with /orders or /money about a
  // figure because all three read the same file.
  async pulse(ctx, q, req) {
    return {
      window: PULSE_WINDOWS.has(String(req?.query?.window)) ? String(req.query.window) : '30',
      today: pktToday(new Date()),
      book: engineOrders(),
    };
  },

  async orders(ctx, q) {
    return {
      flags: await q(
        "SELECT buyer, COUNT(*) AS n, MAX(at) AS last_at FROM client_note WHERE kind = 'flag' GROUP BY buyer"
      ),
      // The promised dates. `loadDueDates` returns null rather than throwing
      // when the table cannot be read, and the view keeps that distinction:
      // "nobody promised anything" and "we could not look" render differently.
      due: await loadDueDates(),
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
    };
  },

  // No buyer chosen: the picker. `directory` is one row per buyer that has ever
  // been written to here, counts only, because the picker never shows a
  // message body and pulling 300 of them to render a list of names is waste.
  // It is merged in the view with the engine's open orders and cold quotes, so
  // the picker still names every buyer who needs one during a database outage.
  async messages(ctx, q) {
    return {
      buyer: '',
      buyerKey: '',
      directory: await q(
        'SELECT buyer, COUNT(*) AS notes, ' +
          "SUM(kind = 'sent') AS sent, SUM(kind = 'flag') AS flags, " +
          'MAX(at) AS last_at FROM client_note GROUP BY buyer'
      ),
      // Counts only. The picker never prints a line from the playbook, because
      // no line can be chosen before a buyer is, and pulling thirty cards to
      // render a list of usernames is waste.
      talk: await q(
        'SELECT `group`, MIN(heading) AS heading, COUNT(*) AS cards ' +
          'FROM talk WHERE active = 1 GROUP BY `group` ORDER BY MIN(sort)'
      ),
    };
  },

  // One buyer. Same section, same lock, its own material. `notes` carries the
  // reply's name through the join so the history can say which template was
  // sent; `orders` and `leads` are this buyer's rows out of the engine's own
  // files, a filter of published data, never a second computation of it.
  //
  // `talk` is the owner's Client Talk Hub, the whole of it. INACTIVE CARDS ARE
  // SELECTED TOO, and that is deliberate: the owner edits this page, and a card
  // he switched off has to be visible to him to be switched back on. The view
  // shows a deactivated card to the owner and to nobody else.
  async message(ctx, q, req) {
    const buyer = String(req.params.buyer || '').slice(0, 120);
    const key = normaliseBuyer(buyer);
    const allOrders = engineOrders();
    const allLeads = engineLeads();

    return {
      buyer,
      buyerKey: key,
      orders: isMissing(allOrders) ? MISSING : allOrders.filter((r) => normaliseBuyer(r.client) === key),
      leads: isMissing(allLeads) ? MISSING : allLeads.filter((r) => normaliseBuyer(r.client) === key),
      notes: await q(
        'SELECT n.id, n.buyer, n.at, n.author, n.kind, n.body, n.response_id, r.name AS response_name ' +
          'FROM client_note n LEFT JOIN response r ON r.id = n.response_id ' +
          'WHERE n.buyer = ? ORDER BY n.at DESC LIMIT 300',
        [buyer]
      ),
      talk: await q(
        'SELECT id, slug, heading, `group`, kind, stage, chips, title, sub, turns, ' +
          'active, sort, source, author, updated_at FROM talk ' +
          'ORDER BY sort, id'
      ),
      // The review gate reads these: an order past a date we promised refuses
      // a review ask whatever its age. null when unreadable, which the gate
      // treats as unknown rather than as "not late".
      due: await loadDueDates(),
    };
  },

  async team(ctx, q) {
    return {
      weeks: await q('SELECT * FROM team_week ORDER BY week_ending DESC, person ASC LIMIT 300'),
      people: await q('SELECT name, role, active FROM app_user ORDER BY role, name'),
      decisions: await q('SELECT * FROM decision ORDER BY decided_on DESC, id DESC LIMIT 100'),
      // The lock list itself, so the owner-only access panel can print the
      // minimum role and who set it rather than inferring "above csr" from the
      // rail. `readAccess()` already has this, but it is cached for 15s and
      // carries no reason text, the panel states a stored fact, so it reads it.
      access: await q(
        'SELECT section, min_role, locked_by, locked_at, reason FROM section_access ORDER BY section'
      ),
    };
  },

  async money(ctx, q) {
    return {
      upsell: await q(
        "SELECT * FROM upsell ORDER BY FIELD(stage,'pitch','followup','research','won','lost'), updated_at DESC"
      ),
    };
  },


  // ---- Reports: the owner half ---------------------------------------------
  //
  // A window of days, not a live feed. The view buckets everything into
  // Pakistan calendar days itself, see its header for why that cannot be done
  // in SQL, so this loader's only job is to hand it the right rows and the
  // window they belong to.
  //
  // IT READS THE SHIFT LOGGER NOW, NOT THIS HUB'S OWN TABLES.
  //
  // This used to be four SELECTs against `shift_report` / `activity` /
  // `reminder`. Those tables are still there and still correct, and they are
  // also never going to have another row written to them: the hub stopped
  // being a thing CSRs log into, and the team files its shifts in the CSR
  // Shift Logger. Left pointing at MySQL this page would have kept rendering
  // perfectly — panels, headings, filters, an empty state per section — while
  // reporting that eighty-nine shifts of work did not happen.
  //
  // That is the failure this codebase keeps having to design against: not an
  // error, a calm and plausible zero. So the source moved and the provenance
  // stamp in the view moved with it, because a figure whose origin is wrong on
  // screen is worse than one that is missing.
  //
  // The profile filter is gone with it. The logger holds ten profiles and this
  // hub is about one, so the scope is not the owner's to choose here; it is
  // fixed at X Studioz in `lib/external.js` and `profiles: []` collapses the
  // chip row rather than offering nine filters that would all come back empty.
  async reportsCeo(ctx, q, req) {
    const now = new Date();
    const today = pktToday(now);
    const date = isoDateParam(req?.query?.date) || today;
    const days = REPORT_WINDOWS.has(String(req?.query?.days)) ? Number(req.query.days) : 1;
    const from = shiftIsoDay(date, -(days - 1));

    // Which stages carry a standing caution is a property of the rule, and the
    // logger has no such column. Derived here from the one rule table rather
    // than restated in the adapter, so a rule that gains or loses its caution
    // changes in one place.
    const alertKeys = new Set(
      Object.entries(REMINDER_RULES)
        .filter(([, def]) => def && def.alert)
        .map(([key]) => key)
    );

    const { shifts, activities, reminders, standing } = await ceoWindow({
      from,
      to: date,
      alertKeys,
    });

    return {
      date,
      from,
      days,
      profile: EXTERNAL_PROFILE,
      profiles: [],
      now,
      shifts,
      activities,
      reminders,
      standing,
    };
  },

  // ---- Handbook: the six documents, from disk -------------------------------
  //
  // No database at all. These are files committed to the repository, so this
  // section keeps working through an outage that takes out everything typed.
  // `documents()` never throws and never returns null: a file that will not
  // parse comes back with `ok:false` and its full text, a file that is not
  // there comes back with `present:false` and a reason, and the view renders
  // both rather than showing a document that looks empty.
  //
  // The search runs over the whole set on purpose, including when a document
  // is open. "Which of the six is this in" is the question the reader cannot
  // answer, and removing it is what this section is for.
  async handbook(ctx, q, req) {
    const docs = handbookDocuments();
    const wanted = str(req?.params?.doc, 40);
    const doc = wanted ? handbookDocument(wanted) : null;
    const query = str(ctx.query?.q, 120) || '';
    return {
      docs,
      docId: wanted,
      doc,
      query,
      // Results belong to the index. With a document open the same query is
      // used to mark the words in place, which is a different job from
      // listing everywhere else they appear.
      results: query && !doc ? handbookSearch(query) : null,
    };
  },
};

// ============================================================================
// 5b. REPORTS, the shared vocabulary
// ============================================================================
//
// THE ONE PLACE THE TWO NAMES MEET.
//
// views/reports.js was ported from the shift logger and reads its column
// names; db/schema.sql uses the hub's. Rather than let each query invent its
// own aliases, which is how half a section ends up rendering blank while the
// other half works, every read of these three tables goes through the column
// lists below, and every rule key goes through RULE_KEY_TO_VIEW.
//
// tests/wiring.test.js asserts the rule map is total in both directions. A
// stage renamed on either side fails the suite instead of rendering as
// "Unknown reminder", which is what a bare lookup would have produced: a card
// with buttons that do nothing, on a page that looks fine.





const REPORT_WINDOWS = new Set(['1', '7', '30']);

/** Must match WINDOWS in views/entry.js. */
const REACH_WINDOWS = new Set(['7', '30', '90']);

/** Must match WINDOWS in views/pulse.js. */
const PULSE_WINDOWS = new Set(['7', '30', '90', 'june']);

/** Map a q() result's rows without losing the ok/rows:null distinction. A
 *  `.map()` straight onto `rows` would throw on an outage, and a `|| []`
 *  guard would turn the outage into an empty list, the one substitution this
 *  whole seam exists to prevent. */
function mapRows(result, fn) {
  if (!result || !result.ok) return result;
  return { ok: true, rows: (result.rows || []).map(fn), notice: null };
}



/** Pakistan is UTC+5 with no daylight saving, so a calendar day there is an
 *  exact offset from UTC and needs no time zone tables anywhere. */
const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;

function pktToday(now = new Date()) {
  return new Date(now.getTime() + PKT_OFFSET_MS).toISOString().slice(0, 10);
}

function pktHour(now = new Date()) {
  return new Date(now.getTime() + PKT_OFFSET_MS).getUTCHours();
}

/** Which shift the clock says it is. The view pre-selects it and says so; it
 *  is never used to decide which shift a row belongs to after the fact. */
function pktShiftNow(now = new Date()) {
  const h = pktHour(now);
  if (h >= 9 && h < 17) return 'Morning';
  if (h >= 17 || h < 1) return 'Evening';
  return 'Night';
}

function shiftIsoDay(iso, delta) {
  const [y, m, d] = String(iso).split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return iso;
  return new Date(Date.UTC(y, m - 1, d) + delta * 86_400_000).toISOString().slice(0, 10);
}


/** Designer names the engine has actually seen on an order. A datalist, not a
 *  validated list, a new designer must be typeable on their first day. */
function designersFromEngine() {
  const orders = engineOrders();
  if (isMissing(orders)) return [];
  const names = new Set();
  for (const o of orders) {
    for (const key of ['logo_designer', 'branding_designer', 'designer']) {
      const v = o?.[key];
      if (v && String(v).trim()) names.add(String(v).trim());
    }
  }
  return [...names].sort();
}


/** Profile names, taken from the engine's own flow rows, never a hand-kept
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
  // Reports is registered below instead: it carries a role floor in code that
  // this generic line cannot express, and losing that floor would publish
  // every CSR's per-person figures to every CSR with the page looking normal.
  if (s.key === 'reports') continue;
  const loaderKey = s.key;
  app.get(s.href, requireAuth, gate(s.key), page(s.key, loaders[loaderKey]));
}

// One buyer. Same section, same lock, its own material.
app.get('/clients/:buyer', requireAuth, gate('clients'), (req, res, next) => {
  const buyer = String(req.params.buyer || '').trim();
  if (!buyer || !normaliseBuyer(buyer)) return res.redirect(302, '/clients?error=buyer');
  return page('clients', loaders.client)(req, res, next);
});

// One buyer's message history and what may be said to them next. This is the
// href every "write to this buyer" link on the hub points at, the compose
// form's own `back` field is `/messages/<buyer>`, so without this route every
// logged message bounced to a 404 and the section could only ever show its
// picker.
//
// A username that normalises to nothing is NOT redirected away, unlike
// /clients. The view has a stated branch for it: it renders the picker and
// says that name was not recognised, which tells whoever followed the bad link
// what was wrong with it instead of silently returning them to the list.
app.get('/messages/:buyer', requireAuth, gate('messages'), page('messages', loaders.message));

// One document, open. Same section, same lock, same loader, its own URL so a
// rule can be linked to: /handbook/oh-01#s6 is "revisions, in the Order
// Handbook" and it survives being pasted into a message. An unrecognised name
// is NOT redirected away, the view has a stated branch for it that names what
// was asked for and lists the six, which tells whoever followed the bad link
// what was wrong with it.
app.get('/handbook/:doc', requireAuth, gate('handbook'), page('handbook', loaders.handbook));

// ---- Reports: one half now, the reading half -------------------------------
//
// There were two. `/reports` was the CSR's own shift, a log form and a queue of
// follow-up buttons; `/reports/ceo` was what those shifts produced. The first
// is gone. Nobody types a shift into this hub, they type it into the CSR Shift
// Logger, and a form nobody posts is worse than no form: it is an invitation
// to enter a second copy of something that already exists somewhere else.
//
// So the reading half moves up to `/reports` and keeps its floor.
//
// The floor is gated TWICE and the order matters. `gate('reports')` reads the
// section lock the owner sets from inside the hub, and `atLeast('manager')` is
// the floor this page carries in code. The floor can only be raised: lock
// Reports to owner and this follows it up, never down.
//
// It is a code floor rather than a `section_access` row on purpose. A section
// absent from that table is OPEN, which is the right default for a section
// and exactly the wrong one here, because forgetting to insert one row would
// publish every CSR's per-person figures to every CSR, silently, with the page
// looking completely normal.
app.get(
  '/reports',
  requireAuth,
  gate('reports'),
  atLeast('manager', 'reports'),
  page('reports', loaders.reportsCeo, { view: 'reports-ceo' })
);

// The old address, kept as a redirect rather than dropped. It is the one URL
// from this section anybody has bookmarked, and a 404 on it reads as "the
// figures are gone" rather than "the figures moved up one level".
app.get('/reports/ceo', requireAuth, (req, res) => {
  const query = req.originalUrl.includes('?') ? `?${req.originalUrl.split('?')[1]}` : '';
  res.redirect(301, `/reports${query}`);
});

// ============================================================================
// 7. WRITES
// ============================================================================

/**
 * One transaction: the change and the audit row together.
 *
 * If the audit insert fails the change rolls back. That is the point, a
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

// `entryDefaultIso` and its comment lived here, working out which day the
// daily form should open on from `roster.entryDay`. The form is gone and the
// reach page opens on the board's own last day instead, so nothing needs it.
//
// `roster.entryDay` itself stays. The fact it encodes, that Fiverr publishes a
// day's figures around midday the next day, is what makes a board one day
// behind normal and a board nine days behind a gap, which is the tolerance the
// reach page warns against.

/** Post/Redirect/Get. `back` is validated so a form cannot bounce off-site,
 *  and the message is a CODE, not free text, nothing a client sends is ever
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

// ---- Reach: nothing to write --------------------------------------------
//
// There was a POST /entry here, and a ninety-line body that turned fourteen
// form fields plus a per-gig split into a row of `daily_entry`. It is gone
// with the form. The team types those numbers into the impressions board and
// this hub reads them; a second place to type them would not be a backup, it
// would be a second answer, and nobody would know which one was being read.
//
// `daily_entry` and `daily_entry_gig` are left in db/schema.sql. They hold
// what was typed here while the form existed, and dropping a table to tidy up
// after a decision is how the evidence for the decision disappears.

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



// ---- Orders: the promised delivery date -------------------------------------
//
// The one field the order sheet does not carry, so it is typed here. Writing
// it does NOT touch the sheet, and it does not change any engine figure: the
// engine keeps computing age, and this records what was agreed. The page
// compares them.

app.post(
  '/orders/due',
  ...write('orders', '/orders', async (req) => {
    const row = {
      client: str(req.body.client, 120),
      project: str(req.body.project, 200),
      order_date: str(req.body.order_date, 30),
    };
    if (!row.client) return { error: 'buyer' };

    if (req.body.clear) {
      await auditedWrite(req, 'order_due_cleared', { buyer: row.client, project: row.project }, async () => {
        await clearDueDate(row);
      });
      return { ok: 'due_cleared' };
    }

    const dueDate = str(req.body.due_date, 30);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return { error: 'date' };
    const note = str(req.body.note, 2000) || null;

    await auditedWrite(
      req,
      'order_due_set',
      { buyer: row.client, project: row.project, due: dueDate },
      async () => {
        await setDueDate({ row, dueDate, note, setBy: req.user.name });
      }
    );
    return { ok: 'due_set' };
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

// ---- Messages: the owner's own talk playbook -------------------------------
//
// OWNER ONLY, AND IT IS CHECKED HERE RATHER THAN TRUSTED FROM THE PAGE.
//
// views/messages.js does not render the editor to anybody but Ezan, and that is
// the courtesy. This is the rule. A hidden form is not a permission: the POST
// is one curl away, and the person most likely to find it is a CSR who
// bookmarked the URL, not an attacker.
//
// It is a code check rather than a `section_access` row for the same reason
// /reports/ceo is: a section absent from that table is OPEN, so forgetting one
// row would hand every CSR the ability to rewrite what everybody says to every
// buyer, silently, with the page looking completely normal.

const TALK_STAGES = ['all', 'inquiry', 'kickoff', 'working', 'approved', 'delivered'];
const TALK_KINDS = ['ask', 'stop', 'care'];

/** The turn rows a form posted, as parallel arrays. Blank rows are dropped. */
function readTurns(body) {
  const heard = [].concat(body.turn_h || []);
  const say = [].concat(body.turn_s || []);
  const opens = [].concat(body.turn_u || []);
  const warn = [].concat(body.turn_w || []);

  const turns = [];
  for (let i = 0; i < Math.max(heard.length, say.length); i += 1) {
    const h = str(heard[i], 400);
    const s = str(say[i], 4000);
    // BOTH HALVES OR NEITHER. A turn with a reply and no trigger is a line
    // nobody can find; a turn with a trigger and no reply is a question the
    // page raises and refuses to answer. Neither is stored.
    if (!h || !s) continue;
    turns.push({ h, s, u: str(opens[i], 200), w: str(warn[i], 600) });
  }
  return turns;
}

app.post(
  '/messages/talk',
  ...write('messages', '/messages', async (req) => {
    if (req.user?.role !== 'owner') return { error: 'forbidden' };

    const id = intOrNull(req.body.id);
    const title = str(req.body.title, 200);
    const group = str(req.body.group, 24);
    const heading = str(req.body.heading, 80);
    const turns = readTurns(req.body);

    if (!title || !group || !heading || !turns.length) return { error: 'talk' };

    const kind = oneOf(req.body.kind, TALK_KINDS) || 'ask';
    const sub = str(req.body.sub, 2000);
    // Clamped to the column. A SMALLINT handed 99999 is a strict-mode error,
    // which surfaces as a 500 on a form that was filled in correctly except for
    // one number nobody was told the range of.
    const sort = Math.max(-32768, Math.min(32767, intOrNull(req.body.sort) ?? 0));

    // A card with no stage ticked is offered at EVERY stage, never at none.
    // Storing an empty list would hide it behind every tab at once, which is
    // indistinguishable from having deleted it and is not what anybody meant
    // by leaving the boxes alone.
    const stage = [].concat(req.body.stage || []).map(String).filter((s) => TALK_STAGES.includes(s));
    const stageJson = JSON.stringify(stage.length ? [...new Set(stage)] : ['all']);

    const chips = JSON.stringify(
      String(req.body.chips ?? '')
        .split(',')
        .map((c) => c.trim().slice(0, 40))
        .filter(Boolean)
        .slice(0, 4)
    );

    await auditedWrite(req, id ? 'talk_update' : 'talk_create', { id, title, turns: turns.length }, (t) =>
      id
        ? t.run(
            'UPDATE talk SET heading = ?, `group` = ?, kind = ?, stage = ?, chips = ?, ' +
              'title = ?, sub = ?, turns = ?, sort = ?, author = ? WHERE id = ?',
            [heading, group, kind, stageJson, chips, title, sub, JSON.stringify(turns), sort, req.user.name, id]
          )
        : // slug stays NULL on a card written here. That is what keeps
          // db/seed-talk.js off it: the seed keys on slug, and a UNIQUE index
          // ignores NULLs, so re-running the import can neither duplicate this
          // card nor overwrite it.
          t.run(
            'INSERT INTO talk (heading, `group`, kind, stage, chips, title, sub, turns, sort, source, author) ' +
              "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'hub', ?)",
            [heading, group, kind, stageJson, chips, title, sub, JSON.stringify(turns), sort, req.user.name]
          )
    );
    return { ok: 'talk' };
  })
);

app.post(
  '/messages/talk/toggle',
  ...write('messages', '/messages', async (req) => {
    if (req.user?.role !== 'owner') return { error: 'forbidden' };
    const id = intOrNull(req.body.id);
    if (!id) return { error: 'invalid' };
    const active = checked(req.body.active);

    // Deactivate, never delete. A card that went out to buyers for six months
    // is the explanation for six months of replies, and a DELETE makes those
    // replies unaccountable. Off is a state; gone is a hole.
    await auditedWrite(req, 'talk_toggle', { id, active }, (t) =>
      t.run('UPDATE talk SET active = ?, author = ? WHERE id = ?', [active, req.user.name, id])
    );
    return { ok: active ? 'talk_on' : 'talk_off' };
  })
);

// ---- Responses: the reply library ------------------------------------------




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

// ---- Reports: the shift, what was logged, and what that booked -------------
//
// THE ONE INVARIANT THIS WHOLE SECTION EXISTS FOR:
//
//   An activity is written in the SAME TRANSACTION as the reminders it books.
//
// Not "shortly after", not "in an afterwards hook". If the reminder inserts
// fail, the entry rolls back with them. An entry that saved and booked nothing
// is the exact failure the shift logger was built to prevent, a follow-up
// nobody ever hears about again, and it is invisible from the outside: the
// CSR sees "saved", the timeline shows the entry, and the buyer is simply
// never contacted. Half-written is worse than not written, because not written
// is something a person notices.
//
// `lib/reminders.js` decides WHAT is owed. This code only writes it down.

// This hub is XStudioz and only XStudioz. The shift-report system it grew out
// of served ten profiles, so every row there carries a profile column; here
// there is exactly one, and asking a CSR to pick it on every entry would be a
// field whose only possible wrong answer is somebody else's data.
const HUB_PROFILE = 'X Studioz';



/**
 * Was this a rule refusing to book, rather than the database failing?
 *
 * `transaction()` wraps whatever is thrown inside it in a DbError and keeps
 * the original on `.cause`, so a bare `instanceof` check here would classify
 * "your custom reminder has no time on it" as a database outage, and tell the
 * CSR nothing was saved because the store is down, which is both untrue and
 * unfixable from their end. Walk the chain.
 */
function reminderFault(err) {
  for (let e = err, hops = 0; e && hops < 5; e = e.cause, hops += 1) {
    if (e instanceof ReminderError) return e;
  }
  return null;
}

/** Fields the form uses for plumbing rather than content. */
const NOT_DETAIL = new Set(['_csrf', 'back', 'report_id', 'type', 'activity_id', 'reminder_id', 'button', 'intent']);

/** The typed fields of an activity form → the `detail` JSON.
 *  Blank stays out entirely: an absent key is "not recorded", and writing ''
 *  would make `detail.remind_in` exist-and-be-empty, which parses to a default
 *  rather than to the rule's stated 24 hours. */
function detailFrom(body) {
  const out = {};
  for (const [key, value] of Object.entries(body || {})) {
    if (NOT_DETAIL.has(key)) continue;
    if (Array.isArray(value)) {
      const list = value.map((v) => str(v, 200)).filter(Boolean);
      if (list.length) out[key] = list;
      continue;
    }
    const v = str(value, 2000);
    if (v !== null) out[key] = v;
  }
  return out;
}

/** Read a reminder for update, inside the transaction, with its row locked.
 *  `FOR UPDATE` matters: two CSRs on the same profile can tap the same card in
 *  the same second, and without the lock both reads see it pending and both
 *  write a resolution, the second silently overwriting the first's button. */
async function lockReminder(t, id) {
  return t.queryOne('SELECT * FROM reminder WHERE id = ? FOR UPDATE', [id]);
}

/** Write one drafted reminder. The draft comes from lib/reminders.js and its
 *  keys are the column names on purpose, one shape, no per-call mapping. */
async function insertReminder(t, draft) {
  return t.run(
    'INSERT INTO reminder (report_id, activity_id, `rule`, rule_key, chain_step, profile, client, client_key, ' +
      'order_ref, due_at, heading, body, alert, state, resolution, snoozed_until, resolved_by, resolved_at, booked_by) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      draft.report_id, draft.activity_id, draft.rule, draft.rule_key, draft.chain_step,
      draft.profile, draft.client, draft.client_key, draft.order_ref, draft.due_at,
      draft.heading, draft.body, draft.alert, draft.state, draft.resolution,
      draft.snoozed_until, draft.resolved_by, draft.resolved_at, draft.booked_by,
    ]
  );
}

/** Write a state transition back. Never touches `heading`/`body`: resolving a
 *  reminder does not change what it asked for, and a ledger that rewrites its
 *  own history cannot settle an argument later. */
async function saveReminderState(t, next) {
  return t.run(
    'UPDATE reminder SET state = ?, resolution = ?, snoozed_until = ?, resolved_by = ?, resolved_at = ? WHERE id = ?',
    [next.state, next.resolution, next.snoozed_until, next.resolved_by, next.resolved_at, next.id]
  );
}

/** The shift the signed-in person has open, or null. Every write below is
 *  scoped through this: a report_id from a form is a number a browser sent,
 *  and it is never trusted to name somebody else's shift. */
async function openShiftOf(t, person, reportId = null) {
  const row = await t.queryOne(
    "SELECT * FROM shift_report WHERE person = ? AND status = 'open' ORDER BY opened_at DESC LIMIT 1",
    [person]
  );
  if (!row) return null;
  if (reportId !== null && String(row.id) !== String(reportId)) return null;
  return row;
}

// ---- open a shift ----------------------------------------------------------


// ---- log an activity, and book what it owes --------------------------------


// ---- remove an entry, and the reminders it booked --------------------------


// ---- resolve, snooze, or advance a chain -----------------------------------


// ---- take the last tap back ------------------------------------------------
//
// The spec asks for five seconds of undo on a toast. A toast needs JavaScript
// and vanishes with the page, so this keeps the same promise durably: the
// reminders closed on this shift stay listed with a way back, through a page
// load, a dropped connection and a locked screen.


// ---- mark an incoming handoff note read ------------------------------------


// ---- wrap up, and hand over ------------------------------------------------


/**
 * Is this buyer safe to ask for a public review, right now, on this profile?
 *
 * Runs INSIDE the booking transaction so the answer cannot be stale: a dispute
 * logged four seconds ago has to count, and a check made before the
 * transaction opened would miss it.
 *
 * A read that fails does not reach here, it throws, and the whole entry rolls
 * back, which is the right way round. The alternative is booking a review ask
 * because the flag query happened to be unavailable, and that is precisely the
 * ask the rule exists to stop.
 */
async function reviewFlagsFor(t, profile, client) {
  const key = client ? buyerKey(client) : null;
  if (!key) return {};

  const alerts = await t.query(
    "SELECT rule_key FROM reminder WHERE profile = ? AND client_key = ? AND alert = 1 AND state <> 'resolved'",
    [profile, key]
  );
  const flags = {
    frustrated: alerts.some((a) => a.rule_key === 'frustrated_alert'),
    disputed: alerts.some((a) => a.rule_key === 'disputed_alert'),
    late: false,
  };

  const stale = pick(engineRun(), 'recovery.open_orders.orders');
  if (isMissing(stale) || !Array.isArray(stale)) {
    // The late list is unreadable. Hold the ask: an ask the hub cannot prove
    // is safe is the one the rule was written about.
    flags.late = true;
    return flags;
  }
  flags.late = stale.some((o) => o?.stale && normaliseBuyer(o.client) === normaliseBuyer(client));
  return flags;
}

// ============================================================================
// 8. LOGIN / LOGOUT
// ============================================================================
//
// APP_PASSWORD proves you are the team. The name says which of the team you
// are. The name picker is a SIGNATURE on every write, not a security boundary,
// and lib/auth.js says so in as many words, do not let a later reader mistake
// it for one.

function loginPage(req, res, { error = null } = {}) {
  // headline stays empty: layout()'s title prints it, and setting both
  // rendered "Sign in" twice, once above the other.
  const ctx = buildCtx(req, res, null, { headline: '', chrome: 'minimal' });
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
          ? html`<p class="note note--neg">Login is not configured on this server, ${cfg.missing.join(' and ')} not set. Nobody can sign in until they are.</p>`
          : ''}
        ${cfg.warning ? html`<p class="note note--warn">${cfg.warning}</p>` : ''}
      </div>
    </div>`;

  return layout(ctx, { title: 'Sign in', kicker: 'XStudioz hub', html: body });
}

// Step two, on a new device only: who is holding it. Asked once, then never
// again, but not optional, because an unsigned tick is a tick nobody can be
// asked about, and that is the failure this whole hub was built to fix.
function claimPage(req, res, { error = null, users = null, usersError = null } = {}) {
  const ctx = buildCtx(req, res, null, { headline: '', chrome: 'minimal' });
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
              Asked once for this browser. Your name signs every tick, note and score you write,
              it is attribution, not a second password.
            </p>
          </div>
          <div class="form-actions">
            <button class="btn" type="submit">This laptop is mine</button>
          </div>
        </form>

        <form method="post" action="/share" class="stack stack--tight">
          <input type="hidden" name="next" value="${nextTo}">
          <div class="form-actions">
            <button class="btn btn--ghost" type="submit">The team shares this laptop</button>
          </div>
          <p class="field-hint">
            Pick this for a desk more than one person sits at. The password is not asked again on this
            laptop, and whoever sits down taps their own name at the start of their shift, so their work
            is signed by them and not by whoever set it up.
          </p>
        </form>
      </div>
      <div class="lede-side">
        <p class="caption">Sign out at any time to hand this device to someone else, that is the one thing that makes it ask again.</p>
        ${usersError ? html`<p class="note note--warn">${usersError}</p>` : ''}
      </div>
    </div>`;

  return layout(ctx, { title: 'Who is on this device?', kicker: 'XStudioz hub', html: body });
}

// The shift picker: a trusted laptop asking who is at the keyboard.
//
// The roster does the work here. At 10 AM on a Tuesday it knows Amrah and
// Zaheen are on, so those two are the buttons and everybody else is folded
// away. One tap for the normal case, and a wrong tap is visible because the
// person who should be on duty is the one shown first.
function whoPage(req, res, { error = null, users = null, usersError = null, needPassword = null } = {}) {
  const ctx = buildCtx(req, res, null, { headline: '', chrome: 'minimal' });
  const nextTo = safeNext(req.query.next || req.body?.next, '/');
  const desk = deskNow();
  const onDuty = new Set(desk.names);

  const all = users || [];
  const rostered = all.filter((u) => onDuty.has(u.name));
  const others = all.filter((u) => !onDuty.has(u.name));

  const personButton = (u) => html`<form method="post" action="/who" class="who-pick">
      <input type="hidden" name="next" value="${nextTo}">
      <input type="hidden" name="name" value="${u.name}">
      ${u.role === 'owner'
        ? html`<label class="sr-only" for="pw-${u.name}">Password for ${u.name}</label>
            <input class="who-pw" id="pw-${u.name}" name="password" type="password"
                   autocomplete="current-password" placeholder="Password"
                   ${safe(needPassword === u.name ? 'autofocus' : '')} required>`
        : ''}
      <button class="btn ${safe(u.role === 'owner' ? 'btn--ghost' : '')}" type="submit">
        ${u.name}${u.role === 'owner' ? ' (needs the password)' : ''}
      </button>
    </form>`;

  const body = html`<div class="lede">
      <div class="lede-main">
        <div class="figure">
          <span class="cap">${desk.uncovered ? 'Nobody is rostered right now' : 'On the roster right now'}</span>
          <strong class="mid">${desk.names.length ? desk.names.join(', ') : missing()}</strong>
          <p class="sub">${desk.label}, ${desk.day}. Tap your name to start your shift.</p>
        </div>

        ${error ? html`<p class="note note--neg">${error}</p>` : ''}

        <div class="who-grid">${join(rostered.map(personButton))}</div>

        ${others.length
          ? html`<details class="who-others">
              <summary>Somebody else is at this desk</summary>
              <div class="who-grid">${join(others.map(personButton))}</div>
            </details>`
          : ''}

        ${usersError ? html`<p class="note note--warn">${usersError}</p>` : ''}
      </div>
      <div class="lede-side">
        <p class="caption">
          This laptop is already trusted, so there is no password for a CSR. Your name signs every note,
          entry and tick you write for the next ${String(Math.round(SHIFT_TTL_MS / 3_600_000))} hours, then
          the hub asks again so the next shift does not write under your name.
        </p>
        <p class="caption">
          Ezan is the exception. His sections are locked to him, so choosing him needs the password every
          time, otherwise the lock would be a label rather than a lock.
        </p>
      </div>
    </div>`;

  return layout(ctx, { title: 'Who is at this desk?', kicker: 'Start of shift', html: body });
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
    // Expired proof means the password must be typed again, do not leave them
    // on a form that cannot succeed.
    if (result.reason === 'expired') {
      return res.status(401).send(loginPage(req, res, { error: result.message }));
    }
    res.status(result.reason === 'db_unavailable' ? 503 : 401)
      .send(claimPage(req, res, { error: result.message, users, usersError }));
  })
);

// Enrol a shared laptop: trusted, nobody bound to it.
app.post(
  '/share',
  wrap(async (req, res) => {
    const result = await shareDevice({ req, res });
    const to = encodeURIComponent(safeNext(req.body.next, '/'));
    if (result.ok) return res.redirect(303, `/who?next=${to}`);
    return res.status(401).send(loginPage(req, res, { error: result.message }));
  })
);

// Who is at the keyboard of an already-trusted laptop.
app.get(
  '/who',
  wrap(async (req, res) => {
    // A laptop nobody has trusted yet has to do the password first.
    if (!req.device) {
      const to = encodeURIComponent(safeNext(req.query.next, '/'));
      return res.redirect(302, `/login?next=${to}`);
    }
    res.send(whoPage(req, res, await usersOrNotice()));
  })
);

app.post(
  '/who',
  loginLimiter,
  wrap(async (req, res) => {
    const name = String(req.body.name || '').slice(0, 80);
    const result = await switchPerson({ req, res, name, password: req.body.password });
    if (result.ok) return res.redirect(303, safeNext(req.body.next, '/'));

    if (result.reason === 'untrusted') {
      return res.status(401).send(loginPage(req, res, { error: result.message }));
    }
    const { users, usersError } = await usersOrNotice();
    res
      .status(result.reason === 'db_unavailable' ? 503 : 401)
      .send(
        whoPage(req, res, {
          error: result.message,
          users,
          usersError,
          needPassword: result.reason === 'owner_password' ? name : null,
        })
      );
  })
);

app.post(
  '/login',
  loginLimiter,
  wrap(async (req, res) => {
    const result = await attemptLogin({ req, res, password: req.body.password });

    // Password accepted on a device nobody has claimed yet, one more step.
    if (result.ok && result.needsName) {
      const to = encodeURIComponent(safeNext(req.body.next, '/'));
      return res.redirect(303, `/claim?next=${to}`);
    }
    if (result.ok) return res.redirect(303, safeNext(req.body.next, '/'));

    // 4xx so the limiter counts the attempt, it skips successful requests.
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

// A GET must not log anyone out, an <img src="/logout"> anywhere would do it.
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
//   the engine data on disk, without it there is nothing to render
//   MySQL, without it the hub degrades but still works
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
 * The last stop. It says what broke and never shows a stack, a stack trace in
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
      ? html`Everything typed into the hub, ticks, entries, notes, scores, could not be read or written. The engine's figures are unaffected and every page that reads from <code class="mono">data/</code> still works.`
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
        next: html`<span class="caption">Reference <code class="mono">${ref}</code>, quote it if you report this.</span>`,
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
 * A failure here must NOT stop the server. The engine-data pages. Today,
 * Orders, Inquiries, Money, read from disk and are still completely valid
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
        ? `[boot] schema: created ${created.length} table(s), ${created.join(', ')}`
        : '[boot] schema: up to date'
    );
    // Drift means a table exists but is missing a column this build expects.
    // CREATE TABLE IF NOT EXISTS cannot fix that, so it must be said out loud
    // rather than discovered later as a column-not-found on someone's save.
    if (drift.length) {
      console.warn(`[boot] schema DRIFT, ${drift.length} table(s) missing expected columns:`);
      for (const d of drift) console.warn(`[boot]   ${d.table}: ${(d.missing || []).join(', ')}`);
    }
  } catch (err) {
    console.error(`[boot] schema migration FAILED, ${err.message}`);
    console.error('[boot] typed records will not work until this is fixed. Engine pages are unaffected.');
    return;
  }
  try {
    const { seed } = await import('./db/seed.js');
    const { users, responses } = await seed({ log: hush });
    if (users?.inserted?.length) {
      console.log(`[boot] seed: added ${users.inserted.length} user(s), ${users.inserted.join(', ')}`);
    }
    if (responses?.inserted) {
      console.log(`[boot] seed: added ${responses.inserted} repl(ies) to the library`);
    }
  } catch (err) {
    console.error(`[boot] seed failed, ${err.message}`);
  }

  // THE TALK PLAYBOOK SEEDS ON BOOT, and it did not before.
  //
  // It was an npm script, on the assumption that whoever deployed would run it
  // once. Nobody did, because the person who owns those lines works from a
  // phone and a browser and has no shell. The result was a Messages page that
  // said "the playbook is empty, run npm run seed:talk" to the one person who
  // could not, and every reply looked like something he had to type by hand.
  //
  // Safe to run every boot: INSERT IGNORE on a stable slug, so a second run
  // inserts nothing, overwrites nothing, and never touches a card written or
  // edited inside the hub.
  try {
    const { seedTalk } = await import('./db/seed-talk.js');
    const res = await seedTalk({ log: hush });
    if (res?.inserted) console.log(`[boot] seed: added ${res.inserted} talk card(s)`);
  } catch (err) {
    console.error(`[boot] talk seed failed, ${err.message}`);
  }
}

if (process.env.NODE_ENV !== 'test') {
  const cfg = authConfig();
  if (!cfg.ok) {
    console.warn(`[boot] ${cfg.missing.join(' and ')} not set, nobody can sign in until they are.`);
  }
  if (cfg.warning) console.warn(`[boot] ${cfg.warning}`);
  // Length only, never the value, enough to tell a mistyped password from a
  // pasted trailing space without putting the secret in a log file.
  console.log(`[boot] APP_PASSWORD: ${passwordShape()}`);
  if (!dbConfigured()) {
    console.warn(
      `[boot] database not configured (missing ${missingEnv().join(', ')}), typed records are unavailable; ` +
        'the engine-data pages still work.'
    );
  }
  const st = staleness();
  console.log(
    `[boot] engine data: ${st.ok ? `run ${st.run_date}, ${st.label}` : 'MISSING, latest-run.json not readable'}`
  );

  // Listen FIRST, migrate after.
  //
  // These were the other way round and it took the site down with a 503. The
  // schema work opens a MySQL connection, and an unreachable or slow database
  // makes that await hang for its full connect timeout, during which the
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
    console.error(`[boot] database preparation errored, ${err.message}`);
  });
}

export default app;
