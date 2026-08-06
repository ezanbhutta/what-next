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

/**
 * 4. A VIEW MUST NOT READ A COLUMN NAME THE LOADER ALIASED AWAY.
 *
 * server.js selects the reports tables through REPORT_COLS / ACTIVITY_COLS /
 * REMINDER_COLS, and several columns are renamed on the way out:
 * `opened_at AS started_at`, `person AS csr_name`, `kind AS type`,
 * `order_ref AS project`, `body AS note`, `booked_by AS created_by`. The row a
 * view receives has the ALIAS. Reading the original name yields `undefined`,
 * and `undefined` is exactly the kind of nothing this file exists to catch: it
 * does not throw, it does not blank the page, it takes the empty branch.
 *
 * That is not hypothetical. views/reports-ceo.js grouped shifts into days with
 * `pktDay(s.opened_at)`. Every key came back null, no shift matched any day,
 * and the page rendered "Day by day: 0 shifts, covered by nobody" and "Who
 * covered what: no shift was opened in this window" directly beneath a masthead
 * reading "Shifts 1 · People 1 · Entries 19". HTTP 200, nothing in the log, and
 * an owner being told the shift in front of him did not happen.
 *
 * Checks 1-3 could not see it: the route exists, the loader supplies `shifts`,
 * and the view does read `ctx.data.shifts`. The drift is one level down, inside
 * the row, which is why this check reads for the aliased-away name directly.
 */
