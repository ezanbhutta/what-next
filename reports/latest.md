# XStudioz — What Next · Thursday 20 August 2026

**Organic health: 🟢 HEALTHY** · index 62/100

## Money sitting still

**$6,835** is committed or quoted and not moving — $535 in orders open more than 60 days, $6,300 in quotes that were never placed.

| Open orders | Count | Value |
| :-- | --: | --: |
| 0-7 days | 13 | $1,255 |
| 8-30 days | 7 | $1,945 |
| 31-60 days | 2 | $270 |
| 60+ days ⚠️ | 5 | $535 |
| **All open** | **27** | **$4,005** |

**Oldest open orders**

| Client | Age | Status | Value | Designer |
| :-- | --: | :-- | --: | :-- |
| jordyspikker | 159d | revision | $100 | Ahmed Ashfaq |
| calumsnell | 157d | revision | $100 | Nime |
| elite9921 | 111d | in_progress | $105 | Musharaf |
| institutoibt | 84d | revision | $115 | Nimeazad |
| moni_rotanak | 84d | revision | $115 | Abiha Imran |
| institutoibt | 56d | revision | $120 | Nimeazad |
| hoppycampers | 45d | revision | $150 | Amin |
| thisguy07 | 20d | revision | $250 | Amin |

**Quotes with no follow-up ever logged** — 3 worth $295

| Client | Quoted | Age | CSR |
| :-- | --: | --: | :-- |
| akhilkpfxx | $160 | 168d | Amrah |
| zain_qw | $75 | 50d | Swaid |
| Mohamed L | $60 | 101d | — |

## Do today

### P0 · Close out 5 orders open more than 60 days ($535)
**Owner:** Ezan · **Est. impact:** $214 · **Effort:** 3.0h · **Confidence:** 60%

*Why:* 5 orders worth $535 have been open longer than 60 days, out of 27 open orders worth $4,005 in total. The oldest is jordyspikker at 159 days. Every one of these buyers has already paid or committed, so this is not new business to win — it is delivered-or-owed work nobody closed. It is also the largest single block of recoverable money in the dataset, and unlike the funnel it needs no new traffic.

- Open each order and establish one thing: is the client waiting on us, are we waiting on the client, or is it dead. That answer decides everything else and takes a minute per order.
- Where we owe work — assign it to the designer named on the row with a delivery date this week. Oldest first: jordyspikker (159d, $100), calumsnell (157d, $100), elite9921 (111d, $105).
- Where the client is silent — send one message that states what was last delivered and asks a single closed question. Do not re-open the brief.
- Where it is genuinely dead — set the status so it stops appearing here, and note why in the CSR column.
- Anything still open at this time next week gets escalated, not re-listed.
- Script: `playbooks/stale_orders.md`
- Source rows: `jordyspikker: 159d, $100, revision`, `calumsnell: 157d, $100, revision`, `elite9921: 111d, $105, in_progress`, `institutoibt: 84d, $115, revision`, `moni_rotanak: 84d, $115, revision`

### P0 · Organic decline is a gig page and handling problem — act accordingly
**Owner:** CEO · **Est. impact:** $22,997 · **Effort:** 2.0h · **Confidence:** 75%

*Why:* Orders moved -96.7% over 14 days (243 -> 8). 75% of that swing is closing rate, which fell: impressions 197,662 -> 87,381, CTR 1.47% -> 1.60%, close rate 8.4% -> 0.6%. That makes this a gig page and handling problem — work on gig copy, packages, response speed, CSR quality.

- Treat this as a page-and-handling problem — reach and clicks are holding, buyers are arriving and not ordering.
- Check first-response time on inbound inquiries over this window. Slow first replies show up here before anywhere else.
- Re-read the gig packages against the last 10 lost inquiries: are buyers asking for something the packages do not describe?
- Script: `playbooks/upsell.md`

### P0 · Fill revenue in the daily ledger (197 days blank)
**Owner:** Whoever owns the daily ledger · **Est. impact:** $2,000 · **Effort:** 2.0h · **Confidence:** 90%

*Why:* 197 ledger days record orders but $0 revenue. Every revenue forecast, the AOV target and the whole revenue side of the objective are currently inferred from the CRM sheet instead of measured, because this column is empty.

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

### P2 · Follow up the 3 quotes that never got one ($295)
**Owner:** Ezan · **Est. impact:** $61 · **Effort:** 1.5h · **Confidence:** 45%

