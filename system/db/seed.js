#!/usr/bin/env node
// db/seed.js — the people, and the reply library. Safe to run repeatedly.
//
//   npm run seed                  insert what is missing, touch nothing else
//   npm run seed -- --refresh-responses
//                                 also refresh imported reply text (never a
//                                 response someone wrote in the hub)
//
// Seeding is INSERT IGNORE against the UNIQUE keys, so a second run inserts
// nothing and overwrites nothing. Roles get edited by hand later; a seed that
// re-asserted them would quietly undo that on every deploy.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, run, closePool, dbConfigured, missingEnv, DbError } from '../lib/db.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESPONSES_PATH = path.join(HERE, '..', 'data', 'responses.json');
//: The owner's real quick-replies, exported from the XStudioz Resources sheet.
//: Loaded alongside the talk projection; the two are different KINDS and the
//: page keeps them apart.
const QUICK_PATH = path.join(HERE, '..', 'data', 'quick-responses.json');

// ------------------------------------------------------------------ people
//
// THE NAME DISCREPANCY — read before editing this list.
//
// Two sources name the team and they do not agree, which is the same class of
// problem as the 25 buyers marked "Not Placed" who had ordered: two systems,
// each holding part of the truth, neither aware of the other.
//
//   In the team-review sheet:      Ezan, Amrah, Zaheen, Hasnain, Nadir
//   Handling work in the data:     Iqra, Hasnain, Salman, Zubair, Swaid,
//                                  Tanzeel, Fatima, Shahzaib, Ezan, Nadir,
//                                  Amrah, Tayyab
//
// Specifically, counting `csr` across data/orders.jsonl and data/leads.jsonl:
//
//   Iqra      612 orders, 18 inquiries  — reviewed by nobody
//   Salman     55 orders,  1 inquiry    — reviewed by nobody
//   Shahzaib   14 orders,  1 inquiry    — reviewed by nobody
//   Zaheen      0 orders,  0 inquiries  — reviewed weekly
//
// Iqra alone handled more orders than everyone in the review sheet combined
// and has never appeared in a weekly score. Zaheen is scored every week and
// touches nothing the engine can see. Both facts are reported, neither is
// resolved here: whether Zaheen works off-platform, or is spelled differently
// in the sheets, or has left, is a question for Ezan — not something a seed
// script should decide by omitting a row.
//
// SEEDED ACTIVE: the five reviewed names below.
// SEEDED INACTIVE: Iqra, Salman, Shahzaib, in FORMER further down, because
// 681 orders are attributed to them and the past has to stay explainable.
// NOT SEEDED AT ALL: Zubair, Swaid, Tanzeel, Fatima, Tayyab. They appear in
// the order book but in neither the review sheet nor the brief, so they may
// be former staff or another team. Add them by hand once someone confirms;
// do not invent team members from a column.
//
// SPELLING: the brief writes "ShahZaib", the engine's data writes "Shahzaib".
// The engine's spelling wins here, because `person` and `entered_by` have to
// line up with what the engine emits. (MySQL's default collation is
// case-insensitive, so this is one row either way — but only the matching
// spelling reads correctly on screen.) The engine's normalise_profile is the
// authority on names; the hub never invents a second mapping.
export const TEAM = [
  { name: 'Ezan', role: 'owner' }, // owns money-at-rest and every recovery task
  { name: 'Amrah', role: 'csr' },
  { name: 'Zaheen', role: 'csr' },
  { name: 'Hasnain', role: 'csr' },
  { name: 'Nadir', role: 'csr' },
];

