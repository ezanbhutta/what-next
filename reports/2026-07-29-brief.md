# XStudioz — What Next · Wednesday 29 July 2026

**Organic health: 🔴 BREACH** · index 39/100 · VVRO share 79% (cap 45%)

> Place **1 VVRO order today** (1x $86-$150) — quota **2/week**.

**Why the constraint is breached**
- structural: organic -14.3% since VVRO began 2026-07-13 (0.66 -> 0.56/day)

## Do today

### P0 · Rescue at-risk order #5 — Dr. Ali Albalawi
**Owner:** Ezan (escalate to CEO if refund is formally requested) · **Est. impact:** $400 · **Effort:** 1.5h · **Confidence:** 70%

*Why:* Buyer has raised refund/dispute language and the order is rev sent. A single 1-star review would move the public rating by 0.0024 (4.837 -> 4.834) across 1,582 reviews, and that rating is what every future buyer sorts on. The order is worth ~$128; the rating damage is worth far more.

- Read the full order history before replying — do not reintroduce any concept the buyer already rejected.
- Reply within 2 hours. Acknowledge the specific frustration in their own words; do not defend the work.
- Offer a concrete choice: (a) one senior designer takes a fresh direction at no cost, or (b) a clean partial refund and a mutual cancellation with no review.
- If they choose (a), name the designer and give a fixed date.
- If they choose (b), process it same day — a fast clean exit is cheaper than a slow 1-star.
- Script: `playbooks/dispute_rescue.md`
- Source rows: `order_tracker/tracker#b0r4`

### P0 · VVRO: 2/week (1 today) — CUT
**Owner:** CEO / order placement · **Est. impact:** $826 · **Effort:** 0.5h · **Confidence:** 80%

*Why:* Organic constraint breached — structural: organic -14.3% since VVRO began 2026-07-13 (0.66 -> 0.56/day). The objective makes organic recovery a hard constraint, so the dose is cut by 2/day and revenue upside is ignored until flow recovers. Quota 2/week (0.29/day); share cap allows 0.58/day.

- Place **1 VVRO order today** (1x $86-$150) — quota **2/week**.
- Countries to spread across: Other x1
- At this quota the VVRO share settles at 29%, against a cap of 0.58 VVRO/day at the current organic rate.
- Do not place on a fixed weekday pattern — the schedule rotates weekly for a reason.
- Log every placement in the daily ledger with its real amount. Revenue columns are currently all zero, which blinds the whole controller.
- Script: `playbooks/vvro_dosing.md`

### P0 · Fill revenue in the daily ledger (111 days blank)
**Owner:** Whoever owns the daily ledger · **Est. impact:** $2,000 · **Effort:** 2.0h · **Confidence:** 90%

*Why:* 111 ledger days record orders but $0 revenue. Every revenue forecast, the AOV target and the whole revenue side of the objective are currently inferred from the CRM sheet instead of measured, because this column is empty.

- Fill Organic Revenue and VVRO Revenue for every day with orders.
- Backfill from 2026-06-11 forward — that is where the ledger starts.
- This is the single highest-value data fix available: it unblocks revenue forecasting entirely.
- Script: `playbooks/data_hygiene.md`

### P0 · Request a review on every delivery (~+139 reviews in 90d)
**Owner:** Delivery lead + all CSRs · **Est. impact:** $3,472 · **Effort:** 1.0h · **Confidence:** 45%

*Why:* Only 13.6% of the 597 orders on tabs that track reviews have one recorded. At the current 3.00 orders/day, lifting capture to 65% yields about 139 extra reviews over 90 days. Review velocity is a direct gig-ranking input and the only growth lever here that costs nothing and carries no platform risk.

- Add the review request to the delivery message template so it is sent automatically, not remembered.
- Ask at the moment of approval, not days later.
- Record the outcome in the REVIEW column every time — 'no review' is data, blank is not.
- Never ask for 5 stars explicitly; that violates Fiverr ToS and risks the account.
- Script: `playbooks/review_capture.md`

### P1 · Run the upsell A/B test to de-bias the 54% vs 31% gap
**Owner:** CEO + Salman · **Est. impact:** $3,000 · **Effort:** 1.0h · **Confidence:** 40%

*Why:* Leads with an upsell attempt convert 54.3% (n=70) against 30.8% (n=929), z=4.05. That is a +76% relative lift — but it is observational, and CSRs choose who to upsell. The test tells you how much of it is real.

