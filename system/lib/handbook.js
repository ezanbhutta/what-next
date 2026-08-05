// lib/handbook.js, the six owner-written documents, parsed out of plain text.
//
// WHAT THIS MODULE IS
//
//   data/handbook/*.txt are PDF extractions with the page layout preserved.
//   They are not markup and they were never meant to be read by a program.
//   This module turns them into sections, clauses, bullets, tables and
//   callouts so the team can jump to a rule instead of scrolling a wall.
//
// THE RULE THAT SHAPES EVERY FUNCTION HERE
//
//   A file that does not parse must still be READABLE. Every parse step is
//   wrapped, and a document that comes out with no sections is returned with
//   `ok:false` and its full text in `raw`, which the view renders as plain
//   text. A blank page would be the worst outcome: it looks like the rule
//   does not exist, and somebody mid-shift acts on that.
//
//   A file that is not on disk is MISSING, never an empty document. It gets
//   `ok:false`, `present:false` and a reason. The view says so.
//
// THE LETTERSPACING PROBLEM, AND WHY THERE IS A DICTIONARY IN HERE
//
//   The PDF tracked its headings and table labels, so the extractor wrote
//   them out one letter group at a time:
//
//       M EA S U R E        C U R R EN T        TA R G ET
//       D O C U M EN T S I N T H I S S ET
//
//   The gap between two letters and the gap between two WORDS are both a
//   single space, so the word boundaries are simply gone. Collapsing the
//   spaces gives DOCUMENTSINTHISSET and nothing in the string says where to
//   cut it.
//
//   So the cuts are made against a vocabulary built from the documents
//   themselves: every word that appears in ordinary, un-tracked prose across
//   the six files, plus a short seed list of common words and the handful of
//   labels that only ever appear tracked. A run is re-split only when EVERY
//   piece is a word in that vocabulary; if any piece is not, the original
//   spaced string is kept exactly as it was. That is the important half of
//   the contract: this never guesses a word into existence, it only ever
//   recognises one, and when it cannot, the reader sees the raw text rather
//   than an invention.
//
// NOTHING HERE IS A NUMBER THE HUB PUBLISHES. These documents state figures
// ($5,722 in open quotations, a 4.8 rating) that were true when they were
// written. They are quoted as document text, never lifted into a hub figure,
// because the engine is the only source for those and a second copy is a
// second thing that can be wrong.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, '..', 'data', 'handbook');

// ============================================================================
// 1. THE SET
// ============================================================================
//
// Named, not globbed. The directory holds working files as well, and a
// document that appears in the hub because somebody dropped a file next to
// the others is a document nobody decided to publish. `answers` is navigation
// copy: the one question this document settles, in the words a CSR would use
// mid-shift. The document's own summary line is parsed from its cover page
// and shown underneath it.

export const MANIFEST = Object.freeze([
  {
    id: 'OM-01',
    file: 'XStudiozOperatingModel.txt',
    name: 'Operating Model',
    answers: 'What the profile is trying to do, and who decides what.',
  },
  {
    id: 'RR-01',
    file: 'XStudiozRolesandResponsibilities.txt',
    name: 'Roles and Responsibilities',
    answers: 'Whose job this is, who covers which hours, and what sits outside a role.',
  },
  {
    id: 'SS-01',
    file: 'XStudiozServiceStandards.txt',
    name: 'Service Standards',
    answers: 'What the client should experience, and by when.',
  },
  {
    id: 'IC-01',
    file: 'XStudiozInquiryandConversion.txt',
    name: 'Inquiry and Conversion',
    answers: 'What to do with an inquiry, from the first reply to closing it.',
  },
  {
    id: 'OH-01',
    file: 'XStudiozOrderHandbook.txt',
    name: 'Order Handbook',
    answers: 'What to do with an order, from receipt to final delivery.',
  },
  {
    id: 'CP-01',
    file: 'XStudiozCapabilityProgramme.txt',
    name: 'Capability Programme',
    answers: 'The sixty day plan, and what each person has to be able to do by the end of it.',
  },
]);

