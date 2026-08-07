# Prompt 10: Remove BUILD/POLISH's z3 code

**BLOCKED — do not start until Prompts 01-09 are merged AND running in
production for at least one full deploy cycle with no fallback-to-greedy
rate regression.** This is the "straight cutover, greenfield" decision
from the design doc (resolved open item 12) — no feature flag, no
dual-run period, but also not a same-day step after Prompt 09 merges.
If you were dispatched this prompt and Prompts 01-09 only just merged
minutes ago, stop and escalate rather than proceeding — this is exactly
the kind of blast-radius-widening judgment call this programme's
standing rules ask you to check on rather than push through.

**Context**: `docs/superpowers/specs/2026-08-07-cpsat-scheduler-design.md`,
section "z3 removal scope" — **BUILD/POLISH only**. `schedule.ts:889-890`
confirms REFLOW goes to a completely separate z3 encoding (`repair.ts`)
that this prompt must not touch. `z3-load.ts` (the shared WASM loader)
stays regardless — REFLOW still needs it until its own, separate
cutover is decided.

**Acceptance criteria**: `build-encode.ts` and `build-lns.ts` are
deleted, the R18 gate is removed from `build.ts`, and the full engine
test suite is green with raw JSON counts confirming `numFailedTests: 0`
— not a wrapper summary.

**Do not touch**: `packages/engine/src/scheduling/repair.ts`,
`repair-domain.ts`, `repair-decompose.ts`, `repair-minimality.ts`,
`repair-synthetic-board.ts`, or `z3-load.ts` itself. Grepping for
`loadZ3`/`withZ3Lock` after this prompt will still find real hits in
those files — that is correct and expected, not a sign this prompt is
incomplete.

**Files:**
- Delete: `packages/engine/src/scheduling/build-encode.ts`, `packages/engine/src/scheduling/build-lns.ts`
- Delete: `packages/engine/src/scheduling/build-encode-parity.test.ts` (see Step 3 for why)
- Modify: `packages/engine/src/scheduling/build.ts` (remove the R18 `canSolveWithin`/`MAX_SOLVE_ENCODING` gate and any now-dead z3-import lines)

- [ ] **Step 1: Confirm no remaining references, scoped correctly**

Run: `git grep -n "build-encode\|withZ3Lock\|loadZ3" packages/engine/src/scheduling/build.ts`

Review every hit in `build.ts` specifically — anything still there
after Prompt 06 should only be Prompt 06's leftover z3-import lines,
not live logic (Prompt 06 already replaced the actual solve call). Do
**not** run this grep repo-wide and treat REFLOW's hits in
`repair.ts`/`z3-load.ts` as something to clean up — they are correct
and out of scope.

- [ ] **Step 2: Delete the files and dead code**

Delete `build-encode.ts` and `build-lns.ts`. Remove the R18 gate and its
`MAX_SOLVE_ENCODING` constant from `build.ts`. Remove `z3-solver` type
imports (`Solver`, `Bool`, `Arith`) from `build.ts` if nothing else in
the file uses them after the deletion.

- [ ] **Step 3: Delete `build-encode-parity.test.ts`**

This test's entire purpose was proving two z3 encodings (build-encode's
and build.ts's own) agree with each other — there is only one placer
left in the BUILD/POLISH path now (CP-SAT), and Prompt 07's parity test
against the real `validateAssignments` is the replacement. Deleting
this file is correct, not a coverage loss: Prompt 07's test covers more
ground (TS-vs-Python agreement, not TS-vs-TS agreement).

- [ ] **Step 4: Run the full engine test suite**

Run: `cd packages/engine && npx vitest run --reporter=json --outputFile=/tmp/gate.json`

Read `/tmp/gate.json`'s `numFailedTests`/`numTotalTests`/`numPassedTests`
directly. Expected: `numFailedTests: 0`. Do not trust any wrapper
summary — this repo's own `rtk` vitest wrapper is on record hiding
suite-collection failures behind a false `PASS(0) FAIL(0)`.

- [ ] **Step 5: Commit**

```bash
git add -A packages/engine/src/scheduling/
git commit -m "refactor(engine): remove z3 tier-solver code now that BUILD/POLISH runs on cp-sat"
```

**Verify**: `/tmp/gate.json` shows `numFailedTests: 0` with the full
suite's real total (not a filtered subset — confirm the total count is
in the same ballpark as this repo's known full-suite size, not
suspiciously small, which would indicate a collection failure rather
than a clean pass).

**Output cap**: final message under 15 lines — raw counts from the JSON file, confirm `repair.ts`/`z3-load.ts` untouched (list their git status as unchanged), confirm the two deleted files and the parity test are gone.
