# Tennis — domain audit (W4, #407)

**Module** `tennis@1.0.0`, built on the nested kernel (`nested/kernel.ts` —
points → games → sets, the only kernel in the engine with a game layer).
**Variants:**

- `tour` (default) — best of 3 tie-break sets, tie-break at 6–6 to 7, advantage
  games;
- `grand-slam` — best of 5, the deciding set plays normally but its tie-break at
  6–6 runs to 10;
- `fast4` — sets to 4 games, tie-break at 3–3 to 5, no-ad games;
- `doubles-noad-mtb10` — no-ad games and a 10-point **match tie-break** that
  replaces the deciding set (the ITF doubles norm).

**Audited against:** the ITF *Rules of Tennis* (Rule 5 "score in a game",
Rule 6 "score in a set", Rule 7 "score in a match", Rule 21 "the let",
Rule 30 "continuous play"), Appendix VI (alternative procedures — no-ad, short
sets, match tie-break) and Appendix VII / the ITF *Duties and Procedures for
Officials* — i.e. the **chair umpire's card**: point-by-point boxes, the server
column, the ace / double-fault marks, the code-violation box, the change-of-ends
ticks and the signature line.

## Mapping table

| fact | variants | who/what participates | schema path | status | note |
| --- | --- | --- | --- | --- | --- |
| A point is won | all | entrant | `Ev.Point.by` | modelled | |
| Point calls 0 / 15 / 30 / 40 | all | entrant | `State.points` (`kind: "standard"`), `gameScoreLine` | modelled | the display speaks tennis. |
| Deuce and advantage | tour, grand-slam | entrant | `State.points.advantage` | modelled | advantage back to deuce is folded, not derived. |
| No-ad: one deciding point at deuce | fast4, doubles-noad-mtb10 | entrant | `Cfg.game.noAd` | modelled | |
| Receiver's choice of side at the deciding point | fast4, doubles-noad-mtb10 | entrant | `Ev.Point.meta.receiverSide` | modelled | recorded for the record; ITF App VI. |
| Games won inside a set | all | entrant | `State.games` | modelled | |
| Set won at 6 games, by two | tour, grand-slam | entrant | `Cfg.set.gamesTo`, `Cfg.set.winBy` | modelled | |
| Short sets to 4 | fast4 | entrant | `Cfg.set` (variant `fast4`) | modelled | ITF App VI. |
| Tie-break game at 6–6 to 7, win by 2 | tour, grand-slam, fast4 | entrant | `Cfg.set.tiebreakAt`, `.tiebreakTo`, `Cfg.tiebreak.winBy` | modelled | `fast4` enters at 3–3 and plays to 5. |
| Deciding-set tie-break to 10 at 6–6 | grand-slam | entrant | `Cfg.finalSet.tiebreakTo` | modelled | the real slam rule, not an approximation. |
| Match tie-break replacing the deciding set | doubles-noad-mtb10 | entrant | `Cfg.finalSet.matchTiebreakTo` | modelled | banked as `ClosedSet.mtb`, printed `[10–7]`. |
| Advantage (open-ended) final set | configurable | entrant | `Cfg.set.tiebreakAt = null` | modelled | no shipped variant uses it; the kernel supports it. |
| Match won at 2 sets (3 in a slam) | all | entrant | `Cfg.bestOf`, `State.setsWon`, `outcome.kind = "win"` | modelled | tennis never draws. |
| Which side is serving | all | entrant side | `State.serving`, `summary.detail.serving` | modelled | alternates each game; after a tie-break the first tie-break server receives. |
| Tie-break serve rotation (one point, then two each) | all | entrant side | `State.tbPointsPlayed`, `State.tbFirstServer` | modelled | ITF Rule 5b. |
| **Which player** served the point | all | person `server` | `Ev.Point.server` → `State.persons[id].serves` | extended | optional `PersonId`. The chair's card has a server column; in doubles the side alone cannot say who served. |
| **Which player** won the point | all | person `scorer` | `Ev.Point.scorer` → `State.persons[id].points` | extended | optional. `scorer` is the engine-wide name for the person credited with a point; `winner` is an EntrantId everywhere else (`MatchOutcome.winner`). `Ev.Point.meta.kind = "winner"` keeps the word where tennis really uses it — the *shot type*. |
| Ace | all | person (the server) | `Ev.Point.meta.kind = "ace"` + `Ev.Point.server` → `State.persons[id].aces` | extended | the shot type was already modelled; W4 makes it attributable. |
| Double fault | all | person (the server) | `Ev.Point.meta.kind = "double_fault"` + `Ev.Point.server` → `State.persons[id].doubleFaults` | extended | credited to the **server** even though the receiver wins the point — that is how the card scores it. |
| Winner / unforced error | all | person `scorer` | `Ev.Point.meta.kind`, `Ev.Point.scorer` | modelled | the shot type already existed; attribution now rides with it. |
| Code violation ladder: warning → point penalty → game penalty → default | all | entrant + optional person | `Ev.Sanction.level`, `.person`, `.reason` → `State.sanctions[]`, `summary.detail.sanctions`, `discipline.extractCards` | extended | new `tennis.sanction` event; never moves the score. `reason` is optional free text and reaches the discipline projection only — the fold never reads it, so no recorded state moves. |
| The point a **point penalty** concedes | all | entrant | recorded as a `tennis.point` for the opponent | modelled | as the chair writes it into the card. |
| The game a **game penalty** concedes | all | entrant | — | deferred | there is no "award a game" event, and adding one would be a new scoring path rather than an additive field. A scorer can enter the four points; a proper fix needs a product decision. |
| The specific code-violation offence (racquet abuse, audible obscenity, coaching, time violation, …) | all | person | `Ev.Sanction.reason` (free text) | deferred | still deferred as a *taxonomy*: the ITF offence list is long and tour-specific, and a closed enum needs a product decision plus four locale dictionaries. W4's review added the free-text `reason` so the chair's own words reach `DisciplineCard.reason` — which is what an accumulation rule keyed on the offence ("three for racquet abuse") actually needs. Carrom's dossier records the same compromise. |
| Break of serve | all | entrant | derived from `State.serving` + `State.games` | modelled | the card marks it; the ledger already determines it. |
| First serve vs second serve | all | person | — | deferred | the chair's card records only the outcome (a double fault). First-serve percentage is a broadcast statistic, wrong fidelity for our tiers. |
| Lets | all | — | — | deferred | a let is replayed and nothing is written — there is no scoresheet fact to record. |
| Challenges / electronic review | all | person | — | deferred | Hawk-Eye venues only, and electronic line calling has removed challenges from most tour events. Niche; wrong fidelity for club play. |
| Change of ends (odd games; every 6 points in a tie-break) | all | — | — | deferred | fully derivable from the games and points played; procedural, no fold consequence. |
| Medical timeout, toilet break, heat rule | all | entrant + optional person | `Ev.Interruption.kind`, `.by`, `.person`, `.duration` → `State.interruptions[]`, `summary.detail.interruptions` | extended | new `tennis.interruption` event (W4a §5.4). `duration` is recorded explicitly, not derived: a three-minute limit must not drift when the chair taps late. Never moves the score — a delay penalty is entered as the point it is. `person` REQUIRES `by`: the allowance is per side, so a named player with no side is credited on the leaderboard while nothing charges the break to anyone, and the ITF limit is per player. The fold cannot derive the side (it holds the two entrant ids and no lineup), so it refuses instead. |
| A break allowance, and a break that runs over it | configurable | entrant | `Cfg.interruptions[kind].count` / `.seconds` → `State.interruptions[].overCount` / `.overran` | extended | BOTH are **recorded and flagged, never rejected** — the (N+1)th break of a kind by one side in one set gets `overCount`, an over-long one gets `overran`, and both stand. Nothing derived from cfg may throw: cfg is read live from `division.config` and every read replays the whole stream from `init`, so a refusal computed here fires on events already in the ledger the moment an organiser lowers the number, with no event to void and no scorer action that recovers the fixture. (§5.4 specified a hard refusal for `count`; the W4a review corrected it — the period kernel takes the same decision for `periodSeconds`, in the same words.) `count` is evaluated only where the break names a side: a rain delay is charged to nobody, the same conditional shape ITTF expedite takes without `serving`. Both flags are PROJECTIONS of the cfg in force at read time, not facts about the event, and a later cfg edit legitimately flips them against an unchanged `duration` — the alternative freezes a verdict beside the input it came from, which is the two-fields-that-silently-disagree bug this wave rejected everywhere else. No shipped variant declares an allowance. |
| **When** a break was called | all | — | `Ev.Interruption.at` (`GameTime` verbatim), `playPhases(cfg)` = `pre, S1…S{bestOf}` | extended | the period is the **set** and `elapsed` counts from the start of that set, which is how the card and every broadcast clock report tennis time — the generator's stamp is set-relative for the same reason, so the corpus freezes the model the row states. Optional: an unstamped break is unconstrained by the kernel's monotonic guard, so no recorded stream changed meaning. A stamp naming a set the match has not reached is refused; the set on the record is always the fold's own index, never the payload's. `apply()` re-validates both the stamp's period and its own set index against `playPhases(cfg)` before comparing them, so a period the sport does not declare is a fixable `INVALID_EVENT` — `apply` is reached directly by conformance and simulation, where the kernel's check never runs, and `UNKNOWN_PHASE` there is an unactionable 500. |
| Coaching (now permitted on tour) | all | person | — | deferred | not a scoring fact; when it is illegal it arrives as a code violation, which is modelled above. |
| Retirement | all | entrant | `core.forfeit` → `outcome.kind = "award"` | modelled | completed sets already stand in the ledger. |
| Walkover | all | entrant | `core.forfeit` before `core.start` | modelled | same event, no sets played. |
| Suspension for rain or darkness | all | — | `core.suspend` / `core.resume` (both carry `at`) for a stoppage play returns from; `core.abandon` → `State.replayFlagged` when it does not | modelled | kernel-owned, so no tennis code folds them. The suspend/resume pair and `tennis.interruption` are complementary records and a chair may write both: the pair says play stopped and when, the interruption says which break it was and who it is charged to. |
| Singles vs doubles | all | entrant kind | `entrantModel.kinds` (`individual`, `pair`) | modelled | entrant kind, not a module variant. |
| Doubles serving and receiving order | all | persons | — | deferred | `server` now records who served each point, so the order is reconstructable; **enforcing** the fixed rotation needs the pair's declared order, which is a lineup-layer fact. |
| Chair umpire on the card | all | official | `officialLabel.scorer = "Chair Umpire"` | modelled | |
| Remarks | all | — | `core.note` | modelled | free text, no fold effect. |
| A printed tennis scorecard | all | — | — | deferred | only volleyball ships an `exportTemplates.scoresheet`; a tennis card is a print task for a later wave, not a schema gap. |

