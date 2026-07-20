# One Trial Per Organisation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `subscriptions.trial_used_at` mean "this org has already had Pro" on every route that grants it, give the staff trial-grant a real effect, stop a dunning org minting a second subscription, and brand the embedded checkout.

**Architecture:** All changes are code — no migration. One shared liveness predicate in `lib/billing.ts` decides whether an org is Stripe-billed; `assertCheckoutAllowed` and `extendTrial` both consume it so they cannot drift. Staff grants convey Pro through the existing `comped_until` machinery, which self-expires at read time.

**Tech Stack:** Next 16 (App Router, RSC), TypeScript, postgres.js, Stripe (stripe-node v22, API `2026-06-24.dahlia`), vitest, Playwright.

Spec: `docs/superpowers/specs/2026-07-20-one-trial-per-org-design.md`

## Global Constraints

- **One migration, V303 only** (added 2026-07-20 for Task 4C). Tasks 1-4 and 5-9 add none — `trial_used_at` (V277) and `comped_until` already exist. V303 adds `subscriptions.has_payment_method`.
- **DB-backed vitest needs an explicit URL.** Run from `apps/web`:
  `DATABASE_URL="postgresql://ashokhein@localhost:5432/seazn" DATABASE_SSL=disable npx vitest run <path>`.
  Without it every DB suite silently **skips** and reports green.
  `postgresql://localhost:...` (no user) fails TLS — `lib/db.ts` only treats `@localhost` as local.
- **`trial_used_at` is never cleared** except by the Restore trial action in Task 6.
- **Liveness rule, used everywhere:** an org is Stripe-billed when
  `stripe_subscription_id is not null AND status in ('trialing','active','past_due')`.
  A cancelled subscription keeps its id forever — never branch on the column alone.
- **The 400/409 arms write nothing** — guard before any DB write and before any Stripe call.
- **i18n:** any new user-facing string needs all four locales (`en`, `fr`, `es`, `nl`) plus `npm run i18n:gen-keys`. Admin-panel copy is English-only (the panel is not localised).
- **Help pages are mandatory** (Task 9) — `apps/web/content/help/billing/plans.md` already promises "one trial per organisation".
- **Visual sign-off gate:** Tasks 7–8 change a paid surface. Screenshot and get the user's pick **before** merge. Do not choose the palette unilaterally.

---

### Task 1: `syncSubscription` stamps on first sync of any subscription

Closes the dashboard-created / invoice-billed leak: a subscription that never trialed leaves `trial_used_at` null today, so after cancelling, the org is offered a fresh 14-day trial.

**Files:**
- Modify: `apps/web/src/lib/billing.ts:181-219` (the `syncSubscription` upsert)
- Test: `apps/web/src/lib/__tests__/billing-sync-trial.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: no signature change. `syncSubscription(orgId: string, stripeSub: Stripe.Subscription): Promise<void>` behaves the same except `trial_used_at` is always non-null after it returns.

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe.skipIf(!HAS_DB)("trial_used_at stamping (one trial per org)")` block in `apps/web/src/lib/__tests__/billing-sync-trial.test.ts`:

```ts
  // A subscription created in the Stripe dashboard (invoice-billed, no trial)
  // is still an org that has HAD Pro — V277's own backfill counted it, the
  // ongoing code did not.
  it("stamps a subscription that never carried a trial", async () => {
    const orgId = await seedOrg();
    const readStamp = async () =>
      (
        await sql<{ trial_used_at: string | null }[]>`
          select trial_used_at from subscriptions where org_id = ${orgId}`
      )[0].trial_used_at;

    await syncSubscription(orgId, stripeSub({ id: "sub_notrial", status: "active" }));
    const stamped = await readStamp();
    expect(stamped).not.toBeNull();
    expect(checkoutTrialDays({ trial_used_at: stamped })).toBe(0);
  });

  it("a replay of the same event does not re-date the stamp", async () => {
    const orgId = await seedOrg();
    const readStamp = async () =>
      (
        await sql<{ trial_used_at: string | null }[]>`
          select trial_used_at from subscriptions where org_id = ${orgId}`
      )[0].trial_used_at;

    await syncSubscription(orgId, stripeSub({ id: "sub_replay", status: "active" }));
    const first = await readStamp();
    await syncSubscription(orgId, stripeSub({ id: "sub_replay", status: "active" }));
    expect(await readStamp()).toEqual(first);
  });

  // Task 7 of the payments wave clears dispute flags on a re-buy. That reset
  // must not take trial_used_at with it — they share one upsert.
  it("a re-buy under a NEW subscription id keeps the original stamp", async () => {
    const orgId = await seedOrg();
    const readStamp = async () =>
      (
        await sql<{ trial_used_at: string | null }[]>`
          select trial_used_at from subscriptions where org_id = ${orgId}`
      )[0].trial_used_at;

    await syncSubscription(orgId, stripeSub({ id: "sub_first", status: "active" }));
    const first = await readStamp();
    await sql`update subscriptions set status = 'canceled' where org_id = ${orgId}`;
    await syncSubscription(orgId, stripeSub({ id: "sub_second", status: "active" }));
    expect(await readStamp()).toEqual(first);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd apps/web && DATABASE_URL="postgresql://ashokhein@localhost:5432/seazn" DATABASE_SSL=disable npx vitest run src/lib/__tests__/billing-sync-trial.test.ts
```

Expected: the three new tests FAIL with `expected null not to be null` (and the replay/re-buy cases failing on `null` equality). The two pre-existing tests still PASS. If everything reports "skipped", the `DATABASE_URL` is missing — fix that before continuing.

- [ ] **Step 3: Change the upsert**

In `apps/web/src/lib/billing.ts`, in the `on conflict (org_id) do update set` block, replace the `trial_used_at` line:

```sql
      -- One trial per org: stamped the first time a trial appears, never cleared.
      trial_used_at          = coalesce(subscriptions.trial_used_at, excluded.trial_used_at),
```

with:

```sql
      -- One trial per org — and "trial" means "has had Pro". Any subscription
      -- reaching us counts, including a dashboard-created one that never
      -- carried a trial_end (V277's backfill always assumed this; the code
      -- did not). Never cleared except by the staff Restore trial action.
      trial_used_at          = coalesce(subscriptions.trial_used_at,
                                        excluded.trial_used_at, now()),
```

The `values` clause needs no change: it already inserts `now()` when `trial_end` is set, and the insert arm is only reached for an org with no row, where the `null` case is now covered by the update arm's `now()` only on conflict. To cover the **insert** arm too, change the inserted `trial_used_at` expression from:

```ts
       ${stripeSub.trial_end ? new Date().toISOString() : null},
```

to:

```ts
       ${new Date().toISOString()},
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd apps/web && DATABASE_URL="postgresql://ashokhein@localhost:5432/seazn" DATABASE_SSL=disable npx vitest run src/lib/__tests__/billing-sync-trial.test.ts
```

Expected: PASS, all 5.

- [ ] **Step 5: Run the neighbouring billing suites for fallout**

```bash
cd apps/web && DATABASE_URL="postgresql://ashokhein@localhost:5432/seazn" DATABASE_SSL=disable npx vitest run src/lib/__tests__/billing-sync-guards.test.ts src/lib/__tests__/billing-reconcile-invalidate.test.ts src/lib/__tests__/billing-grace-anchor.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/billing.ts apps/web/src/lib/__tests__/billing-sync-trial.test.ts
git commit -m "fix(billing): any subscription burns the org's trial, not just a trialing one"
```

---

### Task 2: `compToPro` stamps

A comp is free Pro — that is the free ride. Without this, comp → downgrade → checkout still offers 14 days.

