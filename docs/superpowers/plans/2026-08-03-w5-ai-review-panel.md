# W5 — AI review panel: instruction preview, assumptions, unschedulable

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the organiser what we compiled their sentence into *before* a credit is spent, and render the three things the pipeline already knows and never says — the compiled rules, the assumptions, and the fixtures the solver gave up on.

**Architecture:** A new parse-only preview endpoint runs the W3 stage-1 compiler outside `spendCredit`, persists the compiled result to a new `ai_parse_previews` row, and returns it with a `preview_id`. The console renders that as a confirm gate; declining is a client no-op that spent nothing. Confirming posts the run with `preview_id`, and the run reuses the stored parse instead of compiling a second time — a changed instruction 409s rather than silently recompiling behind a confirmation the organiser already gave. After a run, one shared review module builds every amber/note row (warnings, unschedulable, assumptions) and the count is derived from that same array, so "N to review" cannot drift from what is on screen.

**Tech Stack:** Next.js (this repo's fork — read `node_modules/next/dist/docs/` before writing route code), React 19 server/client components, zod (`apps/web/src/server/api-v1/schemas.ts`), Flyway migrations, Postgres, vitest (`renderToStaticMarkup` + `DictProvider` component pattern), Playwright e2e, Tailwind.

---

## Global Constraints

Copied verbatim from the repo rules and the programme design doc. **Every task's requirements implicitly include this section.**

- **Every change ships a test that fails without it.** No exceptions.
- **Every new or changed user-facing string goes in all four locale dictionaries** (`apps/web/src/dictionaries/{en,es,fr,nl}/ui.json` — flat dotted-key JSON). Never hardcoded English. Run `npm run i18n:gen-keys` then `npm run i18n:check` in the same task that adds the key.
- **`content/help/**` is ONE English tree** — help edits owe no i18n work.
- **UI is verified by screenshot at desktop AND 375px, with no horizontal page scroll.** This is a user-facing organiser surface: **full design polish bar**, not the relaxed `/admin` bar.
- **api-v1 schema change → `npm run openapi:gen` and commit `openapi/*.json`.** The drift gate is **CI-only**; a fully green local run proves nothing. This repo has been bitten by it four times (#88, #124, #127, #397).
- **Assertions on a Next HTML body must anchor on `="`.** React serialises an omitted prop as `"$undefined"`, so a bare `data-*` probe passes in both states.
- **`grep` reports files here as `Binary file … matches`** — always pass `-a` before concluding a call site does not exist.
- **`rtk` lies.** Its vitest summary prints `PASS(0) FAIL(0)` for a suite that failed to *collect*, and it hides `npm run lint` output. Judge green only from `--reporter=json --outputFile` (`numPassedTests`/`numTotalTests`), and use `rtk proxy` for lint and read `✖ N problems`.
- **`npm test --workspace apps/web -- run <path>` treats positionals as filename FILTERS.** A typo silently runs a subset and reports green. Run whole suites. Note `apps/web`'s `test` script is *already* `vitest run`, so a positional `run` is itself the trap. `--root apps/web` is also poison — it ENOENTs path-relative suites.
- **This worktree has no `.env.local`, so a bare test run SKIPS ~1785 tests and still reports success.** A DB-backed suite reports `status: "passed"` with every test `skipped`. Always run with the DB env, and sanity-check `numPendingTests` (~50 with the DB, ~1785 without):
  ```
  DATABASE_URL=postgres://…@localhost:54329/seazn_w5 DB_SCHEMA=seazn_club \
    npm test --workspace apps/web -- --reporter=json --outputFile=/tmp/w5.json
  ```
- **Never enable `.github/workflows/e2e.yml`.** Verify e2e locally: production build + `E2E_PROD_TARGET` on :3100.
- **A killed background command reports exit code 0.** Have the command write `EXIT=$?` itself.
- **Never check out a branch in the main repo dir.** All work happens in the worktree `/Users/ashokhein/github/seazn.club/.claude/worktrees/w5-review-panel` (branch `feat/w5-ai-review-panel`), which already has `node_modules` symlinks.
- **`packages/engine` is zod-only** — no DB, no provider, no wall clock. Nothing in this plan adds engine code; if you think it does, stop and re-read.
- **The AI-run server suites mock the Anthropic SDK with a queue that is 1:1 with ARCHITECT calls.** Adding an LLM round to an existing path shifts every count and error code in `schedule-ai-route.test.ts`, `competition-schedule-ai-route.test.ts`, `competition-schedule-ai-http.test.ts` and `ai-credit-wallet-spend.test.ts`. This plan deliberately puts the new parse round in a *separate request*, so those suites must stay untouched — if one goes red, you changed the existing path and should not have.

### The two `assumptions`, which are not the same field

There are two arrays named `assumptions` in this codebase and conflating them is the single most likely way to get this wave wrong:

| | source | when | content |
|---|---|---|---|
| **resolver assumptions** | `ResolvedParse.assumptions` (`schedule-ai-parse.ts:286-299`, produced by `resolveParsed` at `:319`) | stage 1, deterministic, before any credit | how we read the window, weekday readings, feasibility rewrites |
| **model assumptions** | `AiSchedulePlan.assumptions` (`schedule-ai-prompt.ts:239-251`, `string[].max(10).optional()`) | stage 2, model-authored, after the run | what the architect assumed while placing |

**Resolver assumptions render in the preview. Model assumptions render in the review panel after the run.** They live in different HTTP responses and must never be merged into one array.

---

## File structure

**Server — new**

| File | Responsibility |
|---|---|
| `apps/web/db/migration/V345__ai_parse_previews.sql` | the preview table |
| `apps/web/src/server/usecases/schedule-ai-preview.ts` | parse-only usecase: rate limit → affordability → `parseInstruction` → `resolveParsed` → persist → return |
| `apps/web/src/app/api/v1/divisions/[id]/schedule/ai-preview/route.ts` | single-division preview route |
| `apps/web/src/app/api/v1/competitions/[id]/schedule/ai-preview/route.ts` | joint preview route |

**Server — modified**

| File | Change |
|---|---|
| `apps/web/src/server/api-v1/schemas.ts` | `AiParsePreviewRequest`/`AiParsePreviewResponse`; `assumptions` on `AiPlanResponse` (~:1710 block) and `AiCompetitionPlanResponse` (:1867+); `preview_id` on both plan requests |
| `apps/web/src/server/api-v1/openapi.ts` | register the two new routes (existing registrations at :226, :230) |
| `apps/web/src/server/usecases/schedule-ai.ts` | reuse a stored parse at :2228; carry model assumptions into the response build at :2478 |
| `apps/web/src/server/usecases/competition-schedule-ai.ts` | same, at :2082 and the joint response build |

**Client — new**

| File | Responsibility |
|---|---|
| `apps/web/src/components/v2/board/ai-instruction-describe.ts` | pure: `describeHardConstraint`, `constraintToken` — exhaustive over the 6 `HardConstraint` variants |
| `apps/web/src/components/v2/board/ai-instruction-preview.tsx` | the preview card + confirm bar (shared by both consoles) |
| `apps/web/src/components/v2/board/ai-review.ts` | pure: `buildReviewRows(plan, opts) → ReviewRow[]`, `reviewRowCount(rows)` — the ONE definition of the count |
| `apps/web/src/components/v2/board/ai-review-panel.tsx` | renders `ReviewRow[]`; used by both consoles |
| `apps/web/src/components/v2/board/ai-division-chip.tsx` | `DivisionChip`, extracted verbatim from `ai-competition-console.tsx:279-294` |

**Client — modified**

| File | Change |
|---|---|
| `ai-console-state.ts` | `preview` slice + `canRun(state)` selector |
| `ai-console.tsx` | `BriefStep` two-stage gate (:989-1196); `ScheduleStep` renders `AiReviewPanel` (:1255) |
| `ai-diff-panel.tsx` | stops owning warning/assumption rows; keeps blocking + the diff |
| `ai-competition-console.tsx` | imports `DivisionChip` from the new module; `JointReviewStep` (:316) replaces its hand-rolled warnings list (:545-608) and count (:552-558) with `AiReviewPanel`; the joint brief step gets the same gate |

---

## Task 1 — Preview contract: table, usecase, routes

**Files:**
- Create: `apps/web/db/migration/V345__ai_parse_previews.sql`
- Create: `apps/web/src/server/usecases/schedule-ai-preview.ts`
- Create: `apps/web/src/app/api/v1/divisions/[id]/schedule/ai-preview/route.ts`
- Create: `apps/web/src/app/api/v1/competitions/[id]/schedule/ai-preview/route.ts`
- Modify: `apps/web/src/server/api-v1/schemas.ts`, `apps/web/src/server/api-v1/openapi.ts`
- Test: `apps/web/src/server/usecases/__tests__/schedule-ai-preview.test.ts`

**Interfaces:**
- Consumes: `parseInstruction(instruction, ctx, opts)` → `ParseOutcome { raw, failed, tokens, servedModel }` (`schedule-ai-parse.ts:204-222`); `resolveParsed(raw, clock, tz, hints)` → `ResolvedParse { hard, soft, unparsed, assumptions, windowMs }` (`:286-319`); `minimumCredits(chosen)` (`apps/web/src/lib/ai-rung.ts:242`); the rate limiter used at `schedule-ai.ts:2203`. **Read those exact lines first and match the real signatures** — the line numbers are from a recon pass, not gospel.
- Produces: `previewScheduleAi(input) → AiParsePreviewResponse` and a durable `ai_parse_previews` row keyed by `(org_id, scope, scope_id, instruction_hash)`; Task 2 consumes `preview_id`.

- [ ] **Step 1: Load the Postgres skill before writing any SQL**

Invoke `supabase:supabase-postgres-best-practices`. It is mandatory before creating a table in this repo. Follow it for column types, indexes and naming.

- [ ] **Step 2: Write the migration**

`apps/web/db/migration/V345__ai_parse_previews.sql`. V344 is the current head — confirm with `ls apps/web/db/migration | sort -V | tail -3` before naming the file. Greenfield: no backfill is owed.

```sql
-- W5 (#400). A compiled instruction the organiser has been shown but not yet
-- paid for. The run endpoint reuses it so a confirmed compile is the one that
-- executes, and so confirming does not pay for a second parse round.
create table if not exists ai_parse_previews (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs (id) on delete cascade,
  scope text not null check (scope in ('division', 'competition')),
  scope_id uuid not null,
  -- sha256 hex of the NORMALISED instruction (trimmed, whitespace collapsed).
  -- The run gate compares this, so a reworded sentence can never execute under
  -- a confirmation given for the previous one.
  instruction_hash text not null,
  instruction text not null,
  -- ResolvedParse: hard[], soft[], unparsed[], assumptions[], windowMs.
  resolved jsonb not null,
  -- RawParsed as the model emitted it; null when the compile failed schema.
  raw jsonb,
  failed boolean not null default false,
  output_tokens integer not null default 0,
  served_model text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz
);

-- The run gate's lookup: newest unconsumed, unexpired preview for this exact
-- instruction in this exact scope.
create index if not exists ai_parse_previews_lookup_idx
  on ai_parse_previews (org_id, scope, scope_id, instruction_hash, created_at desc);

-- Sweep support; partial so it stays small.
create index if not exists ai_parse_previews_expiry_idx
  on ai_parse_previews (expires_at)
  where consumed_at is null;

comment on table ai_parse_previews is
  'W5 #400: a stage-1 compiled instruction shown to an organiser before any credit is spent.';
```

Apply it: `npm run db:apply` (Flyway, incremental). Use a **fresh schema** for this wave's test DB per the session brief — see `docs`/memory for the ephemeral PG :54329 recipe, and remember a fresh schema needs `db:apply` **and** `npm run sync:sports`.

- [ ] **Step 3: Write the failing usecase test**

`apps/web/src/server/usecases/__tests__/schedule-ai-preview.test.ts`. This is the wave's load-bearing test — it is what makes "declining spends no credit" a fact rather than a claim. Mirror the SDK-mock setup used by `schedule-ai-route.test.ts` (read it; do not invent a new harness).

```ts
it("spends no credit and makes no architect call", async () => {
  const before = await balance(walletId);
  const res = await previewScheduleAi({ /* … division scope, instruction … */ });
  expect(res.compiled.hard.length).toBeGreaterThan(0);
  expect(await balance(walletId)).toBe(before);          // no credit moved
  expect(architectCalls()).toBe(0);                       // no stage-2 call
  expect(parseCalls()).toBe(1);                           // exactly one compile
});

it("refuses before any model call when the wallet cannot afford the run", async () => {
  await setBalance(walletId, 0);
  await expect(previewScheduleAi({ /* … */ })).rejects.toMatchObject({ status: 402 });
  expect(parseCalls()).toBe(0);                           // unpriced is not free
});

it("stamps the parse spend on the ledger", async () => {
  await previewScheduleAi({ /* … */ });
  const lines = await ledgerLinesFor(orgId);
  expect(lines.filter((l) => l.kind === "ai_parse")).toHaveLength(1);
});
```

The exact ledger `kind` and helper names must be read from the W3 parse-stamp code (`schedule-ai.ts` around :2228-2260) — reuse them, do not mint a second vocabulary.

- [ ] **Step 4: Run it and watch it fail**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/w5-review-panel
npm test --workspace apps/web -- --reporter=json --outputFile=/tmp/w5-t1.json
```
Expected: the new suite fails to resolve `previewScheduleAi`. Confirm from the JSON (`numFailedTests`), not from the terminal summary.

- [ ] **Step 5: Write the schemas**

In `apps/web/src/server/api-v1/schemas.ts`, beside the existing AI schemas:

```ts
export const AiParsePreviewRequest = z.object({
  instruction: z.string().min(1).max(2000),
  /** Joint only: the divisions in scope, so the resolver reads the same window
   *  the run will. Omitted on the single-division route. */
  division_ids: z.array(Uuid).optional(),
});
export type AiParsePreviewRequest = z.infer<typeof AiParsePreviewRequest>;

export const AiParsePreviewResponse = z.object({
  /** Reuse token for the run. Absent when the compile failed schema twice —
   *  there is nothing to confirm, only a fallback to choose. */
  preview_id: Uuid.optional(),
  /** True when stage 1 failed schema twice. The client must offer the explicit
   *  preference fallback and must NEVER fall back on its own. */
  failed: z.boolean(),
  compiled: z.object({
    hard: z.array(HardConstraint),
    soft: z.array(z.object({ note: z.string(), weight: z.union([z.literal(1), z.literal(2), z.literal(3)]) })),
    /** Verbatim. Never converted into a rule. */
    unparsed: z.array(z.string()),
    /** RESOLVER assumptions — not the model's. See the plan's header table. */
    assumptions: z.array(z.string()),
  }),
  /** The resolved calendar window, in the org timezone, as YYYY-MM-DD. */
  window: z.object({ start: z.string(), end: z.string(), tz: z.string() }),
  expires_at: z.string(),
});
export type AiParsePreviewResponse = z.infer<typeof AiParsePreviewResponse>;
```

`HardConstraint` is already exported from the engine (`packages/engine/src/scheduling/constraints.ts:61-86`) — import it, do not redeclare it. If `schemas.ts` cannot import from the engine, check how W3 got `RuleCode` in there (`schemas.ts` near :1710) and follow that exact route.

- [ ] **Step 6: Write the usecase**

`apps/web/src/server/usecases/schedule-ai-preview.ts`. Order of operations, and it matters:

1. authz + `rateLimit` — **the preview consumes the run's rate-limit budget** (it is the LLM call). Reuse the limiter at `schedule-ai.ts:2203` unchanged; do not add a second bucket.
2. `walletIdFor` → `balance` vs `minimumCredits([...chosen rungs])`. **`balance > 0` is not enough** — a 3-credit wallet and a 4-credit joint run slip straight through it. Copy the comparison from `schedule-ai.ts:2225` / `competition-schedule-ai.ts:2078` rather than re-deriving it. Refuse with the same 402 shape the run refuses with, **before** `parseInstruction`.
3. `parseInstruction(...)` with its own small meter and `clampRound` ceiling, exactly as W3 configured it.
4. Stamp the parse spend on the ledger, same line kind W3 uses.
5. `resolveParsed(raw, clock, tz, hints)` → `ResolvedParse`.
6. Insert the row with `expires_at = now() + interval '30 minutes'` (a preview older than that is stale by wall-clock as well as by content — the org's clock may have crossed a day boundary and the window resolution with it).
7. Return `AiParsePreviewResponse`.

On `failed === true`: still stamp the tokens, still return 200 with `failed: true`, `preview_id` **absent**, and `compiled.unparsed` carrying the raw instruction. A parse failure is a state to render, not an error to throw.

Resolve the provider from the **model slug**, never from the global `AI_PROVIDER`: `model.includes("/") ? "openrouter" : "anthropic"`. A bare Anthropic id sent to OpenRouter is a 404.

- [ ] **Step 7: Write the routes**

Both routes are thin. Read `apps/web/src/app/api/v1/divisions/[id]/schedule/ai-plan/route.ts` and copy its authz, error envelope and handler shape exactly. **Read `node_modules/next/dist/docs/` for the route-handler API in this Next fork before writing either file** — this is not the Next.js you know.

- [ ] **Step 8: Run the tests to green**

```bash
npm test --workspace apps/web -- --reporter=json --outputFile=/tmp/w5-t1.json
node -e "const r=require('/tmp/w5-t1.json');console.log(r.numPassedTests,'/',r.numTotalTests,'failed',r.numFailedTests)"
```
Expected: the three new tests pass and `numFailedTests` is 0. **The four SDK-mock suites must be untouched and still green** — if any of them moved, you added a round to the existing path.

- [ ] **Step 9: Regenerate the OpenAPI document**

```bash
npm run openapi:gen
git status --short openapi/
```
Expected: `openapi/*.json` shows a diff. **Commit it.** The drift gate is CI-only and will kill the job in ~2 minutes with no test output if you skip this.

- [ ] **Step 10: Commit**

```bash
git add apps/web/db/migration/V345__ai_parse_previews.sql \
        apps/web/src/server/usecases/schedule-ai-preview.ts \
        apps/web/src/app/api/v1/divisions/\[id\]/schedule/ai-preview/route.ts \
        apps/web/src/app/api/v1/competitions/\[id\]/schedule/ai-preview/route.ts \
        apps/web/src/server/api-v1/schemas.ts apps/web/src/server/api-v1/openapi.ts \
        apps/web/src/server/usecases/__tests__/schedule-ai-preview.test.ts openapi/
git commit -m "feat(scheduler): parse-only preview endpoint that spends no credit (#400)"
```

---

## Task 2 — The run reuses the confirmed compile, or refuses

**Files:**
- Modify: `apps/web/src/server/usecases/schedule-ai.ts` (~:2228), `apps/web/src/server/usecases/competition-schedule-ai.ts` (~:2082), `apps/web/src/server/api-v1/schemas.ts`
- Test: `apps/web/src/server/usecases/__tests__/schedule-ai-preview-reuse.test.ts`

**Interfaces:**
- Consumes: the `ai_parse_previews` row from Task 1; `preview_id` on the request.
- Produces: a run that compiles **zero** times when a valid `preview_id` is supplied, and a `409 preview_stale` when the instruction no longer matches.

- [ ] **Step 1: Write the failing tests**

```ts
it("does not recompile when a valid preview is confirmed", async () => {
  const p = await previewScheduleAi({ instruction: INSTRUCTION, /* … */ });
  resetParseCalls();
  const run = await runScheduleAi({ instruction: INSTRUCTION, preview_id: p.preview_id, /* … */ });
  expect(parseCalls()).toBe(0);              // the confirmed compile is the one that ran
  expect(architectCalls()).toBe(1);
  expect(run.warnings).toBeDefined();
});

