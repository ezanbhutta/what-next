// lib/handbook.test.js: the six documents, and the seam between what the
// parser found and what a link promises.
//
// WHY THESE CHECKS AND NOT OTHERS
//
// Every failure this file pins renders as a page that looks finished. A table
// that lost its last column still draws. A heading that swallowed the table
// under it still reads. A search result whose anchor does not exist still
// opens the right document, at the top, and the reader scrolls looking for a
// clause the link said was there. None of it throws, none of it blanks, and
// none of it is visible without going and looking.
//
// The input is six fixed files committed to this repository, so these are
// real assertions about real content rather than fixtures that agree with the
// code by construction. If somebody re-exports a PDF and the extraction
// changes shape, this is what says so.

import test from 'node:test';
import assert from 'node:assert/strict';

import { MANIFEST, documents, document, search, terms, snippet } from './handbook.js';

const docs = documents();
const byId = new Map(docs.map((d) => [d.id, d]));

// ---------------------------------------------------------------- the set

test('every document in the manifest is on disk and parses into sections', () => {
  assert.equal(docs.length, MANIFEST.length);
  const broken = docs.filter((d) => !d.present || !d.ok).map((d) => `${d.id}: ${d.reason}`);
  assert.deepEqual(broken, [], `documents that did not parse:\n  ${broken.join('\n  ')}`);
  for (const doc of docs) {
    assert.ok(doc.sections.length >= 5, `${doc.id} came back with ${doc.sections.length} sections`);
    assert.ok(doc.title, `${doc.id} has no title`);
    assert.ok(doc.summary, `${doc.id} has no summary line off its cover page`);
  }
});

test('a document is reachable by code, by slug and by name, and by nothing else', () => {
  assert.equal(document('OM-01')?.id, 'OM-01');
  assert.equal(document('om-01')?.id, 'OM-01');
  assert.equal(document('operating-model')?.id, 'OM-01');
  assert.equal(document('nope'), null);
  assert.equal(document(''), null);
  assert.equal(document(undefined), null);
});

// ---------------------------------------------------------------- anchors

test('no anchor is used twice inside one document', () => {
  for (const doc of docs) {
    const seen = new Set();
    const twice = [];
    for (const section of doc.sections) {
      if (seen.has(section.id)) twice.push(section.id);
      seen.add(section.id);
      for (const block of section.blocks) {
        if (block.kind !== 'clause') continue;
        if (seen.has(block.anchor)) twice.push(block.anchor);
        seen.add(block.anchor);
      }
    }
    // OM-01 section 3 numbers its objectives 3.1 to 3.4 and then numbers its
    // exclusions 3.1 to 3.4 as well. Two elements sharing an id is not a
    // rendering nicety: every link to the second one lands on the first, and
    // the page looks entirely correct when it does.
    assert.deepEqual(twice, [], `${doc.id} repeats the anchors ${twice.join(', ')}`);
  }
});

test('every passage the search can return names an anchor that exists', () => {
  const queries = ['revision', 'brief', 'refund', 'cancellation', 'follow up', 'package', 'USD 500'];
  const dead = [];
  for (const q of queries) {
    for (const hit of search(q, { limit: 500 }).hits) {
      const doc = byId.get(hit.docId);
      const ids = new Set();
      for (const s of doc.sections) {
        ids.add(s.id);
        for (const b of s.blocks) if (b.kind === 'clause') ids.add(b.anchor);
      }
      if (!ids.has(hit.anchor)) dead.push(`${q} → ${hit.docId}#${hit.anchor}`);
    }
  }
  assert.deepEqual(dead, [], `search results pointing at anchors nothing renders:\n  ${dead.join('\n  ')}`);
});

// ---------------------------------------------------------------- the parse

test('a right-aligned column is not swallowed by the one before it', () => {
  // OM-01 section 2 sets its figures hard right under headers that start
  // thirty characters to their left. Read with a greedy cell match the row
  // comes back as ["Success Score", "8            9"], two columns where the
  // document has three, with the target quietly gone. The table still draws.
  const om = byId.get('OM-01');
  const table = om.sections
    .flatMap((s) => s.blocks)
    .find((b) => b.kind === 'table' && b.columns[0] === 'MEASURE');
  assert.ok(table, 'OM-01 has no MEASURE table any more');
  assert.deepEqual(table.columns, ['MEASURE', 'CURRENT', 'TARGET']);
  assert.deepEqual(table.rows[0], ['Success Score', '8', '9']);
  assert.ok(table.rows.length >= 6, `only ${table.rows.length} rows survived`);
});

