# Field hockey — domain dossier

**Module** `hockey@1.0.0` (`hockey.ts`), built on the shared period kernel
(`../period/kernel.ts`). W4 Layer-1 audit, #407 programme.

**Audited against**

- FIH Rules of Hockey (outdoor) 2025/26 — Rule 12 (penalties awarded), 13
  (penalty corner, penalty stroke), 14 (personal penalties: green / yellow /
  red), 9 (conduct of play).
- FIH Tournament Regulations Appendix 12 — the shoot-out competition: five
  one-on-ones per side, 8 seconds per attempt from the 23 m line, then
  sudden-death pairs.
- The FIH match record sheet / official match report: goals split by origin
  (field goal · penalty corner · penalty stroke), penalty corners awarded,
  cards with time and duration, and the shoot-out record.

**Declared variants** — `fih-outdoor` (the default: 4×15, draws stand, 3/1/0),
`fih-shootout` (a shoot-out settles a drawn match, SO win worth 2 and SO loss
1), `youth` (4×10).

Field hockey and ice hockey share a kernel and almost nothing else on the
scoresheet: no assists, cards make the team short at every grade, the deciders
are quarters and a one-on-one run rather than periods and a straight shot, and
the sport's signature statistic — penalty corners awarded — has no counterpart
on the ice.

## Mapping table

