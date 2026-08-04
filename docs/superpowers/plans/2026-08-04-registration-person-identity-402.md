# Registration Person Identity (#402) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signed-in registrant who affirms they are registering themselves gets **one** `persons` row across every division they enter, while anonymous registration and the guardian/proxy cases keep minting separate persons exactly as they do today.

**Architecture:** A `persons.lane` discriminator (`'player' | 'official'`) makes `(org_id, user_id, lane)` genuinely unique, so the partial unique index #396 planned — and reverted — can land. The public register route resolves the session itself and passes a `sessionUserId` inward; `submitRegistration` writes `registrations.user_id` only under an explicit affirmation plus a server-side guardian veto. `materialise` then upserts into the player lane, letting the unique index arbitrate the concurrent-registration race instead of a SELECT-then-INSERT.

**Tech Stack:** Next.js (App Router, this repo's fork — read `node_modules/next/dist/docs/` before touching route or page code), TypeScript, zod (`api-v1/schemas.ts`), postgres.js (`sql` tagged templates), Flyway migrations under `db/migration/deltas/`, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-04-registration-person-identity-402-design.md` (commit dfcb67d2). Read it before Task 1.

## Global Constraints

- Work only in the worktree `/Users/ashokhein/github/seazn.club/.claude/worktrees/reg-person-402`, branch `feat/registration-person-identity-402`. Never touch the main checkout. Prefix every verify command with `cd <abs worktree> &&` **in the same call** — the shell cwd resets between calls and a run launched elsewhere returns a false green.
- Test database for this branch: `DATABASE_URL="postgresql://postgres@127.0.0.1:54341/seazn_test" DATABASE_SSL=disable`. Schema defaults to `seazn_club` (`lib/db.ts:49`). It is already migrated and seeded (`upserted 11 sports, 31 system variants`). Do **not** point tests at the dev DB on `:5432`.
- Judge a vitest run **only** from `--reporter=json --outputFile`, reading `numPassedTests` / `numTotalTests` / `numFailedTestSuites`. `rtk` prints `PASS(0) FAIL(0)` for a suite that failed to *collect*. Confirm `.testResults[].name` entries resolve under the worktree path.
- Never use `git stash` in this worktree — the stash stack is shared with the main checkout.
- Every user-facing string goes in **all four** locale dictionaries as flat dotted keys. `content/help/**` is one English tree and owes no i18n work.
- Any change to an api-v1 schema requires `npm run openapi:gen` and committing the regenerated `openapi/*.json`. The drift gate is **CI-only** — a green local run proves nothing.
- Name and dob may only ever *suggest*. Nothing in this plan may auto-merge on them.
- `grep -a` always; this repo's files are reported as binary otherwise.

---

### Task 1: `persons.lane` + the partial unique index (V348)

**Files:**
- Create: `db/migration/deltas/V348__persons_lane_and_registration_user.sql`
- Modify: `apps/web/src/server/usecases/officials.ts:154-156`
- Test: `apps/web/src/server/usecases/__tests__/persons-identity.test.ts` (append; keep the existing guardian suite untouched)

**Interfaces:**
- Consumes: nothing.
- Produces: column `persons.lane text not null default 'player'`; index `persons_org_user_lane_uq` on `(org_id, user_id, lane) where user_id is not null`; column `registrations.user_id uuid references users(id) on delete set null`.

- [ ] **Step 1: Write the failing test**

Append to `persons-identity.test.ts`:

```ts
describe.skipIf(!HAS_DB)("persons lane identity (#402)", () => {
  it("rejects a second player-lane person for the same user in one org", async () => {
    const { auth } = await seedOrg("pro");
    const [user] = await sql<{ id: string }[]>`
      insert into users (email, display_name, password_hash)
      values (${`lane-${randomUUID().slice(0, 8)}@test.local`}, 'Lane Tester', 'x')
      returning id`;

    await sql`
      insert into persons (org_id, full_name, user_id, lane)
      values (${auth.orgId}, 'Lane Tester', ${user.id}, 'player')`;

    await expect(
      sql`insert into persons (org_id, full_name, user_id, lane)
          values (${auth.orgId}, 'Lane Tester Again', ${user.id}, 'player')`,
    ).rejects.toThrow(/persons_org_user_lane_uq/);
  });

  it("accepts the same user in BOTH lanes — the case that killed V345", async () => {
    const { auth } = await seedOrg("pro");
    const [user] = await sql<{ id: string }[]>`
      insert into users (email, display_name, password_hash)
      values (${`dual-${randomUUID().slice(0, 8)}@test.local`}, 'Dual Role', 'x')
      returning id`;

    await sql`insert into persons (org_id, full_name, user_id, lane)
              values (${auth.orgId}, 'Dual Role', ${user.id}, 'player')`;
    await sql`insert into persons (org_id, full_name, user_id, lane)
              values (${auth.orgId}, 'Dual Role', ${user.id}, 'official')`;

    const [{ n }] = await sql<{ n: string }[]>`
      select count(*)::text as n from persons
       where org_id = ${auth.orgId} and user_id = ${user.id}`;
    expect(Number(n)).toBe(2);
  });

  it("leaves anonymous persons unconstrained — many null user_ids in one org", async () => {
    const { auth } = await seedOrg("pro");
    await sql`insert into persons (org_id, full_name) values (${auth.orgId}, 'Anon One')`;
    await sql`insert into persons (org_id, full_name) values (${auth.orgId}, 'Anon Two')`;
    const [{ n }] = await sql<{ n: string }[]>`
      select count(*)::text as n from persons
       where org_id = ${auth.orgId} and user_id is null`;
    expect(Number(n)).toBeGreaterThanOrEqual(2);
  });

  it("inviteOfficial mints an official-lane person", async () => {
    const { auth } = await seedOrg("pro");
    const official = await inviteOfficial(auth, {
      display_name: "Ref Without Account",
      role_keys: ["referee"],
    });
    const [row] = await sql<{ lane: string }[]>`
      select p.lane from persons p
        join officials o on o.person_id = p.id
       where o.id = ${official.id}`;
    expect(row.lane).toBe("official");
  });
});
```

Add `import { inviteOfficial } from "../officials";` to the import block. Check `inviteOfficial`'s real argument shape at `officials.ts:144` first and match it — if it differs from the call above, adapt the call, not the assertion.

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/reg-person-402 && \
DATABASE_URL="postgresql://postgres@127.0.0.1:54341/seazn_test" DATABASE_SSL=disable \
npm test --workspace apps/web -- run src/server/usecases/__tests__/persons-identity.test.ts \
  --reporter=json --outputFile=/tmp/t1.json > /dev/null 2>&1; \
node -e 'const r=require("/tmp/t1.json");console.log(r.numPassedTests,"/",r.numTotalTests,"failedSuites",r.numFailedTestSuites)'
```

Expected: the three lane tests FAIL with `column "lane" of relation "persons" does not exist`.

- [ ] **Step 3: Write the migration**

`db/migration/deltas/V348__persons_lane_and_registration_user.sql`:

```sql
-- #402 — registration person identity.
--
-- #396 planned a partial unique index on persons(org_id, user_id). It was
-- reverted (d01c2c55) because one user legitimately holds a player person AND
-- an official person in one org, so the pair is not unique. `lane` supplies the
-- missing third column: registration resolves the player lane, officials keep
-- their own, and the index the design asked for can finally land.
alter table persons
  add column lane text not null default 'player'
  check (lane in ('player','official'));

-- A person referenced by `officials` and never rostered is an official-lane row.
-- A person that is BOTH stays 'player': registration must resolve them, and the
-- officials FK works regardless of lane. Greenfield, so this is a convenience
-- for local and demo databases, not a production backfill.
update persons set lane = 'official'
 where exists (select 1 from officials o where o.person_id = persons.id)
   and not exists (select 1 from entrant_members em where em.person_id = persons.id);

create unique index persons_org_user_lane_uq
  on persons (org_id, user_id, lane)
  where user_id is not null;

-- The registrant's session, captured only under an explicit affirmation with no
-- guardian fields (see submitRegistration). Nullable by design: registration
-- works with no account. `on delete set null` so removing an account does not
-- cascade away the registration record.
alter table registrations
  add column user_id uuid references users(id) on delete set null;

create index if not exists registrations_user_idx
  on registrations (user_id) where user_id is not null;
```

Then set the lane in `officials.ts:154-156`:

```ts
insert into persons (org_id, full_name, lane)
values (${auth.orgId}, ${row.display_name}, 'official')
returning id
```

- [ ] **Step 4: Apply and re-run**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/reg-person-402 && \
DATABASE_URL="postgresql://postgres@127.0.0.1:54341/seazn_test" DATABASE_SSL=disable \
npm run db:apply > /tmp/apply.log 2>&1; echo "APPLY_EXIT=$?"; tail -3 /tmp/apply.log
```

Then re-run the Step 2 command. Expected: all four lane tests PASS and the pre-existing guardian test still passes.

- [ ] **Step 5: Commit**

```bash
git add db/migration/deltas/V348__persons_lane_and_registration_user.sql \
        apps/web/src/server/usecases/officials.ts \
        apps/web/src/server/usecases/__tests__/persons-identity.test.ts
git commit -m "feat(db): V348 persons.lane makes (org_id,user_id) uniquely resolvable (#402)"
```

---

### Task 2: capture the session `user_id`, with the guardian veto

**Files:**
- Modify: `apps/web/src/server/api-v1/schemas.ts:1069-1095` (`PublicRegisterRequest`)
- Modify: `apps/web/src/app/api/v1/public/orgs/[orgSlug]/competitions/[slug]/register/route.ts`
- Modify: `apps/web/src/server/usecases/registrations.ts:236-274` (`RegistrationRow`), `:784-790` (signature), `:884-901` (insert)
- Test: `apps/web/src/server/usecases/__tests__/registration-user-link.test.ts` (create)

**Interfaces:**
- Consumes: Task 1's `registrations.user_id` column.
- Produces: `submitRegistration(orgSlug, compSlug, input, origin, opts?: { locale?: Locale | null; sessionUserId?: string | null })`; `RegistrationRow.user_id: string | null`; request fields `registering_self?: boolean` and `players[].self?: boolean`.

- [ ] **Step 1: Write the failing test**

Create `registration-user-link.test.ts`. Reuse `seedOpenDivision` / `seedOrg` exactly as `persons-identity.test.ts` does (copy the helper — it is 30 lines and duplicating it keeps the two suites independent).

```ts
async function submitAs(
  div: { divisionId: string; orgSlug: string; compSlug: string },
  over: Partial<Parameters<typeof submitRegistration>[2]>,
  sessionUserId: string | null,
) {
  return submitRegistration(
    div.orgSlug,
    div.compSlug,
    {
      division_id: div.divisionId,
      display_name: "Sam Player",
      contact_email: `sam-${randomUUID().slice(0, 8)}@test.local`,
      dob: null,
      gender: null,
      guardian_name: null,
      guardian_consent: false,
      privacy_consent: true,
      answers: {},
      players: [],
      ...over,
    },
    "http://test.local",
    { sessionUserId },
  );
}

async function linkedUser(registrationId: string): Promise<string | null> {
  const [row] = await sql<{ user_id: string | null }[]>`
    select user_id from registrations where id = ${registrationId}`;
  return row.user_id;
}

describe.skipIf(!HAS_DB)("registration session capture (#402)", () => {
  it("signed out ⇒ user_id null", async () => {
    const { auth } = await seedOrg("pro");
    const div = await seedOpenDivision(auth);
    const res = await submitAs(div, {}, null);
    expect(await linkedUser(res.registration.id)).toBeNull();
  });

  it("signed in but NOT affirmed ⇒ user_id null (opt-in, never inferred)", async () => {
    const { auth } = await seedOrg("pro");
    const div = await seedOpenDivision(auth);
    const userId = await makeUser();
    const res = await submitAs(div, {}, userId);
    expect(await linkedUser(res.registration.id)).toBeNull();
  });

  it("signed in and affirmed ⇒ user_id captured", async () => {
    const { auth } = await seedOrg("pro");
    const div = await seedOpenDivision(auth);
    const userId = await makeUser();
    const res = await submitAs(div, { registering_self: true }, userId);
    expect(await linkedUser(res.registration.id)).toBe(userId);
  });

  it("affirmed BUT guardian_name present ⇒ user_id null (server-side veto)", async () => {
    const { auth } = await seedOrg("pro");
    const div = await seedOpenDivision(auth);
    const userId = await makeUser();
    const res = await submitAs(
      div,
      { registering_self: true, guardian_name: "Grace Guardian" },
      userId,
    );
    expect(await linkedUser(res.registration.id)).toBeNull();
  });

  it("affirmed BUT guardian_consent true ⇒ user_id null (server-side veto)", async () => {
    const { auth } = await seedOrg("pro");
    const div = await seedOpenDivision(auth);
    const userId = await makeUser();
    const res = await submitAs(
      div,
      { registering_self: true, guardian_consent: true },
      userId,
    );
    expect(await linkedUser(res.registration.id)).toBeNull();
  });
});
```

`makeUser()` is a local helper:

```ts
async function makeUser(): Promise<string> {
  const [u] = await sql<{ id: string }[]>`
    insert into users (email, display_name, password_hash)
    values (${`u-${randomUUID().slice(0, 8)}@test.local`}, 'Session User', 'x')
    returning id`;
  return u.id;
}
```

Check the real `users` column list before running — if `password_hash` is not the column name, match what the table has.

- [ ] **Step 2: Run to verify it fails**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/reg-person-402 && \
DATABASE_URL="postgresql://postgres@127.0.0.1:54341/seazn_test" DATABASE_SSL=disable \
npm test --workspace apps/web -- run src/server/usecases/__tests__/registration-user-link.test.ts \
  --reporter=json --outputFile=/tmp/t2.json > /dev/null 2>&1; \
node -e 'const r=require("/tmp/t2.json");console.log(r.numPassedTests,"/",r.numTotalTests,"failedSuites",r.numFailedTestSuites)'
```

Expected: FAIL — `submitRegistration` takes no `sessionUserId`, so TypeScript rejects the call and the suite fails to collect (`numTotalTests` 0, `numFailedTestSuites` 1). That is the expected red here; do not read it as green.

- [ ] **Step 3: Implement**

In `schemas.ts`, inside `PublicRegisterRequest`:

```ts
  /** #402 — the registrant affirms this entry is for THEMSELVES. Only then may
   *  the session be captured. Never inferred from being signed in: a guardian,
   *  spouse or team captain is signed in too. */
  registering_self: z.boolean().default(false),
```

and add `self` to the `players` element:

```ts
      z.object({
        name: z.string().min(1).max(120),
        dob: z.iso.date().nullish(),
        squad_number: z.number().int().min(0).max(999).nullish(),
        /** #402 — the submitter declaring which roster row is them. At most one. */
        self: z.boolean().optional(),
      }),
```

Add a `superRefine` on `PublicRegisterRequest` so the declaration cannot be incoherent:

```ts
.superRefine((v, ctx) => {
  const selves = v.players.filter((p) => p.self).length;
  if (selves > 1) {
    ctx.addIssue({ code: "custom", path: ["players"], message: "Only one roster entry may be marked as yourself" });
  }
  if (selves > 0 && !v.registering_self) {
    ctx.addIssue({ code: "custom", path: ["players"], message: "Marking a roster entry as yourself requires registering_self" });
  }
});
```

In the route, above the `submitRegistration` call:

```ts
import { getCurrentUser } from "@/lib/auth";
...
    const sessionUser = await getCurrentUser();
    const result = await submitRegistration(orgSlug, slug, input, baseUrl(req), {
      locale: explicitLocale(req),
      sessionUserId: sessionUser?.id ?? null,
    });
```

In `registrations.ts`: add `user_id: string | null;` to `RegistrationRow`; widen the signature to `opts?: { locale?: Locale | null; sessionUserId?: string | null }`; and derive the link before the insert:

```ts
  // #402 — the session is captured ONLY under an explicit affirmation with no
  // guardian involvement. A signed-in guardian registering two children shares
  // one user_id, so an inferred link would merge siblings exactly as
  // contact_email would. The veto lives here, server-side, so a forged request
  // cannot reach the person resolver.
  const linkUserId =
    opts?.sessionUserId && input.registering_self && !input.guardian_name && !input.guardian_consent
      ? opts.sessionUserId
      : null;
```

Add `user_id` to the insert column list at `:884-901`, passing `${linkUserId}`, and add `user_id` to every `select` that hydrates a `RegistrationRow` (grep `-a` for `from registrations` in this file and widen each projection that builds the row).

- [ ] **Step 4: Run to verify it passes**

Re-run the Step 2 command. Expected: 5/5 passed, `numFailedTestSuites` 0.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server/api-v1/schemas.ts \
        "apps/web/src/app/api/v1/public/orgs/[orgSlug]/competitions/[slug]/register/route.ts" \
        apps/web/src/server/usecases/registrations.ts \
        apps/web/src/server/usecases/__tests__/registration-user-link.test.ts
git commit -m "feat(registrations): capture the session user under an affirmation + guardian veto (#402)"
```

---

### Task 3: `materialise` resolves the player lane

**Files:**
- Modify: `apps/web/src/server/usecases/registrations.ts:391-426` (`materialise`)
- Test: `apps/web/src/server/usecases/__tests__/registration-user-link.test.ts` (append)

**Interfaces:**
- Consumes: Task 1's index, Task 2's `RegistrationRow.user_id` and `players[].self`.
- Produces: no new exports — `materialise` stays private.

- [ ] **Step 1: Write the failing test**

Append. `seedOpenDivision` must be parameterised to take an `entrant_kind` for the team case — change the helper to `seedOpenDivision(auth, entrantKind: "individual" | "team" = "individual")` and pass it through to `putRegistrationSettings`.

```ts
describe.skipIf(!HAS_DB)("person resolution by (org_id, user_id, 'player') (#402)", () => {
  it("THE headline: one signed-in registrant, two divisions ⇒ ONE persons row", async () => {
    const { auth } = await seedOrg("pro");
    const divA = await seedOpenDivision(auth);
    const divB = await seedOpenDivision(auth);
    const userId = await makeUser();
    const before = await personCount(auth.orgId);

    const a = await submitAs(divA, { registering_self: true }, userId);
    const b = await submitAs(divB, { registering_self: true }, userId);
    const ca = await confirmRegistration(auth, a.registration.id);
    const cb = await confirmRegistration(auth, b.registration.id);

    expect(await personCount(auth.orgId)).toBe(before + 1);

    const members = await sql<{ person_id: string }[]>`
      select person_id from entrant_members
       where entrant_id in (${ca.entrant_id as string}, ${cb.entrant_id as string})`;
    expect(members).toHaveLength(2);
    expect(members[0].person_id).toBe(members[1].person_id);
  });

  it("the resolved person keeps its OWN data — a later entry never overwrites it", async () => {
    const { auth } = await seedOrg("pro");
    const divA = await seedOpenDivision(auth);
    const divB = await seedOpenDivision(auth);
    const userId = await makeUser();

    const a = await submitAs(divA, { registering_self: true, display_name: "Original Name", dob: "1990-01-01" }, userId);
    await confirmRegistration(auth, a.registration.id);
    const b = await submitAs(divB, { registering_self: true, display_name: "Typo Nmae", dob: "1991-02-02" }, userId);
    await confirmRegistration(auth, b.registration.id);

    const [person] = await sql<{ full_name: string; dob: string | null }[]>`
      select full_name, dob from persons
       where org_id = ${auth.orgId} and user_id = ${userId} and lane = 'player'`;
    expect(person.full_name).toBe("Original Name");
    expect(person.dob).toBe("1990-01-01");
  });

  it("anonymous registrations still mint a fresh person each time", async () => {
    const { auth } = await seedOrg("pro");
    const div = await seedOpenDivision(auth);
    const before = await personCount(auth.orgId);
    const one = await submitAs(div, { display_name: "Anon A" }, null);
    const two = await submitAs(div, { display_name: "Anon B" }, null);
    await confirmRegistration(auth, one.registration.id);
    await confirmRegistration(auth, two.registration.id);
    expect(await personCount(auth.orgId)).toBe(before + 2);
  });

  it("a signed-in guardian entering two children still gets TWO persons", async () => {
    const { auth } = await seedOrg("pro");
    const div = await seedOpenDivision(auth);
    const userId = await makeUser();
    const email = `guardian-${randomUUID().slice(0, 8)}@test.local`;
    const before = await personCount(auth.orgId);

    for (const [name, dob] of [["Ada Child", "2014-03-02"], ["Bob Child", "2016-09-11"]] as const) {
      const r = await submitAs(
        div,
        {
          display_name: name,
          contact_email: email,
          dob,
          registering_self: true,       // even if the form said yes
          guardian_name: "Grace Guardian",
          guardian_consent: true,
        },
        userId,                          // ...and even signed in as one parent
      );
      await confirmRegistration(auth, r.registration.id);
    }

    // The permanent anti-merge guard, now in its user_id form.
    expect(await personCount(auth.orgId)).toBe(before + 2);
  });

  it("team roster: only the declared `self` entry resolves; the rest insert fresh", async () => {
    const { auth } = await seedOrg("pro");
    const divA = await seedOpenDivision(auth, "team");
    const divB = await seedOpenDivision(auth, "team");
    const userId = await makeUser();

    const players = [
      { name: "Cap Tain", self: true },
      { name: "Team Mate One" },
      { name: "Team Mate Two" },
    ];
    const a = await submitAs(divA, { registering_self: true, players }, userId);
    const b = await submitAs(divB, { registering_self: true, players }, userId);
    const ca = await confirmRegistration(auth, a.registration.id);
    const cb = await confirmRegistration(auth, b.registration.id);

    const [{ n }] = await sql<{ n: string }[]>`
      select count(*)::text as n from persons
       where org_id = ${auth.orgId} and user_id = ${userId} and lane = 'player'`;
    expect(Number(n)).toBe(1);

    const rows = await sql<{ entrant_id: string; person_id: string }[]>`
      select entrant_id, person_id from entrant_members
       where entrant_id in (${ca.entrant_id as string}, ${cb.entrant_id as string})`;
    expect(rows).toHaveLength(6);
    const shared = rows.filter((r) => r.person_id === rows[0].person_id);
    // The captain's person is the only one appearing on both entrants.
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.person_id, (counts.get(r.person_id) ?? 0) + 1);
    expect([...counts.values()].filter((c) => c === 2)).toHaveLength(1);
    expect(shared.length).toBeGreaterThan(0);
  });

  it("two concurrent affirmed registrations ⇒ still ONE persons row", async () => {
    const { auth } = await seedOrg("pro");
    const divA = await seedOpenDivision(auth);
    const divB = await seedOpenDivision(auth);
    const userId = await makeUser();
    const before = await personCount(auth.orgId);

    const a = await submitAs(divA, { registering_self: true }, userId);
    const b = await submitAs(divB, { registering_self: true }, userId);
    await Promise.all([
      confirmRegistration(auth, a.registration.id),
      confirmRegistration(auth, b.registration.id),
    ]);

    expect(await personCount(auth.orgId)).toBe(before + 1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Re-run the Task 2 Step 2 command (same file). Expected: the headline test FAILS with `before + 2` received where `before + 1` expected.

- [ ] **Step 3: Implement**

Replace the two insert sites in `materialise`. Add a private helper above it:

```ts
/**
 * #402 — resolve the registrant's player-lane person, or create it.
 *
 * The upsert (not select-then-insert) is what closes the race: two divisions
 * confirmed concurrently by one signed-in registrant both miss a select, and
 * both insert. Here `persons_org_user_lane_uq` arbitrates and the loser is
 * handed the winner's id. `do update set full_name = persons.full_name` is a
 * deliberate no-op — `do nothing` returns no row, and the existing person's own
 * data must win, so a later entry never overwrites full_name/dob/gender. A
 * divergence is a signal for #404's review queue, never an in-place edit.
 */
async function resolvePlayerPerson(
  tx: Tx,
  orgId: string,
  userId: string,
  fullName: string,
  dob: string | null,
  gender: string | null,
): Promise<string> {
  const [person] = await tx<{ id: string }[]>`
    insert into persons (org_id, full_name, dob, gender, user_id, lane)
    values (${orgId}, ${fullName}, ${dob}, ${gender}, ${userId}, 'player')
    on conflict (org_id, user_id, lane) where user_id is not null
    do update set full_name = persons.full_name
    returning id`;
  return person.id;
}
```

Individual path:

```ts
  if (entrantKind === "individual") {
    const personId = reg.user_id
      ? await resolvePlayerPerson(tx, reg.org_id, reg.user_id, reg.display_name, reg.dob, reg.gender)
      : (
          await tx<{ id: string }[]>`
            insert into persons (org_id, full_name, dob, gender)
            values (${reg.org_id}, ${reg.display_name}, ${reg.dob}, ${reg.gender})
            returning id`
        )[0].id;
    await tx`
      insert into entrant_members (entrant_id, person_id)
      values (${entrant.id}, ${personId})
      on conflict (entrant_id, person_id) do nothing`;
  }
```

Team path — inside the roster loop:

```ts
      const personId =
        reg.user_id && p.self
          ? await resolvePlayerPerson(tx, reg.org_id, reg.user_id, name, p.dob ?? null, null)
          : (
              await tx<{ id: string }[]>`
                insert into persons (org_id, full_name, dob)
                values (${reg.org_id}, ${name}, ${p.dob ?? null})
                returning id`
            )[0].id;
```

`reg.roster` entries must carry `self`, so widen the `roster` element type on `RegistrationRow` with `self?: boolean` and confirm the submit insert persists `players` into `roster` verbatim (grep `-a` for `roster` in the insert at `:884-901`).

Note the added `on conflict (entrant_id, person_id) do nothing` on the individual path: with a resolved person, re-confirming the same division would otherwise violate the `entrant_members` primary key.

- [ ] **Step 4: Run to verify it passes**

Re-run. Expected: 11/11 passed in this file, `numFailedTestSuites` 0. Then re-run `persons-identity.test.ts` and confirm the original guardian test is still green.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server/usecases/registrations.ts \
        apps/web/src/server/usecases/__tests__/registration-user-link.test.ts
git commit -m "feat(registrations): resolve the player-lane person instead of minting one (#402)"
```

---

### Task 4: `acceptResolvedClaim` returns 409, not 500

**Files:**
- Modify: `apps/web/src/server/usecases/person-claims.ts:211-225`
- Test: `apps/web/src/server/usecases/__tests__/person-claims.test.ts` (append; create if absent)

**Interfaces:**
- Consumes: Task 1's index.
- Produces: error code `PERSON_ALREADY_LINKED` on `HttpError(409)`.

This is the failure mode the owner's revert cited by name. The lane column removes the player-vs-official collision entirely; what remains is a user claiming a *second player* person in one org — the exact duplicate #402 exists to eliminate — so it must surface as a clean conflict pointing at the merge route, never a 500 carrying a constraint name.

- [ ] **Step 1: Write the failing test**

```ts
it("a second player-lane claim in one org is a 409, not a constraint 500 (#402)", async () => {
  const { auth } = await seedOrg("pro");
  const userId = await makeUser();
  const [first] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name, user_id, lane)
    values (${auth.orgId}, 'Already Linked', ${userId}, 'player') returning id`;
  const [second] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name, lane)
    values (${auth.orgId}, 'Duplicate Of Them', 'player') returning id`;

  const [claim] = await sql<{ id: string }[]>`
    insert into person_claims (org_id, person_id, email, token_hash)
    values (${auth.orgId}, ${second.id}, 'dup@test.local', ${randomUUID()})
    returning id`;

  await expect(
    acceptResolvedClaim(
      { id: claim.id, person_id: second.id, org_id: auth.orgId } as never,
      userId,
    ),
  ).rejects.toMatchObject({ status: 409, code: "PERSON_ALREADY_LINKED" });

  // The first link is untouched.
  const [{ n }] = await sql<{ n: string }[]>`
    select count(*)::text as n from persons
     where user_id = ${userId} and lane = 'player' and id = ${first.id}`;
  expect(Number(n)).toBe(1);
});
```

Match the real `person_claims` column list and the real `ResolvedClaim` shape before running — read `person-claims.ts` around `:180-225` and adapt the inserts, not the assertion.

- [ ] **Step 2: Run to verify it fails**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/reg-person-402 && \
DATABASE_URL="postgresql://postgres@127.0.0.1:54341/seazn_test" DATABASE_SSL=disable \
npm test --workspace apps/web -- run src/server/usecases/__tests__/person-claims.test.ts \
  --reporter=json --outputFile=/tmp/t4.json > /dev/null 2>&1; \
node -e 'const r=require("/tmp/t4.json");console.log(r.numPassedTests,"/",r.numTotalTests,"failedSuites",r.numFailedTestSuites)'
```

Expected: FAIL with a raw postgres error mentioning `persons_org_user_lane_uq`, not an `HttpError`.

- [ ] **Step 3: Implement**

```ts
export async function acceptResolvedClaim(claim: ResolvedClaim, userId: string): Promise<ResolvedClaim> {
  try {
    await sql.begin(async (tx) => {
      const [updated] = await tx<{ id: string }[]>`
        update persons set user_id = ${userId}
        where id = ${claim.person_id} and user_id is null
        returning id`;
      if (!updated) {
        throw new HttpError(409, "This profile has already been claimed", "CLAIM_CLAIMED");
      }
      await tx`
        update person_claims set claimed_at = now()
        where id = ${claim.id} and claimed_at is null`;
    });
  } catch (e) {
    // #402 — persons_org_user_lane_uq. The lane column means a player and an
    // official profile no longer collide; the only remaining collision is two
    // PLAYER persons for one human in one org, which is the duplicate #402
    // exists to eliminate. Route it to the merge tool (#404), never a 500.
    if (isUniqueViolation(e, "persons_org_user_lane_uq")) {
      throw new HttpError(
        409,
        "You already have a player profile in this organisation",
        "PERSON_ALREADY_LINKED",
      );
    }
    throw e;
  }
  return claim;
}
```

Add the helper next to it (check whether `lib/errors.ts` already exports one — grep `-a` for `23505` before writing a duplicate):

```ts
function isUniqueViolation(e: unknown, constraint: string): boolean {
  return (
    typeof e === "object" && e !== null &&
    (e as { code?: string }).code === "23505" &&
    String((e as { constraint_name?: string }).constraint_name ?? (e as { constraint?: string }).constraint ?? "") === constraint
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Re-run Step 2. Expected: PASS. Then run `me.test.ts` and confirm the official-only entitlement test at `:162` is still green.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server/usecases/person-claims.ts \
        apps/web/src/server/usecases/__tests__/person-claims.test.ts
git commit -m "fix(person-claims): a duplicate player link is a 409, not a constraint 500 (#402)"
```

---

### Task 5: the affirmation on the public form, in four locales

**Files:**
- Modify: `apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/register/page.tsx` and whichever client component holds the form (locate it from that page; do not restructure it)
- Modify: all four locale dictionaries (find them with `ls apps/web/src/**/locales/` or `grep -ra "registration." <dict path>`)
- Test: `apps/web/e2e/` (Task 6) plus a component-level assertion if the form already has one

**Interfaces:**
- Consumes: Task 2's request fields.
- Produces: form posts `registering_self` and `players[].self`.

**Load the frontend-design skill before writing any JSX.** This is a user-facing public surface and keeps full polish.

- [ ] **Step 1: Add the strings to all four dictionaries**

Flat dotted keys, matching the surrounding `register.*` namespace:

- `register.self.label` — "I'm registering myself"
- `register.self.hint` — "Links this entry to your account so your results stay together across divisions."
- `register.self.rosterLabel` — "Which of these is you?"
- `register.self.rosterNone` — "None of them"

Translate for all four locales; never leave English in a non-English dictionary.

- [ ] **Step 2: Render the controls**

- The checkbox renders **only** when a session exists. Pass the signed-in state into the form from the server component; do not fetch it client-side.
- Default **unchecked** — the safe state is "no link".
- The roster select renders only when the checkbox is on **and** the form is in team mode, listing the roster names already typed, plus a "None of them" option that clears `self`.
- Both controls hide when guardian fields are filled, matching the server veto.
- Touch targets ≥44px; the select must not overflow at 375px.

- [ ] **Step 3: Verify at both widths**

Use Playwright MCP. Screenshot the form at desktop (1280) and 375px, signed out and signed in. Confirm no horizontal page scroll:

```js
document.documentElement.scrollWidth <= document.documentElement.clientWidth
```

- [ ] **Step 4: i18n gate**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/reg-person-402 && npm run i18n:check
```

Expected: no missing keys in any of the four locales.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app "apps/web/src/**/locales"
git commit -m "feat(register): an explicit 'registering myself' affirmation, four locales (#402)"
```

---

### Task 6: help, smoke, e2e, OpenAPI, and the full gate

**Files:**
- Modify: the registration help article under `content/help/**` (English only)
- Modify: `apps/web/src/lib/smoke.ts` (or wherever the smoke demo lives — grep `-a` for the registration scenario)
- Create: an e2e spec under `apps/web/e2e/`
- Modify: `openapi/*.json` (regenerated, not hand-edited)

- [ ] **Step 1: Regenerate OpenAPI**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/reg-person-402 && \
npm run openapi:gen && git diff --stat openapi/
```

`PublicRegisterRequest` changed, so a diff is expected. A *missing* diff means the generator did not pick the schema up — investigate rather than proceed. The drift gate is CI-only; committing the regenerated file is the whole point.

- [ ] **Step 2: Help article**

Document that signing in and ticking "I'm registering myself" keeps results together across divisions, and that registering a child (guardian details filled) deliberately creates a separate person. One English tree; no i18n owed.

- [ ] **Step 3: Smoke**

Add a step asserting an affirmed signed-in registration across two divisions yields one person. Behaviour changed, so smoke must change with it.

- [ ] **Step 4: E2E**

Prod build + `E2E_PROD_TARGET` per the `seazn-local-env` recipe (§3 — `output: standalone`, so `next start` serves the wrong server while returning 200). Drive the public form signed in, tick the affirmation, submit, confirm, and assert one person. **Never enable `.github/workflows/e2e.yml`.**

- [ ] **Step 5: Full gate, serially, on a quiescent tree**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/reg-person-402 && \
git status --porcelain && \
DATABASE_URL="postgresql://postgres@127.0.0.1:54341/seazn_test" DATABASE_SSL=disable \
npm test --workspace apps/web -- run --reporter=json --outputFile=/tmp/full.json > /dev/null 2>&1; \
node -e 'const r=require("/tmp/full.json");console.log("pass",r.numPassedTests,"fail",r.numFailedTests,"total",r.numTotalTests,"failedSuites",r.numFailedTestSuites)'
```

Then lint (via `rtk proxy`, reading the `✖ N problems` line — `rtk` swallows lint output) and `tsc`. Note `apps/web` typecheck peaks ~2.8 GB; run it alone.

- [ ] **Step 6: Open the PR**

Smoke CI runs on **PRs only** — merging locally and pushing to `main` skips it. The PR body states the #396 dependency was reverted and how this plan restores it.

---

## Self-Review

**Spec coverage.** §2 decision 1 → Task 1. §2 decision 2 → Task 2 (veto) + Task 5 (affirmation UI). §2 decision 3 → Task 3 (team `self`) + Task 5 (roster select). §3 schema → Task 1. §4 capture → Task 2; resolve → Task 3; `inviteOfficial` → Task 1; `acceptResolvedClaim` → Task 4. §5 UI → Task 5. §6 testing → every task's test block plus Task 6 for e2e/smoke. §7 out of scope → nothing implemented against it.

**Placeholders.** None: every code step carries real code, and the three "check the real shape first" notes name the exact file and line range to check rather than deferring a decision.

**Type consistency.** `resolvePlayerPerson(tx, orgId, userId, fullName, dob, gender)` is defined in Task 3 and called only there. `linkUserId` is Task 2's local. `RegistrationRow.user_id` is introduced in Task 2 and consumed in Task 3. `registering_self` and `players[].self` are named identically in Tasks 2, 3 and 5. `PERSON_ALREADY_LINKED` appears only in Task 4.
