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
| Substitution, with the in/out player numbers | indoor | persons `in` / `out` | `Ev.Sub.in`, `Ev.Sub.out` → `State.subs.log[]` | extended | new `volleyball.sub` event; both person fields optional. |
| Substitutions used, per side and per set | indoor | entrant | `State.subs.{home,away}`, `State.subs.thisSet` | extended | `thisSet` resets when a set closes — indoor's allowance is six a **set**. |
| Sanction: warning / penalty / expulsion / disqualification | all | entrant + optional person | `Ev.Sanction.level`, `Ev.Sanction.person` → `State.sanctions[]` | extended | new `volleyball.sanction` event; the FIVB ladder is the kernel's enum verbatim. |
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

**Row counts:** 15 modelled, 7 extended, 7 deferred (29 rows).
Asserted against the table itself by `src/testkit/dossiers.test.ts`.

## Downstream owed

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
