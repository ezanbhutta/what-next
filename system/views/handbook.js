// views/handbook.js, the six owner-written documents, read on a phone.
//
// WHAT THIS SECTION IS FOR
//
//   Somebody is mid-shift with a client waiting. They need one line: how long
//   they have to acknowledge a revision, what the Basic package contains,
//   whether they may quote $600 without asking. Everything on this page is
//   built around getting to that line in seconds and reading it comfortably
//   once it is found.
//
//   So the page does three things and nothing else:
//     the six documents, each with the question it settles
//     one document open, with its headings as a contents list that jumps
//     one search across all six, showing the passage with its own heading
//
// WHAT IT IS NOT
//
//   It is not a viewer for a PDF and it does not reproduce the printed page.
//   Running heads, page numbers and the printed contents page are dropped,
//   because a phone has no pages and "Page 4 of 9" in the middle of the
//   reading column is furniture from a different medium.
//
// THE FIGURE STILL LEADS (R7)
//
//   On the index the figure is how much of the set is readable, and it is a
//   CENSUS of six, not a rate on a sample of six, so it draws no bar and
//   carries no interval. On a document the figure is the document: its title
//   and the sentence under it, before any prose about it.
//
// WHAT IS DELIBERATELY NOT DONE HERE
//
//   No figure in these documents is lifted onto the page as a hub number.
//   OM-01 states $5,722 in open quotations and a 4.8 rating; those were true
//   when it was written, the engine is the only source for what they are now,
//   and a second copy of a number is a second thing that can be wrong. They
//   are shown as what they are: document text, dated by the document's own
//   issue date, which is printed beside them.

import { terms as queryTerms, snippet } from '../lib/handbook.js';

import {
  html,
  join,
  safe,
  esc,
  missing,
  num,
  pill,
  glyph,
  panelHead,
  stamp,
  why,
  empty,
} from './layout.js';

// ============================================================================
// small helpers
// ============================================================================

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Text with the searched words marked.
 *
 * Both branches go through the `html` tag, so every character of document
 * text is escaped whether or not it matched. The regex only ever decides
 * where to put a <mark>, it never puts document text into the page itself.
 */
function marked(text, wanted) {
  const src = String(text ?? '');
  const list = (wanted || []).filter(Boolean);
  if (!list.length || !src) return html`${src}`;

  const re = new RegExp(`(${list.map(escapeRe).sort((a, b) => b.length - a.length).join('|')})`, 'gi');
  const out = [];
  let last = 0;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m[0] === '') {
      re.lastIndex++;
      continue;
    }
    if (m.index > last) out.push(html`${src.slice(last, m.index)}`);
    out.push(html`<mark>${m[0]}</mark>`);
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push(html`${src.slice(last)}`);
  return join(out);
}

/**
 * The search field. One box, one job: it always searches all six.
 *
 * No autofocus, deliberately. On a phone it opens the keyboard on arrival and
 * covers the document list with it, and this page is opened to browse at
 * least as often as it is opened to search.
 */
function searchBar(query) {
  return html`<form class="toolbar doc-search" method="get" action="/handbook" role="search">
      <div class="field">
        <label for="handbook-q">Search all six documents</label>
        <input id="handbook-q" type="search" name="q" value="${query || ''}"
               placeholder="revision, brief, refund, USD 500" autocomplete="off">
      </div>
      <button class="btn" type="submit">Search</button>
    </form>`;
}

// ============================================================================
// one document, rendered
// ============================================================================

function clauseBlock(block, wanted) {
  return html`<div class="clause" id="${safe(esc(block.anchor || ''))}">
      <span class="clause-ref">${block.ref}</span>
      <div class="clause-text">
        <p>${marked(block.text, wanted)}</p>
        ${block.note ? html`<p class="clause-note">${marked(block.note, wanted)}</p>` : ''}
      </div>
    </div>`;
}

function tableBlock(block, wanted) {
  if (!block.columns.length || !block.rows.length) return '';
  return html`<div class="tablewrap doc-table">
      <table class="table table--zebra table--narrow">
        <thead><tr>${join(block.columns.map((c) => html`<th>${c}</th>`))}</tr></thead>
        <tbody>${join(
          block.rows.map(
            (row) => html`<tr>${join(
                row.map((cell, i) =>
                  i === 0
                    ? html`<td class="cell-name">${marked(cell, wanted)}</td>`
                    : html`<td>${marked(cell, wanted)}</td>`
                )
              )}</tr>`
          )
        )}</tbody>
      </table>
      <p class="tablehint" aria-hidden="true">Scroll sideways for more columns →</p>
    </div>`;
}

