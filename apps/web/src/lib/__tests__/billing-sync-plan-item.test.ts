// #329, the money half: what syncSubscriptionForGroup PERSISTS off a
// multi-item subscription.
//
// A group with an extra-organisation rider carries two subscription items and
// Stripe does not promise which comes first. The two items report different
// `current_period_end` — measured at 2027-07-27 (annual plan) against
// 2026-08-27 (monthly rider) on one live test-mode subscription. While
// billing.ts read `items.data[0]`, an add-on landing first stamped the group's
// `current_period_end` eleven months early: an annual customer who paid through
// 2027 reads as lapsing in 2026, and every renewal/entitlement decision that
// hangs off that column follows it.
//
// Its own file rather than an `it` bolted onto billing-sync-trial-credits.ts:
// that suite's `stripeSub()` builder is single-item BY CONSTRUCTION (the point
// it pins is grant ORDER), and widening it to carry add-ons would put the
// two-item fixture underneath assertions that have nothing to do with it.
//
// Real Postgres required; skipped without DATABASE_URL. Seeds are run-unique.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import { sql } from "@/lib/db";
import { syncSubscriptionForGroup } from "@/lib/billing";
import { ORG_ADDON_FEATURE_KEY } from "@/lib/org-addons";
import { setOrgPlan } from "./_billing-group";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);
const tempPlanKeys: string[] = [];

/** The two period ends measured on the live test-mode subscription that this
 *  issue was reproduced against: an ANNUAL plan item and a MONTHLY rider. */
const PLAN_PERIOD_END = Math.floor(Date.UTC(2027, 6, 27) / 1000); // annual plan
const ADDON_PERIOD_END = Math.floor(Date.UTC(2026, 7, 27) / 1000); // monthly rider

/** A temp plan with a known Stripe price, so the same fixture also pins the
 *  price→plan_key resolution (billing.ts's other `items.data[0]` read): if that
 *  one picks the add-on, the price is unknown and the plan key never lands. */
async function seedPlanWithPrice(): Promise<{ key: string; priceId: string }> {
  const key = `tmp_plan_${uniq()}`;
  const priceId = `price_known_${uniq()}`;
  await sql`insert into plans (key, name, stripe_price_id_annual)
            values (${key}, ${"Temp " + key}, ${priceId})`;
  tempPlanKeys.push(key);
  return { key, priceId };
}

async function seedOrg(): Promise<string> {
  const suffix = uniq();
  const [owner] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`plan-item-${suffix}@test.local`}, 'Plan Item Owner', true) returning id`;
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Plan Item Org " + suffix}, ${"plan-item-org-" + suffix}, ${owner!.id}) returning id`;
  return org!.id;
}

/** The shape the webhook actually hands us for a group that bought an extra
 *  organisation: TWO items, the RIDER first. Stripe's ordering is not a
 *  contract, so "first" here is not a contrivance — it is one of the two
 *  orderings production sees, and the one nothing was defending against. */
function twoItemSub(planPriceId: string): Stripe.Subscription {
  return {
    id: `sub_${uniq()}`,
    status: "active",
    trial_end: null,
    cancel_at_period_end: false,
    currency: "usd",
    items: {
      data: [
        {
          id: "si_rider",
          price: { id: `price_rider_${uniq()}` },
          current_period_end: ADDON_PERIOD_END,
          metadata: { feature_key: ORG_ADDON_FEATURE_KEY },
        },
        {
          id: "si_plan",
          price: { id: planPriceId },
          current_period_end: PLAN_PERIOD_END,
          metadata: {},
        },
      ],
    },
  } as unknown as Stripe.Subscription;
}

afterAll(async () => {
  if (!HAS_DB) return;
  if (tempPlanKeys.length) {
    // Same teardown order as billing-sync-trial-credits.test.ts: orgs let go of
    // the group (organizations_subscription_fk) before the subscriptions row
    // referencing the temp plan can go, before plan_entitlements/plans.
    await sql`
      update organizations set subscription_id = null
       where subscription_id in (select id from subscriptions
                                  where plan_key = any(${tempPlanKeys}))`;
    await sql`delete from subscriptions where plan_key = any(${tempPlanKeys})`;
    await sql`delete from plan_entitlements where plan_key = any(${tempPlanKeys})`;
    await sql`delete from plans where key = any(${tempPlanKeys})`;
  }
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("syncSubscriptionForGroup with an add-on item present (#329)", () => {
  it("stamps current_period_end from the PLAN item, not from whichever item is first", async () => {
    const { key, priceId } = await seedPlanWithPrice();
    const orgId = await seedOrg();
    const groupId = await setOrgPlan(orgId, "pro", "active");

    await syncSubscriptionForGroup(groupId, twoItemSub(priceId));

    const [row] = await sql<{ current_period_end: string | null; plan_key: string }[]>`
      select current_period_end, plan_key from subscriptions where id = ${groupId}`;

    expect(row?.current_period_end).not.toBeNull();
    expect(new Date(row!.current_period_end!).toISOString()).toBe(
      new Date(PLAN_PERIOD_END * 1000).toISOString(),
    );
    // The rider's own end must never be what we stored — that is the eleven
    // months, spelled out so a regression reads as the bug and not as an
    // off-by-something.
    expect(new Date(row!.current_period_end!).toISOString()).not.toBe(
      new Date(ADDON_PERIOD_END * 1000).toISOString(),
    );
    // Same read, other consumer: the price we resolve the plan from is the
    // plan item's, so the group actually lands on the purchased plan.
    expect(row?.plan_key).toBe(key);
  });
});
