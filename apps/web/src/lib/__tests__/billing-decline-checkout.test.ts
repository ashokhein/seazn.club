// #206.1: a declined first payment at the embedded checkout. The checkout sheet
// is a Stripe-hosted iframe Playwright cannot type a card into, so this covers
// the SERVER path a declined return actually lands on: reconcileCheckout reading
// back a session whose subscription is `incomplete` — Stripe's status for a
// first payment that never confirmed (declined card, abandoned 3DS). The org
// must NOT be granted the plan (the leak is closed at the entitlement layer,
// #237) and no active/Pro row is left stranded. A completed payment is the
// contrast. Real Postgres required; skipped without DATABASE_URL.
import { afterAll, beforeEach, describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";

// Keep the resolver real (we assert on orgPlanKey); only stub the cache drop.
vi.mock("@/lib/entitlements", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/entitlements")>()),
  invalidateEntitlementsForOrgGroup: vi.fn().mockResolvedValue(undefined),
}));

// checkout.sessions.retrieve is the only Stripe call reconcileCheckout makes.
const stripeMock = vi.hoisted(() => {
  const retrieve = vi.fn();
  return { retrieve, stripe: { checkout: { sessions: { retrieve } } } };
});
vi.mock("@/lib/stripe", () => ({ getStripe: () => stripeMock.stripe }));

import { sql } from "@/lib/db";
import { reconcileCheckout } from "@/lib/billing";
import { orgPlanKey } from "@/lib/entitlements";
import { setOrgPlan } from "./_billing-group";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);
const tempPlanKeys: string[] = [];

/** Fresh org on community, plus a temp paid plan whose price the reconcile maps. */
async function seedOrg(): Promise<{ orgId: string; planKey: string; priceId: string }> {
  const suffix = uniq();
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug)
    values (${"Decline Org " + suffix}, ${"decline-org-" + suffix}) returning id`;
  await setOrgPlan(orgId, "community");
  const planKey = `tmp_plan_${suffix}`;
  const priceId = `price_decline_${suffix}`;
  await sql`insert into plans (key, name, stripe_price_id_monthly)
            values (${planKey}, ${"Temp " + planKey}, ${priceId})`;
  tempPlanKeys.push(planKey);
  return { orgId, planKey, priceId };
}

/** A subscription checkout session as reconcileCheckout retrieves it, with the
 *  subscription in the given status (incomplete = declined first payment). */
function session(
  orgId: string,
  priceId: string,
  status: Stripe.Subscription.Status,
): Stripe.Checkout.Session {
  return {
    metadata: { org_id: orgId },
    // Unique per session: V314's partial unique index on
    // subscriptions.stripe_customer_id rejects two orgs sharing a customer.
    customer: "cus_decline_" + uniq(),
    subscription: {
      id: "sub_decline_" + uniq(),
      status,
      trial_end: null,
      cancel_at_period_end: false,
      currency: "usd",
      items: {
        data: [{ price: { id: priceId }, current_period_end: Math.floor(Date.now() / 1000) + 86_400 }],
      },
    },
  } as unknown as Stripe.Checkout.Session;
}

beforeEach(() => stripeMock.retrieve.mockReset());

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

describe.skipIf(!HAS_DB)("declined first payment at checkout (#206.1)", () => {
  it("lands `incomplete` and conveys NO plan — no free Pro from a failed payment", async () => {
    const { orgId, planKey, priceId } = await seedOrg();
    stripeMock.retrieve.mockResolvedValue(session(orgId, priceId, "incomplete"));

    // The reconcile still runs and syncs the subscription off the session…
    expect(await reconcileCheckout(orgId, "cs_decline")).toBe(true);

    const [s] = await sql<{ status: string; plan_key: string }[]>`
      select status, plan_key from subscriptions
       where id = (select subscription_id from organizations where id = ${orgId})`;
    // …but it is `incomplete` (not active, not past_due — no grace), and although
    // the price synced the plan_key, the org is entitled to nothing until it pays.
    expect(s.status).toBe("incomplete");
    expect(s.plan_key).toBe(planKey);
    expect(await orgPlanKey(orgId)).toBe("community");
  });

  it("a completed payment lands `active` and DOES convey the plan (contrast)", async () => {
    const { orgId, planKey, priceId } = await seedOrg();
    stripeMock.retrieve.mockResolvedValue(session(orgId, priceId, "active"));

    expect(await reconcileCheckout(orgId, "cs_ok")).toBe(true);
    expect(await orgPlanKey(orgId)).toBe(planKey);
  });
});
