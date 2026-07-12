# v4/00 — AI Schedule Architect (normative spec)

Scope: divisions + competitions, timed scheduling only. Replaces the retired
prose→constraints feature. Implemented by PROMPT-41/42/43.

## §1 Remove the old feature

The first-cut AI (`scheduling.ai` v1) only translated prose into the constraints jsonb and
its UI was already withdrawn ("endpoint intact, UI withdrawn"). Verdict: not good enough —
delete it, keep its plumbing. Removal inventory (PROMPT-41):

- `aiConstraintsForDivision` + `parseAiConstraints` + `AiConstraints` zod in
  `apps/web/src/server/usecases/schedule-plus.ts`
- Route `apps/web/src/app/api/v1/divisions/[id]/schedule/ai-constraints/route.ts`
- Its `RouteSpec` row in `apps/web/src/server/api-v1/openapi.ts` ROUTES + schemas
- Parked prose box + dead handlers in `apps/web/src/components/v2/constraints-panel.tsx`
- Unit/e2e tests exercising ai-constraints

**Keep and reuse:** entitlement key `scheduling.ai` (V245 — same paid gate, new feature
behind it), PostHog kill-switch flag `ai-scheduling` (evaluated before the billing gate),
env `SCHEDULING_AI_MODEL` (default `claude-opus-4-8`), `@anthropic-ai/sdk` dep, error
conventions: missing `ANTHROPIC_API_KEY` → 503 friendly message; unparseable model output
after retries → 422.

## §2 Product shape — three modes, one pipeline

| Mode | Trigger | Movable set | Draft given to LLM |
|------|---------|-------------|--------------------|
| `generate` | Blank or partial board, organiser writes an instruction | All unpinned `scheduled`-status fixtures in scope | Greedy `slotFixtures` pass |
| `refine` | Follow-up turn on a proposal ("move finals to Sunday evening") | Same as the prior proposal | The prior proposal |
| `repair` | Disruption ("Court 2 flooded", "rain washed out Saturday") | Only fixtures matching `scope` (from-date / courts / pools), rest become obstacles | Current persisted schedule |

Every mode is **propose-only**. The endpoint returns a proposal + verifier report + diff;
nothing persists until the organiser accepts. Accept path reuses the existing
`applySchedule` use-case (transaction, re-validate, `assertNoBlocking`, advisory lock,
`schedule_applied` ledger event, `divisions.seq` bump) — the AI feature adds zero new write
machinery.

Flexible divisions (`scheduling_mode='flexible'`) are rejected 409 `AI_PLAN_UNSUPPORTED`
(no timestamps to plan). Divisions with >500 movable fixtures are rejected 422 (matches
the apply limit and bounds the context pack).

## §3 Pipeline

```
buildContextPack ─→ greedy draft ─→ LLM (structured output) ─→ validateAssignments
                                            ▲                        │
                                            └── repair round ≤2 ─────┘ blocking conflicts
                                                                     │
                                                          proposal + warnings + diff
```

1. **Context pack** (`buildSchedulePack`, new module `apps/web/src/server/usecases/schedule-ai.ts`):
   deterministic JSON — settings (tz, matchMinutes, gapMinutes, courts, sessionWindows,
   blackouts, `constraints{}`), entrants (+ pool, seed) and the shared-person map from
   `entrant_members`, movable fixtures (id, ext_key, round_no, seq_in_round, pool, feeds,
   current slot, pinned/locked-scope flags), obstacles (other stages, sibling divisions via
   the same query family as `siblingAssignments`), the mode, the draft, the instruction.
   Sorted keys, stable ordering → snapshot-testable and prompt-cache friendly.
2. **Draft**: `slotFixtures` output (mode `generate`) — a legal-but-naive baseline. The LLM
   improves on it instead of inventing time math from scratch.
3. **LLM call**: see `01-llm-contract.md`. Strict structured output; every movable fixture
   must appear exactly once in `assignments` or `unschedulable`.
4. **Verifier**: run engine `validateAssignments` (court/rest/blackout/person_overlap/
   start_window/order) on the proposal against the same obstacles. Blocking conflicts →
   one repair round: send the conflict report back, ask for minimal fixes. Max 2 repair
   rounds, then return the best proposal with residual conflicts marked `blocking:true`
   (UI disables accept for those fixtures, offers "drop blockers to tray").
