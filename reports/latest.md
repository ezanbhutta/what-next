# XStudioz — What Next · Wednesday 29 July 2026

**Organic health: 🔴 BREACH** · index 37/100 · VVRO share 79% (cap 30%)

> Place **1 VVRO order today** (1x $151-$260) — quota **2/week**.

**Why the constraint is breached**
- structural: organic -14.3% since VVRO began 2026-07-13 (0.66 -> 0.56/day)

## Do today

### P0 · Rescue at-risk order #5 — Dr. Ali Albalawi
**Owner:** Ezan (escalate to CEO if refund is formally requested) · **Est. impact:** $400 · **Effort:** 1.5h · **Confidence:** 70%

*Why:* Buyer has raised refund/dispute language and the order is rev sent. A single 1-star review would move the public rating by 0.0024 (4.834 -> 4.832) across 1,583 reviews, and that rating is what every future buyer sorts on. The order is worth ~$112; the rating damage is worth far more.

- Read the full order history before replying — do not reintroduce any concept the buyer already rejected.
- Reply within 2 hours. Acknowledge the specific frustration in their own words; do not defend the work.
- Offer a concrete choice: (a) one senior designer takes a fresh direction at no cost, or (b) a clean partial refund and a mutual cancellation with no review.
- If they choose (a), name the designer and give a fixed date.
- If they choose (b), process it same day — a fast clean exit is cheaper than a slow 1-star.
- Script: `playbooks/dispute_rescue.md`
- Source rows: `order_tracker/tracker#b0r4`

### P0 · VVRO: 2/week (1 today) — CUT
**Owner:** CEO / order placement · **Est. impact:** $1,438 · **Effort:** 0.5h · **Confidence:** 80%

*Why:* Organic constraint breached — structural: organic -14.3% since VVRO began 2026-07-13 (0.66 -> 0.56/day). The objective makes organic recovery a hard constraint, so the dose is cut by 2/day and revenue upside is ignored until flow recovers. Quota 2/week (0.29/day); share cap allows 0.31/day.

- Place **1 VVRO order today** (1x $151-$260) — quota **2/week**.
- Countries to spread across: Other x1
- At this quota the VVRO share settles at 29%, against a cap of 0.31 VVRO/day at the current organic rate.
- Do not place on a fixed weekday pattern — the schedule rotates weekly for a reason.
- Log every placement in the daily ledger with its real amount. Revenue columns are currently all zero, which blinds the whole controller.
- Script: `playbooks/vvro_dosing.md`

### P0 · Bring the impressions sheet up to date — it stops months ago
**Owner:** Hasnain · **Est. impact:** $2,500 · **Effort:** 1.0h · **Confidence:** 80%

*Why:* Impression data exists but stops at 2025-12-13, 228 days before today. The last 28 days carry no rows, so the current decline cannot be attributed to reach, click-through or closing rate. Update the impressions sheet to the present and this becomes answerable immediately — the engine already reads it. Impressions are the leading indicator on the whole objective: Success Score drives impressions, impressions drive organic orders, organic orders drive revenue. Without a current series the engine can see that organic fell but not whether reach or conversion caused it, and those need opposite responses.

- Append daily rows from Fiverr Analytics from the last logged date to today: Date, Account Name, Impressions, Clicks, Organic Orders.
- Keep the existing column names exactly — the engine already reads them and a rename is what schema drift is.
- Post impressions and the 7-day average every morning at 09:00 PKT. It is the one number that says whether the suppression is lifting.
- Once 28 consecutive days exist, the engine attributes any decline to reach, click-through or close rate automatically.
- Script: `playbooks/data_hygiene.md`

### P0 · Fill revenue in the daily ledger (112 days blank)
**Owner:** Whoever owns the daily ledger · **Est. impact:** $2,000 · **Effort:** 2.0h · **Confidence:** 90%

*Why:* 112 ledger days record orders but $0 revenue. Every revenue forecast, the AOV target and the whole revenue side of the objective are currently inferred from the CRM sheet instead of measured, because this column is empty.

