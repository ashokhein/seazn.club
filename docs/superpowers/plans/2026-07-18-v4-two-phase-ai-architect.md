# v4 Two-Phase AI Schedule Architect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the retired prose→constraints AI with a two-phase AI matchday architect: Phase A plans fixture times/courts, Phase B assigns officials to the dry-run schedule, both propose-only with engine referees, plus a guided-intake board console.

**Architecture:** Both phases follow *solver drafts → LLM plans → engine referees*. Phase A: `slotFixtures` draft → `claude-opus-4-8` structured output → `validateAssignments` referee, ≤2 repair rounds. Phase B: `assignOfficials` draft → LLM → proposal-as-locked engine pass + server `ineligible` supplement. Accept chains the two existing apply rails. UI is a 4-step console (Brief → Schedule → Officials → Apply) on the schedule board.

**Tech Stack:** Next.js app router (apps/web), `@anthropic-ai/sdk ^0.110` (`messages.parse` + `zodOutputFormat`), zod 4, `@seazn/engine` (pure), postgres.js, vitest, Playwright.

**Spec:** `design/v4/03-two-phase-officials-and-intake.md` (normative) + `design/v4/00|01|02` as amended. Corpus prompts 41–43 are background only — THIS plan supersedes their task lists.

## Global Constraints

- Model call (verbatim from 01 §1): `client.messages.parse({ model: process.env.SCHEDULING_AI_MODEL ?? "claude-opus-4-8", max_tokens: 32_000, thinking: {type: "adaptive"}, output_config: {effort: "high", format: zodOutputFormat(...)}, system: [{type:"text", text: SYSTEM_PROMPT, cache_control: {type:"ephemeral"}}], messages })`. Abort controller 120s/round. `stop_reason === "refusal"` → 422 before reading content.
- Gates: Phase A `scheduling.ai`, Phase B `officials.auto` (+ `officials.roles_multi` if `policy.roles.length > 1`). Both Pro Plus. Check order: auth → PostHog `ai-scheduling` kill-switch (fallback true) → `requireFeature` → `rateLimit` → validation.
- Propose-only: no endpoint writes fixtures/officials. Apply = existing routes only.
- Repair rounds ≤2 per run. Movable fixtures ≤500 (422 `AI_PLAN_TOO_LARGE`). Flexible divisions 409 `AI_PLAN_UNSUPPORTED`.
- Deterministic packs: sorted keys, fixtures ordered `round_no, seq_in_round, ext_key`; officials by `display_name, id`.
- Errors: no `ANTHROPIC_API_KEY` → 503; refusal/unparseable after 1 retry → 422 `AI_PLAN_FAILED`; empty repair scope → 422 `AI_PLAN_EMPTY_SCOPE`; zero officials → 422 `NO_OFFICIALS`.
- Every new v1 route registered in `apps/web/src/server/api-v1/openapi.ts` ROUTES (coverage test enforces).
- House rules: every change ships a failing-without-it test; `tsc` + unit green before every push; vitest runs from `apps/web` cwd (`@/` aliases); i18n keys land in all 4 locales (en/fr/es/nl parity test); help articles mandatory in closing task.
- UI: caveman-free normal prose in code/comments; console styling `.app-*` rails; 3-colour state contract (amber moved / teal verified / red flagged); `prefers-reduced-motion` dumps traces instantly; screenshot-verify desktop + 390px for every UI task (frontend-design skill).
- Commits: small, per task, `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Migration V292 — `schedule_source` gains `ai`

**Files:**
- Create: `db/migration/deltas/V292__ai_schedule_source.sql`
- Modify: `apps/web/src/server/api-v1/schemas.ts` (ApplyScheduleRequest source enum)

**Interfaces:**
- Produces: `fixtures.schedule_source` accepts `'ai'`; `ApplyScheduleRequest.source` zod enum includes `"ai"`.

- [ ] **Step 1: Verify V292 is free**

Run: `ls db/migration/deltas | sort -V | tail -3`
Expected: `V290__pro_plus_plan.sql` is last. If a V292 exists (parallel branch landed; clubs-w1 branch already owns V291), bump this file to the next free number everywhere it appears in this plan.

- [ ] **Step 2: Write the migration**

```sql
-- V292: AI Schedule Architect (v4/03 §4) — fixtures placed by the AI accept
-- flow carry schedule_source='ai' so the ledger and analytics can tell AI
-- applies from auto/manual ones.
alter table fixtures drop constraint if exists fixtures_schedule_source_check;
alter table fixtures add constraint fixtures_schedule_source_check
  check (schedule_source in ('none', 'auto', 'manual', 'ai'));
```

- [ ] **Step 3: Find the current enum in schemas.ts and extend it**

Run: `grep -n '"none", "auto", "manual"' apps/web/src/server/api-v1/schemas.ts`
Change the `source` enum on `ApplyScheduleRequest` from `z.enum(["none", "auto", "manual"])`-style (match exact current members; it may be `["auto","manual"]`) to include `"ai"`.

- [ ] **Step 4: Failing test — apply route accepts `source:"ai"`**

Add to the existing apply-schedule test file (find with `grep -rln "applySchedule" apps/web/src/server/usecases/__tests__ | head -1`):

```ts
it("accepts source 'ai' and stamps schedule_source", async () => {
  // reuse the file's existing seeded stage + assignment fixture helpers
  const out = await applySchedule(auth, stageId, {
    source: "ai",
    expected_seq: seq,
    assignments: [existingAssignment],
  });
  expect(out.applied).toBeGreaterThan(0);
  const [row] = await sql`select schedule_source from fixtures where id = ${existingAssignment.fixture_id}`;
  expect(row.schedule_source).toBe("ai");
});
```

- [ ] **Step 5: Run test — expect FAIL** (zod rejects `"ai"`), then apply migration to the local test DB per `project_local_test_db` recipe (`DATABASE_URL=postgresql://postgres@127.0.0.1:54329/... npm run db:apply` from repo root) and make the schema edit. Re-run: PASS.
- [ ] **Step 6: `cd apps/web && npx tsc --noEmit` green. Commit** `feat(v4): V292 schedule_source 'ai' + apply enum`

---

### Task 2: Remove the old prose→constraints AI

