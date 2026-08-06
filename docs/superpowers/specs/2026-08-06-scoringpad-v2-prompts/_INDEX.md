# ScoringPad v2 / #407 — session index

**One wave per session.** Read `_RULES.md`, then this file, then the session's
prompt file. This file is the compaction anchor: every ruling, every false
premise, every status change gets written here **as it happens**.

Programme index issue: #411. Design: `../2026-08-03-scoringpad-v2-design.md`.

## Order

Main chain is sequential. The `L` lane is a disjoint file set — run it whenever,
interleaved or in parallel, but `L2` waits on `L1` (shared `schemas.ts`).

| Session | Issue | Prompt file | Depends on | Status |
|---|---|---|---|---|
| S1 | #429 | `S01-429-golden-corpus-policy.md` | — | **DONE** |
| S2 | #430 | `S02-430-fidelity-tier-4-decision.md` | — | TODO (decision only, no code) |
| S3 | #426 | `S03-426-w4b-mutable-squads.md` | S1 | TODO |
| S4 | #428 | `S04-428-offence-taxonomies.md` | S3 (person-role decision) | TODO |
| S5 | #431 | `S05-431-decisions-register.md` | S3, S4 | TODO |
| S6 | #416 | `S06-416-w5-padspec.md` | S2, S3, S5 | TODO |
| S7 | #427 | `S07-427-pad-vocabulary-i18n.md` | S3, S4, S6 | TODO |
| S8 | #417 | `S08-417-w6-player-stats.md` | S6 | TODO |
| S9 | #418 | `S09-418-w7-career-rollup.md` | S3, S8 | TODO |
| S10 | #419 | `S10-419-w8-chassis-renderer.md` | S6 | TODO |
| S11 | #420 | `S11-420-w9-skins.md` | S7, S10 | TODO |
| S12 | #421 | `S12-421-w10-integration-flag.md` | S11 | TODO |
| S13 | #422 | `S13-422-w11-cutover.md` | S12 | TODO |
| L1 | #412 | `L1-412-w1-eligibility.md` | — | TODO |
| L2 | #413 | `L2-413-w2-date-hardening.md` | L1 | TODO |
| L3 | #414 | `L3-414-w3-formats.md` | — | TODO |

Deferred e2e/smoke debt from the engine-only sessions (S1, S3–S8) is discharged
in **S12** (both entry points, offline) and **S13** (smoke through v2, help tree).
Any session that defers a test type must say so in its PR body.

## Done before this index existed

- **W4 #415** merged 2026-08-03, PR #434, squash `fd452457` — 11 `DOMAIN.md`
  dossiers (8 in `sports/<key>/`, 3 as `setbased/DOMAIN.<sport>.md`), 11 frozen
  golden corpora (`sports/**/**.golden.json`), additive schema extensions,
  person-attribution fields. **No version bumps** — modules stay `1.0.0`.
- **W4a #425** (core time model — durations, elapsed-at-event, expiring
  penalties) merged, PRs #454 + #460, 2026-08-04.

## State of the world, verified against `main` 2026-08-06

Facts the 2026-08-03 prompt file gets wrong. Trust these, not that file.

