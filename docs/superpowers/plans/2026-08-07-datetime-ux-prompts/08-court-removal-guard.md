# Prompt 08: Court-removal guard

**Context**: `docs/superpowers/specs/2026-08-07-datetime-scheduling-ux-design.md`,
decision 4. Found while tracing an unrelated question, not part of the
original ask: today, removing a court from settings is completely
unguarded — the save path never checks whether pinned/frozen fixtures
still sit on that court. Consequence, already confirmed: a pinned
fixture stays there forever (exempt from AUTO's own cleanup filter),
REFLOW's move-minimizing objective typically leaves it there too, and
the raw board grid silently drops the card from view.

**Acceptance criteria**: `putScheduleSettings` rejects (409) a config
save that would drop a court still holding a pinned/frozen fixture,
BEFORE writing anything — a rejected save must leave the stored config
completely unchanged. A court removal with only unlocked fixtures, or
no fixtures at all, still succeeds.

**Do not touch**: `packages/engine/src/scheduling/build.ts` or
`repair.ts` — this guard prevents the bad state from being SAVED, it
does not change what either engine does with an already-orphaned
assignment (that behavior is unchanged and correct to leave as-is, per
the CP-SAT design doc's own note on this exact case).

**Files:**
- Modify: `apps/web/src/server/usecases/schedule.ts:157-188` (`putScheduleSettings`)
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json` (if the rejection message needs a dictionary entry — verify the pattern first, see Step 4)
- Test: `apps/web/src/server/usecases/__tests__/schedule.test.ts`

**Interfaces:**
- Consumes: existing DB access inside `putScheduleSettings`'s `withTenant` transaction (already reads `division`/`loadSettings` in that function — reuse, don't add a second connection).

- [ ] **Step 1: Write the failing tests**

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

it("does not write anything when the save is rejected", async () => {
  await seedFixture({ divisionId, court: "Court 2", locked: true });
  const before = await getScheduleSettings(auth, divisionId);
  await expect(putScheduleSettings(auth, divisionId, { config: { ...currentConfig, courts: ["Court 1"] } })).rejects.toBeDefined();
  const after = await getScheduleSettings(auth, divisionId);
  expect(after.config).toEqual(before.config);
});
```

- [ ] **Step 2: Run to verify the guard-related tests fail**

Run: `cd apps/web && npx vitest run src/server/usecases/__tests__/schedule.test.ts -t "court that still has"`
Expected: FAIL — no such check exists today.

- [ ] **Step 3: Add the check inside `putScheduleSettings`**

Inside the `withTenant` callback, after the `division` lookup and
before the `insert...on conflict` write: load the division's CURRENT
`config.courts` (via `loadSettings`, already imported in this file) and
diff against `input.config.courts` to find removed court names. For
each removed court, query fixtures assigned to it with the locked/
pinned predicate — verify the exact column/condition against
`apps/web/src/server/usecases/history.ts`'s `ClearScheduleInput`/
`clearScheduleScoped` handling first (it already distinguishes locked
fixtures for `git grep -n "schedule_locked" apps/web/src/server/usecases/history.ts`
— reuse that exact predicate, don't invent a second one that could
drift from it). If any removed court has matching fixtures, throw
`new HttpError(409, ...)` naming the court and count, BEFORE the
transaction's write statement runs.

- [ ] **Step 4: Decide the message's i18n treatment**

Check how other `HttpError` throws in this file are surfaced to the
client — user-facing string needing dictionary entries, or an
internal/code-based message the client maps to its own localized copy.
Match whichever pattern is already established.

- [ ] **Step 5: Run to verify all four tests pass**

Run: `cd apps/web && npx vitest run src/server/usecases/__tests__/schedule.test.ts`
Expected: PASS, full file green, no regression on any other `putScheduleSettings` test.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/server/usecases/schedule.ts apps/web/src/dictionaries apps/web/src/server/usecases/__tests__/schedule.test.ts
git commit -m "fix(web): reject removing a court with pinned/frozen fixtures still on it"
```

**Verify**: full `putScheduleSettings` test suite green with raw counts; the no-partial-write test specifically confirms atomicity of the rejection.

**Output cap**: final message under 15 lines — pass count, confirm no partial-write on rejection, confirm the reused predicate matches `history.ts`'s exactly.
