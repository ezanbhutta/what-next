// views/responses.js, the reply library, searchable.
//
// WHAT THIS PAGE IS
//
//   Every canned reply the team has, in one place, searchable across its name,
//   its body and the note about when to use it. Grouped by category, because
//   that is how somebody looks for one: not "find reply #34" but "what do I
//   send a buyer who has gone quiet".
//
//   It is the only section whose subject lives ENTIRELY in the typed store.
//   `response` is a MySQL table; nothing here comes out of the engine except
//   the demand figures in the lede, which say how many messages are actually
//   waiting to be written today. So when the database is unreachable this page
//   has no content at all, and it says MISSING rather than rendering a blank
//   page that reads as "we have no replies".
//
// THE TOKEN RULE
//
//   `{username}` is left standing in every body shown here, and the copy button
//   copies exactly what is on screen, token included. Messages substitutes it,
//   because Messages knows which buyer it is talking about. This page does not,
//   and a half-substituted message is the one that gets screenshotted. Marking
//   the token is not decoration: an unfilled `{price}` reads as ordinary prose
//   until it is in somebody's inbox.
//
// WHAT `uses` COUNTS, AND WHY THE PAGE SAYS SO
//
//   server.js increments `response.uses` when a send is LOGGED against a buyer,
//   and this page increments it again when a reply is COPIED. So the column
//   means "taken out of the library", not "messages a buyer received", one
//   number with two producers. It is labelled `taken` here and the difference
//   is stated in the open rather than left for somebody to discover by
//   comparing it against client_note six months from now.
//
// HOUSE RULES THIS FILE IS CARRYING
//
//   R2  An unreachable table is MISSING. An empty table is "the library has not
//       been imported yet" and names the file it comes from. Those are three
//       different screens and none of them is a zero.
//   R3  Nothing on this page is a rate. The counts are a census of a complete
//       list, and the caption says so, so no bar and no interval appear.
//   R6  A review request must never ride on a late or cold order. This page
//       cannot check that, no buyer is chosen here, so every reply that asks
//       for a review is marked, and the mark says where the check does happen.
//   R7  The figure leads. Every explanation is in a <details> underneath it.
//   R8  Add, edit, deactivate and copy all post through the audited writes in
//       server.js. There is no write on this page that is not attributed.

import {
  html,
  join,
  safe,
  missing,
  num,
  money,
  days,
  dateTimeShort,
  glyph,
  pill,
  panelHead,
  why,
  info,
  empty,
  known,
} from './layout.js';
import { pick } from '../lib/data.js';

// ============================================================================
// 1. VOCABULARY
// ============================================================================

/** Where a reply came from. The enum is fiverr | extra | hub, see db/schema.sql. */
// WHERE THE REPLY LIVES, which is not the same question as where it came from.
//
// The old labels answered provenance: Fiverr, Extra, Hub. A CSR mid-conversation
// does not need to know where a line was born; they need to know whether it is
// two taps away inside Fiverr's own reply box or has to be copied out of here.
// Getting that wrong costs either a hunt through Fiverr for something that was
// never saved, or retyping something that was.
//
// Fiverr has no API for its saved replies, so this is typed by a person and
// read by everything else. `extra` and `hub` are both "only here" and are kept
// apart only so an import can still tell what it wrote.
const SOURCE = {
  fiverr: {
    label: 'In Fiverr',
    glyph: 'ok',
    what: "also saved in Fiverr's quick-replies, so it can be sent from there",
  },
  extra: {
    label: 'Hub only',
    glyph: 'idle',
    what: 'lives only in this hub, so it has to be copied from here',
  },
  hub: {
    label: 'Hub only',
    glyph: 'idle',
    what: 'written here, with a name against it in the audit log, and not saved in Fiverr',
  },
};

/** The file db/seed.js imports the library from. Named on the empty state so
 *  "there are no replies" can never be mistaken for "nobody has any". */
const IMPORT_FILE = 'data/responses.json';

/**
 * Does this reply ask for a review?
 *
 * The same test views/messages.js applies, deliberately broad: a false positive
 * costs one line of explanation on a template that was safe anyway, a false
 * negative puts a review ask in front of a buyer whose order is 268 days late.
 * Those are not comparable costs.
 *
 * NOTE: this pattern exists in two files now. It is a RULE, not a figure, so it
 * does not break the one-copy-of-every-number rule, but it should be lifted
 * into a shared module the next time either file is touched, because a rule
 * that drifts is the same failure one step later.
 */
