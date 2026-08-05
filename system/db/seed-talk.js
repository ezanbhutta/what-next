#!/usr/bin/env node
// db/seed-talk.js: load the owner's Client Talk Hub into the `talk` table.
//
//   npm run seed:talk              insert what is missing, touch nothing else
//   npm run seed:talk -- --refresh also refresh cards that came from the file
//                                  (never a card somebody wrote in the hub)
//   npm run seed:talk -- --dry     parse and report, write nothing
//
// IDEMPOTENT, AND HERE IS THE PART THAT MAKES IT SO.
//
// Every card the file produces carries a `slug` derived from its group and its
// title, and the insert is INSERT IGNORE against the unique key on that slug.
// A second run inserts nothing and overwrites nothing. Cards typed into the hub
// have slug NULL, and MySQL's unique index ignores NULLs, so they are invisible
// to this script and cannot be clobbered by it.
//
// The slug is taken from the title as it was on the day of the import, not from
// the title as it stands now. Keying on the live title would mean that the
// first time Ezan rewords a card, the next seed run sees a card it has never
// inserted and puts the old wording back underneath his edit, silently, and
// looking exactly like a successful run.
//
// WHY THIS PARSES JAVASCRIPT RATHER THAN JSON.
//
// The source is the owner's working page, db/client-talk-hub.html. It is his
// file, in his format, and he keeps editing it. Asking him to maintain a
// parallel JSON copy would create the one thing this repo exists to referee:
// two copies of the same content, disagreeing quietly. So this reads his file.
//
// The two array literals are pulled out by name and evaluated in a fresh V8
// context with no globals at all, no require, no process, no fetch, no timers,
// and a hard timeout. That is a smaller risk than hand-rolling a parser for
// unquoted keys, single quotes, smart quotes and apostrophes inside strings,
// which is a parser that would be subtly wrong about exactly one card and
// nobody would notice which.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { query, run, closePool, dbConfigured, missingEnv, DbError } from '../lib/db.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SOURCE_PATH = path.join(HERE, 'client-talk-hub.html');

// The stages an order actually passes through, in order. `all` means the card
// belongs at every stage, which is different from belonging at none.
export const STAGES = ['inquiry', 'kickoff', 'working', 'approved', 'delivered'];
export const STAGE_VALUES = ['all', ...STAGES];
export const KINDS = ['ask', 'stop', 'care'];

// ============================================================================
// PARSING
// ============================================================================

/**
 * Pull `const NAME=[...]` out of the page and evaluate it.
 *
 * The closing bracket is found by counting brackets outside of strings rather
 * than by matching `];`, because a `]` inside a quoted line is not the end of
 * the array and one of the owner's lines could carry one tomorrow.
 */
export function extractArray(source, name) {
  const start = new RegExp(`\\bconst\\s+${name}\\s*=\\s*\\[`).exec(source);
  if (!start) throw new Error(`${name} is not in the file. Has the page been rewritten?`);

  const open = start.index + start[0].length - 1;
  let depth = 0;
  let quote = null;
  let end = -1;

  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      i = source.indexOf('*/', i + 2) + 1;
      continue;
    }
    if (ch === '[' || ch === '{') depth += 1;
    if (ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) throw new Error(`${name} is not closed. The file is truncated or malformed`);

  const literal = source.slice(open, end + 1);
  // A bare context: no require, no process, no globalThis of ours. The literal
  // is data, and this is the only thing it is allowed to be.
  const value = vm.runInNewContext(`(${literal})`, Object.create(null), {
    timeout: 2000,
    displayErrors: true,
  });
  if (!Array.isArray(value)) throw new Error(`${name} did not evaluate to an array`);
  return value;
}