**Files:**
- Modify: `apps/web/src/server/usecases/schedule-plus.ts` (delete lines ~148–275: `AiConstraints` zod + type, `parseAiConstraints`, `AiConstraintsOut`, `aiConstraintsForDivision`)
- Delete: `apps/web/src/app/api/v1/divisions/[id]/schedule/ai-constraints/route.ts`
- Modify: `apps/web/src/server/api-v1/openapi.ts:215` (drop the ai-constraints RouteSpec row) + `schemas.ts` (drop `AiConstraintsRequest` and any response schema only it uses)
- Modify: `apps/web/src/components/v2/constraints-panel.tsx:162-164` region (delete the parked prose box comment block + any dead handlers/imports it references)
- Delete: old tests exercising ai-constraints (`apps/web/src/server/usecases/__tests__/schedule-plus.test.ts` ai cases + `schedule-plus-flag.test.ts` if it only covers the old feature — if it tests the kill-switch helper generically, keep the file and retarget it in Task 6)

**Keep:** entitlement key `scheduling.ai` (V245 row), PostHog flag `ai-scheduling`, env `SCHEDULING_AI_MODEL`, `@anthropic-ai/sdk` dependency, `feature-copy.ts` entries (already Pro Plus wording — verify, don't edit).

- [ ] **Step 1: Delete in the order above.** Fix imports as tsc complains.
- [ ] **Step 2: Run the openapi coverage test** (find: `grep -rln "ROUTES" apps/web/src/server/api-v1/__tests__ | head -1`): PASS with the row gone.
- [ ] **Step 3: Full check** `cd apps/web && npx tsc --noEmit && npx vitest run` — green, no orphan references.
- [ ] **Step 4: Commit** `feat(v4): remove prose→constraints AI (keep gate/flag/env plumbing)`

---

### Task 3: Prompt module — Phase A system prompt + output zod

**Files:**
- Create: `apps/web/src/server/usecases/schedule-ai-prompt.ts`
- Test: `apps/web/src/server/usecases/__tests__/schedule-ai-prompt.test.ts`

**Interfaces:**
- Produces: `SYSTEM_PROMPT: string`, `AiAssignment`, `AiSchedulePlan` (zod), `AiConstraintDelta` (partial of engine constraints schema, reused not redeclared).

- [ ] **Step 1: Write the module.** The system prompt is **verbatim `design/v4/01-llm-contract.md` §4** with ONE addition — append to SOFT GOALS after item (c):

```text
d. Coverage: prefer slots where each required officiating role has an eligible, free
   official (see officials in the pack); name coverage risks in summary.
e. Stability: in refine and repair modes move as few fixtures as possible; prefer keeping
   the prior proposal where it already satisfies the instruction.
```

(The corpus's old (d) stability becomes (e). Copy the full prompt text from 01 §4 — do not paraphrase.)

```ts
import { z } from "zod";
import { SchedulingConstraints } from "@seazn/engine/scheduling";

export const SYSTEM_PROMPT = `...verbatim from 01 §4 with the soft-goal edit above...`;

export const AiAssignment = z.object({
  fixture_id: z.string().uuid(),
  scheduled_at: z.string().datetime({ offset: true }),
  court_label: z.string().min(1),
  schedule_locked: z.boolean().optional(),
});
export const AiConstraintDelta = SchedulingConstraints.partial();
export const AiSchedulePlan = z.object({
  assignments: z.array(AiAssignment).max(500),
  unschedulable: z.array(z.object({ fixture_id: z.string().uuid(), reason: z.string().max(200) })),
  explanations: z.array(z.object({ fixture_id: z.string().uuid(), note: z.string().max(200) })).max(60),
  constraint_suggestions: AiConstraintDelta.optional(),
  summary: z.string().max(600),
});
export type AiSchedulePlan = z.infer<typeof AiSchedulePlan>;
```

- [ ] **Step 2: Golden test** — snapshot the prompt so edits are deliberate:

```ts
import { describe, it, expect } from "vitest";
import { SYSTEM_PROMPT, AiSchedulePlan } from "../schedule-ai-prompt";

describe("schedule-ai prompt contract", () => {
  it("system prompt is frozen", () => {
    expect(SYSTEM_PROMPT).toMatchSnapshot();
  });
  it("plan schema rejects an assignment missing a court", () => {
    const bad = { assignments: [{ fixture_id: crypto.randomUUID(), scheduled_at: "2026-07-18T10:00:00+01:00" }], unschedulable: [], explanations: [], summary: "x" };
    expect(AiSchedulePlan.safeParse(bad).success).toBe(false);
  });
});
```

- [ ] **Step 3: Run (fails on missing module → then passes). Commit** `feat(v4): Phase A prompt module + plan schema`

---

### Task 4: `buildSchedulePack` — context pack with officials availability

**Files:**
- Create: `apps/web/src/server/usecases/schedule-ai.ts`
- Test: `apps/web/src/server/usecases/__tests__/schedule-ai-pack.test.ts` (DB-backed; use the `project_local_test_db` recipe)

**Interfaces:**
- Consumes: `slotFixtures` from `@seazn/engine/scheduling`; settings/obstacles loaders in `apps/web/src/server/usecases/schedule.ts` (`siblingAssignments` family — read that file first and reuse its queries, do not re-derive SQL).
- Produces:

```ts
export interface SchedulePack { /* JSON-serialisable, exactly 01 §2 shape + officials */ }
export async function buildSchedulePack(
  auth: AuthCtx,
  divisionId: string,
  opts: { mode: "generate" | "refine" | "repair";
          instruction: string;
          scope?: { from?: string; courts?: string[]; pool_ids?: string[] };
          prior?: { instruction: string; assignments: { fixture_id: string; scheduled_at: string; court_label: string }[] } },
): Promise<{ pack: SchedulePack; movableIds: Set<string> }>
```

Throws `HttpError(409, "AI_PLAN_UNSUPPORTED")` for `scheduling_mode='flexible'`, `HttpError(422, "AI_PLAN_TOO_LARGE")` for >500 movable, `HttpError(422, "AI_PLAN_EMPTY_SCOPE")` when repair scope matches nothing, `HttpError(400, ...)` for unknown scope court label.

- [ ] **Step 1: Failing snapshot test** — seed a 2-court, 8-entrant RR division (copy the seeding helper style from the nearest schedule usecase test), then:

```ts
it("pack is deterministic and matches the 01 §2 shape", async () => {
  const a = await buildSchedulePack(auth, divisionId, { mode: "generate", instruction: "Finish by 6pm." });
  const b = await buildSchedulePack(auth, divisionId, { mode: "generate", instruction: "Finish by 6pm." });
  expect(JSON.stringify(a.pack)).toBe(JSON.stringify(b.pack));
  expect(a.pack).toMatchSnapshot();
  expect(a.pack.officials.length).toBeGreaterThan(0); // seeded roster present
});
it("repair scope excludes out-of-scope fixtures from movable and adds them as obstacles", async () => {
  const { pack, movableIds } = await buildSchedulePack(auth, divisionId, {
    mode: "repair", instruction: "Court 2 flooded", scope: { courts: ["Court 2"] },
  });
  for (const f of pack.fixtures.movable) expect(f.current.court === "Court 2" || f.current.court === null).toBe(true);
  expect(movableIds.size).toBeLessThan(8 * 7 / 2);
});
it("flexible division 409s", async () => { /* seed flexible division, expect HttpError 409 AI_PLAN_UNSUPPORTED */ });
```

- [ ] **Step 2: Implement.** Pack sections per 01 §2 (`mode/division/settings/entrants/people/fixtures{movable,obstacles}/draft/instruction/prior`) plus:

```ts
officials: [{
  id, name, role_keys, max_per_day,
  blackout_dates: string[],          // from official_blackouts for this org
  busy_elsewhere: string[],          // scheduled_at ISO list, cross-org derived read
  entrant_ids: string[],             // team + person-rostered entrants
}]
```

Reuse the SQL from `officials.ts` `engineInput` (roster + person_entrants), `listOfficialBlackouts`, `listOfficialBusyElsewhere` — extract shared row loaders into exported helpers on `officials.ts` rather than duplicating queries. Draft: `generate` → `slotFixtures` over movable with settings/obstacles; `refine` → `prior.assignments` verbatim as draft; `repair` → current persisted slots of the movable set. Sort every array; ISO strings with offsets in the division tz. Add the v15 seam comment
on the courts line: `// v15 venues: when venue_courts lands, this builder is the single
place court_label strings become venue-scoped (design/v15-venue).`
- [ ] **Step 3: Token budget test** — build the 500-fixture golden pack (seed loop), `JSON.stringify(pack).length / 4 < 60_000` as the cheap proxy (comment: rough chars/4 heuristic; live `AI_EVAL=1` test uses real `count_tokens`).
- [ ] **Step 4: Run all — PASS. Commit** `feat(v4): buildSchedulePack with officials availability + mode scoping`

---

### Task 5: `runAiPlan` — LLM call + verify/repair loop

**Files:**
- Modify: `apps/web/src/server/usecases/schedule-ai.ts`
- Test: `apps/web/src/server/usecases/__tests__/schedule-ai-run.test.ts`

**Interfaces:**
- Consumes: `SYSTEM_PROMPT`, `AiSchedulePlan` (Task 3); `validateAssignments` from `@seazn/engine/scheduling` (read its exact `(assignments, config, existing?) `-style signature at `packages/engine/src/scheduling/calendar.ts:390` before writing).
- Produces:

```ts
export interface AiPlanResult {
  proposal: { fixture_id: string; scheduled_at: string; court_label: string; schedule_locked?: boolean }[];
  unschedulable: { fixture_id: string; reason: string }[];
  warnings: Conflict[];              // non-blocking verifier conflicts
  blocking: Conflict[];              // residual after ≤2 repairs
  diff: { moved: string[]; placed: string[]; unscheduled: string[]; unchanged: string[] };
  explanations: { fixture_id: string; note: string }[];
  constraint_suggestions?: Partial<SchedulingConstraints>;
  summary: string;
  usage: { input_tokens: number; output_tokens: number; repair_rounds: number };
}
export async function runAiPlan(pack: SchedulePack, movableIds: Set<string>): Promise<AiPlanResult>
```

- [ ] **Step 1: Failing harness test with a mocked SDK.** No Anthropic mock precedent exists in the repo — establish it:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const parse = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class Anthropic { messages = { parse }; },
}));