- For the next 100 inbound inquiries, alternate strictly: odd-numbered leads get an upsell attempt, even-numbered do not.
- Do not let CSRs choose. That choice is exactly the bias being measured.
- Log the assignment in the Upsell column so the engine can score it.
- The engine will report the de-biased effect once n>=100 per arm.
- Script: `playbooks/upsell.md`

### P2 · Wire up the 3 promised data sources
**Owner:** CEO · **Est. impact:** $1,500 · **Effort:** 1.0h · **Confidence:** 50%

*Why:* 3 sources are referenced by the plan but not readable by the engine: Disputed / dead / conflicted orders sheet, Impression system, Daily team activity report. Until they exist, dispute exposure, impression-vs-conversion attribution and team-activity attribution are all guesses. In particular, without impressions the engine cannot tell whether an organic decline is falling reach or falling conversion — and those need opposite responses.

- Needed for dispute-risk scoring and refund-exposure forecasting. Run createMissingSourceSheets() in automation/Snapshot.gs to create it with the right headers.
- Needed to separate demand-side (impressions) from conversion-side (CTR/order rate) causes when organic flow moves. Run createMissingSourceSheets() in automation/Snapshot.gs to create it with the right headers.
- Needed to attribute outcome changes to team actions rather than to Fiverr's algorithm.
- Share each sheet with the Google account the engine reads as, then add its file_id to config/sources.yml.
- Script: `playbooks/data_hygiene.md`

### P2 · Route high-value briefs to Amin
**Owner:** CEO · **Est. impact:** $800 · **Effort:** 0.5h · **Confidence:** 35%

*Why:* Amin averages $195 across 21 orders; Abbas averages $70 across 24. Some of that is brief mix rather than skill — but routing the $200+ briefs to the designers who already deliver at that level protects both AOV and rating.

- Assign every brief above $200 to Amin or the next two by AOV.
- Check whether the low-AOV designers are getting low-value briefs or producing low-value outcomes before acting on this.
- Revisit in 30 days with the engine's updated per-designer AOV.
- Script: `playbooks/staffing.md`

### P2 · Stop third follow-ups entirely
**Owner:** All CSRs · **Est. impact:** $380 · **Effort:** 0.5h · **Confidence:** 70%

*Why:* Third follow-ups have converted 0 of 19 leads. That is not a low yield, it is a zero yield. The CSR hours currently spent on F3 are pure loss and are better spent on Tier 1 leads and upsells to existing buyers.

- Cap the follow-up ladder at two touches.
- Reassign the freed time to upselling completed orders — that is where the measured 54.3% vs 30.8% gap lives.
- Note: the follow-up ladder is confounded (only cold leads get chased), so this is a decision about F3 cost, not proof that follow-ups hurt. F1 stays.
- Script: `playbooks/lead_triage.md`

### P3 · Close out approved order #4 — Calum Snell
**Owner:** Delivery lead · **Est. impact:** $116 · **Effort:** 1.0h · **Confidence:** 80%

*Why:* Concept is approved, so the creative risk is gone and the only thing between this and banked revenue plus a review is asset prep. This is the cheapest revenue on the board.

- Ship the full final package today: vectors, all formats, variations, fonts, colour values.
- Deliver via the order (not chat) so it counts toward on-time delivery.
- Attach the review request from playbooks/review_capture.md — only 12.7% of completed orders currently have a review recorded.
- Script: `playbooks/review_capture.md`
- Source rows: `order_tracker/tracker#b0r3`

### P3 · Close out approved order #6 — bethanyjademck
**Owner:** Delivery lead · **Est. impact:** $116 · **Effort:** 1.0h · **Confidence:** 80%

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

### P3 · Triage inbound leads by country before spending CSR time
**Owner:** All CSRs · **Est. impact:** $668 · **Effort:** 1.0h · **Confidence:** 60%

*Why:* Netherlands, Australia, United States convert at 62%, 49%, 39%. United Arab Emirates, India convert at 12%, 4% across 52 leads. Equal effort on both is the single largest misallocation of CSR hours in the data.

- Tier 1 (full custom quote + meeting offer): Netherlands, Australia, United States
- Tier 2 (standard reply, one follow-up max): everyone else.
- Tier 3 (template reply, no follow-up): United Arab Emirates, India
- Never spend a meeting slot on a Tier 3 lead.
- Script: `playbooks/lead_triage.md`


---

## Inorganic (VVRO) plan

- **Action:** CUT · binding constraint: `organic_health_breach`
- **Quota:** 2/week (0.29/day) · today: **1**
- **Ceiling from share cap:** 0.58/day at the current organic rate of 0.71/day
- **Projected VVRO share at this rate:** 29%
- **Cooldown until:** 2026-08-01