// Names that appear in the engine's historical data but are NOT the current
// team. They are deactivated, never deleted, and the difference matters:
//
//   Iqra      handled 612 orders
//   Salman     55
//   Shahzaib   14
//
// Deleting them would orphan 681 orders' worth of attribution and make every
// historical conversion figure unexplainable. "Who handled this?" would answer
// "nobody", which is a lie about the past. Deactivating removes them from the
// device-claim picker and the review programme while leaving every row that
// names them intact and readable.
//
// THEY ARE INSERTED, THEN DEACTIVATED, and the insert half was missing.
//
// This list only ever ran an UPDATE, and nothing ever created the rows for it
// to update, so all three matched nothing on every run since the file was
// written. The Team page draws exactly this distinction: "Retired here" for a
// name in app_user with active = 0, "Not known here" for one that was never
// added. With no rows, Iqra sat under "Not known here" beside Zubair and
// Tayyab, and 585 orders looked like they had been handled by a stranger.
//
// The insert is guarded and cannot promote anybody: `active = 0` is set on
// insert and the UPDATE below only touches a row that is still active, so a
// name Ezan reactivates by hand stays active through every later run.
export const FORMER = ['Iqra', 'Salman', 'Shahzaib'];

async function seedUsers(log) {
  // WHO IS ALREADY HERE, ASKED BEFORE ANYTHING IS WRITTEN.
  //
  // This used to read affectedRows and call 1 an insert, on the documented
  // MySQL rule that an ON DUPLICATE KEY UPDATE changing nothing returns 0.
  // The server this actually runs on returns 1 for that case, so a row that
  // was already there and already correct counted as a fresh insert, and both
  // `npm run seed` and every boot announced "added 5 user(s)" forever. The
  // count was never once right after the first run.
  //
  // That is worse than a cosmetic wrong number. This line is how anyone would
  // notice a name genuinely appearing, and a message that says five every
  // morning cannot carry that signal. So the question is asked in SQL that
  // means one thing on every server, before the write rather than after it.
  const before = new Set((await query('SELECT name FROM app_user')).map((r) => String(r.name)));

  const inserted = [];
  const skipped = [];
  for (const person of TEAM) {
    await run(
      'INSERT INTO app_user (name, role, active) VALUES (?, ?, 1) ' +
        'ON DUPLICATE KEY UPDATE role = VALUES(role), active = 1',
      [person.name, person.role]
    );
    (before.has(person.name) ? skipped : inserted).push(person.name);
  }
  log(
    `[seed] app_user: ${inserted.length} inserted${inserted.length ? ` (${inserted.join(', ')})` : ''}` +
      `, ${skipped.length} already present`
  );

  // The former team: create the row if it is missing, then make sure it is
  // inactive. INSERT IGNORE, never a plain INSERT, so a name Ezan has already
  // added by hand keeps whatever role he gave it.
  const recorded = [];
  for (const name of FORMER) {
    await run("INSERT IGNORE INTO app_user (name, role, active) VALUES (?, 'csr', 0)", [name]);
    if (!before.has(name)) recorded.push(name);
  }
  if (recorded.length) {
    log(`[seed] app_user: ${recorded.length} former member(s) recorded as retired (${recorded.join(', ')})`);
  }

  // Retire anyone on that list who is still marked active. UPDATE, never
  // DELETE, see FORMER above.
  let retired = 0;
  for (const name of FORMER) {
    const result = await run('UPDATE app_user SET active = 0 WHERE name = ? AND active = 1', [name]);
    if (result.affectedRows) retired += 1;
  }
  if (retired) log(`[seed] app_user: ${retired} former member(s) deactivated (${FORMER.join(', ')})`);

  // Report anyone else in the table rather than removing them. A colleague
  // added by hand is data, and a seed script does not delete people.
  const rows = await query('SELECT name FROM app_user');
  const known = new Set([...TEAM.map((t) => t.name), ...FORMER]);
  const extra = rows.map((r) => r.name).filter((n) => !known.has(n));
  if (extra.length) log(`[seed] app_user: ${extra.length} name(s) added outside this seed: ${extra.join(', ')}`);

  return { inserted, skipped, retired, extra };
}

// --------------------------------------------------------------- responses