import { runAiPlan } from "../schedule-ai"; // import AFTER the mock

function planResponse(plan: unknown, usage = { input_tokens: 1000, output_tokens: 500 }) {
  return { parsed_output: plan, stop_reason: "end_turn", usage, content: [] };
}

it("court clash → one repair round → clean", async () => {
  parse
    .mockResolvedValueOnce(planResponse(clashingPlan))   // SF1+SF2 same court+time
    .mockResolvedValueOnce(planResponse(fixedPlan));
  const out = await runAiPlan(pack, movableIds);
  expect(out.usage.repair_rounds).toBe(1);
  expect(out.blocking).toHaveLength(0);
  // the repair user turn carried the verifier conflicts
  const repairMsg = parse.mock.calls[1][0].messages.at(-1);
  expect(JSON.stringify(repairMsg)).toContain("court");
});
it("refusal → 422 AI_PLAN_FAILED", async () => {
  parse.mockResolvedValueOnce({ parsed_output: null, stop_reason: "refusal", usage: {}, content: [] });
  await expect(runAiPlan(pack, movableIds)).rejects.toMatchObject({ status: 422 });
});
it("every movable id appears exactly once across proposal+unschedulable, foreign ids rejected", async () => {
  parse.mockResolvedValueOnce(planResponse(planWithForeignId));
  await expect(runAiPlan(pack, movableIds)).rejects.toMatchObject({ status: 422 });
});
it("pinned fixture never moves: a plan that reassigns a pinned id is rejected as foreign (pinned ids are not in movableIds)", async () => {
  parse.mockResolvedValueOnce(planResponse(planTouchingPinnedId));
  await expect(runAiPlan(packWithPinned, movableIdsWithoutPinned)).rejects.toMatchObject({ status: 422 });
});
it("instruction case finish-by-18:00: mocked compliant plan passes the verifier and every assignment ends ≤ 18:00", async () => {
  parse.mockResolvedValueOnce(planResponse(finishBy18Plan));
  const out = await runAiPlan(pack, movableIds);
  for (const a of out.proposal) expect(new Date(a.scheduled_at).getHours()).toBeLessThan(18);
});
```

Hand-author `clashingPlan`/`fixedPlan` against the Task 4 snapshot pack (small 4-fixture pack fixture in-file is fine — `runAiPlan` takes the pack as data, no DB needed here).

- [ ] **Step 2: Implement** per Global Constraints call shape. Loop: parse → structural check (movable coverage exactly-once, ids ⊆ movable, courts ⊆ settings.courts — violations retry once with a corrective user turn, then 422) → map to engine assignments (epoch ms) → `validateAssignments` with obstacles as `existing` → blocking conflicts? append `{verifier_conflicts, note}` user turn + prior assistant content back (01 §5), round++ ≤2 → return best-so-far with residual `blocking`. Missing `ANTHROPIC_API_KEY` → `HttpError(503, "AI scheduling is not configured on this server")` before any call. Diff computed vs `pack.fixtures.movable[].current`.
- [ ] **Step 3: Run — PASS. `npx tsc --noEmit`. Commit** `feat(v4): runAiPlan verify/repair loop`

---

### Task 6: Phase A route + gates + coverage preview + telemetry

**Files:**
- Create: `apps/web/src/app/api/v1/divisions/[id]/schedule/ai-plan/route.ts`
- Modify: `apps/web/src/server/usecases/schedule-ai.ts` (add `aiPlanForDivision` orchestrator), `openapi.ts` ROUTES + `schemas.ts` (`AiPlanRequest`, `AiPlanResponse`), `apps/web/.env.example` (+`ANTHROPIC_API_KEY=`, `SCHEDULING_AI_MODEL=claude-opus-4-8`)
- Test: `apps/web/src/server/usecases/__tests__/schedule-ai-route.test.ts`

**Interfaces:**
- Consumes: Tasks 4–5; `requireResourceAuth(req, "division", id, "write")` (`server/api-v1/auth.ts:334`); `requireFeature(orgId, key)` (`lib/entitlements.ts:140`); `rateLimit(key, {max, windowSeconds})` (`lib/rate-limit.ts:36`); `isServerFeatureEnabled("ai-scheduling", distinctId, {orgId, fallback: true})` + `captureServer({event, distinctId, orgId, properties})` (`lib/posthog-server.ts`); `assignOfficials` + `AssignPolicy` from `@seazn/engine/officials` for the coverage preview.
- Produces: `POST /api/v1/divisions/{id}/schedule/ai-plan` returning `AiPlanResult & { officials_coverage: {fillable: number; total: number; unfilled: {fixture_id: string; role_key: string}[]} | null }`.

- [ ] **Step 1: Request schema** in `schemas.ts`:

```ts
export const AiPlanRequest = z.object({
  instruction: z.string().min(3).max(4000),
  mode: z.enum(["generate", "refine", "repair"]).default("generate"),
  scope: z.object({
    from: z.string().datetime({ offset: true }).optional(),
    courts: z.array(z.string()).optional(),
    pool_ids: z.array(z.string().uuid()).optional(),
  }).optional(),
  prior: z.object({
    instruction: z.string(),
    assignments: z.array(z.object({ fixture_id: z.string().uuid(), scheduled_at: z.string(), court_label: z.string() })),
  }).optional(),
  officials_policy: AssignPolicy.optional(),   // import the engine zod, do not redeclare
});
```

ROUTES row (mirror `openapi.ts:214-215` style):

```ts
{ path: "/divisions/{id}/schedule/ai-plan", method: "post", summary: "AI Schedule Architect: propose times+courts (generate/refine/repair), engine-verified; propose-only (Pro Plus `scheduling.ai`)", tag: "scheduling", request: S.AiPlanRequest, response: S.AiPlanResponse, errors: [402, 403, 409, 422, 429] },
```

- [ ] **Step 2: Route file** — copy the handler pattern from `app/api/v1/divisions/[id]/officials/auto/route.ts` verbatim (params unwrap, `requireResourceAuth(req, "division", id, "write")`, body zod parse, delegate to `aiPlanForDivision(auth, id, body)`).
- [ ] **Step 3: Orchestrator** in `schedule-ai.ts`:

```ts
export async function aiPlanForDivision(auth: AuthCtx, divisionId: string, input: AiPlanRequest) {
  if (!(await isServerFeatureEnabled("ai-scheduling", auth.userId, { orgId: auth.orgId, fallback: true })))
    throw new HttpError(403, "FEATURE_DISABLED");
  await requireFeature(auth.orgId, "scheduling.ai");
  await rateLimit(`ai-plan:${divisionId}`, { max: 5, windowSeconds: 3600 });
  const { pack, movableIds } = await buildSchedulePack(auth, divisionId, input);
  const result = await runAiPlan(pack, movableIds);
  const officials_coverage = input.officials_policy
    ? coveragePreview(pack, result.proposal, input.officials_policy)
    : null;
  await captureServer({ event: "ai_plan_run", distinctId: auth.userId, orgId: auth.orgId,
    properties: { phase: "schedule", mode: input.mode, fixtures: movableIds.size,
      repair_rounds: result.usage.repair_rounds, input_tokens: result.usage.input_tokens,
      output_tokens: result.usage.output_tokens, blocking: result.blocking.length } });
  return { ...result, officials_coverage };
}
```

`coveragePreview`: map proposal → `OfficialFixture[]` (epoch ms via settings matchMinutes), officials from the pack, `locked: []`, run `assignOfficials`; `total = proposal.length × policy.roles.length`, `unfilled` = its `role_unfilled` conflicts, `fillable = total - unfilled.length`.
- [ ] **Step 4: Route tests** (mock the SDK as in Task 5; seed orgs from the existing route-test helpers):

```ts
it("free org → 402 with feature_key scheduling.ai");
it("admin org_entitlement_overrides row grants a community org → 200");           // insert override row directly in test
it("override bool_value=false kills a pro_plus org → 402");
it("kill-switch off → 403 FEATURE_DISABLED");                                     // mock isServerFeatureEnabled false
it("6th call in the hour → 429");
it("flexible division → 409; 501 movable → 422; unknown scope court → 400");
it("officials_policy present → officials_coverage populated; absent → null");
```

- [ ] **Step 5: Run all + openapi coverage — PASS. Commit** `feat(v4): /schedule/ai-plan route, gates, coverage preview, telemetry`

---

### Task 7: Phase B prompt module — officials system prompt + zod

**Files:**
- Create: `apps/web/src/server/usecases/officials-ai-prompt.ts`
- Test: `apps/web/src/server/usecases/__tests__/officials-ai-prompt.test.ts`

**Interfaces:**
- Produces: `OFFICIALS_SYSTEM_PROMPT: string`, `AiOfficialAssignment`, `AiOfficialsPlan` (zod).

- [ ] **Step 1: Write the module.** Prompt ships **verbatim** (edits require updating the snapshot):

```text
You are the officials architect inside league-management software. You assign officials
to every required role slot of a division's fixtures, following the organiser's
instruction as closely as the hard rules allow.