| Where in the match an event happened (the position axis) | all | — | `SportModule.position(state)` -> `set` + `game` + `points` segments, e.g. `Set 2 . Game 4 . 30-15` | extended | W4a T6b. A **read-side projection**, never a payload: a `MatchPosition` on every stamped event was considered this wave and rejected, because position is derivable from state the fold already computes and recording it would create a recorded value and a derived value of the same type that can silently disagree — the `DisciplineCard.entrantSide` shape. A wrong recorded value is in the hash-chained ledger forever; a wrong projection is one deploy away from fixed. Ordered segments rather than a display string, so W8 can drop a segment for a 375px scorebug, localise each `key` and order two positions in one match; `formatPosition` is the plain-text path. Nothing is materialised into state, so every frozen golden is byte-identical. The tie-break needs no special case: `State.games` is held at 6-6 through it, so it falls out as game 13 of the set. A MATCH tie-break replaces the final set and has no games, so the game segment is omitted rather than reported as a phantom `Game 1`. The point score deliberately carries NO ordinal — points played is not derivable from `GamePoints` past deuce, so `comparePosition` is told to stop at the game rather than handed an invented rank it would sort by. Once a set banks the kernel resets `games` and `points`, so a decided match reads its games off the set that was actually played and drops the points segment. |

**Row counts:** 24 modelled, 9 extended, 9 deferred (42 rows).
Asserted against the table itself by `src/testkit/dossiers.test.ts`.

## Downstream owed

- **Position labels owed in all four locale dictionaries** (W4a T6b): `scoring.position.set`, `scoring.position.game`.
  `SportModule.position` returns a stable segment `key` plus an ENGLISH `label`
  fallback — the engine writes no locale copy, by the same rule `MetricSpec.label`
  follows. W8 renders `scoring.position.<key>` and falls back to `label`. The `period`, `clock` and `points` segments carry NO label — `P2`, `12:41` and `30–15` name themselves, and labelling them renders "Period P2".
  Deliberately NOT written by this task, which touches no dictionary.

- **New event type** `tennis.sanction`, reachable at fidelity tiers 2 and 3
  under the existing `scoring.rally_by_rally` entitlement. No new FeatureKey was
  introduced.
- **New enum** `NestedSanctionLevel` = `warning | point_penalty | game_penalty |
  default`. `apps/web/src/lib/scoring-vocab.ts` humanises unknown values, so
  nothing breaks, but a label set is owed — and `default` in particular reads
  badly unlabelled.
- **`tennis.sanction.reason`** (W4 review) — optional free text, the chair's own
  words for the offence. It reaches `DisciplineCard.reason` and nothing else:
  the fold never reads it, so no recorded state and no golden moves. A pad
  should offer it as a free-text field beside the ladder step, not as a picker,
  until the taxonomy row above is resolved.
