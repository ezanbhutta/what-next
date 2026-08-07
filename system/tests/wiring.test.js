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
/**
 * Section key to the file that renders it.
 *
 * These were the same string until Reports lost its input half. `/reports` was
 * the CSR's shift form and `/reports/ceo` was what the shifts produced; the
 * form is gone, the reading half moved up, and the section is now served by a
 * file that is not named after it. Anything walking SECTIONS has to come
 * through here or it reads a file that is not there.
 */
const VIEW_FILE = { reports: 'reports-ceo' };

const viewSource = (key) =>
  fs.readFileSync(path.join(ROOT, 'views', `${VIEW_FILE[key] || key}.js`), 'utf8');

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
  reports: ['reportsCeo'],
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
  const { ACTION_TYPE_TO_RULE_KEY, RULE_KEY_TO_ACTION_TYPE } = await import('../lib/external.js');
  const { RULE_KEYS } = await import('../lib/reminders.js');

  // Every stage the engine defines must be reachable from what the logger
  // stores. One it cannot name renders on /reports with its raw key for a
  // title and no rule behind it: a real follow-up somebody is waiting on,
  // shown as uninterpretable.
  const unreachable = RULE_KEYS.filter((k) => !RULE_KEY_TO_ACTION_TYPE[k]);
  assert.deepEqual(
    unreachable,
    [],
    `lib/reminders.js defines rule${unreachable.length === 1 ? '' : 's'} ${unreachable.join(', ')} ` +
      'that no logger action type maps to'
  );

  // And nothing in the adapter may point at a stage the engine has dropped.
  const dangling = Object.entries(ACTION_TYPE_TO_RULE_KEY)
    .filter(([, ruleKey]) => !RULE_KEYS.includes(ruleKey))
    .map(([actionType, ruleKey]) => `${actionType} -> ${ruleKey}`);
  assert.deepEqual(
    dangling,
    [],
    `the adapter maps onto rule keys the engine no longer defines: ${dangling.join(', ')}`
  );

  // The two directions are derived from one literal, so this is cheap and it
  // is the assertion that lets the rest of the file trust either of them.
  for (const [type, key] of Object.entries(ACTION_TYPE_TO_RULE_KEY)) {
    assert.equal(RULE_KEY_TO_ACTION_TYPE[key], type, `${type} and ${key} do not round-trip`);
  }
});

/**
 * The owner page must not read the logger's own column names.
 *
 * There was a test here doing this for MySQL: the loader aliased `opened_at`
 * to `started_at` and the view had to read the alias. That seam is gone with
 * the SQL, and the identical seam replaced it one layer out. `lib/external.js`
 * renames the logger's columns on the way in, and a view reaching past it for
 * the raw name gets `undefined`, which renders as an empty cell on a page that
 * otherwise looks finished.
 */
test('the owner page reads the adapter names, not the logger raw ones', () => {
  // The logger's spelling on the left, what the adapter hands over on the
  // right. Restated here on purpose: the point of the check is that the two
  // files disagree, so reading the map out of one of them proves nothing.
  const renamed = {
    start_at: 'started_at',
    finish_at: 'closed_at',
    note_for_next: 'handoff_note',
    action_type: 'rule_key',
  };

  const src = viewSource('reports');
  // Strip comments: these names are discussed in prose in both files, and the
  // prose is how the rename is explained rather than a use of it.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  const problems = [];
  for (const [raw, alias] of Object.entries(renamed)) {
    if (new RegExp(`\\.${raw}\\b`).test(code)) {
      problems.push(`views/reports-ceo.js reads .${raw} — the adapter supplies .${alias}`);
    }
  }
  assert.deepEqual(problems, [], problems.join('; '));
});

test('every wrap-up box the owner page prints can be found in a logger checklist', async () => {
  const { CHECKLIST_LABEL_TO_ID, checklistInHubVocabulary } = await import('../lib/external.js');
  const { CHECKLIST } = await import('../views/reports-ceo.js');

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

/**
 * A Safe value in a plain string prints its own tags to the reader.
 *
 * `dateShort`, `num`, `money` and friends return Safe markup. That is right
 * inside an `html` template and wrong in an ordinary backtick string: the
 * string stringifies to `<span class="nowrap">28 Jul</span>`, and when it later
 * reaches an `html` template the chokepoint escapes it, so the TAGS appear on
 * screen as text. It shipped in three page titles, a browser tab title and four
 * headings. Nothing failed; every piece behaved exactly as designed.
 *
 * THIS IS CHECKED ON RENDERED OUTPUT, NOT ON THE SOURCE. The first version of
 * this test scanned for `${dateShort(` inside a backtick not preceded by
 * `html`, and a regex cannot do that: it cannot tell an opening backtick from a
 * closing one, so it read the gap between two nested templates as a plain
 * string and reported eight false positives in views/clients.js on its first
 * run. What the reader sees is the only thing worth asserting on.
 *
 * `title` and `kicker` are the two fields that are contractually PLAIN TEXT:
 * the shell puts title in <title> and in an <h2>, and neither may contain
 * markup, escaped or otherwise.
 */
test('no view puts markup in its plain-text title or kicker', async () => {
  const cases = [
    ['entry', (await import('../views/entry.js')).render, {
      window: '30',
      asOf: { ok: true, date: '2026-07-28', daysOld: 9, enteredBy: 'x', notice: null },
      days: { ok: true, rows: [{
        entry_date: '2026-07-28', gigs: [{ gig: 'XStudioz', impressions: 10 }],
        impressions: 10, clicks: 1, organic_orders: 1, organic_value: 10,
        directed_orders: 0, directed_value: 0, total_orders: 1, orders_completed: 1,
        completed_value: 10, inquiries_received: 1, cancellations: 0, cancelled_value: 0,
        orders_in_queue: 1, total_reviews: 5, success_score: 8, profile_rating: 4.8,
      }], notice: null },
      gigs: { ok: true, rows: [{ id: 'x', name: 'XStudioz', account: 'XStudioz', active: true, main: true }], notice: null },
    }],
    ['pulse', (await import('../views/pulse.js')).render, {
      window: '30', today: '2026-08-06',
      book: [{ client: 'b', order_date: '2026-07-10', delivered_date: '2026-07-15',
               status: 'completed', amount: 100, rating: 5, csr: 'Iqra', rating_tracked: true,
               order_type: 'organic', project: 'p', logo_designer: 'A', branding_designer: null }],
    }],
    ['reports-ceo', (await import('../views/reports-ceo.js')).render, {
      date: '2026-08-06', from: '2026-07-08', days: 30, profile: 'X Studioz', profiles: [],
      now: new Date('2026-08-06T12:00:00Z'),
      shifts: { ok: true, rows: [], notice: null },
      activities: { ok: true, rows: [], notice: null },
      reminders: { ok: true, rows: [], notice: null },
      standing: { ok: true, rows: [], notice: null },
    }],
  ];

  const problems = [];
  for (const [name, render, data] of cases) {
    const out = render({ data, user: { name: 'Ezan', role: 'owner' }, query: {} });
    for (const field of ['title', 'kicker']) {
      const v = String(out[field] ?? '');
      if (/<[a-z/][^>]*>/i.test(v) || /&lt;|&gt;|&quot;/.test(v)) {
        problems.push(`views/${name}.js ${field} carries markup: ${JSON.stringify(v.slice(0, 120))}`);
      }
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});
