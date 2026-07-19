# Clubs & Teams W1 Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship wave W1 of the clubs & teams redesign: V292 schema + admin-tunable caps, thin "Clubs & Teams" directory list, the club hub page at `/clubs/[id]` (Overview/Teams/Entries), standalone teams, inline player quick-add, and inline plan editing in `/admin/entitlements`.

**Architecture:** Additive V292 migration (club profile columns + `club_contacts`), caps resolved through the existing `plan_entitlements` → `withinLimit()` rail (no code constants), new console route `/clubs/[id]` server page with tab components, and the existing Directory tab reduced to a thin list. All API surface stays in the v1 envelope (`v1()` + zod schemas + `requireResourceAuth`).

**Tech Stack:** Next.js (this repo's fork — read `node_modules/next/dist/docs/` before writing route/page code), postgres.js `withTenant`, zod, Supabase Storage, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-07-18-clubs-teams-redesign-design.md`

## Global Constraints

- Migration number is **V292** (`db/migration/deltas/V292__clubs_teams_redesign.sql`). Do not renumber; do not touch V285–V290.
- Caps (defaults, all tunable in admin): `clubs.max` community 2 / event_pass 2 / pro 20 / pro_plus ∞(null); `teams.max` 2 / 2 / 40 / ∞; `teams.squad_max` 20 / 20 / ∞ / ∞. `clubs.hierarchy` becomes bool TRUE for all four plans.
- Cap violation → `PaymentRequiredError(featureKey)` → 402 envelope → existing `UpgradeGate`.
- **Colors deviation from spec §4.1 (intentional):** keep the deployed `z.record(z.string(), z.string())` wire shape; the UI writes flat keys `home_primary`, `home_secondary`, `away_primary`, `away_secondary`. No nested object, no data migration.
- Keep `/directory?tab=clubs` URL stable (label changes to "Clubs & Teams"; param value stays `clubs`).
- i18n: every new UI string goes into `apps/web/src/dictionaries/{en,fr,es,nl}/ui.json` — the 4-locale parity test fails otherwise.
- After ANY change to `apps/web/src/server/api-v1/schemas.ts` or route files: run `npm run openapi:gen` and commit the regenerated `openapi/*.json` (3×-repeated gotcha).
- Every code change ships a test that fails without it.
- Work in a worktree branch, never checkout in the main repo dir: `git worktree add .claude/worktrees/clubs-w1 -b feat/clubs-w1`.
- Verify before push: `npx tsc --noEmit` + `npm run test:unit` from `apps/web`.
- DB-backed vitest suites need `DATABASE_URL` (local test DB recipe, port 54329) — they skip silently without it.
- Match file idioms: section comments citing spec (`W1 §…`), `msg("key")` for client strings, `t(ui,"key")` server-side.

## File Structure

```
db/migration/deltas/V292__clubs_teams_redesign.sql        (new) schema + entitlements
apps/web/src/lib/feature-copy.ts                          (mod) reasons for new keys
apps/web/src/server/usecases/clubs.ts                     (mod) slug, caps, contacts, profile cols
apps/web/src/server/usecases/teams.ts                     (mod) standalone create, move/detach, squad cap
apps/web/src/server/usecases/imports.ts                   (mod) cap guards at commit
apps/web/src/server/api-v1/schemas.ts                     (mod) Club/PatchClub/contacts/team schemas
apps/web/src/app/api/v1/clubs/[id]/contacts/route.ts      (new) GET/POST
apps/web/src/app/api/v1/clubs/[id]/contacts/[contactId]/route.ts (new) PATCH/DELETE
apps/web/src/app/api/v1/teams/route.ts                    (mod) POST standalone
apps/web/src/app/api/v1/teams/[id]/route.ts               (new) PATCH club_id (move/detach)
apps/web/src/app/api/admin/entitlements/route.ts          (new) PATCH plan cell
apps/web/src/app/admin/entitlements/page.tsx              (mod) render client editor
apps/web/src/components/admin/ent-cell-editor.tsx         (new) inline cell edit
apps/web/src/app/directory/page.tsx                       (mod) thin list tab
apps/web/src/components/v2/clubs-teams-list.tsx           (new) thin list panel
apps/web/src/app/clubs/[id]/page.tsx                      (new) hub server page
apps/web/src/components/v2/club-hub/overview-tab.tsx      (new) profile + contacts
apps/web/src/components/v2/club-hub/teams-tab.tsx         (new) teams + squads + logo grid
apps/web/src/components/v2/club-hub/entries-tab.tsx       (new) entries grid
apps/web/src/components/v2/club-hub/team-squad-editor.tsx (new) moved editor + quick-add
apps/web/src/components/v2/clubs-panel.tsx                (del) superseded (last task)
apps/web/content/help/directory/clubs-and-teams.md        (new) help page
apps/web/scripts? -> root scripts/smoke.ts                (mod) pro+free club paths
apps/web/e2e/clubs.spec.ts                                (mod) full journey
```

Task order: 1→2 backend base, 3–5 backend features, 6 admin, 7–10 UI, 11 help, 12 smoke/e2e, 13 cleanup+verify.

---

### Task 1: V292 migration + feature copy

**Files:**
- Create: `db/migration/deltas/V292__clubs_teams_redesign.sql`
- Modify: `apps/web/src/lib/feature-copy.ts` (add 4 keys)
- Test: applied migration verified via psql; feature-copy covered by existing admin-grid render (no blank "What it gates" cells)

**Interfaces:**
- Produces: columns `clubs.slug`, `clubs.home_ground`, `clubs.website`, `clubs.notes`; table `club_contacts`; entitlement rows `clubs.max`, `teams.max`, `teams.squad_max` (int), `clubs.hierarchy` flipped true for community/event_pass.

- [ ] **Step 1: Write the migration**

```sql
-- =============================================================================
-- W1 §4 (spec 2026-07-18-clubs-teams-redesign): club profile columns,
-- club_contacts, and admin-tunable caps. Additive only.
-- =============================================================================

alter table clubs add column if not exists slug        text;
alter table clubs add column if not exists home_ground text;
alter table clubs add column if not exists website     text;
alter table clubs add column if not exists notes       text;
create unique index if not exists clubs_slug_key on clubs(org_id, slug);

-- FA officer model (spec §4.2); user_id/claimed_at are W3 claim-rail hooks.
create table if not exists club_contacts (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organizations(id) on delete cascade,
  club_id    uuid not null references clubs(id) on delete cascade,
  role_key   text not null default 'secretary'
             check (role_key in ('secretary','chairman','treasurer','welfare','manager','other')),
  full_name  text not null,
  email      text,
  phone      text,
  is_primary boolean not null default false,
  user_id    uuid references users(id) on delete set null,
  invited_at timestamptz,
  claimed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists club_contacts_club_idx on club_contacts(club_id);
create index if not exists club_contacts_org_idx  on club_contacts(org_id);

-- RLS — migration-010 direct policy (same block V242 used for clubs).
alter table club_contacts enable row level security;
alter table club_contacts force  row level security;
drop policy if exists club_contacts_tenant on club_contacts;
create policy club_contacts_tenant on club_contacts for all to app_user
  using (org_id = current_org_id()) with check (org_id = current_org_id());
grant select, insert, update, delete on club_contacts to app_user;

-- Caps (spec §4.4). int null = unlimited. All grids/overrides admin-editable.
insert into plan_entitlements (plan_key, feature_key, bool_value, int_value) values
  ('community',  'clubs.max',       true, 2),
  ('event_pass', 'clubs.max',       true, 2),
  ('pro',        'clubs.max',       true, 20),
  ('pro_plus',   'clubs.max',       true, null),
  ('community',  'teams.max',       true, 2),
  ('event_pass', 'teams.max',       true, 2),
  ('pro',        'teams.max',       true, 40),
  ('pro_plus',   'teams.max',       true, null),
  ('community',  'teams.squad_max', true, 20),
  ('event_pass', 'teams.squad_max', true, 20),
  ('pro',        'teams.squad_max', true, null),
  ('pro_plus',   'teams.squad_max', true, null)
on conflict (plan_key, feature_key) do nothing;

-- Ladder step 3 opens to every plan; clubs.max is the brake (spec decision 3/7).
update plan_entitlements set bool_value = true
 where feature_key = 'clubs.hierarchy' and plan_key in ('community','event_pass');
insert into plan_entitlements (plan_key, feature_key, bool_value, int_value)
select p, 'clubs.hierarchy', true, null
from (values ('event_pass'), ('pro_plus')) as v(p)
on conflict (plan_key, feature_key) do nothing;
```

- [ ] **Step 2: Apply locally**

Run from repo root: `npm run db:apply`
Expected: Flyway reports `Successfully applied 1 migration` (V292).

- [ ] **Step 3: Verify**

Run: `psql "$DATABASE_URL" -c "set search_path=seazn_club; \d clubs" | grep -E "slug|home_ground|website|notes"` and `psql "$DATABASE_URL" -c "set search_path=seazn_club; select plan_key,int_value from plan_entitlements where feature_key='clubs.max' order by 1"`
Expected: 4 new columns; rows community=2, event_pass=2, pro=20, pro_plus=NULL.

- [ ] **Step 4: Feature copy**

In `apps/web/src/lib/feature-copy.ts`, next to the existing `"clubs.hierarchy"` entry add:

```ts
  "clubs.max": "You've reached your plan's club limit.",
  "teams.max": "You've reached your plan's team limit.",
  "teams.squad_max": "This squad has reached your plan's size limit.",
```

(and update the `"clubs.hierarchy"` line to: `"Club hierarchies (parent clubs, group-by-club) — your plan's limits apply."` since it is no longer Pro-only.)

- [ ] **Step 5: Commit**

```bash
git add db/migration/deltas/V292__clubs_teams_redesign.sql apps/web/src/lib/feature-copy.ts
git commit -m "feat(clubs): V292 profile columns, club_contacts, admin-tunable caps"
```

---

### Task 2: Cap enforcement in usecases (clubs.max / teams.max / teams.squad_max)

**Files:**
- Modify: `apps/web/src/server/usecases/clubs.ts` (createClub)
- Modify: `apps/web/src/server/usecases/teams.ts` (createTeam, setTeamSquad)
- Test: `apps/web/src/server/usecases/__tests__/club-caps.test.ts` (new)

**Interfaces:**
- Consumes: `withinLimit(orgId, key, wouldBe)` and `PaymentRequiredError` from `@/lib/entitlements` (existing).
- Produces: `createClub` throws `PaymentRequiredError("clubs.max")` at cap; `createTeam` throws `PaymentRequiredError("teams.max")`; `setTeamSquad` throws `PaymentRequiredError("teams.squad_max")`. Callers/routes unchanged.

- [ ] **Step 1: Write failing tests**

`club-caps.test.ts` — follow the existing DB-backed suite conventions in `__tests__` (describe.skipIf without DATABASE_URL, org fixture helpers used by `teams.test.ts` — copy its setup block verbatim). Test bodies:

```ts
import { describe, it, expect } from "vitest";
import { createClub } from "../clubs";
import { createTeam } from "../teams";
// + the same org/auth fixture imports and setup used at the top of teams.test.ts

describe.skipIf(!process.env.DATABASE_URL)("club/team caps", () => {
  it("blocks the 3rd club on community with PaymentRequiredError(clubs.max)", async () => {
    // fixture org is community by default
    await createClub(auth, { name: "Cap One" });
    await createClub(auth, { name: "Cap Two" });
    await expect(createClub(auth, { name: "Cap Three" })).rejects.toMatchObject({
      featureKey: "clubs.max",
    });
  });

  it("blocks the 3rd team org-wide on community with teams.max", async () => {
    const club = await createClub(auth2, { name: "T Cap" }); // fresh org fixture
    await createTeam(auth2, { name: "T1", club_id: club.id });
    await createTeam(auth2, { name: "T2" }); // standalone counts too
    await expect(createTeam(auth2, { name: "T3" })).rejects.toMatchObject({
      featureKey: "teams.max",
    });
  });
});
```

(Adjust `PaymentRequiredError` field assertion to the class's actual property — check `@/lib/errors`; if it stores the key as `feature_key` or on `extra`, assert that instead.)

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/web && npx vitest run src/server/usecases/__tests__/club-caps.test.ts`
Expected: FAIL — creates succeed past the cap (no error thrown) and `createTeam` signature mismatch (currently `(auth, clubId, input)`).

- [ ] **Step 3: Implement caps**

In `clubs.ts` `createClub`, after the `requireFeature` line:

```ts
export async function createClub(auth: AuthCtx, input: CreateClubInput): Promise<ClubRow> {
  await requireFeature(auth.orgId, "clubs.hierarchy");
  const [{ n }] = await withTenant(auth.orgId, (tx) =>
    tx<{ n: number }[]>`select count(*)::int as n from clubs`);
  const cap = await withinLimit(auth.orgId, "clubs.max", n + 1);
  if (!cap.ok) throw new PaymentRequiredError("clubs.max");
  // …existing insert unchanged
```

Import `withinLimit, PaymentRequiredError` from `@/lib/entitlements`.

In `teams.ts`, change `createTeam` to standalone-capable and capped (route update is Task 4; keep the old export name):

```ts
/** Create a team, optionally under a club (spec §5, ladder step 2/3). */
export async function createTeam(
  auth: AuthCtx,
  input: { name: string; short_name?: string | null; club_id?: string | null },
): Promise<TeamRow> {
  await requireFeature(auth.orgId, "clubs.hierarchy");
  return withTenant(auth.orgId, async (tx) => {
    if (input.club_id) {
      const [club] = await tx`select 1 from clubs where id = ${input.club_id}`;
      if (!club) throw new HttpError(404, "club not found");
    }
    const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from teams`;
    const cap = await withinLimit(auth.orgId, "teams.max", n + 1);
    if (!cap.ok) throw new PaymentRequiredError("teams.max");
    const [team] = await tx<TeamRow[]>`
      insert into teams (org_id, name, short_name, club_id)
      values (${auth.orgId}, ${input.name}, ${input.short_name ?? null}, ${input.club_id ?? null})
      returning id, name, short_name, club_id`;
    return team!;
  });
}
```

Update the one existing caller (`apps/web/src/app/api/v1/clubs/[id]/teams/route.ts`) to `createTeam(auth, { ...body, club_id: id })`.

In `setTeamSquad`, before the delete/insert block:

```ts
  const cap = await withinLimit(auth.orgId, "teams.squad_max", members.length);
  if (!cap.ok) throw new PaymentRequiredError("teams.squad_max");
```

- [ ] **Step 4: Run tests**

Run: `cd apps/web && npx vitest run src/server/usecases/__tests__/club-caps.test.ts src/server/usecases/__tests__/teams.test.ts`
Expected: PASS (including pre-existing teams tests after the signature change).

- [ ] **Step 5: Commit**

```bash
git add -A apps/web/src/server
git commit -m "feat(clubs): enforce clubs.max/teams.max/teams.squad_max via entitlements"
```

---

### Task 3: Club profile columns + slug in usecase/schemas/API

**Files:**
- Modify: `apps/web/src/server/usecases/clubs.ts` (COLS, create, patch, slug)
- Modify: `apps/web/src/server/api-v1/schemas.ts` (Club, CreateClub, PatchClub)
- Test: `apps/web/src/server/usecases/__tests__/club-slug.test.ts` (new)

**Interfaces:**
- Consumes: `slugify`, `uniqueSlug` from `@/server/usecases/slugs` (existing).
- Produces: `ClubRow` gains `slug, home_ground, website, notes` (all `string | null`); create auto-slugs; `patchClub` accepts the new fields and re-slugs on explicit `slug` set only (rename does NOT auto-change slug — public URLs stay stable; W2 adds history if we ever auto-rename).

- [ ] **Step 1: Failing tests**

```ts
describe.skipIf(!process.env.DATABASE_URL)("club slugs", () => {
  it("auto-generates a unique slug on create", async () => {
    const a = await createClub(auth, { name: "Riverside FC" });
    const b = await createClub(auth, { name: "Riverside FC 2" });
    expect(a.slug).toBe("riverside-fc");
    expect(b.slug).toBe("riverside-fc-2");
  });
  it("409s on explicit duplicate slug via patch", async () => {
    const a = await createClub(auth, { name: "Alpha" });
    const b = await createClub(auth, { name: "Beta" });
    await expect(patchClub(auth, b.id, { slug: a.slug! })).rejects.toMatchObject({ status: 409 });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/web && npx vitest run src/server/usecases/__tests__/club-slug.test.ts`
Expected: FAIL — `slug` undefined on ClubRow.

- [ ] **Step 3: Implement**

`clubs.ts`:

```ts
export interface ClubRow {
  id: string; name: string; short_name: string | null; logo_path: string | null;
  colors: unknown; external_ref: string | null;
  slug: string | null; home_ground: string | null; website: string | null; notes: string | null;
  created_at: string;
}
const COLS = ["id","name","short_name","logo_path","colors","external_ref",
  "slug","home_ground","website","notes","created_at"] as const;
```

In `createClub` insert, add slug (inside the existing withTenant, before insert):

```ts
      const slug = await uniqueSlug(slugify(input.name), async (s) => {
        const [hit] = await tx`select 1 from clubs where slug = ${s}`;
        return !!hit;
      });
```

and include `slug` plus the new optional profile fields in the insert column list (`home_ground`, `website`, `notes` from input, default null).

`CreateClubInput` gains `home_ground?/website?/notes?: string`. `PatchClubInput` gains `slug?/home_ground?/website?/notes?: string | null`.

In `patchClub`, before the update, when `patch.slug !== undefined && patch.slug !== null`:

```ts
    if (patch.slug !== undefined && patch.slug !== null) {
      patch.slug = slugify(patch.slug);
      const [dup] = await tx`select 1 from clubs where slug = ${patch.slug} and id <> ${id}`;
      if (dup) throw new HttpError(409, `slug '${patch.slug}' is taken — try '${patch.slug}-2'`);
    }
```

`schemas.ts` — extend `Club` output with `slug/home_ground/website/notes: z.string().nullable()`; `CreateClub` + `PatchClub` with the same optional fields (`website: z.string().url().max(200)`, `home_ground: z.string().min(1).max(200)`, `notes: z.string().max(2000)`, `slug: z.string().min(1).max(80)` — patch variants `.nullable().optional()`).

- [ ] **Step 4: Run tests + openapi**

Run: `cd apps/web && npx vitest run src/server/usecases/__tests__/club-slug.test.ts && cd .. && npm run openapi:gen`
Expected: PASS; openapi JSON regenerated with new fields.

- [ ] **Step 5: Commit**

```bash
git add -A apps/web/src openapi
git commit -m "feat(clubs): profile columns + auto slug on create, explicit slug patch"
```

---

### Task 4: club_contacts usecase + routes; standalone team + move/detach routes

**Files:**
- Modify: `apps/web/src/server/usecases/clubs.ts` (contacts CRUD, getClub includes contacts)
- Modify: `apps/web/src/server/usecases/teams.ts` (setTeamClub)
- Modify: `apps/web/src/server/api-v1/schemas.ts` (ClubContact, CreateClubContact, PatchClubContact, CreateTeamStandalone, PatchTeam)
- Create: `apps/web/src/app/api/v1/clubs/[id]/contacts/route.ts`, `.../contacts/[contactId]/route.ts`, `apps/web/src/app/api/v1/teams/[id]/route.ts`
- Modify: `apps/web/src/app/api/v1/teams/route.ts` (POST)
- Test: `apps/web/src/server/usecases/__tests__/club-contacts.test.ts` (new)

**Interfaces:**
- Produces:
  - `listClubContacts(auth, clubId): Promise<ClubContactRow[]>`
  - `createClubContact(auth, clubId, input): Promise<ClubContactRow>`
  - `patchClubContact(auth, clubId, contactId, patch): Promise<ClubContactRow>`
  - `deleteClubContact(auth, clubId, contactId): Promise<void>`
  - `ClubContactRow = { id, club_id, role_key, full_name, email, phone, is_primary, user_id, claimed_at, created_at }`
  - `setTeamClub(auth, teamId, clubId: string | null): Promise<TeamRow>`
  - `getClub` return gains `contacts: ClubContactRow[]`
  - HTTP: `GET/POST /api/v1/clubs/{id}/contacts`, `PATCH/DELETE /api/v1/clubs/{id}/contacts/{contactId}`, `POST /api/v1/teams` (standalone create, body `{name, short_name?, club_id?}`), `PATCH /api/v1/teams/{id}` (body `{club_id: string | null}`)

- [ ] **Step 1: Failing tests**

```ts
describe.skipIf(!process.env.DATABASE_URL)("club contacts", () => {
  it("CRUDs a contact and enforces single primary per club", async () => {
    const club = await createClub(auth, { name: "Contact FC" });
    const a = await createClubContact(auth, club.id, {
      role_key: "secretary", full_name: "Sam Sec", email: "sam@x.test", is_primary: true });
    const b = await createClubContact(auth, club.id, {
      role_key: "treasurer", full_name: "Tia Tre", is_primary: true });
    const list = await listClubContacts(auth, club.id);
    expect(list.filter((c) => c.is_primary)).toHaveLength(1);       // b won
    expect(list.find((c) => c.id === a.id)!.is_primary).toBe(false);
    await patchClubContact(auth, club.id, a.id, { phone: "0123" });
    await deleteClubContact(auth, club.id, b.id);
    expect(await listClubContacts(auth, club.id)).toHaveLength(1);
  });
  it("moves a team into and out of a club", async () => {
    const club = await createClub(auth, { name: "Move FC" });
    const team = await createTeam(auth, { name: "Movers" });
    expect((await setTeamClub(auth, team.id, club.id)).club_id).toBe(club.id);
    expect((await setTeamClub(auth, team.id, null)).club_id).toBeNull();
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `cd apps/web && npx vitest run src/server/usecases/__tests__/club-contacts.test.ts`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement usecases**

Append to `clubs.ts`:

```ts
// ---------------------------------------------------------------------------
// Club contacts (W1 §4.2/§5.2): FA officer model. is_primary is unique per
// club — setting it clears the previous primary in the same transaction.
// ---------------------------------------------------------------------------

export interface ClubContactRow {
  id: string; club_id: string; role_key: string; full_name: string;
  email: string | null; phone: string | null; is_primary: boolean;
  user_id: string | null; claimed_at: string | null; created_at: string;
}
const CONTACT_COLS = ["id","club_id","role_key","full_name","email","phone",
  "is_primary","user_id","claimed_at","created_at"] as const;

async function assertClub(tx: postgres.TransactionSql, clubId: string) {
  const [c] = await tx`select 1 from clubs where id = ${clubId}`;
  if (!c) throw new HttpError(404, "club not found");
}

export async function listClubContacts(auth: AuthCtx, clubId: string): Promise<ClubContactRow[]> {
  return withTenant(auth.orgId, async (tx) => {
    await assertClub(tx, clubId);
    return tx<ClubContactRow[]>`
      select ${tx(CONTACT_COLS)} from club_contacts
      where club_id = ${clubId}
      order by is_primary desc, role_key, full_name`;
  });
}

export interface ContactInput {
  role_key: string; full_name: string;
  email?: string | null; phone?: string | null; is_primary?: boolean;
}

export async function createClubContact(
  auth: AuthCtx, clubId: string, input: ContactInput,
): Promise<ClubContactRow> {
  return withTenant(auth.orgId, async (tx) => {
    await assertClub(tx, clubId);
    if (input.is_primary)
      await tx`update club_contacts set is_primary = false where club_id = ${clubId}`;
    const [row] = await tx<ClubContactRow[]>`
      insert into club_contacts (org_id, club_id, role_key, full_name, email, phone, is_primary)
      values (${auth.orgId}, ${clubId}, ${input.role_key}, ${input.full_name},
              ${input.email ?? null}, ${input.phone ?? null}, ${input.is_primary ?? false})
      returning ${tx(CONTACT_COLS)}`;
    return row!;
  });
}

export async function patchClubContact(
  auth: AuthCtx, clubId: string, contactId: string, patch: Partial<ContactInput>,
): Promise<ClubContactRow> {
  return withTenant(auth.orgId, async (tx) => {
    await assertClub(tx, clubId);
    if (patch.is_primary)
      await tx`update club_contacts set is_primary = false
               where club_id = ${clubId} and id <> ${contactId}`;
    const cols = Object.keys(patch);
    const [row] = cols.length === 0
      ? await tx<ClubContactRow[]>`
          select ${tx(CONTACT_COLS)} from club_contacts
          where id = ${contactId} and club_id = ${clubId}`
      : await tx<ClubContactRow[]>`
          update club_contacts set ${tx(patch as never, ...(cols as never[]))}
          where id = ${contactId} and club_id = ${clubId}
          returning ${tx(CONTACT_COLS)}`;
    if (!row) throw new HttpError(404, "contact not found");
    return row;
  });
}

export async function deleteClubContact(
  auth: AuthCtx, clubId: string, contactId: string,
): Promise<void> {
  return withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      delete from club_contacts where id = ${contactId} and club_id = ${clubId} returning id`;
    if (!row) throw new HttpError(404, "contact not found");
  });
}
```

Add `import type postgres from "postgres";` at top of `clubs.ts`. In `getClub`, add
`const contacts = await tx<ClubContactRow[]>\`select ${tx(CONTACT_COLS)} from club_contacts where club_id = ${id} order by is_primary desc, role_key, full_name\`;`
and return `{ ...club, teams, contacts }`.

`teams.ts`:

```ts
/** Attach/detach a team to a club (spec §5.2 Teams tab move action). */
export async function setTeamClub(
  auth: AuthCtx, teamId: string, clubId: string | null,
): Promise<TeamRow> {
  await requireFeature(auth.orgId, "clubs.hierarchy");
  return withTenant(auth.orgId, async (tx) => {
    if (clubId) {
      const [club] = await tx`select 1 from clubs where id = ${clubId}`;
      if (!club) throw new HttpError(404, "club not found");
    }
    const [team] = await tx<TeamRow[]>`
      update teams set club_id = ${clubId} where id = ${teamId}
      returning id, name, short_name, club_id`;
    if (!team) throw new HttpError(404, "team not found");
    return team;
  });
}
```

- [ ] **Step 4: Schemas + routes**

`schemas.ts` (near the Club block):

```ts
export const ClubContact = z.object({
  id: z.string(), club_id: z.string(), role_key: z.string(),
  full_name: z.string(), email: z.string().nullable(), phone: z.string().nullable(),
  is_primary: z.boolean(), user_id: z.string().nullable(),
  claimed_at: z.string().nullable(), created_at: z.string(),
});
export const CreateClubContact = z.object({
  role_key: z.enum(["secretary","chairman","treasurer","welfare","manager","other"]),
  full_name: z.string().min(1).max(200),
  email: z.string().email().max(200).nullable().optional(),
  phone: z.string().min(3).max(40).nullable().optional(),
  is_primary: z.boolean().optional(),
});
export type CreateClubContact = z.infer<typeof CreateClubContact>;
export const PatchClubContact = CreateClubContact.partial();
export type PatchClubContact = z.infer<typeof PatchClubContact>;

export const CreateTeamStandalone = z.object({
  name: z.string().min(1).max(200),
  short_name: z.string().min(1).max(40).optional(),
  club_id: z.string().uuid().optional(),
});
export type CreateTeamStandalone = z.infer<typeof CreateTeamStandalone>;
export const PatchTeam = z.object({ club_id: z.string().uuid().nullable() });
export type PatchTeam = z.infer<typeof PatchTeam>;
```

`clubs/[id]/contacts/route.ts`:

```ts
import { v1, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { CreateClubContact } from "@/server/api-v1/schemas";
import { listClubContacts, createClubContact } from "@/server/usecases/clubs";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "club", id, "read");
    return listClubContacts(auth, id);
  });
}

export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const body = await parseBody(req, CreateClubContact);
    const auth = await requireResourceAuth(req, "club", id, "write");
    return createClubContact(auth, id, body);
  });
}
```

`clubs/[id]/contacts/[contactId]/route.ts` mirrors it with `PatchClubContact` → `patchClubContact` (PATCH) and `deleteClubContact` (DELETE, returns `{ deleted: true }`).

`teams/route.ts` — add:

```ts
export async function POST(req: Request) {
  return v1(async () => {
    const body = await parseBody(req, CreateTeamStandalone);
    const auth = await requireAuth(req, "write");
    return createTeam(auth, body);
  });
}
```

`teams/[id]/route.ts` (new):

```ts
import { v1, parseBody } from "@/server/api-v1/http";
import { requireAuth } from "@/server/api-v1/auth";
import { PatchTeam } from "@/server/api-v1/schemas";
import { setTeamClub } from "@/server/usecases/teams";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const body = await parseBody(req, PatchTeam);
    const auth = await requireAuth(req, "write");
    return setTeamClub(auth, id, body.club_id);
  });
}
```

(If `requireResourceAuth` supports a `"team"` kind, prefer it — check `@/server/api-v1/auth`; otherwise `requireAuth(req,"write")` matches the existing squad/logo team routes.)

- [ ] **Step 5: Run tests + openapi + tsc**

Run: `cd apps/web && npx vitest run src/server/usecases/__tests__/club-contacts.test.ts && npx tsc --noEmit && cd .. && npm run openapi:gen`
Expected: PASS / clean / regenerated.

- [ ] **Step 6: Commit**

```bash
git add -A apps/web/src openapi
git commit -m "feat(clubs): contacts CRUD, standalone team create, team move/detach"
```

---

### Task 5: Import cap guards

**Files:**
- Modify: `apps/web/src/server/usecases/imports.ts` (commitImport)
- Test: extend `apps/web/src/server/usecases/__tests__/imports.test.ts` (or the closest existing import commit test file — locate with `grep -rln "commitImport" apps/web/src/server/usecases/__tests__/`)

**Interfaces:**
- Consumes: `ImportPlan.ops` — count `op.kind === "create_club"` / `"create_team"` entries (verify exact op kind strings in `@seazn/engine/import` types before writing the test).
- Produces: `commitImport` throws `PaymentRequiredError("clubs.max" | "teams.max")` when existing count + planned creates exceed the limit.

- [ ] **Step 1: Failing test** — in the existing import test suite, seed a community org at 2 clubs, build a plan creating 1 more club, expect `commitImport` to reject with `featureKey: "clubs.max"` (same assertion shape as Task 2).

- [ ] **Step 2: Verify failure** — `npx vitest run <that file>` → FAIL (commit succeeds today).

- [ ] **Step 3: Implement** — in `commitImport`, before `executePlan`, using the already-fetched tenant tx:

```ts
    const plannedClubs = ops.filter((o) => o.kind === "create_club").length;
    const plannedTeams = ops.filter((o) => o.kind === "create_team").length;
    if (plannedClubs > 0) {
      const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from clubs`;
      const cap = await withinLimit(auth.orgId, "clubs.max", n + plannedClubs);
      if (!cap.ok) throw new PaymentRequiredError("clubs.max");
    }
    if (plannedTeams > 0) {
      const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from teams`;
      const cap = await withinLimit(auth.orgId, "teams.max", n + plannedTeams);
      if (!cap.ok) throw new PaymentRequiredError("teams.max");
    }
```

(Adapt `ops` variable name / op kind strings to the actual engine types; `withinLimit` import already exists in imports.ts for `import.bulk`.)

- [ ] **Step 4: Run tests** — target file + full imports suite → PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(imports): respect clubs.max/teams.max at commit"`

---

### Task 6: Admin inline plan editing

**Files:**
- Create: `apps/web/src/app/api/admin/entitlements/route.ts`
- Create: `apps/web/src/components/admin/ent-cell-editor.tsx`
- Modify: `apps/web/src/app/admin/entitlements/page.tsx` (render editor per cell)
- Test: `apps/web/src/app/api/admin/entitlements/__tests__/route.test.ts` (new; follow the closest existing admin route test — locate with `grep -rln "requireSuperadmin" apps/web/src --include="*.test.ts"`)

**Interfaces:**
- Produces: `PATCH /api/admin/entitlements` body `{ plan_key, feature_key, bool_value?: boolean|null, int_value?: number|null }` → upserts the `plan_entitlements` row, logs staff action, busts the whole entitlement cache (`cacheDelPattern("ent:*")`).

- [ ] **Step 1: Failing test** — superadmin PATCH updates a row and non-admin gets 403 (mirror the existing admin settings route test shape):

```ts
it("updates a plan cell and busts cache", async () => {
  // as superadmin fixture
  const res = await PATCH(reqWithBody({ plan_key: "community", feature_key: "clubs.max", int_value: 5 }));
  expect(res.status).toBe(200);
  // row updated
});
```

- [ ] **Step 2: Verify failure** — route module doesn't exist → FAIL.

- [ ] **Step 3: Implement route**

```ts
import { z } from "zod";
import { requireSuperadmin, logStaffAction } from "@/lib/admin";
import { handler } from "@/lib/http";
import { sql } from "@/lib/db";
import { cacheDelPattern } from "@/lib/cache";

const Body = z.object({
  plan_key: z.enum(["community", "event_pass", "pro", "pro_plus"]),
  feature_key: z.string().min(1).max(100),
  bool_value: z.boolean().nullable().optional(),
  int_value: z.number().int().min(0).nullable().optional(),
});

/** PATCH /api/admin/entitlements — edit one plan cell (W1 §4.5).
 *  int null = unlimited. Busts every org's cached entitlements. */
export async function PATCH(req: Request) {
  return handler(async () => {
    await requireSuperadmin();
    const body = Body.parse(await req.json());
    const [row] = await sql`
      insert into plan_entitlements (plan_key, feature_key, bool_value, int_value)
      values (${body.plan_key}, ${body.feature_key},
              ${body.bool_value ?? null}, ${body.int_value ?? null})
      on conflict (plan_key, feature_key) do update
        set bool_value = excluded.bool_value, int_value = excluded.int_value
      returning plan_key, feature_key, bool_value, int_value`;
    await logStaffAction("entitlement.plan_edit", body);
    await cacheDelPattern("ent:*");
    return row;
  });
}
```

(Match `logStaffAction`'s actual signature from `@/lib/admin` — check its other call sites; adjust the args accordingly.)

- [ ] **Step 4: Cell editor client component**

`ent-cell-editor.tsx` — renders the current value; click → input (number with ∞ toggle for int-typed rows, checkbox for bool); on save `fetch("/api/admin/entitlements", { method: "PATCH", … })` then `router.refresh()`. Admin console styling (`.app-*` dark rails, like other admin controls). Props: `{ planKey, featureKey, type: "bool" | "int", boolValue, intValue }`. Complete component:

```tsx
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export function EntCellEditor(props: {
  planKey: string; featureKey: string; type: "bool" | "int";
  boolValue: boolean | null; intValue: number | null;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [val, setVal] = useState<string>(props.intValue === null ? "" : String(props.intValue));

  async function save(patch: { bool_value?: boolean | null; int_value?: number | null }) {
    setBusy(true);
    try {
      const res = await fetch("/api/admin/entitlements", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan_key: props.planKey, feature_key: props.featureKey, ...patch }),
      });
      if (res.ok) { setEditing(false); router.refresh(); }
    } finally { setBusy(false); }
  }

  if (props.type === "bool") {
    return (
      <button type="button" disabled={busy}
        className="text-slate-300 hover:text-white"
        title="Toggle"
        onClick={() => void save({ bool_value: !(props.boolValue === true), int_value: props.intValue })}>
        {props.boolValue === true ? "✓" : "—"}
      </button>
    );
  }
  if (!editing) {
    return (
      <button type="button" className="text-slate-300 hover:text-white" title="Edit limit"
        onClick={() => setEditing(true)}>
        {props.intValue === null ? "∞" : props.intValue}
      </button>
    );
  }
  return (
    <span className="inline-flex items-center gap-1">
      <input autoFocus value={val} onChange={(e) => setVal(e.target.value)}
        placeholder="∞"
        className="w-14 rounded border border-slate-600 bg-slate-900 px-1 py-0.5 text-xs text-white" />
      <button type="button" disabled={busy} className="text-xs text-lime-400"
        onClick={() => void save({ bool_value: props.boolValue,
          int_value: val.trim() === "" ? null : Number(val) })}>
        save
      </button>
      <button type="button" className="text-xs text-slate-500" onClick={() => setEditing(false)}>
        esc
      </button>
    </span>
  );
}
```

Wire into `admin/entitlements/page.tsx`: replace the plain `{f.cells.community}` cells with `<EntCellEditor planKey="community" featureKey={f.feature_key} type={f.type} …/>` — the page needs raw `bool_value/int_value` per plan, so extend `AdminEntFeature` in `@/lib/entitlement-admin` with `raw: Record<string, { bool_value: boolean | null; int_value: number | null }>` populated in `groupForAdmin`.

- [ ] **Step 5: Run tests + tsc** — route test PASS, `npx tsc --noEmit` clean.

- [ ] **Step 6: Commit** — `git commit -m "feat(admin): inline plan_entitlements editing with cache bust"`

---

### Task 7: Thin "Clubs & Teams" directory list

**Files:**
- Create: `apps/web/src/components/v2/clubs-teams-list.tsx`
- Modify: `apps/web/src/app/directory/page.tsx` (ClubsTab renders the list; label key)
- Modify: `apps/web/src/dictionaries/{en,fr,es,nl}/ui.json`
- Test: `apps/web/e2e/directory-labels.spec.ts` still passes; new assertions in Task 12's clubs.spec

**Interfaces:**
- Consumes: `listClubs` (now returns profile cols), `listTeams` (`TeamListRow` incl. `club_id`), existing `POST /api/v1/clubs`, `POST /api/v1/teams`.
- Produces: `<ClubsTeamsList clubs={…} teams={…} storageBase={…} canEdit={…}/>`; club rows link to `/clubs/{id}`; standalone team rows expand the squad editor from Task 10 (import it as `TeamSquadPanel`).

- [ ] **Step 1: Component**

```tsx
"use client";
// Thin Clubs & Teams register (W1 §5.1). Heavy editing lives on /clubs/[id];
// this list only searches, creates, and links. Standalone teams (ladder
// step 2) expand their squad inline — they have no hub page.
import { useMemo, useState } from "react";
import Link from "@/components/ui/console-link";
import { useRouter } from "next/navigation";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { UpgradeGate } from "@/components/upgrade-gate";
import { useMsg } from "@/components/i18n/dict-provider";
import { TeamSquadPanel } from "@/components/v2/club-hub/team-squad-editor";

export interface ClubListItem {
  id: string; name: string; short_name: string | null; logo_path: string | null;
  slug: string | null; team_count: number; primary_contact: string | null;
}
export interface TeamListItem {
  id: string; name: string; club_id: string | null; logo_path: string | null;
}

export function ClubsTeamsList({ clubs, teams, storageBase, canEdit }: {
  clubs: ClubListItem[]; teams: TeamListItem[]; storageBase: string; canEdit: boolean;
}) {
  const msg = useMsg();
  const router = useRouter();
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [paywall, setPaywall] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openTeam, setOpenTeam] = useState<string | null>(null);

  const fold = (s: string) => s.toLowerCase();
  const visClubs = useMemo(
    () => clubs.filter((c) => !q || fold(c.name).includes(fold(q)) || fold(c.short_name ?? "").includes(fold(q))),
    [clubs, q]);
  const standalone = useMemo(
    () => teams.filter((t) => t.club_id === null).filter((t) => !q || fold(t.name).includes(fold(q))),
    [teams, q]);

  async function create(kind: "club" | "team") {
    const name = window.prompt(msg(kind === "club" ? "clubs.list.newClubPrompt" : "clubs.list.newTeamPrompt"));
    if (!name?.trim()) return;
    setBusy(true); setError(null); setPaywall(null);
    try {
      if (kind === "club") {
        const club = await apiV1<{ id: string }>("/api/v1/clubs", { method: "POST", json: { name: name.trim() } });
        router.push(`/clubs/${club.id}`);
      } else {
        await apiV1("/api/v1/teams", { method: "POST", json: { name: name.trim() } });
        router.refresh();
      }
    } catch (err) {
      if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED")
        setPaywall(String(err.extra.feature_key ?? ""));
      else setError(err instanceof Error ? err.message : "Failed");
    } finally { setBusy(false); }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <input className="input w-full sm:w-64" placeholder={msg("clubs.list.search")}
          value={q} onChange={(e) => setQ(e.target.value)} aria-label={msg("clubs.list.search")} />
        <div className="flex-1" />
        {canEdit && (
          <>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void create("club")}>
              {msg("clubs.list.newClub")}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => void create("team")}>
              {msg("clubs.list.newTeam")}
            </button>
            <Link href="/import" className="btn btn-ghost text-sm">{msg("directory.clubs.import")}</Link>
          </>
        )}
      </div>

      {paywall && <UpgradeGate feature={paywall} />}
      {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}

      <section className="card scroll-x scroll-x-fade">
        <table className="table">
          <thead><tr>
            <th className="px-4 py-2 text-left">{msg("clubs.col.club")}</th>
            <th className="px-4 py-2 text-left">{msg("clubs.list.col.teams")}</th>
            <th className="px-4 py-2 text-left">{msg("clubs.list.col.contact")}</th>
          </tr></thead>
          <tbody>
            {visClubs.length === 0 && standalone.length === 0 && (
              <tr><td colSpan={3} className="px-4 py-6 text-center text-sm text-slate-400">
                {msg("clubs.empty")}
              </td></tr>
            )}
            {visClubs.map((c) => (
              <tr key={c.id} className="border-t border-slate-100">
                <td className="px-4 py-2">
                  <Link href={`/clubs/${c.id}`} className="flex items-center gap-2 font-medium text-slate-900 hover:underline">
                    {c.logo_path ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={`${storageBase}/${c.logo_path}`} alt="" aria-hidden className="h-6 w-6 rounded object-contain" />
                    ) : <span className="inline-block h-6 w-6 rounded bg-slate-100" aria-hidden />}
                    {c.name}
                    {c.short_name && <span className="text-xs text-slate-400">({c.short_name})</span>}
                  </Link>
                </td>
                <td className="px-4 py-2 text-sm text-slate-500">{c.team_count}</td>
                <td className="px-4 py-2 text-sm text-slate-500">{c.primary_contact ?? "—"}</td>
              </tr>
            ))}
            {standalone.map((t) => (
              <tr key={t.id} className="border-t border-slate-100">
                <td className="px-4 py-2" colSpan={3}>
                  <button type="button" className="flex items-center gap-2 text-left font-medium text-slate-800 hover:underline"
                    onClick={() => setOpenTeam(openTeam === t.id ? null : t.id)} aria-expanded={openTeam === t.id}>
                    {t.logo_path ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={`${storageBase}/${t.logo_path}`} alt="" aria-hidden className="h-6 w-6 rounded object-contain" />
                    ) : <span className="inline-block h-6 w-6 rounded bg-slate-100" aria-hidden />}
                    {t.name}
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                      {msg("clubs.list.standalone")}
                    </span>
                  </button>
                  {openTeam === t.id && (
                    <div className="mt-2"><TeamSquadPanel teamId={t.id} canEdit={canEdit} /></div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
```

- [ ] **Step 2: Server data** — in `directory/page.tsx` `ClubsTab`, fetch `listClubs` + `listTeams` and derive `team_count` / `primary_contact`. Extend `listClubs` in `clubs.ts` with a lateral count + primary contact name:

```ts
export async function listClubsWithMeta(auth: AuthCtx) {
  return withTenant(auth.orgId, (tx) => tx<
    (ClubRow & { team_count: number; primary_contact: string | null })[]>`
    select ${tx(COLS.map((c) => `c.${c}` as never))},
           (select count(*)::int from teams t where t.club_id = c.id) as team_count,
           (select cc.full_name from club_contacts cc
             where cc.club_id = c.id and cc.is_primary limit 1) as primary_contact
    from clubs c order by c.name, c.id`);
}
```

(If the `tx(COLS.map(...))` column-qualification trick fights postgres.js, list columns explicitly `c.id, c.name, …` — verify against how other usecases qualify columns.)

Replace `ClubsPanel` usage with `ClubsTeamsList`; delete the old import.

- [ ] **Step 3: i18n keys** — add to all four `ui.json` files (translate for fr/es/nl):

```json
"directory.tab.clubs": "Clubs & Teams",
"clubs.list.search": "Search clubs and teams…",
"clubs.list.newClub": "New club",
"clubs.list.newTeam": "New team",
"clubs.list.newClubPrompt": "Club name",
"clubs.list.newTeamPrompt": "Team name",
"clubs.list.standalone": "standalone",
"clubs.list.col.teams": "Teams",
"clubs.list.col.contact": "Contact"
```

(`directory.tab.clubs` already exists — change its value in each locale.)

- [ ] **Step 4: Run** — `cd apps/web && npx tsc --noEmit && npx vitest run src/__tests__ -t i18n` (parity test name — run the full unit suite if unsure).
Expected: clean/PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(directory): thin Clubs & Teams list linking to club hub"`

---

### Task 8: Club hub page shell + Overview tab

**Files:**
- Create: `apps/web/src/app/clubs/[id]/page.tsx`
- Create: `apps/web/src/components/v2/club-hub/overview-tab.tsx`
- Modify: dictionaries ×4
- Test: e2e in Task 12; `npx tsc --noEmit` here

**Interfaces:**
- Consumes: `getClub` (returns club + teams + contacts after Task 4), `PATCH /api/v1/clubs/{id}`, contacts routes from Task 4.
- Produces: page at `/clubs/[id]?tab=overview|teams|entries`; `<OverviewTab club contacts canEdit storageBase/>`.

- [ ] **Step 1: Page shell** (mirror `directory/page.tsx` conventions — `requirePageAuth`, `DictProvider`, tab nav):

```tsx
export const dynamic = "force-dynamic";
// Club hub (W1 §5.2): Overview / Teams / Entries. The Directory list links
// here; the static /clubs redirect (→ /directory?tab=clubs) still wins for
// the bare path.
import { notFound } from "next/navigation";
import Link from "@/components/ui/console-link";
import { BackLink } from "@/components/back-link";
import { Nav } from "@/components/nav";
import { requirePageAuth } from "@/server/page-auth";
import { getClub } from "@/server/usecases/clubs";
import { HttpError } from "@/lib/errors";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t } from "@/lib/i18n";
import { DictProvider } from "@/components/i18n/dict-provider";
import { OverviewTab } from "@/components/v2/club-hub/overview-tab";
import { TeamsTab } from "@/components/v2/club-hub/teams-tab";
import { EntriesTab } from "@/components/v2/club-hub/entries-tab";

const TABS = ["overview", "teams", "entries"] as const;
type Tab = (typeof TABS)[number];

export default async function ClubHubPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const [{ id }, { tab: rawTab }] = await Promise.all([params, searchParams]);
  const tab: Tab = (TABS as readonly string[]).includes(rawTab ?? "") ? (rawTab as Tab) : "overview";
  const { auth, canEdit } = await requirePageAuth();
  const locale = await resolveLocale();
  const ui = await getDictionary(locale, "ui");
  const club = await getClub(auth, id).catch((err) => {
    if (err instanceof HttpError && err.status === 404) notFound();
    throw err;
  });
  const storageBase = `${process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""}/storage/v1/object/public/assets`;

  return (
    <DictProvider dict={ui} locale={locale}>
      <Nav />
      <main className="mx-auto max-w-4xl px-4 py-8">
        <BackLink href="/directory?tab=clubs" label={t(ui, "clubs.hub.back")} />
        <div className="mb-6 flex items-center gap-3">
          {club.logo_path ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={`${storageBase}/${club.logo_path}`} alt="" aria-hidden className="h-12 w-12 rounded object-contain" />
          ) : null}
          <div>
            <p className="app-eyebrow mb-1">{t(ui, "clubs.hub.eyebrow")}</p>
            <h1 className="page-title">{club.name}</h1>
          </div>
        </div>
        <nav className="mb-6 flex gap-1 border-b border-slate-200">
          {TABS.map((k) => (
            <Link key={k} href={`/clubs/${id}?tab=${k}`}
              className={`border-b-2 px-4 py-2 text-sm font-medium transition ${
                tab === k ? "border-purple-600 text-purple-700"
                          : "border-transparent text-slate-500 hover:text-slate-800"}`}>
              {t(ui, `clubs.hub.tab.${k}`)}
            </Link>
          ))}
        </nav>
        {tab === "overview" && <OverviewTab club={club} canEdit={canEdit} storageBase={storageBase} />}
        {tab === "teams" && <TeamsTab club={club} canEdit={canEdit} storageBase={storageBase} />}
        {tab === "entries" && <EntriesTab club={club} />}
      </main>
    </DictProvider>
  );
}
```

(TeamsTab/EntriesTab are Task 9/10 — create empty placeholder exports in this task so tsc passes: `export function TeamsTab(){return null}` is NOT allowed as a final state, but as an intra-task scaffold committed only when Task 9/10 replace them in the same PR it's fine. To keep tasks independent: in THIS task render Overview only and hide the other two tab links behind `TABS` slice; Task 9/10 extend `TABS`. Choose this variant.)

- [ ] **Step 2: OverviewTab component** — profile form + colours + contacts:

```tsx
"use client";
// Overview (W1 §5.2): profile edit, kit colours (flat record keys —
// home_primary/home_secondary/away_primary/away_secondary), contacts CRUD,
// danger zone. patchClub finally gets a UI.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { UpgradeGate } from "@/components/upgrade-gate";
import { useConfirm } from "@/components/ui/confirm-provider";
import { useMsg } from "@/components/i18n/dict-provider";

interface Contact {
  id: string; role_key: string; full_name: string; email: string | null;
  phone: string | null; is_primary: boolean;
}
interface ClubFull {
  id: string; name: string; short_name: string | null; slug: string | null;
  logo_path: string | null; colors: Record<string, string> | null;
  external_ref: string | null; home_ground: string | null; website: string | null;
  notes: string | null; contacts: Contact[];
}
const ROLES = ["secretary","chairman","treasurer","welfare","manager","other"] as const;
const COLOR_KEYS = ["home_primary","home_secondary","away_primary","away_secondary"] as const;

export function OverviewTab({ club, canEdit, storageBase }: {
  club: ClubFull; canEdit: boolean; storageBase: string;
}) {
  const msg = useMsg();
  const router = useRouter();
  const confirmDialog = useConfirm();
  const [error, setError] = useState<string | null>(null);
  const [paywall, setPaywall] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    name: club.name, short_name: club.short_name ?? "", slug: club.slug ?? "",
    home_ground: club.home_ground ?? "", website: club.website ?? "", notes: club.notes ?? "",
  });
  const [colors, setColors] = useState<Record<string, string>>(club.colors ?? {});
  const [contact, setContact] = useState({ role_key: "secretary", full_name: "", email: "", phone: "" });

  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setError(null); setPaywall(null);
    try { await fn(); router.refresh(); }
    catch (err) {
      if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED")
        setPaywall(String(err.extra.feature_key ?? ""));
      else setError(err instanceof Error ? err.message : "Failed");
    } finally { setBusy(false); }
  }

  const savePatch = () => run(() => apiV1(`/api/v1/clubs/${club.id}`, {
    method: "PATCH",
    json: {
      name: form.name.trim(),
      short_name: form.short_name.trim() || null,
      slug: form.slug.trim() || null,
      home_ground: form.home_ground.trim() || null,
      website: form.website.trim() || null,
      notes: form.notes.trim() || null,
      colors: Object.keys(colors).length ? colors : null,
    },
  }));

  return (
    <div className="space-y-5">
      {paywall && <UpgradeGate feature={paywall} />}
      {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}

      <section className="card grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
        <label className="label flex flex-col gap-1">{msg("clubs.form.name")}
          <input className="input" disabled={!canEdit} value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label className="label flex flex-col gap-1">{msg("clubs.form.short")}
          <input className="input" disabled={!canEdit} value={form.short_name}
            onChange={(e) => setForm({ ...form, short_name: e.target.value })} /></label>
        <label className="label flex flex-col gap-1">{msg("clubs.overview.slug")}
          <input className="input" disabled={!canEdit} value={form.slug}
            onChange={(e) => setForm({ ...form, slug: e.target.value })} /></label>
        <label className="label flex flex-col gap-1">{msg("clubs.overview.homeGround")}
          <input className="input" disabled={!canEdit} value={form.home_ground}
            onChange={(e) => setForm({ ...form, home_ground: e.target.value })} /></label>
        <label className="label flex flex-col gap-1">{msg("clubs.overview.website")}
          <input className="input" type="url" disabled={!canEdit} value={form.website}
            onChange={(e) => setForm({ ...form, website: e.target.value })} /></label>
        <label className="label flex flex-col gap-1 sm:col-span-2">{msg("clubs.overview.notes")}
          <textarea className="input" rows={3} disabled={!canEdit} value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label>
        <div className="sm:col-span-2 flex flex-wrap items-end gap-4">
          {COLOR_KEYS.map((k) => (
            <label key={k} className="label flex flex-col gap-1 text-xs">
              {msg(`clubs.overview.color.${k}`)}
              <input type="color" disabled={!canEdit} value={colors[k] ?? "#0f172a"}
                aria-label={msg(`clubs.overview.color.${k}`)}
                onChange={(e) => setColors({ ...colors, [k]: e.target.value })}
                className="h-9 w-14 cursor-pointer rounded border border-slate-200" />
            </label>
          ))}
          {canEdit && (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void savePatch()}>
              {msg("clubs.overview.save")}
            </button>
          )}
        </div>
      </section>

      <section className="card space-y-3 p-4" aria-label={msg("clubs.overview.contactsTitle")}>
        <h2 className="text-sm font-semibold text-slate-900">{msg("clubs.overview.contactsTitle")}</h2>
        {club.contacts.length === 0 && (
          <p className="text-sm text-slate-400">{msg("clubs.overview.noContacts")}</p>
        )}
        <ul className="space-y-1 text-sm">
          {club.contacts.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                {msg(`clubs.contact.role.${c.role_key}`)}
              </span>
              <span className="font-medium text-slate-800">{c.full_name}</span>
              {c.is_primary && <span className="text-xs text-purple-600">{msg("clubs.contact.primary")}</span>}
              <span className="text-slate-500">{c.email ?? ""}</span>
              <span className="text-slate-500">{c.phone ?? ""}</span>
              {canEdit && (
                <>
                  {!c.is_primary && (
                    <button type="button" className="text-xs text-purple-600 hover:underline" disabled={busy}
                      onClick={() => void run(() => apiV1(`/api/v1/clubs/${club.id}/contacts/${c.id}`,
                        { method: "PATCH", json: { is_primary: true } }))}>
                      {msg("clubs.contact.makePrimary")}
                    </button>
                  )}
                  <button type="button" className="text-xs text-red-600 hover:underline" disabled={busy}
                    onClick={() => void run(() => apiV1(`/api/v1/clubs/${club.id}/contacts/${c.id}`,
                      { method: "DELETE" }))}>
                    {msg("clubs.contact.remove")}
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
        {canEdit && (
          <form className="flex flex-wrap items-end gap-2 border-t border-slate-200 pt-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!contact.full_name.trim()) return;
              void run(async () => {
                await apiV1(`/api/v1/clubs/${club.id}/contacts`, { method: "POST", json: {
                  role_key: contact.role_key, full_name: contact.full_name.trim(),
                  email: contact.email.trim() || null, phone: contact.phone.trim() || null,
                  is_primary: club.contacts.length === 0,
                }});
                setContact({ role_key: "secretary", full_name: "", email: "", phone: "" });
              });
            }}>
            <label className="label flex flex-col gap-1 text-xs">{msg("clubs.contact.role")}
              <select className="input" value={contact.role_key}
                onChange={(e) => setContact({ ...contact, role_key: e.target.value })}>
                {ROLES.map((r) => <option key={r} value={r}>{msg(`clubs.contact.role.${r}`)}</option>)}
              </select></label>
            <label className="label flex flex-col gap-1 text-xs">{msg("clubs.contact.name")}
              <input className="input" value={contact.full_name}
                onChange={(e) => setContact({ ...contact, full_name: e.target.value })} required /></label>
            <label className="label flex flex-col gap-1 text-xs">{msg("clubs.contact.email")}
              <input className="input" type="email" value={contact.email}
                onChange={(e) => setContact({ ...contact, email: e.target.value })} /></label>
            <label className="label flex flex-col gap-1 text-xs">{msg("clubs.contact.phone")}
              <input className="input" value={contact.phone}
                onChange={(e) => setContact({ ...contact, phone: e.target.value })} /></label>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {msg("clubs.contact.add")}
            </button>
          </form>
        )}
      </section>

      {canEdit && (
        <section className="card border-red-200 p-4">
          <h2 className="text-sm font-semibold text-red-700">{msg("clubs.overview.danger")}</h2>
          <p className="mb-2 text-xs text-slate-500">{msg("clubs.overview.deleteHint")}</p>
          <button type="button" className="btn text-red-600" disabled={busy}
            onClick={async () => {
              const ok = await confirmDialog({
                title: msg("confirm.deleteClub.title"),
                body: msg("confirm.deleteClub.body", { name: club.name }),
                confirmLabel: msg("confirm.deleteClub.label"),
                tone: "danger",
              });
              if (!ok) return;
              await run(() => apiV1(`/api/v1/clubs/${club.id}`, { method: "DELETE" }));
              window.location.href = "/directory?tab=clubs";
            }}>
            {msg("clubs.delete")}
          </button>
        </section>
      )}
    </div>
  );
}
```

- [ ] **Step 3: i18n ×4** — keys used above: `clubs.hub.back`, `clubs.hub.eyebrow`, `clubs.hub.tab.overview|teams|entries`, `clubs.overview.slug|homeGround|website|notes|save|contactsTitle|noContacts|danger|deleteHint`, `clubs.overview.color.home_primary|home_secondary|away_primary|away_secondary`, `clubs.contact.role|name|email|phone|add|primary|makePrimary|remove`, `clubs.contact.role.secretary|chairman|treasurer|welfare|manager|other`. English values obvious from context (e.g. "Home ground", "Kit colours — home primary"); translate ×3.

- [ ] **Step 4: Run** — `npx tsc --noEmit` + i18n parity test.
Expected: clean.

- [ ] **Step 5: Commit** — `git commit -m "feat(clubs): hub page shell + Overview tab (profile, colours, contacts, danger zone)"`

---

### Task 9: Hub Teams tab (moved editor + logo grid + quick-add)

**Files:**
- Create: `apps/web/src/components/v2/club-hub/team-squad-editor.tsx` (moved `TeamSquadEditor` + new `TeamSquadPanel` wrapper + quick-add)
- Create: `apps/web/src/components/v2/club-hub/teams-tab.tsx` (team rows, add team, move/detach, per-team badge, bulk `LogoGrid` moved here)
- Modify: `apps/web/src/app/clubs/[id]/page.tsx` (enable tab)
- Modify: dictionaries ×4
- Test: `apps/web/src/components/v2/club-hub/__tests__/quick-add.test.ts` (pure helper) + e2e Task 12

**Interfaces:**
- Consumes: existing `GET/PUT /api/v1/teams/{id}/squad`, `POST /api/v1/persons` (`CreatePerson` — `{full_name}` minimum), `POST /api/v1/teams/{id}/logo`, `PATCH /api/v1/teams/{id}` (Task 4), `POST /api/v1/clubs/{id}/teams`, `/api/v1/clubs/logos` bulk endpoint.
- Produces: `<TeamsTab club canEdit storageBase/>`; `<TeamSquadPanel teamId canEdit/>` (self-fetching wrapper used by the thin list); exported pure helper `foldSuggest(name: string, persons: {id,full_name}[]): {id,full_name} | null` (case/diacritic-folded exact match) used for the dedupe warning.

- [ ] **Step 1: Failing test for foldSuggest**

```ts
import { describe, it, expect } from "vitest";
import { foldSuggest } from "../team-squad-editor";

describe("foldSuggest", () => {
  const persons = [{ id: "1", full_name: "José Álvarez" }, { id: "2", full_name: "Amy Lee" }];
  it("matches ignoring case and diacritics", () => {
    expect(foldSuggest("jose alvarez", persons)?.id).toBe("1");
  });
  it("returns null on no match", () => {
    expect(foldSuggest("New Person", persons)).toBeNull();
  });
});
```

- [ ] **Step 2: Verify failure** — module doesn't exist → FAIL.

- [ ] **Step 3: Implement `team-squad-editor.tsx`**

Move `TeamSquadEditor` from `clubs-panel.tsx` verbatim, then: add at top

```ts
export function foldSuggest(
  name: string, persons: { id: string; full_name: string }[],
): { id: string; full_name: string } | null {
  const fold = (s: string) =>
    s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
  const target = fold(name);
  return persons.find((p) => fold(p.full_name) === target) ?? null;
}
```

In the editor's candidates block, when `filter` is non-empty and `candidates.length === 0`, render quick-add (W1 §5.2 — kills the "add player first" ordering constraint):

```tsx
{canEdit && filter.trim() && candidates.length === 0 && (
  <QuickAdd
    name={filter.trim()}
    persons={persons}
    busy={busy}
    onAdded={(p) => {
      setMembers((prev) => [...prev, { person_id: p.id, full_name: p.full_name,
        squad_number: null, default_position_key: null, is_captain: false, roles: [] }]);
      setDirty(true);
      setFilter("");
    }}
    onError={onError}
  />
)}
```

```tsx
function QuickAdd({ name, persons, busy, onAdded, onError }: {
  name: string; persons: { id: string; full_name: string }[];
  busy: boolean; onAdded: (p: { id: string; full_name: string }) => void;
  onError: (msg: string) => void;
}) {
  const msg = useMsg();
  const [saving, setSaving] = useState(false);
  const dupe = foldSuggest(name, persons);
  return (
    <span className="flex flex-wrap items-center gap-2">
      {dupe && (
        <button type="button" className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-amber-700"
          onClick={() => onAdded(dupe)}>
          {msg("clubs.squad.didYouMean", { name: dupe.full_name })}
        </button>
      )}
      <button type="button" disabled={busy || saving}
        className="rounded-full border border-purple-300 px-2 py-0.5 text-purple-700 hover:bg-purple-50"
        onClick={() => {
          setSaving(true);
          void apiV1<{ id: string; full_name: string }>("/api/v1/persons", {
            method: "POST", json: { full_name: name },
          })
            .then((p) => onAdded({ id: p.id, full_name: p.full_name }))
            .catch((err) => onError(err instanceof Error ? err.message : "Failed"))
            .finally(() => setSaving(false));
        }}>
        {saving ? msg("clubs.squad.adding") : msg("clubs.squad.quickAdd", { name })}
      </button>
    </span>
  );
}
```

(Import `apiV1` — the moved file needs the same imports the old panel had. Verify the exact `POST /api/v1/persons` response shape — unwrap per `apiV1`'s envelope handling — and `CreatePerson`'s required fields at `schemas.ts:271`; if `consent` or other fields are required, send their minimal defaults exactly as `PersonsPanel`'s create form does.)

Also export the self-fetching wrapper for the thin list and teams tab:

```tsx
export function TeamSquadPanel({ teamId, canEdit }: { teamId: string; canEdit: boolean }) {
  const msg = useMsg();
  const [squad, setSquad] = useState<SquadMember[] | null>(null);
  const [persons, setPersons] = useState<{ id: string; full_name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [paywall, setPaywall] = useState<string | null>(null);
  useEffect(() => {
    void apiV1<{ members: SquadMember[] }>(`/api/v1/teams/${teamId}/squad`)
      .then((r) => setSquad(r.members)).catch(() => setSquad([]));
    // same paginated persons loader the old panel used (copy the loop verbatim)
  }, [teamId]);
  if (squad === null) return <p className="text-xs text-slate-400">{msg("clubs.team.loadingSquad")}</p>;
  return (
    <>
      {paywall && <UpgradeGate feature={paywall} />}
      {error && <p className="text-xs text-red-600">{error}</p>}
      <TeamSquadEditor teamId={teamId} initial={squad} persons={persons} canEdit={canEdit}
        onSaved={setSquad} onError={(m) => setError(m || null)} onPaywall={setPaywall} />
    </>
  );
}
```

- [ ] **Step 4: `teams-tab.tsx`** — move `TeamDetailRow`, `AddTeamForm`, `LogoGrid` from `clubs-panel.tsx` into this file (imports adjusted, `TeamSquadEditor` imported from its new module). Add per-team actions row: move/detach via `PATCH /api/v1/teams/{id}` with `{club_id: null}` (detach, confirm dialog) — and in `AddTeamForm` keep posting to `/api/v1/clubs/{clubId}/teams`. Render order: `AddTeamForm`, `LogoGrid` (canEdit), team list with `TeamSquadPanel` inside each expanded row. Props `{ club: { id, name, teams: … }, canEdit, storageBase }` matching the page's `getClub` payload.

- [ ] **Step 5: Enable tab in page** — extend the page's `TABS` to include `"teams"`, render `<TeamsTab …/>`.

- [ ] **Step 6: i18n ×4** — `clubs.squad.quickAdd` ("+ Add '{name}' as new player"), `clubs.squad.adding`, `clubs.squad.didYouMean` ("Did you mean {name}?"), `clubs.team.detach`, `clubs.team.detachConfirm`.

- [ ] **Step 7: Run** — `npx vitest run src/components/v2/club-hub/__tests__/quick-add.test.ts && npx tsc --noEmit`
Expected: PASS/clean. (vitest is node-env — the pure helper test needs no jsdom; keep component logic out of the test.)

- [ ] **Step 8: Commit** — `git commit -m "feat(clubs): hub Teams tab — moved squad editor, logo grid, player quick-add, detach"`

---

### Task 10: Hub Entries tab

**Files:**
- Create: `apps/web/src/components/v2/club-hub/entries-tab.tsx`
- Modify: `apps/web/src/app/clubs/[id]/page.tsx` (enable tab)
- Modify: dictionaries ×4

**Interfaces:**
- Consumes: `getClub` payload — `teams[].entries[] = { division_id, entrant_id, division_name, competition_id }`.
- Produces: read-only grid; W3 approval inbox and W4 wizard mount here later.

- [ ] **Step 1: Component**

```tsx
// Entries (W1 §5.2): where this club's teams are entered. Read-only in W1 —
// the W4 enroll wizard and W3 approval inbox land on this tab.
import Link from "@/components/ui/console-link";
import { useMsg } from "@/components/i18n/dict-provider";

export function EntriesTab({ club }: {
  club: { teams: { id: string; name: string;
    entries: { division_id: string; division_name: string }[] }[] };
}) {
  const msg = useMsg();
  const entered = club.teams.filter((t) => t.entries.length > 0);
  return (
    <section className="card p-4">
      {entered.length === 0 ? (
        <p className="text-sm text-slate-400">{msg("clubs.entries.empty")}</p>
      ) : (
        <table className="table">
          <thead><tr>
            <th className="px-4 py-2 text-left">{msg("clubs.entries.team")}</th>
            <th className="px-4 py-2 text-left">{msg("clubs.entries.divisions")}</th>
          </tr></thead>
          <tbody>
            {entered.map((t) => (
              <tr key={t.id} className="border-t border-slate-100">
                <td className="px-4 py-2 font-medium text-slate-800">{t.name}</td>
                <td className="px-4 py-2">
                  <span className="flex flex-wrap gap-1">
                    {t.entries.map((e) => (
                      <Link key={e.division_id} href={`/divisions/${e.division_id}`}
                        className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600 hover:bg-purple-50">
                        {e.division_name}
                      </Link>
                    ))}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
```

("use client" only if `useMsg` requires it — it does; add the directive. Verify the division console URL pattern — if the app uses slug routes `/o/[org]/c/[comp]/d/[div]`, link via the entry's ids the way `entrants-panel.tsx` links divisions; copy that idiom.)

- [ ] **Step 2: Enable tab; i18n ×4** — `clubs.entries.empty|team|divisions`.

- [ ] **Step 3: Run** — `npx tsc --noEmit` + parity test. Expected: clean.

- [ ] **Step 4: Commit** — `git commit -m "feat(clubs): hub Entries tab (read grid)"`

---

### Task 11: Delete old panel + help page

**Files:**
- Delete: `apps/web/src/components/v2/clubs-panel.tsx`
- Modify: `apps/web/src/app/directory/page.tsx` (drop dead import if any remain)
- Create: `apps/web/content/help/directory/clubs-and-teams.md`
- Modify: whatever `src/server/help-content.ts` needs for a new section/slug (mirror how `players/…` pages are registered; run its test)

**Interfaces:** none new.

- [ ] **Step 1: Delete `clubs-panel.tsx`**; `grep -rn "clubs-panel" apps/web/src` must return nothing.

- [ ] **Step 2: Help page** — front-matter/shape copied from an existing help md (open `content/help/players/claim-your-profile.md` for the exact header fields). Content (English, ~30 lines):

```markdown
# Clubs & Teams

The Directory's Clubs & Teams tab is your org-wide register of clubs and
persistent teams.

## The ladder
- **Entrant only** — add entrants straight into a division; no team needed.
- **Standalone team** — a persistent squad you can re-enroll each season.
- **Club** — group several teams under one badge, kit colours and contacts.

## The club page
Open any club to edit its profile (name, short name, public slug, home
ground, website, notes), kit colours, badge, and contacts (secretary,
chairman, treasurer, welfare officer, manager). The Teams tab manages each
team's squad — type a name and add a brand-new player without leaving the
page. The Entries tab shows where every team is entered.

## Limits
Your plan sets how many clubs and teams you can create and how large a
squad can be. Upgrade to raise the limits.
```

- [ ] **Step 3: Run help test** — `npx vitest run src/server/__tests__/help-content.test.ts`
Expected: PASS (fix registry/slug listing if it fails — the test names the missing piece).

- [ ] **Step 4: Full unit + tsc** — `npx tsc --noEmit && npm run test:unit`. Expected: clean/PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(clubs): retire old clubs panel; help page for Clubs & Teams"`

---

### Task 12: Smoke + e2e journey

**Files:**
- Modify: `scripts/smoke.ts` (repo root)
- Modify: `apps/web/e2e/clubs.spec.ts`

**Interfaces:**
- Consumes: everything above via HTTP.

- [ ] **Step 1: Smoke** — extend `scripts/smoke.ts` following its existing section idioms (login as pro + community fixtures, `assert` helpers). Add, in the pro path: create club → PATCH profile (home_ground) → add contact → create standalone team → PATCH team into club → squad PUT with a quick-created person. In the free path: create 2 clubs then expect the 3rd to 402 with `feature_key: "clubs.max"`. **Order caution:** smoke tests share state — append after the latest section and re-run the whole script.

Run: `npm run smoke` (or the script's documented invocation — match how CI calls it in `.github/workflows/ci.yml`).
Expected: all sections green including the two new ones.

- [ ] **Step 2: e2e** — rewrite `apps/web/e2e/clubs.spec.ts` (currently a 559-byte stub) using the repo's login helper conventions (see `directory-labels.spec.ts`):

```ts
test("club hub journey", async ({ page }) => {
  // login via the existing magic-link login_url helper
  await page.goto("/directory?tab=clubs");
  await page.getByRole("button", { name: /new club/i }).click();
  // window.prompt: stub before click
  // page.once("dialog", d => d.accept("E2E Hub FC")) — Playwright auto-handles prompt via dialog event
  await page.waitForURL(/\/clubs\//);
  await expect(page.getByRole("heading", { name: "E2E Hub FC" })).toBeVisible();
  // Overview: set home ground, save, reload, assert persisted
  // Teams tab: add team, open squad, type new player name, quick-add, save squad
  // Entries tab: renders empty state
});
```

Flesh out with real selectors from the components (labels come from en ui.json keys added above). Respect the e2e shared-DB poison gotcha: unique names (`E2E Hub FC ${Date.now()}`).

Run: `cd apps/web && npx playwright test e2e/clubs.spec.ts`
Expected: PASS.

- [ ] **Step 3: Commit** — `git commit -m "test(clubs): smoke pro+free cap paths, hub e2e journey"`

---

### Task 13: Final verify + wrap

- [ ] **Step 1:** `cd apps/web && npx tsc --noEmit && npm run test:unit` — both clean.
- [ ] **Step 2:** `npm run openapi:gen` — diff empty (already regenerated) or commit it.
- [ ] **Step 3:** Full e2e related set: `npx playwright test e2e/clubs.spec.ts e2e/directory-labels.spec.ts` — PASS.
- [ ] **Step 4:** Update `HANDOFF.md` per repo protocol (status, done, next steps = W2 public page).
- [ ] **Step 5:** `git push -u origin feat/clubs-w1` and open PR titled `feat(clubs): W1 foundation — hub page, caps, contacts, standalone teams` with body summarizing spec §6 W1 row. PR body ends with the standard generated-with footer.

---

## Self-Review Notes (completed)

- **Spec coverage:** §4.1→T1/T3, §4.2→T1/T4, §4.3→T2/T4, §4.4→T1/T2/T5, §4.5→T6, §5.1→T7, §5.2→T8/T9/T10, help→T11, smoke/e2e→T12. W2/W3/W4 items intentionally absent.
- **Placeholders:** verification-style instructions ("check actual signature of X") appear only where the plan writer could not see the file; each names the exact file and what to confirm.
- **Type consistency:** `createTeam(auth, {name, short_name?, club_id?})` used in T2/T4/T7; `ClubContactRow` fields match schema `ClubContact`; `TeamSquadPanel(teamId, canEdit)` consistent between T7 and T9; page `getClub` payload consumed by T8/T9/T10 matches T4's extension.