test('no reports view reads a column its loader renamed', async () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

  // `<expr> AS <alias>` out of the three column lists — the aliases actually
  // in force, read from server.js rather than restated here, so adding one to
  // a SELECT brings it under this check with no edit to the test.
  const renamed = new Map();
  for (const list of ['REPORT_COLS', 'ACTIVITY_COLS', 'REMINDER_COLS']) {
    const block = new RegExp(`const ${list} = \\[([\\s\\S]*?)\\]\\.join`).exec(server);
    if (!block) continue;
    for (const m of block[1].matchAll(/["'`]?([`\w]+)\s+AS\s+(\w+)["'`]?/gi)) {
      renamed.set(m[1].replace(/`/g, ''), m[2]);
    }
  }
  assert.ok(renamed.size > 0, 'found no AS aliases in the reports column lists — has the seam moved?');

  // `rule` is put BACK by server.js. inViewVocabulary() rewrites every reminder
  // row as `{...row, rule: <the view's spelling of rule_key>}` precisely so the
  // CSR page can look its rule up by name, and views/reports-ceo.js also reads
  // `def.rule` off a rule DEFINITION from lib/reminders.js, which is not a row
  // at all. It is the one alias whose original name is legitimately present, so
  // it is exempt here rather than silently unchecked.
  const restored = new Set(['rule']);

  const problems = [];
  for (const view of ['reports', 'reports-ceo']) {
    const src = fs.readFileSync(path.join(ROOT, 'views', `${view}.js`), 'utf8');
    // Strip comments: these names are discussed in prose all over both files,
    // and the prose is how the rule is explained rather than a use of it.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const [original, alias] of renamed) {
      if (restored.has(original)) continue;
      // A property read of the pre-alias name: `.opened_at`, never `x_opened_at`.
      if (new RegExp(`\\.${original}\\b`).test(code)) {
        problems.push(`views/${view}.js reads .${original} — the loader supplies .${alias}`);
      }
    }
  }

  assert.deepEqual(
    problems,
    [],
    `A reports view reads a column name its loader aliased away, so the value is always undefined:\n  ${problems.join('\n  ')}`
  );
});

/**
 * 5. THE CSR PAGE SHOWS THE HEADING THAT WAS BOOKED.
 *
 * lib/reminders.js writes `heading` at booking time from the entry's own
 * detail; that string is what REMINDER-LOGICS.md specifies and what the audit
 * row and the owner's ledger carry. views/reports.js keeps a second rule table
 * with its own `title()` functions, and rendering those instead produced a
 * different sentence on four of the thirteen rules — most damagingly rule 2,
 * where the engine books "Send the 2nd follow-up" and the re-derived title said
 * "Send the 1st follow-up logged": the wrong follow-up, on the one rule whose
 * entire content is which follow-up comes next.
 *
 * So the card renders the stored heading and `title()` is only the fallback.
 */
test('the CSR page renders the stored reminder heading, not a re-derived one', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'views', 'reports.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  assert.match(
    code,
    /function titleOf\s*\(/,
    'views/reports.js has no titleOf() — the card is re-deriving its title instead of showing the booked one'
  );
  assert.doesNotMatch(
    code,
    /\$\{rule\.title\(rem\)\}/,
    'a reminder is still rendered with rule.title(rem); it must go through titleOf(rem) so the stored heading wins'
  );

  const { RULES: engineRules } = await import('../lib/reminders.js');
  const { RULES: viewRules } = await import('../views/reports.js');
  const { RULE_KEY_TO_VIEW } = await import('../server.js');

  // Rule 2 is the specific regression: the engine names the NEXT attempt.
  const booked = engineRules.lead_followup_next.heading({
    client: 'bravo_buyer',
    detail: { attempt: '1st' },
  });
  assert.equal(booked, 'Send the 2nd follow-up to bravo_buyer');

  // And the view's own fallback title for that same row says something else —
  // which is precisely why the stored heading has to win.
  const viewKey = RULE_KEY_TO_VIEW.lead_followup_next;
  const fallback = viewRules[viewKey].title({ client: 'bravo_buyer', note: '1st follow-up logged' });
  assert.notEqual(
    fallback,
    booked,
    'the fallback now matches the booked heading; if the two tables were merged, this test can go'
  );
});

/**
 * 6. EVERY VIEW MODULE ACTUALLY LOADS.
 *
 * server.js imports views DYNAMICALLY, one per request:
 *
 *     mod = await import(new URL(`./views/${key}.js`, import.meta.url).href);
 *
 * which is right for boot time and means a broken view is invisible to
 * everything else. Nothing in this suite imported a view module: the checks
 * above read the files as TEXT to find the keys and links they mention, and
 * server.js imports cleanly whether or not any view parses. So a syntax error
 * in views/money.js — an unbalanced brace, a stray backtick inside an html``
 * template — left the whole suite green and turned exactly one route into a
 * 500 that only a human clicking it would find.
 *
 * That is not hypothetical either: it happened while this file was being
 * written. An HTML comment added inside an html`` template quoted a column name
 * in backticks, the backtick closed the template, and `npm test` reported
 * 94/94 passing over a module Node could not compile.
 *
 * Importing each view is the cheapest possible guard and it covers all of them.
 */
test('every view module imports and exports render()', async () => {
  const dir = path.join(ROOT, 'views');
  const views = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
    .sort();

  assert.ok(views.length >= 10, `expected the section views to be present, found ${views.length}`);

  for (const file of views) {
    let mod;
    try {
      mod = await import(new URL(`../views/${file}`, import.meta.url).href);
    } catch (err) {
      assert.fail(`views/${file} does not load: ${err.message}`);
    }
    // layout.js is the shared toolkit rather than a section, and errors.js
    // renders failures; neither is reached through the render(ctx) contract.
    if (file === 'layout.js' || file === 'errors.js') continue;
    assert.equal(
      typeof mod.render,
      'function',
      `views/${file} must export render(ctx) — server.js calls it for every request to that section`
    );
  }
});

// ============================================================================
// THE SHIFT LOGGER SEAM
// ============================================================================
//
// `/reports/ceo` stopped reading this hub's MySQL and started reading the CSR
// Shift Logger's Supabase, because that is where the team actually files. The
// adapter that makes one look like the other is `lib/external.js`, and every
// way it can be wrong renders as a normal-looking page:
//
//   a stage it cannot name          a reminder with no title and no buttons
//   a checklist label it cannot map every shift that ticked it reads "not done"
//   a failed read returned as []    eighty-nine shifts reported as none
//
// None of those throw. So they are pinned here instead.

test('the logger vocabulary maps onto the engine rule keys, both ways', async () => {
  const { RULE_KEY_TO_VIEW } = await import('../server.js');
  const { ACTION_TYPE_TO_RULE_KEY } = await import('../lib/external.js');

  // Every stage the hub knows must be reachable from what the logger stores.
  const missingFromAdapter = Object.entries(RULE_KEY_TO_VIEW)
    .filter(([ruleKey, actionType]) => ACTION_TYPE_TO_RULE_KEY[actionType] !== ruleKey)
    .map(([ruleKey, actionType]) => `${actionType} should map back to ${ruleKey}`);
  assert.deepEqual(
    missingFromAdapter,
    [],
    'ACTION_TYPE_TO_RULE_KEY is not the inverse of RULE_KEY_TO_VIEW: ' +
      `${missingFromAdapter.join('; ')}. A logger reminder of that stage renders on ` +
      '/reports/ceo with its raw key for a name and no rule behind it.'
  );

  // And nothing in the adapter may point at a stage the engine has dropped.
  const dangling = Object.entries(ACTION_TYPE_TO_RULE_KEY)
    .filter(([, ruleKey]) => !Object.prototype.hasOwnProperty.call(RULE_KEY_TO_VIEW, ruleKey))
    .map(([actionType, ruleKey]) => `${actionType} -> ${ruleKey}`);
  assert.deepEqual(
    dangling,
    [],
    `the adapter maps onto rule keys the engine no longer defines: ${dangling.join(', ')}`
  );
});

test('every wrap-up box the owner page prints can be found in a logger checklist', async () => {
  const { CHECKLIST_LABEL_TO_ID, checklistInHubVocabulary } = await import('../lib/external.js');
  const { CHECKLIST } = await import('../views/reports.js');

  const mapped = new Set(Object.values(CHECKLIST_LABEL_TO_ID));
  const unreachable = CHECKLIST.map((i) => i.id).filter((id) => !mapped.has(id));
  assert.deepEqual(
    unreachable,
    [],
    `the wrap-up table prints ${unreachable.join(', ')} but no logger label maps to it, so every ` +
      'shift that ticked that box renders as "not done" — a wrong figure, not a missing one'
  );

  // The logger keys by label and spells its own capitals; matching is on the
  // letters alone or "Briefs Created" silently stops being "Briefs created".
  const got = checklistInHubVocabulary({
    __shifts: ['Morning'],
    'Briefs Created': true,
    'Briefs Created — count': '5',
    'CRM updated': true,
    'ClickUp cleared': false,
  });
  assert.equal(got.briefs_created, 5, 'a typed count must beat the bare tick');
  assert.equal(got.crm_updated, true, 'a tick with no count stays true, which prints MISSING');
  assert.equal(got.clickup_cleared, false, 'an unticked box is the one honest zero on that panel');
  assert.ok(!('__shifts' in got), '__shifts is the handover audience, not a checklist item');
});

test('a shift report keeps its handover note and its audience through the adapter', async () => {
  const { shiftInHubVocabulary } = await import('../lib/external.js');

  const row = shiftInHubVocabulary({
    id: 'abc',
    csr_name: 'Amrah',
    shift: 'Morning',
    profile: 'X Studioz',
    start_at: '2026-08-05T04:10:00+00:00',
    finish_at: '2026-08-05T12:00:00+00:00',
    status: 'submitted',
    note_for_next: 'Buyer waiting on revised mark.',
    checklist: { __shifts: ['Evening', 'Night'], 'CRM updated': true },
  });

  assert.equal(row.started_at, '2026-08-05T04:10:00+00:00');
  assert.equal(row.closed_at, '2026-08-05T12:00:00+00:00');
  assert.equal(row.handoff_note, 'Buyer waiting on revised mark.');
  assert.deepEqual(row.note_shifts, ['Evening', 'Night']);
  assert.equal(row.checklist.crm_updated, true);
});

test('an unmapped logger stage keeps its name instead of vanishing', async () => {
  const { reminderInHubVocabulary } = await import('../lib/external.js');

  // The live store holds four of these: followup_designer, followup_client,
  // order_assigned, extension. They are real follow-ups somebody is waiting
  // on, so the honest rendering is a card that says it cannot be interpreted,
  // never a card that is not there.
  const row = reminderInHubVocabulary({
    id: 'r1',
    action_type: 'followup_designer',
    profile: 'X Studioz',
    client: 'someBuyer',
    status: 'pending',
    resolution: '',
    due_at: '2026-08-06T09:00:00+00:00',
  });
  assert.equal(row.rule_key, 'followup_designer');
  assert.equal(row.state, 'pending');
  assert.equal(row.alert, false);
});

test('a standing caution survives the trip from the logger', async () => {
  const { reminderInHubVocabulary } = await import('../lib/external.js');
  const { RULES } = await import('../lib/reminders.js');

  // `alert` is not a column in the logger. It is a property of the rule, so it
  // is derived on the way through; a reminder that lost it would drop out of
  // the standing-caution count and off the top of the page.
  const alertKeys = new Set(
    Object.entries(RULES).filter(([, def]) => def && def.alert).map(([k]) => k)
  );
  assert.ok(alertKeys.size >= 2, 'expected the frustrated and disputed stages to carry a caution');

  const row = reminderInHubVocabulary(
    { id: 'r2', action_type: 'disputed', profile: 'X Studioz', status: 'pending' },
    alertKeys
  );
  assert.equal(row.rule_key, 'disputed_alert');
  assert.equal(row.alert, true);
});

test('the owner page never says its numbers were typed here any more', () => {
  const src = viewSource('reports-ceo');
  // The stamp, not the prose. The constant's own comment explains what the
  // page used to claim, and a scan that could not tell those apart would make
  // the explanation unwritable.
  const stamps = src.match(/'Typed here'|`Typed here[^`]*`/g) || [];
  assert.deepEqual(
    stamps,
    [],
    'views/reports-ceo.js still stamps its panels "Typed here". Nothing on that page is typed ' +
      'here now. It is read from the CSR Shift Logger, and a panel claiming authorship of ' +
      "somebody else's data is how an argument about a number starts in the wrong place."
  );
  assert.ok(
    src.includes("const SOURCE = 'CSR Shift Logger'"),
    'the provenance stamp must name the store the figures come from'
  );
});
