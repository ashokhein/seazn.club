# ai-schedule-gap Close-Out Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the ten remaining `ai-schedule-gap` issues — quote/charge integrity, joint apply/undo symmetry, a billing-cron sweep that stops re-reading every wallet daily, and opening division scheduling to every plan.

**Architecture:** Five groups, drawn by file overlap rather than theme. Group C is a one-line wiring fix. Group B adds a server-side competition restore. Group A makes the client quote card see the same environment the server prices in, then detects any residual divergence, then fixes the two officials spend bugs — one pass, because they share `ai-console.tsx`. Group D rewrites one SQL sweep. Group E is entitlement data plus checkpoint eviction.

**Tech Stack:** Next.js (App Router, RSC), TypeScript, `postgres` tagged-template SQL, Flyway migrations, vitest, Playwright, zod.

Design doc: `docs/superpowers/specs/2026-08-05-ai-schedule-gap-triage-design.md`.

## Global Constraints

- **Every change ships a test that fails without it.** Non-negotiable project rule.
- **Test bar:** unit + E2E (Playwright) + smoke + regression on every task, **except** Tasks 4 and 5 (help article and copy-truth guard), which ship unit + regression only.
- **Any new or changed user-facing string goes into all 4 locale dictionaries** — `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`. Never hardcoded English. Dictionaries are **flat dotted-key JSON**.
- **`apps/web/content/help/**` is one English tree** — a help article owes no i18n work.
- **Pre-commit, every commit:** `npm run openapi:gen && npm run i18n:gen-keys`, then `git status --porcelain` must be empty. Both gates are CI-only; a green local test run proves nothing about them.
- **UI verified by screenshot at desktop AND 375px**, with no horizontal page scroll.

## Where the tests live

Do not create new spec files for any task in this plan. Every case below has an existing home.

| Kind | Location | Command |
|---|---|---|
| Unit / integration | `apps/web/src/**/__tests__/` | `npx vitest run <path> --root apps/web --reporter=json --outputFile=<f>` |
| **E2E** | `apps/web/e2e/ai-architect.spec.ts` — every AI-console case in this plan belongs here | `npm run test:e2e --workspace apps/web` |
| E2E (board wiring) | `apps/web/e2e/schedule-board.spec.ts` | as above |
| **Mobile 375px** | a Playwright **project**, not a manual screenshot: `--project=mobile-se --project=mobile-14`. `ai-architect.spec.ts:1207` already has a `test.describe("mobile viewport")` block — add mobile cases there | `npx playwright test --project=mobile-se` |
| **Smoke** | `scripts/smoke.ts`; demo data in `scripts/seed-demo.ts` | `npm run test:smoke` |

`test:e2e` runs three passes (`parallel`, then `serial` with one worker, then the two mobile projects). Run e2e locally against a prod build with `E2E_PROD_TARGET` — **never** enable `.github/workflows/e2e.yml`.

Use `localhost`, never `127.0.0.1`: the session cookie is `Secure` under `NODE_ENV=production` and will not be sent to `127.0.0.1`, which 401s every API call while the browser still looks signed in.

**Existing E2E tests these tasks will break.** Each is a real assertion about current behaviour, so update it deliberately rather than deleting it:

- `ai-architect.spec.ts:509` — *"the officials step prices itself: free draft with no picker, priced once a brief is typed"*. **Task 8** stops the officials step auto-running, so whatever this asserts about a price appearing on arrival now needs a button press first. Read it before writing Task 8's code.
- `ai-architect.spec.ts:197` — *"pro: brief → run → CLEAN → officials → apply → undo"*. Touched by **Task 8** (the officials step gains a click) and **Task 3** (undo becomes one call).
- `ai-architect.spec.ts:762` — *"competition board: pick divisions → price the batch → run → review → apply"*. The natural home for **Task 1**'s and **Task 3**'s joint cases.
- **New branches go in a worktree**, never the main checkout. Worktrees are already created (see each group header). Each has `.env.local`, `apps/web/.env.local` and `.claude/agent-memory` symlinked, and a real `npm ci`.
- **Prefix `cd <abs worktree> &&` in the same call as every command you judge.** The shell's cwd resets to the main checkout between calls; a verify run then silently executes on `main` and returns a false green.
- **Judge vitest only from `--reporter=json --outputFile`** (`numPassedTests`/`numTotalTests`/`numFailedTestSuites`). `rtk` prints `PASS(0) FAIL(0)` for a suite that failed to *collect*.
- **Never `git stash` in a worktree** — the stash stack is shared with the main checkout.
- Next free migration number is **V353**. `V344` is taken.

---

## Group C — board wiring (#394)

Worktree: `/Users/ashokhein/github/wt-ai-gap-c`, branch `ai-gap-c-board-wiring`.

### Task 1: The joint console receives the whole board's fixtures

On a competition board `single` is `null` (`schedule-board.tsx:433` — `divisions.length === 1 ? divisions[0] : null`), so `divBoardFixtures` is `[]` and the joint console gets an empty fixture list. Its review step then renders blocked rows with no labels.

The irony is that the comment directly above the bug already states the correct rule: *"THE division's on a division board, and the WHOLE board's on a competition board — a joint proposal spans every selected division, so narrowing to one would leave most of its ghosts without a code or a matchup."* The ternary implements the opposite.

**Files:**
- Modify: `apps/web/src/components/v2/schedule-board.tsx:596`
- Test: `apps/web/src/components/v2/__tests__/schedule-board-ai-wiring.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Write the failing test**

Add to `apps/web/src/components/v2/__tests__/schedule-board-ai-wiring.test.tsx`. The file already has `openConsole(props)` (line 221) and a `soloProps()` helper; use the competition-board props factory the joint tests already use (`baseProps`/`DIVISIONS` at lines 85-184) and read the `fixtures` prop reaching `AiCompetitionConsole`.

```tsx
it("hands the joint console every division's fixtures, not an empty list (#394)", () => {
  const island = openConsole(baseProps());          // competition board: divisions.length > 1
  const console_ = marked(island.tree(), "data-testid", "ai-competition-console");
  const passed = propsOf(console_).fixtures as AiConsoleFixture[];
  // The blocked-row labels the review step renders come from this list.
  expect(passed.length).toBeGreaterThan(0);
  expect(new Set(passed.map((f) => f.division_id)).size).toBeGreaterThan(1);
});
```

If `marked(…, "data-testid", …)` is not the harness's idiom for reaching the mounted console, copy whatever selector the neighbouring joint tests already use — do not invent a new one, and do not add a `data-testid` to production code just to satisfy this test.

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd /Users/ashokhein/github/wt-ai-gap-c && npx vitest run \
  src/components/v2/__tests__/schedule-board-ai-wiring.test.tsx \
  --root apps/web --reporter=json --outputFile=/tmp/c1.json > /dev/null 2>&1; echo "EXIT=$?"
cd /Users/ashokhein/github/wt-ai-gap-c && node -e "const r=require('/tmp/c1.json');console.log(r.numPassedTests,'/',r.numTotalTests,'failedSuites',r.numFailedTestSuites)"
```

Expected: the new test fails with `expect(received).toBeGreaterThan(0)` — received `0`.

- [ ] **Step 3: Drop the ternary**

`apps/web/src/components/v2/schedule-board.tsx:594-598` becomes:

```tsx
  const aiFixtures = useMemo<AiConsoleFixture[]>(
    () => consoleFixtures(actions.board, entrantNames, feedLabels),
    [actions.board, entrantNames, feedLabels],
  );
```

`divBoardFixtures` (line 572) stays — it has other consumers. Do not delete it. If TypeScript reports it as unused after this edit, that is a signal you removed the wrong thing; re-read its call sites before touching it.

Add to the comment block above it:

```tsx
  // #394: this deliberately does NOT narrow to `single`. On a competition board
  // `single` is null, so narrowing produced an EMPTY list and blanked the joint
  // review step's blocked-row labels. Third instance on this programme of the
  // same shape: extracting a pure function moves the mutation surface to its
  // arguments. `consoleFixtures` was well covered; the line choosing what to
  // hand it was not.
```

- [ ] **Step 4: Run the test and the whole v2 component suite**

```bash
cd /Users/ashokhein/github/wt-ai-gap-c && npx vitest run src/components/v2 \
  --root apps/web --reporter=json --outputFile=/tmp/c2.json > /dev/null 2>&1; echo "EXIT=$?"
cd /Users/ashokhein/github/wt-ai-gap-c && node -e "const r=require('/tmp/c2.json');console.log(r.numPassedTests,'/',r.numTotalTests,'failedSuites',r.numFailedTestSuites)"
```

Expected: all pass, `numFailedTestSuites` 0. The issue reports `src/components/v2` at 404/0 with the ternary dropped; a count near that with zero failures is the target. If the total is far below 404, you filtered the run — re-check the path.

- [ ] **Step 5: E2E — the joint review step shows labelled blocked rows**

Extend `apps/web/e2e/ai-architect.spec.ts:762` — *"competition board: pick divisions → price the batch → run → review → apply"*. It already reaches the review step on a competition board, which is exactly the surface that was blank. Add an assertion that a blocked row carries its fixture label rather than an empty cell.

```bash
cd /Users/ashokhein/github/wt-ai-gap-c && npm run test:e2e --workspace apps/web
```

- [ ] **Step 6: Smoke + mobile**

```bash
cd /Users/ashokhein/github/wt-ai-gap-c && npm run test:smoke
cd /Users/ashokhein/github/wt-ai-gap-c && npx playwright test --project=mobile-se apps/web/e2e/ai-architect.spec.ts
```

If the joint review step is not reachable from the demo data in `scripts/seed-demo.ts`, add a second division to a demo competition so it is. Screenshot desktop and 375px; no horizontal page scroll.

- [ ] **Step 7: Pre-commit gate, then commit**

```bash
cd /Users/ashokhein/github/wt-ai-gap-c && npm run openapi:gen && npm run i18n:gen-keys && git status --porcelain
```

Must print nothing beyond your own intended changes.

```bash
cd /Users/ashokhein/github/wt-ai-gap-c && git add -A && git commit -m "fix: hand the joint AI console the whole board's fixtures (#394)"
```

---

## Group B — joint apply/undo symmetry (#386, #392, #391)

Worktree: `/Users/ashokhein/github/wt-ai-gap-b`, branch `ai-gap-b-joint-undo`.

**Design decisions settled during triage, because the issue's premise did not survive contact with the code:**

- **Not one transaction.** `restoreCheckpoint` (`history.ts:379`) is a loop of up to 500 `undoDivision` calls, *each its own transaction*, and the comment says that is deliberate — "each undo is its own single-writer append (concurrency-safe)". Making a competition restore truly atomic would mean refactoring `undoDivision` to accept a caller-supplied tx and holding N advisory locks across up to 500×N appends. Owner ruled: **server-side, locked, best-effort**. The real failure mode this closes is the client-side loop dying with the browser tab, not a mid-transaction abort.
- **The client sends the anchors.** `schedule.applied_multi` carries `division_ids` only (`competition-schedule-apply.ts:650`); the restore anchors live client-side as `JointCheckpoint[] = {divisionId, checkpointId}` (`ai-joint-apply.ts:42`). The endpoint takes the pairs in the body and **rejects unless the division set exactly equals the event's `division_ids`**, so "all divisions of one apply" stays enforced rather than guessed.

### Task 2: A competition-scoped restore endpoint

**Files:**
- Create: `apps/web/src/app/api/v1/competitions/[id]/schedule/restore/route.ts`
- Create: `apps/web/src/server/usecases/competition-schedule-restore.ts`
- Modify: `apps/web/src/server/api-v1/schemas.ts` (add `RestoreCompetitionScheduleRequest`)
- Modify: `apps/web/src/server/api-v1/openapi.ts` (add the ROUTES entry)
- Test: `apps/web/src/server/usecases/__tests__/competition-schedule-restore.test.ts`

