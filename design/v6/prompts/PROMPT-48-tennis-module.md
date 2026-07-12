# PROMPT-48 — Tennis: nested kernel, module, TennisPad, catalog wiring

**Read first:** `v6/00-sport-expansion-spec.md` §2/§4/§5 (normative), `v6/01-rules-digest.md`
§1 (every constant); `packages/engine/src/sports/setbased/kernel.ts` (style/patterns to mirror —
do NOT extend it), `packages/engine/src/sport/module.ts` (contract),
`packages/engine/src/sports/index.ts` (builtinModules), `scripts/sync-sports.ts` (+ its
SPORT_NAMES map), `components/v2/pads/setbased-pad.tsx` + `fixture-console.tsx` +
`device-score-pad.tsx` (dispatch points), `competition/tiebreakers.ts` (`set_ratio`
pattern for the new `game_ratio`). Preamble: PROMPT-00. **Depends:** none. May run
parallel to PROMPT-49 (disjoint engine areas).

## Task

1. **Nested kernel** (`packages/engine/src/sports/nested/kernel.ts`, v6/00 §2): `NestedCfg`,
   tagged `GamePoints` state, fold for `point` events — deuce/advantage, no-ad deciding
   point, tie-break entry at `tiebreakAt`-all (to `tiebreakTo`, win by 2), advantage
   sets (`tiebreakAt:null`), final-set `matchTiebreakTo` replacing the deciding set,
   serve tracking (game alternation; TB 1-then-2-2; TB first-server receives next set).
   Monotonic decision at `ceil(bestOf/2)` sets. Tier-0 `set_summary` events accepted as
   in setbased summary mode.
2. **`tennis` module** (`packages/engine/src/sports/tennis/tennis.ts`): configSchema
   (zod, defaults = `tour`), eventSchema `tennis.point{by, meta?}` +
   `tennis.set_summary`, variants `tour / grand-slam / fast4 / doubles-noad-mtb10`
   (constants from digest §1), `supportsDraws → false`, metrics
   `sets_won/sets_lost/games_won/games_lost/points_won`, defaultTiebreakers
   `[points, set_ratio, game_ratio, h2h_points, seed]`, fidelityTiers (0 summary /
   3 point-by-point), `officialLabel.scorer:"Chair Umpire"`, positions catalog minimal
   (singles/doubles slots), headline grammar per v6/00 §2 (`6–4 7–6(5) · 40–Ad`, serve
   in `detail.serving`).
3. **`game_ratio` comparator** in `competition/tiebreakers.ts` — cross-multiplied BigInt
   like `set_ratio`; register + `validateCascade` coverage.
4. **Register + catalog**: add to `builtinModules`; SPORT_NAMES `tennis:"Tennis"`;
   document + run `scripts/sync-sports.ts` (dev DB) — note in PR that staging/prod need
   the same run (stale sport_variants gotcha).
5. **TennisPad** (`components/v2/pads/tennis-pad.tsx`): rally mode — big point buttons
   per side, spoken-score display (Love/15/30/40/Ad; TB numerals), serve dot, set strip,
   undo-own-events; summary mode — per-set games + optional TB points. Register in a new
   `NESTED` set in **both** `fixture-console.tsx` and `device-score-pad.tsx` dispatches
   (do not touch `SETBASED`).
6. **Builder wiring**: `SPORT_RULES` tennis block (bestOf, set type incl. fast4 preset
   fields, final-set method), `PREFERRED_VARIANT tennis:"tour"`; `match-length.ts` /
   `venue.ts` rows already exist — assert via test.
7. **Docs/demo**: seed-demo pro org tennis division (tour) with one TB set + one MTB
   match (v6/00 §5); help doc stub per help-content conventions.

## Acceptance

- Unit (engine): golden fold sequences — standard game incl. deuce loop; no-ad deciding
  point (receiver-choice recorded as meta); TB at 6–6 with serve-rotation assertion and
  next-set receiver flip; advantage set past 6–6; fast4 (TB at 3–3 to 5); MTB10 deciding
  set at 1–1; ALREADY_DECIDED after match point; void of match point reopens fold and
  `nextStatus` returns to `in_play` (regression for the v3/09 class of bug).
- Unit (standings): `game_ratio` ordering + cascade validation rejects it for sports
  lacking game metrics.
- E2E: create tennis division via builder (variant visible from synced catalog), score a
  bo3 with TB on the device pad at 390px, headline shows `7–6(5)` form, undo restores
  live point; console summary-mode entry produces identical standings.
- smoke.ts: pro path scores one tennis set rally-mode; free path unaffected.
- `npm test` + `tsc` green; update v6/README status.
