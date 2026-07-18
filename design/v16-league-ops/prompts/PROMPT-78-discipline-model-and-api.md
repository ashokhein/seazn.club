# PROMPT-78 — Discipline: model, card fold, detection, API

**Goal:** the disciplinary spine of SPEC-1 — `discipline_rules` +
`suspensions` tables, the additive `discipline` descriptor on card-emitting
sport modules, the idempotent fold/detection usecase, and the v1 CRUD API.
**Server only** — no UI (PROMPT-79), no report bridge (PROMPT-80).

**Read first:**
- `design/v16-league-ops/SPEC-1-discipline-suspensions.md` — the spec this
  prompt implements. Sections "Data model", "Fold & detection", "Serving".
- `db/migration/deltas/V284__official_onboarding.sql` — the new-table pattern
  to copy verbatim (explicit `org_id`, RLS enable/force, tenant policy,
  `app_user` grants).
- `db/migration/deltas/V290__pro_plus_plan.sql` — the entitlement seed shape
  (`plan_entitlements (plan_key, feature_key, bool_value, int_value)`,
  `on conflict do update`). Every plan gets a row for a new key: a missing
  row DENIES.
- `apps/web/src/server/usecases/player-stats.ts` — `recomputePlayerStats` is
  the fold you are cloning: the `score_events` query, `EventEnvelope`
  assembly, `voids_event_id` handling, recompute-on-read.
- `packages/engine/src/sports/football/football.ts` — `CardRecord`
  (`side`, `person?`, `color: yellow|second_yellow|red`) and the card event
  types football already emits. Also hockey/ice-hockey modules for their
  penalty/card analogues.
- `apps/web/src/server/usecases/scoring.ts` (~line 91) — the decided/void
  write seam where discovery refresh hooks; discipline detection hooks the
  same place.
- `apps/web/src/server/api-v1/schemas.ts`, `.../http.ts`, `.../auth.ts` — 
  zod schema home, `v1`/`reply`/`parseBody`/`requireAuth` route idioms.
- `apps/web/src/lib/entitlements.ts` — `requireFeature(orgId, key)`.
- `apps/web/src/server/usecases/__tests__/schedule.test.ts` — DB-backed
  vitest convention (`skipIf(!HAS_DB)`, per-test org seeding).

**Depends:** nothing. **Migration: V291 draft — renumber to the next free V
at build time and re-check nothing after it seeds the same keys** (V286→V290
lesson). PROMPT-79 adds no migrations.

## Context

Cards already live in the `score_events` ledger and drive the FIFA fair-play
tiebreaker, but nothing accumulates them across fixtures. This prompt folds
them into per-division suspensions behind configurable thresholds. Everything
is a read-side projection: **zero reducer/replay/golden changes** (README D2).

## Decisions (from SPEC-1, restated for the builder)

- Rules JSONB: `accumulation[]` (`{key,color,count,ban_matches}`) +
  `dismissal[]` (`{key,color,ban_matches}`). Buckets are cumulative windows;
  `count: 5` fires at the 5th attributed card of that color, bucket = index
  of the matched window occurrence.
- Auto rows insert as `pending`; the partial unique index
  `(division_id, person_id, rule_key, bucket) where source in
  ('auto_accumulation','auto_dismissal')` is the idempotency arbiter —
  insert `on conflict do nothing`, never pre-check in application logic.
- Voided trigger cards: delete **pending** auto rows whose triggers no longer
  hold; never touch `active`/`served`/`waived` rows (organiser owns decided
  rows; PROMPT-79 shows a hint chip instead).
- Serving: an `active` suspension serves one match per fixture of the
  suspension's `entrant_id` reaching `decided`/`finalized` after
  `decided_at`; `abandoned`/`cancelled` don't count; a forfeit BY the
  suspended entrant counts. Flip to `served` when
  `matches_served >= matches_total`.
- Anonymous cards (`person` undefined) never accumulate.
- Entitlement `discipline.enforced`: community/event_pass false, pro/pro_plus
  true. Gate writes AND rules CRUD with `requireFeature`.
- Manual suspensions: `source='manual'`, created directly as `pending`
  (organiser confirms their own entry to activate — one state machine, no
  special path).

## Files

- **Create** `db/migration/deltas/V291__discipline.sql`
- **Modify** `packages/engine/src/core/types.ts` — add optional `discipline`
  to the sport-module interface + `DisciplineCard` type
- **Modify** `packages/engine/src/sports/football/football.ts` — implement
  `discipline` (extract from existing card event types)
- **Modify** hockey + ice-hockey modules — same, for their card/penalty events
- **Create** `packages/engine/src/conformance/discipline.test.ts` — every
  module whose event types include cards must expose `discipline`
- **Create** `apps/web/src/server/usecases/discipline.ts`
- **Create** `apps/web/src/server/usecases/__tests__/discipline.test.ts`
- **Create** `apps/web/src/app/api/v1/divisions/[id]/discipline-rules/route.ts` (GET/PUT)
- **Create** `apps/web/src/app/api/v1/divisions/[id]/suspensions/route.ts` (GET list, POST manual)
- **Create** `apps/web/src/app/api/v1/suspensions/[id]/route.ts` (PATCH confirm/waive/adjust)
- **Modify** `apps/web/src/server/api-v1/schemas.ts` — zod schemas
- **Modify** `apps/web/src/server/api-v1/openapi.ts` — register the routes
  (**openapi regen/drift gate — bitten three times in v13; do not skip**)
- **Modify** `apps/web/src/server/usecases/scoring.ts` — call
  `detectSuspensions` on the decided/void seam (behind a cheap
  rules-enabled probe)

## Interfaces (produced — PROMPT-79/80 consume these exact names)

```ts
// packages/engine/src/core/types.ts (additive)
export interface DisciplineCard {
  personId?: string;
  entrantSide: Side;
  color: string;          // module-declared key, e.g. "yellow" | "red"
  eventId: string;
}
export interface DisciplineModel {
  colors: { key: string; label: string }[];
  extractCards(ledger: EventEnvelope[]): DisciplineCard[];
}
// SportModule gains: discipline?: DisciplineModel

// apps/web/src/server/usecases/discipline.ts
export type SuspensionStatus = "pending" | "active" | "served" | "waived";
export type SuspensionSource =
  "auto_accumulation" | "auto_dismissal" | "manual" | "report";

export interface DisciplineRules {
  accumulation: { key: string; color: string; count: number; ban_matches: number }[];
  dismissal:    { key: string; color: string; ban_matches: number }[];
}
export interface Suspension {
  id: string; divisionId: string; personId: string; personName: string;
  entrantId: string | null; entrantName: string | null;
  status: SuspensionStatus; source: SuspensionSource;
  reason: string; matchesTotal: number; matchesServed: number;
  fixtureId: string | null; createdAt: string; decidedAt: string | null;
  triggerVoided: boolean;   // true when a trigger event is now voided (hint chip)
}

export function getDisciplineRules(auth: AuthCtx, divisionId: string):
  Promise<{ enabled: boolean; rules: DisciplineRules; sportColors: {key:string;label:string}[] } | null>;
  // null when the division's sport module has no discipline model
export function putDisciplineRules(auth: AuthCtx, divisionId: string,
  body: { enabled: boolean; rules: DisciplineRules }): Promise<void>;
export function listSuspensions(auth: AuthCtx, divisionId: string,
  status?: SuspensionStatus): Promise<Suspension[]>;
export function createManualSuspension(auth: AuthCtx, divisionId: string,
  input: { personId: string; matchesTotal: number; reason: string }): Promise<Suspension>;
export function decideSuspension(auth: AuthCtx, id: string,
  action: { kind: "confirm" } | { kind: "waive" } |
          { kind: "adjust"; matchesTotal?: number; reason?: string }): Promise<Suspension>;

/** Recompute-on-read fold + detection + serving. Idempotent. Called by every
 *  read above and by the scoring decided-seam hook. Safe on divisions with
 *  no rules row (no-op). */
export function detectSuspensions(tx: Tx, divisionId: string): Promise<void>;

/** Cross-surface helpers for PROMPT-79: */
export function activeSuspensionsByEntrant(tx: Tx, divisionId: string):
  Promise<Map<string, { personId: string; personName: string; remaining: number }[]>>;
export function publicSuspensions(orgSlug: string, competitionSlug: string,
  divisionSlug: string): Promise<{ name: string; remaining: number }[]>;
  // names via public_person_name(consent) — exactly publicDivisionStats
```

