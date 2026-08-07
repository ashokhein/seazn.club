# Prompt 07: Confirm blackout round-trip through `putScheduleSettings`

**Context**: `docs/superpowers/specs/2026-08-07-datetime-scheduling-ux-design.md`.
**This prompt is verification, not new backend code.** The design doc's
original assumption was that a new endpoint might be needed for
blackout persistence — that turned out to be wrong once
`apps/web/src/server/usecases/schedule.ts:146-155` was actually read:
`config.blackouts` already flows through the existing JSONB write at
`schedule.ts:179-185` via `usesConstraints()`'s own read of
`config.blackouts.length`. This prompt confirms that's really true
end-to-end rather than assuming it from reading the code alone — if it
turns out NOT to be true, that is itself the important finding, report
it, do not silently add backend code to route around it.

**Acceptance criteria**: both tests below pass with ZERO backend code
changes. If either fails, stop and report — do not add speculative
backend code to make them pass; that would mean this prompt's premise
needs revisiting, which is a decision for the person reading the
report, not something to route around silently.

**Do not touch**: `putScheduleSettings` or any other backend function —
if you find yourself editing one, you've misread this prompt's purpose.

**Files:**
- Test: `apps/web/src/server/usecases/__tests__/schedule.test.ts` (locate the real file — the existing `putScheduleSettings` suite lives somewhere in this directory tree, confirm the exact path before writing)

**Interfaces:**
- Consumes: Prompt 06's editor output shape, `putScheduleSettings` (existing, unmodified).

- [ ] **Step 1: Write the tests**

```typescript
it("a blackout window round-trips through putScheduleSettings unchanged", async () => {
  const config = { ...baseConfig(), blackouts: [{ court: "Court 1", from: 1723027200000, to: 1723030800000 }] };
  await putScheduleSettings(auth, divisionId, { config });
  const stored = await getScheduleSettings(auth, divisionId);
  expect(stored.config.blackouts).toEqual([{ court: "Court 1", from: 1723027200000, to: 1723030800000 }]);
});

it("a blackout window is honored by the placer — a fixture cannot land inside it", async () => {
  const grid = buildGrid({ config: { ...baseConfig(), blackouts: [{ from: T0, to: T0 + 3_600_000 }] } });
  expect(grid.slots.some((s) => s.startAt >= T0 && s.startAt < T0 + 3_600_000)).toBe(false);
});
```

- [ ] **Step 2: Run**

Run: `cd apps/web && npx vitest run src/server/usecases/__tests__/schedule.test.ts -t "blackout"`
Expected: PASS on the first try if the reading was correct.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/server/usecases/__tests__/schedule.test.ts
git commit -m "test: confirm blackout windows round-trip through existing putScheduleSettings and are honored by the placer"
```

**Verify**: both tests pass without any backend code change. If they don't, DO NOT patch around it — report the exact failure as this prompt's result and stop.

**Output cap**: final message under 15 lines — explicitly state whether the existing backend needed zero changes (expected) or whether a real gap was found (escalate, don't silently patch around it).
