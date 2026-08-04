# Volleyball — domain audit (W4, #407)

**Module** `volleyball@1.0.0`, built on the shared set-based kernel
(`setbased/kernel.ts`). **Variants:** `indoor` (default — best of 5, sets to 25,
deciding set to 15, win by 2, no cap) and `beach` (best of 3, sets to 21,
deciding set to 15).

**Audited against:** FIVB *Official Volleyball Rules* (rules 6 "to score a
point", 15 "interruptions", 16 "delays", 21 "misconduct"), the FIVB *Official
Beach Volleyball Rules*, and the FIVB **scoresheet** itself — the point-by-point
grid, the substitution boxes, the timeout boxes, the sanction box and the
signature block. The libero control sheet is a separate FIVB document and is
called out as such below.

Read alongside `DOMAIN.badminton.md` and `DOMAIN.tabletennis.md`: all three are
presets of one kernel, so an `extended` row here usually appears there too, and
a row that says the sport does **not** have a fact is enforced by the preset's
`records` flags rather than by silence.

## Mapping table

| fact | variants | who/what participates | schema path | status | note |
| --- | --- | --- | --- | --- | --- |
| A rally is won, scoring a point | all | entrant | `Ev.Rally.wonBy` | modelled | rally scoring; every rally scores. |
| Running score inside a set (the point-by-point grid) | all | entrant | `State.sets[].home` / `.away` | modelled | |
| Completed set score | all | entrant | `Ev.SetSummary.home/away` (or `by/forBy/forOpp`) → `State.sets[]` | modelled | dual fidelity: the same set can arrive as one summary or as its rallies. |
| Set target 25, deciding set 15 | indoor | — | `Cfg.setTo`, `Cfg.finalSetTo` | modelled | |
| Beach targets 21, deciding set 15, best of 3 | beach | — | `Cfg.bestOf`, `Cfg.setTo`, `Cfg.finalSetTo` (variant `beach`) | modelled | |
| Two-point margin with an uncapped endgame (32–30 is legal) | all | — | `Cfg.winBy = 2`, `Cfg.cap = null` | modelled | `reachableSetScore` rejects 25–24 and 33–30. |
| Match won at three sets (two on the beach) | all | entrant | `State.setsWon`, `outcome.kind = "win"` | modelled | |
| FIVB match points 3:0 for a 3–0/3–1, 2:1 for a 3–2 | indoor | entrant | `Cfg.pointsMap`, `standingsDelta` | modelled | beach uses a flat 2:0. |
| Serving player (the grid records the server's number) | all | person `server` | `Ev.Rally.server` → `State.persons[id].serves` | extended | optional `PersonId` on the rally; folds to a per-person serve tally. |
| Player credited with the point (kill / block / ace) | all | person `scorer` | `Ev.Rally.scorer` → `State.persons[id].points` | extended | optional; a rally that names nobody folds exactly as before. |
| Team timeout | all | entrant | `Ev.Timeout.by` → `State.timeouts.{home,away}`, `summary.detail.timeouts` | extended | new `volleyball.timeout` event; never touches the score. |
| Technical timeout (automatic at 8 and 16) | indoor | entrant | `Ev.Timeout.technical` | extended | flag on the same event; beach has none. |
| Substitution, with the in/out player numbers | indoor | persons `off` / `on` | `Ev.Sub.off`, `Ev.Sub.on` → `State.subs.log[]` | extended | new `volleyball.sub` event; both person fields optional. **Deliberately unscored**: the persons are recorded but feed no `playerStats` metric — coming on is not a performance, and the allowance it spends is a per-side count (`State.subs`), not a personal one. Pinned by setbased-audit tests. |
| Substitutions used, per side and per set | indoor | entrant | `State.subs.{home,away}`, `State.subs.thisSet` | extended | `thisSet` resets when a set closes — indoor's allowance is six a **set**. |
| Sanction: warning / penalty / expulsion / disqualification | all | entrant + optional person | `Ev.Sanction.level`, `Ev.Sanction.person`, `Ev.Sanction.reason` → `State.sanctions[]`, `discipline.extractCards` | extended | new `volleyball.sanction` event; the FIVB ladder is the kernel's enum verbatim. W4's review added optional free-text `reason` — the sanction box on the sheet holds one, and an accumulation rule keyed on the offence rather than the ladder step needs it. It reaches `DisciplineCard.reason` only; the fold never reads it, so no recorded state moves. |
| The point a penalty concedes | all | entrant | recorded as a `volleyball.rally` for the opponent | modelled | this is what the scoresheet does: the point goes in the grid, the sanction box holds the reason. |
| Starting line-up and rotational order per set | all | persons | `LineupPair.slots[].orderNo` / `.positionKey` | modelled | lineup layer, not the event stream. |
| Libero registration | indoor | person, role `libero` | `positions.roles[libero]` | modelled | up to two per team, so the role is not unique. |
| Libero replacements | indoor | persons | — | deferred | recorded on the **libero control sheet**, a separate FIVB document, and has no score consequence. Whether a pad tracks it is a product decision. |
| Rotational fault | all | — | — | deferred | a rotational fault is simply a lost rally; the sheet records the point, never the cause. |
| Ball-handling faults, net faults, four hits | all | — | — | deferred | not recorded anywhere on the scoresheet — the referee signals, the scorer writes the point. |
| Court switch (indoor at 8 in the deciding set; beach every 7 points, every 5 in the deciding set) | all | — | — | deferred | fully derivable from the running score; procedural, no scoresheet field. |
| Timeout / substitution allowances (2 timeouts a set, 6 subs a set indoor) | indoor | — | — | deferred | the referees enforce the caps. Making the schema refuse the 7th substitution would make a legitimate late correction unrecordable — a product decision, not a schema gap. |
| Beach volleyball has no substitutions | beach | — | `records.substitutions` | deferred | `records` is a **sport** flag, so the kernel accepts `volleyball.sub` under the `beach` variant too. Gating capabilities per variant needs a product decision (it would also change what an existing beach division may record). |
| Attack / block / dig / reception chains | all | persons | — | deferred | Pro statistics, not scoresheet facts; a separate fidelity tier, not this schema. |
| Forfeit, incomplete or absent team | all | entrant | `core.forfeit` → `outcome.kind = "award"` | modelled | pays the clean-sweep points pair. |
| Match abandoned (venue, power, weather) | all | — | `core.abandon` → `State.replayFlagged` | modelled | leaves the fixture undecided for re-scheduling. |
| Referee / scorer / captain signatures | all | officials | `exportTemplates.scoresheet.signatures` | modelled | the printed sheet already carries the block. |
| Remarks and injury notes | all | — | `core.note` | modelled | free text, no fold effect. |

| Where in the match an event happened (the position axis) | all | — | `SportModule.position(state)` -> `set` + `points` segments, e.g. `Set 5 . 12-10` | extended | W4a T6b. A **read-side projection**, never a payload: a `MatchPosition` on every stamped event was considered this wave and rejected, because position is derivable from state the fold already computes and recording it would create a recorded value and a derived value of the same type that can silently disagree — the `DisciplineCard.entrantSide` shape. A wrong recorded value is in the hash-chained ledger forever; a wrong projection is one deploy away from fixed. Ordered segments rather than a display string, so W8 can drop a segment for a 375px scorebug, localise each `key` and order two positions in one match; `formatPosition` is the plain-text path. Nothing is materialised into state, so every frozen golden is byte-identical. ONE function reference shared with badminton and table tennis. The score comes from the set the number resolved to, which makes all four cases fall out of one expression: love-all before the first rally, the live score during a set, love-all again between sets, and the final score of the deciding set once the match is over. |

**Row counts:** 15 modelled, 8 extended, 7 deferred (30 rows).
Asserted against the table itself by `src/testkit/dossiers.test.ts`.

## Downstream owed

- **Position labels owed in all four locale dictionaries** (W4a T6b): `scoring.position.set`.
  `SportModule.position` returns a stable segment `key` plus an ENGLISH `label`
  fallback — the engine writes no locale copy, by the same rule `MetricSpec.label`
  follows. W8 renders `scoring.position.<key>` and falls back to `label`. The `points` segment carries no label.
  Deliberately NOT written by this task, which touches no dictionary.

- **New event types** `volleyball.timeout`, `volleyball.sanction`,
  `volleyball.sub` reach a scorer at fidelity tiers 2 and 3 under the existing
  `scoring.rally_by_rally` entitlement. No new FeatureKey was introduced; if
  timeline facts should be gated separately from rally scoring, that is a
  product decision for a later wave.
- **New enum** `SetBasedSanctionLevel` = `warning | penalty | expulsion |
  disqualification`. `apps/web/src/lib/scoring-vocab.ts` humanises unknown
  values, so nothing breaks, but a proper label set is owed.
- **New payload fields** `volleyball.rally.server` and `.scorer`. A pad must be
  able to pick them from the on-court six plus the libero.
- **`summary().detail`** now carries `timeouts`, `sanctions` and `subs` when
  they are non-empty. Per-**person** tallies deliberately stay out of `summary`:
  `coarsen` collapses rallies into set summaries and discards attribution, so a
  summary carrying `persons` could never satisfy the §9.6 coarse ≡ fine
  invariant. They live in `State.persons` and in the `playerStats` fold.
- **`playerStats` now exists** (`points`, `serves`, `sanctions`), so volleyball
  leaderboards stop reporting `requires_detailed_scoring`. W6 can build stat
  models on exactly these keys.
- Beach-specific capability gating (no substitutions, no technical timeout) is
  unresolved — see the deferred row above.
