# Prompt 07: Integration tests — parity, production-board regression, fallback path

**Context**: `docs/superpowers/specs/2026-08-07-cpsat-scheduler-design.md`,
section "Testing strategy" — the parity test is the actual correctness
gate ("not Python agreeing with itself, but TS and Python agreeing on
what's legal"), modeled directly on `build-encode-parity.test.ts`'s own
precedent of proving two placers agree.

**Acceptance criteria**: a real running CP-SAT service, called through
the real TS client, produces a board that (a) matches the investigation's
proven production-board result, and (b) passes the real
`validateAssignments` with zero conflicts — not a mock, not a
reimplemented checker.

**Do not touch**: anything in `services/cp-sat/src` or
`packages/engine/src/scheduling/build.ts` — this prompt only adds
tests against what Prompts 01-06b already built.

**Files:**
- Create: `packages/engine/src/scheduling/__tests__/cpsat-integration.test.ts`
- Create: `services/cp-sat/README.md` section "local dev"

**Interfaces:**
- Consumes: a real running CP-SAT service on `localhost` (started per the README recipe), `build.ts`'s `buildSchedule`.

- [ ] **Step 1: Write the local-dev recipe in the README**

```markdown
## Local dev (for integration tests)

    cd services/cp-sat
    venv/bin/pip install -e ".[dev]"
    CPSAT_SERVICE_SECRET=dev-secret CPSAT_PORT=50051 venv/bin/python3 -m cp_sat.main

In another terminal: `CPSAT_SERVICE_HOST=localhost:50051 CPSAT_SERVICE_SECRET=dev-secret npm run test:integration --workspace packages/engine`
```

- [ ] **Step 2: Write the failing integration tests**

```typescript
// packages/engine/src/scheduling/__tests__/cpsat-integration.test.ts
import { describe, expect, it } from "vitest";
import { buildSchedule } from "../build.ts";
import { validateAssignments } from "../calendar.ts";

const RUN_INTEGRATION = process.env.CPSAT_SERVICE_HOST !== undefined;

describe.skipIf(!RUN_INTEGRATION)("cp-sat integration (requires a running service)", () => {
  it("solves the production board to OPTIMAL with zero verifier conflicts", async () => {
    const input = productionShapeBuildInput(); // 37 fixtures, 5 courts, 30/10 match/gap — same shape as the investigation
    const result = await buildSchedule(input);
    expect(result.engine).toBe("cp-sat");
    expect(result.status).toBe("ok");
    expect(result.assignments.length).toBeGreaterThanOrEqual(35);
    const conflicts = validateAssignments(result.assignments, input.config, input.existing ?? [], input.dependencies ?? []);
    expect(conflicts).toHaveLength(0);
  });

  it("falls back to greedy with the service unreachable", async () => {
    const input = productionShapeBuildInput();
    const result = await buildSchedule({ ...input }, { cpsatHost: "localhost:1" });
    expect(result.engine).toBe("greedy");
    expect(result.status).toBe("solver_unavailable");
  });
});
```

- [ ] **Step 3: Confirm default-skip behavior, then run for real**

Run without the service: `cd packages/engine && npx vitest run src/scheduling/__tests__/cpsat-integration.test.ts`
Expected: SKIPPED (no `CPSAT_SERVICE_HOST` set) — this is correct, not a
failure; the suite must never silently run against a missing service.

Start the service per the README, then run:
`cd packages/engine && CPSAT_SERVICE_HOST=localhost:50051 CPSAT_SERVICE_SECRET=dev-secret npx vitest run src/scheduling/__tests__/cpsat-integration.test.ts`
Expected: PASS if Prompts 01-06b are all correctly wired; if either test
fails, that's a real defect in an earlier prompt, not this one — trace
it back rather than adjusting the assertion to match whatever the code
currently does.

- [ ] **Step 4: Commit**

```bash
git add packages/engine/src/scheduling/__tests__/cpsat-integration.test.ts services/cp-sat/README.md
git commit -m "test(engine): cp-sat integration suite — production-board parity + fallback path"
```

**Verify**: with the service running, both tests PASS. Without it, both are SKIPPED, not silently absent from the run — confirm the skip is visible in the reporter output, not just an empty describe block.

**Output cap**: final message under 15 lines — pass/skip counts in both configurations, conflict count from `validateAssignments` on the happy path (must be exactly 0).
