# Table Tennis — Engine & Scoring Architecture

Module: `tabletennis` (preset over `setbased` kernel) · Spec anchor:
`04-sport-scoring-specs.md` §5 · Implementation: PROMPT-06 · Verify against current ITTF
Handbook ([11-sources.md](../11-sources.md) "still to fetch").

## 1. What makes table tennis different
Shortest scoring unit of the set-based family: games to **11, win by 2, no cap** (deuce
runs 12-10, 15-13…), matches best of 5 or 7. Two structural features stand out:
**service alternation every 2 points** (every point at deuce) and the **team-tie format**
(a "match" between clubs = 4–5 individual matches) — the cleanest showcase for
`parent_fixture_id` aggregation.

## 2. Match model (kernel parameters)
```
Cfg: { bestOf: 5 | 7, gameTo: 11, finalSetTo: 11, winBy: 2, cap: null,
       pointsMap: {'any-win': [2,0]} }        // league convention 2/0; cfg
Variants: `bo5` (groups), `bo7` (KO/finals), `hardbat-21 {gameTo: 21}` (legacy/social)
```
Game predicate: `score ≥ 11 && margin ≥ 2`. Expedite rule (game running long) is an
officiating device — no engine effect.

## 3. Events
Fine: `rally {wonBy}` — serve derivable: `firstServer` from `core.start`, alternate every
2 points (every 1 from 10-10); deciding game **ends switch at 5** (display marker).
Coarse: `game.summary {home, away}` with reachability validation (12-10 ok, 11-10 rejected).
Dual-fidelity `coarsen` hook mandatory.

## 4. Team ties (the architecture point)
Club league tie (Swaythling/modern ITTF team format):
```
parent fixture (Team A vs Team B, tie won at 3 individual wins)
  └── child fixtures per the tie system: A-X, B-Y, doubles, A-Y, B-X
```
- Lineup at parent level nominates players → child fixtures materialise with resolved
  entrant pairings (competition layer, not module).
- Parent outcome folds from child outcomes (first to 3); remaining children `cancelled`.
- Standings count parent results; child results feed player stats.
Reserved in schema (`fixtures.parent_fixture_id`); implement after singles/doubles ship.

## 5. Standings & tiebreakers
Ledger: `matches_won, games_won, games_lost, points_won, points_lost`.
Cascade (ITTF group play): `matches_won → h2h among tied (matches, then game_ratio, then
point_ratio computed on tied-group results only, recursive)` — set `h2hRecursive: true`;
fall back to full-group ratios, then `lots`. This is the classic partition-refinement
test case (05 §4.2).

## 6. Disciplines, positions, roster
Singles/doubles/mixed = entrant kinds (same as badminton, incl. pair-composition rule
for XD). No positions. Doubles serve-order (partners alternate hits) is play enforcement,
not scoring. Profile attrs: `{grip?, style?, rating?}` — rating as seed source.

## 7. Edge cases checklist
- Deciding game 5-point ends switch + serve-every-point from 10-10 (display markers only).
- Retirement mid-game: as badminton — completed games stand, outcome `award` with partial summary.
- Wheelchair/para service rules: out of scoring scope.
- 21-point legacy variant coexists via cfg — kernel unchanged (proves parameterisation).