const REVIEW_ASK =
  /\breviews?\b|\brating\b|\brate\s+(?:us|your|the|this|our)\b|\b\d\s*stars?\b|\bfive[-\s]star\b|\bleave\s+(?:us\s+)?(?:a|your)\b|\bfeedback\s+on\s+fiverr\b/i;

function asksForReview(row) {
  const text = [row.name, row.category, row.when_to_use, row.body].filter(Boolean).join(', ');
  return REVIEW_ASK.test(text);
}

/** Words that suggest a reply is for a buyer who has gone quiet. A KEYWORD
 *  match, not a taxonomy, the table has no field that says which situation a
 *  reply belongs to, and the caption that renders this says so. */
const FOLLOWUP_HINT = /follow[\s-]?up|check[\s-]?in|chase|nudge|quiet|no reply|reminder|still interested/i;

function looksLikeFollowUp(row) {
  return FOLLOWUP_HINT.test([row.name, row.category, row.when_to_use].filter(Boolean).join(', '));
}

// ============================================================================
// 2. FILTERS, they live in the URL, so a filtered library is a link
// ============================================================================

const STATES = ['active', 'retired', 'all'];

function readFilters(query = {}) {
  const s = (v, max = 80) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const state = STATES.includes(s(query.state)) ? s(query.state) : 'active';
  return {
    q: s(query.q, 120),
    category: s(query.category, 60),
    source: Object.keys(SOURCE).includes(s(query.source)) ? s(query.source) : '',
    // 'active' is the default and therefore never written into a link.
    state: state === 'active' ? '' : state,
  };
}

function href(filters, overrides = {}) {
  const merged = { ...filters, ...overrides };
  const parts = Object.entries(merged)
    .filter(([, v]) => v !== '' && v !== null && v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  return parts.length ? `/responses?${parts.join('&')}` : '/responses';
}

function anyFilter(f) {
  return Object.values(f).some((v) => v !== '');
}

/** The state a row must be in to pass. '' means active-only (the default). */
function stateAllows(row, state) {
  if (state === 'all') return true;
  if (state === 'retired') return Number(row.active) !== 1;
  return Number(row.active) === 1;
}

function matches(row, f) {
  if (!stateAllows(row, f.state)) return false;
  if (f.source && String(row.source ?? '') !== f.source) return false;
  if (f.category) {
    const cat = String(row.category ?? '').trim();
    if (f.category === '__none' ? cat !== '' : cat !== f.category) return false;
  }
  if (f.q) {
    // Name, body and when-to-use. The body is in the haystack on purpose: the
    // reply somebody wants is usually remembered by a phrase inside it, not by
    // whatever it was filed under.
    const hay = [row.name, row.body, row.when_to_use, row.category]
      .filter((v) => v != null)
      .join(' \n ')
      .toLowerCase();
    if (!hay.includes(f.q.toLowerCase())) return false;
  }
  return true;
}

// ============================================================================
// 3. THE BODY, WITH ITS TOKENS LEFT STANDING
// ============================================================================

const TOKEN = /\{([a-z0-9_]+)\}/gi;

/**
 * Mark every `{token}` in a body without substituting any of them.
 *
 * The rendered text is character-for-character the stored body, which is what
 * makes the copy button honest: it reads `textContent` off this element, so
 * what lands on the clipboard is exactly what is on screen, token included.
 * Nothing here may start inserting or removing characters.
 */
function markTokens(body) {
  const text = String(body ?? '');
  const parts = [];
  const tokens = new Set();
  let last = 0;

  for (const m of text.matchAll(TOKEN)) {
    parts.push(text.slice(last, m.index));
    tokens.add(m[0]);
    parts.push(html`<span class="var">${m[0]}</span>`);
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));

  return { html: join(parts), tokens: [...tokens] };
}

// ============================================================================
// 4. THE LEDE, the library, and the demand for it
// ============================================================================

