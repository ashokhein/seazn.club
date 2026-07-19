// Final-review fix (payments hardening): the missed-webhook reconcile path
// (reconcileCheckout) writes the new plan into `subscriptions` but used to leave
// the org's cached entitlement resolver stale until its TTL expired, so a paid
// org could still hit free-tier caps for minutes after returning from checkout.
// reconcileCheckout must invalidate the org's entitlements once the sub syncs,
// mirroring the pass path (recordPassPurchase). Plan-generic: pro AND pro_plus.
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, beforeEach, describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";

// Spy on the invalidation without touching the rest of the resolver — this is
// the exact call the regression guards. (Sibling convention: billing-pass-revoke
// mocks @/lib/email the same way.)
const entMock = vi.hoisted(() => ({ invalidate: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/entitlements", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/entitlements")>()),
  invalidateOrgEntitlements: entMock.invalidate,
}));

// checkout.sessions.retrieve is the only Stripe call reconcileCheckout makes;
// stub it so no network is hit (sibling convention: billing-pass-duplicate).
const stripeMock = vi.hoisted(() => {
  const retrieve = vi.fn();
  return { retrieve, stripe: { checkout: { sessions: { retrieve } } } };
});
vi.mock("@/lib/stripe", () => ({ getStripe: () => stripeMock.stripe }));

import { sql } from "@/lib/db";
import { reconcileCheckout } from "@/lib/billing";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);
const tempPlanKeys: string[] = [];

/** A fresh org + a community subscription row (the pre-checkout state) and a
 *  temp plan whose monthly price id the reconcile will map to. */
async function seedOrgAwaitingReconcile(): Promise<{ orgId: string; planKey: string; priceId: string }> {
  const suffix = uniq();
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug)
    values (${"Reconcile Org " + suffix}, ${"reconcile-org-" + suffix}) returning id`;
  await sql`insert into subscriptions (org_id, plan_key, status)
            values (${orgId}, 'community', 'active')`;
  const planKey = `tmp_plan_${suffix}`;
  const priceId = `price_reconcile_${suffix}`;
  await sql`insert into plans (key, name, stripe_price_id_monthly)
            values (${planKey}, ${"Temp " + planKey}, ${priceId})`;
  tempPlanKeys.push(planKey);
  return { orgId, planKey, priceId };
}

/** A completed subscription checkout session as reconcileCheckout retrieves it
 *  (subscription + price expanded). */
function subscriptionSession(orgId: string, priceId: string): Stripe.Checkout.Session {
  return {
    metadata: { org_id: orgId },
    customer: "cus_reconcile",
    subscription: {
      id: "sub_reconcile_" + uniq(),
      status: "active",
      trial_end: null,
      cancel_at_period_end: false,
      currency: "usd",
      items: {
        data: [{ price: { id: priceId }, current_period_end: Math.floor(Date.now() / 1000) + 86_400 }],
      },
    },
  } as unknown as Stripe.Checkout.Session;
}

beforeEach(() => {
  entMock.invalidate.mockClear();
  stripeMock.retrieve.mockReset();
});

afterAll(async () => {
  if (!HAS_DB) return;
  if (tempPlanKeys.length) {
    // Subscriptions seeded onto the temp plans must go first — plans.key is
    // referenced by subscriptions_plan_key_fkey.
    await sql`delete from subscriptions where plan_key = any(${tempPlanKeys})`;
    await sql`delete from plans where key = any(${tempPlanKeys})`;
  }
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("reconcileCheckout → entitlement invalidation", () => {
  it("invalidates the org's cached entitlements after the sub syncs (pro)", async () => {
    const { orgId, planKey, priceId } = await seedOrgAwaitingReconcile();
    stripeMock.retrieve.mockResolvedValue(subscriptionSession(orgId, priceId));

    expect(await reconcileCheckout(orgId, "cs_reconcile")).toBe(true);

    // The plan landed AND the stale cache was dropped — this second assertion is
    // what fails without the invalidation call added on the reconcile path.
    const [s] = await sql<{ plan_key: string }[]>`
      select plan_key from subscriptions where org_id = ${orgId}`;
    expect(s.plan_key).toBe(planKey);
    expect(entMock.invalidate).toHaveBeenCalledTimes(1);
    expect(entMock.invalidate).toHaveBeenCalledWith(orgId);
  });

  it("does NOT invalidate when the session carries no subscription (no plan change)", async () => {
    const { orgId } = await seedOrgAwaitingReconcile();
    stripeMock.retrieve.mockResolvedValue({
      metadata: { org_id: orgId },
      customer: "cus_reconcile",
      subscription: null,
    } as unknown as Stripe.Checkout.Session);

    expect(await reconcileCheckout(orgId, "cs_nosub")).toBe(false);
    expect(entMock.invalidate).not.toHaveBeenCalled();
  });
});
