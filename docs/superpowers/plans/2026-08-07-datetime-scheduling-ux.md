# Date/Time Scheduling UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Also read `docs/superpowers/RULES.md` before starting any task** — project-wide standing policy (agent topology, required test types, mindset) that applies here in full.

**Goal:** One shared native-input date/time component used everywhere, a schedule board whose time axis matches what the solver actually reasoned about, a real blackout-window editor, and a guard against removing a court with pinned/frozen fixtures on it — per `docs/superpowers/specs/2026-08-07-datetime-scheduling-ux-design.md`.

**Architecture:** Componentize six existing ad-hoc native `<input type="date"|"time"|"datetime-local">` declarations into one shared component (no custom picker). Replace the board's fixed `matchMinutes+gapMinutes` step with the backend's already-correct `gcd(matchMinutes, gapMinutes)`. Add a blackout editor that writes into the existing `config.blackouts` field — no new backend endpoint, `putScheduleSettings` already persists it as part of the config JSONB. Add a pre-write check in that same function rejecting a court removal that would strand pinned/frozen fixtures.

**Tech Stack:** React/Next.js (existing `apps/web` conventions), Vitest, Playwright, this repo's `.input`/`.label` shared CSS classes.

## Global Constraints

- Every new/changed user-facing string → all 4 locale dictionaries (`apps/web/src/dictionaries/{en,es,fr,nl}/*.json`), never hardcoded English.
- Every UI surface verified at desktop AND 375px, no horizontal page scroll.
- Every task ships all 4 test types per `docs/superpowers/RULES.md`: unit, E2E (Playwright), smoke (`scripts/smoke.ts`), regression (a test that fails without the fix). Tasks 1-4 are unit+regression only where nothing new is E2E/smoke-visible yet — Task 9 is where cumulative E2E+smoke coverage for the whole feature set lands, same pattern as the CP-SAT plan's own Task 11.
- Agent topology for dispatch: Scout=Sonnet High, Implementer=Sonnet xHigh, Reviewer=Sonnet xHigh (`docs/superpowers/RULES.md` — supersedes any older Opus guidance).
- Blackout config is gated behind the `scheduling.constraints` feature (`usesConstraints()`, `schedule.ts:146-155`) — the editor UI must respect this, not just the backend.
- Pre-commit: `npm run openapi:gen && git status --porcelain` must be empty — none of these tasks change the OpenAPI-documented wire shape (`config` stays an opaque JSON blob to the API layer), but verify anyway, don't assume.

---

## File Structure

```
apps/web/src/components/v2/shared/
└── datetime-field.tsx                                  # NEW — shared component

apps/web/src/components/v2/
├── division-builder.tsx                                # MODIFY — use shared component
├── competition-wizard.tsx                               # MODIFY — use shared component
├── constraints-panel.tsx                                # MODIFY — blackout editor, fix broken pointer
├── schedule-board.tsx                                    # MODIFY — real gcd step
└── board/
    ├── settings-panel.tsx                                # MODIFY — use shared component
    └── board-grid.tsx                                    # MODIFY — row height handling

packages/engine/src/scheduling/
└── grid-step.ts                                          # NEW — shared gcd helper (TS mirror of build-grid.ts's own gcd logic, so frontend and backend can never drift again)

apps/web/src/lib/schedule-board.ts                        # MODIFY — daySlots() takes the real step
apps/web/src/server/usecases/schedule.ts                  # MODIFY — putScheduleSettings gets the court-removal guard
apps/web/src/dictionaries/{en,es,fr,nl}/ui.json            # MODIFY — new strings (blackout editor, court-removal rejection)
e2e/schedule-datetime-ux.spec.ts                           # NEW — Task 9
scripts/smoke.ts                                            # MODIFY — Task 9
```

---

### Task 1: Shared `DateTimeField` component

**Files:**
- Create: `apps/web/src/components/v2/shared/datetime-field.tsx`
- Test: `apps/web/src/components/v2/shared/__tests__/datetime-field.test.tsx`

**Interfaces:**
- Produces: `<DateTimeField kind="date" | "time" | "datetime-local" value={string} onChange={(v: string) => void} label={string} min?={string} disabled?={boolean} />` — Tasks 2, 3, 4, 6 all import this exact component and prop shape.

- [ ] **Step 1: Read the reference styling**

Read `apps/web/src/components/v2/division-builder.tsx` lines 760-790 (its
native date/time inputs) to copy the exact current class names and
structure — the "consistent inputs" rule requires this component to be
indistinguishable from what's already there, not a new look.

- [ ] **Step 2: Write the failing test**