**Files:**
- Modify: `apps/web/src/server/usecases/admin-plan.ts:67-74` (the `compToPro` update)
- Test: `apps/web/src/server/usecases/__tests__/admin-plan.test.ts`

**Interfaces:**
- Consumes: `checkoutTrialDays` from `@/lib/billing` (already imported by this test file as of commit `f0637762`).
- Produces: no signature change.

- [ ] **Step 1: Write the failing test**

Append inside `describe.skipIf(!HAS_DB)("admin plan tools")`:

```ts
  // A comp is free Pro — the org has had its free ride, so a later self-serve
  // upgrade bills from day one. This is the user-reported symptom: an org that
  // was comped, then downgraded, was still offered the 14-day trial.
  it("comp-to-Pro burns the trial, and a downgrade does not give it back", async () => {
    const { orgId, actorId } = await seedOrg();
    const readSub = async () =>
      (
        await sql<{ trial_used_at: string | null }[]>`
          select trial_used_at from subscriptions where org_id = ${orgId}`
      )[0];
    expect(checkoutTrialDays(await readSub())).toBe(14);

    await compToPro(actorId, orgId, null, "founder friend");
    const stamped = (await readSub()).trial_used_at;
    expect(stamped).not.toBeNull();

    await compToPro(actorId, orgId, null, "extended the comp");
    expect((await readSub()).trial_used_at).toEqual(stamped);

    await adminDowngrade(actorId, orgId, "comp ended");
    expect(checkoutTrialDays(await readSub())).toBe(0);
  });
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd apps/web && DATABASE_URL="postgresql://ashokhein@localhost:5432/seazn" DATABASE_SSL=disable npx vitest run src/server/usecases/__tests__/admin-plan.test.ts -t "burns the trial"
```

Expected: FAIL, `expected null not to be null`.

- [ ] **Step 3: Stamp in `compToPro`**

In `apps/web/src/server/usecases/admin-plan.ts`, replace the update inside `compToPro`:

```ts
  await sql`
    update subscriptions set
      plan_key = 'pro', status = 'active',
      comped_until = ${until ? until.toISOString() : null},
      status_changed_at = case when status is distinct from 'active'
                               then now() else status_changed_at end,
      updated_at = now()
    where org_id = ${orgId}`;
```

with:

```ts
  await sql`
    update subscriptions set
      plan_key = 'pro', status = 'active',
      comped_until = ${until ? until.toISOString() : null},
      -- A comp IS the free ride: the org has had Pro without paying, so a
      -- later self-serve upgrade bills from day one. coalesce keeps the first
      -- comp's date across re-comps. Reversible via Restore trial.
      trial_used_at = coalesce(trial_used_at, now()),
      status_changed_at = case when status is distinct from 'active'
                               then now() else status_changed_at end,
      updated_at = now()
    where org_id = ${orgId}`;
```

- [ ] **Step 4: Run it to verify it passes**

```bash
cd apps/web && DATABASE_URL="postgresql://ashokhein@localhost:5432/seazn" DATABASE_SSL=disable npx vitest run src/server/usecases/__tests__/admin-plan.test.ts
```

Expected: PASS, all tests in the file.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server/usecases/admin-plan.ts apps/web/src/server/usecases/__tests__/admin-plan.test.ts
git commit -m "fix(billing): comp-to-Pro burns the org's one trial"
```

---

### Task 3: `hasLiveSubscription` + `assertCheckoutAllowed` covers `past_due`

An org in dunning still has a live subscription, so today it can open a second checkout and mint a **second** subscription. This task also creates the predicate Task 4 depends on.

**Files:**
- Modify: `apps/web/src/lib/billing.ts:66-79` (`assertCheckoutAllowed`)
- Test: `apps/web/src/lib/__tests__/billing-checkout.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export function hasLiveSubscription(sub: { stripe_subscription_id: string | null; status: string | null } | undefined): boolean`
  - `assertCheckoutAllowed` keeps its signature `(sub) => void`.

- [ ] **Step 1: Write the failing tests**

In `apps/web/src/lib/__tests__/billing-checkout.test.ts`, add `hasLiveSubscription` to the import list from `@/lib/billing`, then append:

```ts
describe("hasLiveSubscription", () => {
  it("is true only for a subscription id in a non-terminal status", () => {
    for (const status of ["trialing", "active", "past_due"]) {
      expect(hasLiveSubscription({ stripe_subscription_id: "sub_1", status })).toBe(true);
    }
  });

  // A cancelled subscription keeps its id forever. Branching on the column
  // alone would send a departed customer down the Stripe rails.
  it("is false for a cancelled subscription that still carries its id", () => {
    expect(hasLiveSubscription({ stripe_subscription_id: "sub_1", status: "canceled" })).toBe(false);
  });

  it("is false with no subscription id, whatever the status", () => {
    expect(hasLiveSubscription({ stripe_subscription_id: null, status: "past_due" })).toBe(false);
    expect(hasLiveSubscription(undefined)).toBe(false);
  });
});

