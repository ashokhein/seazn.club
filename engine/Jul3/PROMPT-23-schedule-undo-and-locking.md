# PROMPT-23 — Schedule Undo, Versioning & Safe Destructive Ops

**Read first:** `engine/Jul3/03-schedule-undo-and-locking.md` (normative);
`engine/05-formats-progression-tiebreakers.md` §5 (division ledger); `engine/02-domain-model.md`
§6, §8; `engine/07-greenfield-schema.md` notes 1–3; `engine/12-scheduling-ux.md` §3.
Preamble: PROMPT-00. **Depends:** PROMPT-08 (progression ledger), PROMPT-17 (console/board).

## Task
1. **Schema** (Jul3/03 §2): `divisions.schedule_locked/edit_watermark`, `fixtures.locked/
   schedule_source`, `division_checkpoints` table; RLS/org_id + `check:rls`.
2. **Engine** `packages/engine/history/` — **pure**: the `ReversibleOp` registry (Jul3/03 §3)
   declaring `invert` for each structural `division_events` type; `undo`/`redo` as pure
   functions `(state, ledger, watermark) → {eventToAppend, newWatermark}`; `fold(events ≤
   watermark) → DivisionScheduleState`. Results-guard: block undo past decided fixtures
   (`UNDO_BLOCKED_HAS_RESULTS`). Cite `// Jul3/03 §3`.
3. **Scoped ops** (Jul3/03 §5): pure `clearSchedule(scope)` + `removeEntrantsFromPool(poolId)`
   returning the events to append; `excludeLocked` default true; results-guard.
4. **App/API** (Jul3/03 §6): `undo`/`redo`/`history`/`checkpoints`/`restore` endpoints
   (division-lock append, optimistic seq → 409 on stale); `schedule/clear` + `pools/{id}/
   clear-entrants` requiring `confirm:true`; `fixtures/{id}` PATCH `locked`. All emit
   ledger events; hash-chain intact.
5. **Locking** (Jul3/03 §4): wire persisted `fixtures.locked` + scope-lock predicate into
   PROMPT-17's `lockedAssignments` obstacle input (two-site safety).
6. **UI**: undo/redo buttons + history panel + named checkpoints; confirm modal on clear,
   button moved away from "Schedule" (doc 18-May ask); pin/lock badges.

## Acceptance
- Property: `apply → undo → redo` round-trips to identical state; undo never mutates ledger
  rows (append-only); watermark truncation linearises history (Word-like).
- Golden: generate 8-team schedule → move 3 fixtures → undo×3 = original → redo×3 = moved;
  scoped clear of pool A leaves pool B + locked fixtures intact.
- E2E: two-site division — regenerate site A with site B locked → site B fixtures unchanged;
  clear without confirm rejected; restore to a checkpoint (guarded past results).
- `npm test` + `npm run lint` green; update `engine/README.md` indexes.