*Why:* 3 buyers were quoted $295 between them and no follow-up was ever logged against any of them — the largest is akhilkpfxx at $160, quoted 168 days ago. That sits inside a total unanswered pipeline of $6,300 across 20 leads. Of the 29 quoted leads anyone did chase, 12 placed (41%); this is costed at half that, because these are older. Note the raw split is misleading: quoted leads with no follow-up appear to convert at 97%, but that is because a follow-up only gets logged when the buyer did not say yes immediately. These 3 are the residue of that group, not part of its success.

- Work the never-followed-up list first, largest first: akhilkpfxx ($160, 168d), zain_qw ($75, 50d), Mohamed L ($60, 101d).
- One message each. State the quote is still open, and ask one question they can answer in a word — whether the project is still live. Do not re-pitch and do not discount unprompted.
- Log the touch in the FollowUp column the same day, or the next run will tell you to send it again.
- Then work the remainder by value; treat a third unanswered follow-up as a no and stop.
- Script: `playbooks/dead_pipeline.md`
- Source rows: `akhilkpfxx: $160, 168d, 0 follow-ups`, `zain_qw: $75, 50d, 0 follow-ups`, `Mohamed L: $60, 101d, 0 follow-ups`, `bobzinos: $900, 155d, 1 follow-ups`, `farida_ism: $700, 188d, 1 follow-ups`, `tatiana_1017: $510, 15d, 1 follow-ups`, `ryan_wonders: $350, 114d, 1 follow-ups`, `rztwerk: $250, 24d, 1 follow-ups`, `chupetes: $200, 163d, 1 follow-ups`, `dgtl_depot: $175, 196d, 1 follow-ups`

### P2 · Route high-value briefs to Md Rezaul
**Owner:** CEO · **Est. impact:** $800 · **Effort:** 0.5h · **Confidence:** 35%

*Why:* Md Rezaul averages $143 across 9 orders; Nimeazad averages $76 across 21. Some of that is brief mix rather than skill — but routing the $200+ briefs to the designers who already deliver at that level protects both AOV and rating.

- Assign every brief above $200 to Md Rezaul or the next two by AOV.
- Check whether the low-AOV designers are getting low-value briefs or producing low-value outcomes before acting on this.
- Revisit in 30 days with the engine's updated per-designer AOV.
- Script: `playbooks/staffing.md`

### P2 · Start recording upsells — the column is empty
**Owner:** All CSRs · **Est. impact:** $1,200 · **Effort:** 1.5h · **Confidence:** 50%

*Why:* Upsell is marked on 0.0% of the 174 orders whose tab has an Upsell column. That is not a low upsell rate, it is an unused column. The highest-value lever in the funnel currently cannot be measured, which means it cannot be improved or defended.

- Fill the Upsell column on every order: TRUE/FALSE, no blanks.
- Fill 'What did you upsell and how much' whenever TRUE.
- Backfill the last 30 completed orders from memory this week.
- Script: `playbooks/upsell.md`


---

## Who does what

### Ezan · team lead · all hours
*2 task(s), ~5.0h*

- **P0** Close out 5 orders open more than 60 days ($535)
- **P0** Organic decline is a gig page and handling problem — act accordingly

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
*2 task(s), ~3.5h*

- **P0** Fill revenue in the daily ledger (197 days blank)
- **P2** Start recording upsells — the column is empty

Standing duties, every shift:
- Answer every new first-message within 30 minutes. Response rate counts only the first message in a thread, on a 24-hour window, rolling 90 days.
- Report spam as spam within 24 hours — it then does not count against response rate. Most agencies bleed this metric on messages they could have flagged in three seconds.
- Post the 12-question intake within 15 minutes of any order starting.
- Send the 50%-elapsed checkpoint on every live order. This is the habit that converts an invisible 3-star private rating into a fixed order.
- Log every quoted price into the inquiry sheet the moment it is sent.
- Never move a pre-order conversation off Fiverr, and never argue.

### Hasnain · csr · 17:00-01:00 PKT
*2 task(s), ~1.5h*

- **P1** Wire up the 1 promised data source
- **P2** Route high-value briefs to Md Rezaul

Standing duties, every shift:
- Answer every new first-message within 30 minutes. Response rate counts only the first message in a thread, on a 24-hour window, rolling 90 days.
- Report spam as spam within 24 hours — it then does not count against response rate. Most agencies bleed this metric on messages they could have flagged in three seconds.
- Post the 12-question intake within 15 minutes of any order starting.
- Send the 50%-elapsed checkpoint on every live order. This is the habit that converts an invisible 3-star private rating into a fixed order.
- Log every quoted price into the inquiry sheet the moment it is sent.
- Never move a pre-order conversation off Fiverr, and never argue.