it("409s rather than silently recompiling a changed instruction", async () => {
  const p = await previewScheduleAi({ instruction: "finals on Friday", /* … */ });
  await expect(
    runScheduleAi({ instruction: "finals on Saturday", preview_id: p.preview_id, /* … */ }),
  ).rejects.toMatchObject({ status: 409, code: "preview_stale" });
  expect(architectCalls()).toBe(0);          // nothing was spent on the mismatch
});

it("still compiles inline when no preview_id is supplied", async () => {
  await runScheduleAi({ instruction: INSTRUCTION, /* no preview_id */ });
  expect(parseCalls()).toBe(1);              // API consumers and smoke keep working
});

it("does not consume a second rate-limit token when a preview is reused", async () => {
  // three previews exhaust the 3/hr bucket; confirming the third must still run.
  /* … */
});
```

- [ ] **Step 2: Run them and watch them fail**

`npm test --workspace apps/web -- --reporter=json --outputFile=/tmp/w5-t2.json`. Expected: `preview_id` is not a known request field.

- [ ] **Step 3: Add `preview_id` to both plan requests**

In `schemas.ts`, add `preview_id: Uuid.optional()` to `AiPlanRequest` and `AiCompetitionPlanRequest`. Optional, because smoke, the e2e API paths and any external consumer must keep working without it.

- [ ] **Step 4: Implement the reuse gate**

At `schedule-ai.ts:2228` and `competition-schedule-ai.ts:2082`, replace the unconditional `parseInstruction` with:

```ts
// A confirmed compile is the one that executes. Recompiling here would run the
// architect under rules the organiser never saw — the exact failure this wave
// exists to close — so a mismatch refuses instead of guessing.
const confirmed = input.preview_id
  ? await loadPreview(input.preview_id, { orgId, scope, scopeId })
  : null;