You receive one JSON context pack: the fixture list with start times, courts and playing
entrants (a dry-run schedule the organiser has not applied yet, or the current one), the
officials roster (the roles each official can take, per-day caps, blackout dates, times
they are busy elsewhere, the entrants they play for), locked assignments that must not
change, the assignment policy (required roles per fixture, rest minutes, pool lock,
fairness basis), a draft assignment from a deterministic solver, and the organiser's
instruction. On repair rounds you also receive a verifier conflict report.

HARD RULES — the server verifier rejects violations, so check your work against each one
before answering:
1. Use only official ids and fixture ids from the pack. Every required role slot
   (each fixture x each role in policy.roles) appears exactly once in your output —
   either in assignments or in unfilled with a short honest reason.
2. An official must hold the role you assign them (their role_keys).
3. An official must never work two fixtures whose intervals overlap including the rest
   margin, never a fixture overlapping a time they play or are busy elsewhere, and never
   on one of their blackout dates.
4. An official must never officiate a fixture in which an entrant they belong to plays.
5. Respect max_per_day caps. When poolLock is on, officials only take fixtures in their
   home pool.
6. Never change an assignment marked locked; echo locked rows exactly as given.

SOFT GOALS — in this priority order:
a. The organiser's instruction. It outranks everything except hard rules; explain any
   compromise in summary.