## Build steps (TDD, bite-sized)

- [ ] **Step 1 — Migration.** Write `V291__discipline.sql` with the two
  tables + indexes + RLS exactly as SPEC-1 "Data model" (copy the DDL block
  verbatim, then V284-style RLS/grants), plus the entitlement seed:
  ```sql
  insert into plan_entitlements (plan_key, feature_key, bool_value, int_value) values
    ('community',  'discipline.enforced', false, null),
    ('event_pass', 'discipline.enforced', false, null),
    ('pro',        'discipline.enforced', true,  null),
    ('pro_plus',   'discipline.enforced', true,  null)
  on conflict (plan_key, feature_key) do update
    set bool_value = excluded.bool_value, int_value = excluded.int_value;
  ```
  Run `npm run db:apply` against the local dev DB; expect clean migrate.
- [ ] **Step 2 — Engine descriptor, failing conformance test first.** Write
  `packages/engine/src/conformance/discipline.test.ts`: iterate all
  registered modules; for each whose event-type registry contains a
  card/penalty event, assert `module.discipline` is defined and
  `extractCards` on that module's golden ledger returns ≥1 card with a
  declared color. Run: expect FAIL for football/hockey/ice-hockey.
- [ ] **Step 3 — Implement `discipline` on the three modules** by projecting
  their existing card event payloads into `DisciplineCard[]` (reuse the same
  payload parsing their reducers/`playerStats` already do — do not invent a
  second payload reader if a helper exists; extract one if needed). Types in
  `core/types.ts`. Run conformance + the module test suites: PASS, golden
  files untouched (`git status` must show no `.golden.json` changes).
- [ ] **Step 4 — Fold + detection, tests first.** In
  `__tests__/discipline.test.ts` (DB-backed, `skipIf(!HAS_DB)`), seed an org
  + football division + fixtures, insert attributed card events, and assert:
  (a) 5 yellows → one pending `yellow_5` row; re-run `detectSuspensions`
  twice → still one row. (b) 10th yellow → second row bucket 2.
  (c) red → `auto_dismissal` pending. (d) voiding a trigger yellow deletes
  the pending row; confirming first then voiding leaves the row with
  `triggerVoided: true`. (e) anonymous card accumulates nothing.
  (f) serving: confirm → two decided fixtures for the entrant →
  `matches_served = 2`, status `served`; abandoned fixture doesn't count;
  forfeit by the suspended entrant counts. Expect all FAIL.
- [ ] **Step 5 — Implement `discipline.ts`** per the interfaces block: fold
  clones `recomputePlayerStats`'s event query; rules from
  `discipline_rules`; inserts `on conflict do nothing`; serving update +
  status flip in the same pass; `requireFeature(auth.orgId,
  "discipline.enforced")` on every auth'd entry point. Run tests: PASS.
- [ ] **Step 6 — Scoring seam.** In `scoring.ts`, where decided/void writes
  refresh discovery, add `await detectSuspensions(tx, divisionId)` guarded
  by a one-query probe (`select 1 from discipline_rules where division_id =
  … and enabled`). Regression test: deciding a fixture in a rules-enabled
  division creates the pending row without any discipline read. PASS.
- [ ] **Step 7 — Routes + schemas + openapi.** zod: `DisciplineRulesBody`
  (validate colors against the module's declared keys at the usecase, not in
  zod), `CreateSuspensionBody`, `DecideSuspensionBody` (discriminated on
  `kind`). Routes per the Files list, `requireAuth(req, "write")` for
  mutations. Register every path in `openapi.ts`. Run the openapi drift
  test: PASS.
- [ ] **Step 8 — Entitlement denial test.** Community org → rules PUT and
  suspension POST return 403; GET rules returns the PlusReveal-shaped 403
  the console expects (mirror how other Pro usecases signal it). PASS.
- [ ] **Step 9 — Verify + commit.** `npx tsc --noEmit` + full unit run +
  conformance. Commit: `feat(discipline): model, card fold, detection, API (V291)`.

## Out of scope (later prompts)

No UI strings, no i18n keys, no help article, no smoke extension — PROMPT-79
carries ALL of it (help/i18n/smoke are per-PR closing passes and land with
the UI PR of this spec).
