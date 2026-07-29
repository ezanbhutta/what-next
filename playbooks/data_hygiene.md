# Playbook — Data hygiene

The engine's advice is only as good as what it can read. These are the gaps currently
degrading it, in order of cost.

## 1. Daily ledger revenue is empty (111 days)

Every ledger day records order counts but `$0` revenue. This is the **highest-value fix
available**: it blocks revenue forecasting entirely, so the engine currently infers
revenue from the CRM sheet's AOV instead of measuring it.

Fill Organic Revenue and VVRO Revenue for every day with orders, back to 2026-06-11.

## 2. The Upsell column is unused (0.0% of 492 orders)

Not a low upsell rate — an unused column. The highest-value lever in the funnel cannot be
measured, improved or defended. Fill TRUE/FALSE on every order, no blanks, plus the
"what and how much" field whenever TRUE.

## 3. The ClickUp sync is broken (334 logged failures)

`CLICKUP_TOKEN script property is missing.` Every ClickUp task the sheet should have
created since then does not exist, so work is tracked in two places that disagree. Set
the property, re-run the backlog, **and add a failure alert** — 334 silent failures is the
real defect here, not the missing token.

## 4. 65 leads marked Placed with no value

Pipeline value and per-CSR revenue attribution are both understated by an unknown amount,
which makes CSR comparisons unreliable.

## 5. Three promised sources do not exist yet

- **Disputes / dead / conflicted orders sheet** — needed for dispute-risk scoring.
- **Impression system** — needed to tell *falling reach* from *falling conversion*. These
  need opposite responses, and without impressions the engine is guessing which one an
  organic decline represents. This is the most analytically valuable of the three.
- **Daily team activity report** — needed to attribute outcome changes to team actions
  rather than to Fiverr's algorithm.

## Conventions that keep the engine working

- **One header row per tab, spelled consistently.** The engine tolerates drift (it handles
  ten header layouts today) but every new spelling is a chance to silently lose a column.
  The daily brief reports the unmapped-column rate; if it climbs, a sheet changed shape.
- **Never overwrite a header cell with data.** Two tabs have a project name where `Date`
  should be.
- **Dates in one format.** `DD-MMM-YYYY` preferred. Nine formats are currently in use.
- **"no review" is data. Blank is not.** Same for every status column.
