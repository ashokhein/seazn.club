# Prompt 02: Convert `division-builder.tsx`

**Context**: `docs/superpowers/specs/2026-08-07-datetime-scheduling-ux-design.md`,
decision 1. This is the first of three mechanical conversions (Prompts
02-04) — same shared component, three different files, each
independently reviewable.

**Acceptance criteria**: the two native date/time inputs in
`division-builder.tsx` are replaced by `DateTimeField`, with IDENTICAL
`useState`/validation behavior to before — this is a markup swap, not a
logic change. Every pre-existing test in the file stays green.

**Do not touch**: any other file. `DateTimeField` (Prompt 01) must
already exist before this prompt can run.

**Files:**
- Modify: `apps/web/src/components/v2/division-builder.tsx:768-784`
- Test: existing division-builder test file — add a regression case, do not remove existing coverage

**Interfaces:**
- Consumes: `DateTimeField` from `apps/web/src/components/v2/shared/datetime-field.tsx` (Prompt 01).

- [ ] **Step 1: Read the current implementation**

Read lines 760-790 in full — the exact `useState` wiring around the two
native inputs there, so the replacement preserves identical behavior.

- [ ] **Step 2: Write the failing regression test**

```typescript
it("division schedule start/end use the shared DateTimeField component", () => {
  render(<DivisionBuilder {...defaultProps} />);
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
`<DateTimeField kind="date" .../>`, wiring the exact same
`useState`/`onChange` handlers already there.

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