/** Accepts either a list of objects or a {name: body} map. */
export function normaliseResponses(parsed) {
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.responses)
      ? parsed.responses
      : Object.entries(parsed || {}).map(([name, body]) =>
          typeof body === 'string' ? { name, body } : { name, ...body }
        );

  const usable = [];
  const rejected = [];
  for (const item of list) {
    const name = String(item?.name ?? item?.title ?? '').trim();
    const body = String(item?.body ?? item?.text ?? item?.message ?? '').trim();
    if (!name || !body) {
      // No placeholder rows, no empty bodies. A reply library with invented
      // entries is worse than a short one.
      rejected.push(item?.name ?? '(unnamed)');
      continue;
    }
    const source = ['fiverr', 'extra', 'hub'].includes(item?.source) ? item.source : 'fiverr';
    usable.push({
      name: name.slice(0, 120),
      body,
      when_to_use: item?.when_to_use ?? item?.when ?? null,
      category: item?.category ? String(item.category).slice(0, 60) : null,
      source,
      kind: ['quick', 'case'].includes(item?.kind) ? item.kind : 'quick',
    });
  }
  return { usable, rejected };
}

async function seedResponses(log, { refresh = false } = {}) {
  // Both libraries, in one pass. The sheet's quick replies go first so that if
  // a name ever collides, the owner's real template wins the unique key and the
  // derived line is the one skipped.
  const sources = [QUICK_PATH, RESPONSES_PATH].filter((f) => fs.existsSync(f));
  if (!sources.length) {
    log(`[seed] response: skipped, no ${path.relative(process.cwd(), RESPONSES_PATH)}`);
    return { skipped: true };
  }

  const usable = [];
  const rejected = [];
  for (const file of sources) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      // One unreadable file must not silently drop the other. Say which.
      log(`[seed] response: SKIPPED ${path.basename(file)}, not valid JSON (${err.message})`);
      continue;
    }
    const part = normaliseResponses(parsed);
    usable.push(...part.usable);
    rejected.push(...part.rejected);
  }
  let inserted = 0;
  let refreshed = 0;

  for (const r of usable) {
    const result = await run(
      'INSERT IGNORE INTO response (name, body, when_to_use, category, source, kind) VALUES (?, ?, ?, ?, ?, ?)',
      [r.name, r.body, r.when_to_use, r.category, r.source, r.kind]
    );
    if (result.affectedRows) {
      inserted += 1;
    } else if (refresh) {
      // Only ever refresh imported text. `source='hub'` is something a person
      // typed into this app, and an import must not overwrite it.
      const updated = await run(
        "UPDATE response SET body = ?, when_to_use = ?, category = ? WHERE name = ? AND source <> 'hub'",
        [r.body, r.when_to_use, r.category, r.name]
      );
      refreshed += updated.affectedRows ? 1 : 0;
    }
  }

  log(
    `[seed] response: ${inserted} inserted, ${usable.length - inserted} already present` +
      (refresh ? `, ${refreshed} refreshed` : '')
  );
  if (rejected.length) {
    log(`[seed] response: ${rejected.length} entry(ies) skipped for a missing name or empty body`);
  }
  return { inserted, refreshed, rejected: rejected.length, total: usable.length };
}

// -------------------------------------------------------------------- main

export async function seed({ refreshResponses = false, log = console.log } = {}) {
  const users = await seedUsers(log);
  const responses = await seedResponses(log, { refresh: refreshResponses });
  await run('INSERT INTO audit (who, action, detail) VALUES (?, ?, ?)', [
    null,
    'seed',
    JSON.stringify({ users: users.inserted.length, responses: responses.inserted ?? 0 }),
  ]);
  return { users, responses };
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (invokedDirectly) {
  if (!dbConfigured()) {
    console.error(`[seed] not configured, missing ${missingEnv().join(', ')}.`);
    process.exit(2);
  }
  try {
    await seed({ refreshResponses: process.argv.includes('--refresh-responses') });
    await closePool();
    process.exit(0);
  } catch (err) {
    await closePool();
    if (err instanceof DbError && err.unavailable) {
      console.error(`[seed] database unreachable (${err.code}): ${err.message}`);
      console.error('[seed] nothing was written. Run db/migrate.js first if the tables do not exist.');
      process.exit(2);
    }
    console.error(`[seed] failed: ${err.message}`);
    process.exit(1);
  }
}
