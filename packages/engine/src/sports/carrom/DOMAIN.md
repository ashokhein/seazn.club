# Carrom — domain audit

**Module** `carrom@1.0.0` (`carrom.ts`). Entrant kinds `individual` and
`pair` (doubles); official label **Umpire**.

**Declared variants:**

| variant | gameTo | queenPoints | queenCapAt | everything else |
| --- | --- | --- | --- | --- |
| `icf` | 25 | 3 | 22 | the ICF defaults |
| `club-29` | 29 | 5 | 24 | documented club/family rules |

**Audited against:** the ICF *Laws of Carrom* — Laws 39/42/43 (toss, choice,
the breaker takes white), 49 (break alternation), 51 (fouls and due coins), 52
(point values: coins ×1, queen ×3), 53 (a board's points; the queen must be
pocketed **and** covered by the player who wins the board), 54 (no queen
benefit from 22 points), 55 (penalties), 56 (a game: first to 25 or the leader
after 8 boards; tie → extra board), 57 (a match: best of 3); and the ICF
scoresheet, which books each board's points to a **side** with a running game
score. `carrom.md` §1–7 carries the verified text.

Schema-path prefixes: `Ev.` = event payload branch, `Cfg.` = config,
`State.` = folded state, `summary.` = the `ScoreSummary` a UI renders.

## Mapping table

| fact | variants | who/what participates | schema path | status | note |
| --- | --- | --- | --- | --- | --- |
| Toss, and the choice of first break (Laws 39/42/43) | all | entrant | `Ev.CarromToss.firstBreak` → `State.firstBreak` | modelled | a sport event *before* `core.start`, because core payloads are kernel-owned and strict-empty |
| Break alternates each board, and each game's first break alternates (Law 49a) | all | entrant | `State.games[].boards[].breaker` (derived) | modelled | deterministic from `firstBreak` + game/board index |
| The striker who actually broke this board | all | person: `breaker` | `Ev.CarromBoardSummary.breaker` → `State.games[].boards[].breakerPerson` → `summary.detail.games[].boards[].breakerPerson` | extended | in doubles the break rotates through **four** players, so the side alone loses the actor |
| Winner of the board | all | entrant | `Ev.CarromBoardSummary.winner` | modelled | |
| Coins left to the opponent = the winner's coin points (Laws 52b(ii), 53a) | all | entrant | `Ev.CarromBoardSummary.opponentCoinsLeft` × `Cfg.pointsPerCoin` | modelled | 0–9 |
| Queen pocketed **and** covered → bonus points (Law 52b(i)) | all | entrant | `Ev.CarromBoardSummary.queenTo`, `Cfg.queenPoints` | modelled | 3 (icf) / 5 (club-29) |
| The player who pocketed and covered the queen | all | person: `queenBy` | `Ev.CarromBoardSummary.queenBy` → `boards[].queenPerson` | extended | refused when `queenTo` is `null` — nobody can be credited with a queen no side covered |
| Queen credited only to the coverer who also wins the board (Law 53b/c) | all | entrant | `State…queenScored`, `Cfg.queenFollowsBoard` | modelled | the house rule hands her to the board winner regardless |
| No queen benefit once the pre-board score reaches the cap (Law 54) | icf (22), club-29 (24) | entrant | `Cfg.queenCapAt` | modelled | checked against the **pre-board** score — this board's coins never lift you past your own cap |
| Board points banked into the running game score | all | entrant | `State.games[].score` | modelled | |
| Game target (first to 25 / 29) | icf (25), club-29 (29) | entrant | `Cfg.gameTo` | modelled | |
| Leader after `maxBoards` boards wins the game (Law 56a) | all | entrant | `Cfg.maxBoards` (8) | modelled | |
| Game tied after `maxBoards` → extra sudden-death board (Law 56b) or a drawn game | all | entrant | `Cfg.tieBoard` | modelled | `extra` = ICF, `draw` = house rule that makes drawn matches possible |
| A **fresh toss** for the extra board (Law 56b) | all | entrant | — | deferred | needs a product decision: a mid-match toss would have to override the deterministic break alternation, and no scoresheet we audited records it separately from the board itself |
| Best-of-N games decides the match (Law 57) | all | entrant | `Cfg.bestOf`, `State.gamesWon` | modelled | refined to odd values so a decider exists |
| Due points and penalty points (Laws 51, 55) | all | entrant | `Ev.CarromGameAdjust.delta` + `.reason` | modelled | signed delta on the open game's score; refused if it would go below zero |
| The player whose act caused the adjustment | all | person: `person` | `Ev.CarromGameAdjust.person` → `State.penalties[]` → `summary.detail.penalties` | extended | fouls are committed by a striker, not by a side |
| Which foul it was (due coin, striker pocketed, board disturbed…) | all | person | `Ev.CarromGameAdjust.reason` (free text) | deferred | a closed foul vocabulary needs a product decision plus four locale dictionaries; the umpire's reason string carries it today |
| Strike-by-strike play (each strike, coins pocketed, fouls per strike) | all | person: `striker` | `Ev.CarromStrike` (typed; `apply()` rejects it) | deferred | reserved Pro fidelity, entitlement `scoring.strike_by_strike` (carrom.md §6). The fine tier is its own prompt and would add tiers 2/3 |
| Doubles: which partner performed an individual act | all | person | the `breaker` / `queenBy` / `person` fields above | extended | the entrant is the pair; the acts the laws name a player for now name one |
| A board's **points** split between two partners in doubles | all | person | — | deferred | Law 53a books a board to the **side** that cleared its coins; an ICF scoresheet has no per-player point column, so any split would be invented |
| Walkover / no-show | all | entrant | `core.forfeit` → `outcome.award` | modelled | completed games stand in the ledger |
| Abandonment | all | entrant | `core.abandon` → `outcome.no_result` | modelled | completed games recorded, shared points |
| Match (standings) points | all | entrant | `Cfg.points.{win,draw,loss}` | modelled | |
| Ledger: games / boards / raw points for the ratio tie-breaks | all | entrant | `metrics.{sets_won,boards_won,points_won,…}` | modelled | games ride the `sets_*` keys, boards feed `board_ratio` |
| Time limit per board or per game | all | — | — | deferred | ICF club play is untimed; a shot/board clock needs a product decision and a live timer the engine does not own |
| Which side plays white coins / black coins | all | entrant | — | deferred | Law 43 gives white to the breaker, so it is derivable from `firstBreak` + the alternation already in state; storing it would duplicate state |

