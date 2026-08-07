# Prompt 06: Blackout editor UI + fix the broken pointer string

**Context**: `docs/superpowers/specs/2026-08-07-datetime-scheduling-ux-design.md`,
decision 3 — supplements the AI natural-language console, doesn't
replace it. Writes into the EXISTING `config.blackouts` field
(confirmed by reading `apps/web/src/server/usecases/schedule.ts:146-155`'s
`usesConstraints()` directly — no new backend endpoint needed; Prompt 07
verifies this rather than this prompt building something new).

**Acceptance criteria**: organiser can add/remove a blackout window
(from/to time, optional court scope) through a real form, replacing the
current read-only count. The dead-end pointer string ("edit them on the
constraints panel" — pointing at itself) is gone. Gated behind the
`scheduling.constraints` feature, matching the existing
`usesConstraints()` gate.

**Do not touch**: the AI console's own NL parsing path
(`schedule-ai-parse.ts`) — this prompt adds a form, it does not change
how the AI console works.

**Files:**
- Modify: `apps/web/src/components/v2/constraints-panel.tsx:56,266-270`
- Modify: `apps/web/src/components/v2/board/settings-panel.tsx` (the `"boardset.customWindows"` string's usage)
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`
- Test: `apps/web/src/components/v2/__tests__/constraints-panel.test.tsx`

**Interfaces:**
- Consumes: `DateTimeField` from `apps/web/src/components/v2/shared/datetime-field.tsx` (Prompt 01) for the from/to time fields.
- Produces: an editable list writing `Blackout[]` (`{ court?: string; from: number; to: number }`) into `config.blackouts` via the panel's existing `onChange(config)` prop.

- [ ] **Step 1: Read the current read-only display and the broken pointer**

Read `constraints-panel.tsx` lines 250-280 (the current read-only
count) and find the exact `settings-panel.tsx` usage of the
`"boardset.customWindows"` string.

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
Expected: FAIL — no "add blackout" control exists yet, broken pointer still present.

- [ ] **Step 4: Build the editor**

Replace the read-only `{startWindows.length} start window(s) set` block
with a real editable list: court-scope selector (optional, defaults to
"all courts") + two `DateTimeField kind="time"` fields (from/to) per
row, add/remove buttons. On save, convert the form's local hour:minute
state into `Blackout`'s `{ court?, from, to }` shape (resolved against
the division's date context — read how `constraints-panel.tsx` already
resolves its other time-based fields to the org tz rather than
inventing a second conversion path) and merge into `config.blackouts`,
calling the existing `onChange(config)` prop.

- [ ] **Step 5: Remove the broken pointer string**

Delete the `"boardset.customWindows"` string's usage in
`settings-panel.tsx` (check its other call sites first — repoint rather
than delete if the slot is still needed for something else) now that
the constraints panel has a real editor.

- [ ] **Step 6: Add i18n keys to all 4 locales**

"Add blackout", "Blackout start", "Blackout end", "Remove", a
court-scope label, a validation message ("end must be after start") —
genuinely translated per locale, not copy-pasted English.

- [ ] **Step 7: Run to verify it passes**

Run: `cd apps/web && npx vitest run src/components/v2/__tests__/constraints-panel.test.tsx`
Expected: PASS, full file green.

- [ ] **Step 8: Verify the feature gate**

Confirm the editor only renders for orgs with `scheduling.constraints`
(mirrors `usesConstraints()`'s existing gate) — write a test asserting
it's absent for a Community-tier org.

- [ ] **Step 9: Screenshot at desktop and 375px.**

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/components/v2/constraints-panel.tsx apps/web/src/components/v2/board/settings-panel.tsx apps/web/src/dictionaries apps/web/src/components/v2/__tests__/constraints-panel.test.tsx
git commit -m "feat(web): real blackout-window editor, fix dead-end pointer string"
```

**Verify**: full constraints-panel test file green, i18n drift gate clean (`npm run i18n:gen-keys && git status --porcelain` empty), feature-gate test passes, screenshots attached.

**Output cap**: final message under 15 lines.
