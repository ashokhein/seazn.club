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
| S2 | #430 | `S02-430-fidelity-tier-4-decision.md` | — | **DONE** — no code. Fidelity ladder closed at 0–3; tier 4 will never exist |
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

### The T lane — PARKED, after S13

Fidelity band 3 for the sports that never got one. Ruled shelf-ready in S2/#430:
specced and committed, **nothing runs until a real customer ask**. Design:
`../2026-08-06-fidelity-tier3-extension-design.md`.

| | scope | entitlement | status |
|---|---|---|---|
| T1 | shared machinery — coverage primitive, `derive` returning absent, declared-band state | — | PARKED |
| T2 | period family — hockey, icehockey (shots, saves, save %, faceoffs, circle penetrations) | new key, unnamed | PARKED |
| T3 | setbased + nested — additive fields on the existing `*.rally` / `tennis.point` | `scoring.rally_by_rally` | PARKED |
| T4 | carrom — wire the already-typed `CarromStrike` in | `scoring.strike_by_strike` | PARKED |

T1 first; T2–T4 are independent of each other and pull in any order. Seven of
#430's rows; the excluded set (plus/minus, boardgame PGN, hockey possession)
stays on #430 under a structural rule — *not an independently voidable discrete
fact*. **The fidelity model redesign this lane assumes lands in S6, not here.**

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
- 2026-08-06 — S2 — **powerplay conversion is DEFERRED for want of a
  DENOMINATOR, not for want of a consumer.** Penalty-shot (IIHF) and
  penalty-corner / stroke (FIH) conversion both ship this session, because
  `State.setPieces[side][kind]` already records numerator and denominator.
  Powerplay does not: the numerator is `kindCounts[side].pp`, but the
  denominator is man-advantage OPPORTUNITIES, which is not a count of penalties.
  Coincidental penalties cancel and overlapping ones collapse into a single
  opportunity, so deriving it needs interval arithmetic over
  `startedAt`/`expiresAt` — i.e. STAMPED penalties. Only **3 of 21** hockey
  streams and **2 of 15** icehockey streams carry a stamped `suspension.start`,
  so for the overwhelming majority of recorded fixtures the intervals do not
  exist and any figure would be synthesised. Do NOT approximate it with a raw
  penalty count: that reports 4-on-4 coincidentals as two powerplays and reads
  as data rather than as a guess. Revisit when stamped penalties are the norm.
- 2026-08-06 — S2 — **an optional field folded into a two-counter tally was a
  silent-0 defect one level BELOW the one #429 fixed.** `PeriodSetPiece.outcome`
  is optional, and an attempt the scorer never resolved folded to exactly the
  numbers a recorded MISS folds to — 1 of 9 hockey and 1 of 6 icehockey recorded
  set pieces hit it. So `scored / awarded` was dragged toward zero by missing
  data, invisibly. Fixed ADDITIVELY with a third counter, `resolved`: `outcome`
  stays optional (requiring it is a schema narrowing that would stop every
  already-recorded event without one from parsing), `awarded − resolved` is the
  visible unknown, and a rate is `scored / resolved`. The general lesson is
  worth more than the fix: #429 taught the RANKING layer to tell "no data" from
  a recorded zero, and that is only ever as good as the tallies feeding it.
  Check the fold before trusting the comparator.
- 2026-08-06 — S2 — **`unslimCorpus` must NEVER be used to compare two versions
  of the engine.** It re-folds the stored ledger with CURRENT code, so
  `corpusStateDiff(unslimCorpus(before), unslimCorpus(after))` compares a thing
  with itself: it reported `changedStates: 0` for a change whose real footprint
  was 39 full states and 51 digests across 7 streams. Same failure class as the
  slimming defect it was written to recover from, and unguardable — a wrong `0`
  looks exactly like a right one. Compare the RECORDED BYTES: loop
  `verifyStream` over `readCorpus(key).streams`. Now in the docstring and in
  `GOLDEN-POLICY.md` §2.
