# XStudioz — What Next · Sunday 16 August 2026

**Organic health: 🟢 HEALTHY** · index 79/100

## Money sitting still

**$7,355** is committed or quoted and not moving — $1,180 in orders open more than 60 days, $6,175 in quotes that were never placed.

| Open orders | Count | Value |
| :-- | --: | --: |
| 0-7 days | 5 | $520 |
| 8-30 days | 9 | $2,105 |
| 31-60 days | 1 | $150 |
| 60+ days ⚠️ | 10 | $1,180 |
| **All open** | **25** | **$3,955** |

**Oldest open orders**

| Client | Age | Status | Value | Designer |
| :-- | --: | :-- | --: | :-- |
| osmanbey_35 | 283d | in_progress | $250 | Aashir |
| faisalkazmi53 | 199d | in_progress | MISSING | Shaoor |
| jordyspikker | 155d | revision | $100 | Ahmed Ashfaq |
| calumsnell | 153d | revision | $100 | Nime |
| kuykendalljr | 150d | in_progress | $75 | Saad Sajid |
| vickizhou318 | 141d | in_progress | MISSING | — |
| paolowhite | 113d | revision | $320 | Zahid |
| elite9921 | 107d | in_progress | $105 | Musharaf |

**Quotes with no follow-up ever logged** — 3 worth $295

| Client | Quoted | Age | CSR |
| :-- | --: | --: | :-- |
| akhilkpfxx | $160 | 164d | Amrah |
| zain_qw | $75 | 46d | Swaid |
| Mohamed L | $60 | 97d | — |

## Do today

### P0 · Rescue at-risk order #5 — Dr. Ali Albalawi
**Owner:** Ezan (escalate to CEO if refund is formally requested) · **Est. impact:** $400 · **Effort:** 1.5h · **Confidence:** 70%

*Why:* Buyer has raised refund/dispute language and the order is rev sent. A single 1-star review would move the public rating by 0.0023 (4.841 -> 4.838) across 1,637 reviews, and that rating is what every future buyer sorts on. The order is worth ~$97; the rating damage is worth far more.

- Read the full order history before replying — do not reintroduce any concept the buyer already rejected.
- Reply within 2 hours. Acknowledge the specific frustration in their own words; do not defend the work.
- Offer a concrete choice: (a) one senior designer takes a fresh direction at no cost, or (b) a clean partial refund and a mutual cancellation with no review.
- If they choose (a), name the designer and give a fixed date.
- If they choose (b), process it same day — a fast clean exit is cheaper than a slow 1-star.
- Script: `playbooks/dispute_rescue.md`
- Source rows: `order_tracker/tracker#b0r4`

### P0 · Close out 10 orders open more than 60 days ($1,180)
**Owner:** Ezan · **Est. impact:** $472 · **Effort:** 3.0h · **Confidence:** 60%

*Why:* 10 orders worth $1,180 have been open longer than 60 days, out of 25 open orders worth $3,955 in total. The oldest is osmanbey_35 at 283 days. Every one of these buyers has already paid or committed, so this is not new business to win — it is delivered-or-owed work nobody closed. It is also the largest single block of recoverable money in the dataset, and unlike the funnel it needs no new traffic.

- Open each order and establish one thing: is the client waiting on us, are we waiting on the client, or is it dead. That answer decides everything else and takes a minute per order.
- Where we owe work — assign it to the designer named on the row with a delivery date this week. Oldest first: osmanbey_35 (283d, $250), jordyspikker (155d, $100), calumsnell (153d, $100).
- Where the client is silent — send one message that states what was last delivered and asks a single closed question. Do not re-open the brief.
- Where it is genuinely dead — set the status so it stops appearing here, and note why in the CSR column.
- Anything still open at this time next week gets escalated, not re-listed.
- Script: `playbooks/stale_orders.md`
- Source rows: `osmanbey_35: 283d, $250, in_progress`, `faisalkazmi53: 199d, MISSING, in_progress`, `jordyspikker: 155d, $100, revision`, `calumsnell: 153d, $100, revision`, `kuykendalljr: 150d, $75, in_progress`, `vickizhou318: 141d, MISSING, in_progress`, `paolowhite: 113d, $320, revision`, `elite9921: 107d, $105, in_progress`, `institutoibt: 80d, $115, revision`, `moni_rotanak: 80d, $115, revision`

