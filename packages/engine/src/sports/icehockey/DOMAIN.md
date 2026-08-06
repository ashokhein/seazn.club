# Ice hockey — domain dossier

**Module** `icehockey@1.0.0` (`icehockey.ts`), built on the shared period kernel
(`../period/kernel.ts`). W4 Layer-1 audit, #407 programme.

**Audited against**

- IIHF Rule Book 2025/26 — Rules 16–35 (penalties), 24 (penalty shot), 33
  (bench minors and who serves), 84 (overtime), 85 (game-winning shots).
- The IIHF Official Game Sheet: the goal section (No · period · time · team ·
  scorer · A1 · A2 · situation), the penalty section (period · time · No ·
  min · infraction · served by · start · end), the goalkeeper record, shots on
  goal by period, and the GWS section.
- IIHF Event Code 2026 §219 (3-2-1-0 points) and §220 (head-to-head-first
  tie-break).

**Declared variants** — `iihf` (the default: 3×20, sudden-death OT, GWS,
3-2-1-0) and `recreational` (no OT, no GWS, draws stand, 2/1/0).

Everything below is what a scorekeeper writes on the sheet. `Ev.` = a payload
branch of `eventSchema`, `Cfg.` = the parsed config, `State.` = the folded
state, `summary.` = `module.summary(state)`.

## Mapping table

