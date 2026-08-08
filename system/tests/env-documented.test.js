// tests/env-documented.test.js, the deploy runbook cannot fall behind the code.
//
// WHY THIS FILE EXISTS
//
// On 2026-08-08 both external stores were unreachable on /feeds. Neither
// Supabase project was down: both answered in half a second, and the reports
// anon key was valid until 2036. The hub simply had no keys, because
// README.md's "Environment variables" block, the list a person actually works
// from when provisioning the Hostinger panel, named seven variables and the
// code read nine. .env.example named all nine. The two files disagreed and the
// runbook won, so REPORTS_SUPABASE_KEY and IMPRESSIONS_SUPABASE_KEY were never
// set.
//
// That failure is invisible from every angle you would normally check. A
// missing key throws inside select() before any request leaves the process, so
// there is no failed request to find, no 401 in a log, and no unhealthy
// service to point at. And because one omission covered both keys, two
// independent projects went dark in the same instant, which reads like an
// outage and is not one.
//
// So the code is the source of truth here, and both documents have to keep up
// with it. Adding a process.env read now fails this test until it is written
// down in both places.
//
// WHAT IS ALLOWED THROUGH
//
// PLATFORM below are set by the runtime rather than by a person, so a runbook
// entry for them would be noise. TUNING have working defaults in code and the
// hub is correct without them; they are optional by design and documented in
// .env.example only. Everything else is required: without it the hub either
// does not start or silently serves a degraded page, which is the case this
// test exists to prevent.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Set by the host, never typed into a panel. */
const PLATFORM = new Set(['NODE_ENV', 'PORT', 'TZ']);

/** Have real defaults in code. Optional, so .env.example only. */
const TUNING = new Set([
  'COOKIE_SECURE',
  'DB_BREAKER_MS',
  'DB_CONNECT_TIMEOUT_MS',
  'DB_POOL_SIZE',
  'REPORTS_SUPABASE_URL',
  'IMPRESSIONS_SUPABASE_URL',
  'XSTUDIOZ_DATA_DIR',
]);

const SOURCE_DIRS = ['lib', 'views', 'db'];

function sourceFiles() {
  const out = [path.join(ROOT, 'server.js')];
  for (const dir of SOURCE_DIRS) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs)) {
      if (name.endsWith('.js')) out.push(path.join(abs, name));
    }
  }
  return out;
}

/** Every process.env.X the hub actually reads. */
function varsReadInSource() {
  const found = new Set();
  for (const file of sourceFiles()) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)) found.add(m[1]);
  }
  return found;
}

test('every environment variable the hub reads is documented in .env.example', () => {
  const example = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  const undocumented = [...varsReadInSource()]
    .filter((v) => !PLATFORM.has(v))
    .filter((v) => !example.includes(v))
    .sort();

  assert.deepEqual(
    undocumented,
    [],
    `read by the hub but absent from system/.env.example: ${undocumented.join(', ')}. ` +
      'Add the name with an empty value, never a real one.'
  );
});

test('every required environment variable is named in the deploy runbook', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

  // The runbook block itself, not the whole file: a variable mentioned in
  // passing elsewhere in the prose is not an instruction to set it, and the
  // whole failure this test guards against was a person working from this
  // block alone.
  const heading = readme.indexOf('## Deploying');
  assert.ok(heading !== -1, 'system/README.md has no "## Deploying" section');
  const next = readme.indexOf('\n## ', heading + 1);
  const runbook = readme.slice(heading, next === -1 ? readme.length : next);

  const missing = [...varsReadInSource()]
    .filter((v) => !PLATFORM.has(v) && !TUNING.has(v))
    .filter((v) => !runbook.includes(v))
    .sort();

  assert.deepEqual(
    missing,
    [],
    `required, but not named in README.md's Deploying section: ${missing.join(', ')}. ` +
      'Somebody provisioning the panel from that block would not set these, ' +
      'and the hub would serve a degraded page without failing.'
  );
});

test('the two Supabase keys are named in the runbook by their exact variable names', () => {
  // Belt and braces on the specific pair that broke. The generic test above
  // derives its list from source, so a refactor that stopped reading a key
  // through process.env would take it out of that list and quietly retire the
  // check along with the bug it protects against.
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  for (const name of ['REPORTS_SUPABASE_KEY', 'IMPRESSIONS_SUPABASE_KEY']) {
    assert.ok(
      readme.includes(name),
      `${name} is not in system/README.md. Leaving it out took /feeds down once.`
    );
  }
});

test('.env.example still carries no real values', () => {
  // The file exists to document names. A value in it is a committed
  // credential, and this repo has shipped one before.
  const example = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  const offenders = [];
  for (const line of example.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const value = trimmed.slice(eq + 1).trim();
    // localhost and default ports are not credentials.
    if (value && !['localhost', '3306', '3000', 'production'].includes(value)) {
      offenders.push(trimmed.slice(0, eq));
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `system/.env.example carries values for: ${offenders.join(', ')}. Placeholders only.`
  );
});