### P0 · Fill revenue in the daily ledger (183 days blank)
**Owner:** Whoever owns the daily ledger · **Est. impact:** $2,000 · **Effort:** 2.0h · **Confidence:** 90%

*Why:* 183 ledger days record orders but $0 revenue. Every revenue forecast, the AOV target and the whole revenue side of the objective are currently inferred from the CRM sheet instead of measured, because this column is empty.

- Fill every revenue column in the ledger for every day that recorded orders.
- Backfill from 2026-06-11 forward — that is where the ledger starts.
- This is the single highest-value data fix available: it unblocks revenue forecasting entirely.
- Script: `playbooks/data_hygiene.md`

### P1 · Wire up the 1 promised data source
**Owner:** CEO · **Est. impact:** $1,500 · **Effort:** 1.0h · **Confidence:** 50%

*Why:* 1 sources are referenced by the plan but not readable by the engine: Disputed / dead / conflicted orders sheet. Until they exist, dispute exposure, impression-vs-conversion attribution and team-activity attribution are all guesses. In particular, without impressions the engine cannot tell whether an organic decline is falling reach or falling conversion — and those need opposite responses.

- Needed for dispute-risk scoring and refund-exposure forecasting. Run createMissingSourceSheets() in automation/Snapshot.gs to create it with the right headers.
- Share each sheet with the Google account the engine reads as, then add its file_id to config/sources.yml.
- Script: `playbooks/data_hygiene.md`

### P1 · Route high-value briefs to Md Rezaul
**Owner:** CEO · **Est. impact:** $800 · **Effort:** 0.5h · **Confidence:** 35%

*Why:* Md Rezaul averages $151 across 8 orders; Nimeazad averages $76 across 21. Some of that is brief mix rather than skill — but routing the $200+ briefs to the designers who already deliver at that level protects both AOV and rating.

- Assign every brief above $200 to Md Rezaul or the next two by AOV.
- Check whether the low-AOV designers are getting low-value briefs or producing low-value outcomes before acting on this.
- Revisit in 30 days with the engine's updated per-designer AOV.
- Script: `playbooks/staffing.md`

### P2 · Start recording upsells — the column is empty
**Owner:** All CSRs · **Est. impact:** $1,200 · **Effort:** 1.5h · **Confidence:** 50%

*Why:* Upsell is marked on 0.0% of the 150 orders whose tab has an Upsell column. That is not a low upsell rate, it is an unused column. The highest-value lever in the funnel currently cannot be measured, which means it cannot be improved or defended.

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

### P2 · Upsell Calum Snell (order #4)
**Owner:** Salman (highest value-per-lead at $53) · **Est. impact:** $180 · **Effort:** 0.4h · **Confidence:** 35%

*Why:* Buyer left on warm terms, which is the only reliable upsell signal in this dataset. Inquiries where an upsell was attempted converted 54.3% against 30.8% without. Upsell is recorded on 0.2% of orders today, so this is close to untouched revenue.

- Lead with what they already have, not with a price.
- Offer the next tier that fits their brand stage: brand guidelines, social kit, stationery, or a sub-brand.
- Anchor at the $151-$260 band — it is the top quartile of your order book and it lands with buyers who already trust you.
- Log the attempt in the Upsell column either way. The column is empty today, which is why this lever cannot be measured.
- Script: `playbooks/upsell.md`
- Source rows: `order_tracker/tracker#b0r3`

### P3 · Close out approved order #4 — Calum Snell
**Owner:** Delivery lead · **Est. impact:** $87 · **Effort:** 1.0h · **Confidence:** 80%

*Why:* Concept is approved, so the creative risk is gone and the only thing between this and banked revenue plus a review is asset prep. This is the cheapest revenue on the board.

