# XStudioz — What Next · Wednesday 29 July 2026

**Organic health: 🟠 SOFTENING** · index 45/100

## Money sitting still

**$8,007** is committed or quoted and not moving — $2,285 in orders open more than 60 days, $5,722 in quotes that were never placed.

| Open orders | Count | Value |
| :-- | --: | --: |
| 0-7 days | 7 | $1,085 |
| 8-30 days | 6 | $1,425 |
| 31-60 days | 2 | $295 |
| 60+ days ⚠️ | 17 | $2,285 |
| **All open** | **32** | **$5,090** |

**Oldest open orders**

| Client | Age | Status | Value | Designer |
| :-- | --: | :-- | --: | :-- |
| osmanbey_35 | 265d | in_progress | $250 | Aashir |
| johnjk001 | 209d | delivered | $0 | Dulal Khan |
| faisalkazmi53 | 181d | in_progress | $0 | Shaoor |
| madewelltech | 171d | delivered | $120 | Amin |
| andrem530 | 156d | revision | $295 | Amin |
| jordyspikker | 137d | revision | $100 | Ahmed Ashfaq |
| calumsnell | 135d | revision | $100 | Nime |
| kuykendalljr | 132d | in_progress | $75 | Saad Sajid |

**Quotes with no follow-up ever logged** — 6 worth $1,477

| Client | Quoted | Age | CSR |
| :-- | --: | --: | :-- |
| selmaprof | $950 | 26d | Iqra |
| akhilkpfxx | $160 | 146d | — |
| architpatel497 | $147 | 34d | Iqra |
| kai_utzinger | $85 | 93d | — |
| zain_qw | $75 | 28d | Swaid |
| Mohamed L | $60 | 79d | — |

## Do today

### P0 · Rescue at-risk order #5 — Dr. Ali Albalawi
**Owner:** Ezan (escalate to CEO if refund is formally requested) · **Est. impact:** $400 · **Effort:** 1.5h · **Confidence:** 70%

*Why:* Buyer has raised refund/dispute language and the order is rev sent. A single 1-star review would move the public rating by 0.0024 (4.834 -> 4.832) across 1,583 reviews, and that rating is what every future buyer sorts on. The order is worth ~$109; the rating damage is worth far more.

- Read the full order history before replying — do not reintroduce any concept the buyer already rejected.
- Reply within 2 hours. Acknowledge the specific frustration in their own words; do not defend the work.
- Offer a concrete choice: (a) one senior designer takes a fresh direction at no cost, or (b) a clean partial refund and a mutual cancellation with no review.
- If they choose (a), name the designer and give a fixed date.
- If they choose (b), process it same day — a fast clean exit is cheaper than a slow 1-star.
- Script: `playbooks/dispute_rescue.md`
- Source rows: `order_tracker/tracker#b0r4`

### P0 · Close out 17 orders open more than 60 days ($2,285)
**Owner:** Ezan · **Est. impact:** $914 · **Effort:** 3.0h · **Confidence:** 60%

*Why:* 17 orders worth $2,285 have been open longer than 60 days, out of 32 open orders worth $5,090 in total. The oldest is osmanbey_35 at 265 days. Every one of these buyers has already paid or committed, so this is not new business to win — it is delivered-or-owed work nobody closed. It is also the largest single block of recoverable money in the dataset, and unlike the funnel it needs no new traffic.

