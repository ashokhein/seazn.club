# Board game (chess) — domain audit

**Module** `boardgame@1.0.0` (`boardgame.ts`). One sport key covering chess,
draughts, go and any 1-v-1 win/draw/loss board game. Entrant kind
`individual`; official label **Arbiter**.

**Declared variants:** `classical`, `rapid`, `blitz`. They are *clock families*
— each sets only `Cfg.variant` and nothing else, so the scoring, the ledger and
the tie-break cascade are identical across all three (see
[Variant differences](#variant-differences) for what actually differs in the
laws and why the module does not need to branch on it).

**Audited against:** FIDE *Laws of Chess* (2023 edition) — Art. 5 (the game is
over), Art. 6 (the clock), Art. 7 (irregularities), Art. 8 (recording the
moves), Art. 9 (drawn game), Appendix A (rapid) and Appendix B (blitz); the
FIDE *Competition Rules* for pairing cards and board order; a standard FIDE
scoresheet (players, ratings, colours, board number, movetext, result, both
signatures) and the arbiter's pairing card. Swiss tie-break definitions from
the FIDE Tie-Break Regulations.

Schema-path prefixes: `Ev.` = an event payload branch, `Cfg.` = config,
`State.` = folded state, `summary.` = the `ScoreSummary` a UI renders.

## Mapping table

| fact | variants | who/what participates | schema path | status | note |
| --- | --- | --- | --- | --- | --- |
| Result 1–0 / ½–½ / 0–1 | all | entrant | `Ev.BoardgameResult.winner` → `State.outcome` | modelled | `null` = draw |
| Points 1 / ½ / 0 as exact integers | all | entrant | `Cfg.scoring.{win,draw,loss}` (half-points ×2) | modelled | keeps Buchholz/SB integer arithmetic exact |
| Ended by checkmate / resignation / flag fall / agreement / stalemate / insufficient material | all | entrant | `Ev.BoardgameResult.method` | modelled | pre-existing vocabulary |
| Ended by default (no-show) or double default | all | entrant | `core.forfeit`, `method: "double_forfeit"` | modelled | double default folds to `no_result`, 0–0 |
| Ended by adjudication | all | entrant | `method: "adjudication"` | modelled | |
| Draw by threefold / fivefold repetition (Art. 9.2, 9.6.1) | all | entrant | `Ev.BoardgameResult.method = "repetition"` | extended | new enum member; folds to `State.method` and `summary.detail.method` |
| Draw by the 50-move claim / 75-move rule (Art. 9.3, 9.6.2) | all | entrant | `method = "fifty_move"` | extended | new enum member, same fold |
| Draw by dead position (Art. 5.2.2) | all | entrant | `method = "dead_position"` | extended | deliberately distinct from `insufficient`, which is the flag-fall material rule (Art. 6.9) |
| Loss for a repeated illegal move (Art. 7.5.5; immediate in blitz, App. B.3.2) | all | entrant | `method = "illegal_move"` | extended | folds to `outcome.method` like every other decisive method |
| Which player had White | all | entrant | `Ev.BoardgamePairing.white` → `State.colorOfHome` | extended | **the gap that mattered**: home was hard-coded White, but Swiss pairing alternates colours, so round 2 routinely has the home entrant with Black. Feeds the `white`/`black` standings metrics the pairing engine reads |
| Colours disabled (go, draughts, generic 1-v-1) | all | — (config) | `Cfg.colors` | modelled | a pairing card naming White under `colors: false` is refused (`INVALID_EVENT`) |
| A forfeited game is excluded from colour history | all | entrant | `State.forfeited` → `metrics.white`/`black` | modelled | |
| Who actually sat at the board (team-match board order) | all | person: `homePerson`, `awayPerson` | `Ev.BoardgamePairing.{homePerson,awayPerson}` → `State.players` → `summary.detail.players` | extended | the entrant is the club in a team event; the player is what a stat model needs |
| Board number within a team match | all | entrant | `Ev.BoardgamePairing.board` → `State.board` | extended | |
| Move number the game finished on (Art. 8.1) | all | entrant | `Ev.BoardgameResult.moves` → `State.moves` → `summary.detail.moves` | extended | the game *length*, which is what a scoresheet's last written move number gives you |
| The moves themselves (algebraic movetext / PGN) | all | person | — | deferred | **wrong fidelity for our scoring tiers.** A per-ply ledger turns the engine into a chess implementation (legality, FEN, per-ply clocks) and no declared tier asks for it. PGN stays a document attached via `core.note` until there is a product decision on blob storage in the ledger |
| The player who won the board | all | person: `winnerPerson` | `Ev.BoardgameResult.winnerPerson` → `State.winnerPerson` | extended | refused on a drawn game — a draw credits *both* players |
| Per-person ½ point for a drawn board | all | person | — | deferred | needs a pairing↔result join that `aggregatePlayerStats` (one event type → one person field) cannot express; see *Downstream owed* |
| Time control: base + increment | all | — (config) | `Cfg.clock.{base,increment}` | modelled | metadata, no scoring effect. `increment` is optional (W4a), so sudden death is expressible without a zero that reads as a deliberate Fischer setting |
| Time delay (Bronstein / simple delay), independently of increment | all | — (config) | `Cfg.clock.delay` | extended | W4a §5.5. **Increment and delay are different clocks:** increment ADDS to the clock after the move and unused time is BANKED; delay WITHHOLDS the clock for `delay` before it starts running and banks nothing. Independent knobs — a control may carry both, either or neither. Still metadata, still no fold effect; what it buys is a pad that counts down correctly for a delay control instead of treating it as Fischer |
| Multi-period control (e.g. 90′/40 moves + 30′ + 30″, FIDE classical) | classical | — | — | deferred | a control that *changes* mid-game needs move-count triggers and a second base; the single `{base, increment, delay}` triple covers rapid, blitz and every club classical control this product has seen |
| Time trouble / clock reading per move | all | person | — | deferred | not a scoresheet fact — it belongs to the ticking clock, which is the pad's half of the W4a split, not the engine's |
| When during the game a recorded fact happened (`at`) | all | — | — | deferred | **no `at` stamp this wave, deliberately.** W4a's ruling is that `at` records only what the fold cannot derive, and this module has nothing to derive it against: no phases, and a single terminal event. Where the game stood is the **move index**, which `Ev.BoardgameResult.moves` already carries |
| Clock family (classical / rapid / blitz) | all | — (config) | `Cfg.variant` | modelled | the only thing the three variants set |
| Adjournment and the sealed move | classical | person | — | deferred | obsolete in FIDE play since the 1990s; would need sealed-move + resumption state for a case we have never been asked for |
| Arbiter intervention, warning, conduct penalty | all | person | `core.note` | deferred | free text is the right fidelity; a closed penalty vocabulary needs a product decision (and i18n) |
| Bye value (full-point / half-point) | all | entrant | `Cfg.byeScore` | modelled | competition-level; read by the Swiss engine, not folded here |
| Swiss tie-breaks (Buchholz, Buchholz cut-1, Sonneborn-Berger, direct, wins) | all | entrant | `defaultTiebreakers`, `metrics.wins` | modelled | |
| Player rating; rated vs unrated event | all | person | — | deferred | a person/entrant record fact, not a match-ledger fact |
| Abandonment (venue lost, round replayed) | all | entrant | `core.abandon` → `State.replayFlagged` | modelled | leaves the game undecided and flags it |

**Row counts:** 12 modelled, 10 extended, 8 deferred (30 rows).
Asserted against the table itself by `src/testkit/dossiers.test.ts`.

## Why the pairing card is not `by` + `person`

Every other module names the side with `by` and the player with `person`. The
arbiter's pairing card uses `homePerson` / `awayPerson` instead, and W4's
cross-family review left it that way on purpose.

The card is one record of a **meeting**, not of an act by one side. `white` and
`board` are properties of the PAIRING: who had White is a single fact about two
players, and the board number is the pair's slot in the team match. Two
`by`+`person` events would have to either drop those two facts or carry a copy
of each on both halves — and two copies of "who had White" can disagree, which
the atomic card cannot express. The home/away distinction survives either way;
what does not survive is the pairing's own facts.

W5 should render this as one pairing control with two name fields, not as the
per-side control the other sports get.

## Variant differences

Beyond the clock family, the FIDE laws differ between the three variants in
ways the *arbiter* applies but the *ledger* does not need to branch on:

- **Recording obligation.** Art. 8.1 requires both players to record every
  move in classical; App. A.2 and B.2 waive it for rapid and blitz. Since the
  module deliberately does not record moves at all (see the deferred row), this
  difference costs us nothing.
- **Illegal moves.** In classical the *second* illegal move by the same player
  loses (Art. 7.5.5); in blitz the *first* claimed illegal move loses
  immediately (App. B.3.2). Either way the recorded fact is the same:
  `method: "illegal_move"`. The variant in `Cfg.variant` is enough for a pad to
  word the prompt correctly.
- **Claim procedure.** Repetition and 50-move claims need a scoresheet in
  classical and an arbiter observation in rapid/blitz. Same recorded method.

So: the variants differ in *procedure*, not in *what a scorer records*. No
per-variant schema branch is owed.

## Downstream owed

Recorded, not acted on:

1. **New `method` enum members** — `repetition`, `fifty_move`, `dead_position`,
   `illegal_move`. `apps/web/src/lib/scoring-vocab.ts` humanises unknown values,
   so nothing breaks, but the four deserve proper labels (and the four locale
   dictionaries) when a later wave touches that file.
2. **New event type `boardgame.pairing`** — a tier-1 event. A scoring pad must
   be able to prompt for *who has White*, *who is sitting*, and *board number*
   before the clocks start, and to re-record it (an arbiter correcting a
   mis-set board is legal until the game ends).
3. **Colour is now data, not a derivation.** Any surface that assumed
   "home = White" must read `State.colorOfHome` / `summary.detail.colorOfHome`.
   The Swiss pairing engine already consumes the `white`/`black` metrics, which
   now reflect the real colour rather than a fixed assumption.
4. **`boardgame.playerStats` now exists** (`games`, `wins`). Leaderboards that
   said *requires detailed scoring* for this sport can render as soon as
   pairing cards are being recorded.
5. **Per-player chess points (1 / ½ / 0) are a W6 stats-model item.** They need
   a join from the pairing card (who sat) to the result (who won), which the
   current flat `{from: eventType, field: personField}` metric shape cannot do.
   Either the stats model grows a join, or the pad writes `winnerPerson` on
   every decisive board and draws stay entrant-level.
6. **PGN storage** remains an open product decision (see the deferred row) —
   worth revisiting only if chess organisers ask for game download.
7. **`Cfg.clock.delay`, and `increment` now optional** (W4a §5.5). Any surface
   that renders a time control must read all three of `base` / `increment` /
   `delay`. An absent `increment` does mean no Fischer increment — what a
   surface must not assume is that the control is Fischer-family at all, since
   it may be delay-only: check `delay` before assuming the clock banks time.
   A pad that counts down has to bank increment and *not* bank delay.
8. **No e2e coverage this wave, by decision.** W4a ships no `apps/web` surface,
   so there is nothing to drive; e2e for the time model is deferred to **W10
   (#421)**, where the pad first meets the API. Recorded so the absence is a
   decision rather than an oversight. No smoke coverage is owed either — this
   change is cfg metadata with no fold effect, so `scripts/smoke.ts` has
   nothing to assert.