```typescript
// apps/web/src/components/v2/shared/__tests__/datetime-field.test.tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DateTimeField } from "../datetime-field.tsx";

describe("DateTimeField", () => {
  it("renders a native input of the requested kind with the shared input class", () => {
    render(<DateTimeField kind="date" value="2026-08-07" onChange={() => {}} label="Start date" />);
    const input = screen.getByLabelText("Start date");
    expect(input).toHaveAttribute("type", "date");
    expect(input.className).toContain("input");
  });

  it("uses text-base sm:text-sm so iOS does not zoom on focus", () => {
    render(<DateTimeField kind="time" value="09:00" onChange={() => {}} label="Start time" />);
    expect(screen.getByLabelText("Start time").className).toMatch(/text-base/);
  });

  it("calls onChange with the raw input value", () => {
    const onChange = vi.fn();
    render(<DateTimeField kind="datetime-local" value="" onChange={onChange} label="Kickoff" />);
    fireEvent.change(screen.getByLabelText("Kickoff"), { target: { value: "2026-08-07T09:00" } });
    expect(onChange).toHaveBeenCalledWith("2026-08-07T09:00");
  });

  it("applies min when provided", () => {
    render(<DateTimeField kind="date" value="" onChange={() => {}} label="End date" min="2026-08-07" />);
    expect(screen.getByLabelText("End date")).toHaveAttribute("min", "2026-08-07");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/components/v2/shared/__tests__/datetime-field.test.tsx`
Expected: FAIL — component doesn't exist.

- [ ] **Step 4: Write the component**

```typescript
// apps/web/src/components/v2/shared/datetime-field.tsx
"use client";

import { useId } from "react";

export interface DateTimeFieldProps {
  kind: "date" | "time" | "datetime-local";
  value: string;
  onChange: (value: string) => void;
  label: string;
  min?: string;
  disabled?: boolean;
}

export function DateTimeField({ kind, value, onChange, label, min, disabled }: DateTimeFieldProps) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="label">
        {label}
      </label>
      <input
        id={id}
        type={kind}
        className="input w-full text-base sm:text-sm"
        value={value}
        min={min}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/web && npx vitest run src/components/v2/shared/__tests__/datetime-field.test.tsx`
