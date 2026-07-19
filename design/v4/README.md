# v4 — AI Schedule Architect

> **Status (2026-07-19):** built. PROMPT-85 ✅ · PROMPT-86 ✅ · PROMPT-87 ✅ — two-phase architect (schedule + officials), guided intake, repair nudges, ledger audit, graded run quotas (free 5 / Event Pass 10 / Pro 20 / Pro Plus 50, officials unmetered), e2e + smoke coverage. Competition-level multi-division still deferred.
> Branch (planned): `feat/v4-ai-schedule`. Migrations: V-next (schedule_source `ai`).
> **2026-07-14:** interactive board-UX prototype built (mocked LLM) → design + findings in
> `02-board-ux.md`; PROMPT-43 gains a pixel/motion reference before coding.
> **2026-07-18:** approved revision `03-two-phase-officials-and-intake.md` — two-phase
> architect (Phase B officials via LLM + engine referee), guided intake (pre-flight +
> wish chips), repair nudges, ledger audit trail, Pro Plus gate fix. Competition-level
> multi-division **deferred**. Build as PROMPT-85..87 (85 core+A, 86 officials B,
> 87 board UX) — 41..43 stay as base reference, superseded where 03 amends.

## Theme

Replace the weak first-cut schedule AI (`aiConstraintsForDivision` — prose→constraints only,
UI already withdrawn) with a full **AI Schedule Architect**: the organiser types an
instruction in plain language ("finish by 6pm, juniors before 2pm, marquee match last on
Court 1, keep the Smith brothers apart") and the system produces a complete, legal,
applicable schedule — then refines it in follow-up turns and repairs it after mid-season
disruptions. Pro-only (`scheduling.ai`). Token spend is acceptable: a couple of runs per
division, quality over cost.

**Architecture in one line: solver drafts → AI plans → engine referees.** The LLM is never
trusted for legality; `validateAssignments` re-checks every proposal server-side and feeds
conflicts back for repair rounds. Output is the existing `applySchedule` shape, so apply,
undo, checkpoints, seq-concurrency and the ledger all work unchanged.

## Document index

| # | File | Contents | Prompt |
|---|------|----------|--------|
| 00 | `00-ai-schedule-architect.md` | Normative spec: removal of old feature, modes, pipeline, API, data, gating, failure modes, decisions | 41, 42, 43 |
| 01 | `01-llm-contract.md` | The LLM contract: model/params, context-pack format, output schema, verbatim system prompt, repair/refine protocol, eval fixtures | 41, 42 |
| 02 | `02-board-ux.md` | Board UX design + prototype finding: surface the referee/repair loop, 3-colour state contract, block/summary/instruction decisions, states. Prototype artifact linked. | 43 |
| 03 | `03-two-phase-officials-and-intake.md` | 2026-07-18 approved revision: Phase B officials (draft→LLM→referee), pre-flight + wish chips, repair nudges, ledger audit, Pro Plus gates + admin override, drift fixes, deferrals | 85, 86, 87 |

## Prompt index (prompts/)

| Prompt | Delivers | Depends on |
|--------|----------|------------|
| PROMPT-41 | Core engine: context pack, Anthropic call, verify/repair loop, `POST /divisions/{id}/schedule/ai-plan`, removal of old ai-constraints feature, `schedule_source='ai'` migration | — |
| PROMPT-42 | Refine + repair modes, competition-level multi-division planning, constraint-suggestion accept path | PROMPT-41 |
| PROMPT-43 | Board UX: instruction panel, ghost preview, diff + explanations, accept→apply, follow-up chat | PROMPT-41 (42 for follow-up) |

## Build order (canonical)

41 → 42 → 43. Do not run 42/43 alongside 41 (shared files: `schedule-plus.ts`,
`openapi.ts`, `constraints-panel.tsx`).

## House rules

PROMPT-00 conventions apply. Every change ships a failing-without-it regression test;
`scripts/smoke.ts` extended per feature (pro + free paths); `tsc` + unit tests green before
push; new v1 routes registered in `server/api-v1/openapi.ts` ROUTES (coverage test enforces).
Read `v3/11-gaps-and-decisions.md` for still-binding cross-cutting defaults.