if (input.preview_id && !confirmed) throw apiError(409, "preview_stale");
if (confirmed && confirmed.instruction_hash !== hashInstruction(input.instruction)) {
  throw apiError(409, "preview_stale");
}
const resolved = confirmed
  ? ResolvedParse.parse(confirmed.resolved)
  : await compileInline(input.instruction, ...);   // today's path, unchanged
if (confirmed) await markPreviewConsumed(confirmed.id);
```

`loadPreview` must scope on `org_id` **and** `scope`/`scope_id` and reject `expires_at < now()` and `consumed_at is not null`. A preview is single-use: a consumed one 409s, so a double-submit cannot run twice off one confirmation.

Skip the rate-limit consumption when `confirmed` is non-null — the preview already paid for it.

- [ ] **Step 5: Run to green**

`npm test --workspace apps/web -- --reporter=json --outputFile=/tmp/w5-t2.json`, then read `numFailedTests` from the JSON. The four SDK-mock suites stay green and untouched.

- [ ] **Step 6: Regenerate OpenAPI and commit**

```bash
npm run openapi:gen
git add -A && git commit -m "feat(scheduler): run reuses the confirmed compile, 409s on a stale preview (#400)"
```

---

## Task 2b — Close the reuse gate's three holes (from the Task 2/3 review)

Found reviewing `95320220` + `d168adc8`. Each is a defect in the wave's core guarantee — *the compile the organiser confirmed is the compile that executes* — not a polish item. Sequenced after Task 1's review fixes because both touch `schedule-ai-preview.ts`.

**Files:** `apps/web/src/server/usecases/schedule-ai-preview.ts`, `schedule-ai.ts`, `competition-schedule-ai.ts`; a new `db/migration/deltas/V346__ai_parse_previews_division_ids.sql` (do NOT amend V345 — it is already applied locally and Flyway would fail its checksum); tests in `__tests__/schedule-ai-preview-reuse.test.ts`.

- [ ] **H1 — the joint preview's identity omits the division set.**

`schedule-ai-preview.ts:125-136` keys the lookup on `org_id + scope + scope_id(=competitionId) + instruction_hash`. The division set is neither stored nor checked. So preview `{A,B}` → run `{A,B,D}` under the same sentence is **honoured**: `competition-schedule-ai.ts:2163` feeds the stored `resolved`, whose window `resolveParsed` feasibility-extended from `{A,B}`'s fixture count (`schedule-ai-parse.ts:413-424`), and whose `raw` was compiled with only A and B in the prompt's division list. The architect then places D under a window resolved without it. The function's own doc at `:97-100` makes exactly this argument for scope and stops one level short.

Persist the sorted kept `division_ids` on the row and add them to the `where`. `kept` is already computed at `competition-schedule-ai.ts:2067`, before the claim at `:2096`. Failing test first: a preview minted for two divisions, confirmed for three, must 409.

- [ ] **H2 — deviation 2 has no test with teeth.**

Delete `...(confirmed !== null ? { resolved: confirmed.resolved } : {})` at `schedule-ai.ts:2295` / `competition-schedule-ai.ts:2163` and **all 16 reuse tests still pass** — `buildSchedulePack:837` falls back to `resolveParsed(opts.raw)` on the same `confirmed.raw`, and no test advances the clock between preview and run. The reviewer verified the reasoning holds and that nothing else re-derives the executed rules from `now`, but the guarantee currently rests on an assertion nobody makes.

One test: mint a preview at T, run with `now` advanced across an org-clock day boundary, assert the pack window equals the previewed window. It must fail with that spread line deleted.

- [ ] **H3 — a failed run burns the confirmed compile.**

`schedule-ai.ts:2243` claims the preview *before* `buildSchedulePack`, the quote, and `spendCredit` at `:2345` — and `canPay` is short-circuited to `true` on the reuse path (`:2283`), so the affordability pre-flight no longer runs at all. A 402 at `spendCredit`, or the documented `AI_PLAN_TIMEOUT` 422 (`:1547`/`:1675`), leaves `consumed_at` set with nothing to show for it: retrying the same `preview_id` 409s and the organiser pays for another parse round.

Fix so that **both** properties hold — a double-submit still buys exactly one run, and a run that never reached `spendCredit` does not eat the confirmation. Restoring the `balance >= minimumCredits` check on the reuse path and releasing the claim (`consumed_at = null`) when the run throws before the credit is reserved satisfies both; the atomic `update … where consumed_at is null returning` stays exactly where it is, because it is what makes the double-submit case race-safe under READ COMMITTED. Test both directions.

- [ ] **Minor, take if cheap** — validate the stored `resolved`/`raw` crossing the DB→engine boundary (`schedule-ai-preview.ts:125` types the jsonb by generic parameter only; `resolved.hard` goes straight to the verifier, and a deploy that changes `HardConstraint` inside a live preview's 30-minute TTL feeds the engine a shape it no longer expects). `ResolvedParse` is a TS interface, not a zod schema, so this is a real deviation from the plan's Step 4, not an oversight — closing it means giving it a schema.

**Verified clean by the same review, do not re-raise:** cross-tenant is closed twice (`withTenant` + `org_id` in the predicate); the single `update … returning` is race-safe and double-submit buys one run; the no-`preview_id` path is unchanged; the limiter is skipped on reuse and consumed otherwise; Task 3 sources `chosen.plan.assumptions` from the architect's stage-2 array, defaults to `[]`, and publishes as required-with-default on both responses; `competition-schedule-ai-http.test.ts`'s +2 lines are genuinely type-forced.

---

## Task 3 — Model assumptions reach the client

**Files:**
- Modify: `apps/web/src/server/api-v1/schemas.ts`, `apps/web/src/server/usecases/schedule-ai.ts` (~:2478 response build), `apps/web/src/server/usecases/competition-schedule-ai.ts` (joint response build)
- Test: `apps/web/src/server/usecases/__tests__/schedule-ai-assumptions.test.ts`

**Interfaces:**
- Consumes: `AiSchedulePlan.assumptions` (`schedule-ai-prompt.ts:239-251`, `string[].max(10).optional()`).
- Produces: `AiPlanResponse.assumptions: string[]` and `AiCompetitionPlanResponse.assumptions: string[]` — Task 5 renders them.

- [ ] **Step 1: Write the failing test**

```ts
it("carries the model's assumptions into the response", async () => {
  queueArchitect({ /* … plan with */ assumptions: ["Read 'the weekend' as Sat + Sun."] });
  const res = await runScheduleAi({ /* … */ });
  expect(res.assumptions).toEqual(["Read 'the weekend' as Sat + Sun."]);
});