test('a table keeps its rows whether they are one blank line apart or two', () => {
  // IC-01 double-spaces its rows and RR-01 single-spaces them. Ending a table
  // on blank lines reads half the tables in the set as a single row followed
  // by loose prose, which renders as an ordinary paragraph and looks fine.
  const ic = byId.get('IC-01');
  const conversion = ic.sections
    .flatMap((s) => s.blocks)
    .find((b) => b.kind === 'table' && b.columns.includes('CONVERTED'));
  assert.ok(conversion, 'IC-01 has no conversion table any more');
  assert.ok(conversion.rows.length >= 3, `only ${conversion.rows.length} of 3 periods survived`);

  const rr = byId.get('RR-01');
  const roles = rr.sections
    .flatMap((s) => s.blocks)
    .find((b) => b.kind === 'table' && b.columns[0] === 'ROLE');
  assert.ok(roles, 'RR-01 has no roles table any more');
  assert.ok(roles.rows.length >= 6, `only ${roles.rows.length} of 6 roles survived`);
});

test('letterspaced headings are put back together, and never invented', () => {
  const labels = new Set();
  for (const doc of docs) {
    for (const section of doc.sections) {
      for (const block of section.blocks) {
        if (block.kind === 'table') for (const c of block.columns) labels.add(c);
        if (block.kind === 'callout') labels.add(block.title);
      }
    }
  }
  // The words the extractor broke apart, back in one piece.
  for (const want of ['MEASURE', 'ASSESSMENT', 'PROBABLE CAUSE', 'DOCUMENTS IN THIS SET']) {
    assert.ok(labels.has(want), `"${want}" did not come back out of its letterspacing`);
  }
  // And nothing that is still in pieces. A label with three or more stubs in
  // it was tracked and was not recognised, which is allowed. It just has to
  // stay rare enough to notice, because the fallback is legible and a wrong
  // re-split would not be.
  const stillSpaced = [...labels].filter((l) => {
    const parts = l.split(/\s+/);
    return parts.length >= 3 && parts.filter((p) => p.length <= 2).length / parts.length >= 0.6;
  });
  assert.deepEqual(stillSpaced, [], `labels that never came back together: ${stillSpaced.join(' · ')}`);
});

test('a clause keeps its statement and its note apart', () => {
  const om = byId.get('OM-01');
  const objectives = om.sections.find((s) => s.title === 'Objectives');
  const first = objectives.blocks.find((b) => b.kind === 'clause' && b.ref === '3.1');
  assert.equal(first.text, 'Grow revenue and organic orders.');
  assert.match(first.note, /^No other outcome is treated as an objective\./);
});

// ---------------------------------------------------------------- search

test('every term has to be present before the search widens, and it says when it did', () => {
  const both = search('revision brief');
  assert.ok(both.total > 0);
  assert.equal(both.widened, false);
  for (const hit of both.hits) {
    const hay = hit.text.toLowerCase();
    assert.ok(hay.includes('revision') && hay.includes('brief'), `"${hit.text}" is missing a term`);
  }

  // Two words that never share a passage. The search widens rather than
  // returning nothing, and the flag is what lets the page say it answered a
  // wider question than the one it was asked.
  const apart = search('revision zzzzznotaword');
  assert.equal(apart.widened, apart.total > 0);
});

test('a query of nothing returns nothing rather than everything', () => {
  for (const q of ['', '   ', null, undefined, 'a']) {
    const r = search(q);
    assert.equal(r.total, 0, `"${q}" matched ${r.total} passages`);
    assert.deepEqual(r.hits, []);
  }
});

test('terms and snippet do not throw on anything a person can type', () => {
  for (const q of ['$500', "client's", 'USD 500 / refund', '((', '   ', '4.8']) {
    assert.doesNotThrow(() => terms(q));
    assert.doesNotThrow(() => snippet('some passage of text', terms(q)));
  }
  const cut = snippet('x'.repeat(400) + ' revision ' + 'y'.repeat(400), ['revision']);
  assert.ok(cut.text.includes('revision'), 'the snippet cut away the word it was centred on');
  assert.ok(cut.text.length <= 300);
});

test('nothing in these documents names the retired programme', () => {
  // Belt and braces. `esc()` scrubs the name out of every rendered string, so
  // this is not what protects the page, it is what tells us if a re-issued
  // document starts carrying the word, which is a conversation with the owner
  // rather than a rendering problem.
  for (const doc of docs) {
    assert.doesNotMatch(String(doc.raw), /vvro|inorganic/i, `${doc.id} names the retired programme`);
  }
});