- Fill Organic Revenue and VVRO Revenue for every day with orders.
- Backfill from 2026-06-11 forward — that is where the ledger starts.
- This is the single highest-value data fix available: it unblocks revenue forecasting entirely.
- Script: `playbooks/data_hygiene.md`

### P0 · Work the $5,472 dead pipeline, largest first
**Owner:** Ezan · **Est. impact:** $821 · **Effort:** 3.0h · **Confidence:** 55%

*Why:* $5,472 quoted across 19 named leads with 0 follow-ups ever logged. At a 15% recovery that is $821 — more than a full day of current revenue, for zero ad spend and no new traffic. Top Rated needs $10,000 earned and over half of it is sitting in a spreadsheet column.

- Start with: selmaprof ($950), bobzinos ($900), farida_ism ($700), getgwoppa ($700).
- Use the four-line message in playbooks/dead_pipeline.md — quote still open, ask when to check back, ask for their number if budget was the issue.
- Log every touch in the FollowUp column with a date, same day.
- Anything that reopens goes straight into the normal intake flow.
- Script: `playbooks/dead_pipeline.md`

### P1 · Install the mid-order checkpoint — private feedback is the leak
**Owner:** All CSRs (compliance owned by Hasnain) · **Est. impact:** $3,851 · **Effort:** 1.0h · **Confidence:** 45%

*Why:* Only 7.9% of the 2353 orders on tabs that track reviews have one recorded, but public reviews are not where the damage is. Private ratings run underneath, stay open 60 days, are weighted most heavily for first-time buyers, and are invisible. That is why 1,583 reviews at 4.8 sit alongside Success Score 8. Asking for reviews does nothing about it; catching the problem mid-order does.

- At 50% of elapsed time on every order, send the direction so far and ask plainly whether anything needs changing. This is the one habit that converts a silent 3-star private rating into a fixed order, while the order is still open.
- Chase any silent buyer within 24 hours of delivery — orders auto-complete after 3 days and the private window stays open 60 days after that.
- Log every order where the buyer went silent, exceeded the agreed revisions, or accepted without a word. That is your proxy for the feedback you cannot see.
- Do NOT ask for a review beyond one neutral line at delivery, and never name a rating. Team briefing Rule 7 treats soliciting as an Integrity violation; see playbooks/review_capture.md.
- Script: `playbooks/review_capture.md`

### P2 · Run the upsell A/B test to de-bias the 54% vs 31% gap
**Owner:** CEO + Salman · **Est. impact:** $3,000 · **Effort:** 1.0h · **Confidence:** 40%

*Why:* Leads with an upsell attempt convert 50.0% (n=38) against 5.3% (n=947), z=10.59. That is a +847% relative lift — but it is observational, and CSRs choose who to upsell. The test tells you how much of it is real.

- For the next 100 inbound inquiries, alternate strictly: odd-numbered leads get an upsell attempt, even-numbered do not.
- Do not let CSRs choose. That choice is exactly the bias being measured.
- Log the assignment in the Upsell column so the engine can score it.
- The engine will report the de-biased effect once n>=100 per arm.
- Script: `playbooks/upsell.md`

### P2 · Wire up the 2 promised data sources
**Owner:** CEO · **Est. impact:** $1,500 · **Effort:** 1.0h · **Confidence:** 50%

*Why:* 2 sources are referenced by the plan but not readable by the engine: Disputed / dead / conflicted orders sheet, Daily team activity report. Until they exist, dispute exposure, impression-vs-conversion attribution and team-activity attribution are all guesses. In particular, without impressions the engine cannot tell whether an organic decline is falling reach or falling conversion — and those need opposite responses.

- Needed for dispute-risk scoring and refund-exposure forecasting. Run createMissingSourceSheets() in automation/Snapshot.gs to create it with the right headers.
- Needed to attribute outcome changes to team actions rather than to Fiverr's algorithm.
- Share each sheet with the Google account the engine reads as, then add its file_id to config/sources.yml.
- Script: `playbooks/data_hygiene.md`

### P2 · Route high-value briefs to Raylain
**Owner:** CEO · **Est. impact:** $800 · **Effort:** 0.5h · **Confidence:** 35%