Expected: PASS, all 4 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/v2/shared/datetime-field.tsx apps/web/src/components/v2/shared/__tests__/datetime-field.test.tsx
git commit -m "feat(web): shared DateTimeField component, consolidating six ad-hoc native inputs"
```

**Verify**: `cd apps/web && npx vitest run src/components/v2/shared/__tests__/datetime-field.test.tsx` → 4 passed, 0 failed.

**Output cap**: final message under 15 lines — pass count, confirm class names match the division-wizard reference exactly.

---

### Task 2: Convert `division-builder.tsx`

**Files:**
- Modify: `apps/web/src/components/v2/division-builder.tsx:768-784`
- Test: existing division-builder test file — add a regression case, do not remove existing coverage

**Interfaces:**
- Consumes: `DateTimeField` (Task 1).

- [ ] **Step 1: Read the current implementation**

Read lines 760-790 in full — the exact `useState` wiring around the two
native inputs there, so the replacement preserves identical behavior
(not just identical markup).

- [ ] **Step 2: Write the failing regression test**

```typescript
it("division schedule start/end use the shared DateTimeField component", () => {
  render(<DivisionBuilder {...defaultProps} />);
  // The shared component always sets text-base sm:text-sm — a component-level
  // fingerprint proving THIS input, not a lookalike, is in use.
  const startInput = screen.getByLabelText(/schedule start/i);
  expect(startInput.className).toMatch(/text-base/);
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd apps/web && npx vitest run src/components/v2/__tests__/division-builder.test.tsx -t "shared DateTimeField"`
Expected: FAIL — old native input lacks the fingerprint class.

- [ ] **Step 4: Replace the two native inputs with `DateTimeField`**

Swap the `<input type="datetime-local">` (schedule start) and
`<input type="date">` (schedule end, `min` derived from start) for
`<DateTimeField kind="datetime-local" .../>` and
`<DateTimeField kind="date" .../>` respectively, wiring the exact same
`useState`/`onChange` handlers that were already there — this task
changes markup, not state logic.

- [ ] **Step 5: Run full file to verify nothing broke**

Run: `cd apps/web && npx vitest run src/components/v2/__tests__/division-builder.test.tsx`
Expected: PASS — new test green, every pre-existing test in the file still green.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/v2/division-builder.tsx apps/web/src/components/v2/__tests__/division-builder.test.tsx
git commit -m "refactor(web): division-builder uses shared DateTimeField"
```

**Verify**: full division-builder test file green, raw count pasted, not a wrapper summary.

**Output cap**: final message under 15 lines.

---

### Task 3: Convert `competition-wizard.tsx`

**Files:**
- Modify: `apps/web/src/components/v2/competition-wizard.tsx:134-146`
- Test: existing competition-wizard test file

**Interfaces:**
- Consumes: `DateTimeField` (Task 1).

Same shape as Task 2, applied to competition-wizard's two `<input type="date">` elements (competition start/end).

- [ ] **Step 1: Read lines 130-150 in full before changing anything.**
- [ ] **Step 2: Write the failing regression test** (same fingerprint pattern as Task 2, targeting the competition start/end labels).
- [ ] **Step 3: Run to verify it fails.**

Run: `cd apps/web && npx vitest run src/components/v2/__tests__/competition-wizard.test.tsx -t "shared DateTimeField"`

- [ ] **Step 4: Replace both native inputs with `DateTimeField kind="date"`, preserving existing `useState`/validation wiring.**
- [ ] **Step 5: Run the full file to verify nothing broke.**

Run: `cd apps/web && npx vitest run src/components/v2/__tests__/competition-wizard.test.tsx`
Expected: PASS, full file green.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/v2/competition-wizard.tsx apps/web/src/components/v2/__tests__/competition-wizard.test.tsx
git commit -m "refactor(web): competition-wizard uses shared DateTimeField"
```

**Verify**: full competition-wizard test file green, raw count pasted.

**Output cap**: final message under 15 lines.

---

### Task 4: Convert `settings-panel.tsx`'s date/time inputs

**Files:**
- Modify: `apps/web/src/components/v2/board/settings-panel.tsx:176,181,190-200`
- Test: existing settings-panel test file

**Interfaces:**
- Consumes: `DateTimeField` (Task 1).

**Do not touch**: `settings-panel.tsx`'s `courts` array editor (lines
84-149, native `<input type="text">` for court names, not a date/time
input) — out of scope for this task, touched again in Task 8.

- [ ] **Step 1: Read lines 170-225 in full** — four separate inputs here (`startAt` datetime-local, `endAt` date, two play-hours `time` inputs), each with its own `min` derivation logic to preserve exactly.
- [ ] **Step 2: Write the failing regression test** covering all four fields with the same fingerprint pattern as Tasks 2-3.
- [ ] **Step 3: Run to verify it fails.**

Run: `cd apps/web && npx vitest run src/components/v2/board/__tests__/settings-panel.test.tsx -t "shared DateTimeField"`

- [ ] **Step 4: Replace all four native inputs with `DateTimeField`**, preserving each field's existing `min`/validation wiring individually — do not consolidate their state logic, only their markup.
- [ ] **Step 5: Run the full file to verify nothing broke.**

Run: `cd apps/web && npx vitest run src/components/v2/board/__tests__/settings-panel.test.tsx`
Expected: PASS, full file green.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/v2/board/settings-panel.tsx apps/web/src/components/v2/board/__tests__/settings-panel.test.tsx
git commit -m "refactor(web): settings-panel date/time inputs use shared DateTimeField"
```

**Verify**: full settings-panel test file green, raw count pasted.

**Output cap**: final message under 15 lines.

---

### Task 5: Board segmentation matches the backend's real step

**Files:**
- Create: `packages/engine/src/scheduling/grid-step.ts`
- Modify: `apps/web/src/components/v2/schedule-board.tsx:862`, `apps/web/src/lib/schedule-board.ts:101-108`, `apps/web/src/components/v2/board/board-grid.tsx:104`
- Test: `packages/engine/src/scheduling/grid-step.test.ts`, existing `schedule-board-polish.test.tsx`/`schedule-board-day-tab.test.tsx`

**Interfaces:**
- Produces: `gridStepMinutes(matchMinutes: number, gapMinutes: number): number` in `packages/engine` — a SHARED helper both `build-grid.ts` (backend) and `schedule-board.tsx` (frontend) import, so the two can never drift apart on this calculation again. This is the direct fix for the divergence the design doc's investigation found.

**Do not touch**: `build-grid.ts`'s own `gridStepMinutes` computation logic
— extract it into the new shared file, don't reimplement it a second
time with a second chance to drift.

- [ ] **Step 1: Read the reference computation**

Read `packages/engine/src/scheduling/build-grid.ts` lines 100-108 (the
existing `gcd(matchMinutes, gapMinutes)` computation) in full before
extracting it.

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
    // Cross-check against the actual buildGrid() output rather than
    // trusting the extraction alone.
    const grid = buildGrid({ config: { matchMinutes: 30, gapMinutes: 10, courts: ["C1"] } });
    expect(gridStepMinutes(30, 10)).toBe(grid.stepMinutes);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd packages/engine && npx vitest run src/scheduling/grid-step.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 4: Extract `gridStepMinutes` into `grid-step.ts`, re-import it into `build-grid.ts`**

Move the gcd computation verbatim into the new file, export it, and
change `build-grid.ts` to import and call it instead of computing
inline — confirms the extraction is byte-identical to the original by
construction, not by re-derivation.

- [ ] **Step 5: Run to verify it passes, and confirm the backend's own tests still pass**

Run: `cd packages/engine && npx vitest run src/scheduling/grid-step.test.ts src/scheduling/build-grid.test.ts`
Expected: PASS, both files, 0 regressions in `build-grid.test.ts`.

- [ ] **Step 6: Wire the frontend to the real step**

In `schedule-board.tsx:862`, replace `slotMinutes = cfg.matchMinutes + cfg.gapMinutes` with `slotMinutes = gridStepMinutes(cfg.matchMinutes, cfg.gapMinutes)` (imported from `packages/engine`). In `board-grid.tsx:104`, replace the fixed `h-10` row class with a floor-based rule: `Math.max(40, Math.min(80, 600 / totalSlotsVisible))` px via inline style, or a small set of Tailwind height steps chosen so finer segmentation produces MORE rows at a readable minimum height rather than shrinking text — exact breakpoints decided during this step by screenshotting both a coarse (60 min) and fine (10 min) board and picking values that read cleanly at both, not pre-committed to a single number in this plan (this is the "row-height exact values" open item the design doc deliberately deferred to implementation).

- [ ] **Step 7: Update existing board tests for the new step, run the full suite**

Run: `cd apps/web && npx vitest run src/components/v2/__tests__/schedule-board-polish.test.tsx src/components/v2/__tests__/schedule-board-day-tab.test.tsx`

These tests were written against the OLD `matchMinutes+gapMinutes`
step — read them first, update any assertion that hardcodes the old
slot count/timing, and add one new case proving the new step matches
`gridStepMinutes`'s output for that test's board shape. If either file
needs no changes because it doesn't assert on exact slot count, say so
rather than editing needlessly.

Expected: PASS, full green, with the new step verified.

- [ ] **Step 8: Screenshot both a coarse and fine board at desktop and 375px**

Per `docs/superpowers/RULES.md`'s UI/UX bar — confirm no horizontal
page scroll at 375px on either board shape, and that the finer board's
extra rows scroll vertically in a bounded container rather than
breaking layout.

- [ ] **Step 9: Commit**

```bash
git add packages/engine/src/scheduling/grid-step.ts packages/engine/src/scheduling/grid-step.test.ts packages/engine/src/scheduling/build-grid.ts apps/web/src/components/v2/schedule-board.tsx apps/web/src/lib/schedule-board.ts apps/web/src/components/v2/board/board-grid.tsx apps/web/src/components/v2/__tests__/schedule-board-polish.test.tsx apps/web/src/components/v2/__tests__/schedule-board-day-tab.test.tsx
git commit -m "fix(web): board time axis matches the backend's real gcd step, not a fixed sum"
```

**Verify**: `packages/engine` and `apps/web` board-related suites both green with raw counts; two screenshots attached (coarse/fine × desktop/375px, or four total) confirming no horizontal scroll.

**Output cap**: final message under 15 lines — pass counts, chosen row-height values and why, screenshot confirmation.

---

### Task 6: Blackout editor UI + fix the broken pointer string

**Files:**
- Modify: `apps/web/src/components/v2/constraints-panel.tsx:56,266-270`
- Modify: `apps/web/src/components/v2/board/settings-panel.tsx` (line ~1804's dictionary-referenced string)
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`
- Test: `apps/web/src/components/v2/__tests__/constraints-panel.test.tsx`

**Interfaces:**
- Consumes: `DateTimeField` (Task 1, for the from/to time fields).
- Produces: an editable list UI writing `Blackout[]` (`{ court?: string; from: number; to: number }`) into the SAME `config.blackouts` field `putScheduleSettings` already persists — no new API shape, verified against the real function body at `schedule.ts:157-188`.

- [ ] **Step 1: Read the current read-only display and the broken pointer**

Read `constraints-panel.tsx` lines 250-280 (the current read-only count)
and find the exact `settings-panel.tsx` string key referenced as
`"boardset.customWindows"` (currently telling users to "edit them on
the constraints panel" — which is this same panel, and cannot).

- [ ] **Step 2: Write the failing test**

```typescript
it("lets an organiser add a blackout window with from/to and optional court scope", () => {
  const onChange = vi.fn();
  render(<ConstraintsPanel config={configWithNoBlackouts()} onChange={onChange} />);
  fireEvent.click(screen.getByRole("button", { name: /add blackout/i }));
  fireEvent.change(screen.getByLabelText(/blackout start/i), { target: { value: "12:00" } });
  fireEvent.change(screen.getByLabelText(/blackout end/i), { target: { value: "13:00" } });
  fireEvent.click(screen.getByRole("button", { name: /save/i }));
  expect(onChange).toHaveBeenCalledWith(
    expect.objectContaining({ blackouts: expect.arrayContaining([expect.objectContaining({ from: expect.any(Number), to: expect.any(Number) })]) }),
  );
});

it("no longer points organisers at a panel that cannot edit windows", () => {
  render(<SettingsPanel {...defaultProps} />);
  expect(screen.queryByText(/edit them on the constraints panel/i)).not.toBeInTheDocument();
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd apps/web && npx vitest run src/components/v2/__tests__/constraints-panel.test.tsx -t "blackout"`
Expected: FAIL — no "add blackout" control exists yet, and the broken pointer string is still present.

- [ ] **Step 4: Build the editor**

Replace `constraints-panel.tsx`'s read-only `{startWindows.length}
start window(s) set` block with a real editable list: each row shows a
court-scope selector (optional, defaults to "all courts") and two
`DateTimeField kind="time"` fields (from/to), an add button, and a
remove button per row. On save, convert the form's local
hour:minute state into `Blackout`'s `{ court?, from, to }` shape
(absolute ms, resolved against the division's date context — read how
`constraints-panel.tsx` already resolves its other time-based fields
to the org tz rather than inventing a second conversion path) and merge
into `config.blackouts`, calling the same `onChange(config)` prop the
rest of the panel already uses to bubble up to `settings-panel.tsx`'s
save flow.

- [ ] **Step 5: Remove the broken pointer string**

Delete the `"boardset.customWindows"` string's usage in
`settings-panel.tsx` (or repoint it, if that string's slot is still
needed for something else — check its other call sites first) now that
the constraints panel has a real editor to point to instead of itself.

- [ ] **Step 6: Add i18n keys to all 4 locales**

New keys needed: "Add blackout", "Blackout start", "Blackout end",
"Remove", a court-scope label, and any validation message (e.g. "end
must be after start"). Add to `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`
— genuinely translated per locale, not copy-pasted English (per this
repo's dictionary-copy-truth guard).

- [ ] **Step 7: Run to verify it passes**

Run: `cd apps/web && npx vitest run src/components/v2/__tests__/constraints-panel.test.tsx`
Expected: PASS, full file green.

- [ ] **Step 8: Verify the feature gate**

Confirm the editor only renders when the org has `scheduling.constraints`
(mirrors `usesConstraints()`'s existing gate at `schedule.ts:146-155`)
— write a test asserting it's absent for a Community-tier org.

- [ ] **Step 9: Screenshot at desktop and 375px.**

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/components/v2/constraints-panel.tsx apps/web/src/components/v2/board/settings-panel.tsx apps/web/src/dictionaries apps/web/src/components/v2/__tests__/constraints-panel.test.tsx
git commit -m "feat(web): real blackout-window editor, fix dead-end pointer string"
```

**Verify**: full constraints-panel test file green, i18n drift gate clean (`npm run i18n:gen-keys && git status --porcelain` empty), feature-gate test passes, screenshots attached.

**Output cap**: final message under 15 lines.

---

### Task 7: Confirm blackout round-trip through `putScheduleSettings`

**Files:**
- Test: `apps/web/src/server/usecases/__tests__/schedule.test.ts` (or wherever the existing `putScheduleSettings` suite lives — locate it first)

**Interfaces:**
- Consumes: Task 6's editor output shape, `putScheduleSettings` (existing, unmodified by this task).

This task is **verification, not new backend code** — the design doc's
original assumption (a new endpoint might be needed) turned out to be
wrong once `schedule.ts:146-155` was actually read: `config.blackouts`
already flows through the existing JSONB write at `schedule.ts:179-185`.
Confirm that's really true end-to-end rather than assuming it from
reading the code alone.

- [ ] **Step 1: Write the failing (well, should-already-pass, confirm it does) integration test**

```typescript
it("a blackout window round-trips through putScheduleSettings unchanged", async () => {
  const config = { ...baseConfig(), blackouts: [{ court: "Court 1", from: 1723027200000, to: 1723030800000 }] };
  await putScheduleSettings(auth, divisionId, { config });
  const stored = await getScheduleSettings(auth, divisionId);
  expect(stored.config.blackouts).toEqual([{ court: "Court 1", from: 1723027200000, to: 1723030800000 }]);
});

it("a blackout window is honored by the placer — a fixture cannot land inside it", async () => {
  // Real board, real buildGrid()/admits() — not a mock — proving the
  // frontend's new editor writes something the SOLVER actually respects,
  // not just something the database accepts.
  const grid = buildGrid({ config: { ...baseConfig(), blackouts: [{ from: T0, to: T0 + 3_600_000 }] } });
  expect(grid.slots.some((s) => s.startAt >= T0 && s.startAt < T0 + 3_600_000)).toBe(false);
});
```

- [ ] **Step 2: Run**

Run: `cd apps/web && npx vitest run src/server/usecases/__tests__/schedule.test.ts -t "blackout"`
Expected: PASS on the first try if the reading was correct — if it
fails, that's a real finding (the assumption was wrong after all), not
a step to work around; report it rather than adjusting the test to fit.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/server/usecases/__tests__/schedule.test.ts
git commit -m "test: confirm blackout windows round-trip through existing putScheduleSettings and are honored by the placer"
```

**Verify**: both tests pass without any backend code change — if they don't, stop and report rather than adding new backend code speculatively; that would mean Task 6/this task's premise needs revisiting first.

**Output cap**: final message under 15 lines — explicitly state whether the existing backend needed zero changes (expected) or whether a real gap was found (escalate, don't silently patch around it).

---

### Task 8: Court-removal guard

**Files:**
- Modify: `apps/web/src/server/usecases/schedule.ts:157-188` (`putScheduleSettings`)
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json` (rejection message)
- Test: `apps/web/src/server/usecases/__tests__/schedule.test.ts`

**Interfaces:**
- Consumes: existing DB access inside `putScheduleSettings`'s `withTenant` transaction.
- Produces: `putScheduleSettings` throws `HttpError(409, ...)` when the new `config.courts` list drops a court that still has pinned/frozen fixtures assigned to it.

**Do not touch**: the AUTO/REFLOW engine code paths — this guard prevents
the bad state from being SAVED in the first place; it does not change
what either engine does with an already-orphaned assignment (that
behavior — pinned exempt from AUTO's filter, REFLOW's `{original} ∪
{configured}` domain — is unchanged and correct to leave as-is per the
CP-SAT design doc's own note on this).

- [ ] **Step 1: Write the failing test**

```typescript
it("rejects removing a court that still has a pinned fixture on it", async () => {
  await seedFixture({ divisionId, court: "Court 2", locked: true });
  const newConfig = { ...currentConfig, courts: ["Court 1"] }; // Court 2 dropped
  await expect(putScheduleSettings(auth, divisionId, { config: newConfig }))
    .rejects.toMatchObject({ status: 409, message: expect.stringMatching(/court 2/i) });
});

it("allows removing a court whose fixtures are all unlocked", async () => {
  await seedFixture({ divisionId, court: "Court 2", locked: false });
  const newConfig = { ...currentConfig, courts: ["Court 1"] };
  await expect(putScheduleSettings(auth, divisionId, { config: newConfig })).resolves.toBeDefined();
});

it("allows removing a court with no fixtures on it at all", async () => {
  const newConfig = { ...currentConfig, courts: ["Court 1"] }; // Court 2 was never used
  await expect(putScheduleSettings(auth, divisionId, { config: newConfig })).resolves.toBeDefined();
});
```

- [ ] **Step 2: Run to verify the first test fails**

Run: `cd apps/web && npx vitest run src/server/usecases/__tests__/schedule.test.ts -t "court that still has"`
Expected: FAIL — no such check exists today (confirmed earlier by trace: the save path currently accepts any court list unconditionally).

- [ ] **Step 3: Add the check inside `putScheduleSettings`**

Inside the `withTenant` callback, after the `division` lookup and
before the `insert...on conflict` write: fetch the division's current
`config.courts` (from `loadSettings`, already imported in this file) and
diff against `input.config.courts` to find removed court names. For
each removed court, query fixtures assigned to it
(`schedule_locked = true` OR whatever this codebase's actual
pinned/frozen flag predicate is — verify the exact column/condition
against `history.ts`'s `ClearScheduleInput`/`clearScheduleScoped`
handling, which already distinguishes locked fixtures for a related
purpose, rather than inventing a new predicate). If any removed court
has matching fixtures, throw
`new HttpError(409, "..." )` naming the court and count before the
transaction writes anything.

- [ ] **Step 4: Add the i18n string for the rejection message**

This is a server-side error message — check whether this codebase's
`HttpError` messages are already user-facing strings needing dictionary
entries (per how other `HttpError` throws in this file are handled) or
internal-only strings the client maps to its own localized copy. Match
whichever pattern is already established rather than introducing a
third convention.

- [ ] **Step 5: Run to verify all three tests pass**

Run: `cd apps/web && npx vitest run src/server/usecases/__tests__/schedule.test.ts`
Expected: PASS, full file green, no regression on any other `putScheduleSettings` test.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/server/usecases/schedule.ts apps/web/src/dictionaries apps/web/src/server/usecases/__tests__/schedule.test.ts
git commit -m "fix(web): reject removing a court with pinned/frozen fixtures still on it"
```

**Verify**: full `putScheduleSettings` test suite green with raw counts; confirm the guard fires BEFORE the transaction write (a rejected save must leave the stored config completely unchanged — add an assertion for this specifically).

**Output cap**: final message under 15 lines — pass count, confirm no partial-write on rejection.

---

### Task 9: E2E + smoke coverage for the whole feature set

**Files:**
- Create: `e2e/schedule-datetime-ux.spec.ts`
- Modify: `scripts/smoke.ts`

**Interfaces:**
- Consumes: the real running app (Playwright drives a browser against it), all of Tasks 1-8's changes.

Per `docs/superpowers/RULES.md`: every task ultimately owes E2E +
smoke coverage; this task is where it lands for this whole programme,
once the full chain is visible end-to-end (mirrors the CP-SAT plan's
own Task 11 for the same reason).

- [ ] **Step 1: Write the E2E spec**

```typescript
// e2e/schedule-datetime-ux.spec.ts
import { test, expect } from "@playwright/test";

test.describe("date/time scheduling UX", () => {
  test("organiser adds a blackout window and it blocks that time on the board", async ({ page }) => {
    await page.goto("/console/.../constraints"); // exact route: read the existing constraints-panel e2e spec (if any) for the real path rather than guessing
    await page.getByRole("button", { name: /add blackout/i }).click();
    await page.getByLabel(/blackout start/i).fill("12:00");
    await page.getByLabel(/blackout end/i).fill("13:00");
    await page.getByRole("button", { name: /save/i }).click();
    await page.goto("/console/.../board");
    await page.getByRole("button", { name: /auto.?schedule/i }).click();
    // No fixture card renders inside the 12:00-13:00 column for any court.
    await expect(page.locator('[data-testid="board-cell"][data-hour="12"]')).toBeEmpty();
  });

  test("removing a court with a pinned fixture is rejected with a clear message", async ({ page }) => {
    // seed a pinned fixture on "Court 2" via the existing e2e fixture-seeding helper
    await page.goto("/console/.../board/settings");
    await page.getByRole("button", { name: /remove court 2/i }).click();
    await page.getByRole("button", { name: /save/i }).click();
    await expect(page.getByText(/court 2/i)).toBeVisible();
    await expect(page.getByText(/pinned/i)).toBeVisible();
  });

  test("board renders without horizontal scroll at 375px with the new segmentation", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/console/.../board");
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBe(clientWidth);
  });
});
```

Read this repo's existing e2e specs under `e2e/` first for the real
route paths, auth setup, and fixture-seeding helpers already
established — the routes above are placeholders for the PATTERN, not
verified paths; replace them with the real ones before this spec can
run at all.

- [ ] **Step 2: Add smoke coverage**

Read `scripts/smoke.ts`'s existing structure (per
`project_test_infra` — a control run pattern already exists for
similarly hard-to-E2E cases). Add a smoke check that a division with a
configured blackout window and a fresh auto-schedule run produces a
board with zero assignments inside the blackout — a lighter-weight,
faster-running confirmation than the full E2E spec, for the fast smoke
tier.

- [ ] **Step 3: Run the E2E spec locally**

Run per this repo's local e2e recipe (`seazn-local-env` skill,
`project_local_e2e_recipe` — prod build + local port, not `npm run dev`).
Expected: all 3 cases pass. If the app isn't running standalone yet,
bring it up per that skill first — do not skip this step by reasoning
about what the test "should" do.

- [ ] **Step 4: Run smoke**

Run: `npx tsx scripts/smoke.ts` (or this repo's actual invocation —
confirm from `package.json`'s scripts).
Expected: the new blackout check passes alongside existing checks.

- [ ] **Step 5: Commit**

```bash
git add e2e/schedule-datetime-ux.spec.ts scripts/smoke.ts
git commit -m "test(e2e): cover blackout windows, court-removal guard, and 375px board layout end-to-end"
```

**Verify**: E2E spec 3/3 passing against a real local server, smoke check passing. Per `docs/superpowers/RULES.md`, a failure in an unrelated existing e2e spec is noted and skipped, not chased — but any of the 3 new cases failing is this task's own responsibility to fix, not to skip.

**Output cap**: final message under 15 lines — E2E pass count, smoke result, note any existing e2e route/helper you had to adjust the placeholder paths to match.

---

### Task 10: Regression test review — existing suites that assert on the old behavior

**Files:**
- Review (and modify only where a real assertion is now stale): `apps/web/src/components/v2/board/__tests__/disruption-signals.test.ts`

**Interfaces:**
- Consumes: nothing new — this task audits Tasks 1-8's blast radius against tests that predate them.

- [ ] **Step 1: Re-read `disruption-signals.test.ts`'s `court_gone` case**

The test at `disruption-signals.test.ts:78-84` asserts `computeDisruptions`
flags a fixture on a removed court with reason `"court_gone"`. Task 8
makes that scenario **impossible to reach via the save path** when the
fixture is pinned/frozen (the save is now rejected before it can
happen) — but still reachable for an UNLOCKED fixture (Task 8
deliberately does not block that case, per the design doc's stated
scope: "an unlocked, unpinned fixture on the removed court is not
blocked"). Confirm the existing test's fixture is unlocked; if it's
pinned/locked, the test's own premise is now unreachable and needs
updating to an unlocked fixture to keep testing a real scenario.

- [ ] **Step 2: Run it as-is first, before touching anything**

Run: `cd apps/web && npx vitest run src/components/v2/board/__tests__/disruption-signals.test.ts`

If it still passes unmodified, the fixture was already unlocked — leave
the file alone, note this in the final summary, and move on. Do not
edit a test that doesn't need it.

- [ ] **Step 3: If it needs updating, write why in the commit, not just what**

If the test's fixture WAS pinned and the scenario is now unreachable,
change it to an unlocked fixture and add a short comment noting Task 8
made the pinned case save-time-rejected rather than post-hoc-detected —
future readers should not have to re-discover this by re-running both
tests to notice the relationship.

- [ ] **Step 4: Commit only if Step 3 required a change**

```bash
git add apps/web/src/components/v2/board/__tests__/disruption-signals.test.ts
git commit -m "test: keep court_gone disruption test reachable after the court-removal guard"
```

**Verify**: `disruption-signals.test.ts` passes, and its scenario is confirmed still reachable (not silently testing something the code no longer allows to happen).

**Output cap**: final message under 15 lines — state plainly whether a change was needed or not, don't pad either way.

---

## Self-Review

**Spec coverage**: shared component (Task 1-4), board segmentation (Task
5), blackout editor including the broken-pointer fix (Task 6), backend
confirmation not reinvention (Task 7 — the design doc's own assumption
corrected against real code), court-removal guard (Task 8), all 4
required test types (unit throughout, E2E+smoke consolidated in Task 9,
regression explicit in every task plus a dedicated audit in Task 10),
i18n and mobile bar addressed per-task rather than deferred. Open items
1-3 from the design doc: #1 (component API shape) resolved concretely
in Task 1; #2 (hard block vs override) resolved as hard block in Task
8, matching the design doc's stated lean; #3 (row-height values)
explicitly left to Task 5's own screenshot-driven step, not
pre-committed here either — consistent with the design doc's own
deferral, not a gap this plan silently introduced.

**Placeholder scan**: no TBD/TODO. Task 9's e2e route paths are
explicitly flagged as PATTERN-ONLY placeholders with an explicit
required step to replace them against real routes before the spec can
run — this is disclosed, not silently left vague, and step 1 makes
fixing it a hard prerequisite rather than optional polish.

**Type consistency**: `DateTimeFieldProps` (Task 1) is the single shape
every consuming task (2, 3, 4, 6) imports — no task redefines its own
variant. `gridStepMinutes` (Task 5) is imported, not reimplemented, by
the frontend. `Blackout`'s `{ court?, from, to }` shape (Task 6, 7) is
the existing engine type, not a new frontend-only shape that would need
translation at the API boundary.

---

**Plan complete and saved to `docs/superpowers/plans/2026-08-07-datetime-scheduling-ux.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — fresh subagent per task (Scout/Implementer/Reviewer per `docs/superpowers/RULES.md`), review between tasks

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