- Open each order and establish one thing: is the client waiting on us, are we waiting on the client, or is it dead. That answer decides everything else and takes a minute per order.
- Where we owe work — assign it to the designer named on the row with a delivery date this week. Oldest first: osmanbey_35 (265d, $250), madewelltech (171d, $120), andrem530 (156d, $295).
- Where the client is silent — send one message that states what was last delivered and asks a single closed question. Do not re-open the brief.
- Where it is genuinely dead — set the status so it stops appearing here, and note why in the CSR column.
- Anything still open at this time next week gets escalated, not re-listed.
- Script: `playbooks/stale_orders.md`
- Source rows: `osmanbey_35: 265d, $250, in_progress`, `johnjk001: 209d, $0, delivered`, `faisalkazmi53: 181d, $0, in_progress`, `madewelltech: 171d, $120, delivered`, `andrem530: 156d, $295, revision`, `jordyspikker: 137d, $100, revision`, `calumsnell: 135d, $100, revision`, `kuykendalljr: 132d, $75, in_progress`, `vickizhou318: 123d, $0, in_progress`, `paolowhite: 95d, $320, delivered`

### P0 · Fill revenue in the daily ledger (112 days blank)
**Owner:** Whoever owns the daily ledger · **Est. impact:** $2,000 · **Effort:** 2.0h · **Confidence:** 90%

*Why:* 112 ledger days record orders but $0 revenue. Every revenue forecast, the AOV target and the whole revenue side of the objective are currently inferred from the CRM sheet instead of measured, because this column is empty.

- Fill every revenue column in the ledger for every day that recorded orders.
- Backfill from 2026-06-11 forward — that is where the ledger starts.
- This is the single highest-value data fix available: it unblocks revenue forecasting entirely.
- Script: `playbooks/data_hygiene.md`

### P1 · Wire up the 2 promised data sources
**Owner:** CEO · **Est. impact:** $1,500 · **Effort:** 1.0h · **Confidence:** 50%

*Why:* 2 sources are referenced by the plan but not readable by the engine: Disputed / dead / conflicted orders sheet, Daily team activity report. Until they exist, dispute exposure, impression-vs-conversion attribution and team-activity attribution are all guesses. In particular, without impressions the engine cannot tell whether an organic decline is falling reach or falling conversion — and those need opposite responses.

- Needed for dispute-risk scoring and refund-exposure forecasting. Run createMissingSourceSheets() in automation/Snapshot.gs to create it with the right headers.
- Needed to attribute outcome changes to team actions rather than to Fiverr's algorithm.
- Share each sheet with the Google account the engine reads as, then add its file_id to config/sources.yml.
- Script: `playbooks/data_hygiene.md`

### P1 · Route high-value briefs to Amin
**Owner:** CEO · **Est. impact:** $800 · **Effort:** 0.5h · **Confidence:** 35%

*Why:* Amin averages $134 across 7 orders; Abiha averages $72 across 6. Some of that is brief mix rather than skill — but routing the $200+ briefs to the designers who already deliver at that level protects both AOV and rating.

- Assign every brief above $200 to Amin or the next two by AOV.
- Check whether the low-AOV designers are getting low-value briefs or producing low-value outcomes before acting on this.
- Revisit in 30 days with the engine's updated per-designer AOV.
- Script: `playbooks/staffing.md`

### P2 · Start recording upsells — the column is empty
**Owner:** All CSRs · **Est. impact:** $1,200 · **Effort:** 1.5h · **Confidence:** 50%

*Why:* Upsell is marked on 0.0% of the 54 orders whose tab has an Upsell column. That is not a low upsell rate, it is an unused column. The highest-value lever in the funnel currently cannot be measured, which means it cannot be improved or defended.

- Fill the Upsell column on every order: TRUE/FALSE, no blanks.
- Fill 'What did you upsell and how much' whenever TRUE.
- Backfill the last 30 completed orders from memory this week.
- Script: `playbooks/upsell.md`

### P2 · Upsell andrem530 (order #1)
**Owner:** Salman (highest value-per-lead at $53) · **Est. impact:** $180 · **Effort:** 0.4h · **Confidence:** 35%

*Why:* Buyer left on warm terms, which is the only reliable upsell signal in this dataset. Inquiries where an upsell was attempted converted 54.3% against 30.8% without. Upsell is recorded on 0.2% of orders today, so this is close to untouched revenue.

