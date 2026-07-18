# PROMPT-80 — Official marks & match reports: model, usecases, API

**Goal:** SPEC-3's server side — `official_marks` + `match_reports` tables,
organiser mark usecases (Pro-gated), official report usecases on the
cross-org rail, the report→suspension soft bridge, and the v1 API.
**Server only** — UI in PROMPT-81.

**Read first:**
- `design/v16-league-ops/SPEC-3-official-marks-reports.md` — the spec.
- `db/migration/deltas/V284__official_onboarding.sql` — BOTH patterns this
  prompt copies: the new-table RLS shape AND the cross-org write rail
  (`official_availability` is written by the official through the superuser
  connection; tenant policy serves organiser reads).
- `apps/web/src/server/usecases/officials.ts` — assignment rows
  (`fixture_officials`: `role_key`s are **JSONB — use `= any`, not `IN`**,
  v11 lesson), `acceptedOfficialCovers`, how official identity resolves via
  `person_claims` → `officials.person_id`.
- `apps/web/src/server/usecases/me-officiating.ts` (or wherever
  `getMyOfficiating` lives — find it via the #122 `completed[]` work) — the
  `/me` cross-org read path and the completed-union shape the report window
  keys off (**union, not a date window** — #122 lesson).
- `apps/web/src/server/usecases/discipline.ts` — PROMPT-78's
  `createManualSuspension` NOT used here; the bridge inserts directly with
  `source='report'` (see Decisions).
- `db/migration/deltas/V290__pro_plus_plan.sql` — entitlement seed shape.

**Depends:** PROMPT-78 merged (bridge target table). The bridge must still
**ship dark** if `discipline_rules`/`suspensions` are absent at runtime —
guard, don't crash. **Migration: V293 draft — renumber at build.**
PROMPT-81 adds no migrations.

## Decisions (from SPEC-3, restated)

- Mark window: assignment `response='accepted'` AND fixture
  `decided|finalized`. One mark per assignment (unique
  `fixture_official_id`), upsert-editable forever.
- Report window: accepted AND fixture `decided|finalized|abandoned`.
  Draft → submitted; **submitted is immutable**.
- Aggregates: org-scoped avg/count for the console;
  official-facing = global avg/count across all orgs, surfaced only when
  count ≥ 3, never per-mark detail (D4).
- Bridge on submit: incidents with `kind in (red_card, misconduct)` AND a
  `person_id` → insert `suspensions` row `(source='report', status='pending',
  matches_total=1, reason=incident.note, fixture_id, person_id, division_id
  from the fixture)` — only when the org has `discipline.enforced` AND the
  table exists (`to_regclass('suspensions') is not null` probe). Idempotency:
  deterministic `rule_key = 'report:'||fixture_official_id`, `bucket =
  incident index`, riding PROMPT-78's partial unique index by also setting
  source-compatible conflict handling — insert `on conflict do nothing` with
  source `'report'` **excluded** from that index, so add a second partial
  unique index in V293:
  `create unique index suspensions_report_once on suspensions(division_id,
  person_id, rule_key, bucket) where source = 'report';`
- Entitlement `officials.marks`: community/event_pass false, pro/pro_plus
  true. Reports: NO plan gate (free portal principle); identity check only.
- Marks on voided fixtures keep counting (bind to performance, not result).

## Files

- **Create** `db/migration/deltas/V293__official_marks_reports.sql` — the two
  tables + indexes + RLS from SPEC-3 verbatim, the `suspensions_report_once`
  index above, and the `officials.marks` seed (4 plans, V290 shape).
- **Create** `apps/web/src/server/usecases/official-marks.ts`
- **Create** `apps/web/src/server/usecases/match-reports.ts`
- **Create** `apps/web/src/server/usecases/__tests__/official-marks.test.ts`
- **Create** `apps/web/src/server/usecases/__tests__/match-reports.test.ts`
- **Create** `apps/web/src/app/api/v1/fixture-officials/[id]/mark/route.ts` (PUT/DELETE)
- **Create** `apps/web/src/app/api/v1/officials/[id]/marks-summary/route.ts` (GET)
- **Create** `apps/web/src/app/api/v1/me/officiating/[fixtureOfficialId]/report/route.ts` (GET/PUT)
- **Create** `apps/web/src/app/api/v1/me/officiating/[fixtureOfficialId]/report/submit/route.ts` (POST)
- **Create** `apps/web/src/app/api/v1/fixtures/[id]/reports/route.ts` (GET)
- **Modify** `apps/web/src/server/api-v1/schemas.ts` + `openapi.ts` (drift gate)

## Interfaces (produced — PROMPT-81 consumes these exact names)

```ts
// official-marks.ts
export interface MarkSummary { average: number | null; count: number;
  recent: { mark: number; comment: string | null; fixtureLabel: string; createdAt: string }[] }
export function putMark(auth: AuthCtx, fixtureOfficialId: string,
  input: { mark: number; comment?: string }): Promise<void>;   // 1..5, upsert
export function deleteMark(auth: AuthCtx, fixtureOfficialId: string): Promise<void>;
export function orgMarksSummary(auth: AuthCtx, officialId: string): Promise<MarkSummary>;
/** Global, official-facing: null until count >= 3. Superuser read. */
export function myMarksAverage(userId: string): Promise<{ average: number; count: number } | null>;

// match-reports.ts
export type IncidentKind = "red_card" | "misconduct" | "injury" | "other";
export interface ReportIncident { kind: IncidentKind; person_id?: string;
  entrant_id?: string; note: string }
export interface MatchReport { id: string; fixtureOfficialId: string;
  status: "draft" | "submitted"; body: string; incidents: ReportIncident[];
  submittedAt: string | null }
export function getMyReport(userId: string, fixtureOfficialId: string): Promise<MatchReport | null>;
export function putMyReport(userId: string, fixtureOfficialId: string,
  input: { body: string; incidents: ReportIncident[] }): Promise<MatchReport>; // draft only
export function submitMyReport(userId: string, fixtureOfficialId: string): Promise<MatchReport>;
export function fixtureReports(auth: AuthCtx, fixtureId: string): Promise<
  (MatchReport & { officialName: string })[]>;   // submitted only
```

## Build steps (TDD)

- [ ] **Step 1 — Migration.** V293 per Files. `npm run db:apply` clean.
- [ ] **Step 2 — Marks tests first** (DB-backed): window enforcement
  (pending-response or scheduled fixture → 403), upsert (two PUTs → one row,
  second mark wins), org isolation (org B summary excludes org A marks),
  `myMarksAverage` null at 2 marks / value at 3 across two orgs,
  entitlement 403 for community. FAIL.
- [ ] **Step 3 — Implement `official-marks.ts`.** Tenant rail +
  `requireFeature(auth.orgId, "officials.marks")`; `official_id`/`fixture_id`
  stamped from the assignment row server-side (never from the body).
  PASS.
- [ ] **Step 4 — Reports tests first**: identity (user without a claimed
  official on that assignment → 404), window incl. abandoned, draft
  round-trip, submit immutability (PUT after submit → 409), organiser
  `fixtureReports` sees submitted only. Bridge: submit with a red_card
  incident + person → pending suspension `source='report'`; resubmit
  impossible; incident without person_id → no row; org without
  `discipline.enforced` → no row, no error; `suspensions` table absent
  (simulate via to_regclass mock or schema-less test DB) → no error. FAIL.
- [ ] **Step 5 — Implement `match-reports.ts`.** Cross-org superuser rail
  (`official_availability` write path as the template), explicit
  person-claim checks, **never `withTenant` for the official side**. Bridge
  per Decisions. PASS.
- [ ] **Step 6 — Routes + schemas + openapi.** zod: `PutMarkBody`
  (`mark: z.number().int().min(1).max(5)`), `PutReportBody` (incidents array,
  `kind` enum, note required non-empty). Register all paths in `openapi.ts`;
  drift test green.
- [ ] **Step 7 — Verify + commit.** `tsc` + unit suites. Commit:
  `feat(officials): marks + match reports model/usecases/API (V293)`.

## Out of scope

UI, email `report_submitted`, i18n, help, smoke — all PROMPT-81.
