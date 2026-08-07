# Prompt 06: Wire `solveBuild` in `build.ts` to call CP-SAT instead of z3

**Context**: `docs/superpowers/specs/2026-08-07-cpsat-scheduler-design.md`,
section "Service boundary — only the solve step moves" — verification
NEVER moves. `validateAssignments` runs once, generically, over
whichever engine's board it's handed (`build.ts:705`) — this is the
direct fix for the placer/verifier-fork bug class on record in this
repo's engine history. This prompt adds a third placer (CP-SAT) beside
greedy and z3; it must not touch how the board gets verified.

**Acceptance criteria**: `buildSchedule`'s exported signature is
unchanged (`BuildInput -> Promise<BuildResult>`) — no caller in
`schedule.ts` needs to change. A successful CP-SAT solve produces
`engine: "cp-sat"` and a verified (zero-conflict) board. A CP-SAT
failure/timeout falls back to the existing greedy path — reuse it,
don't build a second fallback mechanism.

**Do not touch**: `validateAssignments` itself, or anything in
`calendar.ts`. Do not remove `build-encode.ts`/z3 code yet — that's
Prompt 10, gated on this whole programme running green in production
first.

**Files:**
- Modify: `packages/engine/src/scheduling/build.ts` (the `solveBuild` function, line ~1069 — **read it in full first**, this prompt changes its internals, not its exported shape)
- Test: `packages/engine/src/scheduling/build.test.ts` (existing file — add cases, do not remove existing greedy-path coverage)

**Interfaces:**
- Consumes: `cpsat-client.ts`'s `solveBuild` (Prompt 05).
- Produces: `buildSchedule(input: BuildInput): Promise<BuildResult>` — signature unchanged.

- [ ] **Step 1: Read the current implementation**

Read `packages/engine/src/scheduling/build.ts` lines 1013-1600 in full
(`buildSchedule` and `solveBuild`) before changing anything. Identify
exactly where z3 gets loaded (`loadZ3`/`withZ3Lock`), where the tier
walk happens, and where `BuildResult` gets assembled — this prompt
replaces the z3-specific middle section only; the R18 gate check,
greedy seed, and final `validateAssignments` call before returning must
be preserved unchanged.

- [ ] **Step 2: Write the failing test**

```typescript
// packages/engine/src/scheduling/build.test.ts (additions)
import { vi } from "vitest";

describe("buildSchedule — CP-SAT path", () => {
  it("uses the CP-SAT client and returns a verified board", async () => {
    vi.spyOn(await import("./cpsat-client.ts"), "solveBuild").mockResolvedValue({
      assignments: [{ fixtureId: "f1", court: "Court 1", startAtMs: 0 }],
      status: "OPTIMAL", tiersCompleted: 4,
      objectiveValues: [], elapsedMs: 1200, wallExhausted: false,
    });
    const result = await buildSchedule(minimalBuildInput());
    expect(result.engine).toBe("cp-sat");
    expect(result.assignments).toHaveLength(1);
    expect(result.conflicts).toHaveLength(0); // validateAssignments still ran
  });

  it("falls back to greedy on CP-SAT timeout, exactly like a z3 gate-reject", async () => {
    vi.spyOn(await import("./cpsat-client.ts"), "solveBuild").mockRejectedValue(new Error("cp-sat solveBuild exceeded deadline"));
    const result = await buildSchedule(minimalBuildInput());
    expect(result.engine).toBe("greedy");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/engine && npx vitest run src/scheduling/build.test.ts -t "CP-SAT path"`
Expected: FAIL — `result.engine` is still `"z3"`/`"greedy"` via the old code path, `"cp-sat"` never appears.

- [ ] **Step 4: Replace the z3 middle section of `solveBuild` with a CP-SAT call**

Within `solveBuild`, replace the `loadZ3`/`encodeBuild`/tier-walk/LNS
block with: build a `SolveBuildInput` from the function's existing
`grid`/`fixtures`/`config`/`existing`/`dependencies` locals (already
computed earlier in the function, unchanged), call
`cpsatClient.solveBuild(...)` with `wallSeconds` from the existing
`wallMs` budget math, and on success map its
`assignments`/`tiersCompleted`/`elapsedMs`/`wallExhausted` into the same
local variables the rest of the function already expects before falling
through to the existing `validateAssignments` call. On rejection (any
error, including deadline-exceeded), fall through to the existing
greedy-seed path exactly as today's z3-unavailable/gate-reject branches
already do — reuse it, don't add a new fallback mechanism. Set
`engine: "cp-sat"` (new literal, add it to `BuildResult["engine"]`'s
type union alongside the existing `"greedy"`/`"z3"`/`"z3+lns"` — do not
remove the old values yet, Prompt 10 does that).

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/engine && npx vitest run src/scheduling/build.test.ts`
Expected: PASS — new tests green, all pre-existing tests in this file
still green (confirms the exported signature and greedy fallback truly
didn't change shape).

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/scheduling/build.ts packages/engine/src/scheduling/build.test.ts
git commit -m "feat(engine): wire BUILD/POLISH's solveBuild to the cp-sat service"
```

**Verify**: `cd packages/engine && npx vitest run --reporter=json --outputFile=/tmp/gate.json src/scheduling/build.test.ts` then read `numFailedTests`/`numPassedTests` from the JSON directly — do not trust a wrapper summary (this repo's own `rtk` vitest summary can report `PASS(0) FAIL(0)` on a suite that failed to collect).

**Output cap**: final message under 15 lines — raw pass/fail counts from the JSON file, confirm no pre-existing test broke, confirm `result.conflicts` is empty on the happy path (proof verification still ran).
