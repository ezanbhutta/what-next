#!/usr/bin/env node
// db/responses-from-talk.js , build data/responses.json out of the talk playbook.
//
// The reply library and the talk playbook are two surfaces over the same
// thing: lines the owner wrote to send to buyers. Messages uses them in
// conversation (buyer says X, this goes back); Responses lists them flat, by
// category, to send and log.
//
// So there is ONE source, db/client-talk-hub.html, and this projects it into
// the second shape. It is not a second copy anybody maintains: re-running it
// regenerates the file, and db/seed.js is INSERT IGNORE, so a reply edited
// inside the hub (source 'hub') is never overwritten by an import.
//
// Nothing here invents a line. Every body is a `turns[].s` the owner wrote.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPlaybook } from './seed-talk.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'data', 'responses.json');

/** A short, unique, human name for a reply. */
function nameFor(card, turn, seen) {
  // The buyer's line is what a CSR is scanning for, so it leads. The card
  // title is the fallback for a turn that carries no buyer line.
  const said = String(turn.h || '').replace(/\s+/g, ' ').trim();
  const title = String(card.title || '').replace(/[“”"]/g, '').replace(/\s+/g, ' ').trim();
  let base = said ? `${title}, ${said}` : title;
  base = base.slice(0, 110).replace(/[,\s]+$/, '');
  let name = base;
  let n = 2;
  while (seen.has(name.toLowerCase())) {
    name = `${base.slice(0, 104)} (${n})`;
    n += 1;
  }
  seen.add(name.toLowerCase());
  return name;
}

export function build() {
  const { usable } = readPlaybook();
  const out = [];
  const seen = new Set();
  for (const card of usable || []) {
    for (const turn of card.turns || []) {
      const body = String(turn.s || '').trim();
      if (!body) continue; // a card with no reply is not a reply
      const when = [
        turn.h ? `When they say: ${String(turn.h).trim()}` : null,
        turn.u ? `Opens: ${String(turn.u).trim()}` : null,
        turn.w ? `Careful: ${String(turn.w).trim()}` : null,
        card.sub ? String(card.sub).trim() : null,
      ].filter(Boolean).join(' · ') || null;
      out.push({
        name: nameFor(card, turn, seen),
        body,
        when_to_use: when,
        category: card.heading || null,
        source: 'extra',
      });
    }
  }
  return out;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  const rows = build();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(rows, null, 1) + '\n', 'utf8');
  console.log(`wrote ${path.relative(process.cwd(), OUT)}, ${rows.length} replies from the talk playbook`);
}
