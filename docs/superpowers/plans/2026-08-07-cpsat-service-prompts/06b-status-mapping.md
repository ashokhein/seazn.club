# Prompt 06b: Status vocabulary translation

**Context**: `docs/superpowers/specs/2026-08-07-cpsat-scheduler-design.md`,
section "Status vocabulary translation — owned by TS, not the contract"
and section "UI / wire-surface impact" — the visible copy is ALREADY
engine-neutral (checked all 4 locale dictionaries: `board.result.engine.z3`
renders as "Solver"/"Solveur"/"Solucionador", never literally "z3"), so
this prompt adds one new engine label and one new status case, it does
not rewrite existing user-facing copy.

**Acceptance criteria**: CP-SAT's native status
(`OPTIMAL/FEASIBLE/INFEASIBLE/UNKNOWN/ERROR`) maps to a `BuildStatus`
value per the table below, concretely resolving what the design doc
left open. The new `"cp-sat"` engine label renders the same neutral
"Solver" copy the existing `"z3"` label already uses, in all 4 locales.

**Do not touch**: the existing `z3`/`z3+lns`/`z3_unavailable` values —
additive only, they're removed in Prompt 10, not renamed here.

**Files:**
- Modify: `packages/engine/src/scheduling/build.ts` (status mapping, adjacent to Prompt 06's change), `apps/web/src/components/v2/board/result-strip.tsx`, `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`
- Test: `packages/engine/src/scheduling/build.test.ts`, `apps/web/src/components/v2/board/__tests__/result-strip.test.tsx` (additions to both)

**Interfaces:**
- Consumes: CP-SAT's native status from `cpsat-client.ts` (Prompt 05).
- Produces: the existing `BuildStatus` union (`build.ts:387`) gets one new value, `"solver_unavailable"`.

Mapping decided (do not re-derive): `UNKNOWN` → `not_searched` (both
mean "nothing proven, don't claim otherwise" — closest semantic match).
`ERROR` → new `"solver_unavailable"` (not reusing `z3_unavailable` —
that string is invisible to users per the design doc's finding, but the
identifier itself is misleading once z3 is gone; cheaper to add one
clean value now than carry a stale name forward). `INFEASIBLE` →
`infeasible` (same semantics, a real proof). `OPTIMAL`/`FEASIBLE` → `ok`
or `already_optimal` per the existing rule already in `build.ts`
(unchanged logic, just fed by CP-SAT's numbers now).

- [ ] **Step 1: Write the failing test**

```typescript
describe("CP-SAT status -> BuildStatus mapping", () => {
  it.each([
    ["UNKNOWN", "not_searched"],
    ["ERROR", "solver_unavailable"],
    ["INFEASIBLE", "infeasible"],
  ] as const)("%s maps to %s", async (cpsatStatus, expected) => {
    vi.spyOn(await import("./cpsat-client.ts"), "solveBuild").mockResolvedValue({
      assignments: [], status: cpsatStatus, tiersCompleted: 0, objectiveValues: [], elapsedMs: 100, wallExhausted: false,
    });
    const result = await buildSchedule(minimalBuildInput());
    expect(result.status).toBe(expected);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/engine && npx vitest run src/scheduling/build.test.ts -t "status -> BuildStatus"`
Expected: FAIL — `solver_unavailable` doesn't exist on the type yet, mapping not implemented.

- [ ] **Step 3: Add `"solver_unavailable"` to `BuildStatus` and implement the mapping**

Add the new literal to the `BuildStatus` union at `build.ts:387`
(additive — do not remove `z3_unavailable`, it may still be referenced
by REFLOW's own status handling until that's a separate, later
decision). Implement the switch mapping CP-SAT's status into the
function's existing status-assignment point.

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/engine && npx vitest run src/scheduling/build.test.ts`
Expected: PASS.

- [ ] **Step 5: Update the UI's `statusKey()` switch and add the engine label**

Modify `apps/web/src/components/v2/board/result-strip.tsx`'s
`statusKey()` (line ~42) to add `case "solver_unavailable"` returning
the **existing** i18n key `"board.result.unavailable"` (the current
z3_unavailable copy — "does not promise a retry will help" — is equally
true for a CP-SAT outage; same key, new case, no new string needed
here). Add `"cp-sat": "board.result.engine.cpsat"` to `ENGINE_KEY`
(line 33) — this **is** a new string; add the key to all 4 dictionaries
(`apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`) with the same
copy the existing `z3` key already uses in each locale ("Solver" /
"Solveur" / "Solucionador" / NL equivalent).

- [ ] **Step 6: Write and run a UI test**

```typescript
// apps/web/src/components/v2/board/__tests__/result-strip.test.tsx (addition)
it("cp-sat engine renders the same neutral 'Solver' copy as z3 did", () => {
  const html = render(metrics(), solver({ engine: "cp-sat", status: "ok" }));
  expect(html).toContain("Solver");
});
```

Run: `cd apps/web && npx vitest run src/components/v2/board/__tests__/result-strip.test.tsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/engine/src/scheduling/build.ts apps/web/src/components/v2/board/result-strip.tsx apps/web/src/dictionaries apps/web/src/components/v2/board/__tests__/result-strip.test.tsx
git commit -m "feat: translate cp-sat's native status vocabulary into BuildStatus, add cp-sat engine label"
```

**Verify**: `cd packages/engine && npx vitest run src/scheduling/build.test.ts` AND `cd apps/web && npx vitest run src/components/v2/board/__tests__/result-strip.test.tsx` → both suites fully green. Also run this repo's i18n drift gate: `npm run i18n:gen-keys && git status --porcelain` must be empty after — a key added to one locale and not another is exactly what this gate exists to catch.

**Output cap**: final message under 15 lines — pass counts for both suites, confirm i18n drift gate is clean, confirm all 4 locales have the new key.
