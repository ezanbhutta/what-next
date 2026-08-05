// views/today.js, the landing view. A checklist, and the one number that
// explains why the checklist is in this order.
//
// WHAT THIS VIEW IS
//
//   The 12 tasks the engine emitted for the run date, each with a checkbox
//   whose state lives in MySQL keyed (run_date, task_id) and records who
//   ticked it. Everything above the list exists to say why the list is worth
//   working: $8,007 is sitting still, it needs no new traffic, no marketplace
//   lever and nobody's permission.
//
// THE TWO STORES MEET HERE, AND THE PAGE SAYS WHICH IS WHICH
//
//   The tasks are engine output read from disk (`latest-run.json`). The ticks
//   are the only thing a human typed. They have separate provenance stamps
//   because they fail separately: a database outage must not make a full list
//   look cleared, and a missing run file must not make an empty page look
//   like a quiet morning. When `ctx.data.byTask` is null the boxes are
//   DISABLED and the progress rule reads MISSING, never 0 of 12.
//
// HOUSE RULES THIS FILE IS CARRYING
//
//   R2  Nothing renders 0 for an unknown. `pick()` yields MISSING and the
//       formatters render it.
//   R3  The progress rule is a CENSUS of a complete list of 12, not a rate on
//       a sample of 12. It draws no bar, no meter and no trend arrow, and its
//       caption says so, see `progressRule`.
//   R4  The retired programme is never named. There is no volume instruction
//       to print, so none is printed, not even a zero.
//   R6  A review request must never ride on a late or cold order. Two of the
//       engine's own tasks carry a review-capture step for a buyer who is
//       ALSO on the 60+ day list. The hub does not silently delete the step
//       and it does not silently obey it: it marks the step, names the
//       conflict and shows the order's age. Refereeing a disagreement between
//       two systems is this hub's whole job, see `reviewConflict`.
//   R7  The figure leads. Money at rest is the first thing on the page; the
//       two traps that live in that money are in a `<details>` underneath it.

import { pick, isMissing } from '../lib/data.js';
import { normaliseBuyer } from '../lib/reconcile.js';

import {
  html,
  join,
  safe,
  missing,
  money,
  num,
  days,
  dateShort,
  glyph,
  pill,
  panelHead,
  why,
  rate,
  known,
} from './layout.js';

// ============================================================================
// small helpers
// ============================================================================

/** Priority → status shape. G1: the shape carries the meaning, not the colour. */
const PRIORITY_TONE = { P0: 'crit', P1: 'warn', P2: 'info', P3: 'idle' };


/** An owner string like "Ezan (escalate to CEO if …)" is a name plus a caveat.
 *  The row shows the name; the caveat goes in the details, in sentence case,
 *  because `.task-meta` is uppercase and a shouted caveat is unreadable. */
