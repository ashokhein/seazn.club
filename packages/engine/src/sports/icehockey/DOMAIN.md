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
| Clock time of a goal | all | — | `Ev.PeriodGoal.clockRef` → `State.goalLog[].clockRef` | extended | Free-text ("12:41"), display only — the engine has no clock by design (v6/00 §6.1). |
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
| Penalty start time | all | — | `Ev.PeriodSuspensionStart.clockRef` | modelled | Display only. |
| Penalty end time | all | — | — | deferred | The release is an event (`icehockey.suspension.end`), not a clock reading; start time + class duration reconstruct the box time. A second clock string would fold to nothing. |
| The team plays short while a penalty runs | all | entrant | `State.suspensions[].teamShort` → `summary.detail.strength` | modelled | 5v4, 5v3. Two coincidental minors fold to 4v4 with no special case. |
| Penalties beyond 5-on-3 stack without reducing further | all | entrant | `Cfg.strength.min = 3` | modelled | |
| Early release of a minor on a powerplay goal | all | entrant | `Ev.PeriodSuspensionEnd` | deferred | The scorer must send the release explicitly. Making a goal auto-release the opponent's running minor would change how an already-recorded goal payload folds, which the wave's additive rule forbids outright. A pad should prompt for it. |
| Delayed penalty | all | — | `core.note` | deferred | Documented kernel design (v6/00 §6.4): the module records the scorer's decision, it does not adjudicate penalty law. |
| Penalty shot AWARDED, converted or not | all | person (taker), person (goalkeeper) | `Ev.PeriodSetPiece{kind:"ps"}` → `State.setPieces.<side>.ps.{awarded,converted}`, `summary.detail.setPieces`, `playerStats.ps_taken` | extended | New event type `icehockey.set_piece` (Rule 24). The `ps` goal kind could only ever show the shots that beat the keeper. |
| Goalkeeper changes; pulled goalie | all | person | — | deferred | On-ice personnel rather than a scoring fact — the module deliberately has no substitution event. The scoring consequence, an empty net, is now captured by `Ev.PeriodGoal.emptyNet`. |
| Shots on goal, per team per period | all | entrant | — | deferred | Wrong fidelity for our tiers: tier 3 tops out at attributed timeline scoring, and a per-shot stream is a different product (and a different pad). See "downstream owed". |
| Saves and save percentage | all | person (goalkeeper) | — | deferred | Derives from shots on goal plus a goalie-on-ice track; both deferred above. `playerStats.so_saves` covers the shoot-out only. |
| Faceoffs won / lost | all | 2 persons | — | deferred | Same fidelity argument as shots on goal. |
| Three periods; period-by-period score | all | entrant | `Cfg.periods{count:3,minutes:20}`, `Ev.PeriodAdvance.to`, `State.periods[]` | modelled | P1 → P2 → P3 → FT. |
| Sudden-death overtime, first goal wins | iihf | entrant | `Cfg.overtime{kind:"sudden_death",minutes:5}` | modelled | Rule 84.1; the OT goal decides instantly with `method:"extra_time"`. |
| Overtime is played 3-on-3 | iihf | entrant | `Cfg.overtime.skaters` | deferred | **Parsed and dropped.** `strengthOf` always bases on `Cfg.strength.base`, so a penalty in OT reads `5v4` instead of `4v3`. Fixing it properly is not a base swap either: under Rule 84.4 the NON-offending team gains a skater rather than the offender losing one — a different strength algorithm. It also cannot be done additively: two states in the frozen golden corpus are in OT with a penalty running, so the chip they recorded would change. Needs a product decision. |
| Game-winning shots: 5 shooters, then sudden-death pairs | iihf | entrant | `Cfg.shootout{attempts:5,suddenDeath:true}` | modelled | Early-out when the lead exceeds the opponent's remaining entitlement. |
| GWS shooting order and shooter | iihf | person | `Ev.PeriodShootoutAttempt.person` → `State.shootout.kicks[].person`, `playerStats.so_attempts` / `so_goals` | extended | The payload field existed; the fold recorded only `{side, scored}`, so the taker was unrecoverable from state. |
| The goalkeeper facing each attempt | iihf | person | `Ev.PeriodShootoutAttempt.goalkeeper` → `State.shootout.kicks[].goalkeeper`, `playerStats.so_saves` | extended | Named on the GWS section of the sheet. |
| A player in the box at the end of OT is ineligible to shoot | iihf | person | `Ev.PeriodShootoutAttempt.meta.ineligible` | modelled | Recorded, never enforced — the engine does not adjudicate. |
| The GWS winner is credited one goal in the official score | iihf | entrant | `State.goals` (excludes it) | deferred | IIHF adds +1 to the winner's score; we show `0 — 0 (GWS 1–0)` and `gf`/`ga` exclude it. Changing it rewrites existing folds and every standings row. Product decision. |
| Points 3 / 2 / 1 / 0 | iihf | entrant | `Cfg.points{win:3,otWin:2,otLoss:1,loss:0}` → `standingsDelta` | modelled | Event Code §219; the OT/GWS split rides on `outcome.method`. |
| H2H-first tie-break | all | entrant | `defaultTiebreakers` | modelled | Event Code §220; pinned by a hand-computed 3-team tie in `period.test.ts`. |
| Draws stand where no decider is configured | recreational | entrant | `Cfg.overtime = null`, `Cfg.shootout = null`, `supportsDraws` | modelled | 2/1/0. |
| A recreational league's simplified penalty ladder | recreational | entrant | `Cfg.suspensions.classes` (inherited) | deferred | The variant inherits the full IIHF ladder. Whether rec leagues want "2 minutes, that's it" is a product decision, and editing the variant changes the config recorded inside that variant's frozen golden streams. |
| Team PIM | all | entrant | `standingsDelta.metrics.pim` | modelled | Summed from `State.cardLog` via the class table. |
| Per-player PIM | all | person | `playerStats.derived.pim` | modelled | Derived from the counted classes (2/4/5/10/20/25). |
| Forfeit; abandonment | all | entrant | `core.forfeit` → `Cfg.awardScore{goals:5}`; `core.abandon` → `Cfg.abandonPolicy:"replay"` | modelled | |
| Rosters, captains, jersey numbers | all | persons | `positions`, `entrantModel.team{squadNumbers,captain}` | modelled | Layer 2 — lineups, not the event ledger. |
| A penalty against a team official / the bench staff | all | person (non-player) | `Ev.PeriodSuspensionStart.person` / `.servedBy` | deferred | Nothing marks the named person as a non-player, so a coach's game misconduct lands in the player stat table. `servedBy` at least names who actually sits. A `role` discriminator needs a product decision on whether non-players exist in the person model at all. |

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
   for none; adding it unconditionally changes the frozen golden deltas. Needs
   a decision on absent-key semantics in the standings fold first.
6. **`DisciplineCard` cannot see the new detail.** It carries
   `{personId, entrantSide, color, eventId}` only, so discipline accumulation
   still keys on colour + person: no "three of the same infraction" rule, and a
   bench minor accumulates against whoever is in `person`. `DisciplineCard`
   lives in `core/types.ts`, outside this wave's blast radius.
7. **Shots on goal / saves / faceoffs** are the honest next fidelity step for
   this sport and would be a tier-4 conversation, not an extension of tier 3.
8. **`Cfg.overtime.skaters` is dead config** until the 3-on-3 strength question
   above is decided. Anything reading it today gets a number the fold ignores.