function blockOf(block, wanted) {
  switch (block.kind) {
    case 'sub':
      return html`<h4 class="doc-sub">${marked(block.text, wanted)}</h4>`;
    case 'para':
      return html`<p class="doc-para">${marked(block.text, wanted)}</p>`;
    case 'clause':
      return clauseBlock(block, wanted);
    case 'bullets':
      return html`<ul class="doc-list">${join(
          block.items.map((item) => html`<li>${marked(item, wanted)}</li>`)
        )}</ul>`;
    case 'callout':
      return html`<aside class="note doc-callout">
          <p class="eyebrow">${block.title}</p>
          <p>${marked(block.text, wanted)}</p>
        </aside>`;
    case 'standfirst':
      return html`<div class="standfirst">
          <div class="standfirst-left">${join(
            block.left.map((l, i) =>
              i === 0
                ? html`<p class="standfirst-name">${marked(l, wanted)}</p>`
                : html`<p>${marked(l, wanted)}</p>`
            )
          )}</div>
          <div class="standfirst-right">${join(block.right.map((r) => html`<p>${marked(r, wanted)}</p>`))}</div>
        </div>`;
    case 'table':
      return tableBlock(block, wanted);
    default:
      return '';
  }
}

function sectionOf(section, wanted) {
  return html`<section class="doc-section" id="${safe(esc(section.id))}">
      <div class="doc-h">
        <h3><span class="doc-h-n">${String(section.n)}</span>${marked(section.title, wanted)}</h3>
        <a class="doc-up" href="#doc-top">Contents</a>
      </div>
      ${join(section.blocks.map((b) => blockOf(b, wanted)))}
    </section>`;
}

function metaRow(doc) {
  if (!doc.meta.length) return '';
  return html`<dl class="doc-meta">${join(
      doc.meta.map((m) => html`<div><dt>${m.label}</dt><dd>${m.value || missing()}</dd></div>`)
    )}</dl>`;
}

function renderDocument(ctx, doc, query) {
  const wanted = query ? queryTerms(query) : [];
  const clean = `/handbook/${encodeURIComponent(doc.slug)}`;

  // ---- present but unparseable: show the text, say why ---------------------
  if (!doc.ok) {
    return {
      kicker: doc.id,
      title: doc.title,
      html: html`<p class="note note--warn">
          ${glyph('warn')} <strong>This document has no contents list.</strong> ${doc.reason}
          Everything it says is below, exactly as it is on disk. Nothing has been dropped.
        </p>
        ${searchBar(query)}
        ${doc.present
          ? html`<div class="block"><pre class="doc-plain">${doc.raw}</pre></div>`
          : html`<div class="figure">
              <span class="cap">${doc.id}</span>
              <strong class="mid">${missing()}</strong>
              <p class="sub">
                <code class="mono">data/handbook/${doc.file}</code> is not on disk, so this document
                cannot be read at all. It is MISSING, not empty. It arrives with the next deploy that
                carries the file.
              </p>
            </div>`}
        <p class="btnrow" style="margin-top:22px"><a class="btn btn--ghost" href="/handbook">All six documents</a></p>`,
    };
  }

  const contents = html`<nav class="doc-toc" id="doc-top" aria-label="Contents of ${doc.title}">
      <p class="eyebrow">Contents</p>
      <ol>${join(
        doc.sections.map(
          (s) => html`<li><a href="#${safe(esc(s.id))}"><span class="doc-toc-n">${String(s.n)}</span>${s.title}</a></li>`
        )
      )}</ol>
      <p class="caption">${num(doc.sections.length)} sections · ${num(doc.words)} words</p>
    </nav>`;

  return {
    kicker: doc.id,
    title: doc.title,
    html: html`${metaRow(doc)}
      ${searchBar(query)}
      ${wanted.length
        ? html`<p class="note">
            ${glyph('info')} Showing <strong>${doc.title}</strong> with
            ${join(wanted.map((t) => html`<mark>${t}</mark>`), ' ')} marked.
            <a href="${safe(esc(clean))}">Clear the marking</a>.
          </p>`
        : ''}
      <div class="doc-layout">
        ${contents}
        <div class="doc-body doc-prose">${join(doc.sections.map((s) => sectionOf(s, wanted)))}</div>
      </div>
      <div class="provenance-bar">
        <span>Read from <code class="mono">data/handbook/${doc.file}</code>.</span>
        <span>This hub never writes to it.</span>
        <span><a href="/handbook">All six documents</a></span>
      </div>`,
  };
}

// ============================================================================
// the index, and search across the set
// ============================================================================