- Ship the full final package today: vectors, all formats, variations, fonts, colour values.
- Deliver via the order (not chat) so it counts toward on-time delivery.
- Attach the review request from playbooks/review_capture.md — only 12.7% of completed orders currently have a review recorded.
- Script: `playbooks/review_capture.md`
- Source rows: `order_tracker/tracker#b0r3`

### P3 · Close out approved order #6 — bethanyjademck
**Owner:** Delivery lead · **Est. impact:** $87 · **Effort:** 1.0h · **Confidence:** 80%

*Why:* Concept is approved, so the creative risk is gone and the only thing between this and banked revenue plus a review is asset prep. This is the cheapest revenue on the board.

- Ship the full final package today: vectors, all formats, variations, fonts, colour values.
- Deliver via the order (not chat) so it counts toward on-time delivery.
- Attach the review request from playbooks/review_capture.md — only 12.7% of completed orders currently have a review recorded.
- Script: `playbooks/review_capture.md`
- Source rows: `order_tracker/tracker#b0r5`

### P3 · Follow up the 3 quotes that never got one ($295)
**Owner:** Ezan · **Est. impact:** $58 · **Effort:** 1.5h · **Confidence:** 45%

*Why:* 3 buyers were quoted $295 between them and no follow-up was ever logged against any of them — the largest is akhilkpfxx at $160, quoted 164 days ago. That sits inside a total unanswered pipeline of $6,175 across 20 leads. Of the 28 quoted leads anyone did chase, 11 placed (39%); this is costed at half that, because these are older. Note the raw split is misleading: quoted leads with no follow-up appear to convert at 97%, but that is because a follow-up only gets logged when the buyer did not say yes immediately. These 3 are the residue of that group, not part of its success.

- Work the never-followed-up list first, largest first: akhilkpfxx ($160, 164d), zain_qw ($75, 46d), Mohamed L ($60, 97d).
- One message each. State the quote is still open, and ask one question they can answer in a word — whether the project is still live. Do not re-pitch and do not discount unprompted.
- Log the touch in the FollowUp column the same day, or the next run will tell you to send it again.
- Then work the remainder by value; treat a third unanswered follow-up as a no and stop.
- Script: `playbooks/dead_pipeline.md`
- Source rows: `akhilkpfxx: $160, 164d, 0 follow-ups`, `zain_qw: $75, 46d, 0 follow-ups`, `Mohamed L: $60, 97d, 0 follow-ups`, `bobzinos: $900, 151d, 1 follow-ups`, `farida_ism: $700, 184d, 1 follow-ups`, `tatiana_1017: $510, 11d, 1 follow-ups`, `ryan_wonders: $350, 110d, 1 follow-ups`, `rztwerk: $250, 20d, 1 follow-ups`, `chupetes: $200, 159d, 1 follow-ups`, `dgtl_depot: $175, 192d, 1 follow-ups`

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
- **P0** Close out 10 orders open more than 60 days ($1,180)
- **P1** Route high-value briefs to Md Rezaul

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

- **P0** Fill revenue in the daily ledger (183 days blank)
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
*4 task(s), ~3.4h*

