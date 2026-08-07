# Prompt 05: Board segmentation matches the backend's real step

**Context**: `docs/superpowers/specs/2026-08-07-datetime-scheduling-ux-design.md`,
decision 2 — the board currently uses a fixed `matchMinutes+gapMinutes`
step, while the backend's own lattice already computes a finer, correct
`gcd(matchMinutes, gapMinutes)` step. The frontend has drifted from the
backend on this; this prompt is the fix, via a genuinely SHARED helper
so the two can't drift apart again.

**Acceptance criteria**: the frontend's row segmentation is computed by
the exact same function the backend calls, verified by a cross-check
test against `buildGrid()`'s real output, not two independent
implementations that happen to agree today.

**Do not touch**: `build-grid.ts`'s other logic — extract only the gcd
computation, re-import it, don't restructure anything else in that
file. Independent of Prompts 02-04 (different files entirely).

**Files:**
- Create: `packages/engine/src/scheduling/grid-step.ts`
- Modify: `apps/web/src/components/v2/schedule-board.tsx:862`, `apps/web/src/lib/schedule-board.ts:101-108`, `apps/web/src/components/v2/board/board-grid.tsx:104`, `packages/engine/src/scheduling/build-grid.ts:100-108`
- Test: `packages/engine/src/scheduling/grid-step.test.ts`, existing `schedule-board-polish.test.tsx`/`schedule-board-day-tab.test.tsx`

**Interfaces:**
- Produces: `gridStepMinutes(matchMinutes: number, gapMinutes: number): number` in `packages/engine` — both `build-grid.ts` and `schedule-board.tsx` import this exact function.

- [ ] **Step 1: Read the reference computation**

Read `packages/engine/src/scheduling/build-grid.ts` lines 100-108 in full before extracting anything.

- [ ] **Step 2: Write the failing test for the extracted helper**

```typescript
// packages/engine/src/scheduling/grid-step.test.ts
import { describe, expect, it } from "vitest";
import { gridStepMinutes } from "./grid-step.ts";

describe("gridStepMinutes", () => {
  it("returns the gcd of match and gap minutes", () => {
    expect(gridStepMinutes(30, 10)).toBe(10);
    expect(gridStepMinutes(40, 10)).toBe(10);
    expect(gridStepMinutes(45, 15)).toBe(15);
  });

  it("returns matchMinutes when gapMinutes is 0", () => {
    expect(gridStepMinutes(30, 0)).toBe(30);
  });

  it("matches build-grid.ts's own lattice step on a real board", () => {
    const grid = buildGrid({ config: { matchMinutes: 30, gapMinutes: 10, courts: ["C1"] } });
    expect(gridStepMinutes(30, 10)).toBe(grid.stepMinutes);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd packages/engine && npx vitest run src/scheduling/grid-step.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 4: Extract `gridStepMinutes` into `grid-step.ts`, re-import it into `build-grid.ts`**

Move the gcd computation verbatim into the new file, export it, change
`build-grid.ts` to import and call it instead of computing inline.

- [ ] **Step 5: Run to verify it passes, confirm the backend's own tests still pass**

Run: `cd packages/engine && npx vitest run src/scheduling/grid-step.test.ts src/scheduling/build-grid.test.ts`
Expected: PASS, both files, 0 regressions in `build-grid.test.ts`.

- [ ] **Step 6: Wire the frontend to the real step**

In `schedule-board.tsx:862`, replace `slotMinutes = cfg.matchMinutes +
cfg.gapMinutes` with `slotMinutes = gridStepMinutes(cfg.matchMinutes,
cfg.gapMinutes)` (imported from `packages/engine`). In
`board-grid.tsx:104`, replace the fixed `h-10` row class with a
floor-based rule producing MORE rows at a readable minimum height for
finer segmentation, rather than shrinking rows — exact breakpoints
decided in this step by screenshotting both a coarse (60 min) and fine
(10 min) board and picking values that read cleanly at both.

- [ ] **Step 7: Update existing board tests, run the full suite**

Run: `cd apps/web && npx vitest run src/components/v2/__tests__/schedule-board-polish.test.tsx src/components/v2/__tests__/schedule-board-day-tab.test.tsx`

These tests were written against the OLD `matchMinutes+gapMinutes`
step — read them first, update any assertion hardcoding the old slot
count/timing, add one new case proving the new step matches
`gridStepMinutes`'s output. If a file needs no changes because it
doesn't assert on exact slot count, say so rather than editing
needlessly.

- [ ] **Step 8: Screenshot both a coarse and fine board at desktop and 375px**

Confirm no horizontal page scroll at 375px on either board shape, and
that the finer board's extra rows scroll vertically in a bounded
container.

- [ ] **Step 9: Commit**

```bash
git add packages/engine/src/scheduling/grid-step.ts packages/engine/src/scheduling/grid-step.test.ts packages/engine/src/scheduling/build-grid.ts apps/web/src/components/v2/schedule-board.tsx apps/web/src/lib/schedule-board.ts apps/web/src/components/v2/board/board-grid.tsx apps/web/src/components/v2/__tests__/schedule-board-polish.test.tsx apps/web/src/components/v2/__tests__/schedule-board-day-tab.test.tsx
git commit -m "fix(web): board time axis matches the backend's real gcd step, not a fixed sum"
```

**Verify**: `packages/engine` and `apps/web` board-related suites both green with raw counts; two-to-four screenshots attached (coarse/fine × desktop/375px) confirming no horizontal scroll.

**Output cap**: final message under 15 lines — pass counts, chosen row-height values and why, screenshot confirmation.