function libraryFigure(counts) {
  return html`<div class="figure">
      <span class="cap">Replies ready to send</span>
      <strong class="big">${num(counts.active)}</strong>
      <p class="sub">
        ${counts.categories
          ? html`across <b>${num(counts.categories)}</b> categor${counts.categories === 1 ? 'y' : 'ies'}.`
          : html`and not one of them is filed under a category, the search is the only way in.`}
        ${counts.retired
          ? html`<b>${num(counts.retired)}</b> more ${counts.retired === 1 ? 'is' : 'are'} retired and still
              readable.`
          : ''}
        ${counts.untaken
          ? html`<b>${num(counts.untaken)}</b> ${counts.untaken === 1 ? 'has' : 'have'} never been taken out
              of the library.`
          : ''}
      </p>
    </div>
    ${why(
      'What "taken" counts, and what it does not',
      html`<p>
          <strong>${num(counts.taken)}</strong> is every time a reply left this library, copied here, or
          logged as a send against a buyer on Messages. It is <em>not</em> a count of messages a buyer
          received. Two things move one column, so a reply copied five times and never sent reads exactly
          like one sent five times.
        </p>
        <p>
          The count that means "a buyer was actually told this" lives in <code class="mono">client_note</code>
          and is on the Messages page, keyed to the buyer. If the two ever need to be told apart, that is the
          table to ask, not this number.
        </p>
        <p>
          <strong>${num(counts.active)} of ${num(counts.total)}</strong> is a census of a complete list, not a
          sample of one. There is no interval on it and nothing here draws a bar.
        </p>`
    )}`;
}

function demandFigure(run, rows) {
  const staleCount = pick(run, 'recovery.open_orders.stale_count');
  const staleAfter = pick(run, 'recovery.open_orders.stale_after_days');
  const staleValue = pick(run, 'recovery.open_orders.stale_value');
  const untouched = pick(run, 'recovery.quotes.untouched_count');
  const untouchedValue = pick(run, 'recovery.quotes.untouched_value');
  const waiting =
    known(staleCount) && known(untouched) ? Number(staleCount) + Number(untouched) : null;

  const followUps = rows.filter((r) => Number(r.active) === 1 && looksLikeFollowUp(r)).length;

  return html`<div class="figure">
      <span class="cap">Buyers waiting for a message</span>
      <strong class="mid">${waiting === null ? missing() : num(waiting)}</strong>
      <p class="sub">
        <b>${num(staleCount)}</b> orders open past ${days(staleAfter)} holding ${money(staleValue)}, and
        <b>${num(untouched)}</b> quotes nobody ever followed up holding ${money(untouchedValue)}. That is
        what this library is for.
      </p>
    </div>
    <p class="note note--neg">
      ${glyph('crit')} <b>Sort before you send.</b> A late order is one of three different problems, we owe
      work, they owe a reply, or it is dead, and only one of them takes a check-in. The bucket is on the
      <a href="/orders">Orders</a> page. No reply on this page knows which bucket a buyer is in.
    </p>
    ${why(
      'Whether the library covers what is waiting',
      html`<p>
          <strong>${num(followUps)}</strong> active repl${followUps === 1 ? 'y reads' : 'ies read'} like a
          follow-up, that is a keyword match on the name, category and when-to-use note, not a taxonomy.
          The <code class="mono">response</code> table has no field that says which situation a reply is
          for, so this is a hint about coverage and nothing may be costed on it.
        </p>
        <p>
          Of the quoted leads anyone did chase, the conversion <em>within</em> the chased group is what the
          chase is worth, the leads with no logged follow-up look better only because a follow-up gets
          logged exactly when the buyer did not say yes immediately. The figure is on Today; never read the
          raw split as if chasing were harmful.
        </p>`
    )}`;
}

// ============================================================================
// 5. ONE REPLY
// ============================================================================