- Lead with what they already have, not with a price.
- Offer the next tier that fits their brand stage: brand guidelines, social kit, stationery, or a sub-brand.
- Anchor at the $151-$260 band — it is the top quartile of your order book and it lands with buyers who already trust you.
- Log the attempt in the Upsell column either way. The column is empty today, which is why this lever cannot be measured.
- Script: `playbooks/upsell.md`
- Source rows: `order_tracker/tracker#b0r0`

### P3 · Follow up the 6 quotes that never got one ($1,477)
**Owner:** Ezan · **Est. impact:** $289 · **Effort:** 1.5h · **Confidence:** 45%

*Why:* 6 buyers were quoted $1,477 between them and no follow-up was ever logged against any of them — the largest is selmaprof at $950, quoted 26 days ago. That sits inside a total unanswered pipeline of $5,722 across 20 leads. Of the 23 quoted leads anyone did chase, 9 placed (39%); this is costed at half that, because these are older. Note the raw split is misleading: quoted leads with no follow-up appear to convert at 91%, but that is because a follow-up only gets logged when the buyer did not say yes immediately. These 6 are the residue of that group, not part of its success.

- Work the never-followed-up list first, largest first: selmaprof ($950, 26d), akhilkpfxx ($160, 146d), architpatel497 ($147, 34d), kai_utzinger ($85, 93d).
- One message each. State the quote is still open, and ask one question they can answer in a word — whether the project is still live. Do not re-pitch and do not discount unprompted.
- Log the touch in the FollowUp column the same day, or the next run will tell you to send it again.
- Then work the remainder by value; treat a third unanswered follow-up as a no and stop.
- Script: `playbooks/dead_pipeline.md`
- Source rows: `selmaprof: $950, 26d, 0 follow-ups`, `akhilkpfxx: $160, 146d, 0 follow-ups`, `architpatel497: $147, 34d, 0 follow-ups`, `kai_utzinger: $85, 93d, 0 follow-ups`, `zain_qw: $75, 28d, 0 follow-ups`, `Mohamed L: $60, 79d, 0 follow-ups`, `bobzinos: $900, 133d, 1 follow-ups`, `farida_ism: $700, 166d, 1 follow-ups`, `ryan_wonders: $350, 92d, 1 follow-ups`, `rztwerk: $250, 2d, 1 follow-ups`

### P3 · Close out approved order #4 — Calum Snell
**Owner:** Delivery lead · **Est. impact:** $98 · **Effort:** 1.0h · **Confidence:** 80%

*Why:* Concept is approved, so the creative risk is gone and the only thing between this and banked revenue plus a review is asset prep. This is the cheapest revenue on the board.

- Ship the full final package today: vectors, all formats, variations, fonts, colour values.
- Deliver via the order (not chat) so it counts toward on-time delivery.
- Attach the review request from playbooks/review_capture.md — only 12.7% of completed orders currently have a review recorded.
- Script: `playbooks/review_capture.md`
- Source rows: `order_tracker/tracker#b0r3`

### P3 · Close out approved order #6 — bethanyjademck
**Owner:** Delivery lead · **Est. impact:** $98 · **Effort:** 1.0h · **Confidence:** 80%

*Why:* Concept is approved, so the creative risk is gone and the only thing between this and banked revenue plus a review is asset prep. This is the cheapest revenue on the board.

- Ship the full final package today: vectors, all formats, variations, fonts, colour values.
- Deliver via the order (not chat) so it counts toward on-time delivery.
- Attach the review request from playbooks/review_capture.md — only 12.7% of completed orders currently have a review recorded.
- Script: `playbooks/review_capture.md`
- Source rows: `order_tracker/tracker#b0r5`

### P3 · Upsell Calum Snell (order #4)
**Owner:** Salman (highest value-per-lead at $53) · **Est. impact:** $180 · **Effort:** 0.4h · **Confidence:** 35%