**Row counts:** 17 modelled, 4 extended, 6 deferred (27 rows).
Asserted against the table itself by `src/testkit/dossiers.test.ts`.

## Downstream owed

Recorded, not acted on:

1. **No new event types** — the three person fields ride the existing
   `carrom.board.summary` and `carrom.game.adjust`, so the fidelity ladder,
   the API event allowlists and the pad's event vocabulary are unchanged.
2. **A pad must be able to name a player per board.** At tier 1 the board
   summary should offer *who broke* and *who took the queen*, and the
   adjustment form should offer *which player*. In doubles that is a
   two-name picker per side; in singles it can default to the single player and
   stay invisible.
3. **`carrom.playerStats` now exists** (`breaks`, `queens`, `penalties`).
   Leaderboards that said *requires detailed scoring* can render once boards
   are being recorded with players. Note `queens` counts *pocketed and covered*,
   not *scored* — the cap (Law 54) can leave a covered queen worth nothing, and
   the stat model has no access to folded state to filter on it.
4. **`summary.detail.penalties`** is a new array in the summary payload. It is
   only present when an adjustment named a player, so nothing existing renders
   differently, but a UI that enumerates `detail` keys should expect it.
5. **Strike-by-strike (tier 2/3) is still owed** and is the natural home for a
   foul taxonomy, per-strike coin counts and a real doubles turn order. Whoever
   picks it up should reuse `CarromStrike`, which is already typed.
