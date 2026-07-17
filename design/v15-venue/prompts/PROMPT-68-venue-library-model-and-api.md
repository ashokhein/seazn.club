# PROMPT-68 — Venue library: model, usecases, API

**Goal:** an org-scoped, reusable venue entity that owns its courts, with tenant
RLS, server usecases, and a v1 CRUD API. **Server only** — no console UI yet
(PROMPT-69), no scheduling (PROMPT-71).

**Read first:**
- `db/migration/deltas/V284__official_onboarding.sql` — the **current** new-table
  pattern to copy verbatim: `create table … references organizations(id) on
  delete cascade`, `create index …_org_idx`, `enable`/`force row level
  security`, `create policy …_tenant … using (org_id = current_org_id()) with
  check (…)`, `grant … to app_user`. Note it passes `org_id` **explicitly**
  (no `set_org_from_parent` trigger). Do the same.
- `db/migration/deltas/V114__scheduling.sql` — the *older* trigger/guard style.
  **Do NOT copy its fresh/live guards** — V284 is the pattern now. It also shows
  the `plan_entitlements` seed shape and confirms `scheduling.multi_division` is
  already seeded (so PROMPT-70 needs no new entitlement).
- `apps/web/src/server/usecases/competitions.ts` — the usecase shape to mirror:
  `listCompetitions(auth, query)`, `createCompetition(auth, body)`, how `auth`
  (org-scoped tenant connection) is threaded, how rows map camelCase.
- `apps/web/src/app/api/v1/competitions/route.ts` — the route shape:
  `v1(async () => …)`, `requireAuth(req, "read"|"write")`, `parseBody(req,
  Schema)`, `reply(201, …)`, `listQuery(req)`. Mirror for venues.
- `apps/web/src/server/api-v1/schemas.ts` — where zod request schemas live
  (e.g. `CreateCompetition`, and the schedule config at ~line 607). Add the
  venue schemas here.
- `apps/web/src/server/api-v1/http.ts` and `.../auth.ts` — `v1`, `reply`,
  `parseBody`, `listQuery`, `requireAuth`, and the `Auth` type (org id +
  tenant SQL client). Use the same client the other usecases use.
- `apps/web/src/lib/routes.ts` — the typed route helper (`orgHome`,
  `orgSettings`, `divisionSchedule`). Add `orgVenues` here (used by PROMPT-69).
- `apps/web/src/server/usecases/__tests__/schedule.test.ts` — the DB-backed
  vitest convention: `skipIf(!HAS_DB)`, `DATABASE_URL`, per-test org seeding.
- Memory/AGENTS: migrations at repo root `db/migration/deltas`; `db:apply` =
  Flyway migrate; local test DB recipe (ephemeral PG on `:54329`).

**Depends:** nothing. **Migration: V285** (this prompt owns the whole schema for
the wave; PROMPT-69/70/71 add no migrations).

## Context

A venue today is `fixtures.venue` — a free string, retyped per fixture, invisible
to everything. This prompt lays the durable spine: a `venues` table the org owns
and reuses, a `venue_courts` child table whose rows become scheduler grid columns
later, and the two M:N join tables plus the fixture FK that PROMPT-70/71 will
populate. Landing **all** of it in one migration (V285) means every downstream
prompt is pure application code.

`address`/`lat`/`lng` ship now but stay null-by-default and unused this wave —
they exist so the later Google/OSM auto-fill spec writes into an existing shape
rather than forcing V-number churn.

## Decisions

- **One migration, V285, all tables** (see README data model). Explicit `org_id`
  on every table; RLS tenant policy; full CRUD grant to `app_user`.