describe("assertCheckoutAllowed past_due", () => {
  // Dunning still owns a live subscription — a second checkout would mint a
  // SECOND subscription for the same org.
  it("409s an org in dunning", () => {
    expect(() =>
      assertCheckoutAllowed({ stripe_subscription_id: "sub_1", status: "past_due" }),
    ).toThrow(/subscription/i);
  });

  // STATUS_MAP folds Stripe's `incomplete` into past_due, so this message is
  // the whole recovery path for an org whose first payment never confirmed.
  it("names the recovery path so the block is not a dead end", () => {
    try {
      assertCheckoutAllowed({ stripe_subscription_id: "sub_1", status: "past_due" });
      throw new Error("expected a 409");
    } catch (e) {
      expect((e as Error).message).toMatch(/payment method|retry/i);
    }
  });

  it("still lets a departed customer buy again", () => {
    expect(() =>
      assertCheckoutAllowed({ stripe_subscription_id: "sub_1", status: "canceled" }),
    ).not.toThrow();
  });

  // A comped org degraded by the past_due grace has no subscription id and
  // must not be locked out of its FIRST purchase.
  it("never blocks an org with no subscription id", () => {
    expect(() =>
      assertCheckoutAllowed({ stripe_subscription_id: null, status: "past_due" }),
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd apps/web && npx vitest run src/lib/__tests__/billing-checkout.test.ts
```

Expected: FAIL — `hasLiveSubscription is not a function`, and the dunning cases fail because nothing throws.

- [ ] **Step 3: Implement**

In `apps/web/src/lib/billing.ts`, replace `assertCheckoutAllowed` with:

```ts
/** Statuses in which a Stripe subscription still owns the org's billing. Our
 *  STATUS_MAP collapses incomplete/unpaid/paused into past_due, so this list
 *  is the whole non-terminal set. `canceled` is terminal — a departed customer
 *  must be able to come back. */
const LIVE_SUBSCRIPTION_STATUSES = ["trialing", "active", "past_due"];

/**
 * Is this org billed by a subscription right now? A cancelled subscription
 * keeps its id on the row forever, so the id alone is NOT the test — anything
 * branching on `stripe_subscription_id` would treat a long-departed customer as
 * Stripe-billed. Shared by the checkout guard and the staff trial grant so the
 * two can never drift apart.
 */
export function hasLiveSubscription(
  sub: { stripe_subscription_id: string | null; status: string | null } | undefined,
): boolean {
  return (
    !!sub?.stripe_subscription_id &&
    LIVE_SUBSCRIPTION_STATUSES.includes(sub.status ?? "")
  );
}

/**
 * A live Stripe subscription means plan changes go through the in-app manage
 * flow — a second checkout would mint a second subscription for the same org.
 * Dunning counts as live: the subscription is still there, it just needs a
 * working card, so the message points at that rather than at a new purchase.
 */
export function assertCheckoutAllowed(
  sub: { stripe_subscription_id: string | null; status: string | null } | undefined,
): void {
  if (!hasLiveSubscription(sub)) return;
  if (sub!.status === "past_due") {
    throw new HttpError(
      409,
      "This organization's subscription needs a working payment method — update your card or retry the invoice from the billing page instead of starting a new subscription.",
    );
  }
  throw new HttpError(
    409,
    "This organization already has a subscription — manage your plan from the billing page instead.",
  );
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd apps/web && npx vitest run src/lib/__tests__/billing-checkout.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/billing.ts apps/web/src/lib/__tests__/billing-checkout.test.ts
git commit -m "fix(billing): a dunning org cannot mint a second subscription"
```

---

### Task 4: `extendTrial` grants real Pro, refuses live Stripe orgs

Today a grant on a Community org writes `status='trialing'` and `trial_end` while leaving `plan_key='community'` — entitlements read `plan_key`, so the org gets **nothing**. This gives the button its meaning and blocks the arm that corrupts billing.

Also widens the entitlement resolver: its comp-expiry branch requires `stripe_subscription_id is null`, so a grant to a **cancelled** org would never expire.

**Files:**
- Modify: `apps/web/src/server/usecases/admin-plan.ts:137-174` (`extendTrial`)
- Modify: `apps/web/src/lib/entitlements.ts:65-72` (comp-expiry branch)
- Test: `apps/web/src/server/usecases/__tests__/admin-plan.test.ts`
- Create: `apps/web/src/server/usecases/__tests__/admin-plan-trial-stripe.test.ts`

**Interfaces:**
- Consumes: `hasLiveSubscription` from `@/lib/billing` (Task 3).
- Produces: `extendTrial(actorId, orgId, days, reason): Promise<string>` — unchanged signature; now throws `HttpError(400)` for a live non-trialing subscription.

- [ ] **Step 1: Write the failing tests**

Append inside `describe.skipIf(!HAS_DB)("admin plan tools")` in `admin-plan.test.ts`:

```ts
  it("a grant to a Community org conveys real Pro, then lapses on its own", async () => {
    const { orgId, actorId } = await seedOrg();
    expect(await hasFeature(orgId, "api.access")).toBe(false);

    await extendTrial(actorId, orgId, 7, "sales call");
    const [row] = await sql<
      { plan_key: string; comped_until: string | null; trial_end: string | null }[]
    >`select plan_key, comped_until, trial_end from subscriptions where org_id = ${orgId}`;
    expect(row.plan_key).toBe("pro");
    expect(row.comped_until).toEqual(row.trial_end);
    expect(await hasFeature(orgId, "api.access")).toBe(true);

    // Clock-controlled lapse — no job flips it, the resolver does.
    await sql`update subscriptions set comped_until = now() - interval '1 minute',
                                       trial_end    = now() - interval '1 minute'
              where org_id = ${orgId}`;
    const { invalidateOrgEntitlements } = await import("@/lib/entitlements");
    await invalidateOrgEntitlements(orgId);
    expect(await hasFeature(orgId, "api.access")).toBe(false);
  });

  it("stacked grants extend from the existing end and keep the first stamp", async () => {
    const { orgId, actorId } = await seedOrg();
    const first = await extendTrial(actorId, orgId, 7, "one");
    const [{ trial_used_at: stamped }] = await sql<{ trial_used_at: string }[]>`
      select trial_used_at from subscriptions where org_id = ${orgId}`;

    const second = await extendTrial(actorId, orgId, 7, "two");
    const days = (new Date(second).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThan(14.1);
    expect(new Date(second).getTime()).toBeGreaterThan(new Date(first).getTime());

    const [after] = await sql<{ trial_used_at: string; comped_until: string }[]>`
      select trial_used_at, comped_until from subscriptions where org_id = ${orgId}`;
    expect(after.trial_used_at).toEqual(stamped);
    expect(new Date(after.comped_until).toISOString()).toBe(second);
  });

  it("does not demote an org already comped above Pro", async () => {
    const { orgId, actorId } = await seedOrg();
    await sql`update subscriptions set plan_key = 'pro_plus' where org_id = ${orgId}`;
    await extendTrial(actorId, orgId, 7, "keep the plus");
    const [row] = await sql<{ plan_key: string }[]>`
      select plan_key from subscriptions where org_id = ${orgId}`;
    expect(row.plan_key).toBe("pro_plus");
  });

  // A cancelled subscription keeps its id. Without the liveness test this org
  // would take the Stripe arm and we would call subscriptions.update on a dead
  // subscription; without the resolver widening, its grant would never expire.
  it("treats a cancelled subscription as no subscription, and the grant still lapses", async () => {
    const { orgId, actorId } = await seedOrg();
    await sql`update subscriptions
                 set stripe_subscription_id = 'sub_dead', status = 'canceled'
               where org_id = ${orgId}`;

    await extendTrial(actorId, orgId, 7, "win-back");
    expect(await hasFeature(orgId, "api.access")).toBe(true);

    await sql`update subscriptions set comped_until = now() - interval '1 minute'
              where org_id = ${orgId}`;
    const { invalidateOrgEntitlements } = await import("@/lib/entitlements");
    await invalidateOrgEntitlements(orgId);
    expect(await hasFeature(orgId, "api.access")).toBe(false);
  });

  it("refuses a live paying subscription and writes nothing", async () => {
    const { orgId, actorId } = await seedOrg();
    await sql`update subscriptions
                 set stripe_subscription_id = 'sub_live', status = 'active',
                     plan_key = 'pro'
               where org_id = ${orgId}`;
    const readRow = async () =>
      (
        await sql<Record<string, unknown>[]>`
          select plan_key, status, trial_end, comped_until, trial_used_at
          from subscriptions where org_id = ${orgId}`
      )[0];
    const before = await readRow();

    await expect(extendTrial(actorId, orgId, 7, "gift")).rejects.toThrow(/Stripe/i);
    expect(await readRow()).toEqual(before);
  });

  it("refuses a subscription in dunning for the same reason", async () => {
    const { orgId, actorId } = await seedOrg();
    await sql`update subscriptions
                 set stripe_subscription_id = 'sub_dunning', status = 'past_due'
               where org_id = ${orgId}`;
    await expect(extendTrial(actorId, orgId, 7, "gift")).rejects.toThrow(/Stripe/i);
  });

  it("still enforces the day bounds", async () => {
    const { orgId, actorId } = await seedOrg();
    await expect(extendTrial(actorId, orgId, 0, "nope")).rejects.toThrow(/1–365/);
    await expect(extendTrial(actorId, orgId, 366, "nope")).rejects.toThrow(/1–365/);
  });
```

- [ ] **Step 1b: Cover the Stripe-facing arms in a mocked file**

`admin-plan.test.ts` deliberately never touches Stripe ("comped orgs only" — its
header says so), so the live-`trialing` arm and the "no Stripe call" assertions
need their own file. Create
`apps/web/src/server/usecases/__tests__/admin-plan-trial-stripe.test.ts`:

```ts
// The Stripe-facing arms of extendTrial. admin-plan.test.ts covers the comped
// paths and never touches Stripe; this file mocks it so we can assert both
// that the trialing arm calls subscriptions.update and — just as important —
// that the arms which must NOT call it never do.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const stripeMock = vi.hoisted(() => {
  const subscriptionUpdate = vi.fn();
  return { subscriptionUpdate, stripe: { subscriptions: { update: subscriptionUpdate } } };
});
vi.mock("@/lib/stripe", () => ({ getStripe: () => stripeMock.stripe }));

import { sql } from "@/lib/db";
import { extendTrial } from "@/server/usecases/admin-plan";

const HAS_DB = !!process.env.DATABASE_URL;

async function seedOrg(): Promise<{ orgId: string; actorId: string }> {
  const s = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"AdmS " + s}, ${"adms-" + s}) returning id`;
  await sql`insert into subscriptions (org_id, plan_key, status)
            values (${orgId}, 'community', 'active') on conflict (org_id) do nothing`;
  const [{ id: actorId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, is_staff, staff_role)
    values (${"staffs-" + s + "@test.local"}, 'Staff', true, 'superadmin') returning id`;
  return { orgId, actorId };
}

beforeEach(() => {
  stripeMock.subscriptionUpdate.mockReset().mockResolvedValue({ id: "sub_ok" });
});

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

describe.skipIf(!HAS_DB)("extendTrial Stripe arms", () => {
  it("pushes trial_end into Stripe for a live trialing sub and leaves comped_until alone", async () => {
    const { orgId, actorId } = await seedOrg();
    await sql`update subscriptions
                 set stripe_subscription_id = 'sub_trialing', status = 'trialing',
                     plan_key = 'pro'
               where org_id = ${orgId}`;

    const end = await extendTrial(actorId, orgId, 7, "sales call");

    expect(stripeMock.subscriptionUpdate).toHaveBeenCalledTimes(1);
    const [subId, params] = stripeMock.subscriptionUpdate.mock.calls[0];
    expect(subId).toBe("sub_trialing");
    expect(params.trial_end).toBe(Math.floor(new Date(end).getTime() / 1000));
    expect(params.proration_behavior).toBe("none");

    const [row] = await sql<{ comped_until: string | null; plan_key: string }[]>`
      select comped_until, plan_key from subscriptions where org_id = ${orgId}`;
    expect(row.comped_until).toBeNull(); // the subscription owns the lifecycle
    expect(row.plan_key).toBe("pro");
  });

  it("never calls Stripe for a cancelled subscription that kept its id", async () => {
    const { orgId, actorId } = await seedOrg();
    await sql`update subscriptions
                 set stripe_subscription_id = 'sub_dead', status = 'canceled'
               where org_id = ${orgId}`;
    await extendTrial(actorId, orgId, 7, "win-back");
    expect(stripeMock.subscriptionUpdate).not.toHaveBeenCalled();
  });

  it("never calls Stripe for the refused arms", async () => {
    for (const status of ["active", "past_due"]) {
      const { orgId, actorId } = await seedOrg();
      await sql`update subscriptions
                   set stripe_subscription_id = ${"sub_" + status}, status = ${status}
                 where org_id = ${orgId}`;
      await expect(extendTrial(actorId, orgId, 7, "gift")).rejects.toThrow(/Stripe/i);
    }
    expect(stripeMock.subscriptionUpdate).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd apps/web && DATABASE_URL="postgresql://ashokhein@localhost:5432/seazn" DATABASE_SSL=disable npx vitest run src/server/usecases/__tests__/admin-plan.test.ts src/server/usecases/__tests__/admin-plan-trial-stripe.test.ts
```

Expected: the seven tests in `admin-plan.test.ts` FAIL — `plan_key` stays `community`, no 400 is thrown, the cancelled-org grant never lapses. In the mocked file, the trialing-arm test FAILS on `comped_until` and the refused-arm test FAILS because nothing throws.

- [ ] **Step 3: Widen the resolver's comp-expiry branch**

In `apps/web/src/lib/entitlements.ts`, replace:

```sql
      when s.comped_until is not null and s.comped_until <= now()
           and s.stripe_subscription_id is null then 'community'
```

with:

```sql
      -- A comp/grant past its end date resolves as community at read time — no
      -- scheduler flips it, the resolution does. A CANCELLED subscription keeps
      -- its id forever, so `is null` alone would leave a win-back grant running
      -- for ever; a live subscription still owns the plan and is exempt.
      when s.comped_until is not null and s.comped_until <= now()
           and (s.stripe_subscription_id is null or s.status = 'canceled')
           then 'community'
```

- [ ] **Step 4: Rewrite `extendTrial`**

In `apps/web/src/server/usecases/admin-plan.ts`, add to the imports:

```ts
import { downgradeToCommunity, hasLiveSubscription } from "@/lib/billing";
```

(replacing the existing `import { downgradeToCommunity } from "@/lib/billing";`)

Then replace the whole body of `extendTrial` after the day-bounds check:

```ts
  const before = await planPanel(orgId);
  const live = hasLiveSubscription(before);
  // Verified against Stripe test mode 2026-07-20: pushing trial_end onto an
  // ACTIVE subscription is accepted but TRUNCATES the paid period to the trial
  // end and rewrites the next invoice (a $19/mo sub paid to 20 Aug came back
  // with period_end 27 Jul and a 429 preview). Dunning is refused for the same
  // reason — the subscription owns the billing timeline either way.
  if (live && before.status !== "trialing") {
    throw new HttpError(
      400,
      "This organization is billed through Stripe — apply a coupon or credit in Stripe instead.",
    );
  }

  const base = before.trial_end && new Date(before.trial_end).getTime() > Date.now()
    ? new Date(before.trial_end)
    : new Date();
  const trialEnd = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
  const iso = trialEnd.toISOString();

  if (live) {
    // Mid-trial on Stripe: push their trial_end so the first charge moves. The
    // plan already came from the price, and comped_until stays out of it — the
    // subscription owns this org's lifecycle.
    await getStripe().subscriptions.update(before.stripe_subscription_id!, {
      trial_end: Math.floor(trialEnd.getTime() / 1000),
      proration_behavior: "none",
    });
    await sql`
      update subscriptions set
        status = 'trialing', trial_end = ${iso},
        trial_used_at = coalesce(trial_used_at, now()),
        status_changed_at = case when status is distinct from 'trialing'
                                 then now() else status_changed_at end,
        updated_at = now()
      where org_id = ${orgId}`;
  } else {
    // No live subscription: the grant has to CONVEY Pro, because entitlements
    // resolve on plan_key — status/trial_end grant nothing. comped_until is the
    // expiry the resolver already honours, so nothing needs to sweep it. Only
    // lift a community org; an org comped at pro_plus must not be demoted.
    await sql`
      update subscriptions set
        plan_key = case when plan_key = 'community' then 'pro' else plan_key end,
        status = 'trialing', trial_end = ${iso}, comped_until = ${iso},
        trial_used_at = coalesce(trial_used_at, now()),
        status_changed_at = case when status is distinct from 'trialing'
                                 then now() else status_changed_at end,
        updated_at = now()
      where org_id = ${orgId}`;
  }

  await invalidateOrgEntitlements(orgId);
  await logStaffAction(actorId, "extend_trial", "org", orgId, {
    reason, days,
    before: { trial_end: before.trial_end, plan_key: before.plan_key },
    after: { trial_end: iso, granted_pro: !live },
  });
  return iso;
```

- [ ] **Step 5: Run to verify it passes**

```bash
cd apps/web && DATABASE_URL="postgresql://ashokhein@localhost:5432/seazn" DATABASE_SSL=disable npx vitest run src/server/usecases/__tests__/admin-plan.test.ts src/server/usecases/__tests__/admin-plan-trial-stripe.test.ts src/lib/__tests__/entitlements-pastdue.test.ts
```

Expected: PASS. `entitlements-pastdue.test.ts` guards the resolver you just edited — if it reds, the `case` arms are in the wrong order.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/server/usecases/admin-plan.ts apps/web/src/lib/entitlements.ts apps/web/src/server/usecases/__tests__/admin-plan.test.ts apps/web/src/server/usecases/__tests__/admin-plan-trial-stripe.test.ts
git commit -m "fix(admin): a granted trial conveys real Pro and expires itself"
```

---

### Task 4C: The trial banner must not ask for a card the org already gave

User-reported 2026-07-20: "I already added the payment method but it is still showing
*4 days left in your Pro trial. Add a payment method →*".

`BillingBanner` (`apps/web/src/components/billing-banner.tsx`) selects only
`plan_key, status, trial_end` and never checks whether a card is on file, so it
tells every trialing org to add one. `billingCtaLabel` in `lib/billing.ts` has
the same defect — it keys on `status` alone.

The banner renders on **org home** (`app/o/[orgSlug]/page.tsx:50`) as well as the
billing page, so a live Stripe read is not acceptable. User decision: store the
fact locally. **The countdown stays** — only the add-a-card CTA is conditional.

**Files:**
- Create: `db/migration/deltas/V303__subscription_has_payment_method.sql`
- Modify: `apps/web/src/lib/billing.ts` (`syncSubscription`, `billingCtaLabel`)
- Modify: `apps/web/src/server/usecases/billing-manage.ts` (`setDefaultPaymentMethod`, `removePaymentMethod`)
- Modify: `apps/web/src/server/usecases/billing-events.ts` (payment-method webhooks)
- Modify: `apps/web/src/components/billing-banner.tsx`
- Modify: `apps/web/src/lib/types.ts` (Subscription)
- Test: `apps/web/src/lib/__tests__/billing-payment-method.test.ts` (new)

**THE WRITER SET IS THE WHOLE TASK.** This branch has been bitten five times by
fixing one writer and missing the rest. Enumerate before implementing:
1. `setDefaultPaymentMethod` — **the in-app add-card path the user actually hit.**
   It updates Stripe's `invoice_settings.default_payment_method` and writes
   nothing locally. Set the flag true here.
2. `removePaymentMethod` — must clear the flag when the last card goes.
3. `syncSubscription` — derive from the Stripe subscription's
   `default_payment_method`, falling back to the customer default. Runs on every
   subscription webhook and on reconcile.
4. `billing-events.ts` — dashboard-side changes (`payment_method.attached`,
   `payment_method.detached`, `customer.updated`) so a card added in the Stripe
   dashboard is reflected too.

- [ ] **Step 1: Write the failing test first**

Cover: flag false on a fresh trialing org; `setDefaultPaymentMethod` sets it true;
`removePaymentMethod` clears it; `syncSubscription` derives it from the Stripe
object; and — the user's exact scenario — a trialing org WITH the flag true does
not render the "Add a payment method" CTA while still rendering the countdown.

- [ ] **Step 2: Run it, confirm it fails for the stated reason.**

- [ ] **Step 3: V303**

```sql
-- V303: the trial banner told every trialing org to add a card, including orgs
-- that already had one, because nothing local recorded the fact. Stripe knows;
-- the banner renders on org home (a hot path) where a live Stripe read is not
-- acceptable, so mirror it here.
alter table subscriptions
  add column if not exists has_payment_method boolean not null default false;
```

- [ ] **Step 4: Implement all four writers, then the banner.**

Banner contract: the countdown text is unchanged in every case. When
`has_payment_method` is true, drop the "Add a payment method →" / "Add a card to
keep Pro →" link; the org has done what was asked. When false, keep today's copy.
`billingCtaLabel` takes the flag as a second argument.

- [ ] **Step 5: Apply V303 locally and verify**

```bash
DATABASE_URL="postgresql://ashokhein@localhost:5432/seazn" npm run db:apply
```
The dev DB has out-of-order V296/V297 from another worktree, so `db:apply` may
fail validation there — if it does, apply V303 by hand for the test run and say so.

- [ ] **Step 6: Prove the fix by mutation** — revert the banner condition, confirm
the user-scenario test reds. Then restore.

- [ ] **Step 7: Commit.**

---

### Task 6C: Staff-only removal of an org's default card

User-requested 2026-07-20, with the customer-facing counterpart explicitly
REJECTED in the same breath — and that rejection is the design.

`billing-manage.tsx:107` hides both "Make default" and "Remove" for the default
card (`{!pm.isDefault && …}`), and `removePaymentMethod` 400s on it server-side
("Make another card the default before removing this one."). With one card on
file that card IS the default, so a customer sees no Remove control at all.
**Keep it that way.** A customer removing their only card does not stop billing —
it makes the next invoice fail, dropping them into dunning → 14-day grace →
degradation; a trialing org with `missing_payment_method: 'cancel'` loses the
subscription at trial end. Cancel subscription is the clean customer path.

Staff need the deliberate exception (erasure requests, fraud cleanup, a card that
must not be charged again), where the intent is explicit and audited.

**Files:**
- Modify: `apps/web/src/server/usecases/billing-manage.ts` (new staff usecase; do NOT loosen `removePaymentMethod`)
- Create: `apps/web/src/app/api/admin/orgs/[id]/remove-payment-method/route.ts`
- Modify: `apps/web/src/components/admin-plan-panel.tsx`
- Modify: `apps/web/src/server/usecases/admin-plan.ts` (`planPanel` must expose the cards to render)
- Test: `apps/web/src/server/usecases/__tests__/` (mocked Stripe, following `admin-plan-trial-stripe.test.ts`)

**Requirements:**
1. A NEW usecase — `staffRemovePaymentMethod(actorId, orgId, paymentMethodId, reason)`. It may detach the default; that is the whole point. Leave the customer-facing `removePaymentMethod` guard intact.
2. Reason required, `logStaffAction("remove_payment_method", …)` with the card's brand/last4 in the detail so the audit says WHICH card.
3. **Must clear `has_payment_method` (Task 4C) when no cards remain** — otherwise the trial banner goes quiet exactly when it should be shouting. This is the fifth writer of that flag; add it to Task 4C's enumerated set.
4. The panel must state the consequence before the click, not after: removing the last card means the next invoice fails (active) or the subscription cancels at trial end (trialing). Use the existing `useConfirm` with `tone: "danger"`.
5. Staff-only via `requireStaff()`, like the other admin routes.

**Test cases:** removing a non-default card leaves the flag true when others remain; removing the LAST card clears it; the audit row carries the reason and the card identity; a non-staff caller 403s; the customer-facing `removePaymentMethod` still refuses the default (regression — prove the guard was not loosened).

---

### Task 5A: End-to-end coverage for the trial rules

Added 2026-07-20 after the plan was challenged: Tasks 1-5 ship only unit and
DB-backed tests. The **user-reported symptom itself** — a burnt-trial org still
being offered the trial — has no browser-level test, and the existing billing
specs have not been run since Task 1 even though Tasks 2 and 4 changed the
comp-to-downgrade path they exercise.

**Files:**
- Modify: `apps/web/e2e/billing.spec.ts`
- Modify: `apps/web/e2e/billing-states.spec.ts`

**Interfaces:**
- Consumes: `setOrgPlanBySql`, `setOrgSubscriptionSql`, `setEntitlementOverrideSql`, `activeOrg`, `apiJson` from `./helpers`.
- Produces: nothing.

- [ ] **Step 1: Run the existing billing specs unchanged, against this branch**

Start a dev server on 3021 with `DATABASE_URL` set, then:

```bash
cd apps/web && PLAYWRIGHT_BASE=http://localhost:3021 DATABASE_URL="postgresql://ashokhein@localhost:5432/seazn" DATABASE_SSL=disable npx playwright test e2e/billing.spec.ts e2e/billing-states.spec.ts --project=parallel --workers=1 --reporter=list
```

Record the result BEFORE writing anything new. If `comped Pro downgrade freezes over-quota competitions` is red, that is a regression from Task 2 or Task 4 — report it and stop.

- [ ] **Step 2: The reported symptom — burnt trial changes the CTA**

The org has had Pro, so the billing page must offer "Go Pro", never "Start free trial". Stamp the column directly and reload:

```ts
test("an org that has already had Pro is not offered the trial again", async ({ page }) => {
  const org = await activeOrg(page);
  await setOrgSubscriptionSql(org.id, { trial_used_at: null });
  await page.goto(`/o/${org.slug}/settings/billing`);
  await expect(page.getByRole("button", { name: /Start free trial/i }).first()).toBeVisible();

  await setOrgSubscriptionSql(org.id, { trial_used_at: new Date().toISOString() });
  await page.reload();
  await expect(page.getByRole("button", { name: /Go Pro/i }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Start free trial/i })).toHaveCount(0);
});
```

If `setOrgSubscriptionSql` cannot set `trial_used_at`, extend that helper — it already writes other subscription columns.

- [ ] **Step 3: A staff grant conveys real Pro**

This is the dead-state Task 4 fixed: before it, the grant wrote `status='trialing'` and the org still had no Pro. Drive the admin panel, then assert a Pro-only surface is reachable for that org.

- [ ] **Step 4: Restore trial flips the CTA back**

Burn the trial, use the admin Restore trial control (Task 6), reload the billing page, assert "Start free trial" returns. This is the only end-to-end proof the escape hatch works.

- [ ] **Step 5: Verify each new test fails without its fix**

For Step 2, revert `trialAvailable` in the billing page to a constant `true` and confirm the test reds. For Step 3, revert `plan_key` lifting in `extendTrial`'s non-live arm. Report both outputs. This branch has produced nine assertions that could not fail — do not add a tenth.

- [ ] **Step 6: Commit**

```bash
git add apps/web/e2e/
git commit -m "test(e2e): the trial rules, at the surface the user actually sees"
```

---

### Task 5B: Smoke coverage for the trial rules

`scripts/smoke.ts` has no trial coverage at all (`grep trial scripts/smoke.ts` is empty), and the standing project rule is that every feature extends the pro and free smoke paths.

**Files:**
- Modify: `scripts/smoke.ts`

- [ ] **Step 1: Read the existing pro and free paths** and follow their assertion style — do not invent a new harness.

- [ ] **Step 2: Assert the invariant on both paths**

After the pro path's checkout/plan setup, assert `trial_used_at` is stamped. On the free path, assert a fresh org starts unstamped and that a staff comp stamps it. Keep assertions on state the smoke script already has access to.

- [ ] **Step 3: Run it**

```bash
DATABASE_URL="postgresql://ashokhein@localhost:5432/seazn" npm run test:smoke
```

Report the pass count. Smoke is the witness that caught a cross-task contract drift earlier in this project's history — treat a red here as real.

- [ ] **Step 4: Commit**

```bash
git add scripts/smoke.ts
git commit -m "test(smoke): pin one-trial-per-org on the pro and free paths"
```

---

### Task 5: Restore trial (usecase + route)

The policy above has no undo. Without one, staff reach for raw SQL the first time a comp turns into a real deal.

**Files:**
- Modify: `apps/web/src/server/usecases/admin-plan.ts` (add `restoreTrial`)
- Create: `apps/web/src/app/api/admin/orgs/[id]/restore-trial/route.ts`
- Test: `apps/web/src/server/usecases/__tests__/admin-plan.test.ts`

**Interfaces:**
- Consumes: `logStaffAction` from `@/lib/admin`, `invalidateOrgEntitlements` from `@/lib/entitlements`.
- Produces: `restoreTrial(actorId: string, orgId: string, reason: string): Promise<void>`; route `POST /api/admin/orgs/[id]/restore-trial` with body `{ reason: string }` returning `{ ok: true }`.

- [ ] **Step 1: Write the failing test**

```ts
  it("restore trial clears the stamp, audits it, and is not a permanent bypass", async () => {
    const { orgId, actorId } = await seedOrg();
    const readSub = async () =>
      (
        await sql<{ trial_used_at: string | null }[]>`
          select trial_used_at from subscriptions where org_id = ${orgId}`
      )[0];

    await compToPro(actorId, orgId, null, "comp that became a deal");
    expect(checkoutTrialDays(await readSub())).toBe(0);

    await restoreTrial(actorId, orgId, "comp converted to a paid pilot");
    expect((await readSub()).trial_used_at).toBeNull();
    expect(checkoutTrialDays(await readSub())).toBe(14);

    const [audit] = await sql<{ detail: { reason: string } }[]>`
      select detail from staff_audit_log
      where target_id = ${orgId} and action = 'restore_trial' order by created_at desc limit 1`;
    expect(audit.detail.reason).toBe("comp converted to a paid pilot");

    // The hatch reopens the door once — the next grant closes it again.
    await extendTrial(actorId, orgId, 7, "pilot extension");
    expect(checkoutTrialDays(await readSub())).toBe(0);
  });

  it("restore trial demands a reason", async () => {
    const { orgId, actorId } = await seedOrg();
    await expect(restoreTrial(actorId, orgId, "  ")).rejects.toThrow(/reason/i);
  });
```

Add `restoreTrial` to the import list from `@/server/usecases/admin-plan`.

- [ ] **Step 2: Run to verify failure**

```bash
cd apps/web && DATABASE_URL="postgresql://ashokhein@localhost:5432/seazn" DATABASE_SSL=disable npx vitest run src/server/usecases/__tests__/admin-plan.test.ts -t "restore trial"
```

Expected: FAIL — `restoreTrial is not a function`.

- [ ] **Step 3: Implement the usecase**

Append to `apps/web/src/server/usecases/admin-plan.ts`:

```ts
/**
 * Give an org its trial back. "One trial per organisation" is enforced on every
 * route that grants Pro, which makes it strict enough to be wrong occasionally —
 * a comp that turns into a paid pilot, a test org promoted to a real customer.
 * This is the sanctioned undo, so nobody edits subscriptions by hand. The next
 * grant of any kind re-stamps it.
 */
export async function restoreTrial(
  actorId: string,
  orgId: string,
  reason: string,
): Promise<void> {
  if (!reason.trim()) throw new HttpError(400, "A reason is required.");
  const [before] = await sql<{ trial_used_at: string | null }[]>`
    select trial_used_at from subscriptions where org_id = ${orgId}`;
  if (!before) throw new HttpError(404, "Organization has no subscription row.");
  await sql`update subscriptions set trial_used_at = null, updated_at = now()
            where org_id = ${orgId}`;
  await invalidateOrgEntitlements(orgId);
  await logStaffAction(actorId, "restore_trial", "org", orgId, {
    reason,
    before: { trial_used_at: before.trial_used_at },
    after: { trial_used_at: null },
  });
}
```

- [ ] **Step 4: Create the route**

Create `apps/web/src/app/api/admin/orgs/[id]/restore-trial/route.ts`:

```ts
import { sql } from "@/lib/db";
import { requireStaff } from "@/lib/admin";
import { handler, HttpError } from "@/lib/http";
import { restoreTrial } from "@/server/usecases/admin-plan";
import { z } from "zod";

const schema = z.object({ reason: z.string().min(1).max(500) }).strict();

/** Give an org its 14-day trial back (v3/08 §1). Superadmin or support — the
 *  sanctioned undo for the one-trial-per-org rule, audited like every other
 *  plan action. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handler(async () => {
    const { id } = await params;
    const staff = await requireStaff();
    const { reason } = schema.parse(await req.json());
    const [org] = await sql<{ id: string }[]>`select id from organizations where id = ${id}`;
    if (!org) throw new HttpError(404, "Organization not found");
    await restoreTrial(staff.id, id, reason);
    return { ok: true };
  });
}
```

- [ ] **Step 5: Run to verify it passes**

```bash
cd apps/web && DATABASE_URL="postgresql://ashokhein@localhost:5432/seazn" DATABASE_SSL=disable npx vitest run src/server/usecases/__tests__/admin-plan.test.ts
```

Expected: PASS.

- [ ] **Step 6: Check the route registry gates**

```bash
cd apps/web && npx vitest run src/lib/__tests__ -t "api-v1"
```

Expected: PASS. `/api/admin/*` routes are outside the v1 key-scope registry, so no `key-scopes.ts` or `openapi:gen` entry is needed. If a coverage test names this route, add it where the other `admin` routes are listed and re-run.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/server/usecases/admin-plan.ts apps/web/src/app/api/admin/orgs/\[id\]/restore-trial/route.ts apps/web/src/server/usecases/__tests__/admin-plan.test.ts
git commit -m "feat(admin): Restore trial — the sanctioned undo for one-trial-per-org"
```

---

### Task 6: Restore trial in the admin panel

**Files:**
- Modify: `apps/web/src/components/admin-plan-panel.tsx`

**Interfaces:**
- Consumes: `POST /api/admin/orgs/{id}/restore-trial` `{ reason }` (Task 5). The panel's existing `call(path, init, busyKey)` helper builds the URL from the org id.
- Produces: nothing.

- [ ] **Step 1: Add the state**

Alongside the existing `const [trialReason, setTrialReason] = useState("");`:

```tsx
  const [restoreReason, setRestoreReason] = useState("");
```

- [ ] **Step 2: Add the card**

Immediately after the closing `</div>` of the "Extend trial" card:

```tsx
        {/* Restore trial — the undo for one-trial-per-org. Every route that
            grants Pro (checkout sync, comp, grant) burns the trial, so staff
            need a sanctioned way back instead of editing SQL. */}
        <div className="rounded-lg bg-slate-800 p-4 space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Restore trial
          </h3>
          <p className="text-xs text-slate-400">
            Clears the one-trial-per-org stamp, so this org can start a 14-day
            trial again. The next comp or grant burns it once more.
          </p>
          <input
            value={restoreReason}
            onChange={(e) => setRestoreReason(e.target.value)}
            placeholder="Reason (required)"
            className={`${inputCls} w-full`}
          />
          <button
            onClick={() =>
              call(
                "restore-trial",
                { method: "POST", body: JSON.stringify({ reason: restoreReason }) },
                "restore",
              )
            }
            disabled={!restoreReason || busy === "restore"}
            className="btn btn-ghost w-full disabled:opacity-40"
          >
            {busy === "restore" ? "…" : "Restore trial"}
          </button>
        </div>
```

- [ ] **Step 3: Typecheck**

```bash
cd apps/web && npx tsc --noEmit
```

Expected: no output.

- [ ] **Step 4: Verify in the browser**

Start the dev server (`npx next dev -p 3021` with `DATABASE_URL` set), open `/admin/orgs/<id>`, and confirm: the card renders, the button is disabled until a reason is typed, clicking it succeeds, and the plan panel's audit history shows a `restore_trial` entry.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/admin-plan-panel.tsx
git commit -m "feat(admin): Restore trial control in the plan panel"
```

---

### Task 7: Brand the embedded checkout

Verified against test mode: this account has **no** branding set (`{"icon":null,"logo":null,"primary_color":null,"secondary_color":null}`), so checkout renders Stripe defaults today.

**Files:**
- Modify: `apps/web/src/lib/billing.ts` (`buildEmbeddedCheckoutParams`, `buildPassCheckoutParams`)
- Test: `apps/web/src/lib/__tests__/billing-checkout.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export const CHECKOUT_BRANDING` — the shared `branding_settings` object both builders spread.

- [ ] **Step 1: Write the failing tests**

```ts
// Stripe's allowed font list for branding_settings.font_family, read back from
// the API on 2026-06-24.dahlia. Barlow Condensed (the brand face) is NOT on it,
// so checkout cannot match the site type — `inter` is the closest neutral.
const STRIPE_FONTS = [
  "default", "be_vietnam_pro", "bitter", "chakra_petch", "hahmlet", "inconsolata",
  "inter", "lato", "lora", "m_plus_1_code", "montserrat", "noto_sans_jp",
  "noto_sans", "noto_serif", "nunito", "open_sans", "pridi", "pt_sans",
  "pt_serif", "raleway", "roboto", "roboto_slab", "source_sans_pro",
  "titillium_web", "ubuntu_mono", "zen_maru_gothic",
];

describe("checkout branding", () => {
  it("brands the subscription checkout", () => {
    const p = buildEmbeddedCheckoutParams({ ...base, customerEmail: "a@b.com" });
    expect(p.branding_settings).toMatchObject({
      background_color: "#150b36",
      button_color: "#a3e635",
      border_style: "rounded",
      display_name: "Seazn Club",
    });
  });

  it("brands the Event Pass checkout identically", () => {
    const p = buildPassCheckoutParams({
      priceId: "price_pass", orgId: "org-abc", competitionId: "comp-1",
      returnUrl: base.returnUrl, customerEmail: "a@b.com",
    });
    expect(p.branding_settings).toEqual(
      buildEmbeddedCheckoutParams({ ...base, customerEmail: "a@b.com" }).branding_settings,
    );
  });

  // A typo here is a live 400 at checkout, so pin it against Stripe's list.
  it("uses a font Stripe actually accepts", () => {
    const p = buildEmbeddedCheckoutParams({ ...base, customerEmail: "a@b.com" });
    expect(STRIPE_FONTS).toContain(p.branding_settings!.font_family);
  });

  it("leaves the trial params alone", () => {
    const withTrial = buildEmbeddedCheckoutParams({ ...base, customerEmail: "a@b.com" });
    expect(withTrial.payment_method_collection).toBe("if_required");
    expect(withTrial.subscription_data?.trial_period_days).toBe(14);
    const noTrial = buildEmbeddedCheckoutParams({ ...base, trialDays: 0, customerEmail: "a@b.com" });
    expect("payment_method_collection" in noTrial).toBe(false);
    expect(noTrial.subscription_data?.trial_period_days).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd apps/web && npx vitest run src/lib/__tests__/billing-checkout.test.ts
```

Expected: FAIL — `branding_settings` is undefined.

- [ ] **Step 3: Implement**

In `apps/web/src/lib/billing.ts`, above `buildEmbeddedCheckoutParams`:

```ts
/**
 * Checkout branding (verified against API 2026-06-24.dahlia). Kept in code
 * rather than the Stripe Dashboard so it is versioned and cannot drift between
 * test and live. This is a token set, not CSS — colours, radius, font, logo.
 * `font_family` comes from a fixed list of 25 that does NOT include Barlow
 * Condensed, so checkout cannot match the site's type; `inter` is the closest
 * neutral. Anything finer-grained would mean ui_mode "elements" and owning the
 * payment UI, which is not worth it.
 */
export const CHECKOUT_BRANDING = {
  background_color: "#150b36",
  button_color: "#a3e635",
  border_style: "rounded",
  font_family: "inter",
  display_name: "Seazn Club",
} as const satisfies Stripe.Checkout.SessionCreateParams.BrandingSettings;
```

Add `branding_settings: { ...CHECKOUT_BRANDING },` to the returned object of **both** `buildEmbeddedCheckoutParams` and `buildPassCheckoutParams`, next to `allow_promotion_codes: true`.

If `Stripe.Checkout.SessionCreateParams.BrandingSettings` does not resolve in this stripe-node build, drop the `satisfies` clause and keep the `as const` — the unit test is the real gate.

- [ ] **Step 4: Run to verify it passes**

```bash
cd apps/web && npx vitest run src/lib/__tests__/billing-checkout.test.ts && npx tsc --noEmit
```

Expected: PASS, no tsc output.

- [ ] **Step 5: Prove it against Stripe, not just the test**

Write a throwaway script at the repo root that creates a session with the real params and prints `session.branding_settings`, run it, confirm the echo matches, then delete it. A unit test cannot catch a value Stripe rejects.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/billing.ts apps/web/src/lib/__tests__/billing-checkout.test.ts
git commit -m "feat(billing): brand the embedded checkout and Event Pass sessions"
```

---

### Task 8: Embedded checkout in a modal

**Files:**
- Modify: `apps/web/src/components/billing-actions.tsx:46-66`
- Modify: `apps/web/e2e/billing.spec.ts`

**Interfaces:**
- Consumes: `Modal` from `@/components/modal` (props: `title`, `children`, `onClose`, `footer?`, `size?: "md" | "lg"`).
- Produces: no export change.

- [ ] **Step 1: Write the failing e2e**

Append to `apps/web/e2e/billing.spec.ts`:

```ts
test("upgrade opens checkout in a modal that survives a dismiss", async ({ page }) => {
  await page.goto("/settings?tab=billing");
  await page.waitForURL(/\/o\/[^/]+\/settings\/billing/, { timeout: 20_000 });

  await page.getByRole("button", { name: /Start free trial|Go Pro/ }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("iframe")).toBeVisible({ timeout: 30_000 });

  // Dismiss and reopen: the provider must remount cleanly with a fresh secret,
  // not a dead iframe from the previous session.
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: /Start free trial|Go Pro/ }).first().click();
  await expect(page.getByRole("dialog").locator("iframe")).toBeVisible({ timeout: 30_000 });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd apps/web && PLAYWRIGHT_BASE=http://localhost:3021 DATABASE_URL="postgresql://ashokhein@localhost:5432/seazn" DATABASE_SSL=disable npx playwright test e2e/billing.spec.ts --project=parallel --workers=1 --reporter=list -g "modal"
```

Expected: FAIL — no `role="dialog"`; checkout renders inline.

- [ ] **Step 3: Implement**

In `apps/web/src/components/billing-actions.tsx`, add `import { Modal } from "@/components/modal";` and replace the `if (clientSecret) { … }` block:

```tsx
  if (clientSecret) {
    return (
      <Modal title="Complete your upgrade" size="lg" onClose={() => setClientSecret(null)}>
        {/* Stripe's iframe measures and resizes itself, so this container must
            not impose a height — Modal already caps the sheet at 85vh and
            scrolls. The provider is mounted only once we hold a secret;
            remounting it would restart the checkout session. */}
        <EmbeddedCheckoutProvider stripe={stripePromise} options={{ clientSecret }}>
          <EmbeddedCheckout />
        </EmbeddedCheckoutProvider>
      </Modal>
    );
  }
```

The button branch below it is unchanged, so the trigger stays in the layout while the checkout floats above it.

- [ ] **Step 4: Run to verify it passes**

```bash
cd apps/web && PLAYWRIGHT_BASE=http://localhost:3021 DATABASE_URL="postgresql://ashokhein@localhost:5432/seazn" DATABASE_SSL=disable npx playwright test e2e/billing.spec.ts --project=parallel --workers=1 --reporter=list
```

Expected: PASS, whole file.

- [ ] **Step 5: Mobile gate**

```bash
cd apps/web && PLAYWRIGHT_BASE=http://localhost:3021 DATABASE_URL="postgresql://ashokhein@localhost:5432/seazn" DATABASE_SSL=disable npx playwright test e2e/mobile.spec.ts --project=mobile-se --reporter=list
```

Expected: PASS. The modal is a bottom sheet under `sm`; if `expectNoHorizontalScroll` reds, the Stripe iframe is overflowing and the sheet needs `overflow-x: hidden`.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/billing-actions.tsx apps/web/e2e/billing.spec.ts
git commit -m "feat(billing): embedded checkout opens in a modal"
```

---

### Task 9: Help pages, visual sign-off, full battery

**Files:**
- Modify: `apps/web/content/help/billing/plans.md`
- Screenshots: session scratchpad

- [ ] **Step 1: Update the help copy**

`plans.md` already says "one trial per organisation; if you come back to Pro later, billing starts from day one" — now true on every path. Extend that sentence so the comp case is not a surprise:

> Starts with a 14-day trial, no card required — one trial per organisation, whether you start it yourself or our team sets one up for you; if you come back to Pro later, billing starts from day one.

Then check whether any other help page describes trials:

```bash
grep -rn "trial" apps/web/content/help/
```

- [ ] **Step 2: Screenshots for sign-off**

With the dev server running, capture the checkout modal at 1440×900 and 375×667, plus the admin plan panel showing Restore trial. Post them and let the user pick before merging — the branding palette (`#150b36` / `#a3e635`) is a proposal, not a decision.

- [ ] **Step 3: Full battery**

```bash
cd apps/web && npx tsc --noEmit
cd apps/web && DATABASE_URL="postgresql://ashokhein@localhost:5432/seazn" DATABASE_SSL=disable npx vitest run
cd packages/engine && npx vitest run
```

Expected: tsc silent; engine 903/903. In the web suite, `registrations.test.ts > sweep reminds once` is a **known** parallel-suite failure — confirm it passes alone before dismissing it:

```bash
cd apps/web && DATABASE_URL="postgresql://ashokhein@localhost:5432/seazn" DATABASE_SSL=disable npx vitest run src/server/usecases/__tests__/registrations.test.ts
```

- [ ] **Step 4: Smoke**

```bash
DATABASE_URL="postgresql://ashokhein@localhost:5432/seazn" npm run test:smoke
```

Expected: green. Extend `scripts/smoke.ts` if the Pro path asserts anything about trial copy.

- [ ] **Step 5: Commit**

```bash
git add apps/web/content/help/billing/plans.md
git commit -m "docs(help): staff-set trials count against the one trial per org"
```

---

## Self-Review

**Spec coverage.** Item 1 → Task 1. Item 2 → Task 2. Item 3 (all four arms, liveness predicate, no-partial-write, resolver widening) → Tasks 3 and 4. Item 4 → Task 3. Item 5 → Tasks 5 and 6. Item 6 (no backfill) → Global Constraints. Item 7 → Task 7. Item 8 → Task 8. Pro Plus needs no task — `applyPlanChange` already coalesces through `syncSubscription`; Task 4's demotion test covers the one edge it introduced. Help pages and the visual gate → Task 9.

**Test-matrix coverage.** Spec cases 1–6 → Task 1 (cases 4 and 6 are folded into the replay/re-buy tests, which exercise the same coalesce). Cases 7–8 → Task 2. Cases 9–17 → Task 4 (13's "no Stripe call" assertion and 14 need a mock, so they live in the new `admin-plan-trial-stripe.test.ts`; `admin-plan.test.ts` stays Stripe-free as its header promises). Cases 18–22 → Task 3. Cases 23–27 → Task 5, except case 26 (non-staff 403), which `requireStaff` provides and the route inherits from the other admin routes' shared gate. Cases 28–30 → Task 7. Cases 31–33 → Task 8.

**Naming consistency.** `hasLiveSubscription` is defined in Task 3 and consumed in Task 4 with the same signature. `restoreTrial(actorId, orgId, reason)` matches between Tasks 5 and 6. `CHECKOUT_BRANDING` is defined and consumed within Task 7.

**Known gap:** Task 7 Step 5 asks for a throwaway live probe because a unit test cannot catch a `branding_settings` value Stripe rejects at runtime.
