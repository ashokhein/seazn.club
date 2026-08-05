# Duplicate-person review queue + merge tool (#404) — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the merge that ships today with a reversible, audited,
consent-preserving one, and put an organiser-facing ranked review queue in front
of it so no merge happens without a human confirming it.

**Architecture:** A merge stops deleting. The absorbed row is tombstoned
(`persons.merged_into`, always naming a *live* person), every dependent row is
repointed under a per-table collision rule, and a `person_merges` row stores a
full JSONB snapshot — which is what makes reversal possible at any time. Consent
resolves per flag to the stricter value. Published boards are re-verified after
the merge, reporting conflicts without blocking it.

**Tech Stack:** Postgres via Flyway (`db/migration/deltas`), `postgres` tagged
templates behind `withTenant`, Next.js app router, vitest (DB-backed),
Playwright, 4 flat-key locale dictionaries.

**Spec:** `docs/superpowers/specs/2026-08-04-duplicate-person-merge-design.md` —
read it before Task 1. Requirements: #403's comment on #404.

## Global Constraints

- Every change ships a test that fails without it. Four kinds across the wave:
  unit, e2e (Playwright), smoke, regression.
- **DB-backed suites MUST open with `const HAS_DB = !!process.env.DATABASE_URL;`
  and `describe.skipIf(!HAS_DB)`.** CI's unit job has no `DATABASE_URL`; omitting
  this failed CI on #470.
- Run tests **from `apps/web`**, judged only by
  `--reporter=json --outputFile` (`numPassedTests` / `numFailedTests` /
  `numFailedTestSuites`). A suite that fails to collect reports 0 failures.
  Running from the repo root gives `Cannot find package '@/lib/...'`.
- Test DB: `DATABASE_URL="postgresql://postgres@127.0.0.1:PORT/seazn_test"
  DATABASE_SSL=disable`, built with `npm run db:apply` **and** `npm run sync:sports`.
  Confirm `show data_directory` is yours — ports here are routinely squatted.
- Organiser-facing surface → full design polish. Load the `frontend-design` skill
  before Task 8. Screenshot desktop **and 375px**; assert
  `document.documentElement.scrollWidth === clientWidth`. Wide tables in
  `overflow-x: auto`.
- Load `supabase:supabase-postgres-best-practices` before Task 1.
- Every user-facing string in all 4 locales:
  `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`, flat dotted keys.
  `apps/web/content/help/**` is one English tree and owes no i18n work.
- Before every commit: `npm run openapi:gen` **and** `npm run i18n:gen-keys`, then
  `git status --porcelain` must be empty. Both are CI-only drift gates.
- `grep -a` always — this repo reports source files as "Binary file … matches".
- Never `rm -rf apps/web/.next` while a dev server is running.
- Never enable `.github/workflows/e2e.yml`.
- Worktree `.claude/worktrees/person-merge-404`, branch `person-merge-404`.
  Prefix `cd <abs worktree> &&` in the *same* call as any command you judge.

## File structure

| File | Responsibility |
|---|---|
| `db/migration/deltas/V349__person_merges.sql` | tombstone column, reissued identity index, `person_merges` ledger |
| `apps/web/src/server/usecases/person-merge.ts` | **new.** snapshot, consent resolution, repoint, flatten, tombstone, reverse |
| `apps/web/src/server/usecases/person-duplicates.ts` | **new.** ranked candidates + evidence |
| `apps/web/src/server/usecases/persons.ts` | `mergePersons` deleted from here; reads gain the tombstone filter |
| `apps/web/src/components/v2/duplicates-panel.tsx` | **new.** queue, confirm dialog, history |

`person-merge.ts` and `person-duplicates.ts` are separate because ranking is a
read with no writes and merging is a transaction with no ranking — they change for
different reasons, and the merge file is already the largest thing in this wave.

## Facts verified against `main` — do not re-derive

| Fact | Evidence |
|---|---|
| The merge being replaced | `apps/web/src/server/usecases/persons.ts:131-163`; route `app/api/v1/persons/[id]/merge/route.ts:9-15`; schema `api-v1/schemas.ts:297`; `openapi.ts:71` |
| `PersonRow` + `COLS` | `persons.ts:13`, `persons.ts:28` (`id, full_name, dob, gender, consent, external_ref, photo_path, user_id, created_at`) |
| Tenancy | `withTenant(auth.orgId, async (tx) => …)`, imported from `@/lib/db` (`persons.ts:6`). RLS is `force`d on every table below. |
| Identity index | `persons_org_user_lane_uq on persons(org_id,user_id,lane) where user_id is not null and lane='player'` — `V348:38-40` |
| Its `ON CONFLICT` twin | `registrations.ts:453-458` — the predicate must be repeated verbatim |
| `lane` | `V348:9-10`, `not null default 'player' check (lane in ('player','official'))` |
| Stats recompute | `recomputePlayerStats(tx, divisionId)` — `player-stats.ts:29`, already `on conflict (division_id, person_id) do update` |
| Verifier entry | `toVerifyConfig` exported at `schedule.ts:488`; `assertNoNewBlocking` (`schedule.ts:573`) is **module-private** |
| Key ban list | `NEVER_KEY_ROUTES` — `api-v1/key-scopes.ts:217` |
| Person UI home | `app/directory/page.tsx` + `components/v2/persons-panel.tsx` (NOT under `/o/[orgSlug]`) |
| `trg_set_org` | `V225:24-30`, **BEFORE INSERT only** |

Every table carrying `person_id`, with the constraint a repoint collides against:

| table | on delete | constraint | migration |
|---|---|---|---|
| `entrant_members` | cascade | PK `(entrant_id, person_id)` | `V213:3,9` |
| `player_profiles` | cascade | PK `(person_id, sport_key)` | `V205:2,6` |
| `lineups` | cascade | PK `(fixture_id, entrant_id, person_id)` | `V215:4,10` |
| `team_members` | cascade | PK `(team_id, person_id)` | `V257:9,15` |
| `player_stat_snapshots` | cascade | PK `(division_id, person_id)` | `V248:8,14` |
| `fixture_availability` | cascade | PK `(fixture_id, person_id)` | `V276:38,44` |
| `person_claims` | cascade | partial unique `(person_id) where claimed_at is null and revoked_at is null` | `V276:10,22` |
| `suspensions` | cascade | partial unique `(division_id, person_id, rule_key, bucket) where source in ('auto_accumulation','auto_dismissal')` | `V293:26,47` |
| `officials` | **set null** | FK only | `V243:11` |

---

### Task 1: V349 — tombstone column, identity index, merge ledger

**Files:**
- Create: `db/migration/deltas/V349__person_merges.sql`
- Test: `apps/web/src/server/usecases/__tests__/person-merge-schema.test.ts`

**Interfaces:**
- Produces: `persons.merged_into uuid`; table `person_merges (id, org_id,
  survivor_id, absorbed_id, actor_user_id, snapshot jsonb, created_at,
  reversed_at, reversed_by)`; the reissued `persons_org_user_lane_uq`.

- [ ] **Step 1: Write the migration**

```sql
-- V349 — #404. A merge must be reversible (Art. 16 rectification), so the
-- absorbed person is TOMBSTONED rather than deleted: six dependent tables are
-- `on delete cascade`, and deleting the row destroys discipline history, stats,
-- team memberships, account claims and RSVPs with it.
alter table persons add column if not exists merged_into uuid references persons(id) on delete set null;
comment on column persons.merged_into is
  '#404: set when this person was absorbed by another. Non-null = tombstone: '
  'hidden from every roster read and public view, kept so the merge can be '
  'undone. Always points at a LIVE person — chains are flattened on merge.';

-- A tombstone must not hold the identity slot: the survivor now owns the
-- (org_id, user_id) pair and the next registration has to land on it. The
-- ON CONFLICT at registrations.ts:456 must repeat this predicate VERBATIM —
-- Postgres only infers a partial index whose predicate the statement implies.
drop index if exists persons_org_user_lane_uq;
create unique index persons_org_user_lane_uq
  on persons (org_id, user_id, lane)
  where user_id is not null and lane = 'player' and merged_into is null;

-- The audit trail AND the undo record.
create table if not exists person_merges (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id) on delete cascade,
  survivor_id   uuid not null references persons(id) on delete cascade,
  absorbed_id   uuid not null references persons(id) on delete cascade,
  actor_user_id uuid references users(id) on delete set null,
  -- Full prior state of BOTH persons rows plus every dependent row moved or
  -- resolved, as {table: [row, …]}. A diff is not enough: reversal has to
  -- reconstruct rows that were merged away, not just flip a pointer.
  snapshot      jsonb not null,
  created_at    timestamptz not null default now(),
  reversed_at   timestamptz,
  reversed_by   uuid references users(id) on delete set null,
  check (survivor_id <> absorbed_id)
);
create index if not exists person_merges_org_idx on person_merges (org_id, created_at desc);
-- One LIVE merge per absorbed person; a reversed one may be superseded.
create unique index if not exists person_merges_absorbed_live_uq
  on person_merges (absorbed_id) where reversed_at is null;

alter table person_merges enable row level security;
alter table person_merges force  row level security;
drop policy if exists person_merges_tenant on person_merges;
create policy person_merges_tenant on person_merges for all to app_user
  using (org_id = current_org_id()) with check (org_id = current_org_id());
grant select, insert, update, delete on person_merges to app_user;

comment on table person_merges is
  '#404: one row per person merge. Holds the snapshot that makes the merge '
  'reversible at any time, and is itself the audit trail (#403 R2/R3).';
```

