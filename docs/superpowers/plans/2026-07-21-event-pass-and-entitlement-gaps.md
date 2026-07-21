# Event Pass E2E + Entitlement Gap Closure — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Event Pass a coherent, discoverable, honestly-advertised product with a receipt — and fix the entitlement resolvers it exposed, which leak Pro to lapsed and expired orgs today.

**Architecture:** Three resolvers collapse to one. `lib/entitlements.ts` stays the reference; `org_has_feature` gains a competition parameter and the three degradations it never learned (override expiry, comped_until, past_due); the two app-side duplicate resolvers are deleted and call the real one. On top of that corrected base, every `event_pass` grant gets its enforcement site threaded with `competitionId`, the offer's copy is aligned with what the matrix actually delivers, and the purchase gains a Stripe customer link, an invoice, and an in-app receipt.

**Tech Stack:** Next.js 16 (breaking changes vs training data — read `node_modules/next/dist/docs/` first), TypeScript, Postgres + Flyway, Stripe (`stripe-node` v22, embedded checkout), vitest, Playwright, `postgres` (porsager) SQL client.

**Spec:** `docs/superpowers/specs/2026-07-21-event-pass-and-entitlement-gaps-design.md`

## Global Constraints

- **Read `node_modules/next/dist/docs/` before writing any Next.js code.** This version has breaking changes vs training data. Task 16 creates a `layout.tsx` — that is the highest-risk guess.
- **Migrations are immutable.** Never edit `V228__fn_org_has_feature.sql`. New work is `V306+`. `db/README.md:5`, `db/README.md:10-12` — the `V###` prefix alone orders execution across all folders.
- **`create or replace view` may only APPEND columns.** `V289:3-4`, `jul3/V242:84`. Changing an expression inside an existing column is fine; reordering or retyping needs `drop view … cascade` + recreate + re-`grant select … to app_user`.
- **Every change ships a test that fails without it.** A test that passes against unfixed code is not a test. A skipped test is not a passing test.
- **Any new feature key or UI string lands in all four locales** — `apps/web/src/dictionaries/{en,es,fr,nl}/`. Current parity is exact at 62 `pricing.matrix.*` keys; keep it exact. Also update `apps/web/src/lib/i18n-keys.ts`.
- **Verify command:** `cd apps/web && npx tsc --noEmit && npx vitest run`
- **Smoke:** `SMOKE_BASE=http://localhost:3021` — it defaults to :3000 and will silently test nothing.
- **Never enable `.github/workflows/e2e.yml`.** It is disabled deliberately. Verify E2E locally.
- **Regenerate the OpenAPI spec** if any `/api/v1` route changes.
- **Commit after every task.** Conventional Commits, `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Event Pass price:** $29 / €29 / £25 / ₹1999 / A$45 — `apps/web/src/config/stripe-plans.json` `passes[0]`. Live test-mode price `price_1TukMvAy22H0xqqxw3aoT3Dr`, active, all five currencies present.
- **Phase 1 lands before every other phase.** Everything downstream assumes a correct resolver.

---

# Phase 1 — Resolver correctness

## Task 1: Pin the resolver drift with failing tests

**Files:**
- Create: `apps/web/src/lib/__tests__/entitlements-sql-parity.test.ts`
- Reference: `apps/web/src/lib/entitlements.ts`, `db/migration/v2-engine/functions/V228__fn_org_has_feature.sql`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: the parity harness later tasks re-run. Exports nothing; it is a test file.

These tests document the four confirmed drifts plus the null-bool fork. They fail
now and pass after Task 2.

- [ ] **Step 1: Write the failing test**

**Codebase test conventions — follow these, there is no factories module:**
tests declare their own local `seed*` helpers with raw SQL, use
`randomUUID().slice(0, 8)` for run-unique names, and gate on
`const HAS_DB = !!process.env.DATABASE_URL`. See
`apps/web/src/lib/__tests__/entitlements-comp-liveness.test.ts:26-45` for the
canonical shape. A raw `insert into organizations` does **not** create a
`subscriptions` row (only the app path at `lib/auth.ts:242-245` does), so seed
one explicitly.

**Trap:** these suites `skipIf(!HAS_DB)`. Run them with `DATABASE_URL` set or
they report green having asserted nothing — a skipped test is not a passing test.

```ts
// apps/web/src/lib/__tests__/entitlements-sql-parity.test.ts
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { hasFeature, invalidateOrgEntitlements } from "@/lib/entitlements";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

/** Community org with an explicit subscriptions row. */
async function seedOrg(): Promise<string> {
  const s = uniq();
  const [{ id: ownerId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`parity-${s}@test.local`}, 'Parity Owner', true) returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Parity " + s}, ${"parity-" + s}, ${ownerId}) returning id`;
  await sql`
    insert into subscriptions (org_id, plan_key, status)
    values (${orgId}, 'community', 'active')`;
  return orgId;
}

/** The SQL resolver must agree with the TS resolver on every mechanism the TS
 *  one implements. V228 was written before override expiry (V266), comped_until
 *  (V266), passes (V270/V271) and the past_due anchor (V291) existed. */
async function sqlHasFeature(orgId: string, key: string, compId?: string) {
  const [row] = await sql<{ v: boolean }[]>`
    select org_has_feature(${orgId}, ${key}, ${compId ?? null}) as v`;
  return row.v;
}