- 2026-08-06 — S2 — **`rtk` swallows the `corpusStateDiff` printout, which IS
  clause 2 of the re-baseline policy.** A `REBASELINE_GOLDEN=1` run reports
  `11 passed` and nothing else, so the state diff a reviewer is required to read
  never appears — and the re-baseline looks clean because it looks like nothing
  at all. Reconstruct from the bytes: diff each written corpus against
  `git show HEAD:<path>` per stream, checking `events` / `lineups` / `configs`
  identical and which of `states` / `summary` / `outcome` / `deltas` moved. A
  policy defeated by a wrapper printing a reassuring number is the same failure
  class as the two entries above.
- 2026-08-06 — **label note** — the six entries above stamped `S2` are S1 pass-4
  work (powerplay conversion, the `resolved` set-piece counter, `unslimCorpus`),
  not S2/#430. S2/#430 is the fidelity-tier-4 decision and its entries are
  stamped `S2/#430`. Recorded rather than rewritten so shas keep matching.
- 2026-08-06 — S2/#430 — **the tier fidelity ladder already exists, is already four
  values, and its entitlement seam is already open. Three of the brief's
  premises are false.** Measured against `main`:
  (a) `FidelityTier` at `sport/module.ts:63-67` is `{tier, eventTypes,
  entitlement?}` and `tier` is `z.union([z.literal(0..3)])` — a **numeric 0–3
  fidelity ladder**, comment `:61` "the four-tier granularity ladder". Not the
  `quick|standard|full` triple S6's brief §1 names. `fidelityTiers` is already
  an **array**, ordered by that number — the brief's "is the ordering a list
  rather than a triple" is already answered yes.
  (b) the entitlement hook already exists and is already generic:
  `FidelityTier.entitlement` (`:66`) is an optional FeatureKey, and
  `apps/web/src/server/usecases/fidelity.ts:17-29` `requiredFeatureForEvent`
  derives the gate from the module's own declaration by numeric compare
  (`t.tier < lowest.tier`, free floor `tier <= 1`). A row declaring `tier: 4`
  flows through it **unchanged**.
  (c) #430's "`CarromStrike` … with `apply()` rejecting it" is false in detail,
  and so is the code comment asserting it (`carrom.ts:114-116`). There is **no
  rejecting arm**: `CarromStrike` (`:117-123`) is simply absent from `CarromEv`
  (`:125`), so `eventSchema` 422s `carrom.strike` structurally. Consequence that
  matters: it is not an `eventSchema` union branch, so S6 acceptance (a) "every
  branch reachable from some action" never sees it — the pattern costs
  conformance nothing and needs no exemption list.
- 2026-08-06 — S2/#430 — **cost of the open seam, quantified.** Adding a fifth
  band today is **one line in one file**: `z.literal(4)` at `module.ts:64`.
  Nothing else is code — `fidelity.ts` is numeric, `entitlement-domains.ts:29-37`
  is a data row owed whenever the feature ships, per-sport `fidelityTiers` are
  data rows. Further: **not every deferred row needs a fifth band.** The fidelity ladder's
  cross-sport meaning is the paywall boundary (0/1 free, 2/3 paid), granularity
  is per-sport, and `carrom.ts:707-712` declares only tiers 0/1 with **2/3
  already reserved for strike-by-strike**. Only sports whose tier 3 is already
  spent on attributed timeline (icehockey, football) would need a 4.
  The expensive path is created by S6, not by today's code: if S6 mints a second
  `quick|standard|full` string vocabulary alongside the numeric fidelity ladder, tier 4
  then costs the new member **plus** the mapping between two fidelity ladders, 11
  `padSpec` declarations, S6's hardcoded two-pair nesting assertion, S10's
  renderer and S11's skins. **Ruling asked for: S6 reuses `FidelityTier.tier`
  (0–3) and mints no second vocabulary.** Cost now 0 files; cost of not doing it
  is paid three sessions later.
  Also asked: **leave the union sealed.** An open enum would let a module
  declare tier 7 and silently create a paid band nothing gates — the sealed
  union is the only check that a tier number means something to the paywall.
- 2026-08-06 — S2/#430 — **the plus/minus trap is a fold rule, and it is the
  same defect class this programme has now hit twice**: `metricOf` returning a
  silent 0 at the ranking layer (S1), and optional `PeriodSetPiece.outcome`
  folding to exactly what a recorded miss folds to (S1 pass 4). Plus/minus is
  worse than both — a half-entered on-ice set can flip the **sign**, not just
  shrink the magnitude. Proposed standing invariant, independent of the tier
  verdict: *a derived statistic whose denominator depends on data the scorer may
  omit carries its own coverage counter, and is not emitted at all for a match
  whose coverage is partial.* Enforced at **match** granularity, because S9's
  career rollup summing complete and incomplete matches together is silently
  wrong in a way no per-event check can see.