### Amrah · csr · 09:00-17:00 PKT
*1 task(s), ~1.5h*

- **P2** Follow up the 3 quotes that never got one ($295)

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
| 2026-08-27 | Organic orders over the 7 days to 27 Aug will be 16.9 (80% CI 11.7-22.2). | 11.66 – 22.19 | medium |
| 2026-09-03 | Organic health index in 14 days will be 62 (80% CI 29-77). | 28.77 – 76.74 | medium |
| 2026-08-27 | Total orders/day averaged over the next 7 days will be 5.22 (80% CI 4.11-6.32). | 4.11 – 6.32 | medium |
| 2026-09-19 | Blended AOV in 30 days will be $98 (80% CI $83-$123). | 82.58 – 122.53 | high |
| 2026-08-27 | Inquiry->order conversion in 7 days will be 21.3% (80% CI 17.0%-24.4%). | 0.17 – 0.24 | high |

**Track record:** 106 resolved, coverage 44% 
(target 80%), median absolute error 29%.


---

## Where the business actually is

| Metric | Value | Note |
|---|---|---|
| Organic orders/day (7d MA) | 1.71 | vs 1.43 14d ago |
| Organic, recent vs earlier | 1.45/day | was 0.66/day (+120.6%) |
| Organic orders, 7d to 19 Aug | 12 | 1.71/day |
| AOV | $98 | median $80, n=137 priced orders |
| Lifetime tracked revenue | $13,407 | across 174 order rows |
| Inquiry conversion | 21.3% | 23/108 |
| Upsell recorded | 0.0% | column is effectively unused |
| Review capture | 46.6% | 81/174 orders that could be rated |
| Gig rating | 4.841 | 1,637 reviews, Level 2 |
| Orders in queue | 22 | live from the gig page |

### Revenue path

At 1.71 orders/day and $98 AOV, the next 30 days project **$5,033** (51 orders).

**No 30-day revenue target is set**, so nothing here can say whether the month is on track. Set `targets.monthly_revenue.t30` in `config/profile.yml`. This line used to read "On track against the 30-day target", which a target of zero clears every single day.

### Funnel leverage

| Segment | n | Conversion | Lower bound |
|---|---|---|---|
| Shift: Night | 32 | 31.2% | 18.0% |
| Shift: Evening | 37 | 21.6% | 11.4% |
| Shift: Morning | 36 | 13.9% | 6.1% |
| United Kingdom | 34 | 35.3% | 21.5% |
| United States | 27 | 22.2% | 10.6% |

Ranked on the Wilson lower bound, not raw rate, so small samples cannot outrank large ones.


---

## Data feeds

| Feed | State | As of | Age | Where it comes from |
|---|---|---|---|---|
| Snapshot credentials | 🟢 live | — | 0h | XSTUDIOZ_SNAPSHOT_URL / _TOKEN in the environment |
| Order and inquiry workbooks | 🟢 live | 2026-08-20T08:42:51.696000+00:00 | 0h | Apps Script snapshot endpoint |
| Impressions source | 🟢 live | 2026-08-18 | 0h | impressions board, via IMPRESSIONS_SUPABASE_KEY |
| Impressions (engine copy) | 🟢 live | 2026-08-18 | 45h | board, merged over the Daily Data Sheet |
| Fiverr gig page | 🟢 live | 2026-08-16 | 93h | browser capture into data/raw/gig/ |
| CSR handoff tracker | 🟢 live | 2026-08-08 | 288h | uploaded into data/raw/order_tracker/ |



---

## System integrity

**Self-check score: 90/100** · 0 blocking failure(s)

- task_count: 10
- ownership: 20
- evidence: 25
- actionability: 15
- falsifiability: 20
- priority_spread: 0

**Checks not passing**
- `warn` **retired_sources_refused** — 1 table(s) from retired sheets were refused and not counted: impressions (1 tables, 162 rows). That data is typed into the hub now. Stop serving the sheet or the same fact lives in two places.
- `warn` **priority_spread_sane** — 3 of 7 tasks are P0

**Data sources still missing**
- Disputed / dead / conflicted orders sheet — Needed for dispute-risk scoring and refund-exposure forecasting. Run createMissingSourceSheets() in automation/Snapshot.gs to create it with the right headers.


---

*Generated 2026-08-20 by the XStudioz growth engine. Read-only: no source sheet was modified.*