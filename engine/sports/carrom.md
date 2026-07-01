# Carrom — Engine & Scoring Architecture

Module: `carrom` (own module — points-race grammar, unlike boardgame or set-based) ·
Implementation: PROMPT-16. **Verify every rule below against the current ICF "Laws of
Carrom" before implementing** — community variants differ widely; ship ICF as the system
preset, keep everything configurable.

## 1. Match structure (ICF baseline)
- **Board** (one rack of 19 coins: 9 white, 9 black, 1 red queen) → **Game** (first to
  25 points, or highest score after 8 boards) → **Match** (best of `bestOf` games; ICF
  commonly 3, finals sometimes 5... cfg).
- Singles or doubles → entrant kind `individual | pair` (doubles partners sit opposite).

```
Cfg { gameTo: 25, maxBoards: 8, bestOf: 3,
      queenPoints: 3, queenCapAt: 22,      // at ≥22 pts queen scores 0 (ICF "no queen benefit at 22+")
      pointsPerCoin: 1,
      points: {win: 2, loss: 0, draw?: 1} }  // competition points per match
```

## 2. Event model — board-level fidelity is the right default
Strike-by-strike scoring is umpire-grade and impractical courtside; the natural unit is
the **board result**:
```
Ev  board.summary { winner: entrantId,
                    opponentCoinsLeft: 0..9,   // winner's board points = coinsLeft × pointsPerCoin
                    queenTo: entrantId|null }  // who pocketed+covered the queen
    game.adjust  { entrantId, delta, reason }  // umpire penalty/foul adjustments
    (fine fidelity later: strike {pocketed[], foul?, due?} — Pro `scoring.strike_by_strike`, reserved)
```
Fold:
```
boardPoints(winner) = opponentCoinsLeft + (queenTo == winner && score(winner) < queenCapAt ? queenPoints : 0)
gameScore accumulates per board; game decided at ≥ gameTo, or after maxBoards → higher score
  (equal after maxBoards → tie-board per cfg: extra board | game drawn)
match decided at ⌈bestOf/2⌉ games
```
Validation: `opponentCoinsLeft ≤ 9`; `queenTo` must be winner or null (queen pocketed by
loser but board lost ⇒ queen credited to board winner per ICF — **verify**; make it an
explicit cfg switch `queenFollowsBoard: true`).

## 3. State machine
```
pre → board[1] → board[2] … (game check after each board) → game[k+1] … → decided
```
State: `{ games: [{boards: [...], score: {a,b}}], currentGame, breaker }` — **break
alternates each board**, first break to the toss/白 winner (`core.start` payload
`{firstBreak}`); track it for display and fine-fidelity later.

## 4. Standings & tiebreakers
Metrics ledger (integers): `matches_won, games_won, games_lost, boards_won, boards_lost,
points_for, points_against`.
Default cascade: `points → matches_won → game_ratio → board_ratio → points_ratio → h2h → lots`
(ratios cross-multiplied — 05 §4.3). No official federation cascade is universal —
document ours as house-standard, overridable.

## 5. Positions/roles
None (catalog empty; doubles = pair entrant, order irrelevant). PlayerProfile attrs:
`{ style?: 'straight'|'cut', hand?: 'L'|'R' }` — display only.

## 6. Fidelity & entitlements
Community: `board.summary` scoring. Pro: strike-by-strike (reserved key
`scoring.strike_by_strike`), foul/due tracking, per-player queen-cover stats, board-time
clock. Public dashboard: game/board scoreboard boxes (reuse set-based UI pattern —
boards render like sets).

## 7. Edge cases
- Game reaching maxBoards tied → cfg: sudden-death board (ICF) vs drawn game.
- `queenCapAt` boundary: player at 21 wins board with queen +3 +2 coins → 26, capped
  display at "wins game"; player at 22 gets coins only.
- Walkover/forfeit mid-match: remaining games awarded (`award` outcome, method walkover).
- Doubles substitution: not allowed mid-match (ICF) — lineup locked at `core.start`.
