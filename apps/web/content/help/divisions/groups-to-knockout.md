---
title: Groups to knockout
description: Combined qualification (winners + runners-up + best thirds) and a custom bracket order, in one stage setup.
order: 4
---

A real cup rarely takes a single slice of the table. The knockout stage's qualification can now **combine tiers**: all group winners, then all runners-up, then the best N third-placed sides — one spec, in that order. Unequal pools are normalised the fair way (results against the bottom side are dropped before thirds are compared).

Set it on the knockout stage as `qualification: { combine: [...] }` — each entry is a normal pick (`take`, `topN` or `bestOfRank`), resolved against the finished stage and concatenated. The same shape serves a cricket Super-Six, a hockey crossover, any pool→bracket sport. Pool picks match the pool **key** ("A"); the display name ("Pool A") also works.

**Custom bracket order.** By default the bracket seeds by the standard fold (1 meets 2 only in the final). When your competition publishes a fixed slot map — regional protection, third-place lookups — give the stage config a `slotOrder`: the round-one slots as seed numbers into the qualified list, `null` for a bye line. The engine validates the map (every seed exactly once) and generates that draw exactly.