function documentCard(doc) {
  if (!doc.present) {
    return html`<li class="doc-card doc-card--missing">
        <p class="doc-code">${doc.id}</p>
        <h3>${doc.name}</h3>
        <p class="doc-answer">${doc.answers}</p>
        <p class="note note--neg">
          ${glyph('crit')} ${missing()}. ${doc.reason} The other documents are unaffected.
        </p>
      </li>`;
  }

  const issued = doc.meta.find((m) => /issue|period/i.test(m.label));
  const owner = doc.meta.find((m) => /owner/i.test(m.label));

  return html`<li class="doc-card">
      <p class="doc-code">${doc.id}${doc.ok ? '' : html` <span class="pill pill--warn">Plain text</span>`}</p>
      <h3><a href="${safe(esc(`/handbook/${encodeURIComponent(doc.slug)}`))}">${doc.title}</a></h3>
      <p class="doc-answer">${doc.answers}</p>
      <p class="doc-summary">${doc.summary || ''}</p>
      <p class="doc-facts">
        <span>${doc.ok ? html`${num(doc.sections.length)} sections` : 'no contents list'}</span>
        <span>${num(doc.words)} words</span>
        ${owner ? html`<span>${owner.value}</span>` : ''}
        ${issued ? html`<span>${issued.value}</span>` : ''}
      </p>
    </li>`;
}

function hitRow(hit, wanted) {
  const cut = snippet(hit.text, wanted);
  const to = hit.anchor
    ? `/handbook/${encodeURIComponent(hit.docSlug)}?q=${encodeURIComponent(wanted.join(' '))}#${hit.anchor}`
    : `/handbook/${encodeURIComponent(hit.docSlug)}`;

  return html`<li class="hit">
      <a class="hit-head" href="${safe(esc(to))}">
        <span class="hit-doc">${hit.docId}</span>
        <span class="hit-where">${hit.sectionN ? html`${String(hit.sectionN)}. ${hit.sectionTitle}` : hit.docTitle}</span>
        ${hit.ref ? html`<span class="hit-ref">${hit.ref}</span>` : ''}
      </a>
      <p class="hit-text">${cut.cutStart ? '… ' : ''}${marked(cut.text, wanted)}${cut.cutEnd ? ' …' : ''}</p>
    </li>`;
}

function documentsPanel(docs) {
  return html`<section class="panel">
      ${panelHead('The six documents', 'live', 'Live · data/handbook')}
      <ul class="doc-grid">${join(docs.map(documentCard))}</ul>
    </section>`;
}

/**
 * A search, rendered.
 *
 * The count leads, then the passages. Each one is a link to the heading it
 * sits under rather than to the top of its document, because "it is in the
 * Order Handbook somewhere" is not an answer to anybody standing up with a
 * client waiting.
 */
function renderSearch(ctx, docs, query, found) {
  const wanted = found.terms;
  const hitDocs = found.inDocs || [];

  const lede = html`<div class="figure">
      <span class="cap">Passages matching ${join(wanted.map((t) => html`<mark>${t}</mark>`), ' ')}</span>
      <strong class="big">${num(found.total)}</strong>
      <p class="sub">
        in <b>${num(hitDocs.length)}</b> of ${num(found.scanned)} documents.
        ${found.total > found.hits.length
          ? html`The best ${num(found.hits.length)} are below, strongest first.`
          : 'Strongest first.'}
        Each one links to the heading it sits under, not to the top of the document.
      </p>
    </div>`;

  const gap = found.absent && found.absent.length
    ? html`<p class="note note--neg">
        ${glyph('crit')} <strong>${join(found.absent.map((id) => html`${id}`), ', ')}
        could not be read</strong>, so this search covered ${num(found.scanned)} documents, not
        ${num(docs.length)}. A phrase that lives only in the missing one will not appear here.
      </p>`
    : '';

  const body = !found.hits.length
    ? html`${empty(
        `No passage in the ${found.scanned} readable documents contains that. Try one word instead of three, or a word the documents themselves would use: revision, brief, quotation, cancellation, package.`
      )}`
    : html`${found.widened
          ? html`<p class="note note--warn">
              ${glyph('warn')} <strong>No passage contains all of those words.</strong> These contain at
              least one of them, so this answers a wider question than the one asked. The closest are
              still first.
            </p>`
          : ''}
        <ul class="hits">${join(found.hits.map((h) => hitRow(h, wanted)))}</ul>
        ${found.total > found.hits.length
          ? html`<p class="tablehint">
              ${num(found.total - found.hits.length)} further matches not shown. Add a word to narrow it.
            </p>`
          : ''}`;

  return {
    kicker: 'Handbook search',
    title: found.total
      ? `${found.total} passage${found.total === 1 ? '' : 's'} match “${query}”`
      : `Nothing in the handbook says “${query}”`,
    html: html`${lede}
      ${searchBar(query)}
      ${gap}
      <section class="panel">
        ${panelHead(
          html`Where ${join(wanted.map((t) => html`<mark>${t}</mark>`), ' ')} appears`,
          'live',
          'Live · data/handbook'
        )}
        ${body}
      </section>
      ${documentsPanel(docs)}`,
  };
}

