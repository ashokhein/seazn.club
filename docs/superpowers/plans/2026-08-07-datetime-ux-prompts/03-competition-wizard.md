# Prompt 03: Convert `competition-wizard.tsx`

**Context**: `docs/superpowers/specs/2026-08-07-datetime-scheduling-ux-design.md`,
decision 1. Same shape as Prompt 02, applied to a different file —
independently reviewable, safe to run in parallel with Prompts 02/04
since the files don't overlap.

**Acceptance criteria**: the two native `<input type="date">` elements
in `competition-wizard.tsx` are replaced by `DateTimeField`, identical
behavior to before. Every pre-existing test in the file stays green.

**Do not touch**: any other file. `DateTimeField` (Prompt 01) must
already exist before this prompt can run.

**Files:**
- Modify: `apps/web/src/components/v2/competition-wizard.tsx:134-146`
- Test: existing competition-wizard test file

**Interfaces:**
- Consumes: `DateTimeField` from `apps/web/src/components/v2/shared/datetime-field.tsx` (Prompt 01).

- [ ] **Step 1: Read lines 130-150 in full before changing anything.**

- [ ] **Step 2: Write the failing regression test**

```typescript
it("competition start/end use the shared DateTimeField component", () => {
  render(<CompetitionWizard {...defaultProps} />);
  const startInput = screen.getByLabelText(/competition start/i);
  expect(startInput.className).toMatch(/text-base/);
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd apps/web && npx vitest run src/components/v2/__tests__/competition-wizard.test.tsx -t "shared DateTimeField"`

- [ ] **Step 4: Replace both native inputs with `DateTimeField kind="date"`**

Preserve existing `useState`/validation wiring exactly — markup change only.

- [ ] **Step 5: Run the full file to verify nothing broke**

Run: `cd apps/web && npx vitest run src/components/v2/__tests__/competition-wizard.test.tsx`
Expected: PASS, full file green.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/v2/competition-wizard.tsx apps/web/src/components/v2/__tests__/competition-wizard.test.tsx
git commit -m "refactor(web): competition-wizard uses shared DateTimeField"
```

**Verify**: full competition-wizard test file green, raw count pasted.

**Output cap**: final message under 15 lines.
