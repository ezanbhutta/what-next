// tests/house-rules.test.js, the rules that have already been broken once.
//
// WHY THIS FILE EXISTS
//
// Every rule below is a rule the repo already states in prose, in README.md
// and in the brief. Prose does not hold. 782 em dashes were taken out of this
// codebase by hand and twelve grew back, in reports-ceo.js, in server.js and
// in both seed scripts, because nothing was watching. A rule with no test is
// a rule that survives exactly as long as the person who remembers it.
//
// WHAT IS CHECKED AND WHAT IS NOT
//
// Source that the team READS, not data the hub QUOTES. The six handbook
// documents are Ezan's own words and are rendered verbatim, em dashes and
// all; rewriting somebody's document to fit our house style would be the hub
// editing a source, which is the one thing it never does. Engine output in
// data/ is the same: the hub reads it, it does not rewrite it.
//
// Comments are stripped before every check. A comment explaining a trap can
// say whatever it needs to; it never reaches a screen.
//
// THE ESCAPE HATCH
//
// A line that genuinely needs a banned character because it PARSES one, not
// because it prints one, carries `reads-input` in a trailing comment. There
// is exactly one today: lib/handbook.js's bullet pattern, because the PDF
// extraction writes its bullets as em and en dashes and the parser has to
// match the character it is given. Anything using this marker to smuggle
// prose past the check is visible in a diff, which is the point.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Every JS file that can put words in front of a person.
 *
 * `*.test.js` is excluded and that exclusion is load-bearing, not laziness:
 * a checker that reads the file stating the rule finds the rule and fails on
 * it. Test files render nothing and print nothing to the team, so there is
 * nothing here for them to violate.
 */
function sourceFiles() {
  const out = [];
  for (const dir of ['views', 'lib', 'db']) {
    const full = path.join(ROOT, dir);
    if (!fs.existsSync(full)) continue;
    for (const f of fs.readdirSync(full)) {
      if (f.endsWith('.js') && !f.endsWith('.test.js')) out.push(path.join(dir, f));
    }
  }
  out.push('server.js');
  return out.filter((f) => fs.existsSync(path.join(ROOT, f)));
}

/**
 * Lines with their comments removed, so a check sees only what can ship.
 *
 * Crude on purpose: a `//` inside a string literal truncates the line early,
 * which can only ever HIDE a violation, never invent one. A checker that
 * fails on a line nobody can find is worse than one that misses a rare case.
 */
function codeLines(file) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n');
  const out = [];
  let inBlock = false;
  src.forEach((raw, i) => {
    let line = raw;
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end === -1) return;
      line = line.slice(end + 2);
      inBlock = false;
    }
    for (;;) {
      const start = line.indexOf('/*');
      if (start === -1) break;
      const end = line.indexOf('*/', start + 2);
      if (end === -1) {
        line = line.slice(0, start);
        inBlock = true;
        break;
      }
      line = line.slice(0, start) + line.slice(end + 2);
    }
    const slashes = line.indexOf('//');
    if (slashes !== -1) line = line.slice(0, slashes);
    if (line.trim()) out.push({ file, line: i + 1, code: line, raw });
  });
  return out;
}

function allCode() {
  return sourceFiles().flatMap(codeLines);
}

const at = (hits) => hits.map((h) => `${h.file}:${h.line}  ${h.raw.trim().slice(0, 110)}`).join('\n');

// ---------------------------------------------------------------- em dashes

test('no em dash reaches a screen or a terminal', () => {
  const hits = allCode()
    .filter((h) => h.code.includes('—'))
    .filter((h) => !/reads-input/.test(h.raw));
  assert.equal(
    hits.length,
    0,
    `An em dash reads as machine-written and the house style bans it.\n` +
      `Use a full stop, a comma or a colon:\n${at(hits)}`
  );
});

// ------------------------------------------------------- the retired names

test('the chokepoint scrubs the retired programme out of every string', async () => {
  // House rule 4, tested where it is enforced. esc() is the one function every
  // user-visible string passes through, so a raw engine key arriving down a
  // data path nobody has written yet is still caught.
  const { esc } = await import('../views/layout.js');
  assert.equal(esc('vvro_share_7d'), 'directed_share_7d');
  assert.equal(esc('by_type.Vvro'), 'by_type.Directed');
  assert.equal(esc('INORGANIC ORDERS'), 'DIRECTED ORDERS');
  assert.equal(esc('inorganic'), 'directed');
});

test('nothing but the scrubber names the retired volume programme', () => {
  // A call site that spells it out is a call site that will one day be
  // rendered without going through esc(). One line owns the words, and it
  // says so in a trailing comment.
  const hits = allCode()
    .filter((h) => /vvro|inorganic/i.test(h.code))
    .filter((h) => !/scrubs-output/.test(h.raw));
  assert.equal(hits.length, 0, `Say "directed". The scrubber already handles the raw keys.\n${at(hits)}`);
});

// ------------------------------------------------------------ banned words

const BANNED = /\b(leverag(?:e|ed|es|ing)|utilis|utiliz|seamless|robust|comprehensive|delve)/i;

test('no consultancy filler in anything the team reads', () => {
  const hits = allCode().filter((h) => BANNED.test(h.code));
  assert.equal(hits.length, 0, `Plain words. These do not survive review:\n${at(hits)}`);
});

// ---------------------------------------------------------------- the OS

test('the operating system never picks the colour scheme', () => {
  // House rule 6. This shipped once and everyone with a dark laptop got a
  // dark page they had not asked for. The toggle is the only thing that
  // switches the palette, so the media query may not appear in the stylesheet
  // and may not be written into a page by a view either.
  const css = fs.readFileSync(path.join(ROOT, 'public', 'app.css'), 'utf8');
  assert.ok(
    !/prefers-color-scheme/.test(css),
    'public/app.css names prefers-color-scheme. Dark mode is an explicit toggle.'
  );
  const hits = allCode().filter((h) => /prefers-color-scheme/.test(h.code));
  assert.equal(hits.length, 0, `A view is emitting prefers-color-scheme:\n${at(hits)}`);
});

// ----------------------------------------------------------------- inputs

test('every input is 16px, so no phone zooms on focus', () => {
  // Under 16px, iOS Safari zooms the page when a field takes focus and does
  // not zoom back out. The team works this hub on phones mid-shift.
  const css = fs.readFileSync(path.join(ROOT, 'public', 'app.css'), 'utf8');
  const bad = [];
  for (const m of css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)) {
    const before = css.slice(Math.max(0, m.index - 400), m.index);
    const rule = before.slice(before.lastIndexOf('}') + 1);
    if (/\b(input|select|textarea)\b/.test(rule) && Number(m[1]) < 16) {
      bad.push(`${m[0]} in rule: ${rule.trim().slice(0, 90)}`);
    }
  }
  assert.equal(bad.length, 0, `An input under 16px makes iOS zoom:\n${bad.join('\n')}`);
});
