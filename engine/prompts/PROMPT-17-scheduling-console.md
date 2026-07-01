# PROMPT-17 — Scheduling Console (Auto + Drag-and-Drop) & Start Flows

**Read first:** `engine/12-scheduling-ux.md` (normative); `engine/05-formats-progression-tiebreakers.md`
§2.6; `engine/08-api-design.md` §3. Preamble: PROMPT-00. Depends: PROMPT-09 (calendar
pass), PROMPT-11 (API), PROMPT-12 (public schedule tab consumes output). UI portions can
run alongside PROMPT-15's fixture console.

## Task

1. **Schema delta** (doc 12 §3): `fixtures.schedule_source/schedule_locked`,
   `schedule_settings` table (RLS + org_id trigger per house pattern); migration +
   `check:rls` coverage.
2. **API** per doc 12 §4: schedule-settings PUT, `schedule/auto` (propose only — calls
   `@seazn/engine` calendar pass with locked fixtures as obstacles), `schedule/apply`
   (transactional persist + `division_events: schedule_edited/…`), fixture PATCH move,
   `schedule/validate`, `publish-schedule`, `divisions/{id}/start`. Conflict taxonomy
   exactly doc 12 §2 (`conflict.court` and direct-feed `warn.order` block; others warn).
3. **Engine extension** (`packages/engine/scheduling/calendar.ts`): support
   `lockedAssignments` input (fixed obstacles), `sessionWindows`, cross-division
   sibling assignments + per-person overlap detection (needs person→entrant map input).
   Pure + deterministic as before; property: re-run with all outputs locked = zero moves.
4. **Two launch actions** on division page (doc 12 §1): `Start tournament` (quick-start:
   generate → sequence-slot → active) and `Schedule` (generate → auto pass → board).
   Division state machine per doc 12 §1 incl. `schedule_published`/`division_started`
   events; scoring endpoints reject events before start.
5. **Drag-and-drop board** (`apps/web`): grid courts × time (day/week views), fixture
   cards (TBD feed labels, division colours in competition view), drag with optimistic
   move + debounced validate, violation badges, pin/lock toggle, "re-flow remaining",
   bulk shift/swap tools. Realtime refresh on `division:{id}`. Keyboard-accessible
   alternative (select card → move via menu) — a11y required.
6. **Entitlement gates** per doc 12 §5 (`scheduling.constraints`, `scheduling.board`
   view-only for Community, multi-division board Pro).
7. Public dashboard schedule tab + `.ics` reflect published schedule only (unpublished
   edits invisible); `revalidateTag` on apply/publish.

## Acceptance
- E2E: 8-team group+KO division — auto-schedule across 2 courts with rest constraint,
  drag one fixture into a court clash (blocked), into a rest violation (warned, allowed),
  lock two cards, re-flow, publish, start, score round 1, rain-reschedule remaining.
- Property tests: locked-fixtures idempotence; validator finds every seeded conflict class.
- Community org: board renders view-only; quick-start unaffected.