b. Fairness: spread duties evenly within the policy's fairness basis; avoid one official
   working many more slots than another.
c. Continuity: prefer keeping an official on the same court across back-to-back fixtures.
d. Stability: in refine mode change as few assignments as possible from the prior
   proposal.

METHOD: Start from the draft — it is legal on overlaps but blind to blackouts,
busy-elsewhere times and your instruction. Identify the slots the instruction targets
(named officials, named fixtures or rounds, seniority or spread wishes), place those
first, then keep or minimally adjust the rest of the draft.

OUTPUT: Only the structured object. explanations: one short note per assignment the
instruction directly shaped (skip routine ones). summary: at most three sentences to the
organiser — what you did, any compromises, anything impossible and why.
```

```ts
import { z } from "zod";

export const OFFICIALS_SYSTEM_PROMPT = `...verbatim above...`;

export const AiOfficialAssignment = z.object({
  fixture_id: z.string().uuid(),
  official_id: z.string().uuid(),
  role_key: z.string().min(1),
});
export const AiOfficialsPlan = z.object({
  assignments: z.array(AiOfficialAssignment).max(1500),
  unfilled: z.array(z.object({ fixture_id: z.string().uuid(), role_key: z.string().min(1), reason: z.string().max(200) })),
  explanations: z.array(z.object({ fixture_id: z.string().uuid(), note: z.string().max(200) })).max(60),
  summary: z.string().max(600),
});
export type AiOfficialsPlan = z.infer<typeof AiOfficialsPlan>;
```

- [ ] **Step 2: Snapshot + schema-rejection tests** (same shape as Task 3). Run — PASS.
- [ ] **Step 3: Commit** `feat(v4): Phase B officials prompt module`

---

### Task 8: `buildOfficialsPack` + server referee

**Files:**
- Create: `apps/web/src/server/usecases/officials-ai.ts`
- Modify: `apps/web/src/server/usecases/officials.ts` (export the row-loader helpers extracted in Task 4; export `engineInput`'s fixture/official mapping as reusable functions)
- Test: `apps/web/src/server/usecases/__tests__/officials-ai-referee.test.ts`

**Interfaces:**
- Consumes: `assignOfficials`, `AssignPolicy`, `OfficialConflict`, types from `@seazn/engine/officials`.
- Produces:

```ts
export interface OfficialsPack { /* fixtures (id,startAt ISO,court,entrants), officials (Task 4 shape + role_keys), locked, policy, draft, instruction, prior */ }
export async function buildOfficialsPack(
  auth: AuthCtx, divisionId: string,
  opts: { instruction: string; policy: AssignPolicy;
          schedule?: { fixture_id: string; scheduled_at: string; court_label: string }[];
          prior?: { instruction: string; assignments: FixtureOfficial[] } },
): Promise<OfficialsPack>          // throws 422 NO_OFFICIALS when roster empty

export type WebOfficialConflict = OfficialConflict | {
  kind: "ineligible"; severity: "block";
  fixtureId: string; officialId: string; roleKey: string; detail: string;
};
export function refereeOfficialsPlan(
  pack: OfficialsPack,
  plan: AiOfficialsPlan,
): { conflicts: WebOfficialConflict[]; lazyUnfilled: { fixture_id: string; role_key: string; candidate_official_id: string }[] }
```

**Referee mechanics (spec §7 decision 8 — read `packages/engine/src/officials/assign.ts` first):**
1. Engine pass with `locked = [...pack.locked, ...plan.assignments]` → validates every proposal row for `official_overlap` (rest-widened), `team_ref_self`, `pool_leak`; greedy then fills only role-slots the plan left uncovered.
2. Any slot the plan declared `unfilled` that the greedy pass filled → `lazyUnfilled` warn with the solver's candidate. `role_unfilled` conflicts from the pass = confirmed-unfilled (fine, they were declared).
3. Server supplement (engine skips these for locked rows): wrong role (`!official.role_keys.includes(role_key)`), `max_per_day` exceeded (recount per official per UTC day over locked+plan), assignment on a blackout date, assignment overlapping a busy-elsewhere time → emit `kind: "ineligible", severity: "block"`.
4. Locked-row tamper: any pack.locked row missing or altered in `plan.assignments`-space → `ineligible` block "locked assignment changed".

- [ ] **Step 1: Failing referee tests** (pure — hand-built pack, no DB):

```ts
it("flags an overlap the LLM created", ...);                    // two slots same official, overlapping
it("flags wrong-role via ineligible", ...);
it("flags maxPerDay breach via ineligible", ...);
it("flags a blackout-date assignment via ineligible", ...);
it("lazy unfilled: declared-unfilled slot the solver can fill comes back with a candidate", ...);
it("confirmed unfilled passes through as role_unfilled without a candidate", ...);
it("locked row altered → ineligible block", ...);
```

- [ ] **Step 2: Implement referee, then `buildOfficialsPack`** (DB test: dry-run `schedule` times override persisted `scheduled_at`; roster/blackouts/busy loaders shared with Task 4; NO_OFFICIALS on empty roster; deterministic ordering + snapshot).
- [ ] **Step 3: Run — PASS. Commit** `feat(v4): officials pack + proposal referee (engine pass + ineligible supplement)`

---

### Task 9: `runOfficialsAiPlan` + Phase B route

**Files:**
- Modify: `apps/web/src/server/usecases/officials-ai.ts` (runner + orchestrator)
- Create: `apps/web/src/app/api/v1/divisions/[id]/officials/ai-plan/route.ts`
- Modify: `openapi.ts` ROUTES + `schemas.ts` (`AiOfficialsPlanRequest`, `AiOfficialsPlanResponse`)
- Test: `apps/web/src/server/usecases/__tests__/officials-ai-route.test.ts`

**Interfaces:**
- Produces: `POST /api/v1/divisions/{id}/officials/ai-plan`:

```ts
// request
{ instruction: z.string().max(2000).default(""),
  schedule: z.array(z.object({ fixture_id: z.string().uuid(), scheduled_at: z.string().datetime({ offset: true }), court_label: z.string() })).optional(),
  policy: AssignPolicy,
  prior: z.object({ instruction: z.string(), assignments: z.array(...) }).optional() }