// ============================================================================
// 2. LINE SHAPES
// ============================================================================

const RE_CLAUSE = /^(\d+\.\d+)\s+(\S.*)$/;
const RE_BULLET = /^[—–-]\s+(\S.*)$/; // reads-input: the owner's PDF bullets are em and en dashes
const RE_PAGE_FOOT = /PAGE\d+OF\d+$/;

/**
 * Split a laid-out line into its columns. Two or more spaces is a gutter.
 *
 * The inner group is LAZY (`??`), and that is the whole correctness of this
 * function. Greedy, the match runs past the first gutter to the end of the
 * line whenever the line ends in a cell, so "Success Score … 8 … 9" comes back
 * as two columns with "8                9" jammed into the second. Nothing
 * about that looks wrong until a table renders with its last column empty.
 */
function cellsOf(line) {
  const out = [];
  const re = /\S(?:.*?\S)??(?=\s{2,}|$)/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    if (m[0].trim() === '') continue;
    out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
    if (re.lastIndex === m.index) re.lastIndex++;
  }
  return out;
}

/**
 * Does this cell look like tracked letterspacing rather than words?
 *
 * Three or more pieces, most of them one or two characters. "Head of Customer
 * Success" has three pieces and none of them short, so it is prose. "M EA S U
 * R E" is six pieces of one or two, so it is a tracked label.
 */
function looksTracked(text) {
  const raw = String(text).trim();
  const parts = raw.split(/\s+/);
  if (parts.length < 3) return false;
  return parts.filter((p) => p.length <= 2).length / parts.length >= 0.6;
}