**Interfaces:**
- Consumes: `lockDivisions(tx, ids)` and `lockOrder(ids)` from `@/server/usecases/competition-schedule-apply` (both already exported, lines 196-211); `restoreCheckpoint(auth, divisionId, checkpointId, confirm)` from `@/server/usecases/history` (line 379), returning `{ watermark: number; steps: number }`; `JOINT_APPLY_EVENT` from `@/server/usecases/competition-schedule-ai` (line 2205, value `"schedule.applied_multi"`).
- Produces:

```ts
export interface CompetitionRestoreOut {
  restored: { division_id: string; watermark: number; steps: number }[];
  failed: { division_id: string; reason: string }[];
  ok: boolean;
}
export async function restoreCompetitionSchedule(
  auth: AuthCtx,
  competitionId: string,
  input: { checkpoints: { division_id: string; checkpoint_id: string }[]; confirm: true },
): Promise<CompetitionRestoreOut>;
```

Task 3 consumes exactly this shape from the client.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/server/usecases/__tests__/competition-schedule-restore.test.ts`. Follow the seeding idiom in the existing `competition-schedule-apply` tests in the same directory.

```ts
it("restores every division named by the apply event, in one call", async () => {
  const { auth, competitionId, divisions, checkpoints } = await seedAppliedJoint(2);
  const out = await restoreCompetitionSchedule(auth, competitionId, {
    checkpoints: checkpoints.map((c) => ({ division_id: c.divisionId, checkpoint_id: c.checkpointId })),
    confirm: true,
  });
  expect(out.ok).toBe(true);
  expect(out.restored.map((r) => r.division_id).sort()).toEqual(divisions.map((d) => d.id).sort());
  expect(out.failed).toEqual([]);
});

it("refuses a subset — the apply was all-or-nothing, so the undo is too", async () => {
  const { auth, competitionId, checkpoints } = await seedAppliedJoint(2);
  await expect(
    restoreCompetitionSchedule(auth, competitionId, {
      checkpoints: [{ division_id: checkpoints[0]!.divisionId, checkpoint_id: checkpoints[0]!.checkpointId }],
      confirm: true,
    }),
  ).rejects.toMatchObject({ status: 422 });
});

it("refuses a division that was not in the apply event", async () => {
  const { auth, competitionId, checkpoints, foreignDivisionId } = await seedAppliedJoint(2);
  await expect(
    restoreCompetitionSchedule(auth, competitionId, {
      checkpoints: [
        ...checkpoints.map((c) => ({ division_id: c.divisionId, checkpoint_id: c.checkpointId })),
        { division_id: foreignDivisionId, checkpoint_id: checkpoints[0]!.checkpointId },
      ],
      confirm: true,
    }),
  ).rejects.toMatchObject({ status: 422 });
});

it("reports a per-division failure instead of aborting the rest", async () => {
  const { auth, competitionId, checkpoints } = await seedAppliedJoint(2);
  const bad = [
    { division_id: checkpoints[0]!.divisionId, checkpoint_id: checkpoints[0]!.checkpointId },
    { division_id: checkpoints[1]!.divisionId, checkpoint_id: "00000000-0000-0000-0000-000000000000" },
  ];
  const out = await restoreCompetitionSchedule(auth, competitionId, { checkpoints: bad, confirm: true });
  expect(out.ok).toBe(false);
  expect(out.restored).toHaveLength(1);
  expect(out.failed).toHaveLength(1);
});

it("requires confirm: true", async () => {
  const { auth, competitionId, checkpoints } = await seedAppliedJoint(2);
  await expect(
    restoreCompetitionSchedule(auth, competitionId, {
      checkpoints: checkpoints.map((c) => ({ division_id: c.divisionId, checkpoint_id: c.checkpointId })),
      confirm: false as unknown as true,
    }),
  ).rejects.toMatchObject({ status: 422 });
});
```

`seedAppliedJoint(n)` is a local helper you write: seed an org, a competition, `n` divisions with fixtures, create one `kind: "ai"` checkpoint per division, apply a joint schedule via `applyCompetitionSchedule` so the `schedule.applied_multi` event exists, and return `{ auth, competitionId, divisions, checkpoints, foreignDivisionId }` where `foreignDivisionId` is a division in the same org that was *not* part of the apply.

- [ ] **Step 2: Run and confirm they fail**

```bash
cd /Users/ashokhein/github/wt-ai-gap-b && npx vitest run \
  src/server/usecases/__tests__/competition-schedule-restore.test.ts \
  --root apps/web --reporter=json --outputFile=/tmp/b1.json > /dev/null 2>&1; echo "EXIT=$?"
cd /Users/ashokhein/github/wt-ai-gap-b && node -e "const r=require('/tmp/b1.json');console.log(r.numPassedTests,'/',r.numTotalTests,'failedSuites',r.numFailedTestSuites)"
```

Expected: the suite fails to resolve `restoreCompetitionSchedule`. **A suite that fails to collect reports `numFailedTests: 0`** — read `numFailedTestSuites`, which must be 1, not `numFailedTests`.

- [ ] **Step 3: Write the usecase**

Create `apps/web/src/server/usecases/competition-schedule-restore.ts`:

```ts
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { lockDivisions } from "./competition-schedule-apply";
import { JOINT_APPLY_EVENT } from "./competition-schedule-ai";
import { restoreCheckpoint } from "./history";

export interface CompetitionRestoreOut {
  restored: { division_id: string; watermark: number; steps: number }[];
  failed: { division_id: string; reason: string }[];
  ok: boolean;
}

/**
 * POST /competitions/{id}/schedule/restore — undo one joint apply (#386).
 *
 * `applyCompetitionSchedule` writes every selected division in ONE transaction.
 * Undoing it used to be N independent restores driven by a client loop, so the
 * board could never be left half-written by an apply but could be left
 * half-restored by an undo — and a closed browser tab was enough to do it.
 *
 * NOT one transaction, deliberately. `restoreCheckpoint` rewinds by appending
 * inverse events, each its own single-writer transaction (`history.ts:379`);
 * that is what makes it concurrency-safe, and wrapping N divisions × up to 500
 * appends in one transaction would hold N advisory locks for the whole rewind.
 * What this endpoint adds instead: every division's lock is taken up front in
 * sorted order (the apply's own deadlock guard), so no concurrent edit can
 * interleave, the loop cannot be abandoned mid-way by a client, and a failure
 * is REPORTED per division rather than leaving the caller to discover it.
 *
 * The division set is validated against the apply event rather than trusted:
 * the caller supplies the checkpoint anchors (only the client holds them — the
 * event carries `division_ids` and nothing else), and the set must match the
 * event's list exactly. A subset is a 422, not a partial restore.
 */
