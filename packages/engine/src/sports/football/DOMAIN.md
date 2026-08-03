# Football — domain audit (W4, #407 programme)

## What was audited, and against what

Association football, as the module `football@1.0.0` models it.

Sources the audit was run against:

- **IFAB Laws of the Game 2025/26** — Law 3 (players and substitutes), Law 5
  (the referee's match record), Law 7 (duration and allowance for time lost),
  Law 10 (determining the outcome, including kicks from the penalty mark),
  Law 12 (fouls and misconduct, and its **temporary dismissals** addendum),
  Law 14 (the penalty kick).
- **The FA's grassroots match record / referee report**, and the FA's
  **sin-bin (temporary dismissal) system**, which runs at every level below
  National League System step 4 and throughout youth football.
- **FA Mini-Soccer and Small-Sided rules** and the **FIFA Futsal Laws**, for
  the substitution and time-penalty divergences in the small-sided game.
- FIFA/UEFA competition regulations for extra time, kicks from the penalty
  mark, and the group-stage points split.

Declared variants (`football.variants`): **`11-a-side`**, **`youth`**,
**`small-sided`**. Where a row says `all`, the fact is recorded identically in
every one of the three; where it names variants, the model diverges and the
"note" column says how.

The module already had optional person fields before this wave, so it sets the
attribution pattern the other families copy. **§4 states exactly which person
roles are complete and which are not.**

## Mapping table

Grouped by area, in scorebook order. `Ev.X` = a branch of the event union,
`Cfg.x` = `configSchema`, `State.x` = the folded `FootballState`,
`summary.x` = `module.summary()`, `Lineup.x` = the core `LineupPair` the module
is initialised with.

| fact | variants | who/what participates | schema path | status | note |
| --- | --- | --- | --- | --- | --- |
| Goal in open play | all | entrant `by`; `scorer`; `assist` | `Ev.FootballGoal.by`, `.scorer`, `.assist` → `State.goals`, `State.periods[].home\|away` | modelled | Scorer must be on the pitch for `by`; all three person fields optional so coarse scoring stays legal. |
| Goal scored from a penalty kick | all | `scorer` | `Ev.FootballGoal.penalty` | modelled | Flag pre-dates W4. W4 gave it a home in the stat model (`playerStats.penalty_goals`), a strict subset of `goals`, so `points = goals + assists` is unchanged. |
| Own goal, and who it is credited to | all | the striking side's `scorer`; credit goes to the opponent | `Ev.FootballGoal.ownGoal` → `creditGoal(opponent(by))` | modelled | `by` is the side whose player struck it; the fold credits the other side. `playerStats.goals` excludes own goals via `when: p.ownGoal !== true`. |
| Own goal charged to the player who scored it | all | `scorer` | would be `playerStats.own_goals` | deferred | The metric is one line, but adding it reds `src/stats/stats.test.ts:52`, which asserts the exact stat row for an own goal. That file is outside this family's blast radius — see §5 blockers. |
| Assist | all | `assist` | `Ev.FootballGoal.assist` → `playerStats.assists` | modelled | One assist per goal (unlike ice hockey's two). |
| Minute of a goal / card / sub | all | n/a | `Ev.FootballGoal.minute`, `Ev.FootballCard.minute`, `Ev.FootballSub.minute` | modelled | Carried on the event and read back from the ledger; the fold keeps per-period counts, not a timeline. |
| A goal-by-goal timeline inside State | all | `scorer`, `assist` | would be `State.timeline[]` | deferred | The ledger already is the timeline and the match report reads it. State is serialised whole into the frozen golden corpus, so a new always-present array would break back-compat for zero new information. |
| Disallowed goal and its reason (offside / VAR) | all | n/a | — | deferred | Not a scorebook entry: a disallowed goal is not a goal, and the FA/IFAB match record has no field for it. VAR exists only above every declared variant's level. Needs a product decision if the pad wants a "chalked off" timeline entry. |
| Penalty awarded in open play and **not** converted (saved / missed / woodwork) | all | `taker`; the defending `keeper` | `Ev.FootballPenalty` → `State.penalties[]` | **extended** | New branch `{by, taker?, keeper?, outcome, minute?}`. `outcome` is a required enum `saved\|missed\|post` — that is also what keeps the branch distinct in the union. A **converted** penalty stays `football.goal {penalty:true}`, so no pre-W4 stream changes meaning. `keeper` is validated against the **defending** side. |
| Who took, and who saved, a missed penalty | all | `taker`, `keeper` | `Ev.FootballPenalty.taker`, `.keeper` → `State.penalties[].taker\|keeper`, `playerStats.penalties_missed` | **extended** | Both optional, per the person-attribution convention. |
| The offence that conceded a penalty | all | offender | — | deferred | Requires the Law 12 direct-free-kick offence taxonomy, which no declared fidelity tier records. Needs a product decision. |
| Yellow card | all | `person` | `Ev.FootballCard.color = "yellow"` → `State.cards[]` | modelled | Anonymous cards legal; a second plain yellow for the same person is refused (must be recorded as `second_yellow`). |
| Second yellow, and the red that follows it | all | `person` | `Ev.FootballCard.color = "second_yellow"` → `State.squads[].sentOff` | modelled | Refused without a prior yellow for that person; the fold removes the player permanently. FIFA fair play scores it −3, a direct red −4, yellow + direct red −5. |
| Direct red card | all | `person` | `Ev.FootballCard.color = "red"` | modelled | Legal pre-kickoff too (football.md §9). |
| **The offence a card was shown for** | all | `person` | `Ev.FootballCard.reason` → `State.cards[].reason` | **extended** | New optional `CardReason` enum: the six Law 12.3 cautionable offences and the seven Law 12.4 sending-off offences. The suspension tariff is a function of *this*, not of the colour — violent conduct and a second caution are both reds and carry different bans. |
| The offence reaching the discipline projection | all | `person` | `discipline.extractCards() → DisciplineCard` | deferred | `DisciplineCard` lives in `src/core/types.ts` and has no `reason` field; adding one is outside this family's blast radius. The offence is on `State.cards[]` and on the ledger event today. See §5 blockers. |
| FIFA fair-play deduction | all | `person` (anonymous cards deduct independently) | `Cfg.fairPlay`, `StandingsDelta.metrics.fair_play` | modelled | Worst applicable category per person. |
| **Sin bin / temporary dismissal** | all — universal in `youth` and `small-sided`, and the FA runs it in `11-a-side` below NLS step 4 | `person` | `Ev.FootballSinBin` → `State.squads[].sinBin[]` | **extended** | New branch. Removes the player from the pitch **without** sending them off — the fact no existing branch could express, since `football.card`'s non-yellow path removes a player for good. Anonymous bins are recorded but never move the pitch, the same discipline anonymous cards get. |
| A sin-binned player returning to the pitch | as above | `person` | `Ev.FootballSinBin.returned` | **extended** | Same branch carries both halves of the fact. An anonymous return closes the oldest anonymous dismissal. `playerStats.sin_bins` counts the dismissal and never the return. |
| Length of a temporary dismissal | as above | n/a | `Ev.FootballSinBin.minutes`, falling back to `Cfg.sinBinMinutes` | **extended** | Left unset on every variant preset on purpose: the FA runs 10 minutes in 90-minute football and reduces it *pro rata* for shorter formats, so it is a competition setting, not a Law constant. |
| A sin-binned player then sent off | as above | `person` | `applyCard` lineup check + `removeFromPitch` | **extended** | A player serving a temporary dismissal is off the pitch but still cardable; a permanent dismissal drops their bin entry so they cannot "return". |
| Substitution (off / on) | all | `off`, `on` | `Ev.FootballSub` → `State.squads[].onPitch\|bench\|offUsed` | modelled | `off` must be on the pitch, `on` must be an unused bench player. |
| **Return ("rolling" / "flying") substitution** | `youth`, `small-sided` | `off`, `on` | `Cfg.rollingSubs` | **extended** | Absent ≡ pre-W4 behaviour (a substituted player may not return). When on, the player who came off rejoins the **bench** and nothing lands in `offUsed`. Declared `true` on both the `youth` and `small-sided` presets and left unset on `11-a-side`. |
| **Cap on substitutions per side** | `11-a-side` (5 under most senior regulations) | entrant | `Cfg.maxSubs` | **extended** | Counted from `squad.offUsed.length`, so it needed no new state. Never applied under `rollingSubs`, which is uncapped by definition. Absent = uncapped, which is what every pre-W4 stream assumed. |
| Substitution *windows* (3 windows for 5 subs) | `11-a-side` | entrant | — | deferred | The Law counts windows, not substitutions, and a window is a clock fact State has no clock for. Needs a product decision. |
| Injury as the reason for a substitution | all | `off` | — | deferred | A scorebook records the substitution, not the injury; the reason is medical data with consent implications. Needs a product decision. |
| Concussion (additional permanent) substitution | all | `off`, `on` | — | deferred | An IFAB trial protocol adopted per competition; would need `Cfg.concussionSubs` and its own exemption from `maxSubs`. Needs a product decision on whether we support the trial. |
| Starting XI confirmed pre-match | all | 11 persons | `Lineup.slots[slot="starting"]`, `positions.lineup.size` | modelled | `validateLineup` enforces the exact count. |
| Captain confirmed pre-match | all | one person | `Lineup.slots[].roles = ["captain"]`, `positions.roles` | modelled | Declared `unique: true`. |
| Goalkeeper confirmed pre-match | all | one person | `Lineup.slots[].positionKey = "GK"` (`min:1, max:1`) | modelled | Enforced on the lineup — but `squadFromLineup` drops `positionKey`, so **State does not know who the keeper is**. See the next two rows. |
| Goalkeeper change without a substitution | all | `person` | would be `Ev.FootballKeeper` | deferred | State drops `positionKey` at init, so a change-only event yields a keeper field that is `undefined` for every match where nobody swapped. Carrying the starting keeper in `init` changes the serialised State of every frozen stream and is therefore not additive. Blocked on W5's lineup model carrying positions into State. |
| Shirt numbers | all | every squad member | `entrantModel.team.squadNumbers = true` | deferred | The flag declares the affordance; the number itself has no home — `LineupSlot` (core/types.ts) has no number field. Outside blast radius; see §5. |
| Squad size per variant (5-, 7-, 9-a-side) | `small-sided` | 5–9 persons | `positions.lineup.size` is a single module-level `11` | deferred | **`PositionCatalog` is declared once per module, not per variant**, and `validateLineup` compares the starting count exactly — so a legal 7-a-side lineup is rejected today. Fixing it is a `SportModule` shape change. See §5 blockers. |
| Bench size | all | up to 12 persons | `positions.lineup.benchMax = 12` | modelled | Same per-variant caveat as squad size. |
| Two halves and half-time | all | n/a | `Ev.FootballPeriod.phase` `HT`/`FT` → `State.periods[]` | modelled | `Cfg.halves` is `z.literal(2)`. |
| Half length | all | n/a | `Cfg.halfMinutes` | modelled | Variant presets: 45 / 30 / 20. |
| Extra time (two halves) | `11-a-side` in knockout stages | n/a | `Cfg.extraTime`, phases `ET_H1`/`ET_H2`, markers `ET_HT`/`ET_FT` | modelled | Only entered when the score is level at FT. |
| **Added time (allowance for time lost)** | all | n/a | `Ev.FootballPeriod.addedMinutes` → `State.periods[].addedMinutes` → `summary.detail.periods` | **extended** | Stamped on the period the marker **closes**, not the one it opens. A match report writes "90+3", which a bare integer `minute` cannot tell apart from the 93rd minute of extra time. |
| Quarters instead of halves | `youth` (mini-soccer age groups) | n/a | `Cfg.halves` is `z.literal(2)` | deferred | Needs three new `PlayPhase` values, two new period markers and a change to what triggers full time — a state-machine extension, not a field. The declared `youth` variant is 2×30 (FA U13+); quarters appear in U7–U10, which the module does not declare as a variant. Needs a product decision to declare a `mini-soccer` variant first. |
| Kick-off, and which side kicks off | all | entrant | — | deferred | `core.start` is kernel-owned, carries no side, and is outside this family's blast radius; a `football.kickoff` would duplicate the start semantics. Needs a product decision. |
| Ends changed at half-time | all | n/a | — | deferred | Not entered in a match record. |
| Temporary suspension of play, then resumption | all | n/a | — | deferred | `core.abandon` is terminal — there is no way to record a stoppage that play resumed from. A resumable suspension needs a core event pair (`core.suspend`/`core.resume`) outside this family's blast radius. See §5. |
| Abandonment | all | n/a | `core.abandon`, `Cfg.abandonPolicy` → `State.replayFlagged`, `summary.detail.abandoned` | modelled | `replay` leaves the fixture undecided; `award` decides for the leader (level ⇒ `no_result`). |
| Forfeit / walkover | all | entrant | `core.forfeit`, `Cfg.awardScore` | modelled | Awards the configured score to the opponent. |
| Kick from the penalty mark, and whether it scored | all, in knockout stages | kicker `person` | `Ev.FootballShootoutKick` → `State.shootout.kicks[]` | modelled | Kicker must be on the pitch; shootout kicks never touch `State.goals`. |
| Shootout order and alternation | as above | entrant | `expectedKicker()` in `sports/period/shootout.ts` | modelled | Out-of-turn kicks are rejected. |
| Shootout early decision and sudden death | as above | entrant | `shootoutDecision()` | modelled | Best-of-five with early decision once the lead exceeds the opponent's remaining kicks, then sudden-death pairs. |
| Which side takes the first kick | as above | entrant | the `by` of the first recorded kick | modelled | The recorded order *is* the coin-toss result; no separate field needed. |
| Keeper facing a shootout kick, and how a kick missed | as above | keeper | — | deferred | Niche even in an elite match record, and the wrong fidelity for tiers 0–3. |
| ABBA shootout order | as above | entrant | — | deferred | Trialled and withdrawn by IFAB; not in force in any competition we serve. |
| Group-stage shootout points split | `11-a-side` in group stages | entrant | `Cfg.points.shootoutWin`, `.shootoutLoss` | modelled | Youth-cup convention (SO win 2 / SO loss 1); folded through `declaredPointsSets`. |
| Referee and assistants | all | officials | `officialLabel.scorer = "Referee"` | deferred | Officials are a competition-layer assignment (the officials rota), not a match event; the module declares only the label the scoring UI shows. |
| Man of the match | all | `person` | `core.award` + `playerStats.awards[motm]` | modelled | Kernel-owned event, undoable via `core.void`. |
| Referee's written remarks | all | n/a | `core.note` | modelled | No state effect by contract. |
| Attendance, weather, pitch condition | all | n/a | — | deferred | Fixture metadata, not a scorebook event — belongs on the fixture record, not in the ledger. |

**Row counts — 26 `modelled`, 10 `extended`, 19 `deferred` (55 rows). No blank cells.**

## Per-variant divergence

| variant | where the model diverges | how it is expressed |
| --- | --- | --- |
| `11-a-side` | Baseline. Return-forbidden substitutions under a competition cap; extra time and kicks from the penalty mark in knockout; sin bins below NLS step 4. | `Cfg.maxSubs`, `Cfg.extraTime`, `Cfg.shootout`, `Ev.FootballSinBin`. |
| `youth` | 2×30 halves; **repeat substitutions**; sin bins are standard, at a shorter pro-rata period; quarters in the mini-soccer age groups the module does not declare. | `halfMinutes: 30` + `rollingSubs: true` on the preset; `Cfg.sinBinMinutes` per competition. Quarters are **deferred**. |
| `small-sided` | 2×20 halves; **flying substitutions**, uncapped; time penalties of sin-bin shape; **a 5-, 7- or 9-man team**. | `halfMinutes: 20` + `rollingSubs: true` on the preset; `Ev.FootballSinBin`. Squad size is **deferred** — `positions.lineup.size` is a single module-level `11`. |

## Person attribution — what is complete, what is not

Football sets the pattern the other families copy, so this is explicit.

**Complete** (the role exists, is optional, and the fold retains it):

| event | person roles | retained in |
| --- | --- | --- |
| `football.goal` | `scorer`, `assist` | ledger + `playerStats.goals/assists/penalty_goals` |
| `football.card` | `person` | `State.cards[].person`, `discipline.extractCards`, `playerStats.*_cards` |
| `football.sub` | `off`, `on` (both **required** — a substitution with nobody named is not a fact) | `State.squads[].onPitch/bench/offUsed` |
| `football.shootout.kick` | `person` (kicker) | validated against the pitch; not retained per-kick in State |
| `football.penalty` *(W4)* | `taker`, `keeper` | `State.penalties[].taker/keeper`, `playerStats.penalties_missed` |
| `football.sinbin` *(W4)* | `person` | `State.squads[].sinBin[].person`, `playerStats.sin_bins` |

**Incomplete / missing:**

1. **The goalkeeper is never named in State.** `squadFromLineup` keeps person
   ids and drops `positionKey`, so nothing downstream can say who was in goal —
   and therefore no goalkeeper stat (clean sheets, saves, goals conceded) is
   derivable. Deferred, see the table.
2. **The shootout kicker is validated but not retained.** `applyShootoutKick`
   checks `person` is on the pitch and then folds only `{side, scored}`. Shootout
   conversion is not attributable from State (it is from the ledger).
3. **The own-goal scorer is retained but not counted.** `scorer` survives on the
   ledger; the missing piece is only the `own_goals` metric — blocked, see §5.
4. **Anonymous is always legal.** Every person field above except
   `football.sub`'s `off`/`on` is optional, and every fold has an anonymous path
   (cards, sin bins and penalties all record without touching the pitch).

## Downstream owed

Nothing here was acted on.

1. **New enum values the web-side vocab does not know**: `CardReason`
   (13 members), `PenaltyOutcome` (`saved`/`missed`/`post`).
   `apps/web/src/lib/scoring-vocab.ts` humanises unknown values, so nothing
   breaks — but they will read as raw snake_case until they get labels, in all
   four locale dictionaries.
2. **New event types the pad must be able to emit**: `football.penalty` and
   `football.sinbin`, both tier-2/3 only (`scoring.match_timeline`
   entitlement). Neither moves the score.
3. **Facts the pad must prompt for**: the penalty `outcome` (required — there
   is no valid `football.penalty` without it); whether a `football.sinbin` is a
   dismissal or a **return** (`returned`); the sin-bin duration when
   `Cfg.sinBinMinutes` is not set; `addedMinutes` at each period marker.
4. **New config the rules editor should expose**: `rollingSubs`, `maxSubs`,
   `sinBinMinutes`. `rollingSubs` now ships `true` on the `youth` and
   `small-sided` presets, so an editor that renders variant presets will show a
   changed default for those two.
5. **Stat models that become possible**: `penalty_goals`, `penalties_missed`,
   `sin_bins` are new `playerStats.metrics` keys and will appear as new
   leaderboard columns. `points` is unchanged (`penalty_goals` is a strict
   subset of `goals`).
6. **Not in the summary, on purpose**: unconverted penalties and sin bins are
   in `State` and on the ledger but **not** in `summary.detail`. Conformance
   §9.6 requires `summary(coarse fold) === summary(fine fold)` and `coarsen`
   drops every event with no score effect — the same reason `cards` has never
   been in the summary. A match report must read the ledger, not the summary.

## Blockers — changes this family needed but did not make

1. **`DisciplineCard` has no `reason` field** (`src/core/types.ts`). The Law 12
   offence now exists on the event and in `State.cards[]`, but
   `discipline.extractCards` cannot surface it, so the discipline usecase still
   cannot vary a suspension by offence. One optional field on
   `DisciplineCard` plus one conditional spread in football's `extractCards`.
2. **`PositionCatalog` is per module, not per variant** (`src/sport/catalog.ts`,
   `src/sport/module.ts`). `positions.lineup.size` is a single `11` and
   `validateLineup` compares it exactly, so the declared `small-sided` variant
   cannot have a legal lineup. Needs either per-variant `positions` on
   `SportModule` or a `Cfg`-driven override read by `validateLineup`.
3. **`LineupSlot` has no shirt-number field** (`src/core/types.ts`), while
   `entrantModel.team.squadNumbers` declares the affordance.
4. **No resumable suspension of play in the core event set**
   (`src/core/events.ts`). `core.abandon` is terminal; there is no
   `core.suspend`/`core.resume` pair, so a match stopped and restarted cannot be
   recorded as such.
5. **`src/stats/stats.test.ts:52` blocks an `own_goals` metric.** It asserts the
   exact stat row for an own goal, so adding the metric reds a file outside this
   family's blast radius.