- 2026-08-06 — S2/#430 — **OWNER RULING (verbatim): "Keep the one, replicate for
  none."** `CarromStrike` stays. It costs conformance nothing — it is not an
  `eventSchema` union branch, so S6 acceptance (a) never sees it and no
  exemption list is needed. The other nine deferred rows get **no typed
  placeholder and no reserved entitlement key**; their reasoning already lives
  in the `DOMAIN.md` dossiers in the sports' own words. S6 corrects the stale
  comment at `carrom.ts:114-116`, which claims `apply()` rejects `carrom.strike`
  — it does not; the type is simply absent from `CarromEv` (`:125`). That stale
  comment is itself the argument against nine more of them.
- 2026-08-06 — S2/#430 — **OWNER RULING (verbatim): "Yes, standing invariant,
  match granularity."** Standing engine invariant, in force now and not
  contingent on any tier-4 verdict: *a derived statistic whose denominator
  depends on data the scorer may omit carries its own coverage counter, and is
  **not emitted at all** for a match whose coverage is partial.* Enforced at
  **match** granularity, because S9's career rollup summing complete and
  incomplete matches together is wrong in a way no per-event check can see.
  Third instance of this defect class in the programme — `metricOf` silent-0 at
  the ranking layer, optional `PeriodSetPiece.outcome` folding to exactly what a
  recorded miss folds to, and now plus/minus, which is worse than both because a
  half-entered on-ice set can flip the **sign**. S6 carries it as a constraint;
  S8 and S9 inherit it.
- 2026-08-06 — S2/#430 — **S6 reuses the numeric fidelity ladder; no second vocabulary.**
  Taken in-session as a routine call, not escalated — the owner's answer was
  that the question was not clear, and it is not a tier-4 question at all. The
  engine already names granularity `0..3` (`module.ts:64`) and the paywall reads
  that number (`fidelity.ts:17-29`). S6's brief §1 would have minted
  `quick|standard|full` as a second name for the same idea, requiring a
  permanent translation table whose drift means a free org pressing a paid
  button or a paying org locked out of one. `padSpec` tiers ARE
  `FidelityTier.tier`; the nesting assertion iterates adjacent members of the
  declared array rather than asserting two hardcoded pairs. Reversible in S6's
  diff if the owner disagrees on sight.
- 2026-08-06 — S2/#430 — **THE FIFTH FALSE PREMISE, and it dissolves the whole
  question: tier 3 is not spent, it is an EMPTY DUPLICATE of tier 2 in 7 of 8
  module files.** Measured on `main` @ `6eaea4fa`:
  `football.ts:2372…` declares tier 2 and tier 3 with byte-identical
  `eventTypes` and the same `scoring.match_timeline`; `setbased/kernel.ts:912`,
  `nested/kernel.ts:1202` and `period/kernel.ts:1310` each declare 2 and 3 as
  the same array with the same entitlement; `carrom.ts:709`, `generic.ts:362`
  and `boardgame.ts:503` stop at tier 1 entirely. **Cricket alone is a real
  four-band fidelity ladder** — `cricket.ts:2392-2401`, tier 2 `cricket.player.line` →
  `stats.player`, tier 3 `cricket.ball`/`cricket.retire` →
  `scoring.ball_by_ball`. So #430's "tier 3 tops out at attributed timeline
  scoring" is true only because tier 3 was left as a copy; tier 3 is not full,
  it is unoccupied.
  Consequence: **we already shipped the "statistician terminal" — for cricket.**
  Ball-by-ball is ~250 deliveries a match with runs, extras, wicket type and
  fielder attribution, entered by a dedicated scorer sitting through the
  innings. Same operator profile, same data volume and the same paid band as an
  ice-hockey shot stream. `apps/web/src/components/v2/pads/cricket-pad.tsx` is
  23.8K, the largest pad in the repo, and the hash-chained `score_events`
  substrate carries that volume today. Tier 4 was never a second product; it was
  an unbuilt tier 3 in every sport but the one that built it.
