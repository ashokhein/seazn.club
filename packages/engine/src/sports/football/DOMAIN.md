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
| Own goal charged to the player who scored it | all | `scorer` | `playerStats.own_goals` | **extended** | `{when: p.ownGoal === true}` on `football.goal`; a personal column only, so `goals` and `points` are unchanged. The closed-set assertion in `src/stats/stats.test.ts` was widened to the new correct row. |
| Assist | all | `assist` | `Ev.FootballGoal.assist` → `playerStats.assists` | modelled | One assist per goal (unlike ice hockey's two). |
| **Time of a goal / card / sub / sin bin** | all | n/a | `Ev.FootballGoal.at`, `Ev.FootballCard.at`, `Ev.FootballSub.at`, `Ev.FootballSinBinStart.at`, `Ev.FootballSinBinEnd.at` → `State.cards[].at`, `State.squads[].sinBin[].startedAt`; legacy `.minute` on all five | **extended** | W4a (#425) §5.2. `at` is the core `GameTime` **verbatim** — SECONDS counted up from the start of the named period, so `90+3` is `{period:"H2", elapsed:2880}`. The pre-existing `minute` is MINUTES; it is **not removed** (that would break every frozen golden and the additive tripwire) but is deprecated in comment. **Where both are present `at` wins**: it is the only one the fold derives from, and `minute` is never read, converted or overwritten. Using the real `GameTime` schema is a contract, not a style note — the kernel is fail-open on a malformed stamp, so the payload schema is the only guard between a corrupt stamp and the ledger. The fold still keeps per-period counts, not a timeline. |
| A goal-by-goal timeline inside State | all | `scorer`, `assist` | would be `State.timeline[]` | deferred | The ledger already is the timeline and the match report reads it. State is serialised whole into the frozen golden corpus, so a new always-present array would break back-compat for zero new information. |
| Disallowed goal and its reason (offside / VAR) | all | n/a | — | deferred | Not a scorebook entry: a disallowed goal is not a goal, and the FA/IFAB match record has no field for it. VAR exists only above every declared variant's level. Needs a product decision if the pad wants a "chalked off" timeline entry. |
| Penalty awarded in open play and **not** converted (saved / missed / woodwork) | all | `taker`; the defending `goalkeeper` | `Ev.FootballPenalty` → `State.penalties[]` | **extended** | New branch `{by, taker?, goalkeeper?, outcome, minute?}`. `outcome` is a required enum `saved\|missed\|post` — that is also what keeps the branch distinct in the union. A **converted** penalty stays `football.goal {penalty:true}`, so no pre-W4 stream changes meaning. `goalkeeper` is validated against the **defending** side. |
| Who took, and who saved, a missed penalty | all | `taker`, `goalkeeper` | `Ev.FootballPenalty.taker`, `.goalkeeper` → `State.penalties[].taker\|goalkeeper`, `playerStats.penalties_missed` | **extended** | Both optional, per the person-attribution convention. |
| The offence that conceded a penalty | all | offender | — | deferred | Requires the Law 12 direct-free-kick offence taxonomy, which no declared fidelity tier records. Needs a product decision. |
| Yellow card | all | `person` | `Ev.FootballCard.color = "yellow"` → `State.cards[]` | modelled | Anonymous cards legal; a second plain yellow for the same person is refused (must be recorded as `second_yellow`). |
| Second yellow, and the red that follows it | all | `person` | `Ev.FootballCard.color = "second_yellow"` → `State.squads[].sentOff` | modelled | Refused without a prior yellow for that person; the fold removes the player permanently. FIFA fair play scores it −3, a direct red −4, yellow + direct red −5. |
| Direct red card | all | `person` | `Ev.FootballCard.color = "red"` | modelled | Legal pre-kickoff too (football.md §9). |
| **The offence a card was shown for** | all | `person` | `Ev.FootballCard.reason` → `State.cards[].reason` | **extended** | New optional `CardReason` enum: the six Law 12.3 cautionable offences and the seven Law 12.4 sending-off offences. The suspension tariff is a function of *this*, not of the colour — violent conduct and a second caution are both reds and carry different bans. |
| **The offence reaching the discipline projection** | all | `person` | `Ev.FootballCard.reason` / `Ev.FootballSinBinStart.reason` → `discipline.extractCards() → DisciplineCard.reason` | **extended** | Unblocked later in W4: `DisciplineCard.reason` (`src/core/types.ts`) plus the conditional spread in football's `extractCards` (`football.ts`), so the discipline usecase can vary a suspension by offence and not only by colour. `extractCards` projects a **sin bin** too, under the declared colour `sin_bin` — the return half of that branch is never a second sanction. |
| FIFA fair-play deduction | all | `person` (anonymous cards deduct independently) | `Cfg.fairPlay`, `StandingsDelta.metrics.fair_play` | modelled | Worst applicable category per person. |
| **Sin bin / temporary dismissal** | all — universal in `youth` and `small-sided`, and the FA runs it in `11-a-side` below NLS step 4 | `person` | `Ev.FootballSinBinStart` (`football.sinbin.start`) → `State.squads[].sinBin[]` | **extended** | New branch. Removes the player from the pitch **without** sending them off — the fact no existing branch could express, since `football.card`'s non-yellow path removes a player for good. Anonymous bins are recorded but never move the pitch, the same discipline anonymous cards get. |
| A sin-binned player returning to the pitch | as above | `person` | `Ev.FootballSinBinEnd` (`football.sinbin.end`) | **extended** | A start/end PAIR, the shape the period kernel uses for a suspension: two scorer moments minutes apart. An anonymous end closes the oldest anonymous dismissal. `playerStats.sin_bins` counts the dismissal and never the return. |
| Length of a temporary dismissal | as above | n/a | `Ev.FootballSinBinStart.minutes`, falling back to `Cfg.sinBinMinutes` | **extended** | Left unset on every variant preset on purpose: the FA runs 10 minutes in 90-minute football and reduces it *pro rata* for shorter formats, so it is a competition setting, not a Law constant. |
| **A sin bin running out on the clock** | as above | `person` | `Ev.FootballSinBinStart.at` + `.minutes`/`Cfg.sinBinMinutes` → `State.squads[].sinBin[].expiresAt`, swept in `apply` | **extended** | W4a (#425) §3.1. Before W4a a temporary dismissal ended **only** on an explicit `football.sinbin.end`, so the competition's own sin-bin length was recorded and never counted down. Expiry is **lazy**: the fold releases the player at the next STAMPED event at or after `expiresAt`, which means the pad (rendering the countdown from `expiresAt`) and the fold legitimately disagree in between — by design, and a `PadSpec` obligation for W5, not a bug. An **unstamped** event sweeps nothing, which is what keeps every pre-W4a stream folding unchanged, and both halves are required, so nothing expires that did not expire before. Expiry **never crosses a period boundary** (§3.2): a bin opened late in a half has an `expiresAt` no later stamp in that half can reach, and the engine has no period length to roll the remainder into, so it does not expire by time at all. An anonymous bin closes without returning anybody to the pitch. The explicit end still works; one stamped at or after a derived expiry is refused as a stale duplicate. |
| A sin-binned player then sent off | as above | `person` | `applyCard` lineup check + `removeFromPitch` | **extended** | A player serving a temporary dismissal is off the pitch but still cardable; a permanent dismissal drops their bin entry so they cannot "return". |
| Substitution (off / on) | all | `off`, `on` | `Ev.FootballSub` → `State.squads[].onPitch\|bench\|offUsed` | modelled | `off` must be on the pitch, `on` must be an unused bench player. |
| **Return ("rolling" / "flying") substitution** | `youth`, `small-sided` | `off`, `on` | `Cfg.rollingSubs` | **extended** | Absent ≡ pre-W4 behaviour (a substituted player may not return). When on, the player who came off rejoins the **bench** and nothing lands in `offUsed`. Declared `true` on both the `youth` and `small-sided` presets and left unset on `11-a-side`. |
| **Cap on substitutions per side** | `11-a-side` (5 under most senior regulations) | entrant | `Cfg.maxSubs` | **extended** | Counted from `squad.offUsed.length`, so it needed no new state. Never applied under `rollingSubs`, which is uncapped by definition. Absent = uncapped, which is what every pre-W4 stream assumed. |
| **Substitution *windows*** (3 windows for 5 subs) | `11-a-side` | entrant | `Cfg.subWindows` + `Ev.FootballSub.at` → `State.squads[].subWindows[]`, error `SUB_WINDOW_EXCEEDED` | **extended** | W4a (#425) §5.2. Unblocked by the core time model: the clock fact State had no clock for is now the stamp on the event. A window is the set of substitutions **sharing one `at`**, so three players sent on at a single stoppage spend one window; five subs taken one at a time spend five, which is exactly the Law that `Cfg.maxSubs` alone could not express. Counted per side, and applied **alongside** `maxSubs`, never instead of it. An **unstamped** substitution is in no window and consumes none — reading "no stamp" as one shared window would trip a one-window allowance on the second unstamped sub and make every pre-W4a stream unfoldable; recording one window each is the mirror of the same bug. Absent `Cfg.subWindows` = unlimited windows, which is what every pre-W4a stream assumed. First throw site for `SUB_WINDOW_EXCEEDED` (422). |
| Injury as the reason for a substitution | all | `off` | — | deferred | A scorebook records the substitution, not the injury; the reason is medical data with consent implications. Needs a product decision. |
| Concussion (additional permanent) substitution | all | `off`, `on` | — | deferred | An IFAB trial protocol adopted per competition; would need `Cfg.concussionSubs` and its own exemption from `maxSubs`. Needs a product decision on whether we support the trial. |
| Starting XI confirmed pre-match | all | 11 persons | `Lineup.slots[slot="starting"]`, `positions.lineup.size` | modelled | `validateLineup` enforces the exact count. |
| Captain confirmed pre-match | all | one person | `Lineup.slots[].roles = ["captain"]`, `positions.roles` | modelled | Declared `unique: true`. |
| Goalkeeper confirmed pre-match | all | one person | `Lineup.slots[].positionKey = "GK"` (`min:1, max:1`) | modelled | Enforced on the lineup — but `squadFromLineup` drops `positionKey`, so **State does not know who the keeper is**. See the next two rows. |
| Goalkeeper change without a substitution | all | `person` | would be `Ev.FootballKeeper` | deferred | State drops `positionKey` at init, so a change-only event yields a keeper field that is `undefined` for every match where nobody swapped. Carrying the starting keeper in `init` changes the serialised State of every frozen stream and is therefore not additive. Blocked on W5's lineup model carrying positions into State. |
| **Shirt numbers** | all | every squad member | `entrantModel.team.squadNumbers = true` + `LineupSlot.squadNumber` | **extended** | Unblocked later in W4: the number field landed on `LineupSlot` (`src/core/types.ts`), so the affordance the entrant model declares now has a home on the lineup. Optional, and the fold never reads it. |
| **Squad size per variant (5-, 7-, 9-a-side)** | `small-sided` | 5–9 persons | `Cfg.teamSize` → `positionsFor(cfg)` → `resolvePositions` | **extended** | Unblocked later in W4: `SportModule.positionsFor?(cfg)` (`src/sport/module.ts`) and the `resolvePositions` accessor (`src/sport/catalog.ts`). Football declares `teamSize: 7` on `small-sided` (`football.ts`), so `validateLineup` now compares against the variant's own starting count. Lineup-only — never the fold. |
| Bench size | all | up to 12 persons | `positions.lineup.benchMax = 12` | modelled | Same per-variant caveat as squad size. |
| Two halves and half-time | all | n/a | `Ev.FootballPeriod.phase` `HT`/`FT` → `State.periods[]` | modelled | `Cfg.halves` is `z.literal(2)`. |
| Half length | all | n/a | `Cfg.halfMinutes` | modelled | Variant presets: 45 / 30 / 20. |
| Extra time (two halves) | `11-a-side` in knockout stages | n/a | `Cfg.extraTime`, phases `ET_H1`/`ET_H2`, markers `ET_HT`/`ET_FT` | modelled | Only entered when the score is level at FT. |
| **Added time (allowance for time lost)** | all | n/a | `Ev.FootballPeriod.addedMinutes` → `State.periods[].addedMinutes` → `summary.detail.periods` | **extended** | Stamped on the period the marker **closes**, not the one it opens. A match report writes "90+3", which a bare integer `minute` cannot tell apart from the 93rd minute of extra time. |
| Quarters instead of halves | `youth` (mini-soccer age groups) | n/a | `Cfg.halves` is `z.literal(2)` | deferred | Needs three new `PlayPhase` values, two new period markers and a change to what triggers full time — a state-machine extension, not a field. The declared `youth` variant is 2×30 (FA U13+); quarters appear in U7–U10, which the module does not declare as a variant. Needs a product decision to declare a `mini-soccer` variant first. |
| Kick-off, and which side kicks off | all | entrant | — | deferred | `core.start` is kernel-owned, carries no side, and is outside this family's blast radius; a `football.kickoff` would duplicate the start semantics. Needs a product decision. |
| Ends changed at half-time | all | n/a | — | deferred | Not entered in a match record. |
| **Temporary suspension of play, then resumption** | all | n/a | `core.suspend` / `core.resume` (kernel-owned) | **extended** | Unblocked later in W4: the pair landed in `src/core/events.ts` and is folded inside `foldMatch`, so it never reaches a module's `apply` and no sport re-implements it. A suspension that is never resumed leaves the stoppage open; `core.abandon`/`core.forfeit` close it in the same step they decide. |
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

**Row counts:** 25 modelled, 18 extended, 13 deferred (56 rows). No blank cells.
Asserted against the table itself by `src/testkit/dossiers.test.ts`.

## Per-variant divergence

| variant | where the model diverges | how it is expressed |
| --- | --- | --- |
| `11-a-side` | Baseline. Return-forbidden substitutions under a competition cap; extra time and kicks from the penalty mark in knockout; sin bins below NLS step 4. | `Cfg.maxSubs`, `Cfg.extraTime`, `Cfg.shootout`, `Ev.FootballSinBinStart` / `Ev.FootballSinBinEnd`. |
| `youth` | 2×30 halves; **repeat substitutions**; sin bins are standard, at a shorter pro-rata period; quarters in the mini-soccer age groups the module does not declare. | `halfMinutes: 30` + `rollingSubs: true` on the preset; `Cfg.sinBinMinutes` per competition. Quarters are **deferred**. |
| `small-sided` | 2×20 halves; **flying substitutions**, uncapped; time penalties of sin-bin shape; **a 5-, 7- or 9-man team**. | `halfMinutes: 20` + `rollingSubs: true` on the preset; `Ev.FootballSinBinStart` / `Ev.FootballSinBinEnd`. Squad size is **deferred** — `positions.lineup.size` is a single module-level `11`. |

## Person attribution — what is complete, what is not

Football sets the pattern the other families copy, so this is explicit.

**Complete** (the role exists, is optional, and the fold retains it):

| event | person roles | retained in |
| --- | --- | --- |
| `football.goal` | `scorer`, `assist` | ledger + `playerStats.goals/assists/penalty_goals` |
| `football.card` | `person` | `State.cards[].person`, `discipline.extractCards`, `playerStats.*_cards` |
| `football.sub` | `off`, `on` (both **required** — a substitution with nobody named is not a fact) | `State.squads[].onPitch/bench/offUsed` |
| `football.shootout.kick` | `person` (kicker) | validated against the pitch; not retained per-kick in State |
| `football.penalty` *(W4)* | `taker`, `goalkeeper` | `State.penalties[].taker/goalkeeper`, `playerStats.penalties_missed` |
| `football.sinbin.start` / `.end` *(W4)* | `person` | `State.squads[].sinBin[].person`, `playerStats.sin_bins` |

**Incomplete / missing:**

1. **The goalkeeper is never named in State.** `squadFromLineup` keeps person
   ids and drops `positionKey`, so nothing downstream can say who was in goal —
   and therefore no goalkeeper stat (clean sheets, saves, goals conceded) is
   derivable. Deferred, see the table.
2. **The shootout kicker is validated but not retained.** `applyShootoutKick`
   checks `person` is on the pitch and then folds only `{side, scored}`. Shootout
   conversion is not attributable from State (it is from the ledger).
3. ~~**The own-goal scorer is retained but not counted.**~~ Closed later in W4:
   `playerStats.own_goals` (`football.ts`) reads `football.goal.scorer` under
   `{when: p.ownGoal === true}`. `goals` and `points` are unchanged.
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
   `football.sinbin.start`/`.end`, all tier-2/3 only (`scoring.match_timeline`
   entitlement). Neither moves the score.
3. **Facts the pad must prompt for**: the penalty `outcome` (required — there
   is no valid `football.penalty` without it); the sin-bin duration when
   `Cfg.sinBinMinutes` is not set; `addedMinutes` at each period marker.
4. **New config the rules editor should expose**: `rollingSubs`, `maxSubs`,
   `sinBinMinutes`, and (W4a) `subWindows`. `rollingSubs` now ships `true` on the
   `youth` and `small-sided` presets, so an editor that renders variant presets
   will show a changed default for those two. `subWindows` is left unset on every
   preset on purpose: three windows is a senior-11-a-side regulation, not a Law
   constant, and absent means unlimited.
5. **Stat models that become possible**: `penalty_goals`, `penalties_missed`,
   `sin_bins` are new `playerStats.metrics` keys and will appear as new
   leaderboard columns. `points` is unchanged (`penalty_goals` is a strict
   subset of `goals`).
6. **W4a — what the pad owes the time model** (`PadSpec`, #416). Four things,
   and none of them is an engine constraint:
   - **The unit.** `at.elapsed` is SECONDS, the legacy `minute` is MINUTES, and
     nothing in the fold converts between them. A pad offering minute-only entry
     multiplies by 60 itself; `core/time.ts`'s `parseElapsed` takes `mm:ss` only
     and refuses a bare number precisely because this sport's legacy field is
     called `minute`.
   - **Remaining-basis entry needs a period length.** The engine holds none for
     football (`Cfg.halfMinutes` is a nominal half, and `elapsed` may legitimately
     overrun it — `90+3`), so a pad offering "07:19 remaining" converts itself.
   - **Render what the fold is folded *as of*.** A sin bin expires lazily, at the
     next stamped event, so between the expiry and that event the pad's countdown
     and the folded strength are meant to differ. Without an `asOf` a scorer reads
     the stale chip as a bug — and must not be offered an explicit "return"
     button for a bin the fold will sweep, which is now refused as a duplicate.
   - **Stamps go in non-decreasing order.** A backwards stamp is
     `NON_MONOTONIC_TIME` (422). Correcting one is void **then** re-append, in
     that order, and an "edit" affordance on anything but the newest stamped
     event must undo forward to it.
7. **No `apps/web` surface, and no e2e, on purpose.** W4a ships engine-side only:
   no API field, no dictionary key, no pad control, so there is nothing to drive
   in a browser. e2e coverage for stamped football events is **deferred to W10
   (#421)**, where the pad first meets the API; persisting `at` (the events table
   gains no column this wave) is deferred with it. Recorded here rather than in
   the mapping table because the table's rows are sport-fact → schema-path tuples
   that `testkit/dossiers.test.ts` tallies, and a process row would corrupt the
   count.
8. **Not in the summary, on purpose**: unconverted penalties and sin bins are
   in `State` and on the ledger but **not** in `summary.detail`. Conformance
   §9.6 requires `summary(coarse fold) === summary(fine fold)` and `coarsen`
   drops every event with no score effect — the same reason `cards` has never
   been in the summary. A match report must read the ledger, not the summary.

## Blockers — all five were raised, and all five are now cleared

This section listed five shared-engine changes the football pass needed and was
not allowed to make: they sat outside one sport family's blast radius. The
shared-engine pass later in W4 made **every one of them**, on this same branch.
Nothing in this dossier is blocked. The mapping-table rows that read `deferred`
because of these are now `extended`, each naming what implements it.

| was blocked on | now | where it lives |
| --- | --- | --- |
| `DisciplineCard` had no `reason` | done | `DisciplineCard.reason` in `src/core/types.ts`; the conditional spread in football's `extractCards` |
| `PositionCatalog` was per module, not per variant | done | `SportModule.positionsFor?(cfg)` (`src/sport/module.ts`) + `resolvePositions` (`src/sport/catalog.ts`); football declares `Cfg.teamSize`, `small-sided` sets `7` |
| `LineupSlot` had no shirt-number field | done | `LineupSlot.squadNumber` in `src/core/types.ts` — the same name the roster path already used (`src/sport/entrant-model.ts`) |
| no resumable suspension in the core event set | done | `core.suspend` / `core.resume` in `src/core/events.ts`, folded inside `foldMatch` and never forwarded to a module's `apply` |
| `src/stats/stats.test.ts` blocked an `own_goals` metric | done | `playerStats.own_goals` in `football.ts`; the closed-set assertion in `stats.test.ts` was widened to the new correct row |

**Still genuinely deferred** (and still marked `deferred` in the table above):
the goalkeeper is not named in `State`, so no keeper stat is derivable; the
shootout kicker is validated but not retained in `State`; quarters instead of
halves need three new `PlayPhase` values; the Law 12 direct-free-kick offence
taxonomy behind a conceded penalty has no declared fidelity tier. Each of those
needs a product decision or a state-machine extension, not a shared-engine
field.