*Why:* Raylain averages $154 across 7 orders; Abdullah averages $61 across 6. Some of that is brief mix rather than skill — but routing the $200+ briefs to the designers who already deliver at that level protects both AOV and rating.

- Assign every brief above $200 to Raylain or the next two by AOV.
- Check whether the low-AOV designers are getting low-value briefs or producing low-value outcomes before acting on this.
- Revisit in 30 days with the engine's updated per-designer AOV.
- Script: `playbooks/staffing.md`

### P3 · Close out approved order #4 — Calum Snell
**Owner:** Delivery lead · **Est. impact:** $101 · **Effort:** 1.0h · **Confidence:** 80%

*Why:* Concept is approved, so the creative risk is gone and the only thing between this and banked revenue plus a review is asset prep. This is the cheapest revenue on the board.

- Ship the full final package today: vectors, all formats, variations, fonts, colour values.
- Deliver via the order (not chat) so it counts toward on-time delivery.
- Attach the review request from playbooks/review_capture.md — only 12.7% of completed orders currently have a review recorded.
- Script: `playbooks/review_capture.md`
- Source rows: `order_tracker/tracker#b0r3`

### P3 · Close out approved order #6 — bethanyjademck
**Owner:** Delivery lead · **Est. impact:** $101 · **Effort:** 1.0h · **Confidence:** 80%

*Why:* Concept is approved, so the creative risk is gone and the only thing between this and banked revenue plus a review is asset prep. This is the cheapest revenue on the board.

- Ship the full final package today: vectors, all formats, variations, fonts, colour values.
- Deliver via the order (not chat) so it counts toward on-time delivery.
- Attach the review request from playbooks/review_capture.md — only 12.7% of completed orders currently have a review recorded.
- Script: `playbooks/review_capture.md`
- Source rows: `order_tracker/tracker#b0r5`

### P3 · Fix the broken ClickUp sync (334 logged failures)
**Owner:** CEO / whoever owns the Apps Script · **Est. impact:** $600 · **Effort:** 1.0h · **Confidence:** 70%

*Why:* The Apps Script has logged 334 failures, including: CLICKUP_TOKEN script property is missing.. Every ClickUp task the sheet should have created since then does not exist, so work is being tracked in two places that disagree.

- Set CLICKUP_TOKEN in the Apps Script's Script Properties.
- Re-run the sync for the backlog.
- Add a failure alert — 300+ silent failures is the real defect.
- Script: `playbooks/data_hygiene.md`


---

## Who does what

### Ezan · team lead · all hours
*4 task(s), ~4.0h*

- **P0** Rescue at-risk order #5 — Dr. Ali Albalawi
- **P2** Route high-value briefs to Raylain
- **P3** Close out approved order #4 — Calum Snell
- **P3** Close out approved order #6 — bethanyjademck

Standing duties, every shift:
- QA gate: nothing ships without a check against the question-11 deliverable list. Watermarks removed, fonts noted, vectors included.
- Reconcile the inquiry log against the order tracker. On 27 July the tracker showed 5 orders and the inquiry log showed 2 for the whole month; until those agree, no conversion figure is trustworthy.
- Take the shift handoff at each changeover — five lines, no exceptions.
- Escalate any cancellation risk before it is filed, never after.

### CEO · ceo · —
*2 task(s), ~1.5h*

- **P0** VVRO: 2/week (1 today) — CUT
- **P2** Run the upsell A/B test to de-bias the 54% vs 31% gap

Standing duties, every shift:
- Post impressions and the 7-day average every morning. It is the single number that says whether the suppression is lifting.
- Hold the inorganic team to the weekly quota and the price bands. Cheap controlled volume on a premium profile is the worst of both worlds.
- Any order past day 7, or any cancellation, comes to you the same day.

### Nadir · csr · 21:00-09:00 PKT
*3 task(s), ~3.0h*

- **P0** Bring the impressions sheet up to date — it stops months ago
- **P1** Install the mid-order checkpoint — private feedback is the leak
- **P3** Fix the broken ClickUp sync (334 logged failures)

