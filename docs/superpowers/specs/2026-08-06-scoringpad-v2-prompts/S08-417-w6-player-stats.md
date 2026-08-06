# S8 — #417 (W6): player-stat models for every sport, prefer-person-fields

Paste this whole file as the session opener. Read `_RULES.md`, then `_INDEX.md`
(S3's keeper identity, S6's contract), then this. Engine-only session.

Branch `feat/s8-w6-player-stats` in a fresh worktree. One PR. Issue #417.
Design: `../2026-08-03-scoringpad-v2-design.md` (Part I, WS2 + prefer-person-fields).

## Why

Closes the engine half of #407 WS2. `playerStats` exists only for football,
hockey and icehockey; cricket, tennis, setbased, carrom, boardgame (chess) and
generic show `requires_detailed_scoring` instead of stats.

`PlayerStatMetric` (`packages/engine/src/stats/stats.ts`, re-pin) reads flat
payload fields holding PersonIds — fine for the three period sports, useless for
families that attribute to EntrantIds (setbased `rally.wonBy`, nested `point.by`,
boardgame `result.winner`, carrom, generic).

W4 added optional explicit PersonId fields. **The owner's decision: prefer
explicit person fields when a payload carries them, fall back to
entrant→person resolution otherwise** — so v1-era events keep producing stats and
v2-pad events sharpen them. That is why the order is W4 → W5 → W6 on the same
module files.

**New since #417 was written:** S3 put positions and keeper identity into
`State`. Goalkeeper statistics — clean sheets, saves, goals conceded — are
derivable **for the first time**. They are in scope here, and S9's career rollup
depends on them existing.

## Scope

1. **Stats core (`stats/stats.ts`)**: dot-path support in `field`/`sumField`;
   `value?: (payload) => number|undefined`; `fromEntrant?: boolean`; a new
   `PlayerStatsFoldCtx {entrants, personsOf(entrantId), cfg}`; `PlayerStatsModel`
   gains `folded?: {keys, fold(events, ctx) → PlayerStatRow[]}` merged with metric
   rows. Resolution order per event: **explicit PersonId field →
   `personsOf(entrantId)` for `individual`/`pair` entrants → unattributed.**
   Keep the existing three sports' semantics untouched.
2. **Kernel-level models** (many sports at once, no drift): default `playerStats`
   built inside `setbased/kernel.ts` and `nested/kernel.ts` factories — the
   period kernel is the precedent. `matches`, `sets_won/lost`, `points_won`
   (+ `games_won` nested, `aces` tennis). Team-sized entrants → `personsOf`
   returns `[]` → the existing `requires_detailed_scoring` messaging stands.
3. **Per-sport models**: cricket — `runs`, `balls_faced`, `fours/sixes`,
   `wickets`, `runs_conceded`, `catches`, `dismissals`, reading W4's enriched
   ball payloads (fielder credit → catches; dismissal detail → dismissal splits)
   with coarse `player_line` mirror keys for v1-era events; boardgame/chess —
   folded `games/wins/draws/losses` + white/black splits, forfeit handling;
   carrom — `boards_won`, `queens`, folded matches/wins; generic — folded W/D/L +
   `points_for`.
4. **Goalkeeper metrics** (new, enabled by S3): clean sheets, goals conceded, and
   saves **where the sport records a save event**; football and both hockey
   codes. Read the keeper from `State`, not from a lineup snapshot taken at
   kickoff — a keeper change mid-match must split the metrics correctly.
5. **Conformance — playerStats block across all 11 modules**: any module with
   `playerStats` must aggregate generated streams without throwing; rows
   deterministic; keys unique; void events **un-count**; mixed streams (v1-era
   entrant-only + v2 person-attributed) produce consistent totals.

Engine-only, read-side projection: **no module version bumps, no migrations** —
snapshots self-backfill via recompute-on-read (`usecases/player-stats.ts` deletes
and refolds per division).

## Acceptance criteria

- [ ] All 11 modules declare `playerStats`; the conformance playerStats block is
      green ×11
- [ ] Explicit-person event **beats** `personsOf` fallback when both resolve —
      test with deliberately **conflicting** attribution
- [ ] v1-era streams (no person fields) still produce rows for individual/pair
      entrants via `personsOf`
- [ ] Cricket: a fielder-credited catch and dismissal-mode splits appear from the
      enriched payloads; the v1-era `player_line` mirror still counts
- [ ] Boardgame forfeit + colour splits correct; void events un-count everywhere
- [ ] **Goalkeeper**: clean sheet and goals-conceded attribute to the keeper who
      was on the field at the time — regression test with a **keeper change
      mid-match**, split across two people
- [ ] Deterministic: the same stream folds to identical rows twice (property test)
- [ ] Key collisions between `folded` rows and metric rows are tested for, not
      just uniqueness within one path
- [ ] Engine purity gate green; `tsc EXIT=0`; engine + root lint `✖ 0 problems`;
      goldens byte-identical or deliberate re-baseline per S1
- [ ] Vitest counts from the JSON reporter; **no `apps/web` diff**

### Test types

- **Unit** — resolution order, dot-paths, per-sport metrics.
- **Regression** — conflicting attribution; keeper change mid-match; void
  un-counting; mixed v1/v2 stream totals.
- **Conformance + golden replay** for the engine half.
- **E2E (Playwright) + smoke: deferred to S9 and S12/S13** — S9 puts these stats
  on `/me` and is the first place a browser can see them. Say so in the PR body.

## Gotchas

- The fold ctx is **data + callbacks only** — the engine purity gate breaks on
  anything else.
- Team-entrant sports legitimately return `[]` from `personsOf`. That is the
  designed no-stats state; do **not** "fix" it by attributing to the whole roster.
- `folded` rows and metric rows merge **on key** — collisions between the two
  paths are the drift to test for.
- A budget/threshold-style test is vacuous if the bound is set so low that both
  the real and the mutant implementation hit it and agree. If you write any
  bounded assertion here, check a mutant actually survives differently.
- Recompute-on-read deletes and refolds per division — a metric whose fold is not
  idempotent will drift on every page view.
- Modules stay `1.0.0`.

## Execution

Core (scope 1) lands **inline first** — every model depends on its types. Then
kernels and per-sport models via the W4 family split **only** if dispatched with
provably disjoint dirs; otherwise one sequential implementer → reviewer loop.

**Scout (sonnet) brief:** `stats/stats.ts` — `PlayerStatMetric`,
`PlayerStatsModel`, every consumer; the three kernel factories
(`setbased`/`nested`/`period`) and how the period kernel builds its default
`playerStats`; `usecases/player-stats.ts` recompute path; where S3 put positions
and keeper identity into `State`. file:line table only, under 30 lines.

**Implementer briefs** carry: the pinned scout table, the resolution-order rule
verbatim, the family's dir list, "do NOT touch other families' kernels", the
verify command, output cap.

**Reviewer (sonnet):** does any metric read a kickoff lineup snapshot instead of
`State` (the keeper bug)? Is the resolution order actually preferred, or does
`personsOf` win by accident when both exist? Does any fold throw on a
cfg-derived condition? Gap list only.

## On close

`_INDEX.md`: S8 → DONE, goalkeeper metrics as shipped (S9 input), any metric key
naming that S9's UI must match. Memory + `scripts/agent-memory-snapshot.sh`.
