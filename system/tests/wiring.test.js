// tests/wiring.test.js — the seam between server.js and views/.
//
// WHY THIS FILE EXISTS
//
// Every bug it pins renders as HTTP 200. That is the whole problem. A view
// whose loader never supplies its data does not throw and does not blank —
// it takes the branch written for "there is nothing here yet" and prints a
// calm, well-designed page that is missing half of itself. A link to a route
// nobody registered looks perfect until somebody clicks it. Neither shows up
// in a smoke test that only checks status codes, and neither shows up in a
// unit test of either side on its own, because each side is individually
// correct. Only the seam is wrong.
//
// Three checks, in the order the failures actually happened:
//
//   1. every section in the rail has a GET route
//   2. every internal link and form action a view emits resolves to a route
//   3. every `ctx.data` key a view reads is supplied by that section's loader
//
// server.js checks NODE_ENV before it binds a port, so this file sets it and
// then reaches the app through a DYNAMIC import. A static `import` would not
// work and would not look broken: ESM evaluates every static import before the
// first statement of the importing module, so `process.env.NODE_ENV = 'test'`
// written above one runs too late, server.js boots for real, and the suite
// fails on EADDRINUSE the moment the dev server is up — or, worse, quietly
// passes on a machine where it is not.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.NODE_ENV = 'test';
const { app, loaders } = await import('../server.js');
const { SECTIONS } = await import('../views/layout.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const viewSource = (key) => fs.readFileSync(path.join(ROOT, 'views', `${key}.js`), 'utf8');

/** Every path Express will answer, as {method, path} — '/clients/:buyer' and all. */
function registeredRoutes() {
  const out = [];
  for (const layer of app._router.stack) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods)) {
      out.push({ method: method.toUpperCase(), path: layer.route.path });
    }
  }
  return out;
}

/** Does `pathname` hit a registered route of this method? Params match one segment. */
function resolves(method, pathname) {
  return registeredRoutes().some((r) => {
    if (r.method !== method) return false;
    const want = r.path.split('/');
    const got = pathname.split('/');
    if (want.length !== got.length) return false;
    return want.every((seg, i) => seg.startsWith(':') || seg === got[i]);
  });
}

/**
 * Internal paths a view hard-codes into an href or a form action.
 *
 * Only literals are collected. A path built from a helper (`/messages/${name}`)
 * is skipped here and covered by check 1 instead — a template with a hole in
 * it cannot be resolved without knowing what goes in the hole, and guessing
 * would make this test fail on data rather than on wiring.
 */
function literalTargets(source, attribute) {
  const found = new Set();
  const re = new RegExp(`${attribute}="(/[^"$]*)"`, 'g');
  for (const m of source.matchAll(re)) {
    const clean = m[1].split('?')[0].split('#')[0];
    if (clean === '' || clean.endsWith('.css')) continue;
    found.add(clean);
  }
  return [...found];
}

const VIEW_KEYS = SECTIONS.map((s) => s.key);

// ---------------------------------------------------------------- check 1

test('every section in the rail has a GET route behind it', () => {
  for (const section of SECTIONS) {
    assert.ok(
      resolves('GET', section.href),
      `${section.key} is in the rail at ${section.href} with no GET route — the link is a 404`
    );
  }
});

test('the two per-buyer detail routes exist, and share their section lock', () => {
  // Both are reachable from inside their own section: /clients links to a
  // buyer record, /messages links to a buyer's history, and the compose form
  // posts back to /messages/<buyer>. A missing detail route strands the
  // section on its list forever.
  for (const p of ['/clients/:buyer', '/messages/:buyer']) {
    assert.ok(
      registeredRoutes().some((r) => r.method === 'GET' && r.path === p),
      `${p} is not registered`
    );
  }
});

// ---------------------------------------------------------------- check 2

test('every internal link a view emits resolves to a GET route', () => {
  const broken = [];
  for (const key of VIEW_KEYS) {
    for (const target of literalTargets(viewSource(key), 'href')) {
      if (!resolves('GET', target)) broken.push(`views/${key}.js -> GET ${target}`);
    }
  }
  assert.deepEqual(broken, [], `dead links:\n  ${broken.join('\n  ')}`);
});

test('every form action a view emits resolves to a POST route', () => {
  // This is the check that was missing when the Responses page shipped a copy
  // button posting to /responses/copy, which nothing served: the reply landed
  // on the clipboard and the count that was supposed to record it 404'd.
  const broken = [];
  for (const key of VIEW_KEYS) {
    for (const target of literalTargets(viewSource(key), 'action')) {
      if (target === '/entry' && !viewSource(key).includes('method="post" action="/entry"')) continue;
      if (!resolves('POST', target) && !resolves('GET', target)) {
        broken.push(`views/${key}.js -> POST ${target}`);
      }
    }
  }
  assert.deepEqual(broken, [], `forms with no handler:\n  ${broken.join('\n  ')}`);
});

// ---------------------------------------------------------------- check 3

