#!/usr/bin/env node
// db/migrate.js — apply db/schema.sql, idempotently, and say what changed.
//
//   npm run migrate            apply
//   npm run migrate -- --dry   print the statements, touch nothing
//
// Idempotent because every statement in schema.sql is CREATE TABLE IF NOT
// EXISTS. That is also the trap this script exists to cover:
//
//   IF NOT EXISTS makes an ADDED COLUMN a silent no-op.
//
// Add a column to schema.sql, run this, and MySQL reports success while the
// table keeps its old shape. The page then reads a column that is not there,
// or writes one that is ignored. So after applying, this compares every
// column in the DDL against information_schema and prints the drift. It does
// not fix it: an ALTER against a live table is a decision a person makes, not
// something a migration runner does at 3am on its own initiative.
//
// It also refuses to run a destructive statement. This repo's whole premise
// is that it does not damage what already exists.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { raw, query, closePool, dbConfigured, missingEnv, dbTarget, DbError } from '../lib/db.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(HERE, 'schema.sql');

const DESTRUCTIVE = /^\s*(DROP|TRUNCATE|DELETE|RENAME|GRANT|REVOKE)\b/i;

// ------------------------------------------------------------- sql parsing

/**
 * Split a SQL file into statements. Hand-rolled rather than split(';')
 * because a `;` inside a string, a comment or a backticked identifier is not
 * a statement boundary, and the day it appears in schema.sql the naive split
 * corrupts two statements instead of failing loudly.
 */