- **P1** Wire up the 1 promised data source
- **P2** Upsell Calum Snell (order #4)
- **P3** Close out approved order #6 — bethanyjademck
- **P3** Close out approved order #4 — Calum Snell

Standing duties, every shift:
- Answer every new first-message within 30 minutes. Response rate counts only the first message in a thread, on a 24-hour window, rolling 90 days.
- Report spam as spam within 24 hours — it then does not count against response rate. Most agencies bleed this metric on messages they could have flagged in three seconds.
- Post the 12-question intake within 15 minutes of any order starting.
- Send the 50%-elapsed checkpoint on every live order. This is the habit that converts an invisible 3-star private rating into a fixed order.
- Log every quoted price into the inquiry sheet the moment it is sent.
- Never move a pre-order conversation off Fiverr, and never argue.

### Amrah · csr · 09:00-17:00 PKT
*2 task(s), ~3.0h*

- **P2** Start recording upsells — the column is empty
- **P3** Follow up the 3 quotes that never got one ($295)

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
| 2026-08-23 | Organic orders over the 7 days to 23 Aug will be 18.0 (80% CI 12.5-23.4). | 12.53 – 23.38 | medium |
| 2026-08-30 | Organic health index in 14 days will be 79 (80% CI 39-102). | 39.09 – 101.91 | medium |
| 2026-08-23 | Total orders/day averaged over the next 7 days will be 5.18 (80% CI 4.08-6.29). | 4.08 – 6.29 | medium |
| 2026-09-15 | Blended AOV in 30 days will be $97 (80% CI $83-$120). | 82.55 – 119.78 | high |
| 2026-08-23 | Inquiry->order conversion in 7 days will be 23.9% (80% CI 18.7%-27.5%). | 0.19 – 0.28 | high |

**Track record:** 91 resolved, coverage 47% 
(target 80%), median absolute error 26%.


---

## Where the business actually is

| Metric | Value | Note |
|---|---|---|
| Organic orders/day (7d MA) | 2.86 | vs 0.86 14d ago |
| Organic, recent vs earlier | 1.32/day | was 0.66/day (+101.7%) |
| Organic orders, 7d to 15 Aug | 20 | 2.86/day |
| AOV | $97 | median $75, n=123 priced orders |
| Lifetime tracked revenue | $11,942 | across 150 order rows |
| Inquiry conversion | 23.9% | 22/92 |
| Upsell recorded | 0.0% | column is effectively unused |
| Review capture | 49.3% | 74/150 orders that could be rated |
| Gig rating | 4.841 | 1,637 reviews, Level 2 |
| Orders in queue | 22 | live from the gig page |

### Revenue path

At 2.86 orders/day and $97 AOV, the next 30 days project **$8,322** (86 orders).

**No 30-day revenue target is set**, so nothing here can say whether the month is on track. Set `targets.monthly_revenue.t30` in `config/profile.yml`. This line used to read "On track against the 30-day target", which a target of zero clears every single day.

### Funnel leverage

| Segment | n | Conversion | Lower bound |
|---|---|---|---|
| Shift: Night | 26 | 38.5% | 22.4% |
| Shift: Evening | 31 | 25.8% | 13.7% |
| Shift: Morning | 30 | 13.3% | 5.3% |
| United Kingdom | 33 | 36.4% | 22.2% |
| United States | 21 | 28.6% | 13.8% |

Ranked on the Wilson lower bound, not raw rate, so small samples cannot outrank large ones.


---

## Data feeds

| Feed | State | As of | Age | Where it comes from |
|---|---|---|---|---|
| Snapshot credentials | 🟢 live | — | 0h | XSTUDIOZ_SNAPSHOT_URL / _TOKEN in the environment |
| Order and inquiry workbooks | 🟢 live | 2026-08-16T08:59:25.971000+00:00 | 0h | Apps Script snapshot endpoint |
| Impressions sheet (engine) | 🟠 stale | 2026-08-06 | 237h | Daily Data Sheet, via the snapshot |
| Fiverr gig page | 🟢 live | 2026-08-16 | -3h | browser capture into data/raw/gig/ |
| CSR handoff tracker | 🟠 stale | 2026-07-29 | 434h | uploaded into data/raw/order_tracker/ |

- **Impressions sheet (engine)** — newest row 2026-08-06. Nobody has filled in the Daily Data Sheet since 2026-08-06.
- **CSR handoff tracker** — 2026-07-29-XOrder_Tracker.xlsx. Upload a fresh tracker export.


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
- `warn` **retired_sources_refused** — 1 table(s) from retired sheets were refused and not counted: impressions (1 tables, 162 rows). That data is typed into the hub now. Stop serving the sheet or the same fact lives in two places.
- `warn` **all_tasks_evidenced** — 10/12 tasks cite a number in their rationale

**Data sources still missing**
- Disputed / dead / conflicted orders sheet — Needed for dispute-risk scoring and refund-exposure forecasting. Run createMissingSourceSheets() in automation/Snapshot.gs to create it with the right headers.


---

*Generated 2026-08-16 by the XStudioz growth engine. Read-only: no source sheet was modified.*