/** `ask` + "Where is this logo going to be used first?" -> a stable key. */
export function slugFor(group, title) {
  const body = String(title)
    .toLowerCase()
    .replace(/[‘’“”]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${group}-${body}`.slice(0, 80);
}

/**
 * The file's shape into the table's shape.
 *
 * Anything that cannot be stored as a usable card is REJECTED by name rather
 * than inserted half-empty. A card with a title and no line to send is worse
 * than a missing card: it looks like guidance and answers nothing.
 */
export function normaliseTalk(data, groups) {
  const headings = new Map((groups || []).map((g) => [String(g.id), String(g.label)]));
  const order = new Map((groups || []).map((g, i) => [String(g.id), i]));

  const usable = [];
  const rejected = [];
  const perGroup = new Map();

  for (const card of data || []) {
    const group = String(card?.g ?? '').trim();
    const title = String(card?.title ?? '').trim();
    const heading = headings.get(group) || null;

    const turns = [];
    for (const t of card?.turns || []) {
      const h = String(t?.h ?? '').trim();
      const s = String(t?.s ?? '').trim();
      if (!h || !s) continue;
      turns.push({
        h,
        s,
        u: t?.u ? String(t.u).trim() : null,
        w: t?.w ? String(t.w).trim() : null,
      });
    }

    if (!group || !heading || !title || !turns.length) {
      rejected.push({
        title: title || '(untitled)',
        why: !group
          ? 'no group'
          : !heading
            ? `group "${group}" is not in GROUPS`
            : !title
              ? 'no title'
              : 'no turn with both a client line and a reply',
      });
      continue;
    }

    // `src:true` and a chip reading "Fiverr official" are the same claim said
    // twice in the source. One provenance chip, deduped case-insensitively.
    const chips = [];
    const seen = new Set();
    for (const c of [...(card.src ? ['Fiverr official'] : []), ...(card.chips || [])]) {
      const label = String(c).trim();
      const key = label.toLowerCase();
      if (!label || seen.has(key)) continue;
      seen.add(key);
      chips.push(label.slice(0, 40));
    }

    const stage = [...new Set((card.stage || []).map((s) => String(s).trim()))].filter((s) =>
      STAGE_VALUES.includes(s)
    );

    const n = (perGroup.get(group) || 0) + 1;
    perGroup.set(group, n);

    usable.push({
      slug: slugFor(group, title),
      heading: heading.slice(0, 80),
      group: group.slice(0, 24),
      kind: KINDS.includes(String(card.kind)) ? String(card.kind) : 'ask',
      // A card with no readable stage is offered at every stage rather than
      // hidden at all of them. Silently filtering it out of every tab is how a
      // line nobody can find becomes a line nobody sends.
      stage: stage.length ? stage : ['all'],
      chips,
      title: title.slice(0, 200),
      sub: card?.sub ? String(card.sub).trim() : null,
      turns,
      // Group order first, then position within the group, spaced so a card can
      // be dropped between two others later without renumbering the file.
      sort: (order.get(group) ?? 90) * 1000 + n * 10,
    });
  }

  // Two cards with the same title in the same group would collapse onto one
  // slug and the second would silently never be inserted. Report it instead.
  const bySlug = new Map();
  const collisions = [];
  for (const card of usable) {
    if (bySlug.has(card.slug)) collisions.push(card.title);
    else bySlug.set(card.slug, card);
  }

  return { usable: [...bySlug.values()], rejected, collisions };
}

export function readPlaybook(file = SOURCE_PATH) {
  const source = fs.readFileSync(file, 'utf8');
  return normaliseTalk(extractArray(source, 'DATA'), extractArray(source, 'GROUPS'));
}

// ============================================================================
// SEEDING
// ============================================================================

export async function seedTalk({ refresh = false, dryRun = false, log = console.log } = {}) {
  if (!fs.existsSync(SOURCE_PATH)) {
    log(`[seed-talk] skipped, no ${path.relative(process.cwd(), SOURCE_PATH)}`);
    return { skipped: true };
  }

  const { usable, rejected, collisions } = readPlaybook();
  log(`[seed-talk] parsed ${usable.length} card(s) from ${path.basename(SOURCE_PATH)}`);
  if (collisions.length) {
    log(`[seed-talk] ${collisions.length} card(s) share a title with another in the same group and`);
    log('            were dropped, because two cards cannot hold one slug:');
    for (const t of collisions) log(`             ! ${t}`);
  }
  if (rejected.length) {
    log(`[seed-talk] ${rejected.length} card(s) not usable:`);
    for (const r of rejected) log(`             - ${r.title} (${r.why})`);
  }

  if (dryRun) {
    for (const c of usable) log(`  · ${c.group}/${c.sort} ${c.slug}, ${c.turns.length} turn(s)`);
    return { dryRun: true, parsed: usable.length, rejected: rejected.length, collisions: collisions.length };
  }

  let inserted = 0;
  let refreshed = 0;

  for (const c of usable) {
    // INSERT IGNORE against uq_talk_slug. This is the idempotency: run it
    // twice, the second run reports 0 inserted and changes nothing.
    const result = await run(
      'INSERT IGNORE INTO talk ' +
        '(slug, heading, `group`, kind, stage, chips, title, sub, turns, active, sort, source, author) ' +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'playbook', ?)",
      [
        c.slug,
        c.heading,
        c.group,
        c.kind,
        JSON.stringify(c.stage),
        JSON.stringify(c.chips),
        c.title,
        c.sub,
        JSON.stringify(c.turns),
        c.sort,
        'Client Talk Hub',
      ]
    );

    if (result.affectedRows) {
      inserted += 1;
      continue;
    }
    if (!refresh) continue;

    // Only ever refresh imported cards. `source='hub'` is something a person
    // typed into this app, and an import must not overwrite it. `active` is
    // left alone too: deactivating a card is a decision somebody made here,
    // and a refresh that revived it would undo that decision invisibly.
    const updated = await run(
      'UPDATE talk SET heading = ?, `group` = ?, kind = ?, stage = ?, chips = ?, ' +
        'title = ?, sub = ?, turns = ?, sort = ? ' +
        "WHERE slug = ? AND source = 'playbook'",
      [
        c.heading,
        c.group,
        c.kind,
        JSON.stringify(c.stage),
        JSON.stringify(c.chips),
        c.title,
        c.sub,
        JSON.stringify(c.turns),
        c.sort,
        c.slug,
      ]
    );
    refreshed += updated.affectedRows ? 1 : 0;
  }

  log(
    `[seed-talk] talk: ${inserted} inserted, ${usable.length - inserted} already present` +
      (refresh ? `, ${refreshed} refreshed` : '')
  );

  // Cards written in the hub, reported and never touched. A seed script that
  // can see rows it did not write should say how many, so "nothing inserted"
  // is never mistaken for "the table is what this file says".
  const own = await query("SELECT COUNT(*) AS n FROM talk WHERE slug IS NULL OR source = 'hub'");
  const ownCount = Number(own?.[0]?.n ?? 0);
  if (ownCount) log(`[seed-talk] talk: ${ownCount} card(s) written in the hub, left untouched`);

  await run('INSERT INTO audit (who, action, detail) VALUES (?, ?, ?)', [
    null,
    'seed_talk',
    JSON.stringify({ inserted, refreshed, parsed: usable.length, rejected: rejected.length }),
  ]);

  return { inserted, refreshed, parsed: usable.length, rejected: rejected.length, hubOwned: ownCount };
}

// ------------------------------------------------------------------- cli

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (invokedDirectly) {
  const dryRun = process.argv.includes('--dry') || process.argv.includes('--dry-run');
  if (!dryRun && !dbConfigured()) {
    console.error(`[seed-talk] not configured, missing ${missingEnv().join(', ')}.`);
    process.exit(2);
  }
  try {
    await seedTalk({ refresh: process.argv.includes('--refresh'), dryRun });
    if (!dryRun) await closePool();
    process.exit(0);
  } catch (err) {
    await closePool();
    if (err instanceof DbError && err.unavailable) {
      console.error(`[seed-talk] database unreachable (${err.code}): ${err.message}`);
      console.error('[seed-talk] nothing was written. Run db/migrate.js first if `talk` does not exist.');
      process.exit(2);
    }
    console.error(`[seed-talk] failed: ${err.message}`);
    process.exit(1);
  }
}