/**
 * The `ctx.data` keys a view module reads.
 *
 * Both spellings, because both are in use and only one of them is obvious.
 * views/entry.js opens with `const d = ctx.data || {}` and then reads `d.date`,
 * `d.previous`, `d.previousGigs` — a scan for `ctx.data.` alone sees none of
 * that and reports the section as fully wired while two of its seven keys were
 * never supplied. So the aliases are resolved first and followed.
 */
function keysReadBy(key) {
  const source = viewSource(key);
  const found = new Set();
  for (const m of source.matchAll(/ctx\.data\??\.([A-Za-z_$][\w$]*)/g)) found.add(m[1]);

  // The whole object only — `const d = ctx.data || {}`. The negative lookahead
  // is load-bearing: without it `const notes = ctx.data?.notes` reads as an
  // alias of ctx.data itself, and then every `notes.ok` and `notes.rows` in
  // the file is reported as a missing key that the loader owes.
  for (const alias of source.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*ctx\.data\s*(?![?.\w])/g)) {
    const name = alias[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const m of source.matchAll(new RegExp(`\\b${name}\\??\\.([A-Za-z_$][\\w$]*)`, 'g'))) {
      found.add(m[1]);
    }
  }
  return [...found].sort();
}

/**
 * Run a loader with no database and no engine assumptions, and report which
 * keys it puts on ctx.data.
 *
 * `q` answers the way a failed read answers — ok:false, rows:null — because
 * that is the shape a loader has to survive anyway, and it means this test
 * needs no MySQL to run in CI or on a laptop.
 */
async function keysSuppliedBy(loaderName) {
  const loader = loaders[loaderName];
  if (!loader) return null;
  const q = async () => ({ ok: false, rows: null, notice: 'stub' });
  const ctx = { engine: { runDate: '2026-08-01' }, query: {}, run: null, data: {} };
  const req = { params: { buyer: 'someone' }, query: {} };
  return Object.keys((await loader(ctx, q, req)) || {}).sort();
}

// A section whose detail page is its own route reads some keys only on the
// list and some only on the detail, so the pair is what has to cover the view.
const LOADERS_FOR = {
  clients: ['clients', 'client'],
  messages: ['messages', 'message'],
};

for (const key of VIEW_KEYS) {
  test(`views/${key}.js is handed every ctx.data key it reads`, async () => {
    const wanted = keysReadBy(key);
    if (!wanted.length) return; // a view that reads none is legitimately chrome-only

    const supplied = new Set();
    for (const name of LOADERS_FOR[key] || [key]) {
      const keys = await keysSuppliedBy(name);
      assert.ok(keys, `there is no loader named "${name}" for section ${key}`);
      for (const k of keys) supplied.add(k);
    }

    const absent = wanted.filter((k) => !supplied.has(k));
    assert.deepEqual(
      absent,
      [],
      `views/${key}.js reads ctx.data.${absent.join(', ctx.data.')} — its loader never sets ` +
        `${absent.length === 1 ? 'it' : 'them'}, so that part of the page silently renders as ` +
        `"nothing here" on every request. Supplied: ${[...supplied].sort().join(', ') || '(nothing)'}`
    );
  });
}

// ---------------------------------------------------------------- check 4

/**
 * Views that are NOT the whole of a section.
 *
 * Reports is one rail entry and two pages: `/reports` is the CSR's shift and
 * `/reports/ceo` is what the shifts produced. The loop above walks SECTIONS,
 * so the second file is invisible to it — and a view nothing checks is a view
 * that drifts. Same three questions, asked by hand.
 */
const EXTRA_VIEWS = [
  { view: 'reports-ceo', loader: 'reportsCeo', at: '/reports/ceo' },
];

for (const extra of EXTRA_VIEWS) {
  test(`views/${extra.view}.js is wired at ${extra.at} and handed every key it reads`, async () => {
    assert.ok(resolves('GET', extra.at), `${extra.at} has no GET route — views/${extra.view}.js is unreachable`);

    const wanted = keysReadBy(extra.view);
    const supplied = new Set(await keysSuppliedBy(extra.loader));
    const absent = wanted.filter((k) => !supplied.has(k));
    assert.deepEqual(
      absent,
      [],
      `views/${extra.view}.js reads ctx.data.${absent.join(', ctx.data.')} — loaders.${extra.loader} ` +
        `never sets ${absent.length === 1 ? 'it' : 'them'}. Supplied: ${[...supplied].sort().join(', ')}`
    );

    const source = viewSource(extra.view);
    for (const target of literalTargets(source, 'href')) {
      assert.ok(resolves('GET', target), `views/${extra.view}.js -> GET ${target} is a dead link`);
    }
    for (const target of literalTargets(source, 'action')) {
      assert.ok(
        resolves('POST', target) || resolves('GET', target),
        `views/${extra.view}.js -> ${target} has no handler`
      );
    }
  });
}

// ---------------------------------------------------------------- check 5

/**
 * The two spellings of the thirteen reminder logics.
 *
 * `lib/reminders.js` names the stage that books a follow-up `order_assign`;
 * `views/reports.js`, ported from the shift logger on a different day, calls
 * the same stage `new_order`. The stored value is the engine's, so every read
 * for the CSR page translates through `RULE_KEY_TO_VIEW` in server.js.
 *
 * Nothing about that drift is visible at runtime. An unmapped key does not
 * throw — the view falls through to its ORPHAN rule and renders a card with
 * the wrong title and no working buttons, on a page that otherwise looks
 * completely normal, and the CSR taps a button that resolves nothing. So the
 * map is checked here, in both directions, and a rename on either side fails
 * the suite instead of shipping.
 */
