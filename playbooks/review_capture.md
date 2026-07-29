# Playbook — Reviews, private feedback, and what you may actually say

> **This playbook was rewritten on 2026-07-29.** The earlier version told the team
> to add a review request to every delivery. Two of your own documents disagree
> about whether that is allowed, and the engine now follows the stricter reading.
> See "The conflict" below.

## The conflict, stated plainly

| Source | Says |
|---|---|
| Team briefing, Rule 7 | "Never ask for a review or a rating. Pressuring a buyer for feedback is an Integrity and Authenticity violation." |
| Operating model, step 12 | "Deliver at 60% of promised time. Then request the review and explain that both a public and a private review will be requested." |

Fiverr's published prohibition is on **pressuring or incentivising** — not on a
single neutral mention. But the downside is wildly asymmetric: a soft request wins
a handful of reviews; an Integrity violation costs the account, and the account
carries 1,583 reviews you cannot rebuild.

**Engine position:** one neutral line at delivery, never repeated, never naming a
rating, never tied to anything of value. Then stop. Resolve this properly and
record the outcome in `docs/DECISIONS.md`.

## Permitted

> "Everything is delivered and the source files are in the folder. If anything is
> missing or you need a format that is not there, tell me and I will sort it today."

That is it. No mention of stars. No follow-up chase. If they leave a review, good.

**Why this wording works anyway:** it routes dissatisfaction to you *privately*
before it becomes a public 3-star or an invisible private rating. That is the
actual mechanism, and it does not require asking for anything.

## Forbidden, without exception

- Asking for 5 stars, or any specific rating.
- Asking a second time.
- Offering anything — a discount, an extra file, faster delivery — in exchange.
- Asking a buyer to change or remove a review already left.
- Any message whose purpose is the review rather than the work.

## The real problem: private feedback

Public reviews are not where the damage is. From the briefing and the operating
model:

- 24 hours after the public review, buyers get an **anonymous questionnaire**:
  overall quality, how closely it met expectations, whether it was useful.
- It stays open for **60 days** after completion.
- **First-time buyers' private ratings are weighted more heavily** than repeat
  customers'. Higher-value and higher-volume orders carry more weight.
- **You will never see any of it.**

This is why a wall of 5-star public reviews sits alongside Success Score 8.
57 of your 1,583 reviews are 3★ or below — but the invisible channel is the one
holding the score down, and asking for reviews does nothing about it.

## What actually moves it — the mid-order checkpoint

At **50% of elapsed time**, send the direction so far and ask plainly whether
anything needs changing.

> "Here is where the mark has got to at the halfway point. Before I take it to
> final files — is this the direction you wanted, or is there something you would
> change?"

This is the single highest-value habit in the whole operating model. It converts a
silent 3-star private rating into a fixed order, *while the order is still open*.
Once it is delivered and they have gone quiet, you have lost the chance and you
will never know it happened.

## The silent-buyer proxy

You cannot see private feedback, so build a proxy. Log every order where:

1. the buyer went silent and never replied,
2. the buyer asked for more than the agreed revisions,
3. the buyer accepted delivery without a word.

Those are the orders most likely leaking private feedback. Chase the silent buyer
**within 24 hours of delivery** — orders auto-complete after 3 days and the private
window stays open for 60 more.

Review the pattern monthly. The engine tracks it once the disputes sheet exists.

## What does NOT hurt you

Fiverr states these explicitly, and the team should stop being afraid of them:

- **Unresponsive clients.** The system accounts for it.
- **Revisions, delivery extensions, partial refunds.** Judged only by their effect
  on client satisfaction. They are tools to fix an experience, not failures.
- **Inactivity.** The score does not drop because orders slowed.

Being afraid of extensions and partial refunds is what pushes CSRs into arguments,
and arguments are what actually damage the conflict-free and communication metrics.
