---
title: Knockout deciders
description: A knockout always produces a winner — enable extra time or a shoot-out on the knockout stage itself.
order: 8
---

A knockout match can't end level: there'd be nobody to advance, and the next round would sit waiting forever. The engine now **refuses to finalize a drawn result** in any stage that can't take draws — you'll see "this stage cannot end level — decide it by extra time or a shootout" instead of a silently stuck bracket.

To make a winner reachable, put the decider on the **knockout stage's config**: `{ "shootout": true }` and/or extra time. Group stages in the same division keep drawing normally — the setting is per stage, not per division. This works the same in every sport whose rules forbid drawn knockouts.

If a match genuinely can't be finished (abandonment, walkover), use the abandon/forfeit flows — those record an outcome the bracket can advance from.
