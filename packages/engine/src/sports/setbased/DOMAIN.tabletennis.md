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
W4 recorded as a real, stated gap and **W4a (#425) §5.3 closed**, with one
limitation stated in the table rather than buried in the code.

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
| Warning and penalty cards (yellow, red) | all | entrant + optional person | `Ev.Sanction.level`, `.person`, `.reason` → `State.sanctions[]`, `discipline.extractCards` | extended | new `tabletennis.sanction` event. Yellow warning = `warning`, red penalty = `penalty`; `expulsion` / `disqualification` cover removal by the referee. W4's review added optional free-text `reason` — the umpire's own words for the offence, which an accumulation rule keyed on it needs. It reaches `DisciplineCard.reason` only; the fold never reads it, so no recorded state moves. |
| The point(s) a red card concedes | all | entrant | recorded as `tabletennis.rally` for the opponent | modelled | the point goes in the score column, the card in the card box — as on paper. |
| Serve rotation: every 2 points (every 5 at 21, every point at deuce) | all | person | — | deferred | fully derivable from the points played once `server` is recorded. A stored rotation cursor could disagree with the ledger. |
| Doubles serve and receive order | all | persons | — | deferred | the fixed ITTF rotation is derivable from the pair's declared order plus the service history; enforcing it is a lineup-layer validation, not an event field. |
| The expedite system is introduced (Law 2.15.1) | all | — | `Ev.ExpediteStart` (`tabletennis.expedite.start`, empty payload) → `State.expedite`, `summary.detail.expedite` | extended | W4a (#425) §5.3 closed W4's stated gap. The **ten-minute trigger stays the pad's** — the engine owns no clock (spec §1.2), so this event is the record that the umpire called it, matching the sheet's expedite mark. |
| Expedite runs to the end of the MATCH, not the game (Law 2.15.4) | all | — | `State.expedite` (never cleared by `bankSet`) | extended | why the payload is EMPTY: with no game number there is nothing a second introduction could re-scope, so a second `tabletennis.expedite.start` is an `INVALID_EVENT`. Scoping it per game is the error this row exists to prevent. |
| Receiver wins the point on their 13th good return (Law 2.15.2) | all | entrant | `Ev.Rally.returns` + `Ev.Rally.serving`; a violation is `EXPEDITE_WRONG_WINNER` (422) | extended | `returns` counts the **receiver's** good returns, not the rally's stroke count. **Enforcement is conditional and this is a stated limitation, not an oversight:** the kernel holds no serving state (`server` is a PERSON feeding a `serves` tally), so where a rally carries `returns` but no `serving` there is no receiver to compare `wonBy` against. Such a rally is **recorded, not rejected**, and counted in `State.expediteUnchecked` — rejecting it would make coarse-tier expedited scoring unrecordable. |
| Which SIDE served the rally | all | entrant | `Ev.Rally.serving` (an `EntrantId`) | extended | distinct from `Ev.Rally.server`, which is a `PersonId`. Adjacent, similarly named, differently typed, and in doubles they disagree — the `DisciplineCard.entrantSide` shape. Expedite enforcement reads `serving` and never `server`. `expedite.test.ts` pins the case that actually has teeth: a rally whose `server` is a string that is ALSO a legal `EntrantId` and names the OTHER side, in both the accept and the reject direction — so a kernel reading `server` resolves it successfully and reaches the wrong verdict. A person-shaped `server` cannot pin this; it kills only by dying in `sideOf`. |
| Service alternates every point under expedite | all | person | — | deferred | the alternation is derivable from the point sequence once expedite is in force, and the kernel stores no service cursor to enforce it against. Same reasoning as the two-point rotation row above. |
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

**Row counts:** 16 modelled, 8 extended, 8 deferred (32 rows).
Asserted against the table itself by `src/testkit/dossiers.test.ts`.

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
- **Expedite (W4a #425 §5.3 — was the one substantive unmet fact, now shipped).**
  A pad owes four things:
  1. the **ten-minute game clock** and the "unless both have reached 9" guard
     (Law 2.15.1) — both live in the pad, not the engine, which owns no clock;
  2. a `tabletennis.expedite.start` control that fires **once per match** and
     then disables itself (a second one is rejected);
  3. a **returns counter on the receiver**, reset each rally, labelled so the
     umpire cannot read it as a stroke count;
  4. `serving` on every rally once expedite is in force. Without it the engine
     cannot check the 13-return rule at all — it counts the rally in
     `State.expediteUnchecked` and lets it stand. A pad that draws a service
     indicator already knows this value; one that does not should say so rather
     than let a scorer believe the rule is being enforced. **The counter is
     readable:** it is deliberately absent from `summary.detail` (coarsening
     discards `returns`, so exposing it there would break §9.6), but the whole
     folded state is persisted as `match_states.state` and returned raw by
     `GET /api/v1/fixtures/:id/state` — the field the pad page already reads.
     No new engine export is owed for the warning in point 4.
- **New error code `EXPEDITE_WRONG_WINNER`** (422) — surfaced verbatim; the
  scorer's fix is to correct `wonBy` or `serving`, never to retry.
- **e2e for expedited scoring is DEFERRED**, not owed by this wave: there is no
  ScoringPad surface to drive yet (#416 / W5). The engine-side proof is
  `expedite.test.ts` plus the golden corpus; the first pad to expose the
  control owes the browser test.