function snippet(row, { ctx, back }) {
  const id = String(row.id);
  const bodyId = `reply-body-${id}`;
  const marked = markTokens(row.body);
  const retired = Number(row.active) !== 1;
  const spec = SOURCE[String(row.source ?? '')] || null;
  const reviewAsk = asksForReview(row);
  const others = marked.tokens.filter((t) => t.toLowerCase() !== '{username}');

  return html`<article class="snippet" id="reply-${safe(id)}">
      <div class="snippet-head">
        <h4>${row.name}</h4>
        ${spec ? pill(spec.glyph, spec.label) : html`<span class="pill pill--idle">${glyph('idle')}Source ${missing()}</span>`}
        ${retired ? pill('idle', 'Retired') : ''}
        ${reviewAsk ? pill('warn', 'Review ask') : ''}
        <span class="uses">${num(row.uses)} taken</span>
      </div>

      <p class="snippet-body" id="${bodyId}">${marked.html}</p>

      ${row.when_to_use ? html`<p class="caption">When to use, ${row.when_to_use}</p>` : ''}

      ${marked.tokens.length
        ? html`<p class="caption">
            ${join(marked.tokens.map((t) => html`<code class="mono">${t}</code>`), ' · ')} stay${
              marked.tokens.length === 1 ? 's' : ''
            } as written. Copying takes ${marked.tokens.length === 1 ? 'it' : 'them'} along, so a
            half-substituted message is impossible to send by accident.${others.length
              ? html` Messages fills <code class="mono">{username}</code> from the buyer it is open on;
                  ${join(others.map((t) => html`<code class="mono">${t}</code>`), ' and ')} nothing fills, 
                  ${others.length === 1 ? 'it' : 'they'} must be typed by hand.`
              : ''}
          </p>`
        : ''}

      ${reviewAsk
        ? html`<p class="note note--warn">
            ${glyph('warn')} <b>This asks for a review.</b> It must never go to a late or cold order, a
            review ask on a late delivery is the most reliable way to turn a private three-star into a
            public one. This page cannot check that, because no buyer is chosen here; open the buyer on
            <a href="/messages">Messages</a> and it checks before it offers.
          </p>`
        : ''}

      <div class="btnrow snippet-actions">
        <form method="post" action="/responses/copy" data-copy="${bodyId}">
          <input type="hidden" name="_csrf" value="${ctx.csrfToken}">
          <input type="hidden" name="id" value="${id}">
          <input type="hidden" name="back" value="${back}">
          <button class="btn btn--sm js-copy" type="submit" hidden>Copy this reply</button>
          <span class="form-status" data-copy-status role="status"></span>
        </form>

        <form method="post" action="/responses/toggle">
          <input type="hidden" name="_csrf" value="${ctx.csrfToken}">
          <input type="hidden" name="id" value="${id}">
          <input type="hidden" name="active" value="${retired ? '1' : '0'}">
          <input type="hidden" name="back" value="${back}">
          <button class="btn btn--sm ${safe(retired ? '' : 'btn--danger')}" type="submit">
            ${retired ? 'Put back in use' : 'Retire this reply'}
          </button>
        </form>
      </div>

      ${why('Edit this reply', editForm({ ctx, row, back }))}

      <form method="post" action="/responses/${safe(id)}/where" class="where-toggle">
        <input type="hidden" name="_csrf" value="${ctx.csrfToken}">
        <input type="hidden" name="back" value="${back}">
        <input type="hidden" name="where" value="${String(row.source) === 'fiverr' ? 'extra' : 'fiverr'}">
        <button class="btn btn--ghost btn--sm" type="submit">
          ${String(row.source) === 'fiverr'
            ? 'Not saved in Fiverr after all'
            : 'This one is saved in Fiverr'}
        </button>
      </form>

      <p class="caption">
        ${spec ? html`${spec.label}, ${spec.what}.` : html`This reply carries no source.`}
        Last changed ${row.updated_at ? dateTimeShort(row.updated_at) : missing()}.
      </p>
    </article>`;
}