- [ ] **Step 2: Write the failing test**

```ts
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)("#404 V349 schema", () => {
  let orgId: string;
  beforeEach(async () => {
    const { auth } = await seedOrg("pro");
    orgId = auth.orgId;
  });
  afterAll(async () => {
    if (orgId) await sql`delete from person_merges where org_id = ${orgId}`;
  });

  const person = async (userId: string | null, mergedInto: string | null = null) => {
    const [row] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name, user_id, lane, merged_into)
      values (${orgId}, 'Alex Morgan', ${userId}, 'player', ${mergedInto})
      returning id`;
    return row!.id;
  };

  it("a tombstoned person frees the identity slot", async () => {
    // Without `and merged_into is null` in the index predicate the second
    // insert throws 23505 and a merged duplicate blocks the human's next
    // registration forever.
    const [{ id: userId }] = await sql<{ id: string }[]>`
      insert into users (email) values (${`m-${randomUUID()}@test.local`}) returning id`;
    const survivor = await person(userId);
    await expect(person(userId, survivor)).resolves.toBeTruthy();
  });

  it("refuses a second live merge for one absorbed person", async () => {
    const a = await person(null);
    const b = await person(null);
    const c = await person(null);
    const insert = (survivor: string) => sql`
      insert into person_merges (org_id, survivor_id, absorbed_id, snapshot)
      values (${orgId}, ${survivor}, ${a}, '{}'::jsonb)`;
    await insert(b);
    await expect(insert(c)).rejects.toThrow(/person_merges_absorbed_live_uq|duplicate key/);
  });

  it("allows a fresh merge once the prior one is reversed", async () => {
    const a = await person(null);
    const b = await person(null);
    const c = await person(null);
    await sql`insert into person_merges (org_id, survivor_id, absorbed_id, snapshot, reversed_at)
              values (${orgId}, ${b}, ${a}, '{}'::jsonb, now())`;
    await expect(sql`
      insert into person_merges (org_id, survivor_id, absorbed_id, snapshot)
      values (${orgId}, ${c}, ${a}, '{}'::jsonb)`).resolves.toBeTruthy();
  });

  it("refuses a merge of a person into itself", async () => {
    const a = await person(null);
    await expect(sql`
      insert into person_merges (org_id, survivor_id, absorbed_id, snapshot)
      values (${orgId}, ${a}, ${a}, '{}'::jsonb)`).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run to verify it fails**

```bash
cd <worktree>/apps/web && DATABASE_URL="postgresql://postgres@127.0.0.1:PORT/seazn_test" \
  DATABASE_SSL=disable npx vitest run src/server/usecases/__tests__/person-merge-schema.test.ts \
  --reporter=json --outputFile=/tmp/t1.json
node -e "const r=require('/tmp/t1.json');console.log(r.numPassedTests,r.numFailedTests,r.numFailedTestSuites)"
```
Expected: the suite fails to collect / every test errors — `relation "person_merges" does not exist`.

- [ ] **Step 4: Apply and re-run**

```bash
cd <worktree> && DATABASE_URL=… DATABASE_SSL=disable npm run db:apply
```
Then the Step 3 command. Expected: 4 passed, 0 failed.

- [ ] **Step 5: Commit**

```bash
git add db/migration/deltas/V349__person_merges.sql apps/web/src/server/usecases/__tests__/person-merge-schema.test.ts
git commit -m "db(V349): tombstone column and person_merges ledger (#404)"
```

---

### Task 2: Tombstones vanish from every read

**Files:**
- Modify: `apps/web/src/server/usecases/persons.ts` — every read of `persons`
- Modify: `apps/web/src/server/usecases/registrations.ts:456` — `ON CONFLICT`
  predicate gains `and merged_into is null`
- Create: `db/migration/deltas/V350__person_tombstone_views.sql` — recreate
  `public_entrants_v` (`V289`) and `public_players_v` (`V307`) with the filter.
  **A NEW migration, never an edit to V349** — V349 is already applied, and
  Flyway validates the checksum of an applied migration, so editing it fails
  `db:apply` for everyone including CI.
- Test: `apps/web/src/server/usecases/__tests__/person-tombstone-reads.test.ts`

**Interfaces:**
- Consumes: `persons.merged_into` (Task 1).
- Produces: the invariant every later task assumes — *a tombstone is invisible to
  every read except the merge history.*

- [ ] **Step 1: Write the failing test**

```ts
const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)("#404 tombstones are invisible", () => {
  it("listPersons omits a tombstoned person", async () => {
    // seed two persons, tombstone one, assert the page contains only the survivor
  });

  it("neither public view exposes a tombstoned person", async () => {
    // select from public_entrants_v / public_players_v for the org
  });

  it("a registration upsert lands on the survivor, not the tombstone", async () => {
    // resolvePlayerPerson-style insert for the same (org_id, user_id, 'player')
    // must return the SURVIVOR id and must not throw 23505.
  });
});
```

- [ ] **Step 2: Run — expect red on all three.**

- [ ] **Step 3: Add the filter everywhere**

`grep -an "from persons" apps/web/src | grep -av "__tests__"` and add
`and merged_into is null` to every read. There is **no type-level protection
here — the grep is the coverage.** Then in `registrations.ts`:

```ts
    on conflict (org_id, user_id, lane)
      where user_id is not null and lane = 'player' and merged_into is null
    do update set full_name = persons.full_name
```

And write the two view recreations into a **new** `V350__person_tombstone_views.sql`,
copying each view's existing body from `V289__entrant_badge_public_view.sql` /
`V307__public_players_ungated.sql` and adding `and p.merged_into is null` to its
person join. Do **not** edit V349 — it is applied, and Flyway validates checksums
of applied migrations.

- [ ] **Step 4: Run — expect 3 passed. Then run the FULL suite**, because this
  changes a read every roster surface depends on:

```bash
cd <worktree>/apps/web && DATABASE_URL=… DATABASE_SSL=disable npx vitest run \
  --reporter=json --outputFile=/tmp/full.json
node -e "const r=require('/tmp/full.json');console.log(r.numPassedTests,'/',r.numTotalTests,'fail',r.numFailedTests)"
```
Expected: 0 failed. Baseline on `main` at the time of writing was 5331/5381.

- [ ] **Step 5: Commit**

```bash
git commit -am "persons: a tombstoned person is invisible to every read (#404)"
```

---

### Task 3: The safe merge

**Files:**
- Create: `apps/web/src/server/usecases/person-merge.ts`
- Modify: `apps/web/src/server/usecases/persons.ts` — **delete** `mergePersons`
  (`:131-163`)
- Test: `apps/web/src/server/usecases/__tests__/person-merge.test.ts`

**Interfaces:**
- Consumes: Tasks 1-2.
- Produces:

```ts
export interface MergeResult { merge_id: string; survivor: PersonRow }
export async function mergePersons(
  auth: AuthCtx,
  survivorId: string,
  absorbedId: string,
  opts: { confirmedBy: string; allowDobMismatch?: boolean },
): Promise<MergeResult>
```

- [ ] **Step 1: Write the failing tests** — one per rule, all DB-backed:

1. **Nothing is destroyed.** Seed the absorbed person with a `suspensions` row, a
   `team_members` row, an open `person_claims` row and a `fixture_availability`
   row; merge; assert each survives against the survivor. *This fails hard against
   the code as it stands — that is the point of it.*
2. **Consent resolves restrictive, per flag.** `{public_name:true,public_photo:true}`
   absorbing `{public_name:false,public_photo:true}` →
   `{public_name:false,public_photo:true}`. Assert **both directions** (restrictive
   as survivor, and as absorbed) so "survivor wins" cannot pass.
3. **`entrant_members` field-wise.** Both on one entrant; survivor
   `{is_captain:false, squad_number:null, roles:["gk"]}`, absorbed
   `{is_captain:true, squad_number:7, roles:["cap"]}` → one row,
   `is_captain:true`, `squad_number:7`, roles containing both.
4. **`player_stat_snapshots` recomputed.** Both carry a snapshot in one division;
   after the merge exactly one row exists for `(division_id, survivor)` and it
   equals a fresh `recomputePlayerStats(tx, divisionId)`.
5. **`person_claims`** — two open claims: survivor's stays open, absorbed's is
   **revoked with a reason**, and the partial unique is not violated.
6. **Cross-org merge is 422.**
7. **Two different non-null `user_id`s is 422**, naming both accounts.
8. **Same `user_id` on both is allowed** (one human, twice).
9. **Differing `dob` is 422 without `allowDobMismatch`, and succeeds with it.**
10. **Chain flattening** — `A.merged_into = B`, then merge B into C: assert
    `A.merged_into === C` and that A's row is in the second merge's snapshot.
11. **Absorbed row is tombstoned, not deleted** — the row still exists with
    `merged_into = survivor`.
12. **A `person_merges` row is written** with actor, both ids and a snapshot
    naming every table touched.
13. **Merging a tombstone (either side) is 409.**

- [ ] **Step 2: Run — expect the module not to resolve.**

- [ ] **Step 3: Implement** in `person-merge.ts`, in this order inside one
  `withTenant` transaction — a partial merge is worse than none:

```
guard (self / cross-org / two accounts / tombstone / dob)
  → snapshot both persons rows + every dependent row into `snapshot`
  → resolve consent onto the survivor (per flag: survivor && absorbed)
  → repoint each table under its rule (table below)
  → flatten: update persons set merged_into = survivor where merged_into = absorbed
  → tombstone: update persons set merged_into = survivor where id = absorbed
  → insert person_merges
```

Per-table rules, exactly as the spec §4.3 states them:

| table | rule |
|---|---|
| `entrant_members` | field-wise: `is_captain` = either, `roles` = union, `squad_number` = survivor's else absorbed's |
| `player_profiles` | survivor's profile wins per `sport_key`; absorbed's snapshotted |
| `lineups` | survivor's row kept; absorbed's snapshotted and dropped |
| `team_members` | survivor's row wins |
| `player_stat_snapshots` | delete both, then `recomputePlayerStats(tx, divisionId)` per affected division |
| `fixture_availability` | most recent response wins |
| `person_claims` | survivor's open claim kept; absorbed's revoked with a reason |
| `suspensions` | all move; on a partial-unique collision keep the earlier row, snapshot the other |
| `officials` | repointed only when `lane = 'official'` on both |

Then delete `mergePersons` from `persons.ts` and re-export the new one from
`person-merge.ts` so the API route keeps one import site.

- [ ] **Step 4: Run — expect all green.**
- [ ] **Step 5: Commit**

```bash
git commit -am "persons: a merge that preserves records and can be undone (#404)"
```

---

### Task 3b: Stats must follow the survivor across a refold

**Files:**
- Modify: `apps/web/src/server/usecases/player-stats.ts:61-62`
- Test: `apps/web/src/server/usecases/__tests__/player-stats-merged.test.ts`

**Why this task exists.** Spec §4.3 claimed `recomputePlayerStats` folds from
score events that "reference users rather than persons", so it would be
authoritative after a repoint. **That is wrong** — `sumPlayerStats` returns
`row.personId` read out of score-event *payloads* (`player-stats.ts:62`, written
at `:67-70`). A tombstoned person's id is still in every historical event, so a
refold rebuilds a snapshot row for the tombstone and the survivor never inherits
those stats. Every stats read refolds, so **no fix inside the merge transaction
can hold** — the relabel has to live in the fold.

**Interfaces:**
- Consumes: `persons.merged_into` (Task 1).
- Produces: nothing new; `recomputePlayerStats(tx, divisionId)` keeps its
  signature and gains correct behaviour across merges.

- [ ] **Step 1: Write the failing test** — score events naming person A; merge A
  into B; call `recomputePlayerStats`; assert exactly one snapshot row exists for
  the division, that it is keyed to **B**, and that it carries A's stats. Then a
  second case: events naming **both** A and B, merged — assert one row whose
  stats are the *sum*, not either half.
- [ ] **Step 2: Run — red** (the row comes back keyed to the tombstone).
- [ ] **Step 3: Implement** — relabel **before** summing, so the engine's own
  summation combines the two histories:

```ts
  const perFixture = [...byFixture.values()].map((ledger) => aggregatePlayerStats(ledger, model));
  // #404: a merged person's id still appears in every historical score event.
  // Relabel to the survivor BEFORE sumPlayerStats so the engine's own summation
  // combines both histories — relabelling after the sum would require
  // re-implementing that arithmetic here.
  const survivorOf = new Map<string, string>(
    (await tx<{ id: string; merged_into: string }[]>`
       select id, merged_into from persons
       where merged_into is not null and org_id = current_org_id()`)
      .map((r) => [r.id, r.merged_into]),
  );
  const relabelled = perFixture.map((agg) => relabelPersonIds(agg, survivorOf));
  const rows = sumPlayerStats(relabelled, model);
```

  Follow the chain to a live survivor if `merged_into` ever points at another
  tombstone — Task 3 flattens on merge, so one hop is the invariant, but assert
  it rather than assume it.
- [ ] **Step 4: Run — green.**
- [ ] **Step 5: Commit**

```bash
git commit -am "stats: a merged person's history follows the survivor (#404)"
```

---

### Task 4: Reversal

**Files:**
- Modify: `apps/web/src/server/usecases/person-merge.ts`
- Test: `apps/web/src/server/usecases/__tests__/person-merge-reverse.test.ts`

**Interfaces:**
- Produces:
  `reverseMerge(auth: AuthCtx, mergeId: string, opts: { confirmedBy: string }): Promise<void>`

- [ ] **Step 1: Write the failing tests**

1. **Round trip — the most important test in the wave.** Capture the full state of
   both people and every dependent table; merge; reverse; assert the state is
   identical to what was captured.
2. Reversal restores the **absorbed person's own consent flags**, undoing the
   restrictive resolution applied to the survivor.
3. Reversing an already-reversed merge is **409**.
4. Rows created **after** the merge stay with the survivor; only snapshotted rows
   move back.
5. Chain restore — after A→B then B→C, reversing B→C leaves `A.merged_into = B`.
6. `reversed_at` / `reversed_by` are stamped and the row is kept, never deleted.

- [ ] **Step 2: Run — red.**
- [ ] **Step 3: Implement** — replay the snapshot backwards inside one
  `withTenant` transaction, then stamp `reversed_at`/`reversed_by`.
- [ ] **Step 4: Run — green.**
- [ ] **Step 5: Commit**

```bash
git commit -am "persons: reverse a merge from its snapshot (#404)"
```

---

### Task 5: Re-verify published boards after a merge

**Files:**
- Modify: `apps/web/src/server/usecases/person-merge.ts`
- Test: `apps/web/src/server/usecases/__tests__/person-merge-reverify.test.ts`

**Interfaces:**
- Consumes: `toVerifyConfig` (`schedule.ts:488`, exported). **Do not import
  `assertNoNewBlocking`** — it is module-private (`schedule.ts:573`).
- Produces: `MergeResult` gains
  `revealed: { division_id: string; conflicts: Conflict[] }[]`.

- [ ] **Step 1: Write the failing test** — two entrants, one holding each
  duplicate, scheduled at the same time on different courts (legal before the
  merge). Merge. Assert (a) `revealed` contains a `person_overlap` naming the
  survivor, and (b) the merge **still committed** — per the W4 delta rule a merge
  is not blocked by what it reveals, or the duplicate stays and the board stays
  wrong.
- [ ] **Step 2: Run — red.**
- [ ] **Step 3: Implement** — after the transaction commits, re-verify every
  published board the survivor appears in and return the result.
- [ ] **Step 4: Run — green.**
- [ ] **Step 5: Commit**

```bash
git commit -am "persons: re-verify published boards after a merge (#404)"
```

---

### Task 6: Candidate ranking

**Files:**
- Create: `apps/web/src/server/usecases/person-duplicates.ts`
- Test: `apps/web/src/server/usecases/__tests__/person-duplicates.test.ts`

**Interfaces:**
- Produces:

```ts
export type Evidence =
  | { kind: "name"; detail: string }
  | { kind: "dob"; detail: string }
  | { kind: "shared_entrant"; detail: string };
export interface Candidate { a: PersonRow; b: PersonRow; score: number; evidence: Evidence[] }
export async function listDuplicateCandidates(
  auth: AuthCtx,
  opts: { limit?: number },
): Promise<{ items: Candidate[] }>
```

- [ ] **Step 1: Write the failing tests**

1. Same normalised name **and** same `dob` ranks above name-only.
2. **Differing non-null `dob` suppresses the pair entirely** — never suggested,
   whatever the name match.
3. Shared entrant history raises the score.
4. **Lane respected** — an `official` is never a candidate for a `player`.
5. Tombstones excluded on both sides.
6. Pairs where both rows carry different non-null `user_id`s are excluded — they
   can never be merged (Task 3 rule 7), so suggesting them is a dead end.
7. Every candidate carries evidence; the organiser is the one deciding.

- [ ] **Step 2: Run — red.**
- [ ] **Step 3: Implement** as one org-scoped self-join inside `withTenant`.
  Normalise names the same way `personKeyResolver` does
  (`schedule-ai.ts:152` — `trim().toLowerCase().replace(/\s+/g," ")`), so the
  queue and the scheduling name guard agree on what "same name" means.
  Mirror the `(nameKey, dob)` shape of `packages/engine/src/import/plan.ts:220-282`
  **without importing it** — it is not exported and the data lives in Postgres.
- [ ] **Step 4: Run — green.**
- [ ] **Step 5: Commit**

```bash
git commit -am "persons: ranked duplicate candidates with evidence (#404)"
```

---

### Task 7: API surface + the confirmation gate

**Files:**
- Modify: `apps/web/src/app/api/v1/persons/[id]/merge/route.ts`
- Create: `apps/web/src/app/api/v1/persons/duplicates/route.ts`
- Create: `apps/web/src/app/api/v1/persons/merges/[id]/reverse/route.ts`
- Modify: `apps/web/src/server/api-v1/schemas.ts:297` (`MergePersons`)
- Modify: `apps/web/src/server/api-v1/key-scopes.ts:217` (`NEVER_KEY_ROUTES`)
- Test: `apps/web/src/app/api/v1/persons/__tests__/merge-route.test.ts`

**Interfaces:**
- Consumes: `mergePersons`, `reverseMerge`, `listDuplicateCandidates`.
- Produces: `MergePersons = z.object({ duplicate_id: Uuid, confirmed: z.literal(true),
  allow_dob_mismatch: z.boolean().optional() })`.

- [ ] **Step 1: Write the failing tests** — a merge POST without `confirmed: true`
  is **422**; with it, 200. An **API-key principal is refused** on all three routes
  (a merge is a human act; same precedent as competition delete). Reversal
  requires the same confirmation.
- [ ] **Step 2: Run — red.**
- [ ] **Step 3: Implement**, adding all three paths to `NEVER_KEY_ROUTES`.
- [ ] **Step 4: Run — green.**
- [ ] **Step 5: `npm run openapi:gen` and commit the regenerated spec.**

```bash
git commit -am "api: duplicate queue, gated merge, reversal (#404)"
```

---

### Task 8: The organiser UI

**Files:**
- Create: `apps/web/src/components/v2/duplicates-panel.tsx`
- Modify: `apps/web/src/app/directory/page.tsx`,
  `apps/web/src/components/v2/persons-panel.tsx`
- Modify: all 4 `apps/web/src/dictionaries/*/ui.json`
- Test: `apps/web/src/components/v2/__tests__/duplicates-panel.test.tsx`

**Load the `frontend-design` skill before designing this.**

- [ ] **Step 1: Write the failing component tests** — the confirm control is
  disabled until the organiser affirms; the dialog renders the **resolved**
  (restrictive) consent rather than the survivor's; the undo control shows for a
  live merge and not a reversed one; a differing-dob pair shows both dates and
  requires the extra affirmation.
- [ ] **Step 2: Run — red.**
- [ ] **Step 3: Build** all six states: empty queue · ranked list with evidence ·
  side-by-side confirm dialog · post-merge result listing revealed conflicts ·
  merge history with Undo · reversal confirmation.
- [ ] **Step 4: Run — green.**
- [ ] **Step 5: Screenshot every state at 1440 and 375**, asserting
  `scrollWidth === clientWidth` at 375. Wide comparison tables in
  `overflow-x: auto`.
- [ ] **Step 6: `npm run i18n:check && npm run i18n:gen-keys`; commit.**

```bash
git commit -am "directory: duplicate review queue and merge flow (#404)"
```

---

### Task 8b: Carry the account link, and make history durable

Both found by Task 8's screenshots. Fixed here, not filed.

**Files:**
- Modify: `apps/web/src/server/usecases/person-merge.ts`
- Create: `apps/web/src/app/api/v1/persons/merges/route.ts`
- Modify: `apps/web/src/server/api-v1/{key-scopes.ts,openapi.ts,schemas.ts}`
- Modify: `apps/web/src/components/v2/duplicates-panel.tsx`
- Test: `apps/web/src/server/usecases/__tests__/person-merge.test.ts` (extend),
  `apps/web/src/app/api/v1/persons/__tests__/merge-route.test.ts` (extend)

**Finding 1 — `persons.user_id` never moves.** `mergePersons` writes only
`consent` to the surviving row. Task 3 refuses when **both** rows carry different
non-null `user_id`s, but when only the **absorbed** row is claimed the survivor
keeps `user_id = null`: `person_claims` repoints while the account link itself
strands on the tombstone, so the player logs in and finds no record.

**Ruling: carry it across when the survivor has none.** It is the same human, and
the both-claimed case is already refused. Reversal must clear it again — the
snapshot already holds both rows, so this is a restore, not a new field.

**Finding 2 — merge history is session-scoped.** `person_merges` has no list
endpoint, so the Undo control survives only until a refresh. That makes the
owner's "unbounded undo" decision hollow in practice.

- [ ] **Step 1: Failing tests**
  1. Survivor has `user_id = null`, absorbed has one → after the merge the
     survivor carries it and the tombstone does not.
  2. Both have the SAME `user_id` → still fine, no change in behaviour.
  3. Both have DIFFERENT non-null `user_id`s → still 422 (unchanged).
  4. Reverse the merge from case 1 → the `user_id` goes back to the absorbed row
     and the survivor is null again.
  5. `GET /api/v1/persons/merges` lists this org's merges, newest first, with
     `reversed_at`; a second org's rows never appear.
  6. The route is in `NEVER_KEY_ROUTES` — an API-key principal is refused.
- [ ] **Step 2: Run — red.**
- [ ] **Step 3: Implement**, then wire the panel's history list to the endpoint so
  Undo survives a reload.
- [ ] **Step 4: Green**, plus the #404 suites and the v2 component directory.
- [ ] **Step 5: `openapi:gen` + `i18n:gen-keys`, commit.**

---

### Task 9: e2e, smoke, help

**Files:**
- Create: `apps/web/e2e/person-merge.spec.ts`
- Modify: `scripts/smoke.ts`
- Create: `apps/web/content/help/players/duplicates.md` (English only)

- [ ] **Step 1: e2e** — sign in, open the queue, merge a suggested pair, see the
  survivor in the roster and the duplicate gone, undo, see both back. Run locally
  against a prod build with `E2E_PROD_TARGET`. **Never enable `e2e.yml`.**
- [ ] **Step 2: smoke** — the queue endpoint answers for a seeded org; a merge
  without `confirmed` is 422; a merge preserves a suspension.
- [ ] **Step 3: help page** — what a merge does, what it does not do, that it can
  be undone, and that consent resolves to the stricter of the two.
- [ ] **Step 4: run the full local smoke, then commit.**

```bash
git commit -am "e2e+smoke+help for the duplicate merge tool (#404)"
```

---

## Self-review

**Spec coverage.** §3 data → Task 1. §3 identity index + `ON CONFLICT` → Tasks 1-2.
§4.1 refusals → Task 3 tests 6-9, 13. §4.2 order → Task 3 step 3. §4.3 per-table
rules → Task 3 tests 1, 3, 4, 5. §4.4 reversal → Task 4. §5 re-verify → Task 5.
§6 candidates → Task 6. §7 surface → Task 8. §8 API → Task 7. §9 testing → spread,
plus Task 9. §10 backfill is out of scope and has no task, as intended.

**Placeholders.** None: every test states its assertion, every rule names its
resolution, and every command is written out with the flags that make its output
trustworthy.

**Type consistency.** `mergePersons` returns `MergeResult { merge_id, survivor }`
in Task 3, gains `revealed` in Task 5, and Tasks 7-8 consume that shape.
`reverseMerge(auth, mergeId, opts)` is identical in Tasks 4, 7, 8.
`listDuplicateCandidates(auth, opts) → { items: Candidate[] }` is identical in
Tasks 6, 7, 8.

**Biggest risk: Task 2.** Adding `merged_into` changes a read that every roster
surface and both public views depend on, and nothing in the type system catches a
missed call site. The grep is the coverage and the full suite is the gate.