function splitOwner(owner) {
  const full = String(owner ?? '').trim();
  if (!full) return { short: null, full: null };
  const m = /^([^(]+?)\s*\((.+)\)\s*$/.exec(full);
  return m ? { short: m[1].trim(), full } : { short: full, full };
}

// ============================================================================
// R6, the review-request referee
// ============================================================================

const REVIEW_ASK = /review[ _-]?(?:request|capture|ask)|ask (?:them )?for a review|request a review/i;

/** Every open order the engine marked stale, keyed by the join key. */
function staleIndex(run) {
  const rows = pick(run, 'recovery.open_orders.orders');
  const map = new Map();
  if (!Array.isArray(rows)) return map;
  for (const row of rows) {
    if (!row || row.stale !== true) continue;
    const key = normaliseBuyer(row.client);
    if (key) map.set(key, row);
  }
  return map;
}

/**
 * Does this task ask for a review on an order that is also 60+ days open?
 *
 * The buyer is named in the task title, sometimes as a display name
 * ("Calum Snell") where the order book has a username ("calumsnell"). Both
 * reduce to the same join key, which is the whole reason `buyer` is the key.
 * Returns the offending order row, or null.
 */
function reviewConflict(task, stale) {
  const steps = Array.isArray(task.steps) ? task.steps : [];
  const text = [task.title, task.why, ...steps].filter(Boolean).join(', ');
  if (!REVIEW_ASK.test(text)) return null;

  const title = String(task.title ?? '');
  const tail = normaliseBuyer(title.split(/[, –-]/).pop());
  const whole = normaliseBuyer(title);

  for (const [key, row] of stale) {
    if (key === tail) return row;
    if (key.length >= 6 && whole.includes(key)) return row;
  }
  return null;
}

// ============================================================================
// the lede, money at rest, and the health constraint beside it
// ============================================================================

function moneyAtRest(run) {
  const atRest = pick(run, 'recovery.total_at_rest');
  const staleCount = pick(run, 'recovery.open_orders.stale_count');
  const staleValue = pick(run, 'recovery.open_orders.stale_value');
  const openCount = pick(run, 'recovery.open_orders.open_count');
  const openValue = pick(run, 'recovery.open_orders.open_value');
  const staleAfter = pick(run, 'recovery.open_orders.stale_after_days');
  const quoteCount = pick(run, 'recovery.quotes.count');
  const quoteTotal = pick(run, 'recovery.quotes.total');
  const untouched = pick(run, 'recovery.quotes.untouched_count');
  const untouchedValue = pick(run, 'recovery.quotes.untouched_value');

  // The follow-up benchmark, reported the only way it is not misleading: the
  // conversion WITHIN the group that was actually chased. `rate()` returns a
  // range on n=24, which is what n=24 deserves.
  const followedN = pick(run, 'recovery.followup_benchmark.followed_n');
  const followedPlaced = pick(run, 'recovery.followup_benchmark.followed_placed');
  const neverN = pick(run, 'recovery.followup_benchmark.never_n');
  const followed = rate(followedPlaced, followedN);

  return html`<div class="figure">
      <span class="cap">Money sitting still</span>
      <strong class="big">${money(atRest)}</strong>
      <p class="sub">
        <b>${num(staleCount)}</b> orders open longer than ${days(staleAfter)} hold ${money(staleValue)},
        and <b>${num(quoteCount)}</b> quotes that never became orders hold ${money(quoteTotal)}.
      </p>
    </div>
    ${why(
      'How this splits, and the two ways it is normally read wrong',
      html`<p>
          The open book is ${money(openValue)} across <strong>${num(openCount)}</strong> orders; the
          ${money(staleValue)} above is the ${num(staleCount)} of those past ${days(staleAfter)}.
          ${money(untouchedValue)} of the quote pile is the <strong>${num(untouched)}</strong> leads
          nobody ever followed up.
        </p>
        <p>
          <strong>An open order is not one thing.</strong> Before a single message goes out, each one is
          sorted into <em>we owe work</em>, <em>they owe a reply</em>, or <em>dead</em>. A "just checking
          in" note sent to a buyer who is waiting on us is how a late order becomes a dispute.
        </p>
        <p>
          <strong>Follow-up counts are not a measure of neglect.</strong> Of the
          <strong>${num(followedN)}</strong> quoted leads anyone did chase, ${num(followedPlaced)} placed, 
          ${followed.ok ? followed.html : missing()}${followed.ok && followed.small
            ? html` <span class="caption">(Wilson 95%, n=${num(followedN)}, too few to state as one number)</span>`
            : ''}. The ${num(neverN)} leads with no logged follow-up appear to convert far higher, but only
          because a follow-up is logged exactly when the buyer did not say yes immediately. Cost the chase
          on the rate <em>within</em> the chased group; never quote the raw split as if chasing were harmful.
        </p>
        <p>
          <strong>No review request attaches to any of this work.</strong> These are late or cold orders,
          and a review ask on a late delivery is the most reliable way to turn a private three-star into a
          public one.
        </p>`
    )}`;
}

function healthSide(run) {
  const verdict = pick(run, 'metrics.health.verdict');
  const index = pick(run, 'metrics.health.index');
  const breached = pick(run, 'metrics.health.breached');
  const reasons = pick(run, 'metrics.health.breach_reasons');
  const structural = pick(run, 'metrics.health.structural_delta_pct');

  // ONE pill, not two.
  //
  // This rendered the engine's verdict ("BREACH") beside a second pill
  // spelling out the same fact ("Constraint breached"), side by side under
  // one figure. Two badges for one state reads as two problems. The verdict
  // word is the engine's key; the sentence is what a person needs, so the
  // sentence wins and the raw key stays in the run JSON where it belongs.
  const breachPill =
    breached === false
      ? pill('ok', 'Not breached')
      : breached === true
        ? pill('crit', 'Constraint breached')
        : html`<span class="pill pill--idle">${glyph('idle')}Breach state ${missing()}</span>`;

  // The documented trap: a red BREACH badge over an empty reasons array, which
  // once printed "No breach" directly underneath itself. If the badge and the
  // evidence disagree, the page says the evidence is absent, it does not
  // quietly render the badge as if it were explained.
  const reasonBlock =
    breached === true && Array.isArray(reasons) && reasons.length === 0
      ? html`<p class="note note--neg">
          The run says the constraint is breached and carries no reasons for it. The evidence did not reach
          the run JSON; treat the badge as unexplained rather than as explained by nothing.
        </p>`
      : Array.isArray(reasons) && reasons.length
        ? html`<ul class="steps">${join(reasons.map((r) => html`<li>${r}</li>`))}</ul>`
        : '';

  return html`<div class="figure">
      <span class="cap">Organic health index</span>
      <strong class="mid">${num(index, { dp: 1 })}<span class="caption"> / 100</span></strong>
      <p class="sub">
        ${breachPill}
      </p>
    </div>
    ${reasonBlock}
    ${why(
      'What this constrains, and what it does not prove',
      html`<p>
          Organic order flow is a <strong>hard constraint</strong>, not a preference. While it is breached,
          nothing may be added on top of it however far behind revenue is. The directed-volume controller is
          switched off as policy, so there is no volume instruction on this page today and no quota to print.
        </p>
        <p>
          Structural change since the comparison window is ${pctSigned(structural)}. The organic decline and
          the start of directed work are <strong>correlated</strong>; that is not proof of a cut. A
          falsifiable prediction sits on the ledger with a resolution date precisely so this settles on
          evidence rather than on argument.
        </p>`
    )}`;
}

/** A signed percentage from a FRACTION, e.g. -0.0376 → −3.8%. */
function pctSigned(fraction) {
  if (!known(fraction)) return missing();
  const n = Number(fraction) * 100;
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  const cls = n > 0 ? 'pos' : n < 0 ? 'neg' : 'flat';
  return html`<span class="${safe(cls)} num">${safe(sign)}${Math.abs(n).toFixed(1)}%</span>`;
}

// ============================================================================
// the checklist
// ============================================================================

function taskRow(task, { runDate, tick, canTick, csrfToken, backTo, conflict }) {
  const id = String(task.id ?? '');
  const done = canTick ? Boolean(tick && Number(tick.done) === 1) : false;
  const owner = splitOwner(task.owner);
  const priority = String(task.priority ?? '');
  const tone = PRIORITY_TONE[priority] || 'idle';
  const steps = Array.isArray(task.steps) ? task.steps : [];
  const refs = Array.isArray(task.refs) ? task.refs : [];
  const due = pick(task, 'due');

  const stepList = join(
    steps.map((step) => {
      const offending = conflict && REVIEW_ASK.test(String(step));
      return html`<li>
        ${step}${offending
          ? html` ${pill('crit', 'Do not send')}
              <p class="caption">
                This buyer's order has been open ${days(conflict.age_days)}. A review ask on a late delivery
                is the most reliable way to turn a private three-star into a public one. Every other step on
                this task stands.
              </p>`
          : ''}
      </li>`;
    })
  );

  return html`<li class="task${safe(done ? ' is-done' : '')}">
      <form method="post" action="/today/task" data-autosubmit>
        <input type="hidden" name="_csrf" value="${csrfToken}">
        <input type="hidden" name="run_date" value="${runDate}">
        <input type="hidden" name="task_id" value="${id}">
        <input type="hidden" name="back" value="${backTo}">
        <label class="task-row">
          <span class="chk">
            <input type="checkbox" name="done" value="1"
                   ${safe(done ? 'checked' : '')}
                   ${safe(canTick ? '' : 'disabled')}>
          </span>
          <span class="task-body">
            <span class="task-head">
              <span class="task-title">${task.title}</span>
              ${priority ? pill(tone, priority) : ''}
            </span>
            <span class="task-meta">
              ${owner.short ? html`<span class="owner">${owner.short}</span>` : html`<span class="owner">${missing()}</span>`}
              ${known(task.impact_usd) ? html`<span class="amt">${money(task.impact_usd)} at stake</span>` : ''}
              ${task.category ? html`<span>${String(task.category).replace(/_/g, ' ')}</span>` : ''}
              ${due === null ? '' : html`<span>Due ${dateShort(due)}</span>`}
              ${conflict ? pill('crit', 'Conflict') : ''}
            </span>
          </span>
        </label>
        <button class="btn btn--ghost btn--sm js-submit" type="submit">Save this tick</button>
      </form>
      <div class="task-extra">
        ${why(
          `Why, and the ${steps.length} steps`,
          html`<p>${task.why}</p>
            ${conflict
              ? html`<p class="note note--neg">
                  <strong>Two systems disagree about this order.</strong> The task asks for a review; the
                  order book has <strong>${conflict.client}</strong> open ${days(conflict.age_days)} at
                  ${money(conflict.amount)} in status <em>${String(conflict.status || '').replace(/_/g, ' ')}</em>,
                  which is one of the stale orders counted at the top of this page. The hub does not delete
                  the step and does not obey it, it marks it, and the marked step is the one to skip.
                </p>`
              : ''}
            <ol class="steps">${stepList}</ol>
            <p class="caption">
              Owner, ${owner.full || missing()}.
              ${task.playbook ? html` Playbook <code class="mono">${task.playbook}</code>.` : ''}
              ${known(task.effort_hours) ? html` Estimated ${num(task.effort_hours, { dp: 1 })}h.` : ''}
              ${known(task.confidence) ? html` Confidence ${num(Number(task.confidence) * 100, { dp: 0 })}%.` : ''}
            </p>
            ${refs.length
              ? html`<p class="caption">Evidence, ${join(refs.map((r) => html`<code class="mono">${r}</code>`), ' · ')}</p>`
              : ''}`
        )}
      </div>
    </li>`;
}

/**
 * The progress rule.
 *
 * This is a census of a complete list of 12, not an estimate of a rate from a
 * sample of 12, so R3 does not apply and nothing here draws a bar: the marks
 * are one per task, in list order, so the row is a map of the list rather than
 * a bar that happens to be made of squares. When the typed store is
 * unreachable the count is MISSING, a cleared-looking list during an outage
 * is the exact failure this repo exists to prevent.
 *
 * @param {boolean[]} state  one entry per task, in the order they are rendered
 */
function progressRule(state, canTick) {
  const total = state.length;
  const cleared = state.filter(Boolean).length;
  const marks = join(
    state.map((done) => html`<i class="${safe(canTick && done ? 'is-on' : '')}"></i>`)
  );
  return html`<div class="progress">
      <span class="progress-count">${canTick ? html`${num(cleared)} / ${num(total)}` : missing()}</span>
      <span class="score" role="img"
            aria-label="${canTick ? `${cleared} of ${total} tasks cleared` : `Tick state unavailable for all ${total} tasks`}">${marks}</span>
      <span class="progress-note">
        ${canTick
          ? 'Cleared today. A count of a complete list of 12, not a rate, so no interval and no bar.'
          : 'Tick state could not be read. This is MISSING, not zero cleared.'}
      </span>
    </div>`;
}

// ============================================================================
// phase and self-check
// ============================================================================

function phasePanel(run) {
  const phase = pick(run, 'phase');
  if (isMissing(phase) || !phase) return '';
  const gates = Array.isArray(phase.gate) ? phase.gate : [];
  const forbidden = Array.isArray(phase.forbidden) ? phase.forbidden : [];

  const rows = join(
    gates.map((g) => {
      const met = g.met === true;
      return html`<tr class="${safe(met ? '' : 'row-attn')}">
        <td><span class="cell-name">${g.label}</span>${g.source ? html`<span class="cell-sub">${g.source}</span>` : ''}</td>
        <td class="r cell-figure">${num(g.required)}</td>
        <td class="r cell-figure">${g.actual === null ? missing() : num(g.actual)}</td>
        <td>${met ? pill('ok', 'Met') : pill('warn', 'Not met')}</td>
      </tr>`;
    })
  );

  return html`<section class="panel">
      ${panelHead(
        html`${phase.label}, ${num(phase.days_remaining)} days left`,
        'live',
        'Live · latest-run.json'
      )}
      <p class="note">${phase.objective}</p>
      ${gates.length
        ? html`<div class="tablewrap">
              <table class="table table--narrow">
                <thead><tr><th>Gate</th><th class="r">Required</th><th class="r">Actual</th><th>State</th></tr></thead>
                <tbody>${rows}</tbody>
              </table>
              <p class="tablehint" aria-hidden="true">Scroll sideways for more columns →</p>
            </div>
            <p class="caption">
              The phase gate is ${phase.gate_open === true ? 'open' : 'closed'}. Until every row is met, the
              phase does not advance.
            </p>`
        : ''}
      ${forbidden.length
        ? html`<p class="note note--warn">
            Forbidden while this phase runs:
            ${join(forbidden.map((f) => html`<code class="mono">${f}</code>`), ' · ')}. A task that asks for
            any of these is a bug in the brief, not an instruction.
          </p>`
        : ''}
    </section>`;
}

function selfCheckNote(run) {
  const results = pick(run, 'selfcheck.results');
  const blocking = pick(run, 'selfcheck.blocking');
  const score = pick(run, 'selfcheck.score');
  if (!Array.isArray(results)) return '';

  const failed = results.filter((r) => r && r.passed === false);
  const blockedCount = known(blocking) ? Number(blocking) : null;

  const head =
    blockedCount === 0
      ? pill('ok', 'Gate passed')
      : blockedCount === null
        ? html`<span class="pill pill--idle">${glyph('idle')}Gate state ${missing()}</span>`
        : pill('crit', `${blockedCount} blocking`);

  return html`<section class="panel">
      ${panelHead('What the engine flagged about its own brief', 'live', 'Live · latest-run.json')}
      <p class="note">${head} Rubric score ${num(score, { dp: 1 })} / 100. ${failed.length
        ? html`<b>${num(failed.length)}</b> check${failed.length === 1 ? '' : 's'} did not pass.`
        : 'Every check passed.'}</p>
      ${failed.length
        ? why(
            'The checks that did not pass',
            html`<ul class="steps">
              ${join(
                failed.map(
                  (f) => html`<li>
                    <strong>${String(f.name).replace(/_/g, ' ')}</strong>
                    ${f.severity === 'block' ? pill('crit', 'Blocking') : pill('warn', 'Warning')}
                    <p class="caption">${f.detail}</p>
                  </li>`
                )
              )}
            </ul>
            <p>
              A warning does not make a figure wrong; it says the brief is thinner than it should be in that
              one place. A blocking failure means the brief should not have been handed over at all.
            </p>`
          )
        : ''}
    </section>`;
}

// ============================================================================
// render
// ============================================================================

export function render(ctx) {
  const run = ctx.run;
  const tasks = pick(run, 'tasks');
  const runDate = ctx.engine.runDate;
  const byTask = ctx.data?.byTask ?? null;
  const ticksOk = ctx.data?.ticks?.ok === true;
  const canTick = Boolean(runDate) && byTask !== null && ticksOk;
  const backTo = '/';

  const atRest = pick(run, 'recovery.total_at_rest');

  // ---- no engine run: say so and stop. There is nothing to check off. ------
  if (!Array.isArray(tasks)) {
    return {
      title: 'There is no task list to work',
      kicker: 'Today',
      html: html`<div class="figure">
          <span class="cap">Tasks for ${ctx.engine.runDate || 'today'}</span>
          <strong class="mid">${missing()}</strong>
          <p class="sub">
            <code class="mono">latest-run.json</code> is absent or unreadable, so there is no task list, no
            money-at-rest figure and no health verdict. Nothing typed into the hub is affected, ticks,
            entries and notes are all still there and still attributed.
          </p>
        </div>
        <p class="note note--neg">
          An empty checklist and an unreadable one look identical from a phone, so this page refuses to draw
          one. Redeploy with the engine's output in <code class="mono">data/</code>, or run the engine.
        </p>`,
    };
  }

  const stale = staleIndex(run);
  const conflicts = new Map();
  for (const t of tasks) {
    const c = reviewConflict(t, stale);
    if (c) conflicts.set(String(t.id), c);
  }

  const doneState = tasks.map((t) => canTick && Number(byTask[String(t.id)]?.done) === 1);
  const cleared = doneState.filter(Boolean).length;

  const lastTick = canTick
    ? Object.values(byTask)
        .filter((r) => Number(r.done) === 1 && r.done_by)
        .sort((a, b) => String(b.done_at ?? '').localeCompare(String(a.done_at ?? '')))[0] || null
    : null;

  const list = join(
    tasks.map((task) =>
      taskRow(task, {
        runDate,
        tick: canTick ? byTask[String(task.id)] : null,
        canTick,
        csrfToken: ctx.csrfToken,
        backTo,
        conflict: conflicts.get(String(task.id)) || null,
      })
    )
  );

  const body = html`<div class="lede">
      <div class="lede-main">${moneyAtRest(run)}</div>
      <div class="lede-side">${healthSide(run)}</div>
    </div>

    <section class="panel">
      ${panelHead(
        html`The list, ${num(tasks.length)} tasks`,
        'live',
        html`Live · latest-run.json · ${dateShort(runDate)}`
      )}
      ${conflicts.size
        ? html`<p class="note note--neg">
            ${glyph('crit')} <strong>${num(conflicts.size)} task${conflicts.size === 1 ? '' : 's'} ask for a
            review on an order that is also past ${days(pick(run, 'recovery.open_orders.stale_after_days'))}.</strong>
            The step is marked <em>Do not send</em> where it appears. Everything else on those tasks stands.
          </p>`
        : ''}
      ${canTick
        ? ''
        : html`<p class="note note--neg">
            ${glyph('crit')} <strong>Tick state could not be read.</strong>
            ${runDate
              ? 'The typed-records database is unreachable, so the hub cannot tell what has already been cleared. The boxes are disabled rather than shown unticked, an unticked box you cannot trust is worse than none.'
              : 'There is no run date to key the ticks on, so nothing can be saved against this list.'}
          </p>`}
      <ul class="tasks">${list}</ul>
      ${progressRule(doneState, canTick)}
      <div class="provenance-bar">
        <span>Tasks, engine output, read from <code class="mono">data/latest-run.json</code>.</span>
        <span>Ticks, typed here, stored against <code class="mono">(${runDate || 'no run date'}, task_id)</code>.</span>
        ${lastTick
          ? html`<span>Last cleared by <strong>${lastTick.done_by}</strong>.</span>`
          : canTick
            ? html`<span>Nothing cleared yet today.</span>`
            : ''}
      </div>
    </section>

    ${phasePanel(run)}
    ${selfCheckNote(run)}`;

  // The title says what the page is, and nothing the page says again.
  //
  // It used to read "12 tasks, and $7,627 that needs no new traffic". That
  // was the third printing of $7,627 and the second of the task count, both
  // in a 24px heading that wrapped to two lines directly above the figure it
  // was restating. The count belongs on the progress rule at the foot of the
  // list, which is the one place a tick changes it.
  // No ticker on this page.
  //
  // The three standing cells are Organic health, Money at rest and Open past
  // 60 days. All three are restated as full figures inside the view, the
  // first two within one screen of the cell. That put $7,627 twice and the
  // breach verdict twice on a 375px viewport before a single instruction.
  // Today is a checklist; the figure and the list are the page.
  return { title: 'Today', ticker: false, html: body };
}

export default render;