5. **Response**: `{proposal, warnings, blocking, diff:{moved,placed,unscheduled,unchanged},
   explanations, summary, constraint_suggestions?, usage:{input_tokens,output_tokens,repair_rounds}}`.

## §4 API surface (all registered in ROUTES)

- `POST /api/v1/divisions/{id}/schedule/ai-plan` — body
  `{instruction: string(3..4000), mode: "generate"|"refine"|"repair" = "generate",
  scope?: {from?: iso, courts?: string[], pool_ids?: uuid[]},
  prior?: {instruction: string, assignments: ScheduleAssignment[]}}`.
  Stateless: the client holds the conversation; `refine` posts the prior proposal back.
  Auth `requireResourceAuth(division, "write")`; gates §6.
- `POST /api/v1/competitions/{id}/schedule/ai-plan` (PROMPT-42) — multi-division: movable
  set spans the competition's timed divisions, court space is shared, response groups
  assignments per division. Additionally gated `scheduling.multi_division`. Accept applies
  per division in build order, each under its own advisory lock + checkpoint.
- Accept = existing `POST /api/v1/stages/{id}/schedule/apply` (division boards) /
  per-division loop (competition board). Client sends `source:"ai"`.
- Constraint suggestions accept = existing `PUT /api/v1/divisions/{id}/schedule-settings`
  (client merges the suggested `constraints{}` delta; no new endpoint).

## §5 Data changes

One migration (V-next): extend `fixtures.schedule_source` check constraint
`none|auto|manual` → `none|auto|manual|ai`; extend `ApplyScheduleRequest.source` enum to
match. `schedule_applied` ledger payload already carries `source` — now distinguishes AI
applies for audit/analytics. No new tables: proposals are ephemeral (client state), the
applied result is fully captured by the existing ledger + checkpoint machinery.
Auto-checkpoint named `before-ai` (via `schedule.versioning` checkpoints) is created in the
accept flow before apply → one-click undo.

## §6 Gating, limits, telemetry

Order of checks in the use-case: auth → PostHog `ai-scheduling` kill-switch (fallback
`true`) → `requireFeature(orgId, "scheduling.ai")` (+ `scheduling.multi_division` for the
competition route) → `rateLimit("ai-plan:" + divisionId, {max: 5, windowSeconds: 3600})`
(429 with friendly copy; competition route keys on competition id, max 3/h) → mode/scope
validation. `captureServer("ai_plan_run", {mode, fixtures, repair_rounds, input_tokens,
output_tokens, blocking})` per run and `ai_plan_accepted` / `ai_plan_discarded` from the UI.
Add `ANTHROPIC_API_KEY` + `SCHEDULING_AI_MODEL` to `apps/web/.env.example` (currently
missing — known gap).

## §7 Failure modes

| Condition | Response |
|---|---|
| No `ANTHROPIC_API_KEY` | 503 "AI scheduling is not configured on this server" |
| Kill-switch off | 404-style hidden in UI; API 403 `FEATURE_DISABLED` |
| Free org | 402 `PAYMENT_REQUIRED` + `feature_key` → `UpgradeGate` |
| Model refusal / unparseable after retry | 422 `AI_PLAN_FAILED` with summary text |
| >500 movable fixtures | 422 `AI_PLAN_TOO_LARGE` |
| Flexible division | 409 `AI_PLAN_UNSUPPORTED` |
| Rate window exceeded | 429 |
| Board changed since proposal (stale `expected_seq` on apply) | existing 409 `SEQ_CONFLICT` → UI refreshes + offers re-run as `refine` |

## §8 Decisions (binding)

1. **LLM plans, engine referees** — no proposal reaches the DB without passing
   `validateAssignments` + `assertNoBlocking` in the apply transaction.
2. **Stateless conversation** — no ai_sessions table; client posts prior proposal back.
   Revisit only if transcripts must survive reloads.
3. **Reuse `scheduling.ai` key** — billing matrix untouched; this is a replacement, not a
   new SKU.
4. **Sync request** — no queue/streaming in this wave; ≤500 fixtures fits comfortably in
   one request. If p95 latency hurts, streaming is the follow-up, not a blocker.
5. **`slotFixtures` stays** — the free/Pro "Auto-schedule" button is unchanged; AI is a
   layer above it, and its draft feeds the LLM.
6. **Suggestions are opt-in** — `constraint_suggestions` never auto-write settings; UI
   shows them as a checked-by-default list applied on accept via the existing PUT.
