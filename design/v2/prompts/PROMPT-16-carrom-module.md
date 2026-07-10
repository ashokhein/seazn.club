# PROMPT-16 — Carrom Sport Module

**Read first:** `engine/sports/carrom.md` (normative); `engine/04-sport-scoring-specs.md`
§9 (invariants); fetch current ICF "Laws of Carrom" and verify: queen cover/points rules,
the 22-point queen cap, board/game/match structure, break alternation — update
`engine/sports/carrom.md` where it diverges. Preamble: PROMPT-00. Depends: PROMPT-03.

## Task
Implement `sports/carrom/` per `engine/sports/carrom.md`:

1. Cfg schema `{gameTo, maxBoards, bestOf, queenPoints, queenCapAt, pointsPerCoin,
   queenFollowsBoard, points}` + variants `icf` (system default) and `club-29`
   (common house rules — pick a documented one).
2. Events: `board.summary {winner, opponentCoinsLeft, queenTo}`, `game.adjust
   {entrantId, delta, reason}`; `core.start` payload `{firstBreak}`. Strike-by-strike
   reserved (do not implement; leave typed placeholder + entitlement key note).
3. Fold per carrom.md §2–3: board points with queen-cap logic at the boundary
   (score < queenCapAt *before* the board's coin points? define order: coin points apply
   first, then queen bonus checked against pre-board score — pick per ICF, document,
   test both boundary cases 21→ and 22→), game decision (gameTo / maxBoards / tie-board
   policy), match at ⌈bestOf/2⌉, break alternation tracking.
4. Outcomes incl. `award` walkover; `no_result` on abandonment with completed games recorded.
5. Standings ledger + cascade per carrom.md §4 (integer ratios, cross-multiplied).
6. `arbitraryEvent(state)` generator; conformance suite; goldens:
   (a) game won exactly at 25 via queen bonus; (b) queen at 22+ scores 0 — game continues;
   (c) 8-board game decided on points; (d) best-of-3 with a tie-board; (e) walkover.

## Acceptance
- `conformanceSuite(carrom)` green; goldens green; carrom.md updated with verified ICF
  citations (section numbers).