it("defaults to an empty array when the model omits them", async () => {
  queueArchitect({ /* … no assumptions key … */ });
  const res = await runScheduleAi({ /* … */ });
  expect(res.assumptions).toEqual([]);      // never undefined — the client maps over it
});
```

Write the joint twin in the same file against `runCompetitionScheduleAi`.

- [ ] **Step 2: Run and watch it fail**

Expected: `res.assumptions` is `undefined`.

- [ ] **Step 3: Widen both response schemas**

```ts
/** The ARCHITECT's own assumptions (stage 2). NOT the resolver's — those are
 *  shown at the preview, before a credit is spent. See W5's plan header. */
assumptions: z.array(z.string()).default([]),
```

- [ ] **Step 4: Fill them in both response builds**

`assumptions: plan.assumptions ?? []` at `schedule-ai.ts:2478` and the joint equivalent.

- [ ] **Step 5: Run to green, regenerate OpenAPI, commit**

```bash
npm test --workspace apps/web -- --reporter=json --outputFile=/tmp/w5-t3.json
npm run openapi:gen && git add -A
git commit -m "feat(scheduler): surface the architect's assumptions on both plan responses (#400)"
```

---

## Task 4 — One definition of a review row, one definition of the count

**Files:**
- Create: `apps/web/src/components/v2/board/ai-review.ts`, `apps/web/src/components/v2/board/ai-review-panel.tsx`, `apps/web/src/components/v2/board/ai-division-chip.tsx`
- Modify: `apps/web/src/components/v2/board/ai-competition-console.tsx` (extract `DivisionChip` at :279-294; import it back)
- Test: `apps/web/src/components/v2/board/__tests__/ai-review.test.ts`, `.../ai-review-panel.test.tsx`

**Interfaces:**
- Consumes: `AiPlanResponse` / `AiCompetitionPlanResponse` (`warnings`, `unschedulable`, `assumptions`); `CONFLICT_LABEL` and `blockingConflictKey`/`blockingConflictCode` from `./types` and `./ai-diff`.
- Produces:
  ```ts
  export type ReviewRow =
    | { kind: "warning"; fixtureId: string; reason: string; detail?: string; rule?: RuleCode }
    | { kind: "unschedulable"; fixtureId: string; reason: string; rule: RuleCode }
    | { kind: "assumption"; text: string };
  export function buildReviewRows(
    plan: Pick<AiPlanResponse, "warnings" | "unschedulable" | "assumptions">,
  ): ReviewRow[];
  export function reviewRowCount(rows: ReviewRow[]): number;   // === rows.length
  export function AiReviewPanel(props: {
    rows: ReviewRow[];
    fixtures: AiConsoleFixture[];
    /** Joint console only. Returns null when the division is unknown — never guess. */
    divisionFor?: (fixtureId: string) => { id: string; name: string } | null;
    onPulse?: (fixtureIds: string[]) => void;
  }): JSX.Element | null;
  ```

**Why this shape.** #388 flags that "N warnings to review" does not cover every amber row on screen, and this wave adds two more row categories. Making the count a property of the rendered array — `rows.length`, from the array the panel renders — is what makes the two structurally incapable of drifting. A count computed from `plan.warnings.length` beside a panel that renders three categories is the same bug again with a bigger number.

- [ ] **Step 1: Write the failing pure test**

`__tests__/ai-review.test.ts`:

```ts
const plan = {
  warnings: [{ fixtureId: "f1", reason: "rest", detail: "18 min short of 45" }],
  unschedulable: [{ fixture_id: "f2", reason: "no court free in the window", rule: "CAP" }],
  assumptions: ["Read 'the weekend' as Sat + Sun."],
};

it("builds one row per reviewable item, in warning → unschedulable → assumption order", () => {
  const rows = buildReviewRows(plan as never);
  expect(rows.map((r) => r.kind)).toEqual(["warning", "unschedulable", "assumption"]);
});

it("counts every row it renders", () => {
  expect(reviewRowCount(buildReviewRows(plan as never))).toBe(3);
});

it("is empty for a clean plan", () => {
  expect(buildReviewRows({ warnings: [], unschedulable: [], assumptions: [] } as never)).toEqual([]);
});

it("does not drop a row category when another is empty", () => {
  const rows = buildReviewRows({ warnings: [], unschedulable: plan.unschedulable, assumptions: [] } as never);
  expect(rows).toHaveLength(1);
  expect(rows[0].kind).toBe("unschedulable");
});
```

- [ ] **Step 2: Run and watch it fail**

`npm test --workspace apps/web -- --reporter=json --outputFile=/tmp/w5-t4.json`

- [ ] **Step 3: Implement `ai-review.ts`**

Pure, no JSX, no hooks. `buildReviewRows` maps the three arrays in the fixed order above. `reviewRowCount(rows)` returns `rows.length` — and yes, that is the entire body; the value is that there is exactly one call site vocabulary for it and no second definition can appear.

- [ ] **Step 4: Extract `DivisionChip`**

Move `ai-competition-console.tsx:279-294` verbatim into `ai-division-chip.tsx`, including `divisionTint`/`divisionInk` and the `data-division-chip` attribute. Import it back into `ai-competition-console.tsx`. **Pure move — no behaviour change, no restyle.** Run the existing `ai-competition-console.test.tsx` and confirm it still passes unchanged; that suite is the proof the move was inert.

- [ ] **Step 5: Write the failing panel test**

`__tests__/ai-review-panel.test.tsx`, following the repo pattern exactly (`renderToStaticMarkup` inside `DictProvider` with the real `en/ui.json` — copy the setup from `ai-console-frozen.test.tsx`).

```tsx
it("renders every row category and states the count once", () => {
  const html = renderToStaticMarkup(
    <DictProvider dict={en}><AiReviewPanel rows={rows} fixtures={fixtures} /></DictProvider>,
  );
  expect(html).toContain('data-review-count="3"');      // anchored on =" — a bare
  // `data-review-count` probe would pass even when React omitted the prop.
  expect(html).toContain("18 min short of 45");
  expect(html).toContain("no court free in the window");
  expect(html).toContain("Read &#x27;the weekend&#x27; as Sat + Sun.");
});