// response
{ assignments: FixtureOfficial[]; conflicts: WebOfficialConflict[];
  diff: { changed: string[]; unchanged: string[]; unfilled: {fixture_id,role_key,reason}[] };
  lazy_unfilled: {fixture_id, role_key, candidate_official_id}[];
  explanations; summary; usage: { input_tokens; output_tokens; repair_rounds } }
```

- [ ] **Step 1: Runner** — same loop shape as Task 5 (`OFFICIALS_SYSTEM_PROMPT`, `zodOutputFormat(AiOfficialsPlan)`, structural check: exact slot coverage, ids ⊆ pack, locked echoed; referee = Task 8; repair turn carries `{verifier_conflicts, note}`; ≤2 rounds; empty `instruction` short-circuit: return the solver draft as the proposal with zero LLM calls, `usage: {0,0,0}` — the "sensible spread" path costs nothing).
- [ ] **Step 2: Route + ROUTES row** — handler copied from officials/auto; use-case gate order: kill-switch → `requireFeature(auth.orgId, "officials.auto")` → `policy.roles.length > 1 && requireFeature(auth.orgId, "officials.roles_multi")` → `rateLimit(\`ai-officials:${divisionId}\`, { max: 5, windowSeconds: 3600 })`. Telemetry `ai_plan_run` with `phase: "officials"`.
- [ ] **Step 3: Route tests** — mocked SDK: locked survives all modes; overlap → repair → clean `repair_rounds:1`; empty roster → 422 `NO_OFFICIALS`; empty instruction → no `parse` calls (assert `parse` not called) and draft returned; gates 402/403/429.
- [ ] **Step 4: Run + coverage test — PASS. Commit** `feat(v4): /officials/ai-plan route + runner`

---

### Task 10: Ledger audit trail + last-run recall

**Files:**
- Modify: `apps/web/src/server/api-v1/schemas.ts` (`ApplyScheduleRequest` + `ApplyAssignmentsInput` gain optional `ai`), `apps/web/src/server/usecases/schedule.ts:541` region, `apps/web/src/server/usecases/officials.ts:433` region
- Create: `apps/web/src/app/api/v1/divisions/[id]/schedule/ai-last/route.ts` (+ ROUTES row, tag "scheduling", GET)
- Test: extend the apply tests from Task 1 + `apps/web/src/server/usecases/__tests__/schedule-ai-ledger.test.ts`

**Interfaces:**
- Produces: optional request field `ai: { instruction: string.max(500), summary: string.max(600), model: string, repair_rounds: number }` on both apply rails → merged into the `schedule_applied` / `officials_assigned` event payloads; `GET /divisions/{id}/schedule/ai-last` → `{ at, instruction, summary } | null` (latest `division_events` row `type='schedule_applied' and payload->>'source'='ai'`).

- [ ] **Step 1: Failing test** — apply with `ai` block → `select payload from division_events where type='schedule_applied' order by seq desc limit 1` contains `instruction`; ai-last route returns it; division without AI applies → `null`.
- [ ] **Step 2: Implement** — `appendDivisionEvent(tx, stage.division_id, "schedule_applied", { stageId, source: input.source, moves, ...(input.ai ? { ai: input.ai } : {}) })`; same spread on the officials insert; trim instruction server-side. Route: `requireResourceAuth(req, "division", id, "read")`.
- [ ] **Step 3: Run — PASS. Commit** `feat(v4): AI audit trail in ledger payloads + ai-last recall`

---

### Task 11: AI console shell — 4-step rail, state machine, gating

**Files:**
- Create: `apps/web/src/components/v2/board/ai-console.tsx` (shell + state machine), `apps/web/src/components/v2/board/ai-console-state.ts` (pure reducer — testable without React)
- Modify: `apps/web/src/components/v2/schedule-board.tsx` (header button + dock render alongside `ConflictsPanel`/`MovePanel` at the ~538/626/640/653 dock sites — follow the existing dock open/close pattern)
- Test: `apps/web/src/components/v2/board/__tests__/ai-console-state.test.ts`

**Interfaces:**
- Produces (pure, consumed by Tasks 12–16):

```ts
export type AiStep = "brief" | "schedule" | "officials" | "apply";
export type AiRunState = "idle" | "running" | "flagged" | "proposal" | "applied" | "error";
export interface AiConsoleState {
  step: AiStep; run: AiRunState;
  mode: "generate" | "refine" | "repair";
  instruction: string; officialsInstruction: string;
  scope?: { from?: string; courts?: string[]; pool_ids?: string[] };
  schedulePlan: AiPlanResponse | null;          // Phase A result
  officialsPlan: AiOfficialsPlanResponse | null;
  error: { status: number; message: string } | null;
}
export function aiConsoleReducer(s: AiConsoleState, a: AiConsoleAction): AiConsoleState;
```

Actions: `SET_INSTRUCTION`, `SET_MODE`, `SET_SCOPE`, `RUN_START`, `RUN_FLAGGED`, `RUN_DONE(plan)`, `RUN_ERROR({status,message})`, `GOTO_STEP`, `OFFICIALS_DONE(plan)`, `APPLIED`, `RESET`, `PREFILL_REPAIR(scope)`.

- [ ] **Step 1: Failing reducer tests** — step transitions gated (can't reach `officials` without `schedulePlan`; `apply` reachable from `schedule` via skip); `RUN_ERROR` keeps prior proposal; `PREFILL_REPAIR` sets mode+scope+step brief; `RESET` clears both plans.
- [ ] **Step 2: Implement reducer, then the shell**: header button "AI schedule" (pro-badged); free org → `<UpgradeGate feature="scheduling.ai" />` inside the dock (no network call); kill-switch flag off → button hidden entirely (flag read the same way the board reads other PostHog client flags — grep `useFeatureFlagEnabled` in `apps/web/src` and copy). Dock/sheet chrome copied from the unscheduled tray component. Stepper rail renders the four steps, current highlighted, completed teal.
- [ ] **Step 3: tsc + unit — green. Screenshot-verify desktop + 390px (empty console, gated console). Commit** `feat(v4): AI console shell + state machine + gating`

---

### Task 12: Step 1 Brief — pre-flight card + wish chips + last-run

**Files:**
- Create: `apps/web/src/components/v2/board/ai-preflight.tsx`, `apps/web/src/components/v2/board/ai-wish-chips.tsx`, `apps/web/src/components/v2/board/wish-compile.ts`
- Modify: `ai-console.tsx` (render in step brief)
- Test: `apps/web/src/components/v2/board/__tests__/wish-compile.test.ts`

**Interfaces:**
- Consumes: board's already-loaded settings/fixtures/entrants props (pass down from `schedule-board.tsx` — no new fetches except `GET .../officials` roster reuse and `GET .../schedule/ai-last`).
- Produces: `compileWishes(wishes: Wish[]): string` — pure:

```ts
export type Wish =
  | { kind: "finish_by"; time: string }
  | { kind: "start_window"; target: string; targetName: string; edge: "before" | "after"; time: string }
  | { kind: "keep_apart"; aName: string; bName: string }
  | { kind: "final_last"; court: string }
  | { kind: "pin_entrant"; name: string };
export function compileWishes(wishes: Wish[]): string;
// e.g. [{kind:"finish_by",time:"18:00"},{kind:"final_last",court:"Court 1"}]
// → "Finish by 18:00. Put the final last on Court 1."
```

- [ ] **Step 1: Failing compile tests** — each wish kind renders its sentence; wishes join with spaces; empty array → "".
- [ ] **Step 2: Implement chips UI**: chip row above the textarea; tapping opens the picker (time input / entrant select from board entrants / court select from settings.courts); confirmed chips render as removable pills; textarea value = `compileWishes(pills) + " " + freeText` (compiled part re-derives on pill change, free text preserved after). Mode chips + 3 presets per mode (copy strings from 02 §4) below.
- [ ] **Step 3: Pre-flight card rows** (each `{label, ok | warn, deepLink}`) derived from board props: courts>0 · sessionWindows set · blackouts count (info) · constraints non-default (info) · movable ≤500 · officials roster>0 + "N officials, M with blackout dates" · pinned count (info). Warn rows amber with links (`/o/.../settings` schedule tab, officials roster). Never disables the run button.
- [ ] **Step 4: Last-run strip** — fetch `ai-last`, render date + instruction, tap fills the textarea. Warn-row deep-link clicks capture `ai_preflight_gap_fixed` (client PostHog, same capture helper the board already uses — grep `posthog.capture` in `components/v2`).
- [ ] **Step 5: Screenshot-verify desktop + 390px (chips open, warn rows). Commit** `feat(v4): brief step — pre-flight, wish chips, last-run recall`

---

### Task 13: Step 2 Schedule — referee trace, ghosts, diff, coverage strip

**Files:**
- Create: `apps/web/src/components/v2/board/ai-trace.tsx` (shared stepper+console, reused by Task 14), `apps/web/src/components/v2/board/ai-diff-panel.tsx`
- Modify: `ai-console.tsx` (run action posts `/schedule/ai-plan` with `officials_policy` when the division has a saved policy), `schedule-board.tsx` grid cells (ghost render path)
- Test: `apps/web/src/components/v2/board/__tests__/ai-diff.test.ts`

**Interfaces:**
- Produces: `<AiTrace phase="schedule"|"officials" events={TraceEvent[]} running={boolean} />` where `TraceEvent = { t: "step"|"log"|"flag"|"clean"; text: string }`; `computeAiDiff(plan, currentFixtures): {moved, placed, unscheduled, unchanged}` (pure — used by the panel AND asserted against server diff).

- [ ] **Step 1: Failing diff test** — 4 fixtures: one moved, one newly placed, one unscheduled, one untouched → buckets exact.
- [ ] **Step 2: Trace component** per 02 §0: stepper nodes light in sequence; `flag` event turns Referee red + injects Repair node + pulses the flagged fixture ids on the grid (1.5s) via a callback prop; `clean` settles nodes teal and always logs `validateAssignments → CLEAN · 0 blocking`. `prefers-reduced-motion` → render final state instantly. Console lines mono, `.app-*` styling.
- [ ] **Step 3: Ghosts**: proposal blocks translucent + dashed on the grid, amber when moved, teal when newly placed, red when blocking; unchanged dimmed; block content = code + JR/Final marker + matchup + time only (≥40px min-height, ellipsized) — move provenance lives in the diff list only (02 §3).
- [ ] **Step 4: Result cards**: summary top (never truncated below 3 sentences), usage mono chips (`in/out/repairs/blocking`), coverage strip when `officials_coverage` non-null. Blocking rows keep Accept disabled with untick-to-tray affordance. Errors 503/402/422/429 inline copy in the panel step.
- [ ] **Step 5: Screenshot-verify desktop + 390px (agenda diff list at 390px, no grid ghosts). Commit** `feat(v4): schedule step — trace, ghosts, diff, coverage`

---

### Task 14: Step 3 Officials — review grid

**Files:**
- Create: `apps/web/src/components/v2/board/ai-officials-review.tsx`
- Modify: `ai-console.tsx` (posts `/officials/ai-plan` with `schedule` = Phase A proposal, `policy` from the officials panel's saved policy or defaults, instruction from officials chips/box)

**Interfaces:**
- Consumes: Task 9 response, `<AiTrace phase="officials" />`, roster from the officials list route.

- [ ] **Step 1: Grid** — one row per fixture (time · matchup), one chip per required role: filled = official name (amber if changed vs draft, teal after referee-clean), red = blocking conflict (tooltip = conflict detail), hollow = unfilled (reason on hover; `lazy_unfilled` rows show "solver suggests {name}" with a one-tap adopt that patches the proposal locally and re-runs the referee via a fresh ai-plan call in refine mode). Locked chips padlocked.
- [ ] **Step 2: Officials wish chips** (`senior refs on finals` / `spread duties evenly` / `{official} only {window}` — picker from roster) + instruction box + `Re-plan` (refine with `prior`). Empty instruction + first entry auto-runs the free solver-draft path (zero tokens) so the step is never blank.
- [ ] **Step 3: Screenshot-verify desktop + 390px. Commit** `feat(v4): officials review step`

---

### Task 15: Step 4 Apply — chained accept

**Files:**
- Modify: `ai-console.tsx` + create `apps/web/src/components/v2/board/ai-apply.ts` (pure orchestration helper, testable)
- Test: `apps/web/src/components/v2/board/__tests__/ai-apply.test.ts` (mock fetch)

**Interfaces:**
- Produces: `applyAiPlans({schedulePlan, officialsPlan, suggestions, seqRef, divisionId, stageId}): Promise<ApplyOutcome>` where `ApplyOutcome = { schedule: "applied"|"seq_conflict"|"error"; officials: "applied"|"skipped"|"error" }`.

- [ ] **Step 1: Failing orchestration tests** — order asserted: checkpoint (`POST` existing checkpoints route, label `before-ai`) → schedule apply (`source:"ai"`, `expected_seq`, `ai` audit block) → officials apply (`ai` block) → suggestions PUT when ticked; `SEQ_CONFLICT` on schedule apply → returns `seq_conflict`, officials skipped; officials failure → `{schedule:"applied", officials:"error"}`.
- [ ] **Step 2: Implement + wire UI**: suggestions checklist checked-by-default; buttons `Apply schedule + officials` / `Apply schedule only` / `Discard` (`ai_plan_discarded` capture); `seq_conflict` → refetch + "Re-run as refine" CTA (prior = current proposal); success → board refetch, all-teal, checkpoint banner, toast with undo.
- [ ] **Step 3: Screenshot-verify both viewports. Commit** `feat(v4): apply step — chained accept + suggestions + seq recovery`

---

### Task 16: Repair nudges

**Files:**
- Create: `apps/web/src/components/v2/board/use-disruption-signals.ts` + `ai-repair-banner.tsx`
- Modify: `schedule-board.tsx` (banner slot above the grid)
- Test: `apps/web/src/components/v2/board/__tests__/disruption-signals.test.ts`

**Interfaces:**
- Produces: `computeDisruptions(fixtures, settings): { fixtureIds: string[]; reasons: ("blackout"|"court_gone"|"outside_window"|"postponed")[]; scope: {courts?: string[]; from?: string} }` — pure over data the board already holds.

- [ ] **Step 1: Failing signal tests** — fixture inside blackout flagged; `court_label` not in `settings.courts` flagged with that court in scope; fixture outside every session window flagged; `postponed`-status with a slot flagged; clean board → empty.
- [ ] **Step 2: Banner** — amber, "N fixtures need repair — Fix with AI", click dispatches `PREFILL_REPAIR(scope)` and opens the console. Hidden when console open or free org. Captures `ai_repair_nudge_shown` once per board load when visible and `ai_repair_nudge_clicked` on click.
- [ ] **Step 3: Screenshot-verify. Commit** `feat(v4): client-derived repair nudges`

---

### Task 17: E2E — full wizard (mocked model)

**Files:**
- Create: `apps/web/e2e/ai-architect.spec.ts` (follow `project_test_infra` conventions: magic-link `login_url`, SQL pro-flip; mock the model by setting `SCHEDULING_AI_MODEL` test double via the same `vi`-less path — e2e runs against the dev server, so mock at the network edge: set `ANTHROPIC_BASE_URL`-style override IF the SDK client is constructed with `baseURL: process.env.SCHEDULING_AI_BASE_URL` — add that one-line escape hatch to the client constructor in `schedule-ai.ts` in this task, pointing at a tiny fixture server started by the spec)

- [ ] **Step 1: Add the base-URL escape hatch + fixture server** (returns a canned parseable plan for both phases; refusal on a magic instruction string for the error path).
- [ ] **Step 2: Spec** — pro org seeded RR division: open console → pre-flight rows visible → chip `finish by 18:00` compiles into textarea → run → trace reaches CLEAN → ghosts + diff counts match payload → Officials step auto-draft renders grid → apply both → board persists, `schedule_applied` payload has `ai.instruction` (assert via API), checkpoint `before-ai` listed, undo restores. Second scenario: inject blackout over a scheduled fixture via settings PUT → nudge banner appears → click prefills repair. Third: free org sees UpgradeGate, no network call. Fourth: 390px viewport full flow (agenda diff).
- [ ] **Step 3: Run e2e headed once, keep screenshots. Commit** `test(v4): ai-architect e2e + model fixture server`

---

### Task 18: Closing — i18n, help, smoke, README

**Files:**
- Modify: `apps/web/src/dictionaries/{en,fr,es,nl}/ui.json` (all new keys under `ai.*` — `ai.console.title`, `ai.step.brief|schedule|officials|apply`, `ai.preflight.*`, `ai.chips.*`, `ai.trace.*`, `ai.apply.*`, `ai.nudge.banner`, error copies; parity test enforces ×4)
- Create: `content/help/ai-scheduling.md`, `content/help/ai-officials.md` (organiser-facing: what the AI sees, the two phases, repair mode, what Pro Plus includes; register slugs — help-slug-registry test will fail until registered)
- Modify: `scripts/smoke.ts` — `v4AiSuite(admin, proOrgId, proOrgSlug)` called from main after `v13Suite`: pro path posts ai-plan (fixture-server mock via the Task 17 base URL), asserts proposal shape + applies with `ai` block + asserts ledger payload + officials ai-plan draft path (zero-token) + ai-last returns the instruction; free path asserts 402 `feature_key`; admin-override path inserts an override row → 200
- Modify: `design/v4/README.md` status line → built

- [ ] **Step 1: Keys + parity test green.**
- [ ] **Step 2: Help articles + slug registry green.**
- [ ] **Step 3: Smoke suite green locally** (ephemeral DB + dev server per smoke conventions).
- [ ] **Step 4: Full gate**: `cd apps/web && npx tsc --noEmit && npx vitest run`; `cd packages/engine && npx vitest run` (must be untouched/green); full smoke. Screenshot set final review.
- [ ] **Step 5: Commit** `feat(v4): closing — i18n ×4, help, smoke suite, README status`

---

## Execution notes

- Task order is strict 1→18; tasks 3–6 = PROMPT-85, 7–10 = PROMPT-86, 11–18 = PROMPT-87. One branch, worktree `.claude/worktrees/v4-ai-architect` (never branch in the main checkout).
- The engine package is **never modified** — any temptation to add conflict kinds or validators there violates spec decision 8.
- Anthropic SDK calls exist in exactly two files (`schedule-ai.ts`, `officials-ai.ts`); both must share one client-construction helper (env key check + optional base-URL escape hatch) — put it in `schedule-ai.ts` and import from `officials-ai.ts`.
- Verify-before-push: `tsc` + unit before every push, no exceptions.