export async function restoreCompetitionSchedule(
  auth: AuthCtx,
  competitionId: string,
  input: { checkpoints: { division_id: string; checkpoint_id: string }[]; confirm: true },
): Promise<CompetitionRestoreOut> {
  if (!input.confirm) throw new HttpError(422, "restore requires confirm: true");

  const applied = await withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<{ payload: { division_ids?: string[] } }[]>`
      select payload from competition_events
       where competition_id = ${competitionId} and org_id = ${auth.orgId}
         and type = ${JOINT_APPLY_EVENT}
       order by created_at desc
       limit 1`;
    if (!row) throw new HttpError(404, "no joint apply to restore");
    return row.payload.division_ids ?? [];
  });

  const asked = input.checkpoints.map((c) => c.division_id);
  if (new Set(asked).size !== asked.length) throw new HttpError(422, "a division was named twice");
  const same =
    asked.length === applied.length && [...asked].sort().every((id, i) => id === [...applied].sort()[i]);
  if (!same) {
    throw new HttpError(
      422,
      "a joint restore must name exactly the divisions the apply wrote",
    );
  }

  // Locks first, for the whole call — sorted order is the deadlock guard the
  // apply uses. Held only while the locks are taken; the rewinds below run in
  // their own transactions, which is the point (see the header).
  await withTenant(auth.orgId, (tx) => lockDivisions(tx, asked));

  const restored: CompetitionRestoreOut["restored"] = [];
  const failed: CompetitionRestoreOut["failed"] = [];
  for (const c of [...input.checkpoints].sort((a, b) => a.division_id.localeCompare(b.division_id))) {
    try {
      const out = await restoreCheckpoint(auth, c.division_id, c.checkpoint_id, true);
      restored.push({ division_id: c.division_id, watermark: out.watermark, steps: out.steps });
    } catch (err) {
      failed.push({
        division_id: c.division_id,
        reason: err instanceof Error ? err.message : "restore failed",
      });
    }
  }
  return { restored, failed, ok: failed.length === 0 };
}
```

Note on the lock: `pg_advisory_xact_lock` is released when its transaction ends, so the `withTenant` above releases immediately. That is honest — this is a serialisation point and an ordering discipline, not a held lock. If a reviewer asks for locks held across the rewinds, that is the "full atomic" option the owner declined; point them at this header.

- [ ] **Step 4: Add the request schema**

In `apps/web/src/server/api-v1/schemas.ts`, beside `ApplyCompetitionScheduleRequest`:

```ts
export const RestoreCompetitionScheduleRequest = z.object({
  checkpoints: z
    .array(z.object({ division_id: z.string().uuid(), checkpoint_id: z.string().uuid() }))
    .min(1),
  confirm: z.literal(true), // double-submit guard, same as the per-division restore
});
```

- [ ] **Step 5: Add the route**

Create `apps/web/src/app/api/v1/competitions/[id]/schedule/restore/route.ts`, mirroring the apply route exactly (body parse before auth, `v1()` wrapper):

```ts
import { v1, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { RestoreCompetitionScheduleRequest } from "@/server/api-v1/schemas";
import { restoreCompetitionSchedule } from "@/server/usecases/competition-schedule-restore";

type Ctx = { params: Promise<{ id: string }> };

/** POST /competitions/{id}/schedule/restore — undo one joint apply (#386).
 *  A thin adapter, like the apply route: every gate and the validation of the
 *  division set against the apply event live in the usecase. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const body = await parseBody(req, RestoreCompetitionScheduleRequest);
    const auth = await requireResourceAuth(req, "competition", id, "write");
    return restoreCompetitionSchedule(auth, id, body);
  });
}
```

- [ ] **Step 6: Add the OpenAPI ROUTES entry**

In `apps/web/src/server/api-v1/openapi.ts`, immediately after the competition schedule apply entry:

```ts
  { path: "/competitions/{id}/schedule/restore", method: "post", summary: "Undo one joint apply — restores every division that apply wrote (confirm: true)", tag: "history", request: S.RestoreCompetitionScheduleRequest, errors: [404, 422] },
```

- [ ] **Step 7: Run the tests**

```bash
cd /Users/ashokhein/github/wt-ai-gap-b && npx vitest run \
  src/server/usecases/__tests__/competition-schedule-restore.test.ts \
  --root apps/web --reporter=json --outputFile=/tmp/b2.json > /dev/null 2>&1; echo "EXIT=$?"
cd /Users/ashokhein/github/wt-ai-gap-b && node -e "const r=require('/tmp/b2.json');console.log(r.numPassedTests,'/',r.numTotalTests,'failedSuites',r.numFailedTestSuites)"
```

Expected: 5/5, `numFailedTestSuites` 0.

- [ ] **Step 8: Pre-commit gate, then commit**

```bash
cd /Users/ashokhein/github/wt-ai-gap-b && npm run openapi:gen && npm run i18n:gen-keys && git status --porcelain
cd /Users/ashokhein/github/wt-ai-gap-b && git add -A && git commit -m "feat: competition-scoped schedule restore (#386)"
```

`openapi:gen` **will** rewrite the generated spec here — that is expected, and committing its output is the point of running it.

### Task 3: The console calls the new endpoint instead of looping

**Files:**
- Modify: `apps/web/src/components/v2/board/ai-joint-apply.ts:184-200` (`undoJointApply`)
- Modify: `apps/web/src/components/v2/board/ai-competition-console.tsx` (the undo call site and its result copy)
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`
- Test: `apps/web/src/components/v2/board/__tests__/ai-joint-apply.test.ts`

**Interfaces:**
- Consumes: the endpoint and `CompetitionRestoreOut` shape from Task 2.
- Produces: `undoJointApply` keeps the name and the `{ ok, failed }` return so the console's existing partial-undo copy keeps working, but gains a `competitionId` parameter.

- [ ] **Step 1: Write the failing test**

In `apps/web/src/components/v2/board/__tests__/ai-joint-apply.test.ts`:

```ts
it("undoes a joint apply with ONE competition-scoped call, not N per-division calls (#386)", async () => {
  const calls: string[] = [];
  const api = (async (path: string) => {
    calls.push(path);
    return { restored: [{ division_id: "d1", watermark: 3, steps: 1 }], failed: [], ok: true };
  }) as unknown as JointApplyApi;

  const out = await undoJointApply("comp-1", [{ divisionId: "d1", checkpointId: "cp1" }], api);

  expect(calls).toEqual(["/api/v1/competitions/comp-1/schedule/restore"]);
  expect(out.ok).toBe(true);
  expect(out.failed).toEqual([]);
});

it("surfaces the server's per-division failures", async () => {
  const api = (async () => ({
    restored: [{ division_id: "d1", watermark: 3, steps: 1 }],
    failed: [{ division_id: "d2", reason: "checkpoint not found" }],
    ok: false,
  })) as unknown as JointApplyApi;

  const out = await undoJointApply(
    "comp-1",
    [
      { divisionId: "d1", checkpointId: "cp1" },
      { divisionId: "d2", checkpointId: "cp2" },
    ],
    api,
  );

  expect(out.ok).toBe(false);
  expect(out.failed).toEqual(["d2"]);
});
```

- [ ] **Step 2: Run and confirm it fails**

```bash
cd /Users/ashokhein/github/wt-ai-gap-b && npx vitest run \
  src/components/v2/board/__tests__/ai-joint-apply.test.ts \
  --root apps/web --reporter=json --outputFile=/tmp/b3.json > /dev/null 2>&1; echo "EXIT=$?"
cd /Users/ashokhein/github/wt-ai-gap-b && node -e "const r=require('/tmp/b3.json');console.log(r.numPassedTests,'/',r.numTotalTests,'failedSuites',r.numFailedTestSuites)"
```

Expected: fails on the argument count / the recorded call paths.

- [ ] **Step 3: Rewrite `undoJointApply`**

```ts
/**
 * Undo one joint apply (#386).
 *
 * One competition-scoped call. This used to loop the per-division restore from
 * the browser, so the apply was atomic while the undo was N independent
 * restores — and abandoning the tab part-way left a half-restored board. The
 * server now takes every division's lock in sorted order and reports per
 * division; the shape below is unchanged so the console's partial-undo copy
 * still reads the same field.
 */
export async function undoJointApply(
  competitionId: string,
  checkpoints: JointCheckpoint[],
  api: JointApplyApi = apiV1,
): Promise<{ ok: boolean; failed: string[] }> {
  try {
    const out = await api<{
      restored: { division_id: string; watermark: number; steps: number }[];
      failed: { division_id: string; reason: string }[];
      ok: boolean;
    }>(`/api/v1/competitions/${competitionId}/schedule/restore`, {
      method: "POST",
      json: {
        checkpoints: checkpoints.map((c) => ({
          division_id: c.divisionId,
          checkpoint_id: c.checkpointId,
        })),
        confirm: true,
      },
    });
    return { ok: out.ok, failed: out.failed.map((f) => f.division_id) };
  } catch {
    // The call itself failed — nothing was restored, and saying "some divisions
    // failed" would be a guess. Report every division as unrestored.
    return { ok: false, failed: checkpoints.map((c) => c.divisionId) };
  }
}
```

- [ ] **Step 4: Update the console call site**

In `ai-competition-console.tsx`, pass `competitionId` as the new first argument. The component already holds it as a prop. Do not change the copy that renders `failed` — it is already honest, and Task 5 guards the help article that was not.

- [ ] **Step 5: Run the board suite**

```bash
cd /Users/ashokhein/github/wt-ai-gap-b && npx vitest run src/components/v2 \
  --root apps/web --reporter=json --outputFile=/tmp/b4.json > /dev/null 2>&1; echo "EXIT=$?"
cd /Users/ashokhein/github/wt-ai-gap-b && node -e "const r=require('/tmp/b4.json');console.log(r.numPassedTests,'/',r.numTotalTests,'failedSuites',r.numFailedTestSuites)"
```

- [ ] **Step 6: E2E — apply a joint schedule, undo it, assert both divisions rolled back**

Extend `apps/web/e2e/ai-architect.spec.ts:762` (the competition-board test, which already applies) with an undo. Assert both divisions are back at their pre-AI times, and that exactly **one** request hit `/schedule/restore` — count it with `page.on("request", …)`. The request count is the regression assertion: N calls means the client is still looping.

`ai-architect.spec.ts:197` ends in `→ apply → undo` on the single-division path; that one still uses the per-division restore and must keep passing unchanged.

- [ ] **Step 7: Smoke + mobile**

```bash
cd /Users/ashokhein/github/wt-ai-gap-b && npm run test:smoke
cd /Users/ashokhein/github/wt-ai-gap-b && npx playwright test --project=mobile-se apps/web/e2e/ai-architect.spec.ts
```

- [ ] **Step 8: Pre-commit gate, then commit**

```bash
cd /Users/ashokhein/github/wt-ai-gap-b && npm run openapi:gen && npm run i18n:gen-keys && git status --porcelain
cd /Users/ashokhein/github/wt-ai-gap-b && git add -A && git commit -m "feat: joint undo is one competition-scoped call (#386)"
```

### Task 4: Document the joint 3/hour limit (#391)

Unit + regression only — no E2E, no smoke. A Playwright run cannot meaningfully assert a markdown paragraph.

**Files:**
- Modify: `apps/web/content/help/scheduling/ai-scheduling.md` (the "Two more limits worth knowing" block, currently line 187)
- Test: `apps/web/src/lib/__tests__/help-copy-truth.test.ts`

**Interfaces:** none.

- [ ] **Step 1: Write the failing test**

The help tree is English-only — no i18n work is owed here. Add to `apps/web/src/lib/__tests__/help-copy-truth.test.ts`, using the same loaded-markdown idiom the file already uses for real articles (see its line ~216):

```ts
it("states the joint run's own hourly limit, and that it is competition-keyed (#391)", () => {
  // The two single-division limits are documented; the joint one is TIGHTER and
  // keyed to a different subject, so silence about it reads as "same as above".
  expect(aiScheduling).toMatch(/\b3\b[^.]{0,60}\bhour\b/i);
  expect(aiScheduling).toMatch(/competition/i);
});
```

- [ ] **Step 2: Run and confirm it fails**

```bash
cd /Users/ashokhein/github/wt-ai-gap-b && npx vitest run src/lib/__tests__/help-copy-truth.test.ts \
  --root apps/web --reporter=json --outputFile=/tmp/b5.json > /dev/null 2>&1; echo "EXIT=$?"
cd /Users/ashokhein/github/wt-ai-gap-b && node -e "const r=require('/tmp/b5.json');console.log(r.numPassedTests,'/',r.numTotalTests,'failedSuites',r.numFailedTestSuites)"
```

- [ ] **Step 3: Edit the article**

The block currently reads "Two more limits worth knowing:" with two bullets. Make it three:

```md
Three more limits worth knowing:

- A joint run needs **at least two divisions**. To schedule one on its own, open its own schedule page.
- The whole run is capped at **500 fixtures to place**, the same ceiling a single division has. Over that, run the divisions in smaller groups.
- A joint run has its own burst brake of **3 runs an hour, counted per competition** — not per division, and tighter than the 5 an hour a single division gets. Two divisions scheduled together spend one joint run between them, out of the competition's three, rather than one each out of their own five.
```

The value is `ai-plan-competition:${competitionId}`, 3/hour, at `competition-schedule-ai.ts:1660`. If that number has changed, the article follows the code, not this plan.

- [ ] **Step 4: Run the test — expect pass. Then commit**

```bash
cd /Users/ashokhein/github/wt-ai-gap-b && npm run openapi:gen && npm run i18n:gen-keys && git status --porcelain
cd /Users/ashokhein/github/wt-ai-gap-b && git add -A && git commit -m "docs: document the joint AI run rate limit (#391)"
```

### Task 5: Guard the joint-undo sentence (#392)

Unit + regression only.

The article used to claim a joint apply gives *"each division its own before-AI save point, so one undo puts the whole thing back."* That was false and was corrected. Nothing stops it coming back. After Task 3 the undo is one call, but it is still **not** all-or-nothing — a per-division failure is reported, so the sentence would still be a lie.

**Files:**
- Modify: `apps/web/src/lib/copy-truth.ts`
- Test: `apps/web/src/lib/__tests__/help-copy-truth.test.ts`

**Interfaces:**
- Produces: `export const FALSE_JOINT_UNDO_PATTERNS: RegExp[]` and
  `export function jointUndoFaults(label: string, markdown: string): string[]`.

- [ ] **Step 1: Write the failing tests — including the fire test**

The corpus check is the point. An empty corpus leaves the guard green while testing nothing, which is worse than no guard because it reads as coverage.

```ts
describe("joint undo copy guard (#392)", () => {
  it("fires on the sentence that was actually wrong", () => {
    expect(
      jointUndoFaults("x", "Each division gets its own before-AI save point, so one undo puts the whole thing back."),
    ).not.toEqual([]);
  });

  it("fires on the synonyms an editor would reach for", () => {
    for (const s of [
      "A single undo restores every division at once.",
      "One click puts all the divisions back.",
      "Undo rolls back the whole joint apply in one step.",
    ]) {
      expect(jointUndoFaults("x", s), s).not.toEqual([]);
    }
  });

  it("does not fire on the true sentence", () => {
    expect(
      jointUndoFaults(
        "x",
        "Each division gets its own before-AI save point, and a restore that fails doesn't stop the rest going back.",
      ),
    ).toEqual([]);
  });

  it("the real article is clean", () => {
    // If this asserts against an EMPTY string the guard proves nothing — the
    // fire tests above exist so a vacuous corpus cannot pass unnoticed.
    expect(aiScheduling.length).toBeGreaterThan(1000);
    expect(jointUndoFaults("ai-scheduling.md", aiScheduling)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and confirm they fail**

```bash
cd /Users/ashokhein/github/wt-ai-gap-b && npx vitest run src/lib/__tests__/help-copy-truth.test.ts \
  --root apps/web --reporter=json --outputFile=/tmp/b6.json > /dev/null 2>&1; echo "EXIT=$?"
cd /Users/ashokhein/github/wt-ai-gap-b && node -e "const r=require('/tmp/b6.json');console.log(r.numPassedTests,'/',r.numTotalTests,'failedSuites',r.numFailedTestSuites)"
```

- [ ] **Step 3: Add the patterns and the scoped fault function**

In `apps/web/src/lib/copy-truth.ts`, following the `RETIRED_AI_RUN_CAP_PATTERNS` idiom (a pattern list, then a sentence-scoped fault function that skips true denials):

```ts
/**
 * A joint apply is ATOMIC; the undo is not (#386, #392). The server restores
 * every division the apply wrote, in one call, under every division's lock —
 * but it reports per-division failures rather than rolling the successes back.
 * So copy may say the apply is all-or-nothing. It may NOT say the undo is.
 *
 * This is the one help claim on this surface about whether the organiser's work
 * survives a failure, which is the claim they will act on.
 *
 * SCOPE: joint-scheduling copy only. A single-division undo genuinely does put
 * everything back in one step, and that sentence must stay writable.
 */
export const FALSE_JOINT_UNDO_PATTERNS = [
  /\b(one|a\s+single|1)\s+(undo|click|step|restore)\b[^.;]{0,60}\b(all|every|whole|entire|both)\b/i,
  /\b(all|every|whole|entire|both)\s+(the\s+)?divisions?\b[^.;]{0,40}\b(at\s+once|in\s+one\s+(go|step|click))\b/i,
  /\bundo\b[^.;]{0,40}\b(the\s+)?(whole|entire)\s+(thing|apply|run|schedule)\b/i,
  /\brolls?\s+back\b[^.;]{0,40}\b(the\s+)?(whole|entire)\s+(joint\s+)?apply\b/i,
];

/** Joint-undo scan, sentence-scoped like {@link retiredRunCapProseFaults}. */
export function jointUndoFaults(label: string, markdown: string): string[] {
  const faults: string[] = [];
  for (const block of claimTexts(markdown)) {
    for (const sentence of sentences(block)) {
      for (const p of FALSE_JOINT_UNDO_PATTERNS) {
        if (!p.test(sentence)) continue;
        faults.push(`${label}: "${sentence.slice(0, 72)}…" claims a joint undo is all-or-nothing: ${p.source}`);
      }
    }
  }
  return faults;
}
```

If a fire test does not match, widen the pattern and add the missed sentence to the fire test — do not narrow the test to fit the pattern. That inversion is what the `RETIRED_AI_RUN_CAP_PATTERNS` "Fix round 2" comments are a record of.

- [ ] **Step 4: Run — expect green. Then commit**

```bash
cd /Users/ashokhein/github/wt-ai-gap-b && npm run openapi:gen && npm run i18n:gen-keys && git status --porcelain
cd /Users/ashokhein/github/wt-ai-gap-b && git add -A && git commit -m "test: guard the joint-undo sentence against regressing (#392)"
```

---

## Group A — quote/charge integrity (#385, #387, #383, #384)

Worktree: `/Users/ashokhein/github/wt-ai-gap-a`, branch `ai-gap-a-quote-integrity` — **create it before starting** (see Appendix).

**One implementer pass, in this order.** These four cannot be split: #385/#387 and #383/#384 all edit `ai-console.tsx` and the quote surfaces.

**Corrections to the issues, verified against the tree:**

- `ai-joint-run.ts` does **not** call the weights functions. It imports only `isRung`/`Rung`. #385's client blast radius is `ai-quote-card.tsx` (which owns `quoteFor`) and `ai-officials-review.tsx`.
- `quoteFor` is **not** in `ai-rung.ts`. It lives at `ai-quote-card.tsx:89-92` and already takes an optional `weights` — the seam for #385 exists.
- `schedule-board.tsx` is itself `"use client"` (line 1). "Thread from the server" therefore means a provider seeded by the RSC that renders the board, not a prop on the board.

### Task 6: Resolve rung weights on the server and provide them to the client

**Files:**
- Modify: `apps/web/src/lib/ai-rung.ts` (export a single resolver)
- Create: `apps/web/src/components/v2/board/rung-config-provider.tsx`
- Modify: the RSC that renders `ScheduleBoard` (find it: `grep -rln "<ScheduleBoard" apps/web/src/app`)
- Modify: `apps/web/src/components/v2/board/ai-quote-card.tsx`
- Modify: `apps/web/src/components/v2/board/ai-officials-review.tsx`
- Test: `apps/web/src/components/v2/board/__tests__/rung-config-provider.test.tsx`

**Interfaces:**
- Produces:

```ts
// lib/ai-rung.ts
export interface RungConfig {
  scheduling: RungWeights;
  officials: RungWeights;
  /** Budget for 1..6 credits, resolved server-side. Index 0 is 1 credit. */
  budgets: number[];
}
export function resolveRungConfig(): RungConfig;

// board/rung-config-provider.tsx
export function RungConfigProvider(props: { value: RungConfig; children: React.ReactNode }): JSX.Element;
export function useRungConfig(): RungConfig;
```

Tasks 7 and 9 consume `useRungConfig()`.

- [ ] **Step 1: Write the failing test**

The class of bug here is invisible to a server-side suite — every vitest run has a working `process.env`. So the test must assert the **prop/context value reaching the card**, not the pure function's return.

```tsx
it("prices from the server-provided config, not from process.env (#385)", () => {
  // A weight the client could never have read: envNumber uses a COMPUTED key,
  // which Next cannot statically replace, so a "use client" module always gets
  // the fallback. If the card renders this price, it read the provider.
  const config: RungConfig = {
    scheduling: { entrantWeight: 99, courtWeight: 99, s1: 1, s2: 2, estTokensAtS1: 1, estTokensAtS2: 2 },
    officials: officialsRungWeights(),
    budgets: [32_000, 64_000, 128_000, 160_000, 192_000, 224_000],
  };
  const tree = render(
    <RungConfigProvider value={config}>
      <AiQuoteCard lines={[{ key: "d1", label: null, input: { movableFixtures: 4, entrants: 8, courts: 2 }, chosen: null }]}
                   onChange={() => {}} msg={msgStub} busy={false} />
    </RungConfigProvider>,
  );
  // s1=1, s2=2 with those weights puts any real division on rung 3.
  expect(creditsShown(tree)).toBe(3);
});

it("throws rather than silently defaulting when no provider is mounted", () => {
  expect(() => renderHookBare(useRungConfig)).toThrow(/RungConfigProvider/);
});
```

The second test matters more than it looks: a `useContext` default value would reintroduce exactly the silent-fallback failure this task exists to remove.

- [ ] **Step 2: Run and confirm both fail**

```bash
cd /Users/ashokhein/github/wt-ai-gap-a && npx vitest run src/components/v2/board/__tests__/rung-config-provider.test.tsx \
  --root apps/web --reporter=json --outputFile=/tmp/a1.json > /dev/null 2>&1; echo "EXIT=$?"
cd /Users/ashokhein/github/wt-ai-gap-a && node -e "const r=require('/tmp/a1.json');console.log(r.numPassedTests,'/',r.numTotalTests,'failedSuites',r.numFailedTestSuites)"
```

- [ ] **Step 3: Add the resolver to `lib/ai-rung.ts`**

Leave `schedulingRungWeights`, `officialsRungWeights` and `tokenBudgetForCredits` exactly as they are — the server still calls them, and a wholesale rename would touch every server pricing path for no benefit.

```ts
/**
 * Every AI_RUNG_* override, resolved in one place, for handing to the client
 * (#385).
 *
 * `envNumber` reads `process.env[name]` with a COMPUTED key. Next replaces
 * `process.env.FOO` by static substitution, and only for NEXT_PUBLIC_-prefixed
 * names, so a computed lookup is never replaced at all: in a "use client"
 * module every call falls through to its fallback. The card therefore priced on
 * defaults while the server priced on the overrides — and when an override
 * RAISES a price that is a silent under-quote, the organiser charged more than
 * the confirm card promised.
 *
 * Nothing sets these variables today, which is exactly why this is worth
 * fixing now: the mechanism exists to be used in production WITHOUT a deploy
 * (see tokenBudgetForCredits' own note), so the first calibration change would
 * introduce the divergence.
 *
 * Server-only. Call it in an RSC and pass the result through RungConfigProvider.
 */
export function resolveRungConfig(): RungConfig {
  return {
    scheduling: schedulingRungWeights(),
    officials: officialsRungWeights(),
    budgets: [1, 2, 3, 4, 5, 6].map((n) => tokenBudgetForCredits(n)),
  };
}
```

- [ ] **Step 4: Write the provider**

```tsx
"use client";
import { createContext, useContext } from "react";
import type { RungConfig } from "@/lib/ai-rung";

const Ctx = createContext<RungConfig | null>(null);

/** Seeded by the RSC that renders the board — see resolveRungConfig (#385). */
export function RungConfigProvider({ value, children }: { value: RungConfig; children: React.ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** No default value, deliberately: a fallback here would reintroduce the exact
 *  silent divergence #385 is about — the card would price on defaults and say
 *  nothing. A missing provider is a bug, so it throws. */
export function useRungConfig(): RungConfig {
  const v = useContext(Ctx);
  if (v === null) throw new Error("useRungConfig requires a RungConfigProvider");
  return v;
}
```

- [ ] **Step 5: Seed it from the RSC**

Find the server component rendering `ScheduleBoard`:

```bash
cd /Users/ashokhein/github/wt-ai-gap-a && grep -ran "<ScheduleBoard" apps/web/src/app
```

Wrap the board in `<RungConfigProvider value={resolveRungConfig()}>`. If several routes mount the board, wrap each — or hoist to the nearest shared layout, whichever needs fewer edits. Confirm the file has no `"use client"` directive before calling `resolveRungConfig()` in it.

- [ ] **Step 6: Consume it in the two client surfaces**

`ai-quote-card.tsx` — `quoteFor` keeps its optional `weights` (server tests call it directly), but the component stops falling back to `schedulingRungWeights()`:

```tsx
export function AiQuoteCard({ lines, onChange, msg, busy, weights, freeDraft = false }: …) {
  const cfg = useRungConfig();
  const quote = quoteFor(lines, { weights: weights ?? cfg.scheduling, freeDraft });
```

Replace the `tokenBudgetForCredits(...)` calls at `ai-quote-card.tsx:170,179-181` with `cfg.budgets[n - 1] ?? tokenBudgetForCredits(n)` — the fallback covers credits above 6, which the ladder does not currently produce.

`ai-officials-review.tsx:214` — replace `useMemo(() => officialsRungWeights(), [])` with `useRungConfig().officials`.

- [ ] **Step 7: Run the board suite**

```bash
cd /Users/ashokhein/github/wt-ai-gap-a && npx vitest run src/components/v2 \
  --root apps/web --reporter=json --outputFile=/tmp/a2.json > /dev/null 2>&1; echo "EXIT=$?"
cd /Users/ashokhein/github/wt-ai-gap-a && node -e "const r=require('/tmp/a2.json');console.log(r.numPassedTests,'/',r.numTotalTests,'failedSuites',r.numFailedTestSuites)"
```

Existing card tests will fail with the "requires a RungConfigProvider" throw. That is the correct failure — wrap their render helper in the provider rather than giving the context a default.

- [ ] **Step 8: E2E + smoke + screenshots (desktop and 375px), then pre-commit gate and commit**

```bash
cd /Users/ashokhein/github/wt-ai-gap-a && npm run openapi:gen && npm run i18n:gen-keys && git status --porcelain
cd /Users/ashokhein/github/wt-ai-gap-a && git add -A && git commit -m "fix: client quote cards price on the server's rung config (#385)"
```

### Task 7: Compare what was charged to what was quoted (#387)

The card computes its quote by calling the same pure function the server calls. That design is deliberate and good — no per-keystroke fetch, one arithmetic implementation. It rests on one premise: same function, same inputs, same environment. PR #359 found three ways that premise breaks; Task 6 closes the largest remaining one. This task makes any residual divergence **visible instead of silent**.

**Detection happens server-side.** The client sends the number its card showed; the server compares it against what it actually charged. That way the telemetry fires even if nobody is looking at the screen, and the event is written by the side that knows the truth.

**Files:**
- Modify: `apps/web/src/server/api-v1/schemas.ts` — add `quoted_credits` to the AI run request schemas, and `quote_mismatch` to `AiRunPriceFields`
- Modify: `apps/web/src/server/usecases/schedule-ai.ts`, `competition-schedule-ai.ts`, `officials-ai.ts` — compare and record
- Modify: `apps/web/src/components/v2/board/ai-console.tsx`, `ai-competition-console.tsx` — send `quoted_credits`, render the receipt line
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`
- Test: `apps/web/src/server/usecases/__tests__/ai-quote-mismatch.test.ts`, plus a component test for the receipt line

**Interfaces:**
- Consumes: `useRungConfig()` from Task 6.
- Produces: `quote_mismatch?: { quoted: number; charged: number }` on `AiRunPriceFields`, consumed by the receipt line and by Task 9's officials card.

- [ ] **Step 1: Write the failing server test**

```ts
it("records a competition_event when the charge differs from the quote (#387)", async () => {
  const { auth, divisionId, competitionId } = await seedPlannableDivision();
  // The card said 1; the server will price this division at 2.
  const plan = await runAiPlan(auth, divisionId, { ...baseInput, quoted_credits: 1 });

  expect(plan.quote_mismatch).toEqual({ quoted: 1, charged: plan.credits });
  const [ev] = await sql<{ type: string; payload: { quoted: number; charged: number } }[]>`
    select type, payload from competition_events
     where competition_id = ${competitionId} and type = 'schedule.ai_quote_mismatch'`;
  expect(ev!.payload.quoted).toBe(1);
  expect(ev!.payload.charged).toBe(plan.credits);
});

it("records nothing and reports nothing when they agree", async () => {
  const { auth, divisionId, competitionId } = await seedPlannableDivision();
  const first = await runAiPlan(auth, divisionId, { ...baseInput });
  const again = await runAiPlan(auth, divisionId, { ...baseInput, quoted_credits: first.credits });

  expect(again.quote_mismatch).toBeUndefined();
  const rows = await sql`
    select 1 from competition_events
     where competition_id = ${competitionId} and type = 'schedule.ai_quote_mismatch'`;
  expect(rows).toHaveLength(0);
});

it("an omitted quoted_credits is not a mismatch", async () => {
  // Older clients, and every server-side caller, send nothing. Silence must not
  // read as "quoted zero".
  const { auth, divisionId } = await seedPlannableDivision();
  const plan = await runAiPlan(auth, divisionId, { ...baseInput });
  expect(plan.quote_mismatch).toBeUndefined();
});
```

- [ ] **Step 2: Run and confirm they fail**

```bash
cd /Users/ashokhein/github/wt-ai-gap-a && npx vitest run src/server/usecases/__tests__/ai-quote-mismatch.test.ts \
  --root apps/web --reporter=json --outputFile=/tmp/a3.json > /dev/null 2>&1; echo "EXIT=$?"
cd /Users/ashokhein/github/wt-ai-gap-a && node -e "const r=require('/tmp/a3.json');console.log(r.numPassedTests,'/',r.numTotalTests,'failedSuites',r.numFailedTestSuites)"
```

- [ ] **Step 3: Extend the schemas**

In `schemas.ts`, add to `AiRunPriceFields` (line 1682):

```ts
  /** Set only when the client's confirm card quoted a different number than the
   *  server charged (#387). Both directions are reported: over-quote is a bad
   *  surprise, under-quote is a billing complaint. */
  quote_mismatch: z.object({ quoted: z.number().int(), charged: z.number().int() }).optional(),
```

And to each AI run request schema:

```ts
  /** What the confirm card showed. Optional — server-side callers send none, and
   *  an absent value must never be read as zero. */
  quoted_credits: z.number().int().positive().optional(),
```

- [ ] **Step 4: Compare and record, in one shared helper**

Add to a module all three usecases already import (or a new `lib/ai-quote-mismatch.ts`):

```ts
/** Compare the card's quote to the charge, record the divergence, return it.
 *  Called by all three run paths so they cannot disagree about what counts as a
 *  mismatch — the same fork that produced #387 in the first place. */
export async function recordQuoteMismatch(
  tx: Tx,
  ctx: { competitionId: string; orgId: string; actorId: string; divisionIds: string[] },
  quoted: number | undefined,
  charged: number,
): Promise<{ quoted: number; charged: number } | undefined> {
  if (quoted === undefined || quoted === charged) return undefined;
  await tx`
    insert into competition_events (competition_id, org_id, type, payload, actor_id)
    values (${ctx.competitionId}, ${ctx.orgId}, 'schedule.ai_quote_mismatch',
            ${tx.json({ quoted, charged, division_ids: ctx.divisionIds } as never)}, ${ctx.actorId})`;
  return { quoted, charged };
}
```

Call it in `schedule-ai.ts`, `competition-schedule-ai.ts` and `officials-ai.ts` right after the charge settles, and spread the result onto the response.

- [ ] **Step 5: Send the quote and render the line**

In `ai-console.tsx` and `ai-competition-console.tsx`, include `quoted_credits: <the number the card showed>` in the run body. Read it from the same `quoteFor(...)` call the card renders — not a recomputation, or the two can drift and this whole task measures nothing.

Render the receipt line when `plan.quote_mismatch` is present. New keys in all 4 dictionaries:

```json
"board.ai.quote.mismatchOver": "Quoted {quoted}, charged {charged}. You were charged more than the estimate — please tell us.",
"board.ai.quote.mismatchUnder": "Quoted {quoted}, charged {charged}. You were charged less than the estimate."
```

Then translate both into `es`, `fr` and `nl`. Do not leave English in the other three files.

- [ ] **Step 6: Component test for the receipt line**

Assert the line renders in both directions and is absent when `quote_mismatch` is undefined.

- [ ] **Step 7: E2E + smoke + screenshots (desktop, 375px)**

- [ ] **Step 8: Pre-commit gate, then commit**

```bash
cd /Users/ashokhein/github/wt-ai-gap-a && npm run openapi:gen && npm run i18n:gen-keys && git status --porcelain
cd /Users/ashokhein/github/wt-ai-gap-a && git add -A && git commit -m "feat: report and record a quote/charge mismatch (#387)"
```

### Task 8: The officials free draft stops auto-spending (#383)

The console auto-fires a draft on entering the officials step (`ai-console.tsx:699-714`), and that run spends 1 credit before any confirm surface renders. `freeDraftQuote` returns `credits: 1` — "free" means free of *model* cost, not free of charge. The arithmetic is correct and intentional, locked by three tests, one of which forces rung 3 and still asserts a 1-credit charge. **Do not change the price.** The gap is the surface.

**Files:**
- Modify: `apps/web/src/components/v2/board/ai-console.tsx:699-714`
- Modify: `apps/web/src/components/v2/board/ai-officials-review.tsx` (mount the card in the pre-run state)
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`
- Test: `apps/web/src/components/v2/board/__tests__/ai-console-officials-autorun.test.tsx`

**Interfaces:**
- Consumes: `useRungConfig()` (Task 6); `AiQuoteCard` with `freeDraft` (already supports it, `ai-quote-card.tsx:139`).

- [ ] **Step 1: Write the failing test**

```tsx
it("does not spend a credit before the organiser has seen a price (#383)", async () => {
  const posts: string[] = [];
  const island = renderConsoleAtOfficialsStep({ onPost: (p) => posts.push(p) });
  // Entering the step must not fire the run.
  expect(posts.filter((p) => p.includes("/officials/ai-plan"))).toHaveLength(0);
  // The flat 1-credit price is on screen instead.
  expect(creditsShown(island)).toBe(1);
});

it("runs the draft when the organiser presses the button", async () => {
  const posts: string[] = [];
  const island = renderConsoleAtOfficialsStep({ onPost: (p) => posts.push(p) });
  await press(island, "board.ai.officials.run");
  expect(posts.filter((p) => p.includes("/officials/ai-plan"))).toHaveLength(1);
});
```

- [ ] **Step 2: Run and confirm the first test fails** (the console fires on mount today)

```bash
cd /Users/ashokhein/github/wt-ai-gap-a && npx vitest run src/components/v2/board/__tests__/ai-console-officials-autorun.test.tsx \
  --root apps/web --reporter=json --outputFile=/tmp/a4.json > /dev/null 2>&1; echo "EXIT=$?"
cd /Users/ashokhein/github/wt-ai-gap-a && node -e "const r=require('/tmp/a4.json');console.log(r.numPassedTests,'/',r.numTotalTests,'failedSuites',r.numFailedTestSuites)"
```

- [ ] **Step 3: Delete the auto-run effect**

Remove the `useEffect` at `ai-console.tsx:699-714` entirely, along with the now-unused `officialsAutoStarted` ref. Leave a comment where it was:

```tsx
// #383: the officials step used to auto-fire the solver draft here. That run
// spends 1 credit (freeDraftQuote is a price CAP, not zero), so the organiser
// was charged before a confirm card could render — the one credit-spending path
// left with no pre-spend surface, and the one they could not decline. The card
// below now carries the flat 1-credit price and a button, exactly as this step's
// siblings do.
```

- [ ] **Step 4: Mount the card in the pre-run state**

In `ai-officials-review.tsx`, when `plan === null`, render `AiQuoteCard` with `freeDraft` and a run button. The `freeDraft` flag is already computed there (`:216`: `instruction.trim() === "" && adoptInstruction.trim() === ""`), and `board.ai.quote.freeDraft` already exists in the dictionaries — reuse it rather than adding a new string.

Add only the button label, in all 4 locales:

```json
"board.ai.officials.run": "Draft the duty spread"
```

- [ ] **Step 5: Run the tests, then the board suite** (both expected green)

- [ ] **Step 6: E2E — the balance is unchanged until the button is pressed**

This is the assertion that would have caught the bug. In `apps/web/e2e/ai-architect.spec.ts`, read the credit balance before entering the officials step and after, assert it is unchanged, then press the button and assert it dropped by exactly 1.

**First read `ai-architect.spec.ts:509`** — *"the officials step prices itself: free draft with no picker, priced once a brief is typed"*. It encodes the current arrive-and-it-has-run behaviour. Update it to press the button, do not delete it: its real subject is that a free draft shows no rung picker, which this task does not change.

`ai-architect.spec.ts:197` (`… → officials → apply → undo`) also gains a click at the officials step.

- [ ] **Step 7: Smoke + mobile, pre-commit gate, commit**

```bash
cd /Users/ashokhein/github/wt-ai-gap-a && npm run test:smoke
cd /Users/ashokhein/github/wt-ai-gap-a && npx playwright test --project=mobile-se apps/web/e2e/ai-architect.spec.ts
```

```bash
cd /Users/ashokhein/github/wt-ai-gap-a && npm run openapi:gen && npm run i18n:gen-keys && git status --porcelain
cd /Users/ashokhein/github/wt-ai-gap-a && git add -A && git commit -m "fix: officials draft asks before it spends (#383)"
```

### Task 9: An adopted candidate reaches the solve (#384)

Adopting a candidate while the instruction is empty silently discards the adoption. Three symptoms, one root: `pack.prior` is carried into the pack and consumed **only** as a diff baseline (`officials-ai.ts:756`), never as a solve input.

`prior` carries two fields doing unrelated jobs. `prior.instruction` is the previous run's sentence. `prior.assignments` is the grid on screen with the organiser's adoption patched in (`ai-console.tsx:906`) — data produced by the click that just happened, not a stale instruction replayed. **This task reads `prior.assignments` only.** Nothing re-executes `prior.instruction`; on the empty-instruction path there is no instruction to execute, which is the premise of that branch (zero LLM calls, deterministic solver, flat 1 credit).

Task 8 removes the auto-run that made this the *default* path. It does not fix it — an organiser who clears the box and adopts still lands here.

**Files:**
- Modify: `apps/web/src/server/usecases/officials-ai.ts:891-908` (the empty-instruction branch) and `draftAsPlan` (`:732-748`)
- Test: `apps/web/src/server/usecases/__tests__/officials-ai-adopt.test.ts`

**Interfaces:**
- Consumes: `OfficialsPack.prior: { instruction: string; assignments: FixtureOfficial[] } | null` (`:110-134`).
- Produces: `draftAsPlan(pack)` gains no new parameter — it reads `pack.prior` itself, so every caller keeps its call site.

- [ ] **Step 1: Write the failing tests**

```ts
it("solves from the adopted assignments when the instruction is empty (#384)", async () => {
  const pack = packWithPrior({
    instruction: "",
    priorAssignments: [{ fixtureId: "f1", roleKey: "referee", officialId: "adopted-official", locked: false }],
  });
  const out = await runOfficialsAiPlan(pack);
  const f1 = out.plan.assignments.find((a) => a.fixture_id === "f1");
  expect(f1!.official_id).toBe("adopted-official");
});

it("does not report the organiser's own adoption as changed", async () => {
  // Symptom 3: the grid diffed a locked-derived draft against the prior the
  // organiser adopted from, and highlighted their adoption as AI-overwritten.
  const pack = packWithPrior({
    instruction: "",
    priorAssignments: [{ fixtureId: "f1", roleKey: "referee", officialId: "adopted-official", locked: false }],
  });
  const res = await runOfficialsAiPlanAndDiff(pack);
  expect(res.diff.changed).not.toContain("f1");
  expect(res.diff.unchanged).toContain("f1");
});

it("still solves from locked when there is no prior", async () => {
  const pack = packWithPrior({ instruction: "", priorAssignments: null });
  const out = await runOfficialsAiPlan(pack);
  expect(out.plan.assignments.map((a) => a.official_id)).toEqual(
    pack.draft.map((d) => d.officialId),
  );
});

it("never re-executes prior.instruction on the empty path", async () => {
  const calls: unknown[] = [];
  const pack = packWithPrior({
    instruction: "",
    priorInstruction: "put Sam on every court",
    priorAssignments: [{ fixtureId: "f1", roleKey: "referee", officialId: "adopted-official", locked: false }],
  });
  await runOfficialsAiPlan(pack, undefined, providerRecording(calls));
  expect(calls, "the empty-instruction path makes zero model calls").toHaveLength(0);
});
```

- [ ] **Step 2: Run and confirm they fail**

```bash
cd /Users/ashokhein/github/wt-ai-gap-a && npx vitest run src/server/usecases/__tests__/officials-ai-adopt.test.ts \
  --root apps/web --reporter=json --outputFile=/tmp/a5.json > /dev/null 2>&1; echo "EXIT=$?"
cd /Users/ashokhein/github/wt-ai-gap-a && node -e "const r=require('/tmp/a5.json');console.log(r.numPassedTests,'/',r.numTotalTests,'failedSuites',r.numFailedTestSuites)"
```

- [ ] **Step 3: Read `pack.prior.assignments` in `draftAsPlan`**

```ts
/**
 * The deterministic draft, as a plan.
 *
 * #384: the baseline is the ADOPTED grid when there is one, and the solver
 * draft otherwise. Before this, an adopt with an empty instruction solved from
 * `locked`, so the adoption never reached the solve — while `officialsDiff`
 * DID read `pack.prior.assignments` as its baseline, which made the grid report
 * the organiser's own adoption as something the AI changed away.
 *
 * `pack.prior.instruction` is deliberately not read here. On this path there is
 * no instruction to execute; the previous run's sentence is not re-run.
 */
function draftAsPlan(pack: OfficialsPack): AiOfficialsPlan {
  const base = pack.prior ? pack.prior.assignments : pack.draft;
  const covered = new Set(base.map((a) => slotKey(a.fixtureId, a.roleKey)));
  const unfilled: AiOfficialsPlan["unfilled"] = [];
  for (const f of pack.fixtures) {
    for (const r of pack.policy.roles) {
      if (!covered.has(slotKey(f.id, r))) {
        unfilled.push({ fixture_id: f.id, role_key: r, reason: "no eligible official available" });
      }
    }
  }
  return {
    assignments: base.map((a) => ({ fixture_id: a.fixtureId, official_id: a.officialId, role_key: a.roleKey })),
    unfilled,
    explanations: [],
    summary: pack.prior
      ? "Adopted assignments kept; remaining slots from the deterministic solver."
      : "Default duty spread from the deterministic solver (no instruction given).",
  };
}
```

`officialsDiff` is **not** modified. It already reads `pack.prior.assignments` as its baseline; after this change the solve and the diff agree, and symptom 3 disappears without touching the diff at all.

The new summary string is model-facing/server-generated prose, not a dictionary key — check how `summary` is rendered before adding i18n work for it. If it reaches the screen verbatim, it needs a dictionary key in all 4 locales instead.

- [ ] **Step 4: Run the tests, then the whole officials suite**

```bash
cd /Users/ashokhein/github/wt-ai-gap-a && npx vitest run src/server/usecases/__tests__ \
  --root apps/web --reporter=json --outputFile=/tmp/a6.json > /dev/null 2>&1; echo "EXIT=$?"
cd /Users/ashokhein/github/wt-ai-gap-a && node -e "const r=require('/tmp/a6.json');console.log(r.numPassedTests,'/',r.numTotalTests,'failedSuites',r.numFailedTestSuites)"
```

- [ ] **Step 5: E2E — adopt a candidate with an empty instruction, assert the adopted official is in the applied grid**

- [ ] **Step 6: Smoke + screenshots, pre-commit gate, commit**

```bash
cd /Users/ashokhein/github/wt-ai-gap-a && npm run openapi:gen && npm run i18n:gen-keys && git status --porcelain
cd /Users/ashokhein/github/wt-ai-gap-a && git add -A && git commit -m "fix: an adopted officials candidate reaches the solve (#384)"
```

---

## Group D — billing-grant cron (#390)

Worktree: `/Users/ashokhein/github/wt-ai-gap-d`, branch `ai-gap-d-cron-antijoin`. **Runs in parallel with Group A** — file sets are disjoint (`lib/credits.ts` and its tests; no UI, no locale strings, no OpenAPI surface).

**Facts confirmed against the tree:**

- The wallet id **is** the subscription id. The sweep selects `s.id` and `grantMonthly(row.id, …)` builds `monthly:${walletId}:${period}` from it (`credits.ts:292`), so the anti-join can be written against `s.id` with no extra join.
- `monthlyPeriod()` is module-private (`credits.ts:184`) and returns `YYYY-MM`, UTC.
- `ai_credit_ledger.idempotency_key` is `text unique` (V320) — the anti-join is an index probe.
- `orgPlanKey` is **not** in `credits.ts`; it is imported from `@/lib/entitlements` (`credits.ts:28`).
- `checkEarnGrantVolumeAlert` runs **after** the sweep, in its own try/catch (`app/api/cron/billing-grant/route.ts:36-46`). Untouched by this change.

### Task 10: The sweep skips wallets already granted this period

**Files:**
- Modify: `apps/web/src/lib/credits.ts` — `grantMonthlyForAllWallets` (415-465)
- Test: `apps/web/src/lib/__tests__/credits-monthly-cron.test.ts`

**Interfaces:**
- Produces: `grantMonthlyForAllWallets` keeps its signature. **`wallets` changes meaning** — it becomes "wallets the sweep considered", i.e. the not-yet-granted set, not every subscription. Any test asserting `wallets` as a total must be updated, not worked around.

- [ ] **Step 1: Write the failing tests**

```ts
it("does not re-consider a wallet already granted this period (#390)", async () => {
  const orgId = await seedOrg();
  const subId = await setOrgPlan(orgId, "pro_plus");

  const first = await grantMonthlyForAllWallets({ walletIds: [subId] });
  expect(first.wallets).toBe(1);
  expect(first.granted).toBe(200);

  // Second run the same month: the wallet is filtered out by the sweep itself,
  // so it is never opened, locked, or re-read.
  const second = await grantMonthlyForAllWallets({ walletIds: [subId] });
  expect(second.wallets).toBe(0);
  expect(second.granted).toBe(0);
  expect(await balance(subId)).toBe(200);
});

it("still grants a wallet that has no key for this period", async () => {
  const orgId = await seedOrg();
  const subId = await setOrgPlan(orgId, "pro");
  const res = await grantMonthlyForAllWallets({ walletIds: [subId] });
  expect(res.wallets).toBe(1);
  expect(res.granted).toBeGreaterThan(0);
});

it("the anti-join is a pre-filter, not the guard — a concurrent double-run still grants once", async () => {
  const orgId = await seedOrg();
  const subId = await setOrgPlan(orgId, "pro_plus");
  // Both calls pass the anti-join (neither sees a key yet); the advisory lock
  // and the in-transaction key check must still make exactly one of them win.
  const [a, b] = await Promise.all([
    grantMonthlyForAllWallets({ walletIds: [subId] }),
    grantMonthlyForAllWallets({ walletIds: [subId] }),
  ]);
  expect(a.granted + b.granted).toBe(200);
  expect(await balance(subId)).toBe(200);
});

it("a zero-grant plan keeps re-qualifying, and that is harmless", async () => {
  // `delta <= 0` returns before the key is written (credits.ts:289), so a wallet
  // whose plan grants nothing never writes a key. It comes back every day and
  // grants nothing — documented, not fixed by the anti-join alone.
  const orgId = await seedOrg();
  const subId = await setOrgPlan(orgId, "community");
  const first = await grantMonthlyForAllWallets({ walletIds: [subId] });
  const second = await grantMonthlyForAllWallets({ walletIds: [subId] });
  expect(second.wallets).toBe(first.wallets);
  expect(second.granted).toBe(0);
});
```

The `community` plan's monthly entitlement must actually be zero for the last test to mean anything. Check `plan_entitlements` for `ai.credits.monthly` on `community` first; if it grants a positive amount, seed a plan that grants nothing instead, and say which in a comment.

- [ ] **Step 2: Run and confirm they fail**

```bash
cd /Users/ashokhein/github/wt-ai-gap-d && npx vitest run src/lib/__tests__/credits-monthly-cron.test.ts \
  --root apps/web --reporter=json --outputFile=/tmp/d1.json > /dev/null 2>&1; echo "EXIT=$?"
cd /Users/ashokhein/github/wt-ai-gap-d && node -e "const r=require('/tmp/d1.json');console.log(r.numPassedTests,'/',r.numTotalTests,'failedSuites',r.numFailedTestSuites)"
```

Expected: the first test fails on `second.wallets` — `1`, not `0`.

- [ ] **Step 3: Add the anti-join**

```ts
export async function grantMonthlyForAllWallets(
  opts: { walletIds?: readonly string[] } = {},
): Promise<{ wallets: number; granted: number; failed: number }> {
  const ids = opts.walletIds ?? null;
  const period = monthlyPeriod();
  const rows = await sql<
    { id: string; status: string; quantity_paid: number; rep_org_id: string; live_org_count: number }[]
  >`
    select s.id, s.status, s.quantity_paid, rep.id as rep_org_id, live.n as live_org_count
      from subscriptions s
      cross join lateral (
        select o.id from organizations o
         where o.subscription_id = s.id and o.deleted_at is null
         order by (o.status = 'suspended'), o.created_at
         limit 1
      ) rep
      cross join lateral (
        select count(*)::int as n from organizations o
         where o.subscription_id = s.id and o.deleted_at is null
      ) live
     where not exists (
       select 1 from ai_credit_ledger
        where idempotency_key = ${"monthly:"} || s.id || ${":" + period}
     )
     ${ids ? sql`and s.id in ${sql(ids as string[])}` : sql``}`;
```

Note the `where`/`and` change: the scoped branch used to be the only `where`. Getting this wrong produces a syntax error, not a silent bug — but check it.

Add the header note:

```ts
  // #390 — the anti-join is a PRE-FILTER, not a replacement for the guard.
  // Two overlapping runs can both pass it (neither sees a key yet), so the
  // `pg_advisory_xact_lock` and the in-transaction idempotency_key check in
  // `grantMonthly` (credits.ts:296-299) stay exactly as written. This change may
  // only ever REDUCE the candidate set.
  //
  // It does not reach zero rows on its own: `delta <= 0` returns before the key
  // is written (:289), so a wallet whose plan grants nothing never writes one
  // and re-qualifies every day. Harmless, and the reason Task 11 resolves the
  // plan in the sweep rather than per row.
  //
  // The DAILY cadence stays. It is deliberate — retry after a failed run, no
  // 28/29/30/31 or timezone edges, and it carries checkEarnGrantVolumeAlert,
  // which needs a genuinely daily poll. This makes the daily run cheap; it does
  // not make it rarer.
```

`monthlyPeriod` is already in scope — it is module-private in the same file, so no export is needed.

- [ ] **Step 4: Run — expect green. Then the whole credits suite**

```bash
cd /Users/ashokhein/github/wt-ai-gap-d && npx vitest run src/lib/__tests__ \
  --root apps/web --reporter=json --outputFile=/tmp/d2.json > /dev/null 2>&1; echo "EXIT=$?"
cd /Users/ashokhein/github/wt-ai-gap-d && node -e "const r=require('/tmp/d2.json');console.log(r.numPassedTests,'/',r.numTotalTests,'failedSuites',r.numFailedTestSuites)"
```

`credits-bootstrap-grant.test.ts` calls `grantMonthlyForAllWallets()` **unscoped** at line 67 and asserts the balance stays 10. That still holds — the wallet was granted at bootstrap, so the anti-join now filters it out and the balance is unchanged for a better reason than before. Update its comment to say so.

- [ ] **Step 5: Commit**

```bash
cd /Users/ashokhein/github/wt-ai-gap-d && npm run openapi:gen && npm run i18n:gen-keys && git status --porcelain
cd /Users/ashokhein/github/wt-ai-gap-d && git add -A && git commit -m "perf: skip already-granted wallets in the monthly sweep (#390)"
```

### Task 11: Resolve the plan in the sweep instead of per row

`orgPlanKey(row.rep_org_id)` is one query per row (`credits.ts:451`), and `grantMonthly`'s `plan_entitlements` lookup (`:284`) is another. That N+1 is the larger constant, and killing it is what makes a zero-row day genuinely free.

**Files:**
- Modify: `apps/web/src/lib/credits.ts`
- Read first: `apps/web/src/lib/entitlements.ts` — `orgPlanKey`
- Test: `apps/web/src/lib/__tests__/credits-monthly-cron.test.ts`

**Interfaces:**
- Consumes: Task 10's sweep.
- Produces: no signature change.

- [ ] **Step 1: Read `orgPlanKey` before writing anything**

```bash
cd /Users/ashokhein/github/wt-ai-gap-d && grep -an -A25 "export async function orgPlanKey" apps/web/src/lib/entitlements.ts
```

It may resolve through a billing group, a pass, or a cache. **Join its logic into the sweep only if you can reproduce it exactly.** If it is more than a plain column read, stop and batch instead: collect the distinct `rep_org_id`s and resolve them in one pass, keeping `orgPlanKey` as the single source of truth. A subtly different plan resolution in the cron would grant the wrong amount — a worse bug than the N+1.

- [ ] **Step 2: Write the failing test**

```ts
it("resolves every wallet's plan without a per-row query (#390)", async () => {
  const orgs = await Promise.all([seedOrg(), seedOrg(), seedOrg()]);
  const subs = await Promise.all(orgs.map((o) => setOrgPlan(o, "pro")));
  const before = queryCount();                       // count queries via the db test hook
  await grantMonthlyForAllWallets({ walletIds: subs });
  const perWallet = (queryCount() - before) / subs.length;
  // Was ~4 round trips per wallet: sweep row, orgPlanKey, entitlement, tx.
  expect(perWallet).toBeLessThan(3);
});
```

If the repo has no query-counting hook, do not invent a fragile one. Assert the observable instead: three wallets on three different plans each receive the right amount in one sweep, and add the round-trip claim as a comment with the measured numbers from a manual run.

- [ ] **Step 3: Implement, run, commit**

```bash
cd /Users/ashokhein/github/wt-ai-gap-d && npx vitest run src/lib/__tests__ \
  --root apps/web --reporter=json --outputFile=/tmp/d3.json > /dev/null 2>&1; echo "EXIT=$?"
cd /Users/ashokhein/github/wt-ai-gap-d && node -e "const r=require('/tmp/d3.json');console.log(r.numPassedTests,'/',r.numTotalTests,'failedSuites',r.numFailedTestSuites)"
cd /Users/ashokhein/github/wt-ai-gap-d && npm run openapi:gen && npm run i18n:gen-keys && git status --porcelain
cd /Users/ashokhein/github/wt-ai-gap-d && git add -A && git commit -m "perf: resolve wallet plans in the sweep, not per row (#390)"
```

---

## Group E — entitlements and checkpoints (#382)

Worktree: `/Users/ashokhein/github/wt-ai-gap-e`, branch `ai-gap-e-open-scheduling` — **create it after Group A merges** (see Appendix).

**Not parallel with Group A.** The checkpoint 402 surfaces in `ai-console-state.ts:452-475`, `ai-console.tsx:331` and `ai-apply.ts:95-102` — all Group A files — and both groups add locale strings, so `i18n:gen-keys` collides on `lib/i18n-keys.ts`.

One PR, four parts, owner-decided.

### Task 12: Open board and constraints to every plan

`hasFeature` returns `row?.bool_value === true` (`entitlements.ts:453`), so a **missing row is false**. Event Pass has no rows at all for board, constraints or multi_division — "multi-division for Pro and Event" is an insert, not a flip.

**Files:**
- Create: `db/migration/deltas/V353__open_scheduling_entitlements.sql`
- Test: `apps/web/src/lib/__tests__/entitlements-scheduling.test.ts`

**Interfaces:** none — entitlements are data. The `requireFeature` calls at `schedule.ts:101`, `:491`, `:697` are not touched and simply start passing.

- [ ] **Step 1: Write the failing test**

```ts
it("opens board and constraints to every plan, and multi-division to Event Pass (#382)", async () => {
  for (const plan of ["community", "pro", "pro_plus", "event_pass", "event_pass_l"]) {
    const orgId = await seedOrgOnPlan(plan);
    expect(await hasFeature(orgId, "scheduling.board"), `${plan} board`).toBe(true);
    expect(await hasFeature(orgId, "scheduling.constraints"), `${plan} constraints`).toBe(true);
  }
});

it("keeps multi-division as the only scheduling paywall", async () => {
  expect(await hasFeature(await seedOrgOnPlan("community"), "scheduling.multi_division")).toBe(false);
  for (const plan of ["pro", "pro_plus", "event_pass", "event_pass_l"]) {
    expect(await hasFeature(await seedOrgOnPlan(plan), "scheduling.multi_division"), plan).toBe(true);
  }
});
```

- [ ] **Step 2: Run and confirm it fails** (community board is false today)

- [ ] **Step 3: Write the migration**

`db/migration/deltas/V353__open_scheduling_entitlements.sql`, following the V344 header style:

```sql
-- V353 — division scheduling is open to every plan; multi-division stays paid.
--
-- #382. `scheduling.ai` was already open to every plan: V322 retired
-- `scheduling.ai.runs_per_division.max` because the AI credit wallet meters runs
-- on every tier, so AI scheduling is credit-gated, not plan-gated. What was
-- still gated is the ordinary board and constraints — the non-AI scheduling an
-- organiser does by hand.
--
-- Event Pass carried NO ROW for any of the three. `hasFeature` reads
-- `row?.bool_value === true`, so a missing row is false: an Event Pass org got
-- none of them. These are inserts, not flips.
--
-- After this, `scheduling.multi_division` is the only scheduling paywall left.
insert into plan_entitlements (plan_key, feature_key, bool_value) values
  ('community',    'scheduling.board',          true),
  ('event_pass',   'scheduling.board',          true),
  ('event_pass_l', 'scheduling.board',          true),
  ('community',    'scheduling.constraints',    true),
  ('event_pass',   'scheduling.constraints',    true),
  ('event_pass_l', 'scheduling.constraints',    true),
  ('event_pass',   'scheduling.multi_division', true),
  ('event_pass_l', 'scheduling.multi_division', true)
on conflict (plan_key, feature_key) do update set bool_value = excluded.bool_value;
```

Conflict target verified: `plan_entitlements_pkey PRIMARY KEY (plan_key, feature_key)`.

- [ ] **Step 4: Apply and run**

```bash
cd /Users/ashokhein/github/wt-ai-gap-e && DATABASE_URL="postgresql://postgres@127.0.0.1:54329/seazn_test" DATABASE_SSL=disable npm run db:apply
cd /Users/ashokhein/github/wt-ai-gap-e && npx vitest run src/lib/__tests__/entitlements-scheduling.test.ts \
  --root apps/web --reporter=json --outputFile=/tmp/e1.json > /dev/null 2>&1; echo "EXIT=$?"
cd /Users/ashokhein/github/wt-ai-gap-e && node -e "const r=require('/tmp/e1.json');console.log(r.numPassedTests,'/',r.numTotalTests,'failedSuites',r.numFailedTestSuites)"
```

`db:apply` alone is not a fresh schema — if the suite reports `expected 'generic' to be 'badminton'` anywhere, run `npm run sync:sports` against the same URL. That is an environment fault, not a regression.

- [ ] **Step 5: E2E — a Community org reaches the board and sets a constraint**

- [ ] **Step 6: Smoke + screenshots, pre-commit gate, commit**

### Task 13: At the save-point cap, roll instead of refusing

`createCheckpoint` (`history.ts:320-350`) throws `PaymentRequiredError` at the cap. Community is **2** — V319 raised it from V290's 1. Replace the refusal with a rolling window.

A checkpoint is a named bookmark, not the history: the ledger keeps every event and restore is "undo until the watermark reaches this seq", so dropping a save point costs the label, not the ability to rewind that far.

**Files:**
- Modify: `apps/web/src/server/usecases/history.ts` — `createCheckpoint`
- Modify: `apps/web/src/components/v2/history-panel.tsx` — render the eviction notice
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`
- Test: `apps/web/src/server/usecases/__tests__/history.test.ts`

**Interfaces:**
- Produces: `CheckpointRow` gains `evicted?: { id: string; label: string }`, consumed by the panel.

- [ ] **Step 1: Write the failing tests**

```ts
it("at the cap, saving evicts exactly the oldest and names it (#382)", async () => {
  const { auth } = await seedOrg("community");
  const { division } = await seedDivision(auth);
  await createCheckpoint(auth, division.id, "one");
  await createCheckpoint(auth, division.id, "two");
  const third = await createCheckpoint(auth, division.id, "three");

  expect(third.evicted?.label).toBe("one");
  const rows = await listCheckpoints(auth, division.id);
  expect(rows.filter((r) => r.kind === "manual").map((r) => r.label)).toEqual(["two", "three"]);
});

it("post-insert count equals the limit exactly, even from over the cap", async () => {
  // Do not assume n === limit. A division can sit above the cap after a plan
  // downgrade, and one save must bring it to exactly the limit.
  const { auth } = await seedOrg("community");
  const { division } = await seedDivision(auth);
  await seedManualCheckpoints(auth, division.id, 5);   // over the cap of 2
  await createCheckpoint(auth, division.id, "new");
  const manual = (await listCheckpoints(auth, division.id)).filter((r) => r.kind === "manual");
  expect(manual).toHaveLength(2);
  expect(manual.at(-1)!.label).toBe("new");
});

it("pro_plus has a null limit and never evicts", async () => {
  const { auth } = await seedOrg("pro_plus");
  const { division } = await seedDivision(auth);
  for (let i = 0; i < 8; i++) await createCheckpoint(auth, division.id, `cp${i}`);
  const manual = (await listCheckpoints(auth, division.id)).filter((r) => r.kind === "manual");
  expect(manual).toHaveLength(8);
});

it("a division below the cap evicts nothing", async () => {
  const { auth } = await seedOrg("community");
  const { division } = await seedDivision(auth);
  const first = await createCheckpoint(auth, division.id, "one");
  expect(first.evicted).toBeUndefined();
});

it("no longer 402s on a manual save", async () => {
  const { auth } = await seedOrg("community");
  const { division } = await seedDivision(auth);
  await createCheckpoint(auth, division.id, "one");
  await createCheckpoint(auth, division.id, "two");
  await expect(createCheckpoint(auth, division.id, "three")).resolves.toBeDefined();
});
```

The last test **replaces** the existing assertion at `history.test.ts:273-282`, which asserts the 402. Change that test rather than adding a contradicting one — leaving both makes the suite assert two incompatible behaviours.

- [ ] **Step 2: Run and confirm they fail**

- [ ] **Step 3: Implement the rolling window**

Replace the quota block in `createCheckpoint`:

```ts
    let evicted: { id: string; label: string } | undefined;
    if (kind === "manual") {
      const [{ n }] = await tx<{ n: number }[]>`
        select count(*)::int as n from division_checkpoints
        where division_id = ${divisionId} and kind = 'manual'`;
      const { limit } = await withinLimit(auth.orgId, "schedule.checkpoints.max", n + 1);
      // #382: a null limit is unlimited (pro_plus) — never evict.
      if (limit !== null && n >= limit) {
        // Delete n - limit + 1, so the post-insert count is EXACTLY the limit.
        // Do not assume n === limit: a plan downgrade can leave a division above
        // the cap, and one save must bring it back to the limit, not to n.
        //
        // Order: created_at asc, seq asc, id asc. The `id` tie-break is a UUID,
        // which the determinism rule normally forbids — acceptable here because
        // this is SELECTION INPUT, not output ordering, the same exemption
        // advisory-lock ordering gets. Do not "fix" it.
        const drop = n - limit + 1;
        const gone = await tx<{ id: string; label: string }[]>`
          delete from division_checkpoints
           where id in (
             select id from division_checkpoints
              where division_id = ${divisionId} and kind = 'manual'
              order by created_at asc, seq asc, id asc
              limit ${drop}
           )
           returning id, label`;
        // The notice names ONE save point; when several go (a downgrade), name
        // the newest of them — it is the one the organiser is likeliest to miss.
        evicted = gone.at(-1);
      }
    }
```

and return `{ ...row!, ...(evicted ? { evicted } : {}) }`.

The 402 path disappears for manual saves. `applyErrorKey`'s `schedule.checkpoints.max` branch (`ai-console-state.ts:466-470`) becomes unreachable from the manual path — **leave it**, and add a comment: it still guards any future caller, and deleting a defensive branch to chase coverage is how the next regression gets in.

- [ ] **Step 4: Surface the eviction**

New keys in all 4 locales:

```json
"history.checkpoint.evicted": "“{name}” was replaced — your plan keeps {count} save points.",
"history.checkpoint.evictedHint": "Undo still rewinds past it."
```

Render them in `history-panel.tsx` after a successful create, using the `evicted` field. The `UpgradeGate` at line 166 stays for the other 402 paths; the eviction notice is a non-blocking line, not a paywall.

- [ ] **Step 5: Run tests, E2E, smoke, screenshots at desktop and 375px**

- [ ] **Step 6: Pre-commit gate, commit**

### Task 14: Prune AI anchors to the newest 3 per division

`kind: "ai"` anchors (V303) are exempt from the quota and nothing ever deletes them. `superseded` is derived on read, not stored, and the only `DELETE` is the user-initiated endpoint (`history.ts:352`). So they accumulate without bound, one per AI apply, forever.

Keep the newest **3** per division. Three rather than one because the existing comment on `CheckpointRow.superseded` calls the deeper rewind out as deliberate: *"jumping back two AI runs is a real capability worth keeping."* Two runs back plus the newest is exactly 3.

**Files:**
- Modify: `apps/web/src/server/usecases/history.ts` — `createCheckpoint`, the `kind === "ai"` path
- Test: `apps/web/src/server/usecases/__tests__/history.test.ts`

**Interfaces:**
- Consumes: Task 13's `createCheckpoint`.

- [ ] **Step 1: Write the failing tests**

```ts
it("keeps the newest 3 AI anchors per division (#382)", async () => {
  const { auth } = await seedOrg("community");
  const { division } = await seedDivision(auth);
  for (let i = 0; i < 6; i++) await createCheckpoint(auth, division.id, `ai-${i}`, "ai");
  const ai = (await listCheckpoints(auth, division.id)).filter((r) => r.kind === "ai");
  expect(ai).toHaveLength(3);
  expect(ai.map((r) => r.label)).toEqual(["ai-3", "ai-4", "ai-5"]);
});

it("pruning is per division, not per org", async () => {
  const { auth } = await seedOrg("community");
  const a = await seedDivision(auth);
  const b = await seedDivision(auth);
  for (let i = 0; i < 4; i++) await createCheckpoint(auth, a.division.id, `a-${i}`, "ai");
  await createCheckpoint(auth, b.division.id, "b-0", "ai");
  expect((await listCheckpoints(auth, b.division.id)).filter((r) => r.kind === "ai")).toHaveLength(1);
});

it("AI anchors still cost no manual quota", async () => {
  const { auth } = await seedOrg("community");
  const { division } = await seedDivision(auth);
  for (let i = 0; i < 4; i++) await createCheckpoint(auth, division.id, `ai-${i}`, "ai");
  const first = await createCheckpoint(auth, division.id, "manual-one");
  expect(first.evicted).toBeUndefined();
});
```

- [ ] **Step 2: Run and confirm they fail**

- [ ] **Step 3: Prune after inserting an AI anchor**

```ts
    // #382: AI anchors are exempt from the manual quota and nothing ever deleted
    // them, so they accumulated one per AI apply, forever. Keep the newest 3.
    // Three, not one: `superseded` exists because jumping back two AI runs is a
    // capability worth keeping (see CheckpointRow.superseded), and two runs back
    // plus the newest is exactly 3.
    //
    // Same ordering exemption as the manual eviction above — selection input.
    if (kind === "ai") {
      await tx`
        delete from division_checkpoints
         where id in (
           select id from division_checkpoints
            where division_id = ${divisionId} and kind = 'ai'
            order by created_at desc, seq desc, id desc
            offset 3
         )`;
    }
```

The index `division_checkpoints_kind_idx (division_id, kind, created_at desc)` from V303 already serves this.

- [ ] **Step 4: Run tests, then the full history suite. Commit.**

### Task 15: Correct the stale checkpoint-quota copy

Found during triage, in no issue. `openapi.ts:222` advertises the quota as "1 free / 5 Pro / unlimited Pro Plus". Community has been **2** since V319. `V303__checkpoint_kind.sql:2` repeats the same stale claim in a comment. The OpenAPI summary is published surface making a false pricing claim — exactly the class `copy-truth.ts` exists to catch.

**Files:**
- Modify: `apps/web/src/server/api-v1/openapi.ts:222`
- Modify: `db/migration/deltas/V303__checkpoint_kind.sql` (comment only)
- Test: `apps/web/src/lib/__tests__/help-copy-truth.test.ts`

**Interfaces:** none.

- [ ] **Step 1: Write the failing test**

```ts
it("the checkpoint quota summary matches the seeded entitlement (#382)", async () => {
  const [{ int_value }] = await sql<{ int_value: number }[]>`
    select int_value from plan_entitlements
     where plan_key = 'community' and feature_key = 'schedule.checkpoints.max'`;
  const summary = ROUTES.find(
    (r) => r.path === "/divisions/{id}/checkpoints" && r.method === "post",
  )!.summary;
  expect(summary).toContain(String(int_value));
  expect(summary, "the retired '1 free' claim").not.toMatch(/\b1\s+free\b/);
});
```

Reading the seeded value rather than hardcoding 2 is the point: the next entitlement change fails this test instead of quietly re-staling the copy.

- [ ] **Step 2: Run and confirm it fails**

- [ ] **Step 3: Fix both strings**

`openapi.ts:222` — replace the parenthetical with `(quota \`schedule.checkpoints.max\`: 2 free / 5 Pro / unlimited Pro Plus; at the cap the oldest save point is replaced)`.

Editing a Flyway migration that has already run does not re-run it. The comment fix is for the next reader only, and the file's checksum is unaffected by a comment change **only if Flyway is configured to ignore it** — verify with a `db:apply` against the test DB before committing. If the checksum is validated, leave V303 alone and put the correction in V353's header instead.

- [ ] **Step 4: Run, pre-commit gate, commit the whole of Group E**

```bash
cd /Users/ashokhein/github/wt-ai-gap-e && npm run openapi:gen && npm run i18n:gen-keys && git status --porcelain
cd /Users/ashokhein/github/wt-ai-gap-e && git add -A && git commit -m "feat: open division scheduling to all plans; roll save points at the cap (#382)"
```

---

## Appendix: worktrees

Already created, with `.env.local`, `apps/web/.env.local` and `.claude/agent-memory` symlinked:

| Group | Path | Branch | `npm ci` |
|---|---|---|---|
| C | `/Users/ashokhein/github/wt-ai-gap-c` | `ai-gap-c-board-wiring` | done |
| B | `/Users/ashokhein/github/wt-ai-gap-b` | `ai-gap-b-joint-undo` | needed |
| D | `/Users/ashokhein/github/wt-ai-gap-d` | `ai-gap-d-cron-antijoin` | needed |

Still to create — A before Group A starts, E after Group A merges:

```bash
cd /Users/ashokhein/github/seazn.club
for g in a:ai-gap-a-quote-integrity e:ai-gap-e-open-scheduling; do
  n="${g%%:*}"; br="${g##*:}"; wt="/Users/ashokhein/github/wt-ai-gap-$n"
  git worktree add -b "$br" "$wt" main
  ln -sfn /Users/ashokhein/github/seazn.club/.env.local "$wt/.env.local"
  ln -sfn /Users/ashokhein/github/seazn.club/apps/web/.env.local "$wt/apps/web/.env.local"
  mkdir -p "$wt/.claude" && ln -sfn /Users/ashokhein/github/seazn.club/.claude/agent-memory "$wt/.claude/agent-memory"
  (cd "$wt" && npm ci)
done
```

**Verify before trusting any run in a worktree:**

```bash
cd <worktree> && readlink -f node_modules/@seazn/engine    # must resolve INSIDE the worktree
```

A symlinked `node_modules` makes `apps/web` compile **main's** engine, so you can test a branch and measure the wrong code. It also fails `next build` with `Symlink … points out of the filesystem root`.

Without `.env.local`, ~1772 DB tests skip themselves **while `total` stays unchanged** — only `pending` moves, so the run looks identical to a green one.
