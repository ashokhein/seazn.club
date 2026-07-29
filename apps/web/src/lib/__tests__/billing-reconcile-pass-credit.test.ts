// Pass-to-Pro credit, reconcile-on-return arm (grant timing moved 2026-07-26 —
// see docs/superpowers/specs/2026-07-26-pass-credit-redemption-design.md §1).
// reconcileCheckout is the path server/settings/billing/page.tsx calls when the
// browser returns from Checkout and no webhook has arrived yet; it is now the
// other half of "learn a subscription started", alongside billing-events.ts
// handleSubscriptionChanged (own test file).
//
// creditPassTowardSubscription's own decisions are pinned in
// pass-credit.test.ts / pass-credit.live.test.ts. What is only testable HERE
// is the wiring: a successful sync fires a credit attempt for orgId, and a
// failing credit attempt must not turn a successful reconcile into a failed
// one — reconcileCheckout's own "never throws" contract is unchanged.
//
// Real Postgres required; skipped without DATABASE_URL. Fixture/mocking
// convention mirrors billing-reconcile-invalidate.test.ts (same file, sibling
// concern — entitlement invalidation vs. the pass credit).
import { afterAll, beforeEach, describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";

// Spy on the credit attempt without touching pass-credit's own logic — this is
// the exact call the wiring regression guards (sibling convention:
// billing-reconcile-invalidate mocks @/lib/entitlements the same way).
const creditMock = vi.hoisted(() => vi.fn(async () => ({ outcome: "no_pass" as const })));
vi.mock("@/server/usecases/pass-credit", () => ({
  creditPassTowardSubscription: creditMock,
}));

// A no-op cache so invalidateEntitlementsForOrgGroup does not need Redis (same
// convention as billing-events-concurrency.test.ts).
vi.mock("@/lib/cache", () => ({
  cacheEnabled: () => false,
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDelPattern: async () => {},
  incrWindow: async () => 1,
}));

// checkout.sessions.retrieve is the only Stripe call reconcileCheckout itself
// makes; stub it so no network is hit (sibling convention:
// billing-reconcile-invalidate, billing-pass-duplicate).
const stripeMock = vi.hoisted(() => {
  const retrieve = vi.fn();
  return { retrieve, stripe: { checkout: { sessions: { retrieve } } } };
});
vi.mock("@/lib/stripe", () => ({ getStripe: () => stripeMock.stripe }));

import { sql } from "@/lib/db";
import { reconcileCheckout } from "@/lib/billing";

import { setOrgPlan } from "./_billing-group";
const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);
const tempPlanKeys: string[] = [];

/** A fresh org + a community subscription row (the pre-checkout state) and a
 *  temp plan whose monthly price id the reconcile will map to — same shape as
 *  billing-reconcile-invalidate.test.ts's seedOrgAwaitingReconcile. */
async function seedOrgAwaitingReconcile(): Promise<{ orgId: string; priceId: string }> {
  const suffix = uniq();
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug)
    values (${"Reconcile Credit Org " + suffix}, ${"reconcile-credit-org-" + suffix})
    returning id`;
  await setOrgPlan(orgId, "community");
  const planKey = `tmp_rc_plan_${suffix}`;
  const priceId = `price_reconcile_credit_${suffix}`;
  await sql`insert into plans (key, name, stripe_price_id_monthly)
            values (${planKey}, ${"Temp " + planKey}, ${priceId})`;
  tempPlanKeys.push(planKey);
  return { orgId, priceId };
}

/** A completed subscription checkout session as reconcileCheckout retrieves
 *  it — same shape as billing-reconcile-invalidate.test.ts's
 *  subscriptionSession, except the customer id is unique PER CALL: the
 *  partial unique index on subscriptions.stripe_customer_id (V314) means two
 *  different groups sharing one literal customer id in the same test run
 *  throws on the second linkStripeCustomer, which would otherwise mask this
 *  file's own assertions behind an unrelated 23505. */
function subscriptionSession(orgId: string, priceId: string): Stripe.Checkout.Session {
  return {
    metadata: { org_id: orgId },
    customer: "cus_reconcile_credit_" + uniq(),
    subscription: {
      id: "sub_reconcile_credit_" + uniq(),
      status: "active",
      trial_end: null,
      cancel_at_period_end: false,
      currency: "usd",
      items: {
        data: [
          {
            price: { id: priceId },
            current_period_end: Math.floor(Date.now() / 1000) + 86_400,
          },
        ],
      },
    },
  } as unknown as Stripe.Checkout.Session;
}

beforeEach(() => {
  creditMock.mockClear().mockResolvedValue({ outcome: "no_pass" });
  stripeMock.retrieve.mockReset();
});

afterAll(async () => {
  if (!HAS_DB) return;
  if (tempPlanKeys.length) {
    await sql`
      update organizations set subscription_id = null
       where subscription_id in (select id from subscriptions
                                  where plan_key = any(${tempPlanKeys}))`;
    await sql`delete from subscriptions where plan_key = any(${tempPlanKeys})`;
    await sql`delete from plans where key = any(${tempPlanKeys})`;
  }
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("reconcileCheckout → pass-to-Pro credit wiring", () => {
  it("fires a credit attempt for orgId after a successful sync", async () => {
    const { orgId, priceId } = await seedOrgAwaitingReconcile();
    stripeMock.retrieve.mockResolvedValue(subscriptionSession(orgId, priceId));

    expect(await reconcileCheckout(orgId, "cs_reconcile_credit")).toBe(true);

    expect(creditMock).toHaveBeenCalledTimes(1);
    expect(creditMock).toHaveBeenCalledWith(orgId);
  });

  it("does NOT attempt a credit when the session carries no subscription", async () => {
    const { orgId } = await seedOrgAwaitingReconcile();
    stripeMock.retrieve.mockResolvedValue({
      metadata: { org_id: orgId },
      customer: "cus_reconcile_credit_nosub_" + uniq(),
      subscription: null,
    } as unknown as Stripe.Checkout.Session);

    expect(await reconcileCheckout(orgId, "cs_reconcile_nosub")).toBe(false);
    expect(creditMock).not.toHaveBeenCalled();
  });

  it("a failing credit attempt does not flip a successful reconcile to failure", async () => {
    const { orgId, priceId } = await seedOrgAwaitingReconcile();
    stripeMock.retrieve.mockResolvedValue(subscriptionSession(orgId, priceId));
    // creditPassTowardSubscription's own contract is "never throws" — but
    // reconcileCheckout's return value must not depend on that contract
    // holding, any more than a checkout 500ing used to be acceptable. Force
    // the seam to reject anyway and prove the reconcile still reports success.
    creditMock.mockRejectedValueOnce(new Error("stripe unreachable"));

    await expect(reconcileCheckout(orgId, "cs_reconcile_credit_fail")).resolves.toBe(true);

    const [s] = await sql<{ plan_key: string }[]>`
      select plan_key from subscriptions where id = (select subscription_id from organizations where id = ${orgId})`;
    expect(s.plan_key).not.toBe("community"); // the plan sync itself still landed
  });
});
