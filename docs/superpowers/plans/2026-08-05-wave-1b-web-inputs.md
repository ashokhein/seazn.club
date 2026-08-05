# Wave 1b — Web Inputs to the Placer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the engine the inputs it needs, in ONE namespace, so Wave 1a's placement convergence is reachable from the AI path and scoped rules bind on both sides of every seam.

**Architecture:** `apps/web` only. Task 1 extracts the single constraints builder that three call sites currently duplicate — #458 falls out of it. Tasks 2-3 collapse two namespaces down to one each. Tasks 4-5 are independent data/return-shape fixes.

**Tech Stack:** TypeScript, vitest, zod, Playwright.

## Global Constraints

- `apps/web` only. Do NOT modify `packages/engine` — Wave 1a is reviewed and shipped (PR #472). If a fix seems to require an engine change, STOP and report.
- Never `git stash` in this worktree — the stash stack is shared with the main checkout; a no-op push+pop pops a FOREIGN stash and leaves `package.json` unmerged, blocking every commit. Revert-to-prove with `git show HEAD:<path> > <path>` or a `cp` backup.
- Prefix `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/sched-convergence &&` in the SAME call as every command you judge; cwd resets to the main checkout between calls.
- Judge vitest ONLY from `--reporter=json --outputFile`. A drop in `numTotalTests` is a failure, not a pass.
- Before every commit: `npm run openapi:gen && npm run i18n:gen-keys && git status --porcelain` — porcelain must show only intended files. `openapi:gen` regenerates from the zod schema and will NOT tell you the served JSON changed; if a task touches a boundary payload, assert the payload directly.
- Do not file GitHub issues. Fix what you find here with a failing-first test, or carry it in one line.
- DB: `postgresql://postgres@127.0.0.1:54337/seazn_w1a`, `DATABASE_SSL=disable` (fresh, migrated, sports + Stripe seeded). Servers :3100/:3200 are running — do not restart them.

## Verified Starting State

Surveyed 2026-08-05 on `feat/sched-convergence`. Every line below was read.

| Fact | Location |
| --- | --- |
| `verifyConfig(pack: SchedulePack): VerifyConfig` | `schedule-ai.ts:1577` |
| `startWindows: []` pinned, deliberately, comment at `:1458-1465` | `schedule-ai.ts:1606` |
| `pack.settings.constraints` IS in scope there — access was never the blocker | `schedule-ai.ts:1601-1611` |
| Sibling A (board): maps every window through, no filter | `schedule.ts:403-406` |
| Sibling B (joint): `flatMap`, DROPS `target.kind` outside `entrant\|pool\|division` | `competition-schedule-ai.ts:1308-1317` |
| `PackStartWindow = { target: {kind: string; id: string}; notBefore?; notAfter? }` | `schedule-ai.ts:219-223` |
| The test PINNING the empty behaviour | `schedule-group-targeting.test.ts:259-263` |
| `siblingAssignments(...): Promise<Assignment[]>` | `schedule.ts:313-321` |
| Its four call sites, all `[...others, ...siblings]` into `validateAssignments` | `schedule.ts:618, 753, 978, 1106` |
| `RuleFixture = { id, extKey, divisionId?, poolId?, winnerTo }` | `calendar.ts:784-790` |
| `Assignment = { fixtureId, court, startAt, endAt, entrants, people, poolId?, divisionId? }` | `calendar.ts:78-87` |
| `moveFixture(...): Promise<void>`; conflicts computed then dropped | `schedule.ts:909-916`, `:951`, `:998` |
| Its only caller discards the value | `fixtures.ts:49` (via route `fixtures/[id]/route.ts:22`) |
| Placer input pool = **uuid** | `schedule-ai.ts:903` |
| Pack pool = **`pools.key`** | `schedule-ai.ts:978`, map built `:639` |
| `toRuleFixture` stamps the KEY onto `RuleFixture.poolId` | `schedule-ai.ts:1558-1564` |
| Joint twin, same split | `competition-schedule-ai.ts:1146` |
| `personKeyResolver(): { keyOf, assumptions }` | `schedule-ai.ts:173-176` |
| Rosters collapsed through it | `schedule-ai.ts:623, 631, 672`; joint `competition-schedule-ai.ts:517,519,580` |
| `scope.personKey` consumed as bare equality, nothing maps it | `calendar.ts:844` |

**Two received claims are FALSE and must not be acted on:**

1. *"#458 is a copy of either sibling."* The siblings disagree — one filters unrecognised `target.kind`, one does not — and **there is no shared builder**: `verifyConfig`, `schedule.ts`'s `toVerifyConfig`, and the joint builder are three independent literal objects over the same shape. Only `toRuleFixture`, `windowBounds` and `effectiveRestMinutes` are genuinely shared. A fourth copy adds a producer to a bug class defined by having too many.
2. *"#462: the joint path gets this right, copy it."* **No call site anywhere builds `RuleFixture[]` for siblings** — the joint path builds them only from `pack.fixtures.movable` (`competition-schedule-ai.ts:1383, 1554`). There is nothing to copy; this is new code.

---

### Task 1: One constraints builder, and #458 falls out

**Files:** create `apps/web/src/server/usecases/engine-constraints.ts`; modify `schedule-ai.ts:1601-1611`, `schedule.ts:399-406`, `competition-schedule-ai.ts:1308-1317`; test `apps/web/src/server/usecases/__tests__/engine-constraints.test.ts` (create).

**Interfaces:** Produces `buildEngineConstraints(source, opts?)` returning the `constraints` object `VerifyConfig` expects, including `startWindows`. Consumed by all three sites.

- [ ] **Step 1: Write the failing test.** Assert the builder (a) maps `notBefore`/`notAfter` through `ms()`, (b) DROPS a window whose `target.kind` is unrecognised, and (c) returns a non-empty `startWindows` for a pack that has one. Assert the drop explicitly with a `target.kind: "nonsense"` case — the joint sibling's comment explains why: the pack is a wire shape, `kind` is a bare `string`, and casting an unrecognised kind through lets the engine silently never match it while hiding that a settings row drifted from the enum.
- [ ] **Step 2: Run it — expect FAIL (module does not exist).**
- [ ] **Step 3: Implement the builder,** taking the filtering behaviour as canonical. Then route all three call sites through it. Delete the three literal blocks.
- [ ] **Step 4: Flip the pin test.** `schedule-group-targeting.test.ts:259-263` asserts `verifyConfig(p).constraints?.startWindows` `toEqual([])`. It must now assert the window is carried, with its pool target intact. Rename the test — its title ("the pinned-empty startWindows cannot yet use") is now false.
- [ ] **Step 5: Full web suite, drift gates, commit** `fix(schedule): build engine constraints in one place, and stop pinning startWindows empty (#458)`.

---

### Task 2: One pool namespace across the engine boundary

`Assignment.poolId` is a **uuid** on the board path and a **pool key** on the AI path. `RuleFixture.poolId` carries the key. `scopeCoversFixture` reads `f?.poolId ?? a.poolId`, so the RuleFixture value MASKS the assignment's — at most one side ever binds. The same split reaches `effectiveRestMinutes`' `restByGroup` lookup (`calendar.ts:107-124`), so a pool-targeted rest rule silently misses on one of the two paths.

**Decision: the uuid is canonical at the engine boundary.** It is what the board path already uses, what the DB stores, and what `restByGroup` keys are authored against. The pool KEY is display metadata (`"A"`, `"B"`) and is not unique across divisions.

**Files:** `schedule-ai.ts:978` (pack build — leave `PackFixture.pool` as the key; it is what the MODEL reads), `schedule-ai.ts:1558-1564` (`toRuleFixture` must stamp the uuid), the `toEngineAssignments` path (comment at `:1450-1456`), `competition-schedule-ai.ts:1146`; test `apps/web/src/server/usecases/__tests__/schedule-pool-namespace.test.ts` (create).

- [ ] **Step 1: Write the failing test.** A pool-scoped rule and a pool-targeted `restByGroup` entry, both authored against the pool **uuid**, must bind on the AI path exactly as they do on the board path. Assert the SAME conflict count from both paths — a test asserting one path cannot catch a namespace split.
- [ ] **Step 2: Run it — expect FAIL** (AI path reports zero).
- [ ] **Step 3: Implement.** Keep the model-facing `PackFixture.pool` as the key; carry the uuid alongside it for engine use. Do NOT rename the pack field — it is a wire shape the prompts read.
- [ ] **Step 4: Full web suite + engine suite** (the engine is a consumer here), drift gates, commit `fix(schedule): one pool namespace at the engine boundary (#449)`.

---

### Task 3: Collapse the person scope the same way rosters are collapsed

Rosters are mapped through `personKeyResolver.keyOf` (`schedule-ai.ts:623-631, 672`), producing `name:<normalised>` where two people share a name. `hard[].scope.personKey` is never mapped, and `calendar.ts:844` compares it raw against `Assignment.people`. So a person-scoped rule stops binding the moment that person collapses.

**Files:** `schedule-ai.ts` where `hard` is assembled for the engine, the joint twin in `competition-schedule-ai.ts`; test `apps/web/src/server/usecases/__tests__/schedule-person-scope.test.ts` (create).

- [ ] **Step 1: Write the failing test.** Two people sharing a display name; a rule scoped to one of their uuids. Assert the rule binds. Add a guard case: with unique names, the rule must bind to that person ONLY — otherwise a collapse that over-matches passes the first assertion.
- [ ] **Step 2: Run it — expect FAIL.**
- [ ] **Step 3: Implement** by mapping `scope.personKey` through the SAME `identity.keyOf` instance that collapsed the rosters, at the point the rules are handed to the engine. Do not build a second resolver — one resolver instance, both sides.
- [ ] **Step 4: Full web suite, drift gates, commit** `fix(schedule): collapse person-scoped rules with the same resolver as the rosters (#450)`.

---

### Task 4: Siblings carry their rule fixtures

`siblingAssignments` returns `Assignment[]`, which structurally cannot carry `extKey` or `winnerTo`. So a competition-scoped rule that names fixtures by selector, or a day cap counting across divisions, sees cross-division fixtures with no rule identity. **Nothing anywhere builds this today** — new code, not a copy.

**Files:** `schedule.ts:313-321` and its four call sites (`:618, 753, 978, 1106`); test `apps/web/src/server/usecases/__tests__/schedule-sibling-rulefixtures.test.ts` (create).

- [ ] **Step 1: Write the failing test.** A competition-scoped `max_fixtures_per_day` over two divisions sharing an entrant. Assert the count includes the sibling division's fixtures. Assert the NUMBER, not merely that a conflict exists.
- [ ] **Step 2: Run it — expect FAIL (undercount).**
- [ ] **Step 3: Implement.** Return `{ assignments, ruleFixtures }` (or a second query), and pass `ruleFixtures` into every `validateAssignments` call that receives siblings. All four call sites must be updated — a missed one is a silent undercount, which is exactly the defect.
- [ ] **Step 4: Full web suite, drift gates, commit** `fix(schedule): sibling fixtures carry their rule identity (#462)`.

---

### Task 5: `moveFixture` returns the conflicts it already computes

`conflicts` is populated at `schedule.ts:998` and discarded because the function is `Promise<void>`. Blocking conflicts throw (409); **warn-level conflicts are silently dropped**, so a drag that creates a warned-about board tells the organiser nothing.

**Files:** `schedule.ts:909-916`, `fixtures.ts:49`, `apps/web/src/app/api/v1/fixtures/[id]/route.ts:22`, plus the UI surface that consumes the PATCH response; test `apps/web/src/server/usecases/__tests__/schedule-move-conflicts.test.ts` (create).

- [ ] **Step 1: Write the failing test.** A move that creates a WARN-level conflict (not blocking, or it throws). Assert the returned conflicts are non-empty and non-blocking.
- [ ] **Step 2: Run it — expect FAIL (returns undefined).**
- [ ] **Step 3: Implement.** Change the return type and thread it through `patchFixture` to the route response. **This changes a wire payload** — update the response schema in `apps/web/src/server/api-v1/schemas.ts`, run `openapi:gen`, and commit the regenerated spec. Assert the payload shape in a test; the drift gate alone will not tell you the served JSON changed.
- [ ] **Step 4: UI.** If the drag surface can render the warning, do it via the `frontend-design` skill and verify at desktop AND 375px with no horizontal page scroll. Any new user-facing string goes in all 4 locale dictionaries, never hardcoded English. If the surface cannot show it without a redesign, say so and stop rather than guessing — a visual restyle needs sign-off.
- [ ] **Step 5: Full web suite, drift gates, commit** `feat(schedule): a move returns the conflicts it computes (#461)`.

---

## Closing gates for the wave

Unit (engine + web), smoke against a standalone server on a FRESH database, and e2e. Smoke reads `SCHEDULING_AI_BASE_URL` from its OWN env or the v4 AI section skips silently while still reporting success. E2E must use `PLAYWRIGHT_BASE=http://localhost:3100`, not `127.0.0.1` — the stored auth cookie's domain is the hostname, and a mismatch 401s every POST while `apiJson` swallows it into `data: undefined`, which reads convincingly as a broken seed helper.

Rebuild before smoke/e2e, or the servers serve a previous branch and pass.

## Out of scope

Wave 2 (#467). Engine changes of any kind. The remaining untriaged issues: #465, #455, #453, #439, #389, #388.