| Old claim | Truth today |
|---|---|
| W4 #415, W4a #425 open | both closed/merged |
| W2 blocked on #398/#399/#400 | all closed — **W2 unblocked** |
| W1 blocked on #402/#404 | both closed — **W1 unblocked** |
| W2 migration is `V345` | last applied is `V355`; next free is **V356** (re-verify at execution) |
| "`ScheduleConfig.endAt` is never read server-side" | **false** — `applyWindow` (`schedule.ts:608-623`) + derived `horizonMinutes` (`:425-428`) landed with #399. W2 shrinks accordingly |
| minor version bump per touched module | **no bumps** — owner ruling, no prod data, extend at `1.0.0` |
| `padSpec` exists somewhere | absent from `packages/` — W5 is untouched greenfield |
| 11 `DOMAIN.md` files | 8 + 3 `DOMAIN.<sport>.md` inside `setbased/` |
| corpus is "2.2 MB" (#429 body, S1 brief) | **4,507,821 bytes** across 11 files at `6846af19` — roughly double, grown by `EXTEND_GOLDEN` passes since W4. Cricket alone is 1,865,370 (41%) |
| only `UPDATE_GOLDEN=1` and `EXTEND_GOLDEN=1` exist | **false** — `REBASELINE_GOLDEN=1` already existed before S1 (same events, recomputed fold) and already cited #429. S1 enforces it; it did not invent it |
| a re-baseline "is reviewed as a state diff" | not possible by inspection — corpora are **single-line minified JSON**, so `git diff` renders any re-baseline as one replaced line. The harness-emitted summary is the only reviewable artifact |
| the never-re-baseline rule held | **false** — `1f56bd5e` (#468, DLS) shipped `cricket.golden.json` mixed into 7 functional files including `apps/web/e2e` and `scripts/smoke.ts` |

Every line number in any prompt file predates 54 W4 commits. **Scout re-pins
before the implementer touches anything.**

## Rulings carried in (do not re-litigate)

- Pad is rebuilt **greenfield**; supersedes #407 WS2 step 6.
- Programme covers all of #407, "not only the UI layer".
- Stat models **prefer explicit PersonId payload fields**, fall back to
  `personsOf(entrantId)` — hence order W4 → W5 → W6 on the same module files.
- Substrate is complete, do NOT rebuild: hash-chained `score_events`,
  `match_states`, realtime tokens, device links. Legacy V014 `matches` = dead.
- Golden corpora are the only tripwire for schema narrowing — conformance
  generates its own streams and can only ever test the present.
- All 8 #431 singletons were ruled 2026-08-03; S5 executes, it does not re-decide.

## Decision log

Append one line per ruling: date, session, decision, reason. Never delete.

- 2026-08-03 — W4 — no module version bumps; no prod data, extend in place at `1.0.0`.
- 2026-08-03 — W4 — frozen golden corpus lands before any schema work (`55b77714`).
- 2026-08-06 — planning — session order fixed as above; #429 first because five
  correctness rows are deadlocked on the never-re-baseline rule.
- 2026-08-06 — S1 — **"never re-baseline" is replaced by "never re-baseline
  silently."** A re-baseline is legitimate only when deliberate, isolated in its
  own commit, and reviewed as a state diff. Reason: the freeze rule protected
  divisions pinned to a module version, and there is no production data — the
  same ground on which W4 skipped version bumps. Enforced, not documented:
  `UPDATE_GOLDEN=1` and `REBASELINE_GOLDEN=1` both refuse to run unless every
  dirty path is a corpus file the run is about to rewrite, and a re-baseline
  prints a per-stream state-diff summary. Policy home:
  `packages/engine/src/testkit/GOLDEN-POLICY.md` (`6846af19`).
- 2026-08-06 — S1 — the config-subset tolerance in `stateMismatch` is
  **permanent and may not be narrowed**: a zod `.default()` on an additive knob
  shifts the resolved config in every frozen state while changing no fold.
  Recorded so a later session does not "tighten" it as a gap.
- 2026-08-06 — S1 — the brief's premise that a **nested** key named `cfg` was a
  live defect is **false**; the status quo was already green there. It ships as a
  regression guard, mutation-proved. The live defect was the sibling write path
  `keepRecordedConfig`, which was untested and carried both weaknesses.
- 2026-08-06 — S1 — **three of the five "deferred correctness rows" in #429 had
  false premises.** (a) Auto early-release of a minor on a powerplay goal is
  **already implemented** — `period/kernel.ts:745-773` `releaseForGoal`, shipped
  in W4a §3.4, documented at `icehockey/DOMAIN.md:50`; `double_minor` is
  deliberately excluded (`:54`). Nothing to do. (b) `Cfg.overtime.skaters` is
  genuinely dead (zero readers) but lives in the **shared** `sports/period/`
  kernel, not in icehockey — blast radius is the whole period family, so the fix
  must stay cfg-driven. (c) The corpus holds **35** OT-with-penalty states across
  3 icehockey streams (3, 4, 13), not the "two states" the issue body claims.
- 2026-08-06 — S1 — **GWS +1 goal: implement, derived at the score layer.**
  IIHF Rule 87 and NHL Rule 84.4 agree — the shoot-out winner is credited one
  additional goal in the FINAL SCORE (3-3 won on shoot-out is recorded 4-3), so
  winner GF +1, loser GA +1, and it flows into goal difference. The same rules
  say shoot-out attempts produce **no** player goals or goals-against; only the
  deciding scorer gets the game-winning goal. So the +1 is awarded in the
  official-score / `sideMetrics` layer (`period/kernel.ts:1302-1306`) and
  **never** by mutating `state.goals` or minting a goal event — a phantom goal
  with no scorer would corrupt the per-person attribution that S8 and S9 read.
  `icehockey/DOMAIN.md:70` called this a product deferral; no rulebook supports
  the current output, so it was a deferral, not a different semantic.
- 2026-08-06 — S1 — **conversion rate stays unemitted; `metricOf` is fixed.**
  No federation ranks on conversion rate — FIH ranks points → GD → GF →
  head-to-head, IIHF points → head-to-head → GD → GF; PC-conversion and
  penalty-shot conversion are display statistics. Emitting them would move
  eleven corpora and every standings delta for no behavioural gain. The live
  defect underneath is `competition/tiebreakers.ts:239-245` `metricOf`, which
  returns **0 silently** for an absent metric key, so a row predating any metric
  scores a genuine zero rather than "no data" — that blocks every future metric,
  including S8's, and is fixed here. Conversion rate itself is deferred: a later
  session emits it cheaply once a consumer exists.
- 2026-08-06 — S1 — **a deliberate fold change ships as a RED code commit
  followed by its re-baseline commit.** The policy requires the re-baseline to
  be isolated in its own commit, so the commit that changes the fold necessarily
  reds the corpora until the next one lands. That transient red is the designed
  cost of isolation, not an accident: the alternative — one commit carrying both
  — is exactly the mixing the policy exists to prevent, and is what `1f56bd5e`
  did. Reviewers should read the pair, and `git bisect` over an engine fold
  change should expect it.
- 2026-08-06 — S1 — **slimming needed THREE commits, and the order is forced.**
  The equivalence suites compare a slim corpus against a full one and read the
  full one from disk; once the committed corpora are slim, that reads the slim
  corpus twice, compares it with itself and asserts nothing **while staying
  green**. `unslimCorpus` derives the full form by re-folding the stored ledger
  — an identity on a corpus that is already full, so the harness lands and is
  green BEFORE the corpora move; the strict "the committed file IS the canonical
  slim form" assertion is false until they have moved, so it trails them.
  Harness (`ffe1260c`) → corpora (`7beff7d4`) → assertion (`b182dd6d`), each
  green standing alone. Recorded because the obvious two-commit split is
  circular and the discovery cost a full re-baseline cycle.
- 2026-08-06 — S1 — corpus slimming shipped: **4,507,821 → 1,746,013 bytes
  (−61.3%)**, `changedStates=0` and `eventsIdentical=true` on all eleven, and
  `schema:snapshot` reports 0 written / 11 already current — the shape-growth
  anchor clause held, so no committed snapshot moved.
- 2026-08-06 — S1 — **`EXTEND_GOLDEN=1` stays OUTSIDE the clean-tree guard, and
  that is deliberate.** Review flagged it as the one corpus-write path the guard
  does not cover. Not changing it: an extension is run precisely BECAUSE a new
  event type or optional field was just added, so the working tree legitimately
  holds that code change. Requiring a clean tree would make the sanctioned
  additive path unusable, and the pressure would go straight back to
  `UPDATE_GOLDEN=1`, which is the thing being prevented. The guard covers the
  two modes that REWRITE recorded states; extension only appends, and
  `golden.test.ts` asserts every pre-existing stream survives byte for byte.
  Recorded so a later session does not "close the hole" and break coverage work.
- 2026-08-06 — S1 — **`Cfg.overtime.skaters` is DROPPED, not implemented — the
  FOURTH false premise in #429.** The row reads "dead config, wire it up". The
  config is indeed dead, but `strength.{base,min}` has exactly one production
  reader — `strengthChip` at `kernel.ts:1481`, inside `summary()` — so it is a
  display projection, not the fold, and would have redded no corpus in either
  direction. Worse, the obvious fix is actively destructive: icehockey is
  `strength: {base: 5, min: 3}` against `overtime.skaters: 3`, and `strengthOf`
  floors at `min`, so swapping the OT base makes base === min, both sides sit at
  base, and `strengthChip` returns **null** — the powerplay chip disappears.
  Measured on both sports (icehockey 5v4/5v3 → null/null; hockey `fih-detail`
  11v10/11v9 → null/null). `icehockey/DOMAIN.md:64` already said all of this and
  was correct; the brief told an agent to update it as stale.
  The correct shape is side-relative per NHL 84.4 — the NON-offending team gains
  a skater — as `strength(X) = overtime.skaters + max(0, short(opponent) −
  short(X))`, which is the only form that also gets coincidental penalties right
  (one each cancels to 3-on-3; a flat "gain per opponent penalty" gives 4-on-4).
  It must be gated per sport: FIH cards REDUCE the offender and nobody gains, so
  the shared period kernel cannot apply it unconditionally. NOT implemented —
  the owner has not ruled on it, and no corpus can witness it either way (all 36
  period streams end `phase: "done"` and the corpus stores only the final
  state's summary), so it would ship on unit tests alone.
- 2026-08-06 — S1 — **the "35 OT-with-penalty states" figure recorded above is
  WRONG.** Measured over the restored full corpus it is **3**, on streams 3, 4
  and 13. Related readings, so the next reader stops re-deriving them: states
  with an OT phase at all = 6 (streams 3, 4, 12, 13); `asOf` in OT = 3. The
  earlier "two states" in `DOMAIN.md:64` was also wrong. The stream list was
  always right; only the counts were invented. Both wrong numbers are now named
  in the DOMAIN row itself.
- 2026-08-06 — S1 — **the GWS +1 is ice-hockey-only, by design.** Awarding it in
  the shared period kernel would double-count against FIH, which already pays
  for a shoot-out win in points (`hockey.ts:103`, `fih-shootout`
  `shootoutWin: 2` = draw 1 + 1) — the credit would then land in goal
  difference, the FIH cascade's second key. Football records the same convention
  (`4 — 4 (5–3 pens)` at `gd 0`). Gated on `PeriodPreset.shootoutWinnerGoal`,
  omitted meaning off. `hockey/DOMAIN.md:67` records the divergence as
  deliberate so a later session does not "fix" it.
- _(append below)_

## Open questions for the owner

- _(none — append as they arise; ask in-session, never file an issue)_
