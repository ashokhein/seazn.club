# PROMPT-42 — AI Refine + Repair + Multi-Division: follow-up turns, disruption reflow, competition scope

**Read first:** `v4/00-ai-schedule-architect.md` §2/§4 (modes, competition endpoint),
`v4/01-llm-contract.md` §5 (refine/repair protocol); `apps/web/src/server/usecases/schedule.ts`
(`applySchedule` per-stage, advisory locks), `server/usecases/history.ts` (checkpoints),
`app/o/[orgSlug]/c/[compSlug]/schedule/page.tsx` (multi-division board, `scheduling.multi_division`).
Preamble: PROMPT-00. **Depends:** PROMPT-41. Do not run alongside PROMPT-41/43.

## Task

1. **Refine mode** (v4/00 §2): accept `prior:{instruction, assignments}` in ai-plan body;
   pack rebuilt from live DB (board may have moved — recompute movable/obstacles), prior
   proposal becomes the draft, prior instruction included so the model preserves earlier
   intent; soft goal (d) stability applies. Remove the 501 stub from PROMPT-41.
2. **Repair mode** (v4/00 §2): `scope{from?, courts?, pool_ids?}` selects the movable set;
   everything outside scope becomes obstacles (including same-stage fixtures). Typical
   flows to test: "Court 2 gone from Saturday 12:00" (courts+from), "rain washed out day
   1, replay everything" (from), pool-scoped reflow. Scope validation: unknown court label
   → 400; empty movable set → 422 `AI_PLAN_EMPTY_SCOPE`.
3. **Competition-level planning** (v4/00 §4): `POST /api/v1/competitions/{id}/schedule/ai-plan`
   — gates `scheduling.ai` + `scheduling.multi_division`; movable set = all timed
   divisions' eligible fixtures, one shared court space (obstacles only external);
   response groups `divisions:[{division_id, assignments, …}]`; per-division ≤500 and
   total ≤500 (one LLM call). Register in ROUTES. Rate key
   `ai-plan:comp:{id}` max 3/h.
4. **Accept flow (server side)**: division accept unchanged (existing apply). Competition
   accept = client loops divisions calling apply per stage; before first apply create a
   `before-ai` checkpoint per division (existing checkpoints route). Document the
   partial-failure story: apply is per-division transactional; a `SEQ_CONFLICT` mid-loop
   stops the loop, UI reports which divisions landed (each independently undo-able).
5. **Constraint suggestions accept path** (v4/00 §8.6): client-side merge of
   `constraint_suggestions` into current `config.constraints` + existing schedule-settings
   PUT; server ensures suggestions schema = strict subset of `ScheduleConfig.constraints`
   (reuse schema objects, no redeclaration).
6. **Telemetry**: `ai_plan_run` gains `mode`, `scoped_fixtures`, `divisions` fields.

## Acceptance

- Unit: refine keeps ≥N% of prior placements when instruction is narrow (stability
  assertion on mocked plan); repair never emits an out-of-scope fixture id (verifier +
  schema test); competition pack spans divisions and marks cross-division court clashes
  as blocking; suggestion delta rejects keys outside `constraints{}`.
- E2E (mocked model): seeded 2-division comp — repair "Court 1 out after 14:00" moves only
  affected fixtures, others byte-identical; competition plan → accept loop → both
  divisions applied with `source:"ai"`, checkpoints `before-ai` exist, undo per division
  restores; free org 402 on competition route even when pro on `scheduling.ai` alone.
- smoke.ts: pro path adds one refine round on the PROMPT-41 proposal.
- `npm test` + `tsc` green; update v4/README status.
