# Officials-Unify-Umpire Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the officials system the single "umpire" path — a claimed official scores through the full `FixtureConsole` board reached from `/my-matches`, the old Invite-Umpire button is removed, the officials schedule list is reordered, and declined/conflicted officials are surfaced on the schedule board + fixture page.

**Architecture:** Option 2 — read-union. An official's `fixture_officials` row with `response = 'accepted'` is the scoring authority; we never copy officials into `scorer_assignments` or `org_members`. Three existing scorer read/gate points learn to recognize an accepted official via one shared predicate `acceptedOfficialCovers(userId, fixtureId)`. The hand-in device link (`/score/[token]`, `DeviceScorePad`) is untouched.

**Tech Stack:** Next.js (vendored, see `AGENTS.md`), TypeScript, `postgres` (porsager) with `withTenant` RLS, Zod schemas, vitest (DB-backed, guarded by `HAS_DB`), Playwright e2e, i18n dictionaries (en/fr/es/nl).

## Global Constraints

- **Single source of truth = `fixture_officials`.** No writes to `scorer_assignments` or `org_members` for officials. Ever.
- **Only `response = 'accepted'` grants scoring.** `pending`/`declined` grant nothing.
- **Officials get `canScore = true`, `canEdit = false`.** A non-member official reaches ONLY the fixture score view; every other page/kind still `notFound()`s them.
- **i18n parity:** every new UI string ships in all four dicts — `src/dictionaries/{en,fr,es,nl}/ui.json`.
- **Board conflict codes follow the `warn.*` (non-blocking) convention.** `ScheduleConflict.code` is a strict `z.enum` in `src/server/api-v1/schemas.ts` — extending it requires `npm run openapi:gen` (drift gate) from repo root.
- **No DB migration** — every column used already exists (`fixtures.officials`, `fixture_officials.response`, `official_availability`, `persons.user_id`).
- **Tests run from `apps/web`**, DB suites need `DATABASE_URL` (ephemeral PG on :54329, see memory `project_local_test_db`) and are wrapped `describe.skipIf(!HAS_DB)`.
- **Every change ships a test that fails without it** (repo rule). **Verify before push:** `npx tsc --noEmit` + unit run.
- Commands: typecheck `npx tsc --noEmit` (in `apps/web`); unit `DATABASE_URL=$TEST_DATABASE_URL npx vitest run <file>` (in `apps/web`); smoke `npm run test:smoke` (repo root); openapi `npm run openapi:gen` (repo root).

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `apps/web/src/server/usecases/scorers.ts` | scorer scope resolution + gates + `/my-matches` read | add `acceptedOfficialCovers`; branch in `requireScorable`; UNION officials into `listAssignedFixtures` |
| `apps/web/src/server/page-auth.ts` | session page auth for fixture console | non-member accepted-official branch in `requireFixturePage` + `requireResourcePageAuth` |
| `apps/web/src/components/me/officiating-lane.tsx` | `/me` officiating lane | repoint "Score this match" to `routes.fixture`; drop device-mint |
| `apps/web/src/server/usecases/me-officiating.ts` | officiating reads/writes | delete `mintMyScoreLink` (dead after repoint) |
| `apps/web/src/app/api/v1/me/assigned-fixtures/[id]/score-link/route.ts` | official device-mint endpoint | delete (dead) |
| `apps/web/src/components/v2/invite-scorer.tsx` | old Invite-Umpire button | **delete** |
| `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx` | division page | remove `InviteScorer` import + usage |
| `apps/web/src/components/v2/officials-panel.tsx` | officials schedule panel | add `status` to `FixtureLite`; sort fixtures |
| `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/schedule/page.tsx` | schedule page | thread `status` into `OfficialsPanel` fixtures prop |
| `apps/web/src/server/api-v1/schemas.ts` | `ScheduleConflict` zod enum | add two `warn.official_*` codes |
| `apps/web/src/server/usecases/schedule.ts` | `validateSchedule` | append official-declined / official-unavailable conflicts |
| `apps/web/src/components/v2/board/types.ts` | board conflict label/help fallbacks | add English fallbacks for the two codes |
| `apps/web/src/dictionaries/{en,fr,es,nl}/ui.json` | i18n | `board.conflict.*` + `board.conflictHelp.*` for the two codes; official-strip strings; prune `inviteScorer.*` |
| `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/f/[no]/page.tsx` | fixture console page | assigned-officials strip (editors) |
| `scripts/smoke.ts` | smoke demo | official accept → full-pad path; drop InviteScorer step |
| `content/help/*.md` | help | officials = umpire path; decline/conflict signals |
| tests | see per-task | new suites + remove InviteScorer specs |

---

## Task 1: `acceptedOfficialCovers` predicate + `requireScorable` branch (A3, write gate)

**Files:**
- Modify: `apps/web/src/server/usecases/scorers.ts` (add predicate near `scorerCovers` ~line 34; branch in `requireScorable` ~line 67)
- Test: `apps/web/src/server/usecases/__tests__/scorers.test.ts`

**Interfaces:**
- Produces: `acceptedOfficialCovers(userId: string, fixtureId: string): Promise<boolean>` — used by Tasks 2 and 3.
- Consumes: existing `fixtureScope`, `scorerCovers`, `scoresViaAssignment`, `FixtureScope`, `HttpError`, `sql`.

- [ ] **Step 1: Write the failing test**

Reuse the seed helpers already in `me-officiating.test.ts` (`makeUser`, `seedOrg`, `seedFutureDivision`). Add to `scorers.test.ts`:

```ts
import { requireScorable, acceptedOfficialCovers } from "../scorers";
// (makeUser/seedOrg/seedFutureDivision copied or imported from the officiating
//  test helpers — same DB-backed pattern, HAS_DB guard.)

describe.skipIf(!HAS_DB)("accepted-official scoring authority", () => {
  it("acceptedOfficialCovers + requireScorable pass only for an accepted official", async () => {
    const { auth } = await seedOrg("pro");
    const { fixtureId } = await seedFutureDivision(auth);
    const user = await makeUser("Ref One");
    const [person] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name, user_id)
      values (${auth.orgId}, 'Ref One', ${user.id}) returning id`;
    const [official] = await sql<{ id: string }[]>`
      insert into officials (org_id, person_id, display_name, role_keys)
      values (${auth.orgId}, ${person!.id}, 'Ref One', array['referee']) returning id`;
    await sql`
      insert into fixture_officials (org_id, fixture_id, official_id, role_key, response)
      values (${auth.orgId}, ${fixtureId}, ${official!.id}, 'referee', 'pending')`;

    // pending → no authority
    expect(await acceptedOfficialCovers(user.id, fixtureId)).toBe(false);

    await sql`update fixture_officials set response = 'accepted'
              where fixture_id = ${fixtureId} and official_id = ${official!.id}`;
    expect(await acceptedOfficialCovers(user.id, fixtureId)).toBe(true);

    const officialAuth = { orgId: auth.orgId, via: "session" as const, userId: user.id, role: "official", keyId: null };
    await expect(requireScorable(officialAuth, fixtureId)).resolves.toMatchObject({ id: fixtureId });

    await sql`update fixture_officials set response = 'declined'
              where fixture_id = ${fixtureId} and official_id = ${official!.id}`;
    expect(await acceptedOfficialCovers(user.id, fixtureId)).toBe(false);
    await expect(requireScorable(officialAuth, fixtureId)).rejects.toThrow(/cannot record scores/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && DATABASE_URL=$TEST_DATABASE_URL npx vitest run src/server/usecases/__tests__/scorers.test.ts -t "accepted-official"`
Expected: FAIL — `acceptedOfficialCovers is not a function`.

- [ ] **Step 3: Add the predicate**

In `scorers.ts`, after `scorerCovers`:

```ts
/** Does the user hold an ACCEPTED official assignment covering this fixture?
 *  Officials are usually NOT org members, so this is a superuser read pinned
 *  through persons.user_id = the user and officials.person_id (the tenant door
 *  never opens for them). Only 'accepted' passes — a pending or declined
 *  assignment grants no scoring rights (design v2 §A5). */
export async function acceptedOfficialCovers(userId: string, fixtureId: string): Promise<boolean> {
  const rows = await sql`
    select 1 from fixture_officials fo
    join officials o on o.id = fo.official_id
    join persons p on p.id = o.person_id
    where fo.fixture_id = ${fixtureId} and p.user_id = ${userId}
      and fo.response = 'accepted'
    limit 1`;
  return rows.length > 0;
}
```

- [ ] **Step 4: Add the `requireScorable` branch**

In `requireScorable`, insert the official check immediately **before** the final `throw` (after the `scoresViaAssignment` block):

```ts
  // Accepted officials score the fixtures they are assigned to (design v2 §A3):
  // fixture_officials is the authority; officials are usually non-members, so
  // this runs off userId, not a membership role.
  if (auth.userId && (await acceptedOfficialCovers(auth.userId, fixtureId))) return scope;
  throw new HttpError(403, "Your role cannot record scores");
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/web && DATABASE_URL=$TEST_DATABASE_URL npx vitest run src/server/usecases/__tests__/scorers.test.ts -t "accepted-official"`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

```bash
cd apps/web && npx tsc --noEmit
git add apps/web/src/server/usecases/scorers.ts apps/web/src/server/usecases/__tests__/scorers.test.ts
git commit -m "feat(officials): accepted officials pass the score-write gate"
```

---

## Task 2: UNION officials into `/my-matches` (A1)

**Files:**
- Modify: `apps/web/src/server/usecases/scorers.ts` — `listAssignedFixtures` (~line 143)
- Test: `apps/web/src/server/usecases/__tests__/scorers.test.ts`

**Interfaces:**
- Consumes: `AssignedFixture` (unchanged shape — already carries slugs, `status`, `sport_key`, `module_version`).
- Produces: `listAssignedFixtures` now also returns accepted-official fixtures.

- [ ] **Step 1: Write the failing test**

```ts
import { listAssignedFixtures } from "../scorers";

describe.skipIf(!HAS_DB)("my-matches includes accepted officials", () => {
  it("lists an accepted official's fixture, excludes a declined one", async () => {
    const { auth } = await seedOrg("pro");
    const { fixtureId } = await seedFutureDivision(auth);
    const user = await makeUser("Ref Two");
    const [person] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name, user_id)
      values (${auth.orgId}, 'Ref Two', ${user.id}) returning id`;
    const [official] = await sql<{ id: string }[]>`
      insert into officials (org_id, person_id, display_name, role_keys)
      values (${auth.orgId}, ${person!.id}, 'Ref Two', array['referee']) returning id`;
    await sql`insert into fixture_officials (org_id, fixture_id, official_id, role_key, response)
              values (${auth.orgId}, ${fixtureId}, ${official!.id}, 'referee', 'accepted')`;

    let list = await listAssignedFixtures(user.id);
    expect(list.map((f) => f.id)).toContain(fixtureId);

    await sql`update fixture_officials set response = 'declined' where fixture_id = ${fixtureId}`;
    list = await listAssignedFixtures(user.id);
    expect(list.map((f) => f.id)).not.toContain(fixtureId);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && DATABASE_URL=$TEST_DATABASE_URL npx vitest run src/server/usecases/__tests__/scorers.test.ts -t "my-matches includes"`
Expected: FAIL — fixture not in list.

- [ ] **Step 3: Add the UNION branch to `listAssignedFixtures`**

The query selects `distinct on (f.scheduled_at, f.id)`. Add a second `from` source via `UNION` on an identical column list. Wrap the existing select as the first arm, then union the official arm. Replace the single `sql\`...\`` return with:

```ts
  return sql<AssignedFixture[]>`
    select distinct on (scheduled_at, id) * from (
      select f.id, f.fixture_no, f.org_id, o.name as org_name, o.slug as org_slug,
             c.id as competition_id, c.name as competition_name, c.slug as competition_slug,
             d.id as division_id, d.name as division_name, d.slug as division_slug,
             d.status as division_status,
             d.sport_key, d.module_version, f.round_no,
             f.home_entrant_id, f.away_entrant_id,
             he.display_name as home_name, ae.display_name as away_name,
             f.scheduled_at, ss.tz as venue_tz, f.venue, f.court_label, f.status
      from scorer_assignments sa
      join fixtures f on (
           (sa.scope_type = 'fixture'     and f.id = sa.scope_id)
        or (sa.scope_type = 'division'    and f.division_id = sa.scope_id)
        or (sa.scope_type = 'competition' and f.division_id in
              (select id from divisions where competition_id = sa.scope_id))
      ) and f.org_id = sa.org_id
      join divisions d on d.id = f.division_id
      join competitions c on c.id = d.competition_id
      join organizations o on o.id = f.org_id
      left join schedule_settings ss on ss.division_id = d.id
      left join entrants he on he.id = f.home_entrant_id
      left join entrants ae on ae.id = f.away_entrant_id
      where sa.user_id = ${userId}

      union

      select f.id, f.fixture_no, f.org_id, o.name as org_name, o.slug as org_slug,
             c.id as competition_id, c.name as competition_name, c.slug as competition_slug,
             d.id as division_id, d.name as division_name, d.slug as division_slug,
             d.status as division_status,
             d.sport_key, d.module_version, f.round_no,
             f.home_entrant_id, f.away_entrant_id,
             he.display_name as home_name, ae.display_name as away_name,
             f.scheduled_at, ss.tz as venue_tz, f.venue, f.court_label, f.status
      from fixture_officials fo
      join officials ofc on ofc.id = fo.official_id
      join persons p on p.id = ofc.person_id
      join fixtures f on f.id = fo.fixture_id
      join divisions d on d.id = f.division_id
      join competitions c on c.id = d.competition_id
      join organizations o on o.id = f.org_id
      left join schedule_settings ss on ss.division_id = d.id
      left join entrants he on he.id = f.home_entrant_id
      left join entrants ae on ae.id = f.away_entrant_id
      where p.user_id = ${userId} and fo.response = 'accepted'
    ) merged
    where status in ${sql(SCORABLE_STATUSES)}
      and (
        (${date ?? null}::text is null
          and (scheduled_at is null or scheduled_at >= date_trunc('day', now())))
        or (${date ?? null}::text is not null
          and scheduled_at >= ${dayFrom ?? null} and scheduled_at < ${dayTo ?? null})
      )
    order by scheduled_at nulls last, id
    limit 200`;
```

(The `distinct on` de-dups a fixture covered by both a scorer assignment and an official row.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && DATABASE_URL=$TEST_DATABASE_URL npx vitest run src/server/usecases/__tests__/scorers.test.ts -t "my-matches includes"`
Expected: PASS. Also rerun the whole file to confirm no regression: `... npx vitest run src/server/usecases/__tests__/scorers.test.ts`.

- [ ] **Step 5: Typecheck + commit**

```bash
cd apps/web && npx tsc --noEmit
git add apps/web/src/server/usecases/scorers.ts apps/web/src/server/usecases/__tests__/scorers.test.ts
git commit -m "feat(officials): accepted officials appear in /my-matches"
```

---

## Task 3: Fixture-console page auth accepts non-member officials (A2)

**Files:**
- Modify: `apps/web/src/server/page-auth.ts` — `requireFixturePage` (~line 128) and `requireResourcePageAuth` (~line 194)
- Test: `apps/web/src/server/usecases/__tests__/officials.test.ts` (predicate wiring), plus e2e in Task 9.

**Interfaces:**
- Consumes: `acceptedOfficialCovers` (Task 1).
- Produces: officials render the fixture console with `canScore=true`, `canEdit=false`.

- [ ] **Step 1: Write the failing test**

Page-auth reads the session (`getCurrentUser`), so its wiring is verified end-to-end by the Task 9 e2e. Here, add a focused DB test asserting the exact rule the branch encodes — a non-member with an accepted assignment is scorable, and the fixture belongs to the org — in `officials.test.ts`:

```ts
import { acceptedOfficialCovers } from "../scorers";
import { fixtureScope } from "../scorers";

describe.skipIf(!HAS_DB)("non-member official fixture access rule", () => {
  it("accepted official (no org_members row) covers only their fixture, in-org", async () => {
    const { auth } = await seedOrg("pro");
    const { fixtureId } = await seedFutureDivision(auth);
    const user = await makeUser("Ref Three"); // deliberately NOT inserted into org_members
    const [person] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name, user_id)
      values (${auth.orgId}, 'Ref Three', ${user.id}) returning id`;
    const [official] = await sql<{ id: string }[]>`
      insert into officials (org_id, person_id, display_name, role_keys)
      values (${auth.orgId}, ${person!.id}, 'Ref Three', array['umpire']) returning id`;
    await sql`insert into fixture_officials (org_id, fixture_id, official_id, role_key, response)
              values (${auth.orgId}, ${fixtureId}, ${official!.id}, 'umpire', 'accepted')`;

    const members = await sql`select 1 from org_members where user_id = ${user.id}`;
    expect(members.length).toBe(0); // still a non-member — Option 2

    expect(await acceptedOfficialCovers(user.id, fixtureId)).toBe(true);
    const scope = await fixtureScope(fixtureId);
    expect(scope?.org_id).toBe(auth.orgId);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && DATABASE_URL=$TEST_DATABASE_URL npx vitest run src/server/usecases/__tests__/officials.test.ts -t "non-member official fixture access"`
Expected: PASS for `acceptedOfficialCovers` (from Task 1) — this test documents the invariant the page-auth branch relies on. If Task 1 is not yet merged, it FAILs on the import. (Kept here as the executable spec for the branch.)

- [ ] **Step 3: Add the branch to `requireFixturePage`**

Today `const membership = orgs.find(...); if (!membership) notFound();` fires before any scoring check. Restructure so a non-member (or a member who cannot score) is checked for an accepted official before 404:

```ts
  const membership = orgs.find((o) => o.id === org.id);
  // ... existing competition/division/fixture resolution stays ...

  const canEdit = membership ? (EDITOR_ROLES as readonly string[]).includes(membership.role) : false;
  let canScore = canEdit;
  if (membership?.role === "scorer") {
    const { fixtureScope, scorerCovers } = await import("@/server/usecases/scorers");
    const scope = await fixtureScope(fixture.id);
    if (!scope || !(await scorerCovers(org.id, user.id, scope))) notFound();
    canScore = true;
  } else if (membership?.role === "viewer") {
    const { fixtureScope, scorerCovers } = await import("@/server/usecases/scorers");
    const scope = await fixtureScope(fixture.id);
    canScore = !!scope && (await scorerCovers(org.id, user.id, scope));
  }
  if (!canScore) {
    // Non-member (or non-scoring member) with an accepted official assignment
    // scores the fixture — the only surface they can reach (design v2 §A2/§A5).
    const { acceptedOfficialCovers } = await import("@/server/usecases/scorers");
    if (await acceptedOfficialCovers(user.id, fixture.id)) canScore = true;
    else if (!membership) notFound();
  }
  return {
    auth: { orgId: org.id, via: "session", userId: user.id, role: membership?.role ?? "official", keyId: null },
    user,
    org: membership ?? { id: org.id, slug: orgSlug, name: org.name, role: "official" as const },
    canEdit,
    canScore,
    competition,
    division,
    fixtureId: fixture.id,
  };
```

Note: the synthesized `org` shape must satisfy the `PageAuth["org"]` type — copy the minimal fields the type requires (id, slug, name, role); if `PageAuth["org"]` has more required fields, fill them from `org` (the resolved org row). `canEdit` is always false for the synthesized official.

- [ ] **Step 4: Add the branch to `requireResourcePageAuth`**

Mirror it, but officials pass **only** for `kind === "fixture"`:

```ts
  const org = orgs.find((o) => o.id === orgId);
  const canEdit = org ? (EDITOR_ROLES as readonly string[]).includes(org.role) : false;
  let canScore = canEdit;
  if (org?.role === "scorer") {
    if (kind !== "fixture") notFound();
    const { fixtureScope, scorerCovers } = await import("@/server/usecases/scorers");
    const scope = await fixtureScope(id);
    if (!scope || !(await scorerCovers(orgId, user.id, scope))) notFound();
    canScore = true;
  } else if (org?.role === "viewer" && kind === "fixture") {
    const { fixtureScope, scorerCovers } = await import("@/server/usecases/scorers");
    const scope = await fixtureScope(id);
    canScore = !!scope && (await scorerCovers(orgId, user.id, scope));
  }
  if (!canScore) {
    if (kind === "fixture") {
      const { acceptedOfficialCovers } = await import("@/server/usecases/scorers");
      if (await acceptedOfficialCovers(user.id, id)) canScore = true;
      else if (!org) notFound();
    } else if (!org) {
      notFound();
    }
  }
  return {
    auth: { orgId, via: "session", userId: user.id, role: org?.role ?? "official", keyId: null },
    user,
    org: org ?? { id: orgId, slug: "", name: "", role: "official" as const },
    canEdit,
    canScore,
  };
```

(If a non-member official hits a non-fixture resource, `org` is undefined and `kind !== "fixture"` → `notFound()`.)

- [ ] **Step 5: Run test + typecheck**

Run: `cd apps/web && DATABASE_URL=$TEST_DATABASE_URL npx vitest run src/server/usecases/__tests__/officials.test.ts -t "non-member official fixture access"` → PASS.
Run: `cd apps/web && npx tsc --noEmit` → clean (fix any `PageAuth["org"]` shape mismatch by filling required fields).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/server/page-auth.ts apps/web/src/server/usecases/__tests__/officials.test.ts
git commit -m "feat(officials): non-member accepted officials can open the fixture score console"
```

---

## Task 4: Repoint `/me` officiating-lane score action to the full board (A4)

**Files:**
- Modify: `apps/web/src/components/me/officiating-lane.tsx` (`openScorePad`, ~line 161)
- Modify: `apps/web/src/server/usecases/me-officiating.ts` (delete `mintMyScoreLink`, ~line 273)
- Delete: `apps/web/src/app/api/v1/me/assigned-fixtures/[id]/score-link/route.ts`
- Test: `apps/web/src/components/me/__tests__/officiating-lane.test.tsx`

**Interfaces:**
- Consumes: `routes.fixture(orgSlug, compSlug, divSlug, no)`; `MyOfficiatingAssignment` already carries `org_slug`, `competition_slug`, `division_slug`, `fixture_no`.

- [ ] **Step 1: Write the failing test**

In `officiating-lane.test.tsx`, assert the "Score this match" control links to the fixture route (not a device link). Follow the existing render/test pattern in that file:

```tsx
it("Score this match points at the full fixture board", async () => {
  const a = makeAssignment({ response: "accepted", fixture_status: "scheduled",
    org_slug: "riverside", competition_slug: "summer", division_slug: "u11", fixture_no: 7 });
  render(<OfficiatingLane isOfficial assignments={[a]} blackouts={[]} pendingClaims={[]} />);
  const link = screen.getByRole("button", { name: /score this match/i });
  // repoint uses routes.fixture — assert the target the click navigates to
  expect(routes.fixture("riverside", "summer", "u11", 7)).toBe("/o/riverside/c/summer/d/u11/f/7");
});
```

(`makeAssignment` = a small factory returning a `MyOfficiatingAssignment` with the given fields; add it to the test file if absent.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/components/me/__tests__/officiating-lane.test.tsx -t "full fixture board"`
Expected: FAIL (control still calls the device-mint; assertion on navigation target absent).

- [ ] **Step 3: Repoint `openScorePad`**

In `officiating-lane.tsx`, add `import { routes } from "@/lib/routes";` and replace the `openScorePad` body:

```tsx
  function openScorePad() {
    // design v2 §A4: accepted officials score on the full FixtureConsole board
    // via /my-matches-grade auth, not the stripped device link.
    window.location.assign(
      routes.fixture(a.org_slug, a.competition_slug, a.division_slug, a.fixture_no),
    );
  }
```

Remove the now-unused `proNote`/`setProNote` state, the `ApiV1Error` import if unused, and the `me.off.scorePro` reference in the JSX (the Pro `scoring.device_links` gate no longer applies — officials get the same board scorers already use).

- [ ] **Step 4: Delete the dead device-mint**

Delete `apps/web/src/app/api/v1/me/assigned-fixtures/[id]/score-link/route.ts` and remove `mintMyScoreLink` from `me-officiating.ts` (and its now-unused imports `createDeviceLink`, `AuthCtx` if unused).

- [ ] **Step 5: Run test + typecheck**

Run: `cd apps/web && npx vitest run src/components/me/__tests__/officiating-lane.test.tsx` → PASS.
Run: `cd apps/web && npx tsc --noEmit` → clean (grep for other `mintMyScoreLink` / `score-link` references first: `grep -rn "mintMyScoreLink\|assigned-fixtures/.*score-link" apps/web/src`).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/me/officiating-lane.tsx apps/web/src/server/usecases/me-officiating.ts apps/web/src/components/me/__tests__/officiating-lane.test.tsx
git rm apps/web/src/app/api/v1/me/assigned-fixtures/[id]/score-link/route.ts
git commit -m "feat(officials): /me score action opens the full board, drop official device-mint"
```

---

## Task 5: Remove the Invite-Umpire button (C)

**Files:**
- Delete: `apps/web/src/components/v2/invite-scorer.tsx`
- Modify: `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx` (remove import + usage ~line 29, ~line 168)
- Modify: `apps/web/src/dictionaries/{en,fr,es,nl}/ui.json` (remove `inviteScorer.*` if unused elsewhere)
- Test/remove: any `invite-scorer` unit/e2e specs

- [ ] **Step 1: Confirm the only references**

Run: `grep -rn "InviteScorer\|invite-scorer\|inviteScorer" apps/web/src`
Expected references: the component file, the division page import+usage, i18n `inviteScorer.*` keys, and possibly a unit/e2e test. (Keep `scorer` role, `scorer_assignments`, `scorerCovers`, `/my-matches`, viewer-additive path — do NOT touch those.)

- [ ] **Step 2: Remove usage from the division page**

Delete the import line `import { InviteScorer } from "@/components/v2/invite-scorer";` and the JSX block:

```tsx
            {editable && (
              <InviteScorer
                orgId={auth.orgId}
                divisionId={id}
                officialLabel={sportModule.officialLabel.scorer}
              />
            )}
```

- [ ] **Step 3: Delete the component + prune i18n + specs**

```bash
git rm apps/web/src/components/v2/invite-scorer.tsx
```
Remove `inviteScorer.*` keys from all four `ui.json` (only if `grep -rn "inviteScorer\." apps/web/src` shows no remaining code references). Delete any `invite-scorer*.test.*` and remove InviteScorer steps from e2e specs (see Task 9 for the e2e sweep).

- [ ] **Step 4: Typecheck + i18n parity check + commit**

Run: `cd apps/web && npx tsc --noEmit` → clean.
Run: `grep -rn "InviteScorer\|invite-scorer" apps/web/src` → no output.
Confirm the four `ui.json` still have equal key counts (parity): `for l in en fr es nl; do echo -n "$l "; grep -c ':' apps/web/src/dictionaries/$l/ui.json; done`

```bash
git add apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx apps/web/src/dictionaries
git commit -m "feat(officials): remove the Invite-Umpire button; officials are the umpire path"
```

---

## Task 6: Reorder the officials schedule list (B)

**Files:**
- Modify: `apps/web/src/components/v2/officials-panel.tsx` (`FixtureLite` ~line 30; `fixtures.map` render ~line 419)
- Modify: `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/schedule/page.tsx` (fixtures prop ~line 168)
- Test: `apps/web/src/components/v2/__tests__/officials-panel-sort.test.tsx` (new)

**Interfaces:**
- `FixtureLite` gains `status: string`.

- [ ] **Step 1: Write the failing test**

```tsx
import { sortFixturesForOfficials } from "@/components/v2/officials-panel";

it("scheduled first (by time), then in_play + decided", () => {
  const f = (id: string, status: string, at: string | null) =>
    ({ id, label: id, scheduled_at: at, status, officials: [] });
  const input = [
    f("done", "finalized", "2026-08-01T09:00:00Z"),
    f("live", "in_play", "2026-08-01T08:00:00Z"),
    f("late", "scheduled", "2026-08-01T12:00:00Z"),
    f("early", "scheduled", "2026-08-01T10:00:00Z"),
    f("cancel", "cancelled", "2026-08-01T07:00:00Z"),
  ];
  expect(sortFixturesForOfficials(input).map((x) => x.id))
    .toEqual(["early", "late", "cancel", "live", "done"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/components/v2/__tests__/officials-panel-sort.test.tsx`
Expected: FAIL — `sortFixturesForOfficials` not exported.

- [ ] **Step 3: Add `status` to `FixtureLite` and export the sort**

In `officials-panel.tsx`, add `status: string;` to the `FixtureLite` interface, and add an exported pure sort:

```tsx
const OFFICIALS_TOP = new Set(["scheduled"]);
/** Assignment view: matches still needing officials first (scheduled, by
 *  kickoff), then in_play + decided (finalized/cancelled) at the bottom. */
export function sortFixturesForOfficials<T extends { status: string; scheduled_at: string | null }>(
  fixtures: T[],
): T[] {
  const byTime = (a: T, b: T) =>
    (a.scheduled_at ?? "9999").localeCompare(b.scheduled_at ?? "9999");
  const top = fixtures.filter((f) => OFFICIALS_TOP.has(f.status)).sort(byTime);
  const bottom = fixtures.filter((f) => !OFFICIALS_TOP.has(f.status)).sort(byTime);
  return [...top, ...bottom];
}
```

Then render `sortFixturesForOfficials(fixtures).map((f) => ...)` in place of `fixtures.map((f) => ...)`.

- [ ] **Step 4: Thread `status` from the schedule page**

In `schedule/page.tsx`, the `OfficialsPanel` `fixtures={fixtures.map((f) => ({ ... }))}` mapping gains `status: f.status,` (the source `fixtures` rows already carry `status` — same array that feeds `ScheduleBoard`).

- [ ] **Step 5: Run test + typecheck + commit**

Run: `cd apps/web && npx vitest run src/components/v2/__tests__/officials-panel-sort.test.tsx` → PASS.
Run: `cd apps/web && npx tsc --noEmit` → clean.

```bash
git add apps/web/src/components/v2/officials-panel.tsx "apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/schedule/page.tsx" apps/web/src/components/v2/__tests__/officials-panel-sort.test.tsx
git commit -m "feat(officials): scheduled matches first, in-play/decided last in the officials list"
```

---

## Task 7: Board conflicts for declined / unavailable officials (D1)

**Files:**
- Modify: `apps/web/src/server/api-v1/schemas.ts` (`ScheduleConflict` enum ~line 661)
- Modify: `apps/web/src/server/usecases/schedule.ts` (`validateSchedule` ~top)
- Modify: `apps/web/src/components/v2/board/types.ts` (`CONFLICT_LABEL`/`CONFLICT_HELP`)
- Modify: `apps/web/src/dictionaries/{en,fr,es,nl}/ui.json` (`board.conflict.*` + `board.conflictHelp.*`)
- Regenerate: `openapi/` via `npm run openapi:gen`
- Test: `apps/web/src/server/usecases/__tests__/schedule.test.ts`

**Interfaces:**
- New conflict codes: `warn.official_declined`, `warn.official_unavailable` (both `blocking: false`).

- [ ] **Step 1: Write the failing test**

```ts
import { validateSchedule } from "../schedule";

describe.skipIf(!HAS_DB)("official conflicts on the board", () => {
  it("emits warn.official_declined for a declined assignment", async () => {
    const { auth } = await seedOrg("pro");
    const { fixtureId } = await seedFutureDivision(auth); // scheduled + on a court
    const [person] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name) values (${auth.orgId}, 'Ref X') returning id`;
    const [official] = await sql<{ id: string }[]>`
      insert into officials (org_id, person_id, display_name, role_keys)
      values (${auth.orgId}, ${person!.id}, 'Ref X', array['referee']) returning id`;
    await sql`insert into fixture_officials (org_id, fixture_id, official_id, role_key, response)
              values (${auth.orgId}, ${fixtureId}, ${official!.id}, 'referee', 'declined')`;

    const { conflicts } = await validateSchedule(auth, /* divisionId */ (await divisionOf(fixtureId)));
    expect(conflicts.some((c) => c.code === "warn.official_declined" && c.fixture_id === fixtureId)).toBe(true);
    expect(conflicts.find((c) => c.code === "warn.official_declined")!.blocking).toBe(false);
  });
});
```

(`divisionOf(fixtureId)` = `select division_id from fixtures where id = …`; inline it.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && DATABASE_URL=$TEST_DATABASE_URL npx vitest run src/server/usecases/__tests__/schedule.test.ts -t "official conflicts"`
Expected: FAIL — code not emitted (and TS enum rejects the string until Step 3).

- [ ] **Step 3: Extend the `ScheduleConflict` enum**

In `schemas.ts`, add to the `z.enum([...])` list:

```ts
    "warn.official_declined",
    "warn.official_unavailable",
```

- [ ] **Step 4: Emit the conflicts in `validateSchedule`**

Before the `return { conflicts: mapConflicts(...) }`, compute official conflicts within the same `withTenant` tx and concatenate. Add:

```ts
    const officialConflicts = await tx<{ fixture_id: string; code: string }[]>`
      -- declined: any assigned official said no
      select fo.fixture_id, 'warn.official_declined' as code
      from fixture_officials fo
      join fixtures f on f.id = fo.fixture_id
      where f.division_id = ${divisionId} and fo.response = 'declined'
      union
      -- unavailable: an accepted/pending official is blacked out on the
      -- fixture's date (venue zone), i.e. a schedule clash
      select fo.fixture_id, 'warn.official_unavailable' as code
      from fixture_officials fo
      join fixtures f on f.id = fo.fixture_id
      join officials o on o.id = fo.official_id
      join official_availability oa on oa.official_id = o.id
      left join schedule_settings ss on ss.division_id = f.division_id
      where f.division_id = ${divisionId}
        and fo.response in ('accepted','pending')
        and f.scheduled_at is not null
        and oa.date = (f.scheduled_at at time zone coalesce(ss.tz, 'UTC'))::date`;

    return {
      conflicts: [
        ...mapConflicts(
          validateAssignments(assignments, toSlotConfig(settings, 0), siblings, feedDependencies(all)),
        ),
        ...officialConflicts.map((c) => ({ fixture_id: c.fixture_id, code: c.code as ScheduleConflict["code"], blocking: false })),
      ],
    };
```

- [ ] **Step 5: English fallbacks + i18n parity**

In `board/types.ts`, add to `CONFLICT_LABEL` and `CONFLICT_HELP`:

```ts
  "warn.official_declined": "umpire declined",
  "warn.official_unavailable": "umpire unavailable",
```
```ts
  "warn.official_declined": "An assigned official has declined — re-assign this match.",
  "warn.official_unavailable": "An assigned official is unavailable at this time.",
```

In each `ui.json` (en shown; translate fr/es/nl):

```json
"board.conflict.warn.official_declined": "umpire declined",
"board.conflict.warn.official_unavailable": "umpire unavailable",
"board.conflictHelp.warn.official_declined": "An assigned official has declined — re-assign this match.",
"board.conflictHelp.warn.official_unavailable": "An assigned official is unavailable at this time."
```

- [ ] **Step 6: Regenerate openapi + run tests**

Run (repo root): `npm run openapi:gen`
Run: `cd apps/web && DATABASE_URL=$TEST_DATABASE_URL npx vitest run src/server/usecases/__tests__/schedule.test.ts -t "official conflicts"` → PASS.
Run: `cd apps/web && npx tsc --noEmit` → clean. Confirm i18n parity counts equal across the four `ui.json`.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/server/api-v1/schemas.ts apps/web/src/server/usecases/schedule.ts apps/web/src/components/v2/board/types.ts apps/web/src/dictionaries openapi
git add apps/web/src/server/usecases/__tests__/schedule.test.ts
git commit -m "feat(officials): surface declined/unavailable officials as board conflicts"
```

---

## Task 8: Assigned-officials strip on the fixture page (D2)

**Files:**
- Modify: `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/f/[no]/page.tsx`
- Create: `apps/web/src/components/v2/fixture-officials-strip.tsx`
- Modify: `apps/web/src/dictionaries/{en,fr,es,nl}/ui.json` (strip strings)
- Test: `apps/web/src/components/v2/__tests__/fixture-officials-strip.test.tsx` (new)

**Interfaces:**
- `getFixture` already returns `fixture.officials` (denormalized: `{ official_id, name, role, locked, response?, decline_reason? }[]` — from `FIXTURE_COLS`).

- [ ] **Step 1: Write the failing test**

```tsx
import { FixtureOfficialsStrip } from "@/components/v2/fixture-officials-strip";
import { render, screen } from "@testing-library/react";

it("shows a red Declined badge with the reason", () => {
  render(<FixtureOfficialsStrip officials={[
    { official_id: "1", name: "Ada", role: "umpire", response: "declined", decline_reason: "away" },
    { official_id: "2", name: "Ben", role: "referee", response: "accepted" },
  ]} />);
  expect(screen.getByText("Ada")).toBeInTheDocument();
  const declined = screen.getByText(/declined/i);
  expect(declined).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/components/v2/__tests__/fixture-officials-strip.test.tsx`
Expected: FAIL — component missing.

- [ ] **Step 3: Create the strip component**

```tsx
"use client";
// Fixture-page officials strip (design v2 §D2): who's assigned, with a status
// chip. A red "Declined" badge (+ reason) is the organiser's cue to re-pick.
import { useMsg } from "@/components/i18n/dict-provider";

interface StripOfficial {
  official_id: string;
  name: string;
  role: string;
  response?: string;
  decline_reason?: string | null;
}

const CHIP: Record<string, string> = {
  accepted: "bg-lime-100 text-lime-800",
  pending: "bg-amber-100 text-amber-800",
  declined: "bg-red-100 text-red-700",
};

export function FixtureOfficialsStrip({ officials }: { officials: StripOfficial[] }) {
  const msg = useMsg();
  if (officials.length === 0) return null;
  return (
    <section className="mb-4 rounded-lg border border-slate-200 bg-white p-3" aria-label={msg("fixture.officials.title")}>
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">
        {msg("fixture.officials.title")}
      </p>
      <ul className="flex flex-wrap gap-2">
        {officials.map((o) => {
          const state = o.response ?? "accepted";
          return (
            <li key={`${o.official_id}:${o.role}`} className="flex items-center gap-1.5 rounded-full border border-slate-200 px-2.5 py-1 text-xs">
              <span className="font-medium text-slate-700">{o.name}</span>
              <span className="text-slate-400 capitalize">{o.role}</span>
              <span
                className={`rounded px-1.5 py-0.5 font-semibold ${CHIP[state] ?? CHIP.pending}`}
                title={state === "declined" && o.decline_reason ? o.decline_reason : undefined}
              >
                {msg(`fixture.officials.${state}` as never)}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
```

- [ ] **Step 4: Render it on the fixture page (editors only)**

In `f/[no]/page.tsx`, import the strip and render it above `<FixtureConsole …/>`, gated on `canEdit` (organiser surface — keep the scorer/official chrome minimal):

```tsx
        {canEdit && Array.isArray(fixture.officials) && (
          <FixtureOfficialsStrip officials={fixture.officials as never} />
        )}
```

- [ ] **Step 5: i18n strings (four dicts)**

Add to each `ui.json` (en shown; translate the rest):

```json
"fixture.officials.title": "Officials",
"fixture.officials.accepted": "Accepted",
"fixture.officials.pending": "Pending",
"fixture.officials.declined": "Declined"
```

- [ ] **Step 6: Run test + typecheck + commit**

Run: `cd apps/web && npx vitest run src/components/v2/__tests__/fixture-officials-strip.test.tsx` → PASS.
Run: `cd apps/web && npx tsc --noEmit` → clean. Confirm i18n parity.

```bash
git add apps/web/src/components/v2/fixture-officials-strip.tsx "apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/f/[no]/page.tsx" apps/web/src/dictionaries apps/web/src/components/v2/__tests__/fixture-officials-strip.test.tsx
git commit -m "feat(officials): assigned-officials strip with decline/conflict badge on the fixture page"
```

---

## Task 9: Hygiene — smoke, help, e2e sweep

**Files:**
- Modify: `scripts/smoke.ts`
- Modify: `content/help/*.md` (the officials / scoring articles)
- Modify/remove: e2e specs referencing InviteScorer or the official device-mint

- [ ] **Step 1: Update the smoke demo**

In `scripts/smoke.ts`, add an officials-scoring path (pro + free where applicable): create an official → invite/claim → accept an assignment → assert the fixture is reachable via `/my-matches` and a score event can be recorded through the fixture console API. Remove the InviteScorer step. Follow the existing smoke structure (HTTP-API calls, SQL verify).

- [ ] **Step 2: Run smoke**

Run (repo root): `npm run test:smoke`
Expected: PASS, including the new officials path.

- [ ] **Step 3: Update help pages**

In the relevant `content/help/*.md` (officials / scoring): document that officials are the umpire/scoring path (invite → claim → /me accept → score on the full board from /my-matches), remove any Invite-Umpire mention, and describe the decline/conflict signals on the board + fixture page. (Repo rule: help updated in the same branch.)

- [ ] **Step 4: e2e sweep**

Run: `grep -rn "invite-scorer\|InviteScorer\|Invite an Umpire\|score-link" apps/web/tests apps/web/e2e 2>/dev/null` (adjust to the repo's e2e dir). Remove/redirect InviteScorer specs; add or extend an officials-directory / officiating e2e that drives: accept an assignment → open the fixture board → record a score. If a `officials-directory` e2e already exists (memory notes 8/8 passing), extend it.

- [ ] **Step 5: Full verify + commit**

Run: `cd apps/web && npx tsc --noEmit` → clean.
Run: `cd apps/web && npx vitest run` → all green.
Run selected e2e per the repo's convention (`npm run test:e2e` or a targeted project).

```bash
git add scripts/smoke.ts content/help
git add apps/web/tests || true
git commit -m "chore(officials): smoke + help + e2e for the unified umpire path"
```

---

## Self-Review

**Spec coverage:**
- A1 → Task 2. A2 → Task 3. A3 → Task 1. A4 → Task 4. A5 (security scoping) → enforced across Tasks 1/3 (only `accepted`, `canEdit=false`, non-fixture kinds 404). B → Task 6. C → Task 5. D1 → Task 7. D2 → Task 8. Hygiene → Task 9. Division-wide → explicitly deferred (spec Known gaps), no task. **All spec sections covered.**

**Placeholder scan:** No TBD/TODO; every code step shows code; every test step shows assertions and the run command with expected result. Seed helpers reference real existing functions (`makeUser`, `seedOrg`, `seedFutureDivision`) — the executor imports/copies them from `me-officiating.test.ts`.

**Type consistency:** `acceptedOfficialCovers(userId, fixtureId)` used identically in Tasks 1/2/3. `sortFixturesForOfficials` name matches its test. `FixtureOfficialsStrip` prop shape matches `fixture.officials` from `FIXTURE_COLS`. New conflict codes `warn.official_declined` / `warn.official_unavailable` identical in schema, usecase, board fallbacks, i18n, and test.

**Risks called out for the executor:**
- Task 3 touches auth — a mistake is a security bug. The synthesized official context must never grant `canEdit` or reach a non-fixture kind. Run `npx tsc` to catch `PageAuth["org"]` shape mismatches.
- Task 7 enum change hits the openapi drift gate — `npm run openapi:gen` and commit the regenerated spec, or the drift test fails.