Standing duties, every shift:
- Answer every new first-message within 30 minutes. Response rate counts only the first message in a thread, on a 24-hour window, rolling 90 days.
- Report spam as spam within 24 hours — it then does not count against response rate. Most agencies bleed this metric on messages they could have flagged in three seconds.
- Post the 12-question intake within 15 minutes of any order starting.
- Send the 50%-elapsed checkpoint on every live order. This is the habit that converts an invisible 3-star private rating into a fixed order.
- Log every quoted price into the inquiry sheet the moment it is sent.
- Never move a pre-order conversation off Fiverr, and never argue.

### Hasnain · csr · 17:00-01:00 PKT
*2 task(s), ~3.0h*

- **P0** Fill revenue in the daily ledger (112 days blank)
- **P2** Wire up the 2 promised data sources

Standing duties, every shift:
- Answer every new first-message within 30 minutes. Response rate counts only the first message in a thread, on a 24-hour window, rolling 90 days.
- Report spam as spam within 24 hours — it then does not count against response rate. Most agencies bleed this metric on messages they could have flagged in three seconds.
- Post the 12-question intake within 15 minutes of any order starting.
- Send the 50%-elapsed checkpoint on every live order. This is the habit that converts an invisible 3-star private rating into a fixed order.
- Log every quoted price into the inquiry sheet the moment it is sent.
- Never move a pre-order conversation off Fiverr, and never argue.

### Amrah · csr · 09:00-17:00 PKT
*1 task(s), ~3.0h*

- **P0** Work the $5,472 dead pipeline, largest first

Standing duties, every shift:
- Answer every new first-message within 30 minutes. Response rate counts only the first message in a thread, on a 24-hour window, rolling 90 days.
- Report spam as spam within 24 hours — it then does not count against response rate. Most agencies bleed this metric on messages they could have flagged in three seconds.
- Post the 12-question intake within 15 minutes of any order starting.
- Send the 50%-elapsed checkpoint on every live order. This is the habit that converts an invisible 3-star private rating into a fixed order.
- Log every quoted price into the inquiry sheet the moment it is sent.
- Never move a pre-order conversation off Fiverr, and never argue.

> The clock is fully covered, with a double-up from 21:00-01:00. The exposure is not a gap, it is a concentration: 01:00-09:00 is the highest-value window on the board — US peak, and the review base is UK, USA, Australia, Canada, UAE and Germany — and it runs single-manned for eight hours. Nadir logged two inquiries in two months in that window. Whether that is volume, tooling or assignment is the first thing to establish; it is the most expensive unknown in the roster.

**Shift handoff — five lines, every changeover:** Open orders and their deadlines; Unanswered first-messages; Orders at risk — past day 5, revision loops, unhappy tone; Escalations needing the lead; Revenue booked this shift.


---

## Where the edge is

**Dygram is the experiment already run** — Dygram holds Success Score 9 at 44% inorganic and pulls 8x the impressions of X Studioz (12,700/day against 1,564). Same operator, same team, same category. Copy its ratio policy rather than theorising about the algorithm.

**1,583 reviews is the moat, and it is being spent on cheap orders** — Almost no competitor in logo design can match that review base. It is a conversion advantage that compounds — and it is currently attached to a $77 inorganic average order value. The same trust aimed at $150-$260 work is the single largest untaken edge here, and it costs nothing to try.

**Half the revenue is from people who already know you** — 158 of 574 clients have ordered more than once, producing 48.2% of orders and $38,724 of revenue — with the Upsell column at 0.0% filled. Competitors fight for the first order. Nobody is fighting for the second one here, including us.


---

## Inorganic (VVRO) plan

- **Action:** CUT · binding constraint: `organic_health_breach`
- **Quota:** 2/week (0.29/day) · today: **1**
- **Ceiling from share cap:** 0.31/day at the current organic rate of 0.71/day
- **Projected VVRO share at this rate:** 29%
- **Cooldown until:** 2026-08-01