it("carries the division chip on the joint console and omits it when unknown", () => {
  const html = renderToStaticMarkup(
    <DictProvider dict={en}>
      <AiReviewPanel rows={rows} fixtures={fixtures}
        divisionFor={(id) => (id === "f2" ? { id: "d1", name: "Under 16s Singles" } : null)} />
    </DictProvider>,
  );
  expect(html).toContain("Under 16s Singles");
  expect(html.match(/data-division-chip="/g) ?? []).toHaveLength(1);  // not guessed for f1
});

it("renders nothing at all for an empty row list", () => {
  const html = renderToStaticMarkup(
    <DictProvider dict={en}><AiReviewPanel rows={[]} fixtures={[]} /></DictProvider>,
  );
  expect(html).toBe("");
});
```

- [ ] **Step 6: Build the panel**

Visual contract — match the existing board idiom (`ai-diff-panel.tsx` is the reference; read it before styling):

- Container: `rounded-lg border border-amber-200 bg-amber-50/60 p-3`, matching the red blocking card's structure at `ai-diff-panel.tsx:103`.
- Header: `<p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-amber-800">` with a `⚠` `aria-hidden` glyph, the localized count string, and `data-review-count={rows.length}` on the container.
- Rows: `<li className="flex items-start gap-2 rounded-md border border-amber-200 bg-white px-2 py-1.5">`.
  - **warning** — fixture code (mono, `font-semibold text-slate-700`) + `Marker` if any + matchup; localized conflict label via the same `conflictLabel` helper `ai-diff-panel.tsx:63-68` uses (route the engine's camelCase reason through `board.conflict.*`, never render the engine's English); `detail` as `text-[10px] text-slate-500` below.
  - **unschedulable** — same head, then the solver's reason in `text-[11px] font-medium text-amber-700`, then a muted line saying the fixture stays in the tray (this is what actually happens; say it rather than leaving the organiser to infer it). Rule code as a mono chip: `<span className="shrink-0 rounded bg-amber-100 px-1 font-mono text-[9px] font-bold text-amber-800">{rule}</span>`.
  - **assumption** — no fixture, no chip: a `~` glyph and the sentence in `text-[11px] text-slate-600`, on `bg-slate-50/70` rather than white, so an interpretive note reads as a different weight from a solver finding.
- `divisionFor` non-null → render `<DivisionChip>` inline after the fixture code, `shrink-0`.
- `onPulse` → the header is a `<button>` that calls `onPulse(rows.filter(hasFixture).map(r => r.fixtureId))`, reusing the grid pulse `ScheduleStep` already wires at `ai-console.tsx:1289`. Keyboard-focusable, visible focus ring.
- **375px:** every row is `flex items-start` with `min-w-0 flex-1 truncate` on the matchup and `shrink-0` on chips and markers. No table, no fixed width, so no horizontal page scroll. If any content genuinely cannot wrap, put **that element** in `overflow-x: auto` — never the page.

- [ ] **Step 7: Add the strings to all four locales**

New keys in `board.ai.review.*`, added to `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`:

| key | en |
|---|---|
| `board.ai.review.title` | `To review` |
| `board.ai.review.count.one` | `{count} thing to review` |
| `board.ai.review.count.other` | `{count} things to review` |
| `board.ai.review.hint` | `None of these block the schedule. Check them before you apply.` |
| `board.ai.review.unschedulable` | `Left out — stays in the tray` |
| `board.ai.review.assumption` | `Assumed` |
| `board.ai.review.pulse` | `Show these on the board` |

Translate into es/fr/nl — real translations, not English copies. Then:

```bash
npm run i18n:gen-keys && npm run i18n:check
```
Expected: clean. `[i18n] missing key` lines from stub dicts are benign noise; anything naming `board.ai.review.*` is not.

- [ ] **Step 8: Run to green and commit**

```bash
npm test --workspace apps/web -- --reporter=json --outputFile=/tmp/w5-t4.json
git add -A && git commit -m "feat(board): one shared review panel, one definition of the count (#400, #388)"
```

---

## Task 5 — Wire the review panel into both consoles

**Files:**
- Modify: `apps/web/src/components/v2/board/ai-console.tsx` (`ScheduleStep` :1255-1330), `ai-diff-panel.tsx`, `ai-competition-console.tsx` (`JointReviewStep` :316, warnings list :545-608, count :552-558)
- Test: `apps/web/src/components/v2/board/__tests__/ai-console-review.test.tsx`, and extend `ai-competition-console.test.tsx`

**Interfaces:**
- Consumes: `buildReviewRows`, `reviewRowCount`, `reviewRowFixtureIds`, `AiReviewPanel` from Task 4; `assumptions` from Task 3.
- Produces: both consoles render the same panel from the same builder.

### Must-fix, carried from the Task 4 review (commit `22d4e223`)

These were found by reviewing Task 4 and are defects **in this task** if left undone.

1. **Do NOT source `divisionFor` from `plan.proposal`.** `ai-competition-console.tsx:355` builds `divisionOf` from `plan.proposal`, but proposal and unschedulable are mutually exclusive — deduped at `schedule-ai.ts:1390-1393`. Wire the panel off that map and every unschedulable row silently loses its chip, on the one console where the chip is the only thing naming the division, for exactly the rows that most need it. `AiConsoleFixture` (`ai-diff.ts:21-37`) carries **no `division_id`**, so the index you need does not exist yet — build a fixture→division map from the console's per-division fixture lists (or widen `AiConsoleFixture`). Write the failing test first: an unschedulable fixture that is absent from `proposal` must still render its chip.
2. **Delete `ai-competition-console.tsx:533-540`** — it still renders `plural("board.ai.joint.warnings", plan.warnings.length)` above the hand-rolled list. Retire the orphaned `board.ai.joint.warnings*` / `warningsTitle` keys from all four dictionaries, or the second count definition quietly returns and #388 is still live.
3. **The pulse must not point at nothing.** `reviewRowFixtureIds` currently feeds unschedulable ids to a button labelled "Show these on the board", but an unschedulable fixture is unscheduled and sits in the **tray**, not on the grid. Either filter the pulse to placed fixtures, or make the tray respond. Say which in the commit message.
4. **Lift `Marker` (JR/FINAL) into one module.** It is currently byte-identical in `ai-diff-panel.tsx:319-330` and `ai-review-panel.tsx:177-188` (Task 4 could not touch `ai-diff-panel.tsx`). The copies have not drifted, so the lift is mechanical and safe.

Also tighten two tests the review flagged as half-toothless:
- `ai-review-panel.test.tsx:96` — `enDict["board.conflict.warn.rest"]` is literally `"rest"`, identical to the fixture's raw token, so an implementation rendering `row.reason` raw passes that line. Use a reason whose localized label differs from its token.
- `ai-review-panel.test.tsx:163` — `toContain("min-w-0 flex-1 truncate")` matches if *any one* element has it. Assert a count of 2, the way the chip probes do.

**Sanctioned, do not "fix":** `ai-division-chip.tsx:19` carries `shrink`, not the `shrink-0` this plan's Task 4 Step 6 asked for. The verbatim-extraction rule outranked it and `shrink truncate max-w-[9rem]` is strictly better at 375px.

- [ ] **Step 1: Write the failing tests**

```tsx
it("single console renders unschedulable and assumptions after a run", () => {
  const html = renderScheduleStep({ plan: planWith({ unschedulable: [u1], assumptions: ["…"] }) });
  expect(html).toContain('data-review-count="2"');
  expect(html).toContain("no court free in the window");
});

it("joint console counts assumptions and unschedulable, not just warnings", () => {
  // Before this task the joint count read plan.warnings.length and said 1.
  const html = renderJointReview({ warnings: [w1], unschedulable: [u1], assumptions: ["…"] });
  expect(html).toContain('data-review-count="3"');
  expect(html).not.toContain("1 warning to review");
});

it("joint unschedulable rows carry the division chip", () => {
  const html = renderJointReview({ unschedulable: [u1] });
  expect(html).toContain('data-division-chip="');
});
```

- [ ] **Step 2: Run and watch them fail**

The joint one fails with `data-review-count="1"`-shaped output or no such attribute at all. That failure **is** #388.

- [ ] **Step 3: Wire the single console**

In `ScheduleStep` (`ai-console.tsx:1281-1300`), render `<AiReviewPanel>` between `<AiDiffPanel>` and the `board.ai.schedule.reviewNote` line, passing `onPulse` (already in scope at :1272). `AiDiffPanel` keeps `blocking` and the diff and gains nothing.

- [ ] **Step 4: Wire the joint console**

Delete the hand-rolled warnings list and count at `ai-competition-console.tsx:545-608` and render `<AiReviewPanel>` in its place, with `divisionFor` built from the console's own fixture list. **Build the map from the loaded fixtures, not from `plan.proposal`** — an unschedulable fixture is by definition absent from the proposal, so a proposal-derived map returns null for exactly the rows that need the chip most. Where the division genuinely is not known, pass null and omit the chip; never guess one.

Retire `board.ai.joint.warnings.one/other` and `board.ai.joint.warningsTitle` once nothing references them (`grep -a` all four dictionaries and all of `apps/web/src`). Removing a key that is still referenced fails `i18n:check` — that is the gate working.

- [ ] **Step 5: Run to green**

```bash
npm test --workspace apps/web -- --reporter=json --outputFile=/tmp/w5-t5.json
npm run i18n:gen-keys && npm run i18n:check
```

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(board): render unschedulable and assumptions on both consoles (#388)"
```

---

## Task 6 — The confirm gate: preview card and two-stage run (single console)

**Files:**
- Create: `apps/web/src/components/v2/board/ai-instruction-describe.ts`, `apps/web/src/components/v2/board/ai-instruction-preview.tsx`
- Modify: `apps/web/src/components/v2/board/ai-console-state.ts`, `ai-console.tsx` (`BriefStep` :989-1196, `run` :532)
- Test: `__tests__/ai-instruction-describe.test.ts`, `__tests__/ai-console-preview-gate.test.ts`, `__tests__/ai-instruction-preview.test.tsx`

**Interfaces:**
- Consumes: `AiParsePreviewResponse` (Task 1); `HardConstraint` (`packages/engine/src/scheduling/constraints.ts:61-86`).
- Produces:
  ```ts
  export function constraintToken(c: HardConstraint): string;              // "REST" | "PER DAY" | …
  export function describeHardConstraint(c: HardConstraint, msg: Msg, names: NameLookup): string;
  export function canRun(state: AiConsoleState): boolean;                  // consumed by Task 7
  ```

**Design direction — read this before writing JSX.** The organiser typed a sentence; this card is the receipt for what the machine will actually enforce. The signature element is a **rule ledger**: a hairline vertical spine down the left of the enforced list, with a monospace constraint token sitting on it and the plain-English reading to its right. The tokens are the engine's own six constraint kinds, so the card teaches real product vocabulary rather than decorating the list — and the same words come back later when a conflict cites the rule. Everything else stays quiet and inside the existing card idiom (`rounded-lg border border-slate-200`, 11px uppercase tracking-wide section labels, mono chips on `ring-1 ring-inset ring-slate-200`). Spend the boldness on the spine and nowhere else.

Do **not** use rule codes (H2/H4/H8) as the token here: every compiled instruction rule verifies as H8, so a rule-code chip would print the same character on every row and say nothing.

- [ ] **Step 1: Write the failing describe test**

`__tests__/ai-instruction-describe.test.ts` — one case per `HardConstraint` variant, all six:

```ts
it.each([
  [{ type: "min_rest_minutes", minutes: 45, rest_scope: "per_person", scope: { kind: "competition" } }, "REST", "at least 45 min rest between a player's matches"],
  [{ type: "max_fixtures_per_day", count: 2, scope: { kind: "competition" } }, "PER DAY", "at most 2 matches a day"],
  [{ type: "fixture_on_weekday", selector: { kind: "terminal" }, weekday: "FRI", scope: { kind: "competition" } }, "WEEKDAY", "the final on Friday"],
  [{ type: "fixture_on_date", selector: { kind: "terminal" }, date: "2026-08-07", scope: { kind: "competition" } }, "DATE", "the final on 7 Aug 2026"],
  [{ type: "not_before", time: "09:00", scope: { kind: "competition" } }, "NOT BEFORE", "nothing before 09:00"],
  [{ type: "not_after", time: "21:00", scope: { kind: "competition" } }, "NOT AFTER", "nothing after 21:00"],
])("describes %s", (c, token, text) => {
  expect(constraintToken(c as HardConstraint)).toBe(token);
  expect(describeHardConstraint(c as HardConstraint, msg, names)).toContain(text);
});

it("names a division-scoped rule rather than implying it binds the whole board", () => {
  const c = { type: "max_fixtures_per_day", count: 2, scope: { kind: "division", divisionId: "d1" } };
  expect(describeHardConstraint(c as HardConstraint, msg, names)).toContain("Under 16s Singles");
});
```

`describeHardConstraint` must be an **exhaustive switch with a `never` default**, so adding a seventh `HardConstraint` variant fails to compile rather than rendering a blank row — the same discipline `RULE_BY_REASON` uses for `ConflictReason`.

- [ ] **Step 2: Run and watch it fail. Then implement `ai-instruction-describe.ts`.**

All strings come from `msg()` with interpolation — never build an English sentence in code.

- [ ] **Step 3: Write the failing reducer/gate test**

`__tests__/ai-console-preview-gate.test.ts` — pure reducer, no DOM. **This is the test that makes "declining spends no credit" true on the client.**

```ts
it("cannot run before a preview is confirmed", () => {
  const s = reduce(initial, { type: "SET_INSTRUCTION", instruction: "finals on Friday" });
  expect(canRun(s)).toBe(false);                       // the run button is not the first click
});

it("can run once a preview is ready", () => {
  const s = reduce(withInstruction, { type: "PREVIEW_READY", preview: PREVIEW });
  expect(canRun(s)).toBe(true);
  expect(s.preview.id).toBe(PREVIEW.preview_id);       // the run carries it
});

it("declining clears the preview and returns to an editable brief without running", () => {
  const s = reduce(withPreview, { type: "PREVIEW_DISMISS" });
  expect(s.preview.status).toBe("idle");
  expect(canRun(s)).toBe(false);
  expect(s.run).toBe("idle");                          // no run was ever started
});

it("editing the instruction invalidates a preview already given", () => {
  const s = reduce(withPreview, { type: "SET_INSTRUCTION", instruction: "finals on Saturday" });
  expect(s.preview.status).toBe("idle");
  expect(canRun(s)).toBe(false);                       // you cannot confirm rules for an old sentence
});

it("a failed compile does not become runnable by itself", () => {
  const s = reduce(withInstruction, { type: "PREVIEW_READY", preview: { ...PREVIEW, failed: true, preview_id: undefined } });
  expect(canRun(s)).toBe(false);                       // silent fallback is refused
});

it("taking the preference fallback is an explicit action, and it runs", () => {
  const s = reduce(failedPreview, { type: "PREVIEW_AS_PREFERENCE" });
  expect(canRun(s)).toBe(true);
  expect(s.preview.asPreference).toBe(true);           // and the run says so
});
```

- [ ] **Step 4: Run and watch it fail. Then implement the state slice.**

In `ai-console-state.ts`, add to `AiConsoleState`:

```ts
preview: {
  status: "idle" | "loading" | "ready" | "error";
  data: AiParsePreviewResponse | null;
  id: string | null;
  /** Set only by an explicit organiser choice after a failed compile. The run
   *  then sends the sentence as a preference, and nothing pretends it is
   *  enforced. Never set by the reducer on its own. */
  asPreference: boolean;
  error: string | null;
};
```

Actions: `PREVIEW_START`, `PREVIEW_READY`, `PREVIEW_ERROR`, `PREVIEW_DISMISS`, `PREVIEW_AS_PREFERENCE`. `SET_INSTRUCTION` resets `preview` to idle whenever the trimmed instruction differs from the previewed one.

`canRun(state)` returns true only when `preview.status === "ready" && (preview.id !== null || preview.asPreference)` and the existing `tooShort`/`busy`/`scheduleFrozen` conditions are clear. Export it; `BriefStep` and Task 7's joint brief both use it, so the gate has one definition.

- [ ] **Step 5: Write the failing preview-card render test**

`__tests__/ai-instruction-preview.test.tsx`, `renderToStaticMarkup` + `DictProvider`:

```tsx
it("renders the enforced rules, the verbatim unparsed text and the assumptions", () => {
  const html = render(<AiInstructionPreview preview={PREVIEW} credits={2} onConfirm={noop} onDismiss={noop} />);
  expect(html).toContain('data-preview-state="ready"');   // anchored on ="
  expect(html).toContain("at most 2 matches a day");
  expect(html).toContain("…verbatim wording…");            // unparsed, untouched
  expect(html).toContain("read the end as the following week");
});

it("shows soft preferences as not enforced", () => {
  const html = render(<AiInstructionPreview preview={withSoft} … />);
  expect(html).toContain("Preferred, not enforced");
});

it("says so when nothing in the sentence could be enforced", () => {
  const html = render(<AiInstructionPreview preview={{ ...PREVIEW, compiled: { hard: [], soft: [], unparsed: ["…"], assumptions: [] } }} … />);
  expect(html).toContain("Nothing in this instruction can be enforced");
});

it("offers the preference fallback on a failed compile and never auto-takes it", () => {
  const html = render(<AiInstructionPreview preview={{ ...PREVIEW, failed: true, preview_id: undefined }} … />);
  expect(html).toContain('data-preview-state="failed"');
  expect(html).toContain("Run it as a preference instead");
  expect(html).not.toContain('data-preview-confirm="1"');  // no confirm path out of a failure
});

it("names the price at the confirm", () => {
  const html = render(<AiInstructionPreview preview={PREVIEW} credits={2} … />);
  expect(html).toContain('data-ai-credits="2"');
});
```

- [ ] **Step 6: Run and watch it fail. Then build `ai-instruction-preview.tsx`.**

Card structure, top to bottom:

1. Eyebrow `READ AS` — `text-[11px] font-semibold uppercase tracking-wide text-slate-500`.
2. **The rule ledger.** `<ul className="mt-2 space-y-1.5 border-l-2 border-violet-200 pl-3">`; each row `<li className="flex items-start gap-2">` with a token chip `<span className="shrink-0 rounded bg-violet-50 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-violet-700 ring-1 ring-inset ring-violet-200">` and the described text `text-xs text-slate-700`. A non-competition scope adds a second muted line naming the division/pool it binds.
3. **Preferred, not enforced** — the `soft` rows, same list shape, slate tokens, no spine tint. Include the honest one-liner: a preference can be ignored. Without this the organiser reads every compiled line as binding, which is the same misreading the wave exists to stop.
4. **Couldn't use** — `unparsed`, verbatim, in `<blockquote className="border-l-2 border-slate-200 pl-3 text-xs italic text-slate-500">`, with a line saying it was not turned into a rule.
5. **Assumed** — the resolver's `compiled.assumptions`, `~` glyph rows, `text-[11px] text-slate-600`.
6. **Window strip** — `window.start → window.end`, with the org timezone named. One line, mono, `text-[11px]`.
7. **Confirm bar** — `flex flex-wrap gap-2`: primary `Run with these rules · {credits}` carrying `data-preview-confirm="1"` and `data-ai-credits`, ghost `Back to the brief`. On the failed state the pair is instead ghost `Run it as a preference instead` + primary `Edit the brief`, and there is no confirm.
8. `data-preview-state={failed ? "failed" : "ready"}` on the container.

Empty-compile state (hard and soft both empty): replace the ledger with the "nothing can be enforced" line and keep `unparsed` visible — a preview that renders an empty list looks like a success.

**375px:** the ledger rows wrap under their token, the window strip wraps, the confirm bar wraps to two full-width buttons. No horizontal page scroll.

- [ ] **Step 7: Wire `BriefStep`**

At `ai-console.tsx:1174`, the button becomes two-stage:

- `canRun(state) === false` and `!tooShort` → primary button `Check what this means`, `onClick` posts `/schedule/ai-preview` and dispatches `PREVIEW_START`/`PREVIEW_READY`/`PREVIEW_ERROR`.
- `preview.status === "ready"` → render `<AiInstructionPreview>` above the button; the card's own confirm calls the existing `run` (`:532`), which now sends `preview_id: state.preview.id` (or `as_preference: true`).
- `busy` keeps today's spinner and `RunElapsed`.
- `tooShort`, `scheduleFrozen` keep today's behaviour exactly — a frozen board still refuses before anything is spent.

**Declining is a pure client action**: `PREVIEW_DISMISS` dispatches and no request is made. That is the whole gate.

- [ ] **Step 8: Add the strings to all four locales**

`board.ai.preview.*`: `readAs`, `check`, `confirm`, `dismiss`, `soft.title`, `soft.hint`, `unparsed.title`, `unparsed.hint`, `assumed.title`, `window`, `empty`, `failed.title`, `failed.hint`, `failed.asPreference`, `failed.edit`, plus the six `board.ai.preview.rule.*` templates `describeHardConstraint` interpolates. English first, then real es/fr/nl translations.

```bash
npm run i18n:gen-keys && npm run i18n:check
```

- [ ] **Step 9: Run to green and commit**

```bash
npm test --workspace apps/web -- --reporter=json --outputFile=/tmp/w5-t6.json
git add -A && git commit -m "feat(board): compiled-instruction preview with a confirm gate (#400)"
```

### Task 6b — carried from the Task 6 review (`5302e723`..`b8d49ffb`, verdict *fix-then-ship*)

**Sequenced after Task 7**, because both touch the four dictionaries. The headline guarantee was verified sound and is not in question: `canRun` lives in the reducer, is enforced again at the request site, `PREVIEW_DISMISS` fires no request and keeps state, `RUN_START` burns the id, both switches fail to compile on a seventh variant, and the two `assumptions` are not conflated.

- [ ] **The failed-preview copy states the opposite of what happens.** `board.ai.preview.failed.hint` promises "the architect will read it, and nothing will check it", but with no `as_preference` wire field the fallback posts a run with no `preview_id`, and `schedule-ai.ts:2319` reads `confirmed === null` as compile-inline. Stage 1 runs again, and a retry that succeeds produces **hard constraints the organiser never saw and never approved** — the exact failure this wave exists to close, surviving on the one path where the compiler choked.

  **Ruling: reword now, fix properly later.** Reword all four locales to promise only what is true — we read it again, and anything we can enforce, we will. Do **not** widen the server contract from a client task: `src/server/**` is settled and reviewed. **File a follow-up issue** for an `as_preference` request field so the fallback can be both honest *and* safe, and reference it from the reworded key's comment. Blocking the run outright on a failed compile was considered and rejected — it strands the organiser whenever the compiler chokes, which is worse than an honest fallback.

- [ ] **English prose on the signature element.** `PER DAY` / `NOT BEFORE` / `NOT AFTER` / `WEEKDAY` (`ai-instruction-describe.ts:62-81`) and `PREFER` (`ai-instruction-preview.tsx:170`) are hardcoded English. The file header invokes the `CAP`/`FN`/`JR` precedent, but those are *abbreviations* and these are English words — a French organiser reads four of them on the element the plan calls the signature. Use locale-neutral forms (`MAX/DAY`, `≥ TIME`, `≤ TIME`, `DAY`) to keep the "same token in every locale" property without shipping English prose. `PREFER` is not one of the engine's six kinds at all, so the precedent does not reach it even in principle — give it a dictionary key or reuse the `~` glyph idiom from the assumptions rows.

- [ ] **The soft-preference row overclaims** (`ai-instruction-preview.tsx:157-178`). Raised by the owner against a real render: *"PREFER — Put the under-14s on the show court where families can watch"*. Asked how we know a family can watch that court, the answer is that we do not, and cannot. Traced: `parsed.soft` reaches exactly one consumer, `schedule-ai-prompt.ts:135` (the architect's prompt); it never reaches the verifier. There is **no court attribute concept anywhere in the engine**, and **no `HardConstraint` variant selects a court**, so a court placement is structurally unenforceable no matter how clearly the organiser phrases it.

  The section hint does say "not enforced", which is why review passed it. The owner's reading is sharper: the token `PREFER` reads as *the system will try*, and beside a clause we cannot model it reads as *the system understood*. Neither is true. **Name the mechanism, not the intention** — the architect is told, and nothing afterwards checks whether it listened. Same defect class as the failed-preview hint above: the card describing an intention instead of a behaviour. Reword the token and hint in all four locales.

  Related follow-up (do NOT build in this wave): typed court attributes plus a court selector in the constraint vocabulary, which is what would make this row mean something. Keep machine-readable tags and human free-text notes strictly apart — a free-text court note fed to the compiler reproduces this exact overclaim one layer down.

- [ ] **A dead confirm button.** `ai-instruction-preview.tsx:96,274` renders the confirm whenever `failed === false`, but the schema permits `failed: false` with `preview_id` absent; `canRun` is then false and the button does nothing with no feedback. Gate the confirm on `preview.preview_id`, or treat a missing id as the failed layout.

- [ ] **The in-callback gate has no test.** Deleting the guard at `ai-console.tsx:588` leaves all 47 tests green — the reducer suite never calls `run`, so only the JSX path is pinned. Add a fetch-spy test that dispatches `SET_INSTRUCTION`, calls the confirm, and asserts **zero POSTs**. This is the wave's headline guarantee; it should not rest on an untested line.

- [ ] **Minor** — `preview()` at `ai-console.tsx:548` guards on length/busy/loading but not `scheduleFrozen`; only the button's `disabled` attribute stops it, and a `disabled` prop is not a guarantee. Thread the prop or accept it explicitly. Also unexport `constraintScopeClause` (`ai-instruction-describe.ts:142`) until Task 7 needs it.

---

## Task 7 — The same gate on the joint console

**Files:**
- Modify: `apps/web/src/components/v2/board/ai-competition-console.tsx` (brief/quote step and its run call), `ai-joint-run.ts`
- Test: extend `__tests__/ai-competition-console.test.tsx`

**Interfaces:**
- Consumes: `AiInstructionPreview`, `canRun` (Task 6), the competition preview route (Task 1).
- Produces: the joint run carries `preview_id` and the same decline-is-free property.

- [ ] **Step 1: Write the failing test**

```tsx
it("joint console will not run before the compile is confirmed", () => {
  expect(canRun(jointStateWithInstruction)).toBe(false);
});

it("joint preview posts the selected divisions so the window resolves as the run will", () => {
  // assert the request body carries division_ids matching the picker selection
});

it("joint confirm sends preview_id", () => {
  // assert the run body carries preview_id from the preview response
});
```

- [ ] **Step 2: Run, fail, then wire it**

Reuse `AiInstructionPreview` unchanged — it takes an `AiParsePreviewResponse` and knows nothing about scope. The joint preview request carries `division_ids` from the division picker, because the resolved window depends on which divisions are in scope and a preview resolved against a different set is a preview of a different run.

- [ ] **Step 3: Run to green, i18n check, commit**

```bash
npm test --workspace apps/web -- --reporter=json --outputFile=/tmp/w5-t7.json
npm run i18n:gen-keys && npm run i18n:check
git add -A && git commit -m "feat(board): confirm gate on the joint console (#400)"
```

### Carried from the Task 5 review (commit `a6c8ae6a`, verdict *ship*)

Four Minors and one framing gap, all landing in files Task 7 already owns. None blocks Task 5; all are cheaper to fix here than to file.

- [ ] **The pulse label under-selects.** `board.ai.review.pulse` reads "Show these on the board", but the pulse is filtered to `kind === "warning"` (`ai-review.ts:100`) while the card also holds unschedulable rows — so "these" highlights a subset and says nothing about it. Filtering was the right call (an unschedulable fixture is absent from `proposal` and has no grid block to light), so fix the copy, not the filter: name the placed subset and carry the count of what will actually light up. All four locales.

- [ ] **Two toothless assertions in `__tests__/ai-competition-console.test.tsx`.**
  - `:518` — `expect(html).not.toContain("1 warning to review")` can never fail: the key that produced that sentence is retired, so no implementation can render it. The real guard is the `data-review-count="3"` line above. Replace with `expect(html.match(/data-review-count="/g)).toHaveLength(1)` — that one *would* fail if a second count were reintroduced, which is the property #388 exists to protect.
  - `:498-505` — the `card()` helper slices from the first `<section`, sound today only because `ai-competition-console.tsx` happens to contain no `<section>` of its own. A future `<section>` above the panel silently retargets every chip assertion without failing. Slice on `data-review-count` instead.

- [ ] **`AiConsoleFixture.division_id` has no enforcement** (`ai-diff.ts:27-41`). It is optional and only `consoleFixtures` (`schedule-board.tsx:254`) populates it; a new production builder that omits it drops the joint chip again with no type error. Not worth a type change — leave a comment naming the single populating call site as load-bearing.

- [ ] **`skipped_divisions` and `divergent_courts` sit in the amber band but outside the count** (`ai-competition-console.tsx:526`, `:534`). Task 4 defines three review categories and these are not among them, so this is spec-sanctioned rather than a defect — but an uncounted amber note beside a counted one is precisely the drift #388 was filed about. **Ruling: demote them visually out of the amber band, do not count them.** They are division-level notes, not per-fixture review rows; folding them into `reviewRowCount` would make one number mean two different units, which is a worse bug than the one being fixed.

---

## Task 8 — e2e, smoke, help, and the screenshot pass

**Files:**
- Modify: `apps/web/e2e/ai-architect.spec.ts`, `scripts/smoke.ts` (`v4AiSuite` :5563, `jointAiSuite` :5978), `apps/web/content/help/scheduling/ai-scheduling.md`
- Possibly create: `apps/web/content/help/scheduling/instruction-preview.md` + a line in `apps/web/src/lib/help.ts:31-40`

**COORDINATION:** a separate branch is repairing `e2e/ai-architect.spec.ts:159` (`pro: brief → run → CLEAN → officials → apply → undo`). **Rebase onto `main` and confirm that fix has landed before editing this spec**, or the two edits collide in the same test body. Check with `git log --oneline origin/main -5` and `gh pr list`.

- [ ] **Step 1: Update the e2e flow for the gate**

The pro flow now types the brief, clicks `Check what this means`, waits for the preview, and clicks `Run with these rules`. Scope every assertion to the preview container, not the page body — a page-wide `getByText` will match the brief textarea's own content.

Add a new e2e case, which is the acceptance case for the whole wave:

```ts
test("pro: declining the compiled instruction spends no credit", async ({ page }) => {
  const before = await creditBalance(page);
  await typeBrief(page, "at most 2 matches a day, final on Friday");
  await page.getByRole("button", { name: "Check what this means" }).click();
  await expect(page.locator('[data-preview-state="ready"]')).toBeVisible();
  await page.getByRole("button", { name: "Back to the brief" }).click();
  await expect(page.locator('[data-preview-state="ready"]')).toHaveCount(0);
  expect(await creditBalance(page)).toBe(before);        // the point of the wave
});
```

Before editing, `grep -a` every literal string this plan introduces across **both** e2e phases — UI text changes break e2e here and it is cheaper to find them now.

- [ ] **Step 2: Run e2e locally**

Production build + `E2E_PROD_TARGET` on :3100. Never enable `e2e.yml`. Run the whole `ai-architect.spec.ts` file and paste the raw counts.

- [ ] **Step 3: Extend `scripts/smoke.ts`, pro and free paths**

In `v4AiSuite` (:5563) and `jointAiSuite` (:5978), following the existing step shape at :5583-5593:

```ts
const pv = await v1(pro, `/api/v1/divisions/${divId}/schedule/ai-preview`, "POST", { instruction: "at most 2 matches a day" });
check("W5 preview: compiles without spending a credit", pv.status === 200 && pv.json.compiled?.hard?.length > 0 && (await creditsOf(pro)) === creditsBefore);

const stale = await v1(pro, `/api/v1/divisions/${divId}/schedule/ai-plan`, "POST", { instruction: "a different sentence", preview_id: pv.json.preview_id });
check("W5 preview: a changed instruction 409s rather than recompiling", stale.status === 409);

const capped = await v1(free, `/api/v1/divisions/${freeDivIds.divId}/schedule/ai-preview`, "POST", { instruction: "…" });
check("W5 preview/free: an exhausted wallet 402s before any model call", capped.status === 402);
```

- [ ] **Step 4: Help pages — English tree only, no i18n owed**

Update `apps/web/content/help/scheduling/ai-scheduling.md` with a section on the preview: what the compiled rules mean, that declining costs nothing, that a preference is not enforced, and what an unschedulable fixture means for the tray. If it warrants its own article, create it and add the slug to the ordered array at `apps/web/src/lib/help.ts:31-40`. Whatever `copy-truth.ts` checks must stay green.

- [ ] **Step 5: Screenshot every state at desktop and 375px**

Playwright MCP, both widths, **no horizontal page scroll at 375px** — verify by asserting `document.scrollingElement.scrollWidth <= clientWidth`, not by eye. States to capture:

1. brief typed, before preview
2. preview ready — rules, soft, unparsed, assumptions, window, confirm bar
3. preview with nothing enforceable
4. preview failed → preference fallback
5. review panel with all three row kinds (single console)
6. review panel on the joint console, chips visible

- [ ] **Step 6: Full gate, raw counts, then commit**

```bash
npm run typecheck && rtk proxy npm run lint
npm test --workspace apps/web -- --reporter=json --outputFile=/tmp/w5-final.json
node -e "const r=require('/tmp/w5-final.json');console.log(r.numPassedTests,'/',r.numTotalTests,'failed',r.numFailedTests)"
npm run i18n:gen-keys && npm run i18n:check
npm run openapi:gen && git status --short openapi/
```

Read `✖ N problems` from the lint output directly — `rtk` hides it, and "ESLint output (JSON parse failed)" is the wrapper losing the result, not a clean run.

```bash
git add -A && git commit -m "test(scheduler): e2e, smoke and help for the W5 review panel (#400)"
git push -u origin feat/w5-ai-review-panel
gh pr create --title "W5: AI review panel — instruction preview, assumptions, unschedulable (#400, #388)" --body "…"
```

Smoke CI runs on **PRs only** — merging locally and pushing to `main` skips it. This work must go through a PR.

---

## Self-review against the issue's acceptance criteria

| AC | Task |
|---|---|
| Preview renders compiled constraints, `unparsed` verbatim, and assumptions | 6 (card), 1 (contract) |
| Confirm gates the architect run; declining spends **no credit** | 6 (reducer gate + e2e), 1 (endpoint spends nothing), 2 (reuse, no double parse) |
| Parse failure surfaces the preference fallback, and taking it is an explicit choice | 6 (`PREVIEW_AS_PREFERENCE`, no auto-fallback, asserted) |
| `assumptions` render on both single and joint consoles | 3 (server), 4 (rows), 5 (both consoles) |
| `unschedulable` render with reason; joint console carries the division chip | 4, 5 |
| The warnings count covers every amber row on screen, defined in one place | 4 (`reviewRowCount(rows) === rows.length`, one builder, both consoles) |
| Every new string in all four locales; `gen-keys` and `i18n:check` clean | 4, 6, 7, 8 |
| 375px clean on every new panel | 4, 6, 8 (measured, not eyeballed) |
| Help pages updated (English tree only) | 8 |
| Screenshots attached for review before merge | 8 |

**Beyond the issue, deliberately included:** soft preferences rendered as *not enforced* (without it every compiled line reads as binding — the same misreading the wave exists to stop); the empty-compile state; the price named at the confirm; the unschedulable row group pulsing its fixtures on the grid through the mechanism `ScheduleStep` already wires; single-use previews so a double-submit cannot run twice off one confirmation.
