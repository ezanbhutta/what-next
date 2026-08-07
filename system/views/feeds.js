// views/feeds.js, every input this business runs on, and whether it is current.
//
// WHY THIS PAGE EXISTS
//
//   Six feeds. Each individually checkable, none checked together, so the
//   honest answer to "is the system live?" was "open six things and work it
//   out". Nobody does that daily, which means the real answer was always
//   "probably".
//
//   On 2026-08-07 "probably" was wrong by an entire verdict. The engine on a
//   44-hour-old snapshot reported organic in BREACH at index 26. The same
//   engine, minutes later, on the live snapshot: HEALTHY at 79. Twelve orders
//   had landed in between and nothing on any page said which one you were
//   looking at.
//
// THREE STATES, AND THEY ARE NOT INTERCHANGEABLE
//
//   live         it answered and its newest data is recent enough to use
//   stale        it answered and its data has stopped moving
//   unreachable  it did not answer, or was never configured
//
//   `stale` means a person stopped filling something in. `unreachable` means a
//   credential or a service. Collapsing them into "not ok" sends whoever picks
//   it up to the wrong place, so they stay distinct and each row carries the
//   specific thing to do about it.
//
// WHERE THE ROWS COME FROM
//
//   Two halves, joined here. The engine checks what it owns (the snapshot
//   endpoint, the gig capture, the tracker) and writes the result into the run
//   JSON. The hub probes what it owns (the two Supabase stores) live on every
//   page load, because a credential should live in exactly one place and a
//   status page is not a good enough reason to copy one.
//
//   So the engine half is as fresh as the last run and says so, and the store
//   half is as fresh as this request.
//
// READ ONLY. Nothing on this page writes anywhere.

import { isMissing } from '../lib/data.js';

import {
  html,
  join,
  safe,
  missing,
  num,
  glyph,
  pill,
  panelHead,
  banner,
  why,
  info,
  empty,
  dateShort,
  dateTextOnly,
  statCard,
  statGrid,
} from './layout.js';

const TONE = { live: 'ok', stale: 'warn', unreachable: 'crit' };
const WORD = { live: 'Live', stale: 'Stale', unreachable: 'Unreachable' };

/** Worst-first. A page that leads with the healthy feeds is a page on which a
 *  broken feed stays broken. */
const RANK = { unreachable: 0, stale: 1, live: 2 };

function ageLabel(hours) {
  if (hours === null || hours === undefined) return missing();
  if (hours < 1) return html`under an hour`;
  if (hours < 48) return html`${num(Math.round(hours))} hours`;
  return html`${num(Math.round(hours / 24))} days`;
}

export function render(ctx) {
  const d = ctx.data || {};
  const engine = Array.isArray(d.engineFeeds) ? d.engineFeeds : null;
  const stores = Array.isArray(d.storeFeeds) ? d.storeFeeds : null;
  const runDate = d.runDate || null;

  // ---- neither half could be read -------------------------------------------
  if (engine === null && stores === null) {
    return {
      title: 'The feed check itself could not run',
      kicker: 'Feeds',
      ticker: [],
      html: html`${banner(
        'crit',
        'Neither the last run nor the live stores could be read.',
        html`This page is the one that is supposed to tell you when something is wrong, so it failing is
          its own kind of answer: treat every figure elsewhere in the hub as unverified until this comes
          back.`
      )}`,
    };
  }

  const rows = [...(engine || []), ...(stores || [])].sort(
    (a, b) => RANK[a.status] - RANK[b.status] || a.label.localeCompare(b.label)
  );

  const counts = { live: 0, stale: 0, unreachable: 0 };
  for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;

  // A HALF THAT COULD NOT BE READ IS NOT A CLEAN BILL OF HEALTH.
  //
  // The verdict was taken from the rows that arrived, so with the engine half
  // unreadable the page reported "All 2 feeds live" while four feeds were
  // simply absent from the table. That is the one direction this page must
  // never be wrong in: it converts "I should go and check" into "it said it
  // was fine". Caught by its own test before it shipped.
  const halfMissing = engine === null || stores === null;
  const worst = halfMissing ? 'unreachable' : rows.length ? rows[0].status : 'unreachable';

  // ---- the verdict ----------------------------------------------------------

  const verdictBanner = halfMissing
    ? banner(
        'crit',
        html`${engine === null && stores === null ? 'Neither half' : 'One half'} of the feed check could not be read.`,
        html`${num(rows.length)} feed${rows.length === 1 ? '' : 's'} reported and the rest are unknown, so
          this page cannot tell you the system is healthy. Unknown is not the same as fine.`
      )
    : worst === 'live'
      ? banner(
          'info',
          html`All ${num(rows.length)} feeds are current.`,
          html`Every figure in this hub is built on data that is moving. This is the state to expect and it
            is worth nothing unless the other two states are loud, which is why this page leads with the
            worst feed rather than with this line.`
        )
      : banner(
          worst === 'unreachable' ? 'crit' : 'warn',
          worst === 'unreachable'
            ? html`${num(counts.unreachable)} feed${counts.unreachable === 1 ? '' : 's'} cannot be reached.`
            : html`${num(counts.stale)} feed${counts.stale === 1 ? '' : 's'} ${counts.stale === 1 ? 'has' : 'have'} stopped moving.`,
          html`Anything computed from ${counts.unreachable + counts.stale === 1 ? 'it' : 'them'} describes
            the last day ${counts.unreachable + counts.stale === 1 ? 'it' : 'they'} had data for, whatever
            date is printed on the page. Each row below says what to do.`
        );

  // ---- the table ------------------------------------------------------------

  const table = html`<section class="panel">
      ${panelHead(
        html`Every feed, ${num(rows.length)}`,
        worst === 'live' ? 'live' : 'missing',
        runDate ? `Engine half as of the ${dateTextOnly(runDate)} run · stores probed just now` : 'Stores probed just now',
        'Worst first. A page that leads with the healthy feeds is a page on which a broken feed stays broken.'
      )}
      ${!rows.length
        ? empty('No feed reported at all.')
        : html`<div class="tablewrap">
            <table class="table table--wide">
              <thead>
                <tr><th>Feed</th><th>State</th><th>Newest data</th><th class="r">Age</th><th>Where it comes from</th></tr>
              </thead>
              <tbody>
                ${join(
                  rows.map(
                    (r) => html`<tr class="${safe(r.status === 'live' ? '' : r.status === 'stale' ? 'row-attn' : 'row-late')}">
                      <td><span class="cell-name">${r.label}</span></td>
                      <td>${pill(TONE[r.status] || 'info', WORD[r.status] || r.status)}</td>
                      <td>${r.as_of ? dateShort(r.as_of) : missing()}</td>
                      <td class="r cell-figure">${ageLabel(r.age_hours)}</td>
                      <td><span class="caption">${r.source}</span></td>
                    </tr>`
                  )
                )}
              </tbody>
            </table>
            <p class="tablehint" aria-hidden="true">Scroll sideways for more columns →</p>
          </div>`}
    </section>`;

  // ---- what to do about each one that is not live ---------------------------

  const broken = rows.filter((r) => r.status !== 'live');

  const actions = html`<section class="panel">
      ${panelHead(
        html`Needs attention, ${num(broken.length)}`,
        broken.length ? 'missing' : 'live',
        broken.length ? 'One entry per feed that is not live' : 'Nothing to do',
        'Each one names the specific thing that would fix it, because "the data is old" is a symptom and the fixes are all different.'
      )}
      ${!broken.length
        ? empty('Every feed is current. Nothing here needs a person.')
        : html`<ul class="plainlist">
            ${join(
              broken.map(
                (r) => html`<li>
                  ${pill(TONE[r.status], WORD[r.status])}
                  <strong>${r.label}</strong>
                  <p class="caption">${r.detail}</p>
                  ${r.fix ? html`<p>${r.fix}</p>` : ''}
                </li>`
              )
            )}
          </ul>`}
      ${why(
        'Why stale and unreachable are two words and not one',
        html`<p>
            <em>Stale</em> means the feed answered and its data has stopped moving: somebody has stopped
            filling something in, and the fix is a person. <em>Unreachable</em> means it did not answer at
            all, or was never configured: the fix is a credential or a service.
          </p>
          <p>
            Both render as "the number is wrong", which is why it is tempting to have one word for them.
            They send you to completely different places, so they get two.
          </p>`
      )}
    </section>`;

  // ---- the split ------------------------------------------------------------

  const provenance = html`<section class="panel">
      ${panelHead('Who checks what', 'live', 'By design',
        'Each side probes only what it already holds the credentials for. A status page is not a good enough reason to copy a key into a second place.')}
      ${statGrid([
        statCard('Checked by the engine', num((engine || []).length), {
          sub: runDate ? `as of the ${dateTextOnly(runDate)} run` : 'no run found',
          tone: engine === null ? 'warn' : '',
        }),
        statCard('Probed by this page', num((stores || []).length), {
          sub: 'live, on every load',
          tone: stores === null ? 'warn' : '',
        }),
        statCard('Live', num(counts.live), { tone: 'ok' }),
        statCard('Not live', num(counts.stale + counts.unreachable), {
          tone: counts.stale + counts.unreachable ? 'warn' : '',
        }),
      ])}
      ${engine === null
        ? html`<p class="note note--neg">
            ${glyph('crit')} The last run could not be read, so the sheet, gig and tracker feeds are not
            represented above at all. They are not healthy and they are not broken; they are unknown.
          </p>`
        : ''}
      ${stores === null
        ? html`<p class="note note--neg">
            ${glyph('crit')} The two Supabase stores could not be probed, so the shift logger and the
            impressions board are missing from the table rather than shown as failing.
          </p>`
        : ''}
    </section>`;

  const title = halfMissing
    ? `Feed check incomplete, ${rows.length} of the feeds reported`
    : worst === 'live'
      ? `All ${rows.length} feeds live`
      : worst === 'unreachable'
        ? `${counts.unreachable} feed${counts.unreachable === 1 ? '' : 's'} unreachable, ${counts.stale} stale`
        : `${counts.stale} feed${counts.stale === 1 ? '' : 's'} stale`;

  return {
    title,
    kicker: 'Feeds · every input, and whether it is moving',
    ticker: [
      { label: 'Feeds', value: num(rows.length) },
      { label: 'Live', value: num(counts.live) },
      { label: 'Stale', value: num(counts.stale), sub: counts.stale ? 'data stopped moving' : '' },
      { label: 'Unreachable', value: num(counts.unreachable), sub: counts.unreachable ? 'key or service' : '' },
    ],
    html: html`${verdictBanner}
      ${table}
      ${actions}
      ${provenance}
      <div class="provenance-bar">
        <span>The engine half is written into the run JSON on each run and is therefore as fresh as the
          last run. The store half is probed on every load of this page.</span>
        <span>Ages are measured against the newest row each feed holds for this profile, not against when
          it was last touched.</span>
        <span>Nothing on this page writes anywhere, and no key is read by anything that does not already
          hold it.</span>
      </div>`,
  };
}

export default render;