| Date | Day | Place | Price bands |
|---|---|---|---|
| 2026-07-29 | Wed | 1 | 1x $86-$150 |
| 2026-07-30 | Thu | 0 | — |
| 2026-07-31 | Fri | 0 | — |
| 2026-08-01 | Sat | 1 | 1x $45-$85 |
| 2026-08-02 | Sun | 0 | — |
| 2026-08-03 | Mon | 1 | 1x $261-$450 |
| 2026-08-04 | Tue | 0 | — |

Per ISO week: **2026-W31** = 2, **2026-W32** = 1 (quota is 2/week; a 7-day window straddles two weeks, so these will not both equal the quota).


---

## Predictions

Each is scored automatically on its resolution date and feeds interval calibration.

| Resolve on | Prediction | 80% interval | Confidence |
|---|---|---|---|
| 2026-08-05 | Organic orders over the 7 days to 05 Aug will be 5.6 (80% CI 2.6-8.6). | 2.57 – 8.63 | medium |
| 2026-08-12 | Organic health index in 14 days will be 51 (80% CI 36-74). | 36.40 – 74.23 | low |
| 2026-08-05 | Total orders/day averaged over the next 7 days will be 3.21 (80% CI 2.34-4.07). | 2.34 – 4.07 | medium |
| 2026-08-28 | Blended AOV in 30 days will be $128 (80% CI $115-$141). | 115.29 – 141.49 | high |
| 2026-08-05 | Inquiry->order conversion in 7 days will be 33.5% (80% CI 29.2%-37.7%). | 0.29 – 0.38 | high |

**Track record:** 57 resolved, coverage 61% 
(target 80%), median absolute error 11%.


---

## Where the business actually is

| Metric | Value | Note |
|---|---|---|
| Organic orders/day (7d MA) | 0.71 | vs 0.71 14d ago |
| Organic since VVRO began | 0.56/day | was 0.66/day (-14.3%) |
| Total orders/day (7d) | 3.00 | 5 organic + 16 VVRO |
| AOV | $128 | median $90, n=713 priced orders |
| Lifetime tracked revenue | $91,544 | across 803 order rows |
| Inquiry conversion | 33.5% | 324/968 |
| Upsell recorded | 0.0% | column is effectively unused |
| Review capture | 13.6% | biggest free growth lever |
| Gig rating | 4.837 | 1,582 reviews, Level 2 |
| Orders in queue | 20 | live from the gig page |

### Revenue path

At 1.00 orders/day and $128 AOV, the next 30 days project **$3,852** (30 orders).

That is **$4,648 behind** the 30-day target. Two routes close it:

- **Volume:** +36 orders (+1.21/day). **Not feasible** — the organic constraint caps volume, and VVRO is already at its ceiling.
- **AOV:** raise AOV to $283 (+121%). This is the route the constraint leaves open.

### Funnel leverage

| Segment | n | Conversion | Lower bound |
|---|---|---|---|
| Shift: Morning | 643 | 38.9% | 35.2% |
| Shift: Night | 100 | 28.0% | 20.1% |
| Shift: Evening | 122 | 23.0% | 16.4% |
| Netherlands | 21 | 61.9% | 40.9% |
| Australia | 51 | 49.0% | 35.9% |
| United States | 310 | 39.4% | 34.1% |
| United Kingdom | 113 | 33.6% | 25.6% |
| Italy | 17 | 41.2% | 21.6% |
| France | 19 | 36.8% | 19.1% |

Ranked on the Wilson lower bound, not raw rate, so small samples cannot outrank large ones.


---

## System integrity

**Self-check score: 96/100** · 0 blocking failure(s)

- task_count: 10
- ownership: 20
- evidence: 21
- actionability: 15
- falsifiability: 20
- priority_spread: 10

**Checks not passing**
- `warn` **all_tasks_evidenced** — 10/12 tasks cite a number in their rationale

**Data sources still missing**
- Disputed / dead / conflicted orders sheet — Needed for dispute-risk scoring and refund-exposure forecasting. Run createMissingSourceSheets() in automation/Snapshot.gs to create it with the right headers.
- Impression system — Needed to separate demand-side (impressions) from conversion-side (CTR/order rate) causes when organic flow moves. Run createMissingSourceSheets() in automation/Snapshot.gs to create it with the right headers.
- Daily team activity report — Needed to attribute outcome changes to team actions rather than to Fiverr's algorithm.


---

*Generated 2026-07-29 by the XStudioz growth engine. Read-only: no source sheet was modified.*