- **New payload fields** `tennis.point.server` and `.scorer`. A doubles pad must
  offer both members of each pair, and should default `server` from
  `summary.detail.serving` plus the pair's order.
- **`summary().detail`** now carries `persons` and `sanctions` when non-empty.
  Tennis can afford `persons` in the summary because it declares no `coarsen`
  hook — the set-based kernel deliberately cannot (see `DOMAIN.volleyball.md`).
- **`playerStats` now exists** (`points`, `service_points`, `aces`,
  `double_faults`, `violations`, `medical_timeouts`), so tennis leaderboards
  stop reporting `requires_detailed_scoring`. W6 can derive first-serve-free
  serving stats from `aces` / `double_faults` over `service_points`.
  `medical_timeouts` counts MEDICAL breaks only — a toilet break or a rain
  delay is not a statistic about a player, and one shared key would make the
  number mean nothing on a leaderboard.
- **New event type** `tennis.interruption` (W4a #425 §5.4), reachable at
  fidelity tiers 2 and 3 under the existing `scoring.rally_by_rally`
  entitlement. No new FeatureKey. There is deliberately **no end event**: a
  start/end pair would make `duration` derivable from the end's stamp, and this
  wave's rule is that `at` records only what the fold cannot derive.
- **New enum** `NestedInterruptionKind` = `medical | toilet | heat | other`, and
  a new `overran` flag on the record. Label keys are owed in
  `apps/web/src/lib/scoring-vocab.ts` and all four dictionaries (#427):
  the event name, the four kinds, `overran`, and a heading for the
  `summary.detail.interruptions` block. `other` in particular reads badly
  unlabelled.
- **New cfg** `Cfg.interruptions[kind] = { count?, seconds? }` — optional with no
  default, so no shipped variant declares one and no frozen state string moves.
  A rules editor offering it must say which scope each half has: `count` is per
  side per SET, `seconds` is per break.
- **`playPhases(cfg)`** is now declared by the tennis module — `pre` then `S1…
  S{bestOf}`. Two consequences beyond this event: a stamped `core.suspend` /
  `core.resume` on a tennis fixture must name one of those periods or it is
  refused as `INVALID_EVENT`, and stamps are now ordered by the kernel's
  monotonic guard. A pad must submit stamps in non-decreasing order or handle
  `NON_MONOTONIC_TIME`; correcting one is void **then** re-append (W4a §4.1).
- **`summary().detail`** gains `interruptions` when non-empty, alongside
  `persons` and `sanctions`.
- **One substantive unmet fact** still needs a product decision before schema
  work: a game penalty has no representation. The medical-timeout gap that sat
  beside it is closed above — the engine still owns no clock, and does not need
  one: the chair's stamp and the break's length both arrive as recorded values.
