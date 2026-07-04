# PROMPT-24 — Scheduling Constraints v2 & AI-Assisted Planning

**Read first:** `engine/Jul3/04-scheduling-constraints-v2.md` (normative);
`engine/05-formats-progression-tiebreakers.md` §2.6; `engine/12-scheduling-ux.md` §2, §4;
`engine/02-domain-model.md` §3 (persons). Preamble: PROMPT-00. **Depends:** PROMPT-09
(calendar), PROMPT-17 (schedule-settings + console). Extends, does not replace, the solver.

## Task
1. **Constraint schema** (Jul3/04 §3): extend `SchedulingConstraints` (Zod) with `restMin`/
   `restByGroup`, `noBackToBack`, `startWindows`, `fieldFairness`, `parallelism`,
   `crossPersonClash`. Validate at schedule-settings PUT.
2. **Solver additions** `packages/engine/scheduling/calendar.ts` — **pure**: enforce new
   hard constraints (rest, start-windows, cross-person-clash=hard) as placement rejections
   with repair; new soft objectives (field fairness, parallelism=mixed). Cross-division
   **person-keyed** overlap map (Jul3/04 §2) built from `entrant_members ⋈ persons`. Never
   silently drop — surface `conflicts`. Cite `// Jul3/04 §3`.
3. **Bulk shift + flexible mode + report** (Jul3/04 §4): pure `shiftSchedule({scope,delta})`
   and `scheduleReport(assignments) → {perEntrant, worst}`; division `scheduling_mode`
   flag (`timed`|`flexible`, `scheduled_at=null` fixtures).
4. **AI layer** (Jul3/04 §5): `POST /divisions/{id}/schedule/ai-constraints` — prose → LLM
   (Anthropic SDK, latest model, **server-only**) → **Zod-parsed** `SchedulingConstraints`;
   unparseable = refuse. Model never writes DB or schedules; the pure solver does. Propose-
   only, human applies.
5. **API** (Jul3/04 §6): schedule-settings fields; `schedule/shift`; `schedule/report`;
   `ai-constraints`. **Entitlements**: constraint solver Pro (`scheduling.constraints`);
   bulk-shift + report all plans; `scheduling.ai` Pro.
6. **UI**: constraint editor; wait-time report before publish; bulk-shift dialog; AI prose
   box showing the parsed constraints for approval (never auto-apply).

## Acceptance
- Property: no schedule places a person (via any entrant) in two overlapping fixtures when
  `crossPersonClash=hard`; rest/start-window bounds hold; over-constrained instance returns
  best-effort + non-empty `conflicts` (never an invalid slot).
- Golden: player entered in two divisions is never double-booked; a `notBefore:09:30` team
  never slotted earlier; bulk-shift +15m moves all in scope, undoable (PROMPT-23).
- E2E: enter prose "no player plays two teams at once, ≥1 break between games, U8 start
  09:00" → parsed constraints shown → apply → solver honours them; infeasible case reports
  the binding constraint.
- `npm test` + `npm run lint` green; update `engine/README.md` indexes.
