# Table tennis — domain audit (W4, #407)

**Module** `tabletennis@1.0.0`, built on the shared set-based kernel
(`setbased/kernel.ts`; the kernel's "sets" are table tennis's **games**).
**Variants:** `bo5` (default — best of 5 games to 11, win by 2, no cap), `bo7`
(knockout / finals) and `hardbat-21` (legacy/social — games to 21).

**Audited against:** the ITTF *Handbook*, Laws of Table Tennis 2 ("a good
service", 2.11 "a point", 2.13 "a match", 2.15 "the expedite system") and
Regulations for International Competitions (timeout, warnings and penalty
cards), plus the ITTF **match sheet** — per-game score boxes, the running score,
the "T" timeout mark, the expedite mark, the card box and the signature block.

Read alongside `DOMAIN.volleyball.md` and `DOMAIN.badminton.md`: all three are
presets of one kernel. Table tennis's distinguishing facts are the uncapped
deuce endgame, the single timeout per player, and the expedite system — which
this audit records as a real, stated gap.

## Mapping table

| fact | variants | who/what participates | schema path | status | note |
| --- | --- | --- | --- | --- | --- |
| A rally is won, scoring a point | all | entrant | `Ev.Rally.wonBy` | modelled | every rally scores. |
| Running score inside a game | all | entrant | `State.sets[].home` / `.away` | modelled | |
| Completed game score | all | entrant | `Ev.GameSummary.home/away` → `State.sets[]` | modelled | coarse tier: a whole game entered as one score. |
| Game to 11, win by 2 | bo5, bo7 | — | `Cfg.setTo = 11`, `Cfg.winBy = 2` | modelled | |
| Uncapped deuce endgame (12–10, 15–13, …) | bo5, bo7 | — | `Cfg.cap = null` | modelled | 11–10 is rejected as non-terminal; 13–10 is rejected as unreachable (12–10 already decided it). |
| Hardbat games to 21 | hardbat-21 | — | `Cfg.setTo`, `Cfg.finalSetTo` (variant `hardbat-21`) | modelled | same kernel, different target. |
| Best of 5 / best of 7 | bo5 / bo7 | entrant | `Cfg.bestOf`, `State.setsWon` | modelled | `bo7` is the knockout/final format. |
| Match points for the league table | all | entrant | `Cfg.pointsMap` (`"*": [2, 0]`) | modelled | configurable per competition. |
| Singles / doubles / mixed | all | entrant kind | `entrantModel.kinds` (`individual`, `pair`) | modelled | entrant kind, deliberately not a module variant. |
| Serving player | all | person `server` | `Ev.Rally.server` → `State.persons[id].serves` | extended | optional `PersonId` on the rally; makes the two-point (five-point at 21) rotation reconstructable from the ledger. |
| Player credited with the point | all | person `scorer` | `Ev.Rally.scorer` → `State.persons[id].points` | extended | optional; a rally naming nobody folds exactly as before. |
| Timeout (one per player or pair, per match) | all | entrant | `Ev.Timeout.by` → `State.timeouts.{home,away}`, `summary.detail.timeouts` | extended | new `tabletennis.timeout` event; the sheet's "T" mark. Never touches the score. |
| Warning and penalty cards (yellow, red) | all | entrant + optional person | `Ev.Sanction.level`, `.person` → `State.sanctions[]` | extended | new `tabletennis.sanction` event. Yellow warning = `warning`, red penalty = `penalty`; `expulsion` / `disqualification` cover removal by the referee. |
| The point(s) a red card concedes | all | entrant | recorded as `tabletennis.rally` for the opponent | modelled | the point goes in the score column, the card in the card box — as on paper. |
| Serve rotation: every 2 points (every 5 at 21, every point at deuce) | all | person | — | deferred | fully derivable from the points played once `server` is recorded. A stored rotation cursor could disagree with the ledger. |
| Doubles serve and receive order | all | persons | — | deferred | the fixed ITTF rotation is derivable from the pair's declared order plus the service history; enforcing it is a lineup-layer validation, not an event field. |
| The expedite system | all | — | — | deferred | **a real gap.** Expedite turns on after 10 minutes (or by agreement) and then the receiver wins the rally if the server makes 13 good returns. The kernel has neither a clock nor a return counter, so it cannot decide such a rally; recording only the sheet's expedite mark would be a fact the fold cannot honour. Needs a product decision on whether we score expedited play at all. |
| Lets (net service, interruption) | all | — | — | deferred | the umpire calls a let and the rally is replayed; nothing is written on the match sheet. |
| Change of ends between games, and at 5 in the deciding game | all | — | — | deferred | procedural and derivable from the game index and the running score. |
| Substitutions | all | — | `records.substitutions` is unset | modelled | table tennis has no substitutions; the kernel refuses `tabletennis.sub`. |
| Timeout allowance (exactly one) | all | — | — | deferred | the umpire enforces it. Refusing a second `tabletennis.timeout` would make a legitimate correction unrecordable — a product decision. |
| Racket and equipment inspection | all | persons | — | deferred | a pre-match control document, not a scoring fact. |
| Team ties (Swaythling / modern club format: first to 3 of 5 individual matches) | all | entrants | competition layer, `Fixture.parent_fixture_id` | modelled | out of module scope by design — this module scores one singles/doubles fixture. |
| Retirement or injury | all | entrant | `core.forfeit` → `outcome.kind = "award"` | modelled | opponent takes the match with the clean-sweep points pair. |
| Match abandoned (venue, power) | all | — | `core.abandon` → `State.replayFlagged` | modelled | leaves the fixture undecided for re-scheduling. |
| Umpire on the sheet | all | official | `officialLabel.scorer = "Umpire"` | modelled | |
| Remarks, injury notes | all | — | `core.note` | modelled | free text, no fold effect. |
| Stroke / rally-length statistics | all | persons | — | deferred | not on the match sheet; Pro statistics, wrong fidelity for our tiers. |

Counts: 16 `modelled`, 4 `extended`, 8 `deferred` — 28 rows.

## Downstream owed

- **New event types** `tabletennis.timeout` and `tabletennis.sanction`,
  reachable at fidelity tiers 2 and 3 under the existing
  `scoring.rally_by_rally` entitlement. No `tabletennis.sub` — the kernel
  rejects it.
- **New enum** `SetBasedSanctionLevel`. Only `warning` and `penalty` correspond
  to the ITTF yellow and red cards; a pad should probably surface just those two
  for this sport.
- **New payload fields** `tabletennis.rally.server` / `.scorer`; a doubles pad
  must offer both members of the pair.
- **`playerStats` now exists** (`points`, `serves`, `sanctions` labelled
  "Cards"), so table tennis leaderboards stop reporting
  `requires_detailed_scoring`.
- **Expedite is the one substantive unmet fact in this sport.** It needs a
  product decision before any schema work: either the pad refuses to score
  expedited play, or the kernel gains a return counter and a per-rally
  "expedited" flag whose fold can hand the rally to the receiver.