| Date | Day | Place | Price bands |
|---|---|---|---|
| 2026-07-29 | Wed | 1 | 1x $151-$260 |
| 2026-07-30 | Thu | 0 | — |
| 2026-07-31 | Fri | 0 | — |
| 2026-08-01 | Sat | 1 | 1x $86-$150 |
| 2026-08-02 | Sun | 0 | — |
| 2026-08-03 | Mon | 1 | 1x $45-$85 |
| 2026-08-04 | Tue | 0 | — |

Per ISO week: **2026-W31** = 2, **2026-W32** = 1 (quota is 2/week; a 7-day window straddles two weeks, so these will not both equal the quota).


---

## Predictions

Each is scored automatically on its resolution date and feeds interval calibration.

| Resolve on | Prediction | 80% interval | Confidence |
|---|---|---|---|
| 2026-08-05 | Organic orders over the 7 days to 05 Aug will be 5.6 (80% CI 2.6-8.6). | 2.57 – 8.63 | medium |
| 2026-08-12 | Organic health index in 14 days will be 49 (80% CI 35-71). | 34.69 – 70.75 | low |
| 2026-08-05 | Total orders/day averaged over the next 7 days will be 3.21 (80% CI 2.34-4.07). | 2.34 – 4.07 | medium |
| 2026-08-28 | Blended AOV in 30 days will be $112 (80% CI $101-$124). | 100.66 – 123.52 | high |
| 2026-08-05 | Inquiry->order conversion in 7 days will be 22.6% (80% CI 19.7%-25.5%). | 0.20 – 0.26 | high |

**Track record:** 57 resolved, coverage 61% 
(target 80%), median absolute error 11%.


---

## Where the business actually is

| Metric | Value | Note |
|---|---|---|
| Organic orders/day (7d MA) | 0.71 | vs 0.71 14d ago |
| Organic since VVRO began | 0.56/day | was 0.66/day (-14.3%) |
| Total orders/day (7d) | 3.00 | 5 organic + 16 VVRO |
| AOV | $112 | median $100, n=1035 priced orders |
| Lifetime tracked revenue | $116,017 | across 2353 order rows |
| Inquiry conversion | 22.6% | 69/305 |
| Upsell recorded | 0.0% | column is effectively unused |
| Review capture | 7.9% | biggest free growth lever |
| Gig rating | 4.834 | 1,583 reviews, Level 2 |
| Orders in queue | 20 | live from the gig page |

### Revenue path

At 1.00 orders/day and $112 AOV, the next 30 days project **$3,363** (30 orders).

On track against the 30-day target.

### Funnel leverage

| Segment | n | Conversion | Lower bound |
|---|---|---|---|
| Shift: Evening | 99 | 24.2% | 16.9% |
| Shift: Night | 32 | 28.1% | 15.6% |
| Shift: Morning | 161 | 21.1% | 15.5% |
| United Kingdom | 71 | 26.8% | 17.9% |
| United States | 54 | 18.5% | 10.4% |
| India | 15 | 6.7% | 1.2% |

Ranked on the Wilson lower bound, not raw rate, so small samples cannot outrank large ones.


---

## System integrity

**Self-check score: 86/100** · 0 blocking failure(s)

- task_count: 10
- ownership: 20
- evidence: 21
- actionability: 15
- falsifiability: 20
- priority_spread: 0

**Checks not passing**
- `warn` **ledger_vs_crm_orders** — daily ledger says 51 orders in window, CRM sheet says 1364 (96% apart). The two sources are maintained separately and disagree; treat the ledger as authoritative for flow and the CRM for economics.
- `warn` **all_tasks_evidenced** — 10/12 tasks cite a number in their rationale
- `warn` **priority_spread_sane** — 5 of 12 tasks are P0

**Data sources still missing**
- Disputed / dead / conflicted orders sheet — Needed for dispute-risk scoring and refund-exposure forecasting. Run createMissingSourceSheets() in automation/Snapshot.gs to create it with the right headers.
- Daily team activity report — Needed to attribute outcome changes to team actions rather than to Fiverr's algorithm.


---

*Generated 2026-07-29 by the XStudioz growth engine. Read-only: no source sheet was modified.*