| fact | variants | who/what participates | schema path | status | note |
| --- | --- | --- | --- | --- | --- |
| Goal credited to a side | all | entrant | `Ev.PeriodGoal.by` → `State.goals`, `State.periods[].home/away` | modelled | Quarter-by-quarter breakdown falls out of the phase machine. |
| Goal scorer | all | person (scorer) | `Ev.PeriodGoal.person` → `State.goalLog[].person` | extended | The field existed but the fold dropped it — the scorer was recoverable only by re-reading the ledger through `playerStats`. Now every attributed goal appends a `GoalLogEntry`. |
| Assists | — | — | `Cfg.assists = false` | deferred | The FIH match record does not record assists. The kernel supports them for ice hockey and this preset deliberately refuses them; a goal payload carrying `assists` is rejected with `INVALID_EVENT`. |
| Field goal (open play, from within the circle) | all | person | `Ev.PeriodGoal.kind` omitted or `"fg"` | modelled | |
| Penalty-corner goal | all | person | `Ev.PeriodGoal.kind = "pc"` → `State.kindCounts`, `standingsDelta.metrics.goals_pc`, `playerStats.goals_pc` | modelled | The sheet always splits FG / PC / PS; person-level split added this wave, the team metric already existed. |
| Penalty-stroke goal | all | person | `Ev.PeriodGoal.kind = "stroke"` → `metrics.goals_stroke`, `playerStats.goals_stroke` | modelled | As above. |
| Own goal | all | entrant (+ the striking side) | `Ev.PeriodGoal.kind = "og"` | modelled | Credits the opponent; `State.goalLog[].by` keeps the side whose player struck it. |
| Quarter and clock time of a goal | all | — | `Ev.PeriodGoal.period` → `State.goalLog[].phase`; `Ev.PeriodGoal.clockRef` | extended | `period` was parsed and discarded; it now labels the log entry, while the goal still lands in the current quarter's bucket. `clockRef` is free text, display only — the engine has no clock (v6/00 §6.1). |
| Empty-net goal (keeper withdrawn for an extra outfielder) | all | person | `Ev.PeriodGoal.emptyNet` → `State.goalLog[].emptyNet`, `playerStats.goals_en` | extended | A boolean beside `kind`, not a fourth kind: a PC can also be scored into an empty net, and widening `Cfg.goalKinds` would have changed the config every frozen golden stream carries inside its state. |
| **Penalty corners AWARDED** (not just converted) | all | entrant, person (taker) | `Ev.PeriodSetPiece{kind:"pc"}` → `State.setPieces.<side>.pc.{awarded,converted}`, `summary.detail.setPieces`, `playerStats.pc_taken` | extended | New event type `hockey.set_piece`. PCs awarded is the headline field-hockey team statistic and was entirely invisible: only a CONVERTED corner existed, as a goal kind. `converted` is the scorer's own answer; the goal itself still arrives as a goal event, so the two never double-count the score. The allowed kinds are `Cfg.setPieceKinds`, seeded from the preset (`["pc", "stroke"]`); emptying the list turns the event off. |
| Penalty strokes awarded and their outcome | all | person (taker), person (goalkeeper) | `Ev.PeriodSetPiece{kind:"stroke"}` → `State.setPieces.<side>.stroke`, `playerStats.strokes_taken` | extended | Same event; a saved stroke was previously unrecordable. |
| Green card — 2 minutes | all | person | `Ev.PeriodSuspensionStart.class = "green"` → `State.suspensions[]`, `State.cardLog[]` | modelled | |
| Yellow card — a MINIMUM of 5 minutes | all | person | `class = "yellow"` plus `Ev.PeriodSuspensionStart.minutes` | extended | The class carries the nominal 5; the umpire's actual award (10 minutes is common) had nowhere to go and now lands on `State.suspensions[].minutes` and `State.cardLog[].minutes`, which is what a pad counts down from. |
| Red card — permanent exclusion | all | person | `class = "red"`, `permanent: true` | modelled | Cannot be released by a `suspension.end`; the team stays short to full time. |
| The team plays short on EVERY card (Rule 14) | all | entrant | `teamShort: true` on green / yellow / red → `summary.detail.strength` | modelled | `11v10`, `11v9`. This is the sharpest divergence from football, where a yellow costs nothing. |
| The offence behind a card | all | — | `Ev.PeriodSuspensionStart.reason` → `State.suspensions[].reason`, `State.cardLog[].reason` | extended | Free text. Recorded, never adjudicated. |
| Time a card was shown | all | — | `Ev.PeriodSuspensionStart.clockRef` | modelled | Display only. |
| End of a temporary suspension | all | person | `Ev.PeriodSuspensionEnd` | modelled | Scorer-driven; the engine has no clock, so the release is always an event. |
| Progressive escalation — a player already carrying a green | all | person | `summary.detail.escalate` | modelled | Hockey-only hint (`escalationHints`), keyed on `preset.key === "hockey"`. |
| A card shown to a team official / coach | all | person (non-player) | `Ev.PeriodSuspensionStart.person` / `.servedBy` | deferred | Nothing marks the named person as a non-player, so a manager's yellow lands in the player stat table, and whether the team also plays short varies by regulation. `servedBy` at least names who leaves the pitch. A `role` discriminator needs a product decision on whether non-players exist in the person model. |
| Four quarters | all | entrant | `Cfg.periods{count:4,minutes:15}`, `Ev.PeriodAdvance.to`, `State.periods[]` | modelled | Q1 → Q2 → Q3 → Q4 → FT. |
| Quarter and half-time breaks | all | — | — | deferred | Not a scorable fact; the advance event is the only phase boundary the ledger needs. |
| Draws stand in a league | fih-outdoor, youth | entrant | `Cfg.overtime = null`, `Cfg.shootout = null`, `supportsDraws` | modelled | 3/1/0, `points → GD → GF → H2H`. |
| Shoot-out competition: 5 one-on-ones per side, then sudden death | fih-shootout | entrant | `Cfg.shootout{attempts:5,suddenDeath:true,clockSeconds:8}` | modelled | App 12. Early-out when the lead exceeds the opponent's remaining entitlement; sudden death only decides on a completed pair. |
| The 8-second clock on each attempt | fih-shootout | — | `Ev.PeriodShootoutAttempt.meta.clockSeconds` | modelled | Recorded per attempt, never enforced. |
| The attacker taking the one-on-one | fih-shootout | person | `Ev.PeriodShootoutAttempt.person` → `State.shootout.kicks[].person`, `playerStats.so_attempts` / `so_goals` | extended | The payload field existed; the fold recorded only `{side, scored}`, so the taker was unrecoverable from state. |
| The defending goalkeeper | fih-shootout | person | `Ev.PeriodShootoutAttempt.goalkeeper` → `State.shootout.kicks[].goalkeeper`, `playerStats.so_saves` | extended | A shoot-out attempt is explicitly a one-on-one against a named keeper. |
| A foul during the shoot-out — retake, or a penalty stroke awarded | fih-shootout | person | — | deferred | App 12's foul outcomes are a small rulebook of their own (defender foul → retake or stroke; attacker foul → attempt ends). The recorded fact — goal or no goal — survives; a retake today would be a second attempt event and would overstate the attempt count. Needs a product decision. |
| Shoot-out bonus point | fih-shootout | entrant | `Cfg.points{shootoutWin:2,shootoutLoss:1}` | modelled | Rides on `outcome.method === "shootout"`. |
| Unlimited rolling substitutions | all | persons | — | deferred | Not a scoring fact; the module deliberately has no substitution event, and FIH itself does not record them on the match sheet. |
| Goalkeeper, field player with goalkeeping privileges, or no keeper at all | all | person | `positions.groups.GK{min:1,max:1}` | deferred | A team composition fact (layer 2), and the catalog REQUIRES exactly one GK, so a side playing without a keeper cannot be expressed in a lineup at all. The scoring consequence is covered by `Ev.PeriodGoal.emptyNet`. See "downstream owed". |
| Shorter quarters for youth | youth | entrant | `Cfg.periods{count:4,minutes:10}` | modelled | The only thing the variant changes. |
| Other youth divergences — smaller sides (e.g. 7-a-side), shorter cards | youth | entrant | `Cfg.strength.base`, `Cfg.suspensions.classes` | deferred | The variant inherits base 11 and the adult card durations, so a 7-a-side youth match reports the wrong strength chip. Correcting it means editing the variant, which changes the config recorded inside that variant's frozen golden streams. Needs a product decision and probably a new variant rather than an edit. |
| Forfeit; abandonment | all | entrant | `core.forfeit` → `Cfg.awardScore{goals:3}`; `core.abandon` → `Cfg.abandonPolicy:"replay"` | modelled | |
| Circle penetrations, shots, possession, PC conversion % | all | entrant | — | deferred | FIH Pro League match reports carry them; wrong fidelity for our scoring tiers. PC conversion is now computable per fixture from `State.setPieces` without any new event. |
| Rosters, captains, squad numbers | all | persons | `positions`, `entrantModel.team{squadNumbers,captain}` | modelled | Layer 2 — lineups, not the event ledger. |

