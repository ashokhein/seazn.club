# Prompt 10: Regression audit — `disruption-signals.test.ts`

**Context**: `docs/superpowers/specs/2026-08-07-datetime-scheduling-ux-design.md`.
Prompt 08's court-removal guard makes the pinned-fixture-on-a-removed-
court scenario **impossible to reach via the save path** — but
`disruption-signals.test.ts:78-84` was written to test exactly that
scenario being *detected after the fact*. This prompt checks whether
that test's premise survived, and fixes it only if it didn't. **Needs
Prompt 08 done first.**

**Acceptance criteria**: `disruption-signals.test.ts` passes, and its
`court_gone` scenario is confirmed still reachable in the state the
guard now allows (an UNLOCKED fixture on a removed court — Prompt 08
deliberately does not block that case).

**Do not touch**: `use-disruption-signals.ts` itself — this prompt
audits the TEST's premise against Prompt 08's new behavior, it does not
change the disruption-detection logic, which is correct and unchanged.

**Files:**
- Review (modify only if genuinely needed): `apps/web/src/components/v2/board/__tests__/disruption-signals.test.ts`

**Interfaces:**
- Consumes: nothing new — audits Prompts 01-08's blast radius against a pre-existing test.

- [ ] **Step 1: Re-read the `court_gone` test case**

Read `disruption-signals.test.ts` lines 78-84 in full. Check whether
its seeded fixture is locked/pinned or unlocked.

- [ ] **Step 2: Run it as-is first, before touching anything**

Run: `cd apps/web && npx vitest run src/components/v2/board/__tests__/disruption-signals.test.ts`

If it still passes unmodified, the fixture was already unlocked —
**leave the file alone**, state that plainly in the final summary, and
stop. Do not edit a test that doesn't need it.

- [ ] **Step 3: If it needs updating, change it and explain why in the code, not just the commit**

If the test's fixture WAS pinned/locked and the scenario is now
unreachable via `putScheduleSettings` (Prompt 08 rejects it), change
the seeded fixture to unlocked so the test exercises a state that can
still actually occur, and add a short comment noting Prompt 08 made the
pinned case save-time-rejected rather than post-hoc-detected — a future
reader should not have to re-discover this relationship by independently
running both suites.

- [ ] **Step 4: Commit only if Step 3 required a change**

```bash
git add apps/web/src/components/v2/board/__tests__/disruption-signals.test.ts
git commit -m "test: keep court_gone disruption test reachable after the court-removal guard"
```

**Verify**: `disruption-signals.test.ts` passes, and its scenario is confirmed still reachable given Prompt 08's new guard.

**Output cap**: final message under 15 lines — state plainly whether a change was needed or not, don't pad either way.
