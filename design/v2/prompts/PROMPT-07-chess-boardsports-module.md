# PROMPT-07 — Board-Game Module & Swiss Metrics

**Read first:** `engine/04-sport-scoring-specs.md` §6; `engine/05-formats-progression-tiebreakers.md`
§2.2, §4; FIDE sources in `engine/11-sources.md`. Preamble: PROMPT-00. Depends: PROMPT-03.

## Task
1. `sports/boardgame/` per spec 04 §6: Cfg (scoring 1/½/0 — represent as integer
   half-points internally, never 0.5 floats), variants classical/rapid/blitz, single
   `result` event, colour metadata (`colors: boolean` cfg; fixture home/away = W/B when
   enabled), byeScore.
2. Swiss metric ledger in `standingsDelta`: opponent list + per-game score + colour —
   enough for the competition engine to compute Buchholz/Cut-1/Sonneborn-Berger **at rank
   time** (these depend on opponents' *final* scores, so they cannot be folded
   incrementally — they are cascade-time computations; implement them in
   `competition/tiebreakers.ts` reading the ledger, not in the module).
   FIDE unplayed-game handling: virtual-opponent adjustment for byes/forfeits (cite the
   handbook section in a comment).
3. `defaultTiebreakers`: `score → buchholz_cut1 → buchholz → sberger → direct → wins → lots`.
4. Colour history string per entrant exposed for the pairing algorithm (05 §2.2 consumes it).
5. Goldens: a published small Swiss cross-table (e.g. 6-player, 5 rounds from a FIDE/
   chess-results.com event) → recompute Buchholz, Cut-1, SB and match the published
   tiebreak columns exactly.

## Acceptance
- Conformance green; goldens match published tiebreaks; half-point integer representation
  verified (no float anywhere in ledger).