function renderIndex(ctx, docs, query) {
  const readable = docs.filter((d) => d.present && d.ok);
  const absent = docs.filter((d) => !d.present);
  const plain = docs.filter((d) => d.present && !d.ok);
  const sections = readable.reduce((n, d) => n + d.sections.length, 0);
  const words = docs.reduce((n, d) => n + (d.words || 0), 0);

  const state =
    absent.length === 0 && plain.length === 0
      ? pill('ok', 'All six readable')
      : absent.length
        ? pill('crit', `${absent.length} not on disk`)
        : pill('warn', `${plain.length} plain text only`);

  // The headline states what is actually readable, not what the set is meant
  // to hold. "44 sections across 6 documents" over a page where two of them
  // failed to load is the kind of true-looking sentence this hub exists to
  // stop: it is the same claim whether nothing is wrong or a third of the
  // handbook is gone.
  const whole = readable.length === docs.length;

  return {
    kicker: 'Handbook',
    title: sections
      ? whole
        ? `${sections} sections you can jump to, across ${docs.length} documents`
        : `${sections} sections you can jump to, in ${readable.length} of ${docs.length} documents`
      : 'The handbook could not be read',
    html: html`<div class="lede">
        <div class="lede-main">
          <div class="figure">
            <span class="cap">The set</span>
            <strong class="big">${num(sections)}</strong>
            <p class="sub">
              sections across <b>${num(docs.length)}</b> documents and ${num(words)} words. Search runs over
              every one of them at once and shows you the passage with the heading it sits under, so you
              can read the rule without working out which document it lives in.
            </p>
          </div>
          ${searchBar(query)}
        </div>
        <div class="lede-side">
          <div class="figure">
            <span class="cap">Readable now</span>
            <strong class="mid">${num(readable.length)}<span class="caption"> / ${String(docs.length)}</span></strong>
            <p class="sub">${state}</p>
          </div>
          ${absent.length
            ? html`<p class="note note--neg">
                ${join(absent.map((d) => html`<span><strong>${d.id}</strong> ${d.reason}</span>`), ' ')}
              </p>`
            : ''}
          ${why(
            'Where these come from, and what search actually reads',
            html`<p>
                They are the owner's six PDFs, extracted to text and committed under
                <code class="mono">data/handbook/</code>. The hub reads them and never writes to them, the
                same rule that applies to the order and inquiry sheets.
              </p>
              <p>
                A count of six is a <strong>census</strong>, not a sample, so the figure above carries no
                interval and draws no bar. Six of six is a fact about the set, not an estimate of anything.
              </p>
              <p>
                The contents lists come from the headings found in each document's own body, not from its
                printed contents page. That way a link can never point at a heading the document does not
                have. Page numbers and running heads are dropped, because a phone has no pages.
              </p>
              <p>
                Figures quoted inside these documents were true on their issue date, which is printed on
                every card. They are document text and nothing here lifts them into a hub number, the
                engine is the only source for what those figures are today.
              </p>`
          )}
        </div>
      </div>

      ${documentsPanel(docs)}`,
  };
}

// ============================================================================
// render
// ============================================================================

export function render(ctx) {
  const docs = ctx.data?.docs ?? null;
  const doc = ctx.data?.doc ?? null;
  const docId = ctx.data?.docId ?? null;
  const query = ctx.data?.query ?? '';
  const found = ctx.data?.results ?? null;

  // ---- the loader could not read the directory at all ----------------------
  if (!Array.isArray(docs) || !docs.length) {
    return {
      kicker: 'Handbook',
      title: 'The handbook could not be read',
      html: html`<div class="figure">
          <span class="cap">Documents</span>
          <strong class="mid">${missing()}</strong>
          <p class="sub">
            The six text files are committed to this repository and shipped with it. If none of them is on
            disk, this deploy did not carry <code class="mono">data/handbook/</code>. Nothing typed into the
            hub is affected and no other section depends on these files.
          </p>
        </div>`,
    };
  }

  // ---- a link to a document that is not in the set ------------------------
  if (docId && !doc) {
    return {
      kicker: 'Handbook',
      title: 'No document with that name',
      html: html`<p class="note note--warn">
          ${glyph('warn')} A link pointed at <code class="mono">/handbook/${docId}</code> and nothing in the
          set answers to it. The six documents are named by their code, <code class="mono">om-01</code> to
          <code class="mono">cp-01</code>.
        </p>
        ${searchBar(query)}
        ${documentsPanel(docs)}`,
    };
  }

  if (doc) return renderDocument(ctx, doc, query);
  if (found) return renderSearch(ctx, docs, query, found);
  return renderIndex(ctx, docs, query);
}

export default render;