function editForm({ ctx, row, back }) {
  const id = String(row.id);
  return html`<form method="post" action="/responses" class="stack-sm">
      <input type="hidden" name="_csrf" value="${ctx.csrfToken}">
      <input type="hidden" name="id" value="${id}">
      <input type="hidden" name="back" value="${back}">
      <div class="form-grid form-grid--two">
        <div class="field">
          <label for="name-${safe(id)}">Name <span class="req">*</span></label>
          <input id="name-${safe(id)}" name="name" value="${row.name}" maxlength="120" required>
          <p class="field-hint">Names are unique. Renaming this to a name that already exists is refused.</p>
        </div>
        <div class="field">
          <label for="cat-${safe(id)}">Category</label>
          <input id="cat-${safe(id)}" name="category" value="${row.category ?? ''}" maxlength="60">
          <p class="field-hint">What situation it is for. Blank files it under "not categorised".</p>
        </div>
      </div>
      <div class="field">
        <label for="when-${safe(id)}">When to use</label>
        <textarea id="when-${safe(id)}" name="when_to_use" rows="2">${row.when_to_use ?? ''}</textarea>
        <p class="field-hint">Searched along with the name and the body. One sentence is enough.</p>
      </div>
      <div class="field">
        <label for="body-${safe(id)}">The reply <span class="req">*</span></label>
        <textarea id="body-${safe(id)}" name="body" rows="9" required>${row.body}</textarea>
        <p class="field-hint">
          Leave <code class="mono">{username}</code> exactly as it is. Messages substitutes it per buyer.
          Typing a name here makes the reply usable for one person only.
        </p>
      </div>
      <div class="form-actions">
        <button class="btn" type="submit">Save this reply</button>
        <span class="form-status">Saved with your name against it, in one transaction with the audit row.</span>
      </div>
    </form>`;
}

// ============================================================================
// 6. THE GROUPS
// ============================================================================

// The group key for a reply with no category. An OBJECT, not a string: any
// string sentinel is a category somebody could type, and the day they do the
// two groups merge silently. Identity cannot collide with typed text.
const UNFILED = Object.freeze({ unfiled: true });

