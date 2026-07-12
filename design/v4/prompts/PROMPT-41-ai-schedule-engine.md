# PROMPT-41 — AI Schedule Engine: context pack, verify/repair loop, ai-plan endpoint, old-AI removal

**Read first:** `v4/00-ai-schedule-architect.md` (normative), `v4/01-llm-contract.md`
(model, schemas, system prompt — ship verbatim); `packages/engine/src/scheduling/calendar.ts`
(`slotFixtures`, `validateAssignments`), `apps/web/src/server/usecases/schedule.ts`
(`autoSchedule`, `applySchedule`, `siblingAssignments`, `assertFreshSeq`),
`apps/web/src/server/usecases/schedule-plus.ts` (old feature to remove; keep its gating
pattern), `apps/web/src/server/api-v1/openapi.ts` (ROUTES coverage test).
Preamble: PROMPT-00. **Depends:** none. Do not run alongside PROMPT-42/43.

## Task

1. **Remove old AI** (v4/00 §1): delete `aiConstraintsForDivision`, `parseAiConstraints`,
   `AiConstraints` from `schedule-plus.ts`; delete
   `app/api/v1/divisions/[id]/schedule/ai-constraints/route.ts`; drop its ROUTES row +
   request/response schemas; strip the parked prose box + handlers from
   `components/v2/constraints-panel.tsx`; delete its tests. Keep entitlement key
   `scheduling.ai`, flag `ai-scheduling`, env `SCHEDULING_AI_MODEL`.
2. **Migration V-next** (v4/00 §5): widen `fixtures.schedule_source` check to
   `none|auto|manual|ai`; extend `ApplyScheduleRequest.source` enum + board client types.
3. **Context pack** (v4/01 §2): new `apps/web/src/server/usecases/schedule-ai.ts` with
   `buildSchedulePack(auth, divisionId, {mode, scope, prior, instruction})` — settings,
   entrants, shared-person map (`entrant_members` join), movable fixtures (unpinned,
   un-scope-locked, status `scheduled`, scope-filtered in repair), obstacles (other stages
   + sibling divisions, reuse `siblingAssignments` family), greedy draft via `slotFixtures`.
   Deterministic ordering; reject flexible divisions (409 `AI_PLAN_UNSUPPORTED`) and >500
   movable (422 `AI_PLAN_TOO_LARGE`).
4. **LLM runner** (v4/01 §1/§4/§5): `runAiPlan(pack)` — `client.messages.parse`, system
   prompt + `zodOutputFormat(AiSchedulePlan)` from `schedule-ai-prompt.ts` (verbatim from
   v4/01), `thinking: adaptive`, `effort: high`, cache_control on system; verifier loop:
   `validateAssignments` → blocking conflicts → repair message → ≤2 rounds; refusal /
   parse-fail → 422 `AI_PLAN_FAILED`; missing key → 503.
5. **Endpoint** (v4/00 §4): `POST /api/v1/divisions/{id}/schedule/ai-plan` — `v1()` +
   `parseBody` + `requireResourceAuth(division, "write")`; use-case order: kill-switch →
   `requireFeature("scheduling.ai")` → `rateLimit("ai-plan:"+divisionId,{max:5,windowSeconds:3600})`
   → pack → run. Response per v4/00 §3 step 5 (proposal, warnings, blocking, diff,
   explanations, summary, constraint_suggestions, usage). Register in ROUTES + schemas.
   `mode:"generate"` only in this prompt (42 adds refine/repair bodies — build the schema
   with all three modes now, 501 `AI_PLAN_MODE_UNAVAILABLE` for refine/repair).
6. **Telemetry + env** (v4/00 §6): `captureServer("ai_plan_run", …)`; add
   `ANTHROPIC_API_KEY`, `SCHEDULING_AI_MODEL` to `apps/web/.env.example`.
7. **Golden tests** (v4/01 §6 items 1–3): pack snapshot, legality/repair harness with
   mocked SDK (`vi.mock("@anthropic-ai/sdk")`), instruction cases, pinned-untouched.

## Acceptance

- Unit: pack snapshot deterministic across two builds; repair harness shows
  `repair_rounds:1` and no reintroduced conflicts; flexible → 409; 501-fixture division →
  422; free org → 402 with `feature_key:"scheduling.ai"`; kill-switch off → 403; no key →
  503; old route gone → openapi coverage test green with removed row.
- E2E (mocked Anthropic via env-injected base URL or module mock in test server): pro org
  posts instruction on seeded 8-entrant RR division → 200 proposal, every movable fixture
  covered, diff counts consistent; apply proposal via existing apply route with
  `source:"ai"` → fixtures persisted, `schedule_applied` event payload has `source:"ai"`,
  undo restores.
- smoke.ts: pro path runs ai-plan (mock) + applies; free path asserts 402 upgrade shape.
- `npm test` + `tsc` green; update v4/README status.