describe.skipIf(!HAS_DB)("org_has_feature parity with lib/entitlements", () => {
  let orgId: string;
  beforeEach(async () => {
    orgId = await seedOrg();
    await invalidateOrgEntitlements(orgId);
  });

  it("ignores an EXPIRED override, like the TS resolver does", async () => {
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value, expires_at)
      values (${orgId}, 'branding', true, now() - interval '1 day')`;
    await invalidateOrgEntitlements(orgId);
    expect(await hasFeature(orgId, "branding")).toBe(false);
    expect(await sqlHasFeature(orgId, "branding")).toBe(false);
  });

  it("degrades a LAPSED comp to community", async () => {
    await sql`
      update subscriptions
      set plan_key = 'pro', comped_until = now() - interval '1 day',
          stripe_subscription_id = null, status = 'active'
      where org_id = ${orgId}`;
    await invalidateOrgEntitlements(orgId);
    expect(await hasFeature(orgId, "branding")).toBe(false);
    expect(await sqlHasFeature(orgId, "branding")).toBe(false);
  });

  it("degrades past_due beyond the 14-day grace", async () => {
    await sql`
      update subscriptions
      set plan_key = 'pro', status = 'past_due',
          status_changed_at = now() - interval '15 days',
          stripe_subscription_id = 'sub_test'
      where org_id = ${orgId}`;
    await invalidateOrgEntitlements(orgId);
    expect(await hasFeature(orgId, "branding")).toBe(false);
    expect(await sqlHasFeature(orgId, "branding")).toBe(false);
  });

  it("honours an Event Pass for the competition in scope, and only that one", async () => {
    const [passed] = await sql<{ id: string }[]>`
      insert into competitions (org_id, name, slug, sport)
      values (${orgId}, 'Passed', 'passed', 'football') returning id`;
    const [other] = await sql<{ id: string }[]>`
      insert into competitions (org_id, name, slug, sport)
      values (${orgId}, 'Other', 'other', 'football') returning id`;
    await sql`
      insert into competition_passes (competition_id, org_id) values (${passed.id}, ${orgId})`;
    await invalidateOrgEntitlements(orgId);

    expect(await hasFeature(orgId, "branding", passed.id)).toBe(true);
    expect(await sqlHasFeature(orgId, "branding", passed.id)).toBe(true);
    expect(await hasFeature(orgId, "branding", other.id)).toBe(false);
    expect(await sqlHasFeature(orgId, "branding", other.id)).toBe(false);
  });

  it("treats a null-bool override as no answer, not as a deny", async () => {
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value, int_value)
      values (${orgId}, 'exports', null, 5)`;
    await invalidateOrgEntitlements(orgId);
    // community has exports=true since V285; an int-only override must not deny it.
    expect(await hasFeature(orgId, "exports")).toBe(true);
    expect(await sqlHasFeature(orgId, "exports")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/web && npx vitest run src/lib/__tests__/entitlements-sql-parity.test.ts
```

Expected: FAIL. The first four fail with `org_has_feature(uuid, text, uuid)` not
existing (the 3-arg form is Task 2). The null-bool case fails on the TS side —
`entitlements.ts:65` returns the override row unconditionally, so `hasFeature`
sees `bool_value === null` and yields `false`.

- [ ] **Step 3: Commit the failing test**

```bash
git add apps/web/src/lib/__tests__/entitlements-sql-parity.test.ts
git commit -m "test(entitlements): pin the five SQL/TS resolver drifts"
```

---

## Task 2: V306 — pass-aware, degradation-aware `org_has_feature`

**Files:**
- Create: `db/migration/deltas/V306__entitlement_resolver_parity.sql`
- Modify: `apps/web/src/lib/entitlements.ts:60-65` (null-bool fork)
- Test: `apps/web/src/lib/__tests__/entitlements-sql-parity.test.ts` (from Task 1)

**Interfaces:**
- Consumes: Task 1's test file.
- Produces: `org_has_feature(p_org_id uuid, p_feature_key text, p_competition_id uuid default null) returns boolean`. Every later SQL task calls the 3-arg form. The 2-arg form is **dropped** — callers must be updated in this same migration.

**Schema facts, verified against the live local DB 2026-07-21 — do not re-derive:**
- `org_has_feature(uuid, text)` exists in **two** schemas: `public` and `seazn_club`.
  So do all four public views. This is a **local-dev artifact**; the app lives in
  `seazn_club` (`db/flyway.toml:8-13` — `scripts/flyway.sh` passes
  `-schemas/-defaultSchema` from `${DB_SCHEMA:-seazn_club}`).
- Therefore: use **unqualified** DDL, exactly as V228 did. It lands in the Flyway
  default schema, which is the one that matters. **Do not** add `public.`-qualified
  statements to "fix" the duplicate — production has no such copy, and the migration
  would fail there.
- `security definer` requires a pinned `search_path`. Use the Flyway placeholder
  `${flyway:defaultSchema}` (available per `db/flyway.toml:13`), **not** a literal
  `public` — a literal would make the function resolve tables in the wrong schema and
  silently return `false` for everything.
- The `drop function if exists org_has_feature(uuid, text)` at the end is likewise
  unqualified and will drop only the default-schema copy. That is correct.

**Read before writing:** `db/README.md` lines 1-45, and
`db/migration/v2-engine/views/V230__view_public_competitions.sql`,
`V238__view_public_discovery.sql`, `db/migration/deltas/V289__entrant_badge_public_view.sql`
in full. You are recreating three of them.

`public_players_v` is deliberately NOT changed here — see Task 4.

- [ ] **Step 1: Write the migration**

```sql
-- db/migration/deltas/V306__entitlement_resolver_parity.sql
-- V306 — the SQL resolver catches up with lib/entitlements.ts.
--
-- V228 was accurate when written. Every mechanism it misses arrived later:
-- override expiry + comped_until (V266), Event Pass (V270/V271), the past_due
-- anchor (V291). Until now a lapsed comp or an expired staff override kept
-- granting Pro on every public page, and a paid Event Pass granted nothing.
--
-- The 2-arg form is dropped, so all four dependent views are recreated here.
-- security definer + a pinned search_path so the competition_passes read is not
-- RLS-filtered if this is ever called from a withTenant transaction (the
-- V226 hash-chain functions use the same shape).

-- NO DEFAULT on p_competition_id, deliberately. A defaulted third parameter
-- would make every surviving 2-arg call ambiguous ("function
-- org_has_feature(uuid, text) is not unique"), and the 2-arg form cannot simply
-- be dropped here: public_players_v still depends on it until Task 4, and
-- server/public-site/data.ts:178-182,373 until Task 8. Instead the 2-arg form
-- becomes a thin delegating wrapper (below), so both arities coexist
-- unambiguously and callers migrate one task at a time. The wrapper is removed
-- in Task 25 once nothing calls it.
create or replace function org_has_feature(
  p_org_id uuid,
  p_feature_key text,
  p_competition_id uuid
) returns boolean
  language sql stable security definer
  set search_path = ${flyway:defaultSchema} as $$
    with plan as (
      select case
        -- Mirrors entitlements.ts:85-88 — a comp past its end date resolves as
        -- community unless a LIVE subscription still owns the plan.
        when s.comped_until is not null and s.comped_until <= now()
             and (s.stripe_subscription_id is null
                  or coalesce(s.status, '') not in
                     ('active', 'trialing', 'past_due', 'unpaid'))
             then 'community'
        -- Mirrors entitlements.ts:94-96 — dunning gets 14 days from the
        -- TRANSITION, not from the last retry.
        when s.status = 'past_due'
             and coalesce(s.status_changed_at, s.updated_at) <= now() - interval '14 days'
             then 'community'
        else coalesce(s.plan_key, 'community')
      end as plan_key
      from organizations o
      left join subscriptions s on s.org_id = o.id
      where o.id = p_org_id
    )
    select coalesce(
      -- Override wins, but only while it is alive (entitlements.ts:64).
      (select bool_value from org_entitlement_overrides
        where org_id = p_org_id and feature_key = p_feature_key
          and (expires_at is null or expires_at > now())),
      -- Event Pass: community orgs only, competition in scope
      -- (entitlements.ts:109-117). A key absent from the pass matrix falls
      -- through to the plan row rather than denying.
      (select pe.bool_value
         from competition_passes cp
         join plan_entitlements pe
           on pe.plan_key = cp.pass_key and pe.feature_key = p_feature_key
        where p_competition_id is not null
          and cp.competition_id = p_competition_id
          and cp.org_id = p_org_id
          and (select plan_key from plan) = 'community'),
      (select pe.bool_value from plan_entitlements pe
        where pe.feature_key = p_feature_key
          and pe.plan_key = (select plan_key from plan)),
      false)
  $$;

-- Dependent views must move to the 3-arg form before the 2-arg one can go.
-- Only the gate EXPRESSION changes in each; no column is added, removed or
-- reordered, so create-or-replace is legal (V289:3-4).

create or replace view public_competitions_v as
  select c.id, c.org_id, c.slug, c.name, c.sport, c.visibility, c.starts_on,
         c.ends_on, c.timezone, c.created_at,
         case when org_has_feature(c.org_id, 'dashboard.branding', c.id)
              then o.branding else '{}'::jsonb end as branding
    from competitions c
    join organizations o on o.id = c.org_id;

-- public_entrants_v and public_discovery_v: recreate with the same column list
-- their effective definitions already have (V289 and V238 respectively),
-- changing ONLY the org_has_feature calls to pass the competition id that is
-- already in scope (V289:36 `c.id`, V238:41 `c.id`).
-- IMPLEMENTER: copy each view body verbatim from its effective source file and
-- add the third argument. Do not retype the column list from memory.

-- Event Pass gains branded exports (spec D6). Inert until exports.ts:131
-- threads its competitionId — both land in this branch.
insert into plan_entitlements (plan_key, feature_key, bool_value, int_value)
values ('event_pass', 'exports.branded', true, null)
on conflict (plan_key, feature_key) do update
  set bool_value = excluded.bool_value, int_value = excluded.int_value;

-- The 2-arg form survives as a delegating wrapper so nothing breaks mid-branch.
-- It is NOT a second resolver: it forwards to the one above with no competition
-- in scope, which is exactly what an org-level question means.
create or replace function org_has_feature(p_org_id uuid, p_feature_key text)
  returns boolean
  language sql stable security definer
  set search_path = ${flyway:defaultSchema} as $$
    select org_has_feature(p_org_id, p_feature_key, null::uuid)
  $$;
```

- [ ] **Step 2: Fix the TS null-bool fork**

`resolveFromDb` currently queries the override FIRST and returns it wholesale
(`entitlements.ts:60-65`), so an override that answers only the INT question
makes `hasFeature` see `bool_value === null` and yield **false**, while the SQL
resolver's `coalesce` falls through to the plan row and yields **true**.

Fix by inverting the order: resolve the base (pass → plan) first, then overlay
only the override's non-null fields. That is exactly `coalesce` semantics, so
the two resolvers agree by construction. Rewrite `resolveFromDb` in
`apps/web/src/lib/entitlements.ts` as:

```ts
async function resolveFromDb(
  orgId: string,
  featureKey: string,
  competitionId?: string,
): Promise<Resolved | null> {
  // Plan first: both the pass branch and the override overlay need it, and it
  // must be resolved exactly once.
  const [orgPlan] = await sql<{ plan_key: string }[]>`
    select case
      when s.comped_until is not null and s.comped_until <= now()
           and (s.stripe_subscription_id is null
                or coalesce(s.status, '') not in ${sql([...LIVE_SUBSCRIPTION_STATUSES])})
           then 'community'
      when s.status = 'past_due'
           and coalesce(s.status_changed_at, s.updated_at) <= now() - interval '14 days'
           then 'community'
      else coalesce(s.plan_key, 'community')
    end as plan_key
    from organizations o
    left join subscriptions s on s.org_id = o.id
    where o.id = ${orgId}`;
  const planKey = orgPlan?.plan_key ?? "community";

  // Event Pass: community orgs only, competition in scope. A key absent from
  // the pass matrix falls through to the plan row rather than denying.
  let base: Resolved | null = null;
  if (planKey === "community" && competitionId) {
    const [pass] = await sql<Resolved[]>`
      select pe.bool_value, pe.int_value
      from competition_passes cp
      join plan_entitlements pe
        on pe.plan_key = cp.pass_key and pe.feature_key = ${featureKey}
      where cp.competition_id = ${competitionId} and cp.org_id = ${orgId}`;
    base = pass ?? null;
  }
  if (!base) {
    const [pe] = await sql<Resolved[]>`
      select bool_value, int_value
      from plan_entitlements
      where plan_key = ${planKey} and feature_key = ${featureKey}`;
    base = pe ?? null;
  }

  // Live overrides win, FIELD BY FIELD. An int-only override must not deny the
  // boolean, and a bool-only override must not zero the quota. Mirrors the SQL
  // resolver's coalesce (spec drift #5). A deliberate deny sets bool_value
  // false, which is non-null and therefore still wins.
  const [ov] = await sql<Resolved[]>`
    select bool_value, int_value
    from org_entitlement_overrides
    where org_id = ${orgId} and feature_key = ${featureKey}
      and (expires_at is null or expires_at > now())`;
  if (!ov) return base;
  return {
    bool_value: ov.bool_value ?? base?.bool_value ?? null,
    int_value: ov.int_value ?? base?.int_value ?? null,
  };
}
```

**Behaviour change to verify:** an override on a key the org has no plan row for
now returns a `Resolved` object rather than `null`. `getLimit` returns
`row.int_value` (possibly null = unlimited) instead of `0`. Check the
`entitlement-admin` tests for anything that depended on the old shape.

- [ ] **Step 3: Apply the migration and run the tests**

```bash
npm run db:apply
cd apps/web && npx vitest run src/lib/__tests__/entitlements-sql-parity.test.ts
```

Expected: all five PASS.

- [ ] **Step 4: Full suite — this migration touches public read paths**

```bash
cd apps/web && npx tsc --noEmit && npx vitest run
```

Expected: green. If a public-site test fails, the view column list drifted — diff
your recreated view against its effective source.

- [ ] **Step 5: Commit**

```bash
git add db/migration/deltas/V306__entitlement_resolver_parity.sql apps/web/src/lib/entitlements.ts
git commit -m "fix(entitlements): the SQL resolver learns passes, expiry, comps and dunning"
```

---

## Task 3: Delete the two duplicate resolvers

**Files:**
- Modify: `apps/web/src/app/api/orgs/[id]/entitlements/route.ts:32-41`
- Modify: `apps/web/src/lib/auth.ts:198-214`
- Test: `apps/web/src/lib/__tests__/entitlements-duplicate-resolvers.test.ts` (create)

**Interfaces:**
- Consumes: `hasFeature`, `getLimit` from `@/lib/entitlements` (Task 2's corrected versions).
- Produces: no new exports. Removes two independent SQL resolution paths.

`api/orgs/[id]/entitlements/route.ts` reproduces all four V228 drifts
independently — it powers the org plan panel, so the UI can promise what
enforcement denies. `assertMayOwnAnotherOrg` honours `expires_at` but not
`comped_until` or `past_due`, so a lapsed comp still creates orgs at the Pro cap.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/lib/__tests__/entitlements-duplicate-resolvers.test.ts
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { assertMayOwnAnotherOrg } from "@/lib/auth";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

/** A user owning exactly one org, with an explicit subscriptions row.
 *  Returns both ids. Same local-helper convention as
 *  entitlements-comp-liveness.test.ts:26-45 — there is no factories module. */
async function seedOwnerWithOneOrg(): Promise<{ userId: string; orgId: string }> {
  const s = uniq();
  const [{ id: userId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`dupres-${s}@test.local`}, 'Dup Owner', true) returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Dup " + s}, ${"dup-" + s}, ${userId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${userId}, 'owner')`;
  await sql`
    insert into subscriptions (org_id, plan_key, status)
    values (${orgId}, 'community', 'active')`;
  return { userId, orgId };
}

describe.skipIf(!HAS_DB)("assertMayOwnAnotherOrg respects read-time degradations", () => {
  it("refuses a lapsed comp beyond the community cap", async () => {
    const { userId, orgId } = await seedOwnerWithOneOrg();
    await sql`
      update subscriptions
      set plan_key = 'pro', comped_until = now() - interval '1 day',
          stripe_subscription_id = null
      where org_id = ${orgId}`;
    // community orgs.max_owned = 1, and they already own one.
    await expect(assertMayOwnAnotherOrg(userId)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run it, confirm it fails**

```bash
cd apps/web && npx vitest run src/lib/__tests__/entitlements-duplicate-resolvers.test.ts
```

Expected: FAIL — the raw SQL reads `plan_key = 'pro'` and allows a second org.

- [ ] **Step 3: Rewrite `assertMayOwnAnotherOrg`**

**Read `apps/web/src/lib/auth.ts:192-218` before writing anything.** This quota is
NOT org-scoped — there is no single `orgId` to resolve. Per the doc comment at
`:192-196` it is a **per-user, cross-org** cap: the user's *best* plan across every
org they own decides, overrides on any owned org lift the user (v3 grandfathering,
where the pro cap dropped 5 → 3), a null `int_value` means unlimited, and a user who
owns nothing may always create their first.

So `getLimit(orgId, …)` with one org is the wrong shape and would silently change
who may create an org. Resolve per owned org and keep "best wins":

```ts
import { getLimit } from "@/lib/entitlements";

async function assertMayOwnAnotherOrg(userId: string): Promise<void> {
  const owned = await sql<{ org_id: string }[]>`
    select m.org_id from org_members m
    where m.user_id = ${userId} and m.role = 'owner'`;
  if (owned.length === 0) return;

  // ONE resolver per owned org. This replaces a raw plan_key + override union
  // that honoured expires_at but NOT comped_until or past_due, so a lapsed comp
  // kept the Pro cap. getLimit applies overrides (with expiry) per org, so the
  // old cross-org override union is preserved by construction.
  const limits = await Promise.all(
    owned.map((o) => getLimit(o.org_id, "orgs.max_owned")),
  );
  // A null limit is UNLIMITED and wins outright — same rule as auth.ts:216.
  if (limits.some((l) => l === null)) return;
  const limit = Math.max(...(limits as number[]));
  if (owned.length + 1 > limit) throw new PaymentRequiredError("orgs.max_owned");
}
```

Preserve the existing doc comment at `:192-196` — the billing decision it records
is still the governing rule.

- [ ] **Step 4: Rewrite the entitlements route**

At `apps/web/src/app/api/orgs/[id]/entitlements/route.ts:32-41`, drop the
`coalesce(ov.bool_value, pe.bool_value)` join entirely. Read the feature list
from `plan_entitlements` for key names only, then resolve each through
`hasFeature`/`getLimit` so the panel shows exactly what enforcement will do.

- [ ] **Step 5: Run tests**

```bash
cd apps/web && npx vitest run && npx tsc --noEmit
```

Expected: green.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/auth.ts apps/web/src/app/api/orgs/\[id\]/entitlements/route.ts apps/web/src/lib/__tests__/entitlements-duplicate-resolvers.test.ts
git commit -m "refactor(entitlements): delete the two duplicate resolvers"
```

---

## Task 4: Move the `public_players_v` gate to its caller

**Files:**
- Modify: `apps/web/src/server/public-site/data.ts:411-420`
- Create: `db/migration/deltas/V307__public_players_ungated.sql`
- Test: `apps/web/src/server/__tests__/public-players-gate.test.ts` (create)

**Why not a parameter:** the gate at `V237:12` sits over `from persons p`; the
only competition reference is inside a correlated `exists()` below it. The view
has no competition column because a person plays in many competitions. Pushing
the gate inward would change its meaning to "*some* competition this person
appears in is entitled" — one Event Pass would expose that person across every
unpaid competition in the org.

**Verified facts — read these before writing (checked against the tree 2026-07-21):**

`V237__view_public_players.sql:6-20` filters on THREE conditions: `public_name`
consent, the org holding `dashboard.player_profiles`, and an `exists(...)` proving
the person is rostered in a publicly visible competition. **Only the middle one
moves.** Consent and visibility stay in the view.

**Exactly one production consumer:** `data.ts:417`, reached from
`app/(public)/shared/[orgSlug]/[competitionSlug]/players/[personId]/page.tsx`. So
there is a single place to re-gate. `V239__v2_grants.sql:14` grants select on the
view — unchanged.

**Trap 1 — the cache boundary.** The query at `:417` sits inside an
`unstable_cache` keyed with `{ tags: [competitionTag(shell.competition.id)],
revalidate: REVALIDATE_SLOW }`. Entitlement changes do **not** bust a competition
tag, so a gate placed INSIDE that closure would be frozen at whatever the
entitlement was when the page was first cached — a lapsed org would keep serving
player cards for a full revalidate window. **Put the gate OUTSIDE the
`unstable_cache`,** before or after the cached call, so it is evaluated per request.
`hasFeature` has its own 5-minute cache, which is the bounded staleness we accept
everywhere else.

**Trap 2 — `consent.test.ts` asserts the OLD view contract.**
`apps/web/src/server/public-site/__tests__/consent.test.ts:135,149,206` query
`public_players_v` directly and assert entitlement-driven filtering. Removing the
gate from the view WILL break them, and that is correct — the view's contract is
changing by design. Do not delete those assertions to make the suite green. Instead:
re-point them at the view's new, narrower contract (consent + visibility), and add a
caller-level test proving the entitlement gate still denies. Coverage must not
shrink: the number of things asserted about entitlement gating should stay the same
or grow.

- [ ] **Step 1: Write the failing test**

Two assertions, at the CALLER level (`getPublicPlayer`), not the view:
a passed competition surfaces the player card; a second, unpassed competition in the
same org does not. A one-sided test would pass even if the gate leaked org-wide,
which is the exact failure this task exists to prevent.

- [ ] **Step 2: Run it, confirm it fails**

```bash
cd apps/web && npx vitest run src/server/__tests__/public-players-gate.test.ts
```

- [ ] **Step 3: Remove the gate from the view, add it to the caller**

V307 recreates `public_players_v` without the `org_has_feature` predicate, keeping
the consent and `exists(...)` clauses byte-identical. `data.ts` then gates on
`hasFeature(org.id, "dashboard.player_profiles", shell.competition.id)` outside the
cached closure.

- [ ] **Step 3b: Update `consent.test.ts` to the new view contract** and confirm the
      entitlement assertions live on at the caller level.

- [ ] **Step 4: Apply, test, commit**

```bash
npm run db:apply && cd apps/web && npx vitest run && npx tsc --noEmit
git add -A && git commit -m "fix(public): scope the player-profile gate to the competition in view"
```

---

## Task 5: The guard test that would have caught all of this

**Files:**
- Create: `apps/web/src/lib/__tests__/pass-scoping-guard.test.ts`

**Interfaces:**
- Consumes: the `event_pass` matrix from the database.
- Produces: a standing guard. No exports.

`entitlements-v2.test.ts` is currently the only test exercising the pass overlay,
and only for two keys. That is why `branding` and `realtime` shipped dead.

- [ ] **Step 1: Write the test**

```ts
// apps/web/src/lib/__tests__/pass-scoping-guard.test.ts
import { describe, it, expect } from "vitest";
import { sql } from "@/lib/db";
import { readFileSync, globSync } from "node:fs";
import ts from "typescript";

/** The four resolver entry points. `withinLimit` takes the competition id as its
 *  FOURTH argument, the others as their third — see lib/entitlements.ts. */
const GATES = new Set(["hasFeature", "requireFeature", "getLimit", "withinLimit"]);

/** Every feature key the Event Pass LIFTS above community must be resolved with
 *  a competitionId at every call site, or the grant is dead on arrival. */
describe("Event Pass grants are resolved with a competition in scope", () => {
  it("has no enforcement site that drops the competition id", async () => {
    const lifted = await sql<{ feature_key: string }[]>`
      select ep.feature_key
      from plan_entitlements ep
      left join plan_entitlements c
        on c.plan_key = 'community' and c.feature_key = ep.feature_key
      where ep.plan_key = 'event_pass'
        and (ep.bool_value is distinct from c.bool_value
             or ep.int_value is distinct from c.int_value)`;

    const keys = new Set(lifted.map((r) => r.feature_key));
    const files = globSync("src/**/*.{ts,tsx}", { cwd: process.cwd() })
      .filter((f) => !f.includes("__tests__"));

    // Parse with the TypeScript compiler, NOT a regex. Real call sites wrap:
    // `withinLimit(` at server/usecases/entrants.ts:243 spans four lines, and any
    // regex anchoring the closing paren to the key string skips every one of
    // them — a guard that reports clean while missing offenders is worse than
    // no guard at all. `typescript` is already a dependency.
    const offenders: string[] = [];
    for (const file of files) {
      const src = ts.createSourceFile(
        file,
        readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const fn = node.expression.getText(src);
          const name = fn.split(".").pop() ?? fn;
          if (GATES.has(name)) {
            // arg 0 = orgId, arg 1 = feature key, arg 2 = competitionId.
            // withinLimit takes (orgId, key, wouldBe, competitionId) — 4 args.
            const keyArg = node.arguments[1];
            const wants = name === "withinLimit" ? 4 : 3;
            if (keyArg && ts.isStringLiteral(keyArg) && keys.has(keyArg.text)) {
              if (node.arguments.length < wants) {
                const { line } = src.getLineAndCharacterOfPosition(node.getStart(src));
                offenders.push(`${file}:${line + 1} ${name}("${keyArg.text}")`);
              }
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(src);
    }
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it — it MUST fail now**

```bash
cd apps/web && npx vitest run src/lib/__tests__/pass-scoping-guard.test.ts
```

Expected: FAIL listing the known offenders, including
`server/usecases/registrations.ts` (`entrants.per_division.max`),
`app/slideshow/competitions/[id]/page.tsx` (`realtime`) and
`server/slideshow-data.ts` (`branding`). **Record the exact list — it is Phase 2's
work queue.**

- [ ] **Step 3: Commit the failing guard**

```bash
git add apps/web/src/lib/__tests__/pass-scoping-guard.test.ts
git commit -m "test(entitlements): guard against pass grants resolved without a competition"
```

Note: this test stays RED until Task 11. That is intentional and must be called
out in the commit body so nobody "fixes" it by weakening the assertion.

---

# Phase 1b — Repackage before sweeping

## Task 5b: Open branding and paid registration to community (D18/D19/D20)

**This lands BEFORE Task 6.** It changes which keys the pass actually lifts, and the
Task 5 guard computes its offender list from that set — so sweeping first would mean
threading `competitionId` through sites that are about to stop needing it.

**Files:**
- Create: `db/migration/deltas/V310__community_branding_and_paid_registration.sql`
  *(shipped as V309, renumbered to V310 — `V309__billing_groups.sql` was claimed
  concurrently on the `feat/billing-groups` branch. **V309 belongs to them; claim V311+
  in `/tmp/seaznclub/RESERVATIONS.md` before writing any new migration.**)*
- Test: extend `apps/web/src/lib/__tests__/pricing-matrix.test.ts`

**Current state (verified live 2026-07-21):**

| key | community | event_pass | pro | pro_plus |
|---|---|---|---|---|
| `branding` | false | true | true | true |
| `registration.paid` | false | true | true | true |
| `registration.fee_percent` | **no row → 5% via env** | 5 | 2 | 1 |

**Target state:**

| key | community | event_pass | pro | pro_plus |
|---|---|---|---|---|
| `branding` | **true** | true | true | true |
| `registration.paid` | **true** | true | true | true |
| `registration.fee_percent` | **8 (explicit row)** | 5 | 2 | 1 |

`dashboard.branding` is NOT touched — stays `false` for community and for the pass.

- [ ] **Step 1: Failing test** — assert the four-column fee ladder is 8/5/2/1 and that
      community resolves `branding` and `registration.paid` true. It must fail now.
- [ ] **Step 2: Run it, confirm it fails.**
- [ ] **Step 3: Write V310.** Three `insert … on conflict (plan_key, feature_key) do
      update` statements. Unqualified DDL, app schema `seazn_club`.

      **The explicit community fee row is load-bearing.** `feePercentFor`
      (`server/usecases/registrations.ts:62`) reads `getLimit` and falls back to
      `platformFeeDefault()` when the value is null or `<= 0`
      (`lib/platform-settings.ts:15`, default 5). Without a real row community would
      silently charge 5% — identical to the pass — and D20's entire fee story would be
      a no-op.
- [ ] **Step 4: `npm run db:apply`, tests pass.**
- [ ] **Step 5: Re-run the Task 5 guard and record the new offender list.** `branding`
      and `registration.paid` should drop out of the lifted set, resolving the four
      org-level offenders without editing those files.
      `registration.fee_percent` STAYS lifted (8 vs 5) and still needs scoping.
- [ ] **Step 6: Commit** — `feat(pricing): logos and paid registration for everyone, fee ladder 8/5/2/1`

**Follow-on consequences to handle in later tasks, not here:**
- `server/usecases/stripe-connect.ts:99` gates Connect onboarding on `registration.paid`
  with an inline any-pass escape. With community `true` that gate is now trivially
  satisfied — simplify it in Phase 2 rather than extracting `hasFeatureOnAnyPass`.
- Task 18 copy: the pass no longer unlocks entry fees, it **discounts** them.
- `/pricing` already renders a folded fees row (`lib/pricing-matrix.ts:80-91`), so the
  ladder should surface there automatically — verify it does.

# Phase 2 — Close the pass-scoping gaps

## Task 6: The revenue bug — public registration caps at 16

**Files:**
- Modify: `apps/web/src/server/usecases/registrations.ts:828`
- Test: `apps/web/src/server/usecases/__tests__/registrations-pass-quota.test.ts` (create)

A pass holder's public registration rejects the 17th entrant despite paying for
32. `ctx.competition_id` is already used twelve lines above at `:816`.

- [ ] **Step 1: Failing test** — seed a pass, open public registration, submit
  entrant 17, expect success.
- [ ] **Step 2: Run it, confirm it 402s.**
- [ ] **Step 3: Add the third argument:**

```ts
const quota = await withinLimit(
  ctx.org_id,
  "entrants.per_division.max",
  n + 1,
  ctx.competition_id,
);
```

- [ ] **Step 4: Test passes.**
- [ ] **Step 5: Commit** — `fix(registrations): honour the Event Pass entrant cap on public signup`

---

## Task 7: Deliver `realtime` (D5)

**Files:**
- Modify: `apps/web/src/app/slideshow/competitions/[id]/page.tsx:40`
- Modify: `apps/web/src/app/slideshow/divisions/[id]/page.tsx:26`
- Modify: `apps/web/src/server/public-site/data.ts:373`, `:481`
- Test: `apps/web/src/server/__tests__/pass-realtime.test.ts` (create)

`id` **is** the competition id at the first site (`:21-24`); `division.competition_id`
is fetched at `:23` in the second; `shell.competition.id` is in the same closure
at the third; `c.id` is joined at the fourth (`:484`).

- [ ] **Step 1: Failing test** — pass-holding community org gets `realtime` true
  for the passed competition and false for another.
- [ ] **Step 2: Run, confirm fail.**
- [ ] **Step 3: Thread the competition id at all four sites.**
- [ ] **Step 4: Test passes.**
- [ ] **Step 5: Commit** — `fix(slideshow): the Event Pass actually delivers realtime`

---

## Task 8: Deliver competition-scoped `branding` (D4)

**Files:**
- Modify: `apps/web/src/server/slideshow-data.ts:84-85` — `orgBoardChrome` gains a `competitionId` parameter
- Modify: both slideshow callers (`competitions/[id]/page.tsx:41`, `divisions/[id]/page.tsx:27`)
- Modify: `apps/web/src/server/public-site/data.ts:178-182` — `loadOrg(orgSlug, competitionId?)`
- Test: `apps/web/src/server/__tests__/pass-branding.test.ts` (create)

**Scope reminder:** this renders the **org's existing** logo and brand colour on
the passed competition's surfaces. No per-competition logo entity, no upload
surface, no schema change.

`loadOrg` has two callers: `getPublicCompetition:233` (competition known) and
`getPublicOrg:206` (genuinely org-scoped — pass nothing). Their `unstable_cache`
keys already differ (`["pub-comp", …]` at `:262` vs `["pub-org", …]` at `:216`),
so no cache collision.

- [ ] **Step 1: Failing test** — passed competition's public page carries the org
  logo; an unpassed competition in the same org does not.
- [ ] **Step 2: Run, confirm fail.**
- [ ] **Step 3: Add the parameter and thread it.**
- [ ] **Step 4: Test passes.**
- [ ] **Step 5: Commit** — `feat(branding): the Event Pass brands the competition it paid for`

---

## Task 9: Deliver `exports.branded` (D6)

**Files:**
- Modify: `apps/web/src/server/usecases/exports.ts:131`
- Test: `apps/web/src/server/usecases/__tests__/exports-pass-branded.test.ts` (create)

The matrix row landed in Task 2's V306. `competitionId` is already a parameter of
the same function (`exports.ts:129`) and is used two lines later at `:132`.

- [ ] **Step 1: Failing test** — branded export for a passed competition carries
  the masthead; unpassed does not.
- [ ] **Step 2: Run, confirm fail.**
- [ ] **Step 3:** `await hasFeature(auth.orgId, "exports.branded", competitionId)`
- [ ] **Step 4: Test passes.**
- [ ] **Step 5: Commit** — `feat(exports): branded print for a passed competition`

---

## Task 10: Two smaller live gaps

**Files:**
- Modify: `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/registrations/page.tsx:34` — `competition` is in scope at `:27`
- Modify: `apps/web/src/app/admin/orgs/[id]/page.tsx:87` — `feePercentFor(id)` drops the competition, so staff see the platform default instead of the pass's 5%
- Test: extend `apps/web/src/server/usecases/__tests__/registrations-pass-quota.test.ts`

- [ ] **Step 1: Failing assertions for both.**
- [ ] **Step 2: Run, confirm fail.**
- [ ] **Step 3: Thread the competition id at both sites.**
- [ ] **Step 4: Tests pass.**
- [ ] **Step 5: Commit** — `fix(entitlements): paid-registration control and staff fee view see the pass`

---

## Task 11: Sweep the latent sites, turn the guard green

**Files:** every file the Task 5 guard listed. Expect roughly 27 groups:
`stages.ts:151,155,159,181,1316`, `scoring.ts:262,268`,
`schedule.ts:95,471,673`, `schedule-ai.ts:1302`, `history.ts:339,546`,
`officials.ts:373,375,414,491,496,666`, `officials-ai.ts:938,940`,
`discipline.ts:438,454,480,501,529,645`, `match-reports.ts:269`,
`official-marks.ts:68,84`, `divisions.ts:420`, `org-posts.ts:395`,
`player-stats.ts:99`, `device-links.ts:105`, `competitions.ts:221,224`,
`registrations.ts:514,766,1944`, `api-v1/auth.ts:138`, `api-keys.ts:42,47`,
`embed-data.ts:64`, plus the UI gates at
`compSlug/settings/page.tsx:39,40`, `compSlug/schedule/page.tsx:35,76,77,78`,
`d/new/page.tsx:25`, `divSlug/schedule/page.tsx:66,67,68,85`,
`divSlug/page.tsx:110,493,498`,
`api/admin/competitions/[id]/discovery/route.ts:33`.

**Do NOT touch** the genuinely org-level sites: `clubs.ts`, `teams.ts`,
`imports.ts:200,210,215`, `officials.ts:64,257`, `official-marks.ts:91`,
`invites.ts:68`, `role/route.ts:23`, `entitlement-freeze.ts:64,104`,
`competitions.ts:89,105,118`, `admin-plan.ts:147`, `billing/page.tsx:109-111`,
`settings/page.tsx:117,133,134,158`, `directory/page.tsx:137`,
`admin/orgs/[id]/page.tsx:47`, `logo-upload-url/route.ts:15`,
`stripe-connect.ts:99`.

- [ ] **Step 1:** Run the guard, take its output as the queue.
- [ ] **Step 2:** Thread `competitionId` at each listed site. Several resolve the
  competition a few lines *after* the gate — move the query above the gate.
- [ ] **Step 3:** Guard goes green.

```bash
cd apps/web && npx vitest run src/lib/__tests__/pass-scoping-guard.test.ts
```

- [ ] **Step 4: Full suite.**
- [ ] **Step 5: Commit** — `fix(entitlements): thread the competition through every scopable gate`

---

# Phase 3 — Money leaves a trace

## Task 12: Link the Stripe customer on pass purchase

**Files:**
- Modify: `apps/web/src/lib/billing.ts:546-570` (`reconcilePassCheckout`)
- Modify: `apps/web/src/server/usecases/billing-events.ts` (webhook pass path)
- Test: `apps/web/src/lib/__tests__/billing-pass-customer-link.test.ts` (create)

**This is load-bearing.** Without it the invoice never reaches the billing page
and the D12 credit lands on an orphan customer. Verified precondition: every org
gets a `subscriptions` row at creation (`lib/auth.ts:242-245`), so
`linkStripeCustomer`'s `if (!before) return` guard (`billing.ts:331`) will not
no-op.

- [ ] **Step 1: Failing test** — after `reconcilePassCheckout`,
  `subscriptions.stripe_customer_id` equals the session's customer.
- [ ] **Step 2: Run, confirm fail.**
- [ ] **Step 3:** add, mirroring `reconcileCheckout:591-595`:

```ts
if (session.customer) {
  await linkStripeCustomer(orgId, session.customer as string);
}
```

- [ ] **Step 4: Test passes.**
- [ ] **Step 5: Commit** — `fix(billing): a pass purchase links its Stripe customer`

---

## Task 13: Invoice, currency pin, and the tax 400

**Files:**
- Modify: `apps/web/src/lib/billing.ts:137-163` (`buildPassCheckoutParams`)
- Modify: `apps/web/src/app/api/billing/pass-checkout/route.ts:54-71`
- Modify: `apps/web/src/lib/billing.ts` — currency stamp in the pass reconcile
- Test: extend `apps/web/src/lib/__tests__/billing-checkout.test.ts`

- [ ] **Step 1: Failing tests** for three things: params carry
  `invoice_creation.enabled` and a description naming the competition; the pass
  reconcile stamps `subscriptions.currency`; an existing-customer session carries
  `customer_update`.
- [ ] **Step 2: Run, confirm fail.**
- [ ] **Step 3: Implement.** Add `competitionName: string` to the builder args and:

```ts
invoice_creation: {
  enabled: true,
  invoice_data: { description: `Event Pass — ${args.competitionName}` },
},
...(args.customerId ? { customer_update: { address: "auto" as const } } : {}),
```

Currency pin (D14), reusing `syncSubscription`'s never-overwrite shape
(`billing.ts:451`):

```sql
update subscriptions
set currency = coalesce(currency, ${session.currency})
where org_id = ${orgId}
```

- [ ] **Step 4: Probe the tax 400 against live test-mode Stripe.** Follow the
  pattern in `apps/web/src/lib/__tests__/billing-proration.live.test.ts`. Create a
  session for a customer that has no address, with `automatic_tax` on, both with
  and without `customer_update`. Record the actual error text in the test comment.
- [ ] **Step 5: Apply the same `customer_update` fix to `buildEmbeddedCheckoutParams`** if the probe confirms it.
- [ ] **Step 6: Tests pass. Commit** — `feat(billing): Event Pass purchases produce a real invoice`

---

## Task 14: In-app purchases section

**Files:**
- Modify: `apps/web/src/server/usecases/billing-manage.ts` — add `passes` to the overview
- Modify: `apps/web/src/app/o/[orgSlug]/settings/billing/page.tsx:285-300`
- Create: `apps/web/src/components/billing-pass-purchases.tsx`
- Test: `apps/web/src/server/usecases/__tests__/billing-overview-passes.test.ts` (create)

Rows: competition name, purchase date, amount, link to the competition, link to
the hosted invoice.

- [ ] **Step 1: Failing test** — overview returns one row per pass with the
  competition name resolved.
- [ ] **Step 2: Run, confirm fail.**
- [ ] **Step 3: Implement** — join `competition_passes` to `competitions`; take
  the amount from the invoice created in Task 13.
- [ ] **Step 4: Test passes.**
- [ ] **Step 5: Screenshot desktop + mobile.**
- [ ] **Step 6: Commit** — `feat(billing): Event Pass purchases appear on the billing page`

---

## Task 15: Pass-to-Pro upgrade — credit and card (D12/D13)

**Files:**
- Modify: `apps/web/src/lib/billing.ts:37-86` (`buildEmbeddedCheckoutParams` gains `requireCard`)
- Modify: `apps/web/src/app/api/billing/checkout/route.ts:54-66`
- Create: `apps/web/src/server/usecases/pass-credit.ts`
- Test: `apps/web/src/server/usecases/__tests__/pass-credit.test.ts` (create)

**Rules:** credit the full pass price if bought ≤30 days ago; **cap at one pass**
(the most recent), not the sum; no credit if the pass was refunded; applies to
Pro **and** Pro Plus; only when `subscriptions.currency` matches the pass
currency — which D14 makes automatic.

Delivered as a **customer balance credit**, not a coupon: Checkout rejects
`discounts` together with `allow_promotion_codes`, and both builders set the
latter.

- [ ] **Step 1: Failing tests** for each rule above, including the 31-day
  boundary and the refunded-pass case.
- [ ] **Step 2: Run, confirm fail.**
- [ ] **Step 3: Implement `creditPassTowardSubscription(orgId)`** creating a
  `customer_balance_transaction` for the pass amount, idempotent per pass intent.
- [ ] **Step 4: `requireCard`** — replace the `trialDays > 0` implication:

```ts
...(args.trialDays > 0 && !args.requireCard
  ? { payment_method_collection: "if_required" as const }
  : {}),
```

The checkout route sets `requireCard: true` when the org holds any pass.

- [ ] **Step 5: Tests pass. Commit** — `feat(billing): credit an Event Pass toward Pro, and take a card`

---

# Phase 4 — Offer, gate and copy

## Task 16: Competition layout + pass context

**Files:**
- Create: `apps/web/src/app/o/[orgSlug]/c/[compSlug]/layout.tsx`
- Create: `apps/web/src/components/competition-pass-provider.tsx`
- Test: `apps/web/e2e/event-pass.spec.ts` (created in Task 22)

**READ `node_modules/next/dist/docs/` ON LAYOUTS BEFORE WRITING THIS FILE.**
No layout exists at this level today; params are async in this version.

- [ ] **Step 1:** Read the layout docs. Note the params signature you find.
- [ ] **Step 2:** Create the layout resolving `competition_passes` once and
  wrapping children in the provider.
- [ ] **Step 3:** Provider exposes `usePassActive(): boolean`, defaulting false
  outside a competition so `UpgradeGate` behaves as today elsewhere.
- [ ] **Step 4: `npx tsc --noEmit`.**
- [ ] **Step 5: Commit** — `feat(console): competition layout provides Event Pass state`

---

## Task 17: Three gate states (D1)

**Files:**
- Modify: `apps/web/src/components/upgrade-gate.tsx`
- Test: `apps/web/src/components/__tests__/upgrade-gate.test.tsx` (create)

- [ ] **Step 1: Failing tests** for all three states from the spec table.
- [ ] **Step 2: Run, confirm fail.**
- [ ] **Step 3: Implement.** `passHref` becomes null when `usePassActive()` is
  true; the ceiling state renders Pro-only with the credit line.
- [ ] **Step 4: Correct `PASS_FEATURES`** — remove `exports`; add
  `exports.branded`, `sponsors.tiers`, `sponsors.monetize`,
  `scheduling.ai.runs_per_division.max`.
- [ ] **Step 5: Tests pass. Commit** — `fix(upgrade): never re-sell a pass the org already holds`

---

## Task 18: Copy alignment across four surfaces

**Files:**
- Modify: `apps/web/src/lib/pricing-cards.ts:14-21`
- Modify: `apps/web/src/app/o/[orgSlug]/c/[compSlug]/upgrade/page.tsx:16-22`
- Modify: `apps/web/src/config/stripe-plans.json` — `passes[0].product.description`
- Modify: `apps/web/src/lib/feature-copy.ts` — add `sponsors.tiers`, `sponsors.monetize`, `branding`
- Modify: `apps/web/src/lib/entitlement-domains.ts` — add `scheduling.ai.runs_per_division.max`
- Modify: all four dictionaries + `apps/web/src/lib/i18n-keys.ts`
- Test: `apps/web/src/lib/__tests__/pricing-matrix.test.ts` (extend)

The bullets must describe what the matrix delivers after Phase 2: 10 divisions,
32 entrants, advanced formats, entry fees at 5%, **competition branding**,
**branded exports**, **realtime**, **sponsor tiers and monetization**, 10 AI runs
per division. Drop the plain-exports claim — community has had those since V285.

**Also state what it does NOT include**: `members.max` falls through to
community's 3.

- [ ] **Step 1: Failing test** — i18n parity across four locales for every new key.
- [ ] **Step 2: Run, confirm fail.**
- [ ] **Step 3: Write the copy in all four surfaces and four locales.**
- [ ] **Step 4: Re-run `npm run stripe:sync`** so the product description updates in Stripe.
- [ ] **Step 5: Tests pass. Commit** — `fix(pricing): the Event Pass describes what it actually delivers`

---

# Phase 5 — Discovery, checkout parity, redesign

## Task 19: Four entry points (D3)

**Files:**
- Modify: competition header/settings, `settings/billing/page.tsx`, `/pricing` pass column, competition list

`routes.competitionUpgrade` currently has exactly one inbound link
(`upgrade-gate.tsx:39`), reachable only after a gate has bitten.

- [ ] **Step 1:** Add all four. Community orgs only; "Event Pass active" chip when held.
- [ ] **Step 2:** Screenshot each, desktop + mobile.
- [ ] **Step 3: Commit** — `feat(upgrade): make the Event Pass discoverable`

---

## Task 20: Checkout parity (D11)

**Files:**
- Modify: `apps/web/src/components/pass-upgrade.tsx:34-53`

Pro uses `<Modal title="Complete your upgrade" size="lg">` (`billing-actions.tsx:49`).
The pass renders inline with a `-mx-9 w-auto sm:mx-0` full-bleed hack and a bare
text "Cancel". Move it onto the same `Modal` and drop the hack — `Modal` already
caps the sheet at 85vh and handles phone widths.

- [ ] **Step 1:** Rewrite using `Modal`.
- [ ] **Step 2:** Screenshot both checkouts side by side, desktop + mobile. They
  should be indistinguishable apart from the line item.
- [ ] **Step 3: Commit** — `style(billing): one checkout presentation for Pro and Event Pass`

---

## Task 21: Upgrade page redesign (D10)

**Files:**
- Modify: `apps/web/src/app/o/[orgSlug]/c/[compSlug]/upgrade/page.tsx`

**Invoke the frontend-design skill first.** States: not-owned (owner),
not-owned (non-owner), owned, owned-at-ceiling, already-Pro. The owned state must
gain a Pro CTA and a receipt link — today it is a dead-end green box.

Visual direction is the implementer's call this session; screenshot desktop +
mobile and show the result with reasoning.

- [ ] **Step 1:** Invoke frontend-design.
- [ ] **Step 2:** Build all five states.
- [ ] **Step 3:** Screenshot each, both viewports.
- [ ] **Step 4: Commit** — `feat(upgrade): rebuild the Event Pass page around its real states`

---

# Phase 6 — Regression suites (D15)

## Task 22: E2E

**Files:**
- Create: `apps/web/e2e/event-pass.spec.ts`
- Modify: `apps/web/e2e/billing.spec.ts`, `apps/web/e2e/pricing-v3.spec.ts`, `apps/web/e2e/mobile.spec.ts`
- Reference: `apps/web/e2e/helpers.ts`, `apps/web/e2e/billing-states.spec.ts`

Cover U1, U6, U7, U12, U14, U15 at desktop **and** mobile, with a real 4242
purchase through embedded checkout against Stripe test mode.

- [ ] **Step 1:** Write the spec file.
- [ ] **Step 2:** Run locally. **Do not enable `e2e.yml`.**
- [ ] **Step 3:** Confirm no test is skipped. A skipped test is not a passing test.
- [ ] **Step 4: Commit** — `test(e2e): Event Pass purchase, ceiling, receipt and upgrade`

---

## Task 23: Smoke

**Files:**
- Modify: `scripts/smoke.ts`

Existing helpers: `grantPass` at `:2610`, used at `:486`, `:576`, `:974`, `:3147`.
Extend both the pro and free paths to assert every newly delivered grant:
`realtime`, `branding`, `exports.branded`, `sponsors.tiers`, `sponsors.monetize`,
the 32-entrant public registration cap, and the AI run quota of 10.

- [ ] **Step 1:** Extend.
- [ ] **Step 2:** `SMOKE_BASE=http://localhost:3021 npx tsx scripts/smoke.ts`
- [ ] **Step 3:** All checks pass, zero new stranded rows.
- [ ] **Step 4: Commit** — `test(smoke): assert every Event Pass grant end to end`

---

## Task 24: Help pages and final verification

**Files:**
- Modify: `apps/web/content/help/billing/event-pass.md`, `plans.md`, `downgrade.md`

- [ ] **Step 1:** Rewrite the Event Pass help page around the corrected offer,
  including the Pro-upgrade credit and what the pass does not include.
- [ ] **Step 2:** Full verification:

```bash
cd apps/web && npx tsc --noEmit && npx vitest run
```

- [ ] **Step 3:** Run E2E and smoke once more.
- [ ] **Step 4:** Update `HANDOFF.md` per the session-end protocol.
- [ ] **Step 5: Commit** — `docs(help): the Event Pass page matches the product`

---

---

## Task 25: Retire the compatibility shim and make CI run these suites

**Files:**
- Create: `db/migration/deltas/V308__drop_org_has_feature_2arg.sql`
- Modify: `.github/workflows/ci.yml:199`

Two loose ends that can only close once everything else has landed.

**The shim.** Task 2 kept `org_has_feature(uuid, text)` as a delegating wrapper so
callers could migrate one task at a time. By now Task 4 has moved
`public_players_v` and Task 8 has moved `server/public-site/data.ts:178-182,373`.
Confirm nothing calls the 2-arg form, then drop it — otherwise a future caller
silently gets pass-blind resolution, which is the exact bug class this branch exists
to kill.

**CI.** `.github/workflows/ci.yml:58` runs the unit job with no `DATABASE_URL`, so
every DB-gated suite skips. The integration job (line 149) has a database but scopes
vitest to `src/server` (line 192) plus one named file,
`src/lib/__tests__/rate-limit.redis.test.ts` (line 199). Nothing under
`src/lib/__tests__` that needs a database runs. That means the parity harness from
Task 1 and the guard from Task 5 protect nothing after merge. Pre-existing —
`entitlements-comp-liveness.test.ts` and `entitlements-pastdue.test.ts` have the same
hole.

- [ ] **Step 1:** Grep the whole tree for 2-arg `org_has_feature(` calls. Expect zero.
- [ ] **Step 2:** Write V308 dropping the wrapper. Unqualified DDL.
- [ ] **Step 3:** `npm run db:apply`, then full suite.
**Env consolidation (owner decision 2026-07-21).** The same problem in miniature: the
root `.env.local` is read by NOTHING in `package.json`, `db:apply` relies on
`DATABASE_URL` already being exported (`scripts/flyway.sh:16`), and `vitest run` loads
no env file at all — so a local run silently skips ~692 DB tests and reports green.

Root becomes the single canonical file:

- [ ] **Step 3a:** Merge `NEXT_PUBLIC_POSTHOG_HOST` and `NEXT_PUBLIC_POSTHOG_KEY` (today
      only in `apps/web/.env.local`) into the root `.env.local`, then replace
      `apps/web/.env.local` with a symlink to `../../.env.local`. Next.js follows
      symlinks, so every existing `--env-file=apps/web/.env.local` script keeps working.
      **Do not commit either file** — both are gitignored. Document the symlink step in
      `.env.example` so a fresh clone reproduces it.
- [ ] **Step 3b:** Add `--env-file-if-exists=.env.local` to the `db:*` scripts in the root
      `package.json`. That flag is already used by `stripe:sync` and `i18n:translate`, so
      it is a proven pattern in this repo.
- [ ] **Step 3c:** Load the root env in `apps/web/vitest.config.ts` (`process.loadEnvFile`,
      guarded so a missing file is not fatal in CI where vars come from the environment).
      **Expect this to surface pre-existing failures** — suites that have been skipping
      will start executing. Report them; do not paper over them.

**Local Redis (owner decision 2026-07-21).** The third face of the same problem. With
`REDIS_URL` unset locally the entitlement cache is inert, so cache-staleness bugs are
invisible until a Redis-backed target runs them. Two such bugs shipped into this branch
and were only caught by review, not by a test.

`REDIS_URL` is a **single switch controlling two subsystems**: the fail-open cache
(`lib/cache.ts:35-36`) and the rate limiter, which goes from inert to enforcing
(`lib/rate-limit.ts:40-48`). The auth limits are keyed by **IP**, not user —
`magic-link/route.ts:62` is `magic-link:${ip}` at 5 per 300s — and smoke signs in ~40
users from one IP. So switching Redis on without addressing the limiter hard-breaks
smoke and the Playwright auth setup at the 6th sign-in.

- [ ] **Step 3d:** Add a local Redis (`redis://localhost:6379`; `lib/cache.ts:20` uses
      ioredis, so a plain container works) and document the setup — compose file or
      README — so a fresh clone reproduces it.
- [ ] **Step 3e:** Reset the rate-limit counter from `scripts/smoke.ts` and the Playwright
      auth setup **before each sign-in, not once before the burst.** `max` is 5 per 300s
      and smoke signs in ~40 users, so a single flush still 429s on the 6th. Everything
      comes from one IP, so this is one `DEL rl:magic-link:<ip>` per call (add
      `rl:magic-link-consume:<ip>` if the consume step trips `AUTH_LIMIT`'s 10/60).

      **Do NOT make the limits configurable.** Redis holds only the counter — `incrWindow`
      (`lib/cache.ts:96-105`) is a Lua `INCR`+`EXPIRE` returning an integer; `max` and
      `windowSeconds` are code constants in `rate-limit.ts:62-70` compared in application
      memory. Adding an env knob would mean shipping a way to weaken a security control in
      production. Deleting the counter is arithmetically identical and test-side only.

      No teardown needed: the Lua script sets `EXPIRE`, so counters self-expire.
- [ ] **Step 3f:** Re-run smoke and the full suite with `REDIS_URL` set. **Expect
      failures that have been invisible** — that is the point. Report them; do not paper
      over them. Land this AFTER the entitlement fixes so a red run means a new find,
      not a known one.

- [ ] **Step 4:** Widen the integration job to run the `src/lib/__tests__` DB suites.
- [ ] **Step 5:** Confirm the newly-included suites actually RUN — count them in the
      output. A suite that silently skips in CI is worse than no suite, because it
      reads as coverage.
- [ ] **Step 6: Commit** — `ci: run the entitlement DB suites, drop the 2-arg shim`

---

## Self-review notes

- **Spec coverage:** D1→T17, D2→T13/T14, D3→T19, D4→T8, D5→T7, D6→T2/T9,
  D7→T17/T18, D8→T2/T3, D9→Phase 1 ordering, D10→T21, D11→T20, D12→T15,
  D13→T15, D14→T13, D15→T22/T23/T24, D16→phase order.
- **Resolved pre-flight:** Task 2 Step 2 originally carried a snippet with a
  `'community'` literal that is wrong for a paid org. Replaced with the full
  corrected `resolveFromDb`. Paste that one verbatim.
- **Known gap:** Tasks 4, 6-11, 19 give the shape of each test rather than full
  code. Write them against the local-seed convention shown in Task 1 — copy the
  `seedOrg` helper shape and adapt. Do **not** invent a shared factories module;
  this codebase does not have one, and an earlier draft of this plan referenced a
  fabricated `@/lib/__tests__/helpers/factories`.
- **Every DB suite must run with `DATABASE_URL` set.** They `skipIf(!HAS_DB)` and
  will otherwise report green having asserted nothing.
- **Red test by design:** Task 5's guard stays failing until Task 11.
