# Badminton — Engine & Scoring Architecture

Module: `badminton` (preset over `setbased` kernel) · Spec anchor:
`04-sport-scoring-specs.md` §4 · Implementation: PROMPT-06 · Verify against current BWF
Statutes before build ([11-sources.md](../11-sources.md) "still to fetch").

## 1. What makes badminton different
Rally scoring to 21 with **win-by-2 but a hard cap at 30** (29-29 → golden point, 30-29
wins) — the cap is the differentiator vs volleyball's uncapped endgame. Five disciplines
(MS, WS, MD, WD, XD) that are *not* separate sports — they're entrant-kind + eligibility
combinations. Team events (Thomas/Uber/Sudirman style) aggregate discipline fixtures.

## 2. Match model (kernel parameters)
```
Cfg: { bestOf: 3, gameTo: 21, finalSetTo: 21, winBy: 2, cap: 30,
       pointsMap: {'2-0': [2,0], '2-1': [2,0]} }        // typical league: flat win points
Variants: `bwf` (above) · `classic-15` (legacy/service scoring NOT modelled — rally only)
          · `short {gameTo: 11, cap: 15}` (junior/social)
```
Game-win predicate: `(score ≥ 21 && margin ≥ 2) || score == cap`. Interval markers
(11-point mid-game break) = display metadata.

## 3. Events
Fine: `rally {wonBy}` (server tracking derivable: winner of rally serves next — rally
scoring; store `firstServer` in `core.start` payload for serve display). Coarse:
`game.summary {home, away}` — reachability validation incl. cap corner (30-29 valid,
31-30 invalid, 22-20 valid, 22-19 invalid).

## 4. Disciplines & divisions (the architecture point)
```
Division "Men's Singles U17"  = eligibility {gender: m, age: U17} + entrant kind individual
Division "Mixed Doubles Open" = eligibility {mixed pair} + entrant kind pair
```
Pair gender composition (XD = one m + one f) is an eligibility rule evaluated on
`entrant_members` (extend doc 06 rule kinds with
`{kind: 'pair_composition', composition: ['m','f']}`). One sport module serves all five
disciplines; a "tournament" in badminton parlance = a Competition with 5+ divisions —
exactly the doc 02 model.

## 5. Standings & tiebreakers (BWF-style round robin)
Ledger: `matches_won, games_won, games_lost, points_won, points_lost`.
Cascade: `matches_won → h2h(2 tied) → game_ratio → point_ratio → lots` (BWF regulations
order — verify exact wording; 3+ tied uses ratios among tied group then recomputes —
set `h2hRecursive: true`).
Knockout is the dominant format (seeded draw, byes to top seeds — 05 §2.3 fold seeding
matches BWF draw practice).

## 6. Team ties (later, designed now)
Sudirman-style tie = parent fixture with 5 child fixtures (MS, WS, MD, WD, XD), tie won
at 3 — same `parent_fixture_id` mechanism as TT/chess teams. Nomination rules (player in
≤2 events) = eligibility-style validation at lineup submit.

## 7. Positions/roster
No positions (catalog empty). Doubles service order display-only. Profile attrs:
`{hand, ranking_points?}` — seed source.

## 8. Edge cases checklist
- Golden point 30-29: predicate must decide *at* cap regardless of margin.
- Retirement mid-game: completed games stand; current game awarded at
  `max(gameTo, leaderScore+? )` — BWF records score as-is with W/O marker → outcome
  `award` keeps partial summary.
- Walkover before start → `award`, no game scores.
- Injury shuttle-time/med rules: out of scope (officiating, not scoring).
