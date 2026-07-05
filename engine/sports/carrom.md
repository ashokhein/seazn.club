# Carrom — Engine & Scoring Architecture

Module: `carrom` (own module — points-race grammar, unlike boardgame or set-based) ·
Implementation: PROMPT-16. Rules below are **verified against the ICF "Laws of Carrom"**
(law numbers cited; source: the ICF laws PDF mirrored at iakc.org, retrieved 2026-07-05).
ICF ships as the system preset (`icf` variant); everything stays configurable.

## 1. Match structure (ICF, verified)
- **Board** (one rack of 19 coins: 9 white, 9 black, 1 red queen — Law 41a) → **Game**
  ("A game shall be of 25 points or eight boards. The player who reaches 25 points first
  or leads at the conclusion of the eighth board shall be the winner" — Law 56a) →
  **Match** ("All matches shall be decided only by the best of three games" — Law 57;
  `bestOf` cfg for finals etc.).
- Tied after the eighth board: "an extra board shall be played to decide the winner"
  (Law 56b, with a fresh toss for break) — cfg `tieBoard: 'extra'` (default). House rule
  `'draw'` closes the game drawn instead (enables drawn matches in leagues).
- Singles or doubles → entrant kind `individual | pair` (doubles partners sit opposite,
  Law 39b–d).

```
Cfg { gameTo: 25, maxBoards: 8, bestOf: 3,        // Laws 56a, 57
      queenPoints: 3, queenCapAt: 22,             // Laws 52(b)(i), 54
      pointsPerCoin: 1,                           // Law 52(b)(ii)
      queenFollowsBoard: false,                   // Law 53(b)/(c) — see §2
      tieBoard: 'extra',                          // Law 56b ('draw' = house rule)
      points: {win: 2, loss: 0, draw: 1} }        // competition points per match
```
Variants: `icf` (defaults above) and `club-29` — documented club/family rules
(mastersofgames.com "Rules of Carrom"): game to 29, queen worth 5, no queen benefit
once 24 is reached → `{gameTo: 29, queenPoints: 5, queenCapAt: 24}`.

## 2. Event model — board-level fidelity is the right default
Strike-by-strike scoring is umpire-grade and impractical courtside; the natural unit is
the **board result**:
```
Ev  carrom.toss  { firstBreak }                   // Laws 39/42; breaker takes white (Law 43)
    carrom.board.summary { winner: entrantId,
                    opponentCoinsLeft: 0..9,      // winner's points = coinsLeft × pointsPerCoin (Law 53a)
                    queenTo: entrantId|null }     // who pocketed+covered the queen
    carrom.game.adjust { entrantId, delta≠0, reason } // umpire penalty/foul adjustments
    (fine fidelity later: carrom.strike {striker, pocketed[], foul?, due?} —
     typed placeholder shipped, apply() rejects it; Pro key `scoring.strike_by_strike`)
```
**Deviation (PROMPT-16):** the prompt asked for a `core.start {firstBreak}` payload, but
core event payloads are kernel-owned strict-empty objects (spec 03 §2), so the toss is a
pre-start sport event — the `cricket.toss` precedent.

Fold:
```
queenCredited = (queenTo == winner) || (queenFollowsBoard && queenTo != null)
boardPoints(winner) = opponentCoinsLeft × pointsPerCoin
                    + (queenCredited && preBoardScore(winner) < queenCapAt ? queenPoints : 0)
gameScore accumulates per board; game decided at ≥ gameTo, or after maxBoards → higher score
  (equal after maxBoards → tie-board per cfg: extra board (ICF) | game drawn)
match decided at ⌈bestOf/2⌉ game wins; with drawn games (house rule) the match falls to
  a games-won comparison after bestOf games, equal → drawn match
```
**Queen rules, verified:**
- "Queen: 3 points up to and including 21 points" (Law 52(b)(i)); "The player loses the
  advantage of getting the credit of an additional 3 points for covering the Queen, once
  he has reached the score of 22 points" (Law 54). The bonus is therefore checked against
  the **pre-board score** — a board's own coin points never lift the winner past the cap
  for that board's queen. Boundary: at 21 the queen still counts; at 22 it scores 0.
- "The player is entitled to be credited with the value of the Queen, only if he wins the
  board" (Law 53b); "The player who loses the board is not credited with the value of the
  Queen, even if he has pocketed and covered the Queen" (Law 53c). So a loser-covered
  queen scores for **nobody** under ICF — the earlier draft's guess that she transfers to
  the board winner was wrong. `queenFollowsBoard: true` implements that transfer as an
  explicit house-rule switch (default **false** = ICF).
- Maximum per board: 12 points (9 coins + queen — Law 55).

Validation: `opponentCoinsLeft ∈ 0..9` (integer); `winner`/`queenTo` must be fixture
entrants; `game.adjust` may not take a score below zero.

## 3. State machine
```
pre (toss?) → board[1] → board[2] … (game check after each board) → game[k+1] … → decided
```
State: `{ games: [{boards: [...], score: {a,b}, winner}], gamesWon, firstBreak }` —
**break alternation, verified (Law 49a):** the toss winner breaks board 1; "the turn to
break shall pass alternately during the game"; in game 2 the other player breaks first;
in game 3 it returns to the first player. Doubles: the turn passes to the right (Law
49b) — a per-player rotation inside the pair, not modelled at board fidelity. Law 56b's
fresh toss before an extra board is **not modelled** (no mid-match toss event); the
alternation simply continues. Each board records its breaker for display and for fine
fidelity later.

## 4. Standings & tiebreakers
Metrics ledger (integers): games won/lost ride the shared `sets_won`/`sets_lost`
comparator keys (labelled "Games won/lost" — the badminton precedent), board points ride
`points_won`/`points_lost`, and `boards_won`/`boards_lost` feed the carrom-specific
`board_ratio` key (added to the comparator registry with PROMPT-16).
Default cascade: `points → wins → set_ratio (games) → board_ratio → point_ratio → h2h_points → lots`
(ratios cross-multiplied — 05 §4.3). No official federation cascade is universal —
document ours as house-standard, overridable.

## 5. Positions/roles
None (catalog empty; doubles = pair entrant, order irrelevant). PlayerProfile attrs:
`{ style?: 'straight'|'cut', hand?: 'L'|'R' }` — display only.

## 6. Fidelity & entitlements
Community (tier 0): `carrom.board.summary` scoring. Tier 1 adds `carrom.toss` and
`carrom.game.adjust`. Pro: strike-by-strike (reserved key `scoring.strike_by_strike`,
typed placeholder `CarromStrike` shipped, tiers 2/3 declared when it lands), foul/due
tracking, per-player queen-cover stats, board-time clock. Public dashboard: game/board
scoreboard boxes (reuse set-based UI pattern — boards render like sets).

## 7. Edge cases
- Game reaching maxBoards tied → cfg: sudden-death board(s) (ICF Law 56b) vs drawn game.
- `queenCapAt` boundary: player at 21 wins board with queen +3 +1 coin → 25, game won;
  player at 22 gets coins only (goldens cover both).
- Walkover/forfeit: `award` outcome to the opponent (win/loss match points); the ledger
  keeps only the games/boards actually played.
- Abandonment: `no_result` outcome with completed games recorded in the ledger; both
  sides take the draw share of match points (PROMPT-16 §4).
- Doubles substitution: not allowed mid-match (ICF) — lineup locked at `core.start`.
