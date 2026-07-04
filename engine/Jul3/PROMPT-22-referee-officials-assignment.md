# PROMPT-22 — Referee & Officials Assignment Engine

**Read first:** `engine/Jul3/02-referee-officials-assignment.md` (normative);
`engine/05-formats-progression-tiebreakers.md` §2.6; `engine/12-scheduling-ux.md` §2, §4;
`engine/13-roles-and-scorer.md` (role labels); `engine/07-greenfield-schema.md` §conventions.
Preamble: PROMPT-00. **Depends:** PROMPT-09 (calendar pass), PROMPT-11 (api), PROMPT-17
(board consumes cards). Promotes the doc 10 `officials.assignment` stub.

## Task
1. **Schema** (Jul3/02 §2): `officials`, `fixture_officials` tables; RLS/org_id trigger per
   010; `check:rls` coverage; keep `fixtures.officials` as denormalized read cache; public
   view nulls names when hidden (doc 07 note 4).
2. **Engine pass** `packages/engine/officials/` — **pure, deterministic, seeded**:
   `assignOfficials(input) → {assignments, conflicts}` per Jul3/02 §3; hard constraints
   (overlap, team-ref-self, poolLock, role coverage), soft objective (fairness, block-stay,
   travel/keep-division). Plus the pure **sourcing resolver** (rank/result → OfficialSpec[])
   for phased assignment. Every rule cites `// Jul3/02 §3`. Property: all-locked re-run = 0
   moves (mirror PROMPT-17 §3).
3. **API** (Jul3/02 §4): `officials` CRUD + import; `divisions/{id}/officials/auto` (propose,
   engine call with locked obstacles) + `/apply` (txn + `division_events: officials_assigned`);
   `fixtures/{id}/officials` PATCH (manual set/move/lock); `stages/{id}/officials/source`.
   Conflict taxonomy block/warn per Jul3/02 §4.
4. **Entitlements** (Jul3/02 §5): `officials.auto`, `officials.roles_multi` = Pro; manual
   single-role Community. 402 with `feature_key`.
5. **Console** (`apps/web`): officials palette + auto/apply actions feeding the PROMPT-17
   board (cards, pin/lock, conflict badges); phased "assign Phase 1 now / Phase 2 when ready"
   affordance; hide-names toggle; a11y (keyboard move).

## Acceptance
- Property (fast-check, ≤64 fixtures): no official double-booked; team-ref never officiates
  own fixture nor while playing; poolLock respected; all-locked idempotence.
- Golden: 24-fixture, 2-court day, 6 officials, block-stay on → each official stays on one
  court within a block, fairness spread ≤1; a phased case where Phase-2 officials resolve
  only after Phase-1 decided.
- E2E: auto-assign → drag a ref into an overlap (blocked) → lock two → re-flow → apply →
  public schedule hides names.
- `npm test` + `npm run lint` green; update `engine/README.md` indexes.
