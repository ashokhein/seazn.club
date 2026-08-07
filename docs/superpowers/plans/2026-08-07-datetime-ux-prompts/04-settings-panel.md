# Prompt 04: Convert `settings-panel.tsx`'s date/time inputs

**Context**: `docs/superpowers/specs/2026-08-07-datetime-scheduling-ux-design.md`,
decision 1. Third of the three parallel conversions (02-04) — this file
has FOUR inputs to convert, not two, each with its own `min`/validation
logic to preserve individually.

**Acceptance criteria**: all four native date/time inputs (`startAt`
datetime-local, `endAt` date, two play-hours `time` inputs) replaced by
`DateTimeField`, each field's existing `min`/validation wiring
preserved individually — do not consolidate their state logic, only
their markup.

**Do not touch**: `settings-panel.tsx`'s `courts` array editor (lines
84-149, native `<input type="text">` for court names — not a date/time
input, out of scope here, touched again in Prompt 08). `DateTimeField`
(Prompt 01) must already exist before this prompt can run.

**Files:**
- Modify: `apps/web/src/components/v2/board/settings-panel.tsx:176,181,190-200`
- Test: existing settings-panel test file

**Interfaces:**
- Consumes: `DateTimeField` from `apps/web/src/components/v2/shared/datetime-field.tsx` (Prompt 01).

- [ ] **Step 1: Read lines 170-225 in full**

Four separate inputs here, each with its own `min` derivation logic —
note each one individually before changing anything.

- [ ] **Step 2: Write the failing regression test**

```typescript
it("board settings date/time inputs use the shared DateTimeField component", () => {
  render(<SettingsPanel {...defaultProps} />);
  for (const label of [/start/i, /end/i, /play.*from/i, /play.*until/i]) {
    expect(screen.getByLabelText(label).className).toMatch(/text-base/);
  }
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd apps/web && npx vitest run src/components/v2/board/__tests__/settings-panel.test.tsx -t "shared DateTimeField"`

- [ ] **Step 4: Replace all four native inputs with `DateTimeField`**

Preserve each field's existing `min`/validation wiring individually.

- [ ] **Step 5: Run the full file to verify nothing broke**

Run: `cd apps/web && npx vitest run src/components/v2/board/__tests__/settings-panel.test.tsx`
Expected: PASS, full file green.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/v2/board/settings-panel.tsx apps/web/src/components/v2/board/__tests__/settings-panel.test.tsx
git commit -m "refactor(web): settings-panel date/time inputs use shared DateTimeField"
```

**Verify**: full settings-panel test file green, raw count pasted.

**Output cap**: final message under 15 lines.