- 2026-08-06 — S2/#430 — **RULING (delegated to the session by the owner: "for
  fidelity ladder close you can decide"): the fidelity ladder CLOSES at 0–3. There will be no
  `z.literal(4)`.** `sport/module.ts:64` stays sealed exactly as it stands —
  **zero lines change, now or later.** The deferred rows are re-classified, not
  deferred to a fifth band:
  - **8 of 10 are tier-3 work**, landed by SPLITTING each kernel's duplicated
    2/3 — tier 2 keeps the attributed timeline, tier 3 becomes the per-event
    stream. That is exactly cricket's shape, so it is a proven pattern rather
    than a new one. Rows: shots/saves/faceoffs (icehockey), circle penetrations
    (hockey), attack-block-dig (volleyball), 1st-vs-2nd serve + rally length
    (tennis/badminton/tabletennis), strike-by-strike (carrom/generic).
    Effort, **after S10 ships**, per kernel FAMILY not per sport (`period`
    covers hockey+icehockey, `setbased` covers volleyball+badminton+tabletennis):
    new event type = 5 edits (envelope, payload union, `apply`, `eventSchema`,
    generator) + fold counters + the tier split + `DOMAIN.md` +
    `EXTEND_GOLDEN=1`; one entitlement key across `entitlement-domains.ts` and
    `feature-copy.ts` + plan map (data rows); a `padSpec` block — which is the
    entire point of S6/S10/S11, after which a fidelity band is a DECLARATION,
    not a hand-written pad; 4 locales. **≈4 sessions covers all eight**, each
    about the size of a W4 dossier.
  - **2 of 10 are genuinely different** and are NOT tiers. (i) plus/minus + the
    on-ice set is a continuous LINEUP-STATE problem, not an event problem — you
    cannot type 12 ids per goal, you track every line change (~60–80 more events
    a match) and reconstruct the on-ice set at each goal. New state machine in
    the period kernel plus an undesigned pad affordance; the coverage invariant
    ruled above bites hardest here. Own wave if ever. (ii) boardgame PGN needs
    the blob decision — `score_events` is hash-chained per event and movetext is
    one growing opaque string — and validating SAN is writing a chess engine.
  #430 stays open as the record for those two rows; **no new issue**.
- 2026-08-06 — S2/#430 — **the duplicate 2/3 is NOT a billing bug** — checked
  before asserting it. `requiredFeatureForEvent` (`fidelity.ts:22-28`) takes the
  LOWEST tier accepting a type, so a duplicated pair gates identically either
  way. Whether the fidelity picker presents a dead choice to the user is
  UNVERIFIED; S6 checks it when it declares `padSpec`.