**Row counts:** 19 modelled, 9 extended, 8 deferred (36 rows).
Asserted against the table itself by `src/testkit/dossiers.test.ts`.

## Downstream owed

1. **New event type `hockey.set_piece`.** W5's pad needs controls for
   "penalty corner awarded" and "penalty stroke awarded → converted?", gated on
   fidelity tier 2/3 — it is deliberately absent from tiers 0 and 1.
   `scoring-vocab.ts` humanises unknown types, so nothing breaks today; real
   labels are owed, in all four locale dictionaries.
2. **New payload keys a pad should prompt for**: goal `emptyNet`, `clockRef`;
   card `reason`, `minutes` (the yellow-duration picker is the important one —
   5 or 10 changes what the pad counts down), `servedBy`.
3. **New `summary.detail` keys**: `goalLog` and `setPieces`. Both are ABSENT
   until attributed data exists — consumers must treat them as optional, never
   as `[]`/`{}`.
4. **New `playerStats` metric keys** for W6 stat models: `goals_pc`,
   `goals_stroke`, `goals_en`, `pc_taken`, `strokes_taken`, `so_attempts`,
   `so_goals`, `so_saves`, `cards_served`.
5. **PC conversion rate is now derivable** per fixture (`setPieces.pc.converted
   / .awarded`) but is NOT a standings metric: adding one would have to appear
   in `standingsDelta.metrics` for every fixture or none, and adding it
   unconditionally changes the frozen golden deltas. Needs a decision on
   absent-key semantics in the standings fold.
6. **`DisciplineCard` cannot see `reason` or `minutes`.** It carries
   `{personId, entrantSide, color, eventId}` only, so a league rule like "three
   greens for the same offence" or "any 10-minute yellow counts double" cannot
   be expressed. `DisciplineCard` lives in `core/types.ts`, outside this wave's
   blast radius.
7. **The lineup catalog forces exactly one goalkeeper** (`GK min 1 max 1`).
   A side that plays out its last minutes with eleven outfielders — the very
   situation `emptyNet` records — cannot be represented as a lineup. Worth a
   catalog decision before the pad ships.