export function splitStatements(sql) {
  const out = [];
  let buf = '';
  let i = 0;
  let quote = null; // ' " `
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (quote) {
      buf += ch;
      if (ch === '\\' && quote !== '`') {
        buf += next ?? '';
        i += 2;
        continue;
      }
      if (ch === quote) {
        if (next === quote) {
          buf += next; // doubled quote = escaped quote
          i += 2;
          continue;
        }
        quote = null;
      }
      i += 1;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      buf += ch;
      i += 1;
      continue;
    }
    if (ch === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (ch === ';') {
      if (buf.trim()) out.push(buf.trim());
      buf = '';
      i += 1;
      continue;
    }
    buf += ch;
    i += 1;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/** Table name from a CREATE TABLE statement, or null. */
export function tableOf(statement) {
  const m = /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?([A-Za-z0-9_$]+)`?/i.exec(statement);
  return m ? m[1] : null;
}

const NON_COLUMN = /^(PRIMARY|UNIQUE|KEY|INDEX|CONSTRAINT|FOREIGN|CHECK|FULLTEXT|SPATIAL)\b/i;

/** Column names declared in a CREATE TABLE body. */
export function columnsOf(statement) {
  const open = statement.indexOf('(');
  const close = statement.lastIndexOf(')');
  if (open === -1 || close <= open) return [];
  const body = statement.slice(open + 1, close);

  const parts = [];
  let depth = 0;
  let buf = '';
  let quote = null;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf);

  return parts
    .map((p) => p.trim())
    .filter((p) => p && !NON_COLUMN.test(p))
    .map((p) => {
      const m = /^`?([A-Za-z0-9_$]+)`?/.exec(p);
      return m ? m[1] : null;
    })
    .filter(Boolean);
}

// --------------------------------------------------------------- inspection

async function existingTables() {
  const rows = await query(
    'SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE()'
  );
  return new Set(rows.map((r) => String(r.t)));
}

async function existingColumns(table) {
  const rows = await query(
    'SELECT column_name AS c FROM information_schema.columns ' +
      'WHERE table_schema = DATABASE() AND table_name = ?',
    [table]
  );
  return new Set(rows.map((r) => String(r.c)));
}

// -------------------------------------------------------------------- main

export async function migrate({ dryRun = false, log = console.log } = {}) {
  if (!fs.existsSync(SCHEMA_PATH)) throw new Error(`schema not found at ${SCHEMA_PATH}`);
  const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  const statements = splitStatements(sql);

  const destructive = statements.filter((s) => DESTRUCTIVE.test(s));
  if (destructive.length) {
    // Refuse the whole file, not just the statement. A schema file that has
    // grown a DROP needs a person to look at it.
    throw new Error(
      `schema.sql contains ${destructive.length} destructive statement(s) — refusing to run.\n` +
        destructive.map((s) => `  ${s.split('\n')[0].slice(0, 90)}`).join('\n')
    );
  }

  if (dryRun) {
    log(`[migrate] dry run — ${statements.length} statement(s), nothing executed:`);
    for (const s of statements) log(`  · ${s.split('\n')[0].slice(0, 90)}${s.includes('\n') ? ' …' : ''}`);
    return { created: [], existing: [], drift: [], statements: statements.length, dryRun: true };
  }

  const target = dbTarget();
  log(`[migrate] ${target.host}:${target.port}/${target.database}`);

  const before = await existingTables();

  let applied = 0;
  for (const statement of statements) {
    try {
      await raw(statement);
      applied += 1;
    } catch (err) {
      const head = statement.split('\n')[0].slice(0, 90);
      throw new Error(`statement failed: ${head}\n  ${err.message}`);
    }
  }

  const after = await existingTables();
  const created = [...after].filter((t) => !before.has(t)).sort();
  const existing = [...after].filter((t) => before.has(t)).sort();

  // ------------------------------------------------------------- fixups
  //
  // Named, one-off corrections to a table that already exists. This runner
  // refuses ALTERs as a rule and that rule is right: an ALTER against live
  // data is a decision a person makes. These are the narrow exception, and
  // each one has to satisfy all three of:
  //
  //   1. it cannot lose data
  //   2. it is guarded, so running it twice is a no-op
  //   3. leaving it undone breaks writes, so "tell the operator" is not a fix
  //
  // The alternative here was asking Ezan to run SQL in phpMyAdmin, and an
  // instruction nobody can follow is not a migration strategy.
  const fixups = [];

  // `msg_ratio DECIMAL(5,2)` was labelled "message response ratio, percent as
  // Fiverr states it". It is not a ratio: it is how many inquiries arrived
  // that day. Stored as a percent, 4 inquiries would have read as 4%. CHANGE
  // rather than add-and-drop, so any value already typed moves with it.
  if (after.has('daily_entry')) {
    const cols = await existingColumns('daily_entry');
    const lower = new Set([...cols].map((c) => c.toLowerCase()));
    if (lower.has('msg_ratio') && !lower.has('inquiries_received')) {
      await raw('ALTER TABLE daily_entry CHANGE COLUMN msg_ratio inquiries_received INT NULL');
      fixups.push('daily_entry.msg_ratio renamed to inquiries_received (INT)');
    }
  }

  for (const f of fixups) log(`[migrate] fixup: ${f}`);

  // Drift check. The part IF NOT EXISTS cannot do for you.
  const drift = [];
  for (const statement of statements) {
    const table = tableOf(statement);
    if (!table || created.includes(table)) continue;
    const declared = columnsOf(statement);
    if (!declared.length) continue;
    const present = await existingColumns(table);
    const lower = new Set([...present].map((c) => c.toLowerCase()));
    const missing = declared.filter((c) => !lower.has(c.toLowerCase()));
    if (missing.length) drift.push({ table, missing });
  }

  log(`[migrate] ${applied} statement(s) applied`);
  if (created.length) {
    log(`[migrate] created ${created.length} table(s):`);
    for (const t of created) log(`             + ${t}`);
  } else {
    log('[migrate] created 0 tables — everything was already there');
  }
  if (existing.length) log(`[migrate] already present: ${existing.join(', ')}`);

  if (drift.length) {
    log('');
    log('[migrate] SCHEMA DRIFT — these columns are in schema.sql but not in the database.');
    log('          CREATE TABLE IF NOT EXISTS skipped them silently. Add them with an');
    log('          explicit ALTER TABLE once you have decided what happens to existing rows:');
    for (const d of drift) {
      for (const c of d.missing) log(`             ! ${d.table}.${c}`);
    }
  }

  return { created, existing, drift, statements: applied, dryRun: false };
}

// ------------------------------------------------------------------- cli

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (invokedDirectly) {
  const dryRun = process.argv.includes('--dry') || process.argv.includes('--dry-run');
  if (!dryRun && !dbConfigured()) {
    console.error(
      `[migrate] not configured — missing ${missingEnv().join(', ')}. ` +
        'Copy .env.example to .env and fill it in (placeholders only in the example file).'
    );
    process.exit(2);
  }
  try {
    const result = await migrate({ dryRun });
    await closePool();
    process.exit(result.drift.length ? 3 : 0); // 3 = applied, but drift needs a human
  } catch (err) {
    await closePool();
    if (err instanceof DbError && err.unavailable) {
      console.error(`[migrate] database unreachable (${err.code}): ${err.message}`);
      console.error('[migrate] nothing was changed.');
      process.exit(2);
    }
    console.error(`[migrate] failed: ${err.message}`);
    process.exit(1);
  }
}