- 2026-08-06 — S2/#430 — **there is NO spec and NO prompt for the tier-3
  extension, and the fidelity ladder itself has no written spec at all.** Three findings:
  (a) no prompt file exists for it — `carrom/DOMAIN.md:48` says "The fine tier is
  its own prompt", and that prompt was never written. The S1–S13 / L1–L3
  programme does not contain it: S6 is the contract, S8 is player stats, S10/S11
  are renderer and skins — **none of them add an event type**, which is what
  every tier-3 row needs.
  (b) **"doc 14" does not exist.** The engine cites it as the fidelity ladder's
  specification in three places — `sport/module.ts:61-62` ("doc 14 §1–2"),
  `fidelity.ts:1` ("doc 14 §4, doc 10 §2 rule 2"), `carrom.ts:113-116` ("doc
  10") — and there is no such file anywhere under `docs/`. The fidelity ladder's only
  specification is the code. That is precisely how "tier 3 tops out at
  attributed timeline scoring" went unchallenged into eight DOMAIN dossiers.
  (c) the **design of record was the SOURCE of the `quick|standard|full` error**,
  not S6's brief — `2026-08-03-scoringpad-v2-design.md:195-197`, and its
  conformance clause (d) at `:203`. Fixing S6's prompt alone was insufficient
  because S6 is instructed to read that design. Both corrected in place this
  session, marked SUPERSEDED with a pointer here rather than deleted.
  What DOES exist as the record: the ten refusal rows in the sports' own
  `DOMAIN.md` dossiers (the real content), #430's body, and this log.
- 2026-08-06 — S2/#430 — **terminology: never write a bare "ladder" in this
  programme.** The word carries FIVE unrelated meanings in this repo and one of
  them is an exact enum value: (1) `ladder` is a literal `StageKind` — a
  competition format (`design.md:47-48`, `americano`/`ladder`/`page_playoff`,
  and `api/v1/stages/[id]/challenges/route.ts`); (2) `stepladder` is a bracket
  kind (`BRACKET_KINDS`, `.../[divisionSlug]/page.tsx:51`); (3) the Stripe
  **pricing** ladder — graduated price *tiers*, ~26 uses across
  `stripe-sync.test.ts` and `pricing/page.tsx`, and it says "tier" too, so "tier
  ladder" in this repo usually means BILLING; (4) the IIHF discipline
  escalation ladder (`S06-416-w5-padspec.md:98`); (5) the fidelity tier scale,
  which is the only one this programme means. Always write **"fidelity ladder"**
  or just **"fidelity tiers (0–3)"**. Every occurrence S2 authored across
  `_INDEX.md`, `S06-416-w5-padspec.md` and `2026-08-03-scoringpad-v2-design.md`
  was qualified this session; the bare ones that remain in those files are
  pre-existing and mean (1) or (4).
- 2026-08-06 — S2/#430 — **SIXTH false premise, and it lands ON S6: the tier
  model is internally inconsistent, and S6's conformance criterion (d) "tiers
  nest" WOULD FAIL on cricket today.** `fidelityTiers[].eventTypes` carries two
  incompatible mental models. Football and all three kernels treat it as
  **cumulative bands** — football t2 repeats every t1 type and adds card/sub/
  penalty/sinbin. Cricket treats it as a **per-event lookup** — t1 is the
  innings context, t2 is `["cricket.player.line"]` ALONE, t3 is
  `["cricket.ball","cricket.superover.ball","cricket.retire"]`. So cricket's
  tiers **do not nest**: t1 ⊄ t2. It works only because `requiredFeatureForEvent`
  takes lowest-tier-wins. The one sport that got the ladder right is the one an
  "assert the tiers nest" gate would red.
  Root cause is the same absence that produced the duplicate 2/3: **what a tier
  MEANS is declared nowhere.** "doc 14" is cited three times in engine comments
  and does not exist in the repo, so each sport author invented a reading.
- 2026-08-06 — S2/#430 — **OWNER RULING: redesign the fidelity model, in S6.**
  Declared semantics cross-sport + one band per event type, replacing the
  cumulative `eventTypes` lists:
  ```ts
  export const FIDELITY = { 0:"result", 1:"card", 2:"timeline", 3:"detail" } as const;
  // per module: one band per event type, no repetition
  fidelity: { "cricket.innings.summary":0, "cricket.toss":1,
              "cricket.player.line":2, "cricket.ball":3 },
  fidelityEntitlements: { 2:"stats.player", 3:"scoring.ball_by_ball" },
  ```
  What it buys: (a) **nesting becomes structural** — a tier-N scorer emits every
  band ≤ N by construction, so criterion (d) stops being a test that can fail
  and becomes a property that cannot; (b) **"no tier 3" is the absence of a
  band-3 event**, not a duplicate row — the bug that started S2 becomes
  unrepresentable; (c) the hardcoded free floor `tier <= 1` (`fidelity.ts:27`)
  becomes "bands 0 and 1 declare no entitlement"; (d) the ladder's meaning is
  written down in the one place that cannot drift from the code — the missing
  doc 14, as code.
  **Lands in S6** because S6 seals the tier model into `PadSpec`; doing it later
  means S6/S8/S10/S11 build on the broken model and get rewritten. Blast radius
  is 11 modules + `SportInfo` (`fixture-console.tsx:140`) +
  `requiredFeatureForEvent` + `testkit/golden.ts:282` +
  `conformance/discipline.test.ts:28`. Mechanical; no prod data; modules stay
  `1.0.0`. Grows S6 by roughly a third.
- _(append below)_

## Open questions for the owner

- _(none — append as they arise; ask in-session, never file an issue)_
