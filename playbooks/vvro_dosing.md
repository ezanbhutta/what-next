# Playbook — VVRO dosing

VVRO (self-placed / inorganic orders) is leverage against your organic ranking, not a
growth dial. This playbook exists because the data shows it is currently working against
you.

## What the data says

- VVRO began **2026-07-13**.
- Organic ran at **0.66 orders/day** before. It runs at **0.56/day** since — a **14.3%
  decline**.
- VVRO share of total orders reached **79%** in the last 7 days, against a policy cap of
  **45%**.

That correlation is not proof of causation — Fiverr's algorithm moves for many reasons,
and 16 days is a short window. But it is the wrong direction, and the engine's objective
makes organic recovery a **hard constraint**. So volume gets cut until flow recovers,
regardless of how far behind revenue is.

## The maths that sets the ceiling

The cap is on the *share*, so the absolute ceiling depends on organic volume:

```
v / (o + v) ≤ s      =>      v ≤ o · s / (1 − s)
```

At o = 0.71 organic/day and s = 0.45, the ceiling is **0.58 VVRO/day** — about 4 per
week, not the 2.7/day recently being placed.

**The trap:** when organic falls, the VVRO ceiling falls with it. The leverage shrinks
exactly when it feels most tempting to pull harder. Pulling harder is how the spiral
deepens.

## Rules

1. **Follow the weekly quota, not a daily habit.** When the ceiling is below 1/day,
   "place one every day" silently breaches the cap. The engine gives a weekly quota and
   names the days.
2. **Do not place on a fixed weekday pattern.** The engine rotates the days each week for
   a reason: regular cadence is what makes inorganic volume legible from outside.
3. **Spread the price bands.** All-cheap or all-expensive placements make the order-value
   distribution look synthetic. Follow the band allocation.
4. **Spread the countries.** Mirror your organic mix; do not concentrate.
5. **Log every placement with its real amount.** The ledger's revenue columns are
   currently all zero across 111 days, which blinds the controller entirely.

## When the cut is working

Watch the 7-day organic moving average. The engine predicts the organic health index
recovers ~12 points in 14 days if the dilution hypothesis is right. **If it does not
recover, the decline was not VVRO-driven** and the cut should be reverted — the engine
logs that prediction precisely so this stays falsifiable rather than a matter of opinion.