- **`venue_courts.name` unique per venue**; `sort_order` int for stable column
  order. `kind`/`surface` are `check`-constrained text (not enums — matches the
  codebase's `text check (…)` house style, e.g. V284 `response`).
- **Slugs**: `venues.slug` unique per org, generated from name (reuse the
  existing slugify helper the org/competition usecases use — find it via
  `competitions.ts`; do not hand-roll a new one).
- **Usecases return camelCase** domain objects; SQL stays snake_case.
- **Delete is a hard delete** (org-only). `venue_courts` cascade via FK;
  `competition_venues`/`division_venues` cascade; `fixtures.venue_court_id`
  is `on delete set null` so deleting a venue never orphans a scheduled fixture
  (it just loses the structured link, keeps its `court_label` string).

## Files

- **Create** `db/migration/deltas/V285__venues.sql`
- **Create** `apps/web/src/server/usecases/venues.ts`
- **Create** `apps/web/src/server/usecases/__tests__/venues.test.ts`
- **Create** `apps/web/src/app/api/v1/venues/route.ts` (GET list, POST create)
- **Create** `apps/web/src/app/api/v1/venues/[id]/route.ts` (GET/PATCH/DELETE)
- **Create** `apps/web/src/app/api/v1/venues/[id]/courts/route.ts` (POST add court)
- **Create** `apps/web/src/app/api/v1/venue-courts/[id]/route.ts` (PATCH/DELETE court)
- **Modify** `apps/web/src/server/api-v1/schemas.ts` — add venue zod schemas
- **Modify** `apps/web/src/lib/routes.ts` — add `orgVenues(org)`
- **Modify** `openapi/openapi.yaml` (+ whatever the drift gate reads) — document
  the new paths so the openapi drift test stays green (see PROMPT-70/71 note;
  find the gate via `apps/web/src/server/__tests__` referencing openapi).

## Interfaces (produced — later prompts consume these exact names)

```ts
// apps/web/src/server/usecases/venues.ts
export type VenueKind = "indoor" | "outdoor";
export type VenueSurface = "grass" | "hard" | "clay" | "wood" | "astro" | "other";

export interface VenueCourt {
  id: string; venueId: string; orgId: string;
  name: string; kind: VenueKind; surface: VenueSurface; sortOrder: number;
}
export interface Venue {
  id: string; orgId: string; name: string; slug: string;
  address: string | null; lat: number | null; lng: number | null;
  openFrom: string | null; openTo: string | null;   // "HH:MM" 24h, or null
  timezone: string | null; notes: string | null;
  createdAt: string; updatedAt: string;
}
export interface VenueWithCourts extends Venue { courts: VenueCourt[]; }

export function listVenues(auth: Auth): Promise<VenueWithCourts[]>;
export function getVenue(auth: Auth, id: string): Promise<VenueWithCourts>;
export function createVenue(auth: Auth, input: CreateVenueInput): Promise<Venue>;
export function updateVenue(auth: Auth, id: string, input: UpdateVenueInput): Promise<Venue>;
export function deleteVenue(auth: Auth, id: string): Promise<void>;
export function addCourt(auth: Auth, venueId: string, input: CourtInput): Promise<VenueCourt>;
export function updateCourt(auth: Auth, courtId: string, input: Partial<CourtInput>): Promise<VenueCourt>;
export function removeCourt(auth: Auth, courtId: string): Promise<void>;
```

`CreateVenueInput` / `UpdateVenueInput` / `CourtInput` are the inferred types of
the zod schemas below.

## Build steps (TDD, bite-sized)

- [ ] **Step 1 — Write the migration.** Create `db/migration/deltas/V285__venues.sql`:

```sql
-- =============================================================================
-- V285 — Venues (design v15, PROMPT-68). A venue is an org-owned, reusable
-- place that owns its courts/pitches. Multi-venue scheduling (PROMPT-70/71)
-- reads these; address/lat/lng are reserved for the later auto-fill spec and
-- stay null this wave. Pattern mirrors V284 (explicit org_id, tenant RLS).
-- =============================================================================

create table venues (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organizations(id) on delete cascade,
  name       text not null,
  slug       text not null,
  address    text,
  lat        numeric(9,6),
  lng        numeric(9,6),
  open_from  time,
  open_to    time,
  timezone   text,
  notes      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, slug)
);
create index venues_org_idx on venues(org_id);

create table venue_courts (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organizations(id) on delete cascade,
  venue_id   uuid not null references venues(id) on delete cascade,
  name       text not null,
  kind       text not null default 'indoor'  check (kind in ('indoor','outdoor')),
  surface    text not null default 'other'
               check (surface in ('grass','hard','clay','wood','astro','other')),
  sort_order int  not null default 0,
  created_at timestamptz not null default now(),
  unique (venue_id, name)
);
create index venue_courts_org_idx   on venue_courts(org_id);
create index venue_courts_venue_idx on venue_courts(venue_id);

create table competition_venues (
  org_id         uuid not null references organizations(id) on delete cascade,
  competition_id uuid not null references competitions(id) on delete cascade,
  venue_id       uuid not null references venues(id) on delete cascade,
  primary key (competition_id, venue_id)
);
create index competition_venues_org_idx   on competition_venues(org_id);
create index competition_venues_venue_idx on competition_venues(venue_id);

create table division_venues (
  org_id      uuid not null references organizations(id) on delete cascade,
  division_id uuid not null references divisions(id) on delete cascade,
  venue_id    uuid not null references venues(id) on delete cascade,
  primary key (division_id, venue_id)
);
create index division_venues_org_idx   on division_venues(org_id);
create index division_venues_venue_idx on division_venues(venue_id);

-- Additive link from a scheduled fixture to a structured court. Legacy
-- fixtures.court_label / venue free-text stay as the display fallback.
alter table fixtures add column venue_court_id uuid references venue_courts(id) on delete set null;

-- RLS: org members manage venues through the tenant connection.
do $$
declare t text;
begin
  foreach t in array array['venues','venue_courts','competition_venues','division_venues']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force  row level security', t);
    execute format('drop policy if exists %I on %I', t||'_tenant', t);
    execute format($p$create policy %I on %I for all to app_user
                     using (org_id = current_org_id()) with check (org_id = current_org_id())$p$,
                   t||'_tenant', t);
    execute format('grant select, insert, update, delete on %I to app_user', t);
  end loop;
end $$;

-- No new entitlement: PROMPT-70's 2nd-venue gate reuses scheduling.multi_division (V114).
```

- [ ] **Step 2 — Apply & sanity check.**
  Run: `DATABASE_URL=$DATABASE_URL npm run db:apply`
  Expected: Flyway reports `V285` migrated; `\d venues` shows the columns and the
  `venues_tenant` policy. (Local dev DB per the memory recipe.)

- [ ] **Step 3 — Write the failing usecase test.** Create
  `apps/web/src/server/usecases/__tests__/venues.test.ts`. Follow
  `schedule.test.ts` for `skipIf(!HAS_DB)` + org seeding helpers. Cover:

```ts
import { describe, it, expect } from "vitest";
import { createVenue, listVenues, addCourt, getVenue,
         updateVenue, deleteVenue, removeCourt } from "../venues";
// … test harness: seedOrg() → Auth, HAS_DB guard as in schedule.test.ts

describe.skipIf(!HAS_DB)("venues usecase", () => {
  it("creates a venue with a generated unique slug and lists it", async () => {
    const auth = await seedOrg();
    const v = await createVenue(auth, { name: "Riverside Leisure", openFrom: "09:00", openTo: "22:00" });
    expect(v.slug).toBe("riverside-leisure");
    const list = await listVenues(auth);
    expect(list.map((x) => x.id)).toContain(v.id);
    expect(list[0]!.courts).toEqual([]);
  });

  it("adds courts that come back ordered and typed", async () => {
    const auth = await seedOrg();
    const v = await createVenue(auth, { name: "Riverside" });
    await addCourt(auth, v.id, { name: "Court 2", kind: "indoor", surface: "wood", sortOrder: 2 });
    await addCourt(auth, v.id, { name: "Court 1", kind: "indoor", surface: "wood", sortOrder: 1 });
    const full = await getVenue(auth, v.id);
    expect(full.courts.map((c) => c.name)).toEqual(["Court 1", "Court 2"]);
    expect(full.courts[0]!.surface).toBe("wood");
  });

  it("isolates venues across orgs (RLS)", async () => {
    const a = await seedOrg(); const b = await seedOrg();
    const v = await createVenue(a, { name: "A-Ground" });
    await expect(getVenue(b, v.id)).rejects.toThrow(); // not visible to org B
    expect(await listVenues(b)).toEqual([]);
  });

  it("deletes a venue and cascades its courts", async () => {
    const auth = await seedOrg();
    const v = await createVenue(auth, { name: "Temp" });
    const c = await addCourt(auth, v.id, { name: "C1" });
    await deleteVenue(auth, v.id);
    expect(await listVenues(auth)).toEqual([]);
  });
});
```

- [ ] **Step 4 — Run it, watch it fail.**
  Run: `DATABASE_URL=$DATABASE_URL npx vitest run apps/web/src/server/usecases/__tests__/venues.test.ts`
  Expected: FAIL — `Cannot find module '../venues'`.

- [ ] **Step 5 — Add the zod schemas.** In `apps/web/src/server/api-v1/schemas.ts`:

```ts
export const CourtInput = z.object({
  name: z.string().min(1).max(80),
  kind: z.enum(["indoor", "outdoor"]).default("indoor"),
  surface: z.enum(["grass", "hard", "clay", "wood", "astro", "other"]).default("other"),
  sortOrder: z.number().int().min(0).max(999).default(0),
});
const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const CreateVenue = z.object({
  name: z.string().min(1).max(120),
  address: z.string().max(300).nullish(),
  lat: z.number().min(-90).max(90).nullish(),
  lng: z.number().min(-180).max(180).nullish(),
  openFrom: HHMM.nullish(),
  openTo: HHMM.nullish(),
  timezone: z.string().max(64).nullish(),
  notes: z.string().max(2000).nullish(),
});
export const UpdateVenue = CreateVenue.partial();
```

- [ ] **Step 6 — Implement `venues.ts`.** Mirror `competitions.ts` for the tenant
  SQL client, camelCase mapping, and slug generation (reuse its slugify import;
  on slug collision append `-2`, `-3`, … like the org/competition usecases do).
  `getVenue`/`listVenues` join `venue_courts` ordered by `sort_order, name`.
  `open_from`/`open_to` map to/from `"HH:MM"` (SQL `time` → format to `HH:MM`).
  Every insert sets `org_id = auth.orgId` explicitly. `addCourt`/`updateCourt`
  set `org_id` from the parent venue (a sub-select against `venues` under the
  same tenant policy — a court can only attach to a venue the caller can see).

- [ ] **Step 7 — Run the usecase test green.**
  Run: `DATABASE_URL=$DATABASE_URL npx vitest run apps/web/src/server/usecases/__tests__/venues.test.ts`
  Expected: PASS (all 4).

- [ ] **Step 8 — Wire the API routes.** Create the four route files mirroring
  `competitions/route.ts`:
  - `venues/route.ts`: `GET` → `listVenues(auth)`; `POST` → `reply(201,
    createVenue(auth, parseBody(req, CreateVenue)))`.
  - `venues/[id]/route.ts`: `GET` → `getVenue`; `PATCH` → `updateVenue(auth, id,
    parseBody(req, UpdateVenue))`; `DELETE` → `deleteVenue` then `reply(204)`.
  - `venues/[id]/courts/route.ts`: `POST` → `addCourt(auth, id, parseBody(req,
    CourtInput))`.
  - `venue-courts/[id]/route.ts`: `PATCH` → `updateCourt`; `DELETE` →
    `removeCourt`.
  All go through `v1()` + `requireAuth(req, "read"|"write")`.

- [ ] **Step 9 — Add the route helper.** In `apps/web/src/lib/routes.ts`:

```ts
orgVenues: (org: Slug) => `/o/${org}/settings/venues`,
```

- [ ] **Step 10 — Keep the openapi drift gate green.** Add the `/v1/venues*`
  paths + schemas to `openapi/openapi.yaml` (match an existing CRUD resource's
  entry). Run the drift test the repo uses (grep `openapi` in
  `apps/web/src/server/__tests__` to find it).
  Run: `npx vitest run apps/web/src/server/__tests__` (the openapi test)
  Expected: PASS (no drift).

- [ ] **Step 11 — Full local verify + commit.**
  Run: `npx tsc -p apps/web --noEmit` → 0 errors.
  Run: `DATABASE_URL=$DATABASE_URL npx vitest run` (unit + touched DB suites) → green.
  ```bash
  git add db/migration/deltas/V285__venues.sql \
          apps/web/src/server/usecases/venues.ts \
          apps/web/src/server/usecases/__tests__/venues.test.ts \
          apps/web/src/app/api/v1/venues apps/web/src/app/api/v1/venue-courts \
          apps/web/src/server/api-v1/schemas.ts apps/web/src/lib/routes.ts \
          openapi/openapi.yaml
  git commit -m "feat(venues): org-scoped venue+courts model, usecases, v1 API (V285)"
  ```

## Non-goals

- No console UI (PROMPT-69). No competition/division assignment (PROMPT-70).
- No scheduler wiring, no `venue_court_id` writes yet (PROMPT-71).
- `address`/`lat`/`lng`/`timezone` accepted & stored but not surfaced.

## Done when

- V285 applies clean; `venues`, `venue_courts`, `competition_venues`,
  `division_venues` exist with tenant RLS; `fixtures.venue_court_id` added.
- `venues.ts` usecases pass the 4 DB-backed tests incl. cross-org isolation.
- `/api/v1/venues`, `/api/v1/venues/[id]`, `.../courts`, `/api/v1/venue-courts/[id]`
  respond and are auth-gated.
- `tsc` clean, openapi drift green, full unit run green. Committed.