function groupByCategory(rows) {
  const groups = new Map();
  for (const row of rows) {
    const cat = String(row.category ?? '').trim();
    const key = cat === '' ? UNFILED : cat;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const ordered = [...groups.entries()].sort((a, b) => {
    if (a[0] === UNFILED) return 1;
    if (b[0] === UNFILED) return -1;
    return a[0].localeCompare(b[0], 'en');
  });

  for (const [, list] of ordered) {
    list.sort((x, y) => {
      const activeDelta = (Number(y.active) === 1 ? 1 : 0) - (Number(x.active) === 1 ? 1 : 0);
      if (activeDelta) return activeDelta;
      const useDelta = (Number(y.uses) || 0) - (Number(x.uses) || 0);
      if (useDelta) return useDelta;
      return String(x.name).localeCompare(String(y.name), 'en');
    });
  }
  return ordered;
}

// ============================================================================
// 7. THE SEARCH BAR
// ============================================================================

function toolbar(filters, categories, shown, total) {
  const state = filters.state || 'active';
  return html`<div class="segment" role="group" aria-label="Which replies to show">
      <a href="${href(filters, { state: '' })}" ${safe(state === 'active' ? 'aria-current="true"' : '')}>In use</a>
      <a href="${href(filters, { state: 'retired' })}" ${safe(state === 'retired' ? 'aria-current="true"' : '')}>Retired</a>
      <a href="${href(filters, { state: 'all' })}" ${safe(state === 'all' ? 'aria-current="true"' : '')}>Everything</a>
    </div>

    <form class="toolbar" method="get" action="/responses">
      <span class="search">
        <label class="sr-only" for="rq">Search the library</label>
        <input type="search" id="rq" name="q" value="${filters.q}"
               placeholder="Search name, body or when to use">
      </span>
      <span class="field">
        <label for="f-cat">Category</label>
        <select id="f-cat" name="category">
          <option value="">Any</option>
          ${join(
            categories.map(
              (c) => html`<option value="${c}" ${safe(filters.category === c ? 'selected' : '')}>${c}</option>`
            )
          )}
          <option value="__none" ${safe(filters.category === '__none' ? 'selected' : '')}>Not categorised</option>
        </select>
      </span>
      <span class="field">
        <label for="f-src">Source</label>
        <select id="f-src" name="source">
          <option value="">Any</option>
          ${join(
            Object.entries(SOURCE).map(
              ([key, s]) =>
                html`<option value="${key}" ${safe(filters.source === key ? 'selected' : '')}>${s.label}</option>`
            )
          )}
        </select>
      </span>
      ${filters.state ? html`<input type="hidden" name="state" value="${filters.state}">` : ''}
      <button class="btn btn--sm" type="submit">Search</button>
      ${anyFilter(filters) ? html`<a class="btn btn--ghost btn--sm" href="/responses">Clear</a>` : ''}
      <span class="count">${String(shown)} of ${String(total)}</span>
    </form>`;
}

// ============================================================================
// 8. ADD A REPLY
// ============================================================================

// Reached only when the table answered, so there is always something to write
// to. The unreachable case is handled once, at the top of render(), by not
// drawing the page at all, a form that accepted text and dropped it would be
// worse than no form.
function addPanel(ctx, back) {
  return html`<section class="panel">
      ${panelHead('Add a reply', 'typed', 'Typed here · MySQL · source hub')}
      <div class="field">
        <label for="new-kind">What kind</label>
        <select id="new-kind" name="kind">
          <option value="quick" selected>Quick response, a whole message ready to send</option>
          <option value="case">Case, one line answering one thing a buyer said</option>
        </select>
      </div>
      <form method="post" action="/responses" class="stack-sm">
        <input type="hidden" name="_csrf" value="${ctx.csrfToken}">
        <input type="hidden" name="back" value="${back}">
        <div class="form-grid form-grid--two">
          <div class="field">
            <label for="new-name">Name <span class="req">*</span></label>
            <input id="new-name" name="name" maxlength="120" required
                   placeholder="Delivery is late, dated commitment">
            <p class="field-hint">
              Names are unique. Saving under a name that already exists <b>replaces that reply's text</b>
              rather than adding a second one, check the library above first.
            </p>
          </div>
          <div class="field">
            <label for="new-cat">Category</label>
            <input id="new-cat" name="category" maxlength="60" placeholder="Late orders">
            <p class="field-hint">The heading it will be filed under. Blank is allowed and searchable.</p>
          </div>
        </div>
        <div class="field">
          <label for="new-when">When to use</label>
          <textarea id="new-when" name="when_to_use" rows="2"
                    placeholder="The buyer has paid, the work has not landed, and they have not asked yet."></textarea>
          <p class="field-hint">Searched along with the name and the body.</p>
        </div>
        <div class="field">
          <label for="new-body">The reply <span class="req">*</span></label>
          <textarea id="new-body" name="body" rows="9" required
                    placeholder="Hi {username}, …"></textarea>
          <p class="field-hint">
            Write <code class="mono">{username}</code> where the buyer's Fiverr username goes. It is left
            standing everywhere on this page and filled in only on Messages, where the buyer is known.
          </p>
        </div>
        <div class="form-actions">
          <button class="btn" type="submit">Add to the library</button>
          <span class="form-status">Stored as source <b>hub</b>, with your name in the audit log.</span>
        </div>
      </form>
    </section>`;
}

// ============================================================================
// 9. THE COPY BEHAVIOUR
// ============================================================================
//
// The button is rendered `hidden` and this script un-hides it. Without
// JavaScript there is no copy button at all, and that is deliberate. A button
// that posted "taken" without putting anything on the clipboard would move a
// count for something that did not happen, which is the one thing this hub is
// built not to do. The text is selectable in place either way.
//
// The clipboard write happens BEFORE the form posts, and the post only happens
// if the write succeeded. If the browser refuses (an insecure origin, a denied
// permission), the text is selected instead, the row says so, and the count
// does not move.
//
// The copied text is `textContent` of the rendered body, so what lands on the
// clipboard is character-for-character what is on screen, `{username}` and all.

const COPY_JS = `
(function(){
  'use strict';
  var buttons = document.querySelectorAll('form[data-copy] .js-copy');
  if (!buttons.length) return;
  Array.prototype.forEach.call(buttons, function(b){ b.hidden = false; });

  function say(form, text, bad){
    var slot = form.querySelector('[data-copy-status]');
    if (!slot) return;
    slot.textContent = text;
    slot.className = 'form-status ' + (bad ? 'is-bad' : 'is-ok');
  }

  function selectNode(node){
    try {
      var range = document.createRange();
      range.selectNodeContents(node);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) {}
  }

  function legacyCopy(text){
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }

  document.addEventListener('submit', function(e){
    var form = e.target;
    if (!form || !form.getAttribute || !form.getAttribute('data-copy')) return;
    var node = document.getElementById(form.getAttribute('data-copy'));
    if (!node) return;

    e.preventDefault();
    var text = node.textContent;

    function done(ok){
      if (ok) { say(form, 'Copied, recording it', false); form.submit(); }
      else { selectNode(node); say(form, 'Clipboard refused, the text is selected, copy it by hand. Nothing was counted.', true); }
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function(){ done(true); },
                                              function(){ done(legacyCopy(text)); });
    } else {
      done(legacyCopy(text));
    }
  });
})();
`;

// ============================================================================
// 10. RENDER
// ============================================================================

export function render(ctx) {
  const result = ctx.data?.rows ?? null;
  const rows = result && result.ok ? result.rows : null;
  const filters = readFilters(ctx.query || {});
  const back = href(filters);

  // ---- the table could not be read. Not empty. MISSING. -------------------
  if (!Array.isArray(rows)) {
    return {
      title: 'The reply library cannot be read',
      kicker: 'Responses',
      html: html`<div class="figure">
          <span class="cap">Replies on record</span>
          <strong class="big">${missing()}</strong>
          <p class="sub">
            The <code class="mono">response</code> table is unreachable, so the hub cannot say how many
            replies exist, which are retired, or what any of them says. Nothing has been lost, this page
            holds no copy of the library and never did.
          </p>
        </div>
        <p class="note note--neg">
          ${glyph('crit')} A blank page here would read as "we have no canned replies", which is exactly the
          wrong thing to believe five minutes before answering a buyer. Every other section that reads from
          <code class="mono">data/</code> still works.
        </p>
        ${ctx.dbNotice ? html`<p class="note note--warn">${ctx.dbNotice}</p>` : ''}`,
    };
  }

  const counts = {
    total: rows.length,
    active: rows.filter((r) => Number(r.active) === 1).length,
    retired: rows.filter((r) => Number(r.active) !== 1).length,
    // Real categories only. A blank one is not a category with no name, it is
    // a reply nobody filed, counting it would inflate the heading by one on
    // any library that has a single unfiled reply in it.
    categories: new Set(
      rows
        .filter((r) => Number(r.active) === 1)
        .map((r) => String(r.category ?? '').trim())
        .filter(Boolean)
    ).size,
    taken: rows.reduce((n, r) => n + (Number(r.uses) || 0), 0),
    untaken: rows.filter((r) => Number(r.active) === 1 && !(Number(r.uses) > 0)).length,
  };

  // ---- the table is there and holds nothing. That is a fact, and it has a
  //      cause: the import has not been run. Name the file. ------------------
  if (rows.length === 0) {
    return {
      title: 'The reply library has not been imported yet',
      kicker: 'Responses',
      html: html`<div class="figure">
          <span class="cap">Replies on record</span>
          <strong class="big">${num(0)}</strong>
          ${info(`The table answered, and it is empty. Every reply the team already uses lives in Fiverr's saved quick-replies and in the extra-responses sheet beside it; neither has been loaded into the hub.`)}
        </div>
        <section class="panel">
          ${panelHead('How the library gets here', 'typed', 'Typed store · response · 0 rows')}
          <ol class="steps">
            <li>
              Export the saved replies and the extra-responses sheet into
              <code class="mono">${IMPORT_FILE}</code>, a list of
              <code class="mono">{ name, body, when_to_use, category, source }</code>, where
              <code class="mono">source</code> is <code class="mono">fiverr</code> or
              <code class="mono">extra</code>.
            </li>
            <li>
              Run <code class="mono">npm run seed</code>. It inserts what is missing and overwrites nothing;
              <code class="mono">npm run seed -- --refresh-responses</code> also refreshes imported text, and
              never touches a reply written here.
            </li>
            <li>Rows with no name or an empty body are skipped rather than imported as placeholders.</li>
          </ol>
          ${info(`db/seed.js is the importer. Nothing writes back to the sheet or to Fiverr; the hub reads and this table is its own copy.`)}
        </section>
        ${addPanel(ctx, back)}
        <p class="note">
          A reply added here is stamped <code class="mono">hub</code>, and the import will never overwrite
          it. That is the difference between the two: imported text can be refreshed, written text cannot be
          taken away by a deploy.
        </p>`,
      ticker: [
        { label: 'Replies on record', value: num(0), sub: 'table answered' },
        { label: 'Import file', value: html`<code class="mono">responses.json</code>`, sub: 'not loaded' },
        { label: 'Categories', value: num(0) },
        { label: 'Times taken', value: num(0) },
        { label: 'Retired', value: num(0) },
        {
          label: 'Buyers waiting',
          value: (() => {
            const s = pick(ctx.run, 'recovery.open_orders.stale_count');
            const u = pick(ctx.run, 'recovery.quotes.untouched_count');
            return known(s) && known(u) ? num(Number(s) + Number(u)) : missing();
          })(),
          sub: 'late orders + cold quotes',
        },
      ],
    };
  }

  // ---- the library, filtered and grouped ----------------------------------
  const categories = [
    ...new Set(rows.map((r) => String(r.category ?? '').trim()).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b, 'en'));

  const visible = rows.filter((r) => matches(r, filters));
  const groups = groupByCategory(visible);

  const reviewAsks = rows.filter((r) => Number(r.active) === 1 && asksForReview(r)).length;

  const groupBlocks = groups.length
    ? join(
        groups.map(([key, list]) => {
          const unfiled = key === UNFILED;
          return html`<section class="block">
              <h3>
                ${unfiled ? 'Not categorised' : key}, ${num(list.length)}
                repl${list.length === 1 ? 'y' : 'ies'}
              </h3>
              ${unfiled
                ? html`${info(`These carry no category. The search still finds them by their words; the group heading is the only thing they are missing.`)}`
                : ''}
              ${join(list.map((row) => snippet(row, { ctx, back })))}
            </section>`;
        })
      )
    : empty(
        anyFilter(filters)
          ? 'No reply matches this search. The library is not empty, this selection is.'
          : 'No reply is in use. Every one of them is retired; switch to Retired or Everything to see them.'
      );

  const body = html`<div class="lede">
      <div class="lede-main">${libraryFigure(counts)}</div>
      <div class="lede-side">${demandFigure(ctx.run, rows)}</div>
    </div>

    <section class="panel">
      ${panelHead(
        html`The library, ${num(visible.length)} shown of ${num(rows.length)}`,
        'typed',
        html`Typed · response · ${num(counts.taken)} taken`
      )}
      ${toolbar(filters, categories, visible.length, rows.length)}

      ${reviewAsks
        ? html`<p class="note note--warn">
            ${glyph('warn')} <b>${num(reviewAsks)} of these ${reviewAsks === 1 ? 'asks' : 'ask'} for a
            review.</b> They are marked where they appear. None of them may go to a late or cold order, and
            this page cannot tell which buyer is which. Messages checks that per buyer before it offers one.
          </p>`
        : ''}

      ${groupBlocks}

      <div class="provenance-bar">
        <span>Every reply, typed, stored in <code class="mono">response</code>.</span>
        <span>The waiting figures, engine output, read from <code class="mono">data/latest-run.json</code>.</span>
        <span>Copying, editing and retiring all carry the name you signed in with.</span>
      </div>

      ${info(`The copy button needs JavaScript, and without it there is no button rather than one that counts a copy that did not happen, the text is selectable in place either way. Counts on this page are a census of a complete list, so none of them is a rate and none of them draws a bar.`)}
    </section>

    ${addPanel(ctx, back)}

    <script nonce="${ctx.nonce}">${safe(COPY_JS)}</script>`;

  return {
    title: `${counts.active} replies ready, ${counts.untaken} never used`,
    kicker: `Responses · ${counts.categories} categories`,
    ticker: [
      { label: 'In use', value: num(counts.active), sub: `of ${counts.total}` },
      { label: 'Categories', value: num(counts.categories) },
      { label: 'Times taken', value: num(counts.taken), sub: 'copied or sent' },
      { label: 'Never taken', value: num(counts.untaken), sub: 'in use, unused' },
      { label: 'Retired', value: num(counts.retired), sub: 'still readable' },
      {
        label: 'Buyers waiting',
        value: (() => {
          const s = pick(ctx.run, 'recovery.open_orders.stale_count');
          const u = pick(ctx.run, 'recovery.quotes.untouched_count');
          return known(s) && known(u) ? num(Number(s) + Number(u)) : missing();
        })(),
        sub: 'late orders + cold quotes',
      },
    ],
    html: body,
  };
}

export default render;
