# Badminton — domain audit (W4, #407)

**Module** `badminton@1.0.0`, built on the shared set-based kernel
(`setbased/kernel.ts`; the kernel's "sets" are badminton's **games**).
**Variants:** `bwf` (default — best of 3 games to 21, win by 2, hard cap 30) and
`short` (junior/social — games to 11, cap 15).

**Audited against:** the BWF *Laws of Badminton* (Law 7 "scoring system",
Law 9 "service", Law 10–11 "singles/doubles play and service court", Law 16
"continuous play, misconduct and penalties") and the BWF umpire's **scoresheet**
— the running-score columns with the server's initials, the interval marks, the
misconduct box and the signature block.

Read alongside `DOMAIN.volleyball.md` and `DOMAIN.tabletennis.md`: all three are
presets of one kernel. Badminton's distinguishing facts are the hard cap at 30
and the **absence** of timeouts and substitutions — which this wave makes
explicit rather than implicit.

## Mapping table

| fact | variants | who/what participates | schema path | status | note |
| --- | --- | --- | --- | --- | --- |
| A rally is won, scoring a point | all | entrant | `Ev.Rally.wonBy` | modelled | rally-point scoring since 2006; every rally scores. |
| Running score inside a game | all | entrant | `State.sets[].home` / `.away` | modelled | |
| Completed game score | all | entrant | `Ev.GameSummary.home/away` → `State.sets[]` | modelled | coarse tier: a whole game entered as one score. |
| Game to 21, win by 2 | bwf | — | `Cfg.setTo = 21`, `Cfg.winBy = 2` | modelled | |
| Setting: at 20–20 play continues to a two-point lead | bwf | — | `Cfg.winBy` with `Cfg.cap = 30` | modelled | 22–20, 25–23 accepted; 21–20 rejected. |
| Golden point: 29–29 is decided by the next rally, 30–29 | bwf | — | `Cfg.cap = 30` | modelled | the cap is the badminton-shaped kernel parameter; 31–30 is unreachable. |
| Short format: games to 11, cap 15 | short | — | `Cfg.setTo`, `Cfg.finalSetTo`, `Cfg.cap` (variant `short`) | modelled | 15–14 is that variant's golden point. |
| Best of 3 games; the third game is the decider | all | entrant | `Cfg.bestOf = 3`, `State.setsWon` | modelled | `finalSetTo` equals `setTo` — badminton's decider has no different target. |
| Match points for the league table | all | entrant | `Cfg.pointsMap` (`"*": [2, 0]`) | modelled | configurable per competition. |
| Disciplines MS / WS / MD / WD / XD | all | entrant kind | `entrantModel.kinds` (`individual`, `pair`) | modelled | disciplines are entrant kind + eligibility, deliberately **not** module variants. |
| Serving player | all | person `server` | `Ev.Rally.server` → `State.persons[id].serves` | extended | optional `PersonId` on the rally. The umpire's sheet tracks the server through the rotation; recording it makes the rotation reconstructable. |
| Player credited with the point (the winning stroke) | all | person `scorer` | `Ev.Rally.scorer` → `State.persons[id].points` | extended | optional; a rally naming nobody folds exactly as before. |
| Misconduct: yellow warning, red fault, black disqualification | all | entrant + optional person | `Ev.Sanction.level`, `.person` → `State.sanctions[]` | extended | new `badminton.sanction` event. Card ladder → kernel enum: yellow = `warning`, red = `penalty`, black = `disqualification`; `expulsion` covers a referee's removal from the game. |
| The point a red card concedes | all | entrant | recorded as a `badminton.rally` for the opponent | modelled | the point goes in the score column, the card in the misconduct box — as on paper. |
| Service court, right or left | all | person | — | deferred | fully derivable: the server serves from the right when their own score is even. Recording it would duplicate the ledger and could contradict it. |
| Which player receives | all | person | — | deferred | determined by the score in singles and by the standing rotation in doubles; derivable from the service history once `server` is recorded. |
| Service faults and lets | all | — | — | deferred | the umpire calls them; the scoresheet records only the resulting point, never the cause. |
| Interval at 11 points; break between games | all | — | — | deferred | procedural and derivable from the running score. No fold consequence. |
| Change of ends after each game, and at 11 in the third | all | — | — | deferred | derivable from the game index and the running score. |
| Timeouts | all | — | `records.timeouts` is unset | modelled | BWF play has **no** timeouts (only the interval and the between-game break). The kernel refuses `badminton.timeout` with `INVALID_EVENT`, so a pad can never offer one. |
| Substitutions | all | — | `records.substitutions` is unset | modelled | badminton has no substitutions; the kernel refuses `badminton.sub`. |
| Retirement or injury | all | entrant | `core.forfeit` → `outcome.kind = "award"` | modelled | the opponent takes the match with the clean-sweep points pair. |
| Match abandoned (hall closure, power) | all | — | `core.abandon` → `State.replayFlagged` | modelled | leaves the fixture undecided for re-scheduling. |
| Umpire / service judge on the sheet | all | official | `officialLabel.scorer = "Umpire"` | modelled | |
| Remarks, injury notes | all | — | `core.note` | modelled | free text, no fold effect. |
| A printed badminton scoresheet | all | — | — | deferred | only volleyball ships an `exportTemplates.scoresheet`; a badminton sheet is a print task for a later wave, not a schema gap. |
| Rally length / stroke counts | all | persons | — | deferred | not on any scoresheet; a Pro statistics layer, wrong fidelity for our tiers. |

Counts: 17 `modelled`, 3 `extended`, 7 `deferred` — 27 rows.

## Downstream owed

- **New event type** `badminton.sanction`, reachable at fidelity tiers 2 and 3
  under the existing `scoring.rally_by_rally` entitlement. Badminton
  deliberately gains **no** timeout or substitution event — the kernel rejects
  both, so a generic pad built from `fidelityTiers` will not offer them.
- **New enum** `SetBasedSanctionLevel`. The BWF card colours do not appear in
  the engine; the yellow/red/black → warning/penalty/disqualification mapping
  above is the one a pad and the web vocab must render.
- **New payload fields** `badminton.rally.server` / `.scorer`. In doubles a pad
  must offer both members of the pair.
- **`playerStats` now exists** (`points`, `serves`, `sanctions` labelled
  "Cards"), so badminton leaderboards stop reporting
  `requires_detailed_scoring`.
- Service court and receiver are recorded as **derivable**, not stored. If a
  later wave wants them on screen it should compute them from `server` plus the
  running score rather than adding fields that can disagree with the ledger.