test('every reminder rule maps between the engine and the CSR view, both ways', async () => {
  const { RULE_KEY_TO_VIEW } = await import('../server.js');
  const { RULE_KEYS } = await import('../lib/reminders.js');
  const { RULES: VIEW_RULES } = await import('../views/reports.js');

  const unmapped = RULE_KEYS.filter((k) => !RULE_KEY_TO_VIEW[k]);
  assert.deepEqual(
    unmapped,
    [],
    `lib/reminders.js rule${unmapped.length === 1 ? '' : 's'} ${unmapped.join(', ')} ` +
      'have no entry in RULE_KEY_TO_VIEW — a reminder booked by them renders on the CSR page as an ' +
      'uninterpretable card with buttons that do nothing'
  );

  const viewKeys = Object.keys(VIEW_RULES);
  const dangling = Object.entries(RULE_KEY_TO_VIEW)
    .filter(([, v]) => !viewKeys.includes(v))
    .map(([k, v]) => `${k} -> ${v}`);
  assert.deepEqual(
    dangling,
    [],
    `RULE_KEY_TO_VIEW points at rule keys views/reports.js does not define: ${dangling.join(', ')}`
  );

  const unreachable = viewKeys.filter((v) => !Object.values(RULE_KEY_TO_VIEW).includes(v));
  assert.deepEqual(
    unreachable,
    [],
    `views/reports.js defines rule${unreachable.length === 1 ? '' : 's'} ${unreachable.join(', ')} ` +
      'that nothing can ever book — no engine rule maps to them'
  );
});

/**
 * The two tables of thirteen delays, held to the same numbers.
 *
 * views/reports.js keeps a rule table because the LOG FORM has to say what
 * saving an entry will book before any reminder exists ("this books a reminder
 * — 25 minutes"). lib/reminders.js keeps one because it does the booking. Two
 * tables of the same thirteen offsets is the exact shape of the bug this repo
 * exists to referee: they agree on the day they are written and nowhere else,
 * and when they part the form promises 25 minutes while the engine books 30 —
 * with nothing on either side looking wrong.
 *
 * So the numbers are compared, not trusted. REMINDER-LOGICS.md is the
 * authority for both; if this fails, fix the table that moved rather than the
 * expectation.
 */
test('both rule tables state the same delay, buttons and cancel for all thirteen', async () => {
  const { RULE_KEY_TO_VIEW } = await import('../server.js');
  const { RULES: ENGINE_RULES, RULE_KEYS } = await import('../lib/reminders.js');
  const { RULES: VIEW_RULES } = await import('../views/reports.js');

  // One entry per stage, carrying whatever detail its delay/condition reads.
  const sample = {
    inquiry_followup: {},
    lead_followup_next: { attempt: '1st' },
    order_assign: {},
    order_upsell: { order_via: 'Direct Order' },
    completed_public_review: {},
    review_private_ask: { rating: 5 },
    files_upsell: {},
    revision_check: {},
    offer_fu1: {},
    offer_fu2: {},
    offer_fu3: {},
    delivery_followup: { stage: 'Final files' },
    shared_followup: { elements: ['Final files'] },
    frustrated_alert: {},
    disputed_alert: {},
    custom: {},
  };

  for (const key of RULE_KEYS) {
    const engine = ENGINE_RULES[key];
    const view = VIEW_RULES[RULE_KEY_TO_VIEW[key]];
    const detail = sample[key];
    assert.ok(detail, `add a sample entry for the new rule ${key}`);
    const where = `rule ${engine.rule} (${key} / ${RULE_KEY_TO_VIEW[key]})`;

    // Rule 13's delay is an absolute moment rather than an offset, so there is
    // no shared number to compare — the two tables agree that it is whatever
    // the CSR picked, which both express by reading `remind_at`.
    if (key !== 'custom') {
      const engineDelay = engine.delay({ kind: engine.on, detail }, {});
      const viewDelay =
        typeof view.delay === 'function' ? view.delay({ details: detail }) : view.delay;
      assert.equal(engineDelay, viewDelay, `${where}: the two tables disagree about the delay`);
    }

    const shape = (b) => `${b.key}/${b.label}/${b.kind}/${b.minutes ?? ''}/${b.next ?? ''}`;
    assert.deepEqual(
      engine.buttons.map(shape),
      view.buttons.map(shape),
      `${where}: the two tables disagree about the buttons`
    );

    assert.equal(Boolean(engine.alert), Boolean(view.alert), `${where}: they disagree about the red alert`);
    assert.equal(
      engine.cancelOn ?? null,
      view.cancelOn ?? null,
      `${where}: they disagree about what auto-clears it`
    );
    assert.equal(
      Boolean(engine.chained),
      Boolean(view.chained),
      `${where}: they disagree about whether logging can book it`
    );
  }
});