| fact | variants | who/what participates | schema path | status | note |
| --- | --- | --- | --- | --- | --- |
| Goal credited to a side | all | entrant | `Ev.PeriodGoal.by` → `State.goals`, `State.periods[].home/away` | modelled | Period-by-period breakdown falls out of the phase machine. |
| Goal scorer | all | person (scorer) | `Ev.PeriodGoal.person` → `State.goalLog[].person` | extended | The field existed but the fold dropped it — the scorer was recoverable only by re-reading the ledger through `playerStats`. Now every attributed goal appends a `GoalLogEntry`. |
| Assists, A1 then A2 | all | persons (up to 2) | `Ev.PeriodGoal.assists` → `State.goalLog[].assists`, `playerStats.assists` | modelled | `Cfg.assists = true`; array order is A1, A2 and is preserved. Both count one assist each; the sheet's primary/secondary split is display, not arithmetic. |
| Period a goal was scored in | all | — | `Ev.PeriodGoal.period` → `State.goalLog[].phase` | extended | The field was parsed and discarded. It now labels the log entry; the goal still lands in the CURRENT period bucket, so a back-dated goal is reported honestly rather than silently rewriting `State.periods`. |
| Clock time of a goal | all | — | `Ev.PeriodGoal.at` → `State.goalLog[].at` (was `clockRef`) | extended | W4a (#425): `{period, elapsed}` in seconds, counted UP from the start of the period, and it is what the fold orders and expires against. `clockRef` stays beside it, deprecated and display-only, because removing it would break the frozen goldens; where both are present `at` wins. |
| Even-strength goal | all | entrant | `Ev.PeriodGoal.kind` omitted or `"fg"` | modelled | EV is the absence of a situation code. |
| Powerplay goal | all | entrant, person | `Ev.PeriodGoal.kind = "pp"` → `State.kindCounts`, `standingsDelta.metrics.goals_pp`, `playerStats.goals_pp` | modelled | Person-level split added this wave; the team metric already existed. |
| Shorthanded goal | all | entrant, person | `Ev.PeriodGoal.kind = "sh"` → `metrics.goals_sh`, `playerStats.goals_sh` | modelled | As above. |
| Penalty-shot goal | all | person | `Ev.PeriodGoal.kind = "ps"` → `playerStats.goals_ps` | modelled | Only the converted ones; the awarded shot is its own row below. |
| Empty-net goal | all | person | `Ev.PeriodGoal.emptyNet` → `State.goalLog[].emptyNet`, `playerStats.goals_en` | extended | A boolean beside `kind`, not a sixth kind: IIHF situation codes stack (an SH-EN goal is both), and widening `Cfg.goalKinds` would have changed the config that every frozen golden stream carries inside its state. |
| Own goal | all | entrant (+ the striking side) | `Ev.PeriodGoal.kind = "og"` | modelled | Credits the opponent; `State.goalLog[].by` keeps the side whose player struck it, `credited` the side that got the goal. |
| Game-winning goal (GWG) | all | person | — | deferred | Derivable from the fold — the (loser's final total + 1)-th goal of the winner. Recording it would duplicate state and could contradict it. |
| Plus/minus, and the six players on the ice at each goal | all | up to 12 persons per goal | — | deferred | Needs continuous on-ice personnel tracking. Wrong fidelity for our tiers: no phone scorer enters twelve ids per goal, and a half-entered on-ice set produces wrong plus/minus rather than none. Product decision. |
| Penalty: the offending player | all | person | `Ev.PeriodSuspensionStart.person` → `State.suspensions[].person`, `State.cardLog[].person` | modelled | Optional, so coarse scoring stays legal. |
| Penalty: the infraction | all | — | `Ev.PeriodSuspensionStart.reason` → `State.suspensions[].reason`, `State.cardLog[].reason` | extended | Free text or an IIHF code. Recorded, never adjudicated (v6/00 §6.4). |
| Penalty: class and its recorded minutes | all | entrant | `Ev.PeriodSuspensionStart.class` against `Cfg.suspensions.classes` | modelled | minor 2 · bench minor 2 · double minor 4 · major 5 · misconduct 10 · game misconduct 20 · match 25 PIM. |
| Penalty: the player who SERVES it | all | person | `Ev.PeriodSuspensionStart.servedBy` → `State.suspensions[].servedBy`, `playerStats.pen_served` | extended | Bench minors (Rule 33) and goalkeeper penalties are served by a team-mate. Before this, the only slot for him was `person`, which charged him the PIM he did not earn. Existing `pen_*` metrics still read `person` — the convention is now: `person` = penalised, `servedBy` = sits. |
| Penalty: a duration different from the class nominal | all | — | `Ev.PeriodSuspensionStart.minutes` | extended | Rare on ice, the norm in field hockey; the field lives in the shared kernel. Pads prefer it over the class minutes for a countdown. |
| Penalty start time | all | — | `Ev.PeriodSuspensionStart.at` → `State.suspensions[].startedAt`, `State.cardLog[].startedAt` | extended | W4a. `clockRef` folded to nothing; `at` makes the penalty TIMED — the fold derives `State.suspensions[].expiresAt` from it and the awarded minutes. Unstamped starts keep the old behaviour exactly: nothing expires. The two phases with no play clock are not left without an expiry, because "no expiry" reads as "for the rest of the match": a penalty stamped in `pre` is SERVED from the opening whistle (`{P1, 0}`), and one stamped in `SHOOTOUT` — where there is no match clock and the carry deliberately refuses to spill — serves zero time if its class makes the team short, and keeps its open end if it does not. |
| Penalty end time | all | — | `Ev.PeriodSuspensionEnd.at`; `State.suspensions[].expiresAt` | extended | W4a. Both halves the sheet prints: the DERIVED end (start + awarded minutes) and, when the scorer releases the player explicitly, the stamp on that release. An explicit end at or after the derived expiry is accepted in the GENERAL case, not merely when the same event carries both: the fold applies the release before sweeping, and where an EARLIER stamped event already swept the penalty the release is reconciled against `State.cardLog[].expiresAt` and folds as a no-op. Lazy expiry means the pad and the fold are meant to disagree in that window, so refusing the scorer's own record would punish them for the fold's laziness. Three cases keep their `INVALID_EVENT`, because each is a contradictory record rather than a scorer the fold got ahead of: a release naming a penalty that was never awarded, one the fold ended EARLY on a powerplay goal while it still had time to run, and one carrying no stamp to reconcile against. |
| The team plays short while a penalty runs | all | entrant | `State.suspensions[].teamShort` → `summary.detail.strength` | modelled | 5v4, 5v3. Two coincidental minors fold to 4v4 with no special case. |
| Penalties beyond 5-on-3 stack without reducing further | all | entrant | `Cfg.strength.min = 3` | modelled | |
| Early release of a minor on a powerplay goal | all | entrant | `Ev.PeriodGoal.at` + `Cfg.suspensions.classes.minor.releaseOnGoal` | extended | W4a §3.4 (Rule 20.4). A stamped goal releases the CONCEDING side's earliest-started running minor. Gated on BOTH the goal and the suspension carrying a stamp, which is what makes it additive: no recorded stream carries `at`, so no recorded goal releases anything it did not release before. The conceding side is the opponent of the side CREDITED, not of the side that struck it — the two disagree on an own goal. WHICH penalty goes is the one with the LEAST TIME REMAINING (earliest `expiresAt`), not the first pushed: push order is START order, and the two diverge the moment an umpire awards a duration other than the class nominal, so a 5:00 minor at 100 was released ahead of a 2:00 minor at 200. Push order survives only as the tie-break. A penalty stamped at the goal's OWN instant is skipped — §3.3 declares equal `at` normal, it has served none of its time, and releasing it made the fold depend on the order of two events at one whistle. |
| A penalty runs out by TIME, not only by an event | all | entrant | `Ev.PeriodSuspensionStart.at` + `.minutes` → `State.suspensions[].expiresAt` | extended | W4a §3.1. Expiry is LAZY: the fold sweeps at the next stamped event and at every phase whistle, because state is only ever observed at event boundaries. Between an expiry and the next event the pad (counting down) and the fold (a record of facts) legitimately disagree — a `PadSpec` obligation for W5, not a bug. |
| A penalty awarded near the buzzer keeps running in the next period | all | entrant | `Cfg.periods.minutes` / `Cfg.overtime.minutes` → `State.suspensions[].expiresAt.period` | extended | W4a. A 2:00 minor at 19:10 of a 20-minute period expires 70 s into P2. Deferring this was not a partial answer but the wrong one: an expiry left at `{P1, 1270}` sorts BEFORE every P2 stamp, so the first stamped P2 event swept it and the penalty was UNDER-served. The length comes from the cfg's own required scalars, so every competition gets the carry whether or not it declares anything extra. The carry walks the PLAY phases only, so it may cross into overtime and never into the shootout — and where that overtime is never PLAYED (a 5:00 major at P3 19:10 carries to `{OT, 250}`, then full time decides it 1–0 in regulation) the end-of-match sweep drops it, or the final state reads 5v4 at FULL TIME. That sweep drops TIMED penalties only, which is why an unstamped card and a rest-of-match class still keep the team short to the final whistle. |
| Periods of UNEQUAL length | all | entrant | `Cfg.periodSeconds` → `State.suspensions[].expiresAt` | extended | W4a. `Cfg.periods.minutes` is a single scalar for all n periods and `Cfg.overtime.minutes` a single scalar for OT1..OTk, so a competition whose last period is shorter has nowhere else to say so; `periodSeconds` is that override, still optional with no default (a default would put a new key inside every frozen golden state's cfg). It is NOT the authority for the carry — reading only it duplicated an authority the cfg already held with no cross-check, and `{P1:60,P2:60,P3:60}` against a 20-minute cfg carried a 10-second major three phases downfield. A map that is uniform across a phase group states nothing the scalar does not, so where the two disagree the scalar wins and the map is IGNORED rather than refused: cfg is read live at fold time, a correct length is always in hand, and refusing would let a later config edit make every already-scored fixture in the division unviewable. |
| A double minor's FIRST half ends on a powerplay goal | all | person | `Cfg.suspensions.classes.double_minor` (no `releaseOnGoal`) | deferred | Rule 20.4 ends the first 2:00 and starts the second running. That is two suspensions, not one shortened by half, so flagging the 4:00 class releasable would wipe the 2:00 the offender still owes. Splitting it needs its own state and a pad affordance. The visible consequence, so it is not discovered as a surprise: a goal beside a running double minor reaches PAST it to the ordinary minor, because the 4:00 class is not eligible for release at all. |
| As of when the folded state is true | all | — | `State.asOf` | extended | W4a §6 obligation 3. The newest stamp the fold applied, absent until the first one. A strength chip without it is a number with no instant attached, and every consumer would otherwise re-scan the raw payloads to find one. |
| Delayed penalty | all | — | `core.note` | deferred | Documented kernel design (v6/00 §6.4): the module records the scorer's decision, it does not adjudicate penalty law. |
| Penalty shot AWARDED, converted or not | all | person (taker), person (goalkeeper) | `Ev.PeriodSetPiece{kind:"ps"}` → `State.setPieces.<side>.ps.{awarded,scored}`, `summary.detail.setPieces`, `playerStats.ps_taken` | extended | New event type `icehockey.set_piece` (Rule 24). The `ps` goal kind could only ever show the shots that beat the keeper. The allowed kinds are `Cfg.setPieceKinds`, seeded from the preset (`["ps"]`); emptying the list turns the event off. |
| Goalkeeper changes; pulled goalie | all | person | — | deferred | On-ice personnel rather than a scoring fact — the module deliberately has no substitution event. The scoring consequence, an empty net, is now captured by `Ev.PeriodGoal.emptyNet`. |
| Shots on goal, per team per period | all | entrant | — | deferred | Wrong fidelity for our tiers: tier 3 tops out at attributed timeline scoring, and a per-shot stream is a different product (and a different pad). See "downstream owed". |
| Saves and save percentage | all | person (goalkeeper) | — | deferred | Derives from shots on goal plus a goalie-on-ice track; both deferred above. `playerStats.so_saves` covers the shoot-out only. |
| Faceoffs won / lost | all | 2 persons | — | deferred | Same fidelity argument as shots on goal. |
| Three periods; period-by-period score | all | entrant | `Cfg.periods{count:3,minutes:20}`, `Ev.PeriodAdvance.to`, `State.periods[]` | modelled | P1 → P2 → P3 → FT. |
| Sudden-death overtime, first goal wins | iihf | entrant | `Cfg.overtime{kind:"sudden_death",minutes:5}` | modelled | Rule 84.1; the OT goal decides instantly with `method:"extra_time"`. |
| Overtime is played 3-on-3 | iihf | entrant | `Cfg.overtime.skaters` | deferred | **Parsed and dropped.** `strengthOf` always bases on `Cfg.strength.base`, so a penalty in OT reads `5v4` instead of `4v3`. Fixing it properly is not a base swap either: under Rule 84.4 the NON-offending team gains a skater rather than the offender losing one — a different strength algorithm. A base swap is worse than incomplete, it is actively WRONG, and this is the part to read before reaching for it: ice hockey declares `Cfg.strength{base:5,min:3}` against `Cfg.overtime.skaters:3`, so swapping the overtime base to 3 makes base EQUAL min, `strengthOf` floors both sides at 3 for any number of penalties, `strengthChip` returns null, and the powerplay chip DISAPPEARS in overtime — strictly less than the `5v4` shown today. Field hockey's `fih-detail` coverage config collides the same way (`skaters:7` against `min:7`). Nor would the corpus referee the attempt: `Cfg.strength` has exactly ONE reader, `strengthChip` inside `summary`, and every recorded stream ends in phase `done`, so an overtime-gated change moves no recorded summary and reds nothing. The corpus holds **3** states in OT with a penalty running, across streams 3, 4 and 13 — measured over the unslimmed replay; an earlier revision of this row said two and the S1 decision log said 35, and both are wrong. Needs a product decision. |
| Game-winning shots: 5 shooters, then sudden-death pairs | iihf | entrant | `Cfg.shootout{attempts:5,suddenDeath:true}` | modelled | Early-out when the lead exceeds the opponent's remaining entitlement. |
| GWS shooting order and shooter | iihf | person | `Ev.PeriodShootoutAttempt.person` → `State.shootout.kicks[].person`, `playerStats.so_attempts` / `so_goals` | extended | The payload field existed; the fold recorded only `{side, scored}`, so the taker was unrecoverable from state. |
| The goalkeeper facing each attempt | iihf | person | `Ev.PeriodShootoutAttempt.goalkeeper` → `State.shootout.kicks[].goalkeeper`, `playerStats.so_saves` | extended | Named on the GWS section of the sheet. |
| When each shoot-out attempt was taken | iihf | — | `Ev.PeriodShootoutAttempt.at` → `State.asOf` | extended | W4a. Cards are already stampable in `SHOOTOUT` and the attempt is the only other event that phase is made of, so leaving it unstampable froze `State.asOf` at the last stamped card for the whole decider and a consumer reading "as of when is this true" got an instant from before the shoot-out began. Distinct from `meta.clockSeconds`, which is the 8-second limit on ONE attempt rather than a position in the match. |
| A player in the box at the end of OT is ineligible to shoot | iihf | person | `Ev.PeriodShootoutAttempt.meta.ineligible` | modelled | Recorded, never enforced — the engine does not adjudicate. |
| The GWS winner is credited one goal in the official score | iihf | entrant | `PeriodPreset.shootoutWinnerGoal` → `officialScore` → `summary.headline`, `standingsDelta.metrics{gf,ga,gd}` | extended | IIHF Rule 87 / NHL Rule 84.4. A 2–2 match won on the shoot-out is RECORDED 3–2: the winner takes GF +1, the loser GA +1, and it flows into goal difference. Awarded in the OFFICIAL-SCORE layer — one `officialScore` derivation read by both `summary` and `sideMetrics`, so the headline and the standings ledger cannot fork — and NEVER in the fold. `State.goals`, `State.kindCounts` and `State.goalLog` are untouched and no goal event is minted, because the same rules give shoot-out attempts no player goals and no goals-against; a phantom goal with no scorer would corrupt the per-person attribution that player stats and the career rollup read. Gated on the DECIDED outcome, so a shoot-out still running credits nothing, and on `award`, so a forfeit score stays `Cfg.awardScore`. ICE HOCKEY ONLY: the preset flag is off by default and field hockey deliberately leaves it off — see the matching row in `hockey/DOMAIN.md` before "fixing" the inconsistency. The four icehockey golden streams that end on a shoot-out (3, 4, 12, 13) were re-baselined for it; `summary` and `deltas` moved, no state, no outcome and no event did. This was never a product deferral — no rulebook supported the old output. |
| Points 3 / 2 / 1 / 0 | iihf | entrant | `Cfg.points{win:3,otWin:2,otLoss:1,loss:0}` → `standingsDelta` | modelled | Event Code §219; the OT/GWS split rides on `outcome.method`. |
| H2H-first tie-break | all | entrant | `defaultTiebreakers` | modelled | Event Code §220; pinned by a hand-computed 3-team tie in `period.test.ts`. |
| Draws stand where no decider is configured | recreational | entrant | `Cfg.overtime = null`, `Cfg.shootout = null`, `supportsDraws` | modelled | 2/1/0. |
| A recreational league's simplified penalty ladder | recreational | entrant | `Cfg.suspensions.classes` (inherited) | deferred | The variant inherits the full IIHF ladder. Whether rec leagues want "2 minutes, that's it" is a product decision, and editing the variant changes the config recorded inside that variant's frozen golden streams. |
| Team PIM | all | entrant | `standingsDelta.metrics.pim` | modelled | Summed from `State.cardLog` via the class table. |
| Per-player PIM | all | person | `playerStats.derived.pim` | modelled | Derived from the counted classes (2/4/5/10/20/25). |
| Forfeit; abandonment | all | entrant | `core.forfeit` → `Cfg.awardScore{goals:5}`; `core.abandon` → `Cfg.abandonPolicy:"replay"` | modelled | |
| Rosters, captains, jersey numbers | all | persons | `positions`, `entrantModel.team{squadNumbers,captain}` | modelled | Layer 2 — lineups, not the event ledger. |
| A penalty against a team official / the bench staff | all | person (non-player) | `Ev.PeriodSuspensionStart.person` / `.servedBy` | deferred | Nothing marks the named person as a non-player, so a coach's game misconduct lands in the player stat table. `servedBy` at least names who actually sits. A `role` discriminator needs a product decision on whether non-players exist in the person model at all. |

| Where in the match an event happened (the position axis) | all | — | `SportModule.position(state)` -> `period` + `clock` segments, e.g. `P2 . 12:41` | extended | W4a T6b. A **read-side projection**, never a payload: a `MatchPosition` on every stamped event was considered this wave and rejected, because position is derivable from state the fold already computes and recording it would create a recorded value and a derived value of the same type that can silently disagree — the `DisciplineCard.entrantSide` shape. A wrong recorded value is in the hash-chained ledger forever; a wrong projection is one deploy away from fixed. Ordered segments rather than a display string, so W8 can drop a segment for a 375px scorebug, localise each `key` and order two positions in one match; `formatPosition` is the plain-text path. Nothing is materialised into state, so every frozen golden is byte-identical. Shares ONE function reference with hockey through the period kernel, asserted by identity. SHOOTOUT is evidenced from `State.shootout` and sorts last, so a fixture decided there reports `SHOOTOUT` rather than the third period. The clock is attached only when `asOf.period` matches the phase that resolved — an unstamped period change leaves the newest stamp naming the period before it, and printing 19:59 beside `P3` asserts something false about where play is. |

**Row counts:** 22 modelled, 20 extended, 11 deferred (53 rows).
Asserted against the table itself by `src/testkit/dossiers.test.ts`.

## Downstream owed

1. **New event type `icehockey.set_piece`.** W5's pad needs a control ("penalty
   shot awarded → converted?"), and it must be gated on fidelity tier 2/3 —
   it is deliberately absent from tiers 0 and 1. `scoring-vocab.ts` humanises
   unknown types, so nothing breaks today; a real label is owed.
2. **New payload keys a pad should prompt for**: goal `emptyNet`, `clockRef`;
   suspension `reason`, `servedBy`, `minutes`; shoot-out `goalkeeper`.
3. **New `summary.detail` keys**: `goalLog` (array of attributed goals) and
   `setPieces`. Both are ABSENT until attributed data exists — every consumer
   must treat them as optional, never as `[]`/`{}`.
4. **New `playerStats` metric keys** for W6 stat models: `goals_pp`,
   `goals_sh`, `goals_ps`, `goals_en`, `ps_taken`, `so_attempts`, `so_goals`,
   `so_saves`, `pen_served`.
5. **No new standings metric was added.** A team-level penalty-shot conversion
   rate would have to appear in `standingsDelta.metrics` for every fixture or
   for none; adding it unconditionally changes the frozen golden deltas. The
   absent-key blocker is now GONE: `competition/tiebreakers.ts` `metricOf` is
   partial, and `compareMetric` ranks a row that never recorded the metric
   BELOW every row that did instead of scoring it a genuine zero. A rate metric
   can therefore be emitted for the fixtures that have one. What is still owed
   is a consumer — no federation ranks on conversion rate (FIH is points → GD →
   GF → head-to-head, IIHF points → head-to-head → GD → GF), so emitting it
   today would move eleven corpora and every standings delta for display only.
6. **`DisciplineCard` cannot see the new detail.** It carries
   `{personId, entrantSide, color, eventId}` only, so discipline accumulation
   still keys on colour + person: no "three of the same infraction" rule, and a
   bench minor accumulates against whoever is in `person`. `DisciplineCard`
   lives in `core/types.ts`, outside this wave's blast radius.
7. **Shots on goal / saves / faceoffs** are the honest next fidelity step for
   this sport and would be a tier-4 conversation, not an extension of tier 3.
8. **`Cfg.overtime.skaters` is dead config** until the 3-on-3 strength question
   above is decided. Anything reading it today gets a number the fold ignores.

9. **W4a (#425) — the time model.** New payload key `at` on the goal, the
   suspension start and end, the set piece and the period advance (`clockRef`
   is deprecated but stays). New state keys `State.suspensions[].startedAt` /
   `.expiresAt` and `State.asOf`, all ABSENT until a stamp exists — consumers
   must treat them as optional, never as a zero time. New cfg key
   `Cfg.periodSeconds` (phase label → seconds), optional with no default.
10. **Pad obligations this creates for W5.** A pad rendering a countdown must
   show `State.asOf`, because the pad and the fold legitimately disagree
   between an expiry and the next stamped event. A pad offering
   remaining-basis entry must declare `periodSeconds`. Stamps must be
   submitted in non-decreasing order or the fold answers
   `NON_MONOTONIC_TIME`; correcting one is void-then-re-append, in that order.
11. **No e2e coverage this wave, by decision.** W4a ships no `apps/web`
   surface, so there is nothing to drive; e2e is deferred to **W10 (#421)**,
   where the pad first meets the API. Smoke IS owed and is handed to the
   wave's smoke task: a timed match where a minor expires by fold, a
   powerplay goal releases another, and one penalty crosses the buzzer.
