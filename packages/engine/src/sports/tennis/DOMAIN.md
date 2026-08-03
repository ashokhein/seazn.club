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
| Medical timeout, toilet break, heat rule | all | person | — | deferred | the chair records these as **clock times**, and the kernel has no clock. Needs a product decision before any schema. |
| Coaching (now permitted on tour) | all | person | — | deferred | not a scoring fact; when it is illegal it arrives as a code violation, which is modelled above. |
| Retirement | all | entrant | `core.forfeit` → `outcome.kind = "award"` | modelled | completed sets already stand in the ledger. |
| Walkover | all | entrant | `core.forfeit` before `core.start` | modelled | same event, no sets played. |
| Suspension for rain or darkness | all | — | `core.abandon` → `State.replayFlagged` | modelled | leaves the fixture undecided for re-scheduling. |
| Singles vs doubles | all | entrant kind | `entrantModel.kinds` (`individual`, `pair`) | modelled | entrant kind, not a module variant. |
| Doubles serving and receiving order | all | persons | — | deferred | `server` now records who served each point, so the order is reconstructable; **enforcing** the fixed rotation needs the pair's declared order, which is a lineup-layer fact. |
| Chair umpire on the card | all | official | `officialLabel.scorer = "Chair Umpire"` | modelled | |
| Remarks | all | — | `core.note` | modelled | free text, no fold effect. |
| A printed tennis scorecard | all | — | — | deferred | only volleyball ships an `exportTemplates.scoresheet`; a tennis card is a print task for a later wave, not a schema gap. |

**Row counts:** 24 modelled, 5 extended, 10 deferred (39 rows).
Asserted against the table itself by `src/testkit/dossiers.test.ts`.

## Downstream owed

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
  `double_faults`, `violations`), so tennis leaderboards stop reporting
  `requires_detailed_scoring`. W6 can derive first-serve-free serving stats from
  `aces` / `double_faults` over `service_points`.
- **Two substantive unmet facts** need product decisions before schema work: a
  game penalty has no representation, and medical timeouts need a clock the
  engine does not have.