*Why:* Buyer left on warm terms, which is the only reliable upsell signal in this dataset. Inquiries where an upsell was attempted converted 54.3% against 30.8% without. Upsell is recorded on 0.2% of orders today, so this is close to untouched revenue.

- Lead with what they already have, not with a price.
- Offer the next tier that fits their brand stage: brand guidelines, social kit, stationery, or a sub-brand.
- Anchor at the $151-$260 band — it is the top quartile of your order book and it lands with buyers who already trust you.
- Log the attempt in the Upsell column either way. The column is empty today, which is why this lever cannot be measured.
- Script: `playbooks/upsell.md`
- Source rows: `order_tracker/tracker#b0r3`

### P3 · Upsell bethanyjademck (order #6)
**Owner:** Salman (highest value-per-lead at $53) · **Est. impact:** $180 · **Effort:** 0.4h · **Confidence:** 35%

*Why:* Buyer left on warm terms, which is the only reliable upsell signal in this dataset. Inquiries where an upsell was attempted converted 54.3% against 30.8% without. Upsell is recorded on 0.2% of orders today, so this is close to untouched revenue.

- Lead with what they already have, not with a price.
- Offer the next tier that fits their brand stage: brand guidelines, social kit, stationery, or a sub-brand.
- Anchor at the $151-$260 band — it is the top quartile of your order book and it lands with buyers who already trust you.
- Log the attempt in the Upsell column either way. The column is empty today, which is why this lever cannot be measured.
- Script: `playbooks/upsell.md`
- Source rows: `order_tracker/tracker#b0r5`


---

## Who does what

### Ezan · team lead · all hours
*3 task(s), ~5.0h*

- **P0** Rescue at-risk order #5 — Dr. Ali Albalawi
- **P0** Close out 17 orders open more than 60 days ($2,285)
- **P1** Route high-value briefs to Amin

Standing duties, every shift:
- QA gate: nothing ships without a check against the question-11 deliverable list. Watermarks removed, fonts noted, vectors included.
- Reconcile the inquiry log against the order tracker. On 27 July the tracker showed 5 orders and the inquiry log showed 2 for the whole month; until those agree, no conversion figure is trustworthy.
- Take the shift handoff at each changeover — five lines, no exceptions.
- Escalate any cancellation risk before it is filed, never after.

### CEO · ceo · —
*No assigned tasks today — standing duties only.*

Standing duties, every shift:
- Post impressions and the 7-day average every morning. It is the single number that says whether the suppression is lifting.
- Watch the blended AOV against the organic AOV every week. When the two diverge, the profile is being priced below what its review base can carry, and the objective is revenue, not order count.
- Any order past day 7, or any cancellation, comes to you the same day.

### Nadir · csr · 21:00-09:00 PKT
*3 task(s), ~2.8h*

