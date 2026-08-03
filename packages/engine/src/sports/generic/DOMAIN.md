# Generic — domain audit

**Module** `generic@1.0.0` (`generic.ts`). The fallback module for any sport we
do not model. No `entrantModel` is declared, so every entrant kind is legal;
official label **Scorer**.

**Declared variants:** `win_loss` (record who won; draws off) and `score`
(record two numbers; draws on). Both are *complete* configs, not partial
presets — they are synced into `sport_variants` and served as `default_config`.

**There are no governing laws to audit against**, because there is no sport.
The audit question is therefore different from every other module in this wave:
*what is the minimum a scorer of an arbitrary sport must be able to record, and
where does the fallback stop?* This dossier answers both, and the
[boundary](#the-boundary) is the deliverable that matters — later waves should
stop rediscovering it.

Audited against: the v1 result card this module reproduces (PROMPT-15 cutover),
and the shape of a generic scoring pad — what a volunteer with a phone at an
unmodelled fixture actually needs to press.

Schema-path prefixes: `Ev.` = event payload branch, `Cfg.` = config,
`State.` = folded state, `summary.` = the `ScoreSummary` a UI renders.

## What the gap actually was

Before this wave the module had exactly one event: a **terminal result card**.
A scorer of an unmodelled sport therefore had *nothing to press until the match
ended* — no live score, no way to record who scored, and if they wanted a
running tally they had to keep it on paper and type the final numbers in. A
scoring pad built on this schema could only ever show an empty screen and a
"record result" button.

The smallest additive fix is one event — `generic.score`, a single scoring
action — folded into a running tally that the terminal card can settle from.
That is the entire extension. Everything else is deferred *by design*, not for
lack of time.

## Mapping table

| fact | variants | who/what participates | schema path | status | note |
| --- | --- | --- | --- | --- | --- |
| Final result: who won | `win_loss` | entrant | `Ev.GenericResult.winnerId` | modelled | v1 parity |
| Final result: a draw | both (needs `Cfg.allowDraws`) | entrant | `Ev.GenericResult.isDraw`, or level scores | modelled | refused when draws are off |
| Final result: two scores | `score` | entrant | `Ev.GenericResult.{p1Score,p2Score}` | modelled | winner derived; contradictions between `winnerId`, `isDraw` and the scores are refused |
| A running score during play | all | entrant | `Ev.GenericScore.{by,points}` → `State.running` → `summary.headline` | extended | one scoring action per event; the tally renders live and disappears behind the result once decided |
| Correcting a mis-pressed tally | all | entrant | `Ev.GenericScore.points` (negative) | extended | non-zero integers; a correction that would take a side below zero is refused |
| Who performed a scoring action | all | person: `person` | `Ev.GenericScore.person` → `playerStats` (`points`, `scores`) | extended | **deliberate**: an actor exists for a scoring action in nearly every sport, and it is the one person fact that needs no sport-specific structure. See [the boundary](#the-boundary) |
| Settling the fixture from the tally | `score` | entrant | `Ev.GenericResult` `{}` + `State.running` | extended | the pad's natural flow: tally live, then press *final*. The terminal card still decides — the tally alone never ends a fixture |
| Free-text annotation | all | — | `core.note` | modelled | no state effect, by contract |
| Forfeit / walkover | all | entrant | `core.forfeit` → `outcome.award` | modelled | |
| Abandonment / no result | all | entrant | `core.abandon` → `outcome.no_result` | modelled | shared points, no draw counted |
| League points w / d / l | all | entrant | `Cfg.points.{w,d,l}` | modelled | |
| For / against / difference ledger | all | entrant | `metrics.{for,against,diff}` | modelled | now also fed by a tally-settled result |
| v1 stepladder progress-score carry | all | entrant | `Cfg.progressScore` | modelled | stored for the PROMPT-15 cutover; no scoring effect inside the module |
| Period / half / quarter / segment structure | all | entrant | — | deferred | **boundary.** Segments need open/close semantics, and once you own those you own periods, timers and per-period totals — that is a real module. A scorer can put the segment in a `core.note` |
| Turn order, possession, serve, innings | all | entrant | — | deferred | **boundary.** The first step towards a rally/innings kernel; `setbased/` and `nested/` exist for exactly this |
| Match clock, elapsed time, stoppages | all | — | — | deferred | **boundary.** W4a drew the line more precisely than "the engine owns no clock": the engine models **durations** and **elapsed-at-event** (a stamp on something that already happened), and the pad owns the **ticking** — the running clock, the countdown, the stoppages. Generic takes neither half: it has no periods to stamp an elapsed time against |
| Cards, fouls, discipline | all | person | — | deferred | **boundary.** `DisciplineModel` is declared only by card sports; a generic card would have no colour vocabulary and no suspension rules |
| Lineups, substitutions, bench | all | person | — | deferred | **boundary.** The position catalog is a single unnamed slot per side, on purpose |
| Sets / games / frames / legs hierarchy | all | entrant | — | deferred | **boundary.** A nested-scoring grammar is what `setbased/` and `nested/` are |
| Per-person non-scoring stats (saves, rebounds, fouls won) | all | person | — | deferred | **boundary.** Every such metric is sport vocabulary; `points` + `scores` is the sport-neutral maximum |
| Sport-specific validity rules (a legal score, a maximum, a target) | all | entrant | — | deferred | **boundary.** The fallback cannot know them; the only invariants it enforces are internal consistency and a non-negative tally |

**Row counts:** 9 modelled, 4 extended, 8 deferred (21 rows).
Asserted against the table itself by `src/testkit/dossiers.test.ts`.

## The boundary

**Generic will model:** a terminal result card (win/loss, draw, or two scores);
a flat running tally of scoring actions with optional person credit;
corrections to that tally; free-text notes; and the core lifecycle
(start / forfeit / abandon / finalize). That is the complete list.

**Generic will not model:** anything with *structure* — periods or segments,
turn order or possession, clocks, cards or discipline, lineups or
substitutions, nested scoring units (sets, games, frames, innings), or any
per-person metric beyond "scored, and how much". It will also never enforce a
sport's own validity rules, because it cannot know them.

**The rule for later waves:** a request that generic hold structure is a signal
that the sport deserves its own module (or a variant of an existing kernel),
**not** a reason to extend generic. Generic is a floor, not a platform — the
moment it grows a second dimension it becomes an unmaintained second engine
that every real module has to stay compatible with. If an unmodelled sport is
genuinely unscoreable with a tally plus a result card, that is a module
request, and it should be filed as one.

**Person attribution, decided deliberately:** *yes* on the scoring action
(`Ev.GenericScore.person`), *no* everywhere else. Rationale: "somebody did the
thing that changed the score" is true in nearly every sport and needs no
sport-specific vocabulary, so it is safe to offer. Every other person fact
(who was penalised, who assisted, who was substituted) presupposes a structure
generic has just refused to model, so offering a field for it would be a
promise the fold cannot keep. The terminal result stays entrant-only: a result
is a fixture-level fact, and crediting "the winner" to a person is exactly the
kind of half-truth a fallback should not invent.

## Downstream owed

Recorded, not acted on:

1. **New event type `generic.score`** — declared at fidelity tier 1 (tier 0
   stays "one final card, nothing else"). A pad needs a `+1` / `+N` control per
   side, an undo (a negative correction, or `core.void`), and an optional
   player picker. This is the one screen that makes an unmodelled sport
   scoreable live.
2. **`generic.playerStats` now exists** (`points` summed, `scores` counted).
   Any surface that said *requires detailed scoring* for generic divisions can
   render once actions carry a person.
3. **`summary.headline` is now non-trivial before a result.** It used to be
   `— — —` until the terminal card landed; with a tally it reads `3 — 1`. A
   decided fixture still always renders its result (or `W/O` / `N/R`), never
   the tally — that precedence is pinned by a test.
4. **The `points` field name overlaps `Cfg.points`** (league points w/d/l).
   They are different things: the event's `points` is a score increment. Worth
   a clear label in the pad and in any API documentation.
5. **A tally-settled result (`generic.result {}` in score mode)** is a new,
   legal payload shape. Any client that validated "score mode requires both
   scores" client-side should relax that when a tally exists.