/** Everything except letters and digits, gone. Used for matching, never shown. */
function collapse(text) {
  return String(text).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

// ============================================================================
// 3. THE VOCABULARY, AND THE RE-SPLIT
// ============================================================================

// Common words, plus the labels that appear ONLY as tracked headings in these
// six documents and therefore cannot be learned from their own prose. Adding a
// word here is a decision to recognise it; leaving one out costs nothing but a
// heading that stays spaced out, which is legible and honest.
const SEED = (
  'A AN AND ARE AS AT BE BY DO DOES FOR FROM HAS HAVE IF IN IS IT ITS NO NOT OF ON OR OUT ' +
  'SET THAT THE THEIR THEN THERE THIS TO UP UPS WITH WHAT WHEN WHERE WHICH WHO WILL WITHIN ' +
  'SECTION CONTENTS PAGE VERSION ISSUE DATE OWNER REVIEW CLASSIFICATION INTERNAL PERIOD ' +
  'PRIMARY MEASURE MEASURES REST OBSERVED SILENT ACCEPTANCE PREMIUM ALIGNMENT METHOD ' +
  'STARTING POSITIONS CONCURRENT MONTHLY UNSEEN FEEDBACK DOCUMENTS LIMIT THRESHOLD ACTION ' +
  'BREACHED ITEM VALUE ROLE HOURS HELD PROBABLE CAUSE FIRST POINT AREA'
).split(/\s+/);

let vocabCache = null;

function vocabulary(sources) {
  if (vocabCache) return vocabCache;
  const words = new Set(SEED);
  for (const text of sources) {
    for (const line of String(text).split('\n')) {
      for (const cell of cellsOf(line)) {
        if (looksTracked(cell.text)) continue;
        for (const w of cell.text.match(/[A-Za-z][A-Za-z'’]*/g) || []) {
          if (w.length > 1) words.add(w.toUpperCase());
        }
      }
    }
  }
  vocabCache = words;
  return words;
}

/**
 * Re-split one collapsed run into words, or return null.
 *
 * Longest-words-win: the score is the sum of the squares of the word lengths,
 * so for a fixed run the split with the fewest, longest pieces wins. Single
 * letters are refused outright except A and I, which is what stops CONCURRENT
 * being read as "C ON CURRENT". Digits are always a word, so "SECTION8" and
 * "PAGE3OF9" come apart correctly.
 */
function resplit(run, words) {
  const n = run.length;
  if (!n || n > 120) return null;
  const best = new Array(n + 1).fill(null);
  best[0] = { score: 0, parts: [] };
  for (let i = 0; i < n; i++) {
    if (!best[i]) continue;
    for (let j = i + 1; j <= n; j++) {
      const piece = run.slice(i, j);
      const known =
        /^\d+$/.test(piece) || (piece.length === 1 ? piece === 'A' || piece === 'I' : words.has(piece));
      if (!known) continue;
      const score = best[i].score + piece.length * piece.length;
      if (!best[j] || score > best[j].score) best[j] = { score, parts: [...best[i].parts, piece] };
    }
  }
  return best[n] ? best[n].parts.join(' ') : null;
}

/**
 * A tracked cell, put back together. Unchanged when it cannot be.
 *
 * Two gates before anything is rewritten, and both are load-bearing:
 *
 *   UPPER CASE ONLY. Tracking was applied to headings and labels, all of
 *   which are set in capitals. Prose is never touched, so a wrapped sentence
 *   fragment can never come back SHOUTED at the reader.
 *
 *   A STUB SOMEWHERE. "SUCCESS SCORE" is two ordinary words and is left
 *   exactly as it is. "PROBABLE CAU SE" has a three and a two in it, which is
 *   what tracking does to a word, so it is a candidate.
 *
 * After that, `resplit` decides, and it only ever returns words it recognised.
 */
function untrack(text, words) {
  const raw = String(text).trim();
  if (raw !== raw.toUpperCase() || !/[A-Z]/.test(raw)) return raw;
  const parts = raw.split(/\s+/);
  if (parts.length < 2 || !parts.some((p) => p.length <= 3)) return raw;
  const run = raw.replace(/[\s·]+/g, '');
  if (!/^[A-Za-z0-9'’]+$/.test(run)) return raw;
  const out = resplit(run.toUpperCase(), words);
  if (!out) return raw;
  // Apostrophes are dropped by the run, so put the only shape that occurs
  // back: a possessive at the end of a word. CLIENTS -> CLIENT'S only when
  // the original carried the mark.
  return /['’]/.test(raw) ? out.replace(/\b([A-Z]+)S\b/, "$1'S") : out;
}

// ============================================================================
// 4. THE PARSE
// ============================================================================

/**
 * One page, stripped of its running head and its page footer.
 *
 * Both are printed furniture, they repeat on every page, and leaving them in
 * would put "OM-01 · OPERATING MODEL · SECTION 4" in the middle of the reading
 * column and in every search result.
 */
function stripFurniture(lines, docId) {
  const out = lines.slice();
  const code = collapse(docId);
  while (out.length && out[0].trim() === '') out.shift();
  if (out.length) {
    const head = collapse(out[0]);
    if (head.startsWith(code) || head.startsWith('SECTION') || head.startsWith('CONTENTS')) out.shift();
  }
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  if (out.length) {
    const foot = collapse(out[out.length - 1]);
    if (RE_PAGE_FOOT.test(foot) || foot.startsWith(code + 'V')) out.pop();
  }
  return out;
}

/** The cover page: title, the sentence under it, and the issue block. */
function parseCover(page, words) {
  const lines = page.split('\n').map((l) => l.replace(/\s+$/, ''));
  const solid = lines.filter((l) => l.trim() !== '');
  const meta = [];
  const prose = [];

  for (const line of solid) {
    const parts = cellsOf(line);
    const label = parts[0] ? untrack(parts[0].text, words) : '';
    if (parts.length >= 2 && label === label.toUpperCase() && /[A-Z]/.test(label)) {
      meta.push({ label: titleCase(label), value: parts.slice(1).map((p) => p.text.trim()).join(' ') });
      continue;
    }
    if (RE_PAGE_FOOT.test(collapse(line))) continue;
    if (looksTracked(line)) continue; // the brand line
    prose.push(line.trim());
  }

  // The first prose line is the document code, the second is its name, the
  // rest is the sentence describing it.
  const body = prose.filter((p) => !/^[A-Z]{2}-\d\d$/.test(p));
  const title = body.shift() || null;
  const summary = body.join(' ').trim() || null;
  return { title, summary, meta };
}

function titleCase(text) {
  return String(text)
    .toLowerCase()
    .replace(/(^|\s)([a-z])/g, (m, sp, c) => sp + c.toUpperCase());
}

/**
 * A table, read off its column positions.
 *
 * The header row fixes where each column starts. Every cell below is assigned
 * to a column by its own MIDPOINT, not its left edge, because half of these
 * tables right-align their figures: "9" sits at the far right of a column
 * whose header starts 30 characters to its left, and matching on left edges
 * puts it in the wrong column with nothing looking wrong about the result.
 */
function readTable(headerCells, rowLines, words) {
  const columns = headerCells.map((c) => untrack(c.text, words));
  const rows = [];
  let current = null;

  // Overlap first, nearest edge second. A right-aligned figure often starts to
  // the LEFT of its own column header and ends underneath it, so "does this
  // cell sit past the header's start" is the wrong question and quietly files
  // the value one column early.
  const columnFor = (cell) => {
    let best = 0;
    let bestOverlap = 0;
    for (let i = 0; i < headerCells.length; i++) {
      const h = headerCells[i];
      const overlap = Math.min(cell.end, h.end) - Math.max(cell.start, h.start);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = i;
      }
    }
    if (bestOverlap > 0) return best;
    let nearest = 0;
    let gap = Infinity;
    const mid = (cell.start + cell.end) / 2;
    for (let i = 0; i < headerCells.length; i++) {
      const h = headerCells[i];
      const d = Math.abs((h.start + h.end) / 2 - mid);
      if (d < gap) {
        gap = d;
        nearest = i;
      }
    }
    return nearest;
  };

  const place = (line) => {
    const slots = new Array(columns.length).fill('');
    for (const cell of cellsOf(line)) {
      const idx = columnFor(cell);
      slots[idx] = slots[idx] ? `${slots[idx]} ${cell.text.trim()}` : cell.text.trim();
    }
    return slots;
  };

  for (const line of rowLines) {
    if (line.trim() === '') {
      if (current) rows.push(current);
      current = null;
      continue;
    }
    const slots = place(line);
    if (!current) current = slots;
    else current = current.map((v, i) => (slots[i] ? (v ? `${v} ${slots[i]}` : slots[i]) : v));
  }
  if (current) rows.push(current);
  return { kind: 'table', columns, rows: rows.filter((r) => r.some((c) => c !== '')) };
}

/** Is this line a table header: two or more columns, every label upper case. */
function isTableHeader(line, words) {
  if (/^\s/.test(line)) return false;
  const cells = cellsOf(line);
  if (cells.length < 2) return false;
  return cells.every((c) => {
    const t = untrack(c.text, words);
    return /[A-Z]/.test(t) && t === t.toUpperCase();
  });
}

/**
 * The blocks of one section.
 *
 * Written as a cursor over the lines rather than a regex over the whole page,
 * because a clause, its wrapped remainder and the note underneath it are three
 * different things that look identical to a line-at-a-time reader. The rule
 * that separates them: a clause runs on until a line ENDS a sentence; anything
 * after that, still indented, is the note.
 */
function parseBlocks(lines, words) {
  const blocks = [];
  let i = 0;
  const flushable = [];

  const pushPara = () => {
    if (!flushable.length) return;
    const text = flushable.join(' ').replace(/\s+/g, ' ').trim();
    flushable.length = 0;
    if (text) blocks.push({ kind: 'para', text });
  };

  const blank = (n) => !lines[n] || lines[n].trim() === '';

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '') {
      pushPara();
      i++;
      continue;
    }

    const indent = line.length - line.trimStart().length;
    const body = line.trim();

    // ---- callout: indented, tracked or upper-case title, indented body ----
    if (indent >= 2 && indent <= 8) {
      const title = untrack(body, words);
      if (/[A-Z]/.test(title) && title === title.toUpperCase() && title.length > 3) {
        pushPara();
        i++;
        const said = [];
        while (i < lines.length) {
          if (lines[i].trim() === '') {
            if (blank(i + 1)) break;
            i++;
            continue;
          }
          const ind = lines[i].length - lines[i].trimStart().length;
          if (ind < 2) break;
          said.push(lines[i].trim());
          i++;
        }
        blocks.push({ kind: 'callout', title, text: said.join(' ').replace(/\s+/g, ' ').trim() });
        continue;
      }
    }

    // ---- clause: "3.2   statement." then the wrapped rest, then a note ----
    const clause = RE_CLAUSE.exec(line);
    if (clause && indent === 0) {
      pushPara();
      const ref = clause[1];
      const said = [clause[2].trim()];
      let note = [];
      let sentenceClosed = /[.:;]$/.test(clause[2].trim());
      i++;
      while (i < lines.length && lines[i].trim() !== '') {
        const ind = lines[i].length - lines[i].trimStart().length;
        if (ind === 0) break;
        const piece = lines[i].trim();
        if (sentenceClosed) note.push(piece);
        else {
          said.push(piece);
          sentenceClosed = /[.:;]$/.test(piece);
        }
        i++;
      }
      blocks.push({
        kind: 'clause',
        ref,
        text: said.join(' ').replace(/\s+/g, ' ').trim(),
        note: note.join(' ').replace(/\s+/g, ' ').trim() || null,
      });
      continue;
    }

    // ---- bullet: a dash then a statement, grouped with the ones next to it -
    const bullet = RE_BULLET.exec(body);
    if (bullet && indent === 0) {
      pushPara();
      const items = [];
      while (i < lines.length) {
        if (lines[i].trim() === '') {
          if (blank(i + 1)) break;
          i++;
          continue;
        }
        const m = RE_BULLET.exec(lines[i].trim());
        const ind = lines[i].length - lines[i].trimStart().length;
        if (m && ind === 0) items.push(m[1].trim());
        else if (ind > 0 && items.length) items[items.length - 1] += ` ${lines[i].trim()}`;
        else break;
        i++;
      }
      blocks.push({ kind: 'bullets', items: items.map((t) => t.replace(/\s+/g, ' ').trim()) });
      continue;
    }

    // ---- table: a header row, then rows until two blank lines ------------
    if (isTableHeader(line, words)) {
      pushPara();
      const header = cellsOf(line);
      // Where the second column begins. A lone cell out at that offset is a
      // wrapped row; a lone cell at three spaces is a callout title.
      const secondStart = header.length > 1 ? header[1].start : 0;
      i++;
      const rowLines = [];
      let sawRow = false;
      let afterBlank = true;

      // A TABLE ENDS ON WHAT COMES NEXT, NOT ON BLANK LINES. Blank lines
      // between rows are worth nothing as a signal: the same six documents
      // separate rows by one blank in one table and by two in the next, so
      // "two blanks ends it" reads half of the tables in the set as a single
      // row followed by loose prose. Every line below is asked whether it can
      // be a row instead.
      while (i < lines.length) {
        const cur = lines[i];
        const t = cur.trim();
        if (t === '') {
          if (sawRow && blank(i + 1) && blank(i + 2)) break;
          rowLines.push(cur);
          afterBlank = true;
          i++;
          continue;
        }
        const ind = cur.length - cur.trimStart().length;
        const cs = cellsOf(cur);
        if (ind === 0 && (RE_CLAUSE.test(cur) || RE_BULLET.test(t))) break;
        if (sawRow && isTableHeader(cur, words)) break;
        const isRow =
          cs.length >= 2 ||
          (cs.length === 1 && secondStart > 0 && cs[0].start >= secondStart - 6) ||
          (cs.length === 1 && ind === 0 && !afterBlank);
        if (!isRow) break;
        rowLines.push(cur);
        sawRow = true;
        afterBlank = false;
        i++;
      }
      blocks.push(readTable(header, rowLines, words));
      continue;
    }

    // ---- standfirst: the two column block under a role heading -----------
    //
    // RR-01 opens each role with the person's name at the left margin and
    // their covered hours set hard right, over two or three lines. Read one
    // line at a time it comes out as "Ezan 11:00-23:00 Monday to Friday
    // 09:00-21:00 Saturday and Sunday Head of Customer Success", which is
    // every word in the wrong order. The columns are kept apart instead.
    //
    // THE OPENING LINE HAS TO BE THE TWO COLUMN ONE. Testing "somewhere in
    // this run there is a right-hand cell" instead catches a sub-heading
    // sitting directly above a table header ("Value held" over "ITEM |
    // VALUE"), swallows the header, and the table below it never parses at
    // all. It comes out as a string of two column blocks that look almost
    // right.
    {
      const opening = cellsOf(line);
      let end = i;
      while (end < lines.length && lines[end].trim() !== '' && !(end > i && isTableHeader(lines[end], words))) end++;
      const run = lines.slice(i, end);
      const split = run.map((l) => cellsOf(l));
      const twoColumn =
        opening.length === 2 &&
        opening[1].start >= 55 &&
        run.length >= 2 &&
        run.length <= 4 &&
        split.every((cs) => cs.length >= 1 && cs.length <= 2) &&
        !run.some((l) => isTableHeader(l, words));
      if (twoColumn) {
        const left = [];
        const right = [];
        for (const cs of split) for (const c of cs) (c.start >= 55 ? right : left).push(c.text.trim());
        if (left.length && right.length) {
          pushPara();
          blocks.push({ kind: 'standfirst', left, right });
          i = end;
          continue;
        }
      }
    }

    // ---- sub-heading: short, alone, on its own line after a break --------
    //
    // The blank line BEFORE is what makes this safe. Without it the last line
    // of a wrapped paragraph is short too, and half the prose on the page
    // would be promoted to a heading.
    if (
      indent === 0 &&
      cellsOf(line).length === 1 &&
      body.length <= 64 &&
      !/[.,;:]$/.test(body) &&
      /^[A-Z0-9]/.test(body) &&
      blank(i - 1)
    ) {
      pushPara();
      blocks.push({ kind: 'sub', text: body });
      i++;
      continue;
    }

    flushable.push(body);
    i++;
  }
  pushPara();
  return blocks;
}

/** Split the body pages into numbered sections on the "SECTION n" marker. */
function parseSections(pages, docId, words) {
  const sections = [];
  let open = null;

  for (const page of pages) {
    const lines = stripFurniture(page.split('\n').map((l) => l.replace(/\s+$/, '')), docId);
    let start = 0;

    for (let i = 0; i < lines.length; i++) {
      const marker = /^SECTION(\d+)$/.exec(collapse(lines[i]));
      if (!marker) continue;
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === '') j++;
      if (j >= lines.length) break;
      if (open) open.lines.push(...lines.slice(start, i));
      open = { n: Number(marker[1]), title: lines[j].trim(), lines: [] };
      sections.push(open);
      start = j + 1;
      i = j;
    }
    if (open) open.lines.push(...lines.slice(start), '');
  }

  // Anchors are assigned HERE, once, and stored on the block, so the link a
  // search result emits and the id the page renders are the same string by
  // construction rather than by two functions agreeing. They have to be
  // deduped: OM-01 section 3 lists 3.1 to 3.4 under "Objectives" and then 3.1
  // to 3.4 again under "Excluded", and two elements sharing an id means every
  // link to the second one silently lands on the first.
  const used = new Set();
  const anchor = (base) => {
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    return id;
  };

  return sections.map((s) => {
    const id = anchor(`s${s.n}`);
    const blocks = parseBlocks(s.lines, words);
    for (const block of blocks) {
      if (block.kind === 'clause') block.anchor = anchor(`${id}-c${block.ref.replace(/\./g, '-')}`);
    }
    return { n: s.n, id, title: s.title, blocks };
  });
}

// ============================================================================
// 5. READING, WITH A CACHE THAT NOTICES A CHANGED FILE
// ============================================================================

let cache = { signature: null, docs: null };

function signature() {
  return MANIFEST.map((entry) => {
    try {
      const st = fs.statSync(path.join(DIR, entry.file));
      return `${entry.id}:${st.size}:${st.mtimeMs}`;
    } catch {
      return `${entry.id}:absent`;
    }
  }).join('|');
}

function readOne(entry, words) {
  const file = path.join(DIR, entry.file);
  const base = {
    id: entry.id,
    slug: entry.id.toLowerCase(),
    name: entry.name,
    answers: entry.answers,
    file: entry.file,
  };

  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return {
      ...base,
      present: false,
      ok: false,
      reason: `data/handbook/${entry.file} is not readable (${err.code || 'read failed'}).`,
      title: entry.name,
      summary: null,
      meta: [],
      sections: [],
      raw: null,
      words: 0,
    };
  }

  const text = raw.replace(/\r\n/g, '\n');
  const plain = text.replace(/\f/g, '\n');

  try {
    const pages = text.split('\f');
    const cover = parseCover(pages[0] || '', words);
    // Page two is the printed contents list. The contents this hub shows are
    // derived from the section headings that are actually in the body, so a
    // link can never point at a heading the document does not have.
    const sections = parseSections(pages.slice(2), entry.id, words);
    return {
      ...base,
      present: true,
      ok: sections.length > 0,
      reason:
        sections.length > 0
          ? null
          : 'No numbered sections were found in this file, so it is shown as plain text.',
      title: cover.title || entry.name,
      summary: cover.summary,
      meta: cover.meta,
      sections,
      raw: plain,
      words: (plain.match(/\S+/g) || []).length,
    };
  } catch (err) {
    return {
      ...base,
      present: true,
      ok: false,
      reason: `This file could not be parsed into sections (${err.message}). It is shown as plain text.`,
      title: entry.name,
      summary: null,
      meta: [],
      sections: [],
      raw: plain,
      words: (plain.match(/\S+/g) || []).length,
    };
  }
}

/** Every document in the set, parsed. Never throws, never returns null. */
export function documents() {
  const sig = signature();
  if (cache.docs && cache.signature === sig) return cache.docs;

  const sources = [];
  for (const entry of MANIFEST) {
    try {
      sources.push(fs.readFileSync(path.join(DIR, entry.file), 'utf8'));
    } catch {
      /* absent files simply teach the vocabulary nothing */
    }
  }
  vocabCache = null;
  const words = vocabulary(sources);
  const docs = MANIFEST.map((entry) => readOne(entry, words));
  cache = { signature: sig, docs };
  return docs;
}

/** One document by code (`OM-01`, `om-01`) or by the slug of its name. */
export function document(wanted) {
  const key = String(wanted ?? '').trim().toLowerCase();
  if (!key) return null;
  const docs = documents();
  return (
    docs.find((d) => d.slug === key) ||
    docs.find((d) => d.id.toLowerCase() === key) ||
    docs.find((d) => slugify(d.title) === key) ||
    docs.find((d) => slugify(d.name) === key) ||
    null
  );
}

function slugify(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// ============================================================================
// 6. SEARCH
// ============================================================================

/** The words a query is made of. Two characters minimum, twelve terms maximum. */
export function terms(query) {
  return String(query ?? '')
    .toLowerCase()
    .split(/[^a-z0-9'’$%.]+/i)
    .map((t) => t.replace(/^[.'’]+|[.'’]+$/g, ''))
    .filter((t) => t.length >= 2)
    .slice(0, 12);
}

/** Every searchable passage in one document, each carrying where it came from. */
function passages(doc) {
  const out = [];
  const add = (section, ref, text, kind, anchor = null) => {
    const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (clean.length < 2) return;
    out.push({
      docId: doc.id,
      docSlug: doc.slug,
      docTitle: doc.title,
      sectionId: section ? section.id : null,
      sectionN: section ? section.n : null,
      sectionTitle: section ? section.title : null,
      // Where the reader should land. A clause carries its own anchor, so a
      // hit on 3.3 opens at 3.3 rather than at the top of a section holding
      // ten of them.
      anchor: anchor || (section ? section.id : null),
      ref,
      kind,
      text: clean,
    });
  };

  if (!doc.ok) {
    // A document that did not parse is still searchable, one line at a time.
    for (const line of String(doc.raw ?? '').split('\n')) add(null, null, line, 'line');
    return out;
  }

  for (const section of doc.sections) {
    add(section, null, section.title, 'heading');
    for (const block of section.blocks) {
      if (block.kind === 'para' || block.kind === 'sub') add(section, null, block.text, block.kind);
      else if (block.kind === 'clause')
        add(section, block.ref, [block.text, block.note].filter(Boolean).join(' '), 'clause', block.anchor);
      else if (block.kind === 'bullets') for (const item of block.items) add(section, null, item, 'bullet');
      else if (block.kind === 'callout') add(section, null, `${block.title}. ${block.text}`, 'callout');
      else if (block.kind === 'standfirst') add(section, null, [...block.left, ...block.right].join(' · '), 'standfirst');
      else if (block.kind === 'table') {
        for (const row of block.rows) add(section, null, row.filter(Boolean).join(' · '), 'row');
      }
    }
  }
  return out;
}

/**
 * Search all six.
 *
 * Every term has to be present, which is what makes a two-word query useful
 * ("revision brief" finds the clause about both). When nothing matches every
 * term the search widens to any term and SAYS SO in the returned `widened`
 * flag, so the page can tell the reader it answered a different question from
 * the one they asked.
 */
export function search(query, { limit = 60 } = {}) {
  const wanted = terms(query);
  const docs = documents();
  if (!wanted.length) {
    return { query: String(query ?? ''), terms: [], hits: [], total: 0, widened: false, scanned: docs.length };
  }

  const pool = [];
  for (const doc of docs) if (doc.present) pool.push(...passages(doc));

  const run = (needAll) => {
    const hits = [];
    for (const p of pool) {
      const hay = p.text.toLowerCase();
      const found = wanted.filter((t) => hay.includes(t));
      if (needAll ? found.length !== wanted.length : found.length === 0) continue;
      let score = found.length * 12;
      for (const t of found) {
        if (new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(p.text)) score += 6;
      }
      if (p.kind === 'heading') score += 14;
      if (p.kind === 'clause') score += 4;
      score -= Math.min(6, Math.floor(p.text.length / 220));
      hits.push({ ...p, score, matched: found });
    }
    return hits.sort((a, b) => b.score - a.score || a.docId.localeCompare(b.docId));
  };

  let hits = run(true);
  let widened = false;
  if (!hits.length) {
    hits = run(false);
    widened = hits.length > 0;
  }

  return {
    query: String(query ?? ''),
    terms: wanted,
    total: hits.length,
    hits: hits.slice(0, limit),
    // Which documents matched, counted over ALL hits rather than the page of
    // them below. "In 4 of 6 documents" has to describe the search, not the
    // slice of it that fitted on screen.
    inDocs: [...new Set(hits.map((h) => h.docId))],
    widened,
    scanned: docs.filter((d) => d.present).length,
    absent: docs.filter((d) => !d.present).map((d) => d.id),
  };
}

/** A window of `text` around the first term, so a hit is never off screen. */
export function snippet(text, wanted, width = 260) {
  const full = String(text ?? '');
  if (full.length <= width) return { text: full, cutStart: false, cutEnd: false };
  let at = -1;
  for (const t of wanted || []) {
    const i = full.toLowerCase().indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return { text: full.slice(0, width), cutStart: false, cutEnd: true };
  const from = Math.max(0, at - Math.floor(width / 3));
  const to = Math.min(full.length, from + width);
  const start = from > 0 ? full.indexOf(' ', from) + 1 || from : 0;
  return { text: full.slice(start, to), cutStart: start > 0, cutEnd: to < full.length };
}

export default { MANIFEST, documents, document, search, terms, snippet };