- **P0** Fill revenue in the daily ledger (112 days blank)
- **P2** Upsell andrem530 (order #1)
- **P3** Upsell bethanyjademck (order #6)

Standing duties, every shift:
- Answer every new first-message within 30 minutes. Response rate counts only the first message in a thread, on a 24-hour window, rolling 90 days.
- Report spam as spam within 24 hours — it then does not count against response rate. Most agencies bleed this metric on messages they could have flagged in three seconds.
- Post the 12-question intake within 15 minutes of any order starting.
- Send the 50%-elapsed checkpoint on every live order. This is the habit that converts an invisible 3-star private rating into a fixed order.
- Log every quoted price into the inquiry sheet the moment it is sent.
- Never move a pre-order conversation off Fiverr, and never argue.

### Hasnain · csr · 17:00-01:00 PKT
*3 task(s), ~3.5h*

- **P1** Wire up the 2 promised data sources
- **P3** Follow up the 6 quotes that never got one ($1,477)
- **P3** Close out approved order #4 — Calum Snell

Standing duties, every shift:
- Answer every new first-message within 30 minutes. Response rate counts only the first message in a thread, on a 24-hour window, rolling 90 days.
- Report spam as spam within 24 hours — it then does not count against response rate. Most agencies bleed this metric on messages they could have flagged in three seconds.
- Post the 12-question intake within 15 minutes of any order starting.
- Send the 50%-elapsed checkpoint on every live order. This is the habit that converts an invisible 3-star private rating into a fixed order.
- Log every quoted price into the inquiry sheet the moment it is sent.
- Never move a pre-order conversation off Fiverr, and never argue.

### Amrah · csr · 09:00-17:00 PKT
*3 task(s), ~2.9h*

- **P2** Start recording upsells — the column is empty
- **P3** Upsell Calum Snell (order #4)
- **P3** Close out approved order #6 — bethanyjademck

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

**Dygram is the experiment already run** — Dygram holds Success Score 9 against X Studioz's 8, and pulls 8x the impressions (12,700/day against 1,564). Same operator, same team, same category, same marketplace. Whatever is different between the two profiles is worth more than any competitor study — diagnose it directly rather than theorising about the algorithm.

**1,583 reviews is the moat, and it is being spent on cheap orders** — Almost no competitor in logo design can match that review base. It is a conversion advantage that compounds — and it is currently attached to a low average order value. The same trust aimed at $150-$260 work is the single largest untaken edge here, and it costs nothing to try.

**Half the revenue is from people who already know you** — 158 of 574 clients have ordered more than once, producing 48.2% of orders and $38,724 of revenue — with the Upsell column at 0.0% filled. Competitors fight for the first order. Nobody is fighting for the second one here, including us.


---

## Predictions

Each is scored automatically on its resolution date and feeds interval calibration.

| Resolve on | Prediction | 80% interval | Confidence |
|---|---|---|---|
| 2026-08-05 | Organic orders over the 7 days to 05 Aug will be 5.6 (80% CI 2.6-8.6). | 2.57 – 8.63 | medium |
| 2026-08-12 | Organic health index in 14 days will be 45 (80% CI 29-69). | 28.97 – 68.89 | medium |
| 2026-08-05 | Total orders/day averaged over the next 7 days will be 3.21 (80% CI 2.34-4.07). | 2.34 – 4.07 | medium |
| 2026-08-28 | Blended AOV in 30 days will be $109 (80% CI $98-$120). | 97.86 – 120.10 | high |
| 2026-08-05 | Inquiry->order conversion in 7 days will be 8.0% (80% CI 7.0%-9.0%). | 0.07 – 0.09 | high |

**Track record:** 57 resolved, coverage 61% 
(target 80%), median absolute error 11%.


---

## Where the business actually is

| Metric | Value | Note |
|---|---|---|
| Organic orders/day (7d MA) | 0.71 | vs 0.71 14d ago |
| Organic, recent vs earlier | 0.56/day | was 0.58/day (-3.6%) |
| Organic orders, last 7d | 5 | 0.71/day |
| AOV | $109 | median $80, n=52 priced orders |
| Lifetime tracked revenue | $5,667 | across 54 order rows |
| Inquiry conversion | 8.0% | 2/25 |
| Upsell recorded | 0.0% | column is effectively unused |
| Review capture | 51.9% | 28/54 orders that could be rated |
| Gig rating | 4.834 | 1,583 reviews, Level 2 |
| Orders in queue | 20 | live from the gig page |

### Revenue path

At 0.71 orders/day and $109 AOV, the next 30 days project **$2,335** (21 orders).

On track against the 30-day target.

### Funnel leverage

| Segment | n | Conversion | Lower bound |
|---|---|---|---|

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
- Daily team activity report — Needed to attribute outcome changes to team actions rather than to Fiverr's algorithm.


---

*Generated 2026-07-29 by the XStudioz growth engine. Read-only: no source sheet was modified.*