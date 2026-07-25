// v17 Task 6 (SPEC-2 §5.4): wiring the trial CREDIT grant into
// syncSubscriptionForGroup — the correctness point is ORDER. grantTrial's
// only guard is subscriptions.trial_used_at, which this same sync stamps
// (billing.ts, "one trial per group" comment) — call the grant after that
// stamp already landed and it always sees trial_used_at set and grants 0.
// This exercises the real wiring path (syncSubscription), not credits.ts's
// grantTrial directly (that's covered by credits-grant.test.ts).
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import { sql } from "@/lib/db";
import { syncSubscription } from "@/lib/billing";
import { balance } from "@/lib/credits";
import { setOrgPlan } from "./_billing-group";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);
const tempPlanKeys: string[] = [];

/** A temp plan with a known Stripe price AND its own `ai.credits.trial` row —
 *  proves syncSubscriptionForGroup grants against the PRICE-RESOLVED plan
 *  (what this sync is about to set), not whatever plan_key is still stored
 *  from before the upgrade. Torn down in afterAll. */
async function seedPlanWithTrialCredits(trialCredits: number): Promise<{ key: string; priceId: string }> {
  const key = `tmp_plan_${uniq()}`;
  const priceId = `price_known_${uniq()}`;
  await sql`insert into plans (key, name, stripe_price_id_monthly)
            values (${key}, ${"Temp " + key}, ${priceId})`;
  await sql`insert into plan_entitlements (plan_key, feature_key, int_value)
            values (${key}, 'ai.credits.trial', ${trialCredits})`;
  tempPlanKeys.push(key);
  return { key, priceId };
}

async function seedOrg(): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: ownerId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`trial-credit-${suffix}@test.local`}, 'Trial Credit Owner', true) returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Trial Credit Org " + suffix}, ${"trial-credit-org-" + suffix}, ${ownerId}) returning id`;
  return orgId;
}

/** Minimal Stripe.Subscription shape syncSubscription reads. Price maps to no
 *  known plan (price_unknown), so syncSubscriptionForGroup falls back to
 *  whatever plan_key is already stored on the row — exactly the "first paid
 *  checkout" shape: setOrgPlan below stamps the target plan directly, mimicking
 *  the plan already being on the row by the time this specific sync fires. */
function stripeSub(over: {
  id: string;
  status: Stripe.Subscription.Status;
  priceId?: string;
}): Stripe.Subscription {
  return {
    id: over.id,
    status: over.status,
    trial_end: null,
    cancel_at_period_end: false,
    currency: "usd",
    items: {
      data: [
        {
          price: { id: over.priceId ?? "price_unknown" },
          current_period_end: Math.floor(Date.now() / 1000) + 86_400,
        },
      ],
    },
  } as unknown as Stripe.Subscription;
}

afterAll(async () => {
  if (!HAS_DB) return;
  if (tempPlanKeys.length) {
    // Same teardown order as billing-sync-guards.test.ts: orgs must let go of
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

describe.skipIf(!HAS_DB)("trial credit grant wiring (syncSubscriptionForGroup)", () => {
  it("grants ai.credits.trial on the sync that stamps trial_used_at (won the ordering)", async () => {
    const orgId = await seedOrg();
    const subId = await setOrgPlan(orgId, "pro");

    expect(await balance(subId)).toBe(0);
    const [before] = await sql<{ trial_used_at: string | null }[]>`
      select trial_used_at from subscriptions where id = ${subId}`;
    expect(before.trial_used_at).toBeNull();

    await syncSubscription(orgId, stripeSub({ id: "sub_first_checkout", status: "active" }));

    // The grant WON the ordering: credits landed on the very sync that also
    // stamped trial_used_at, not "never" (which is what calling grantTrial
    // after the stamp would silently produce).
    expect(await balance(subId)).toBe(20);
    const [after] = await sql<{ trial_used_at: string | null }[]>`
      select trial_used_at from subscriptions where id = ${subId}`;
    expect(after.trial_used_at).not.toBeNull();
  });

  it("does not grant a second time on a later plan-change sync", async () => {
    const orgId = await seedOrg();
    const subId = await setOrgPlan(orgId, "pro");

    await syncSubscription(orgId, stripeSub({ id: "sub_first", status: "active" }));
    expect(await balance(subId)).toBe(20);

    // A later sync (plan change, renewal) must not re-grant the trial.
    await syncSubscription(orgId, stripeSub({ id: "sub_first", status: "active" }));
    expect(await balance(subId)).toBe(20);
  });

  it("grants nothing for a community org, but still stamps trial_used_at", async () => {
    const orgId = await seedOrg();
    const subId = await setOrgPlan(orgId, "community");

    await syncSubscription(orgId, stripeSub({ id: "sub_community", status: "active" }));

    expect(await balance(subId)).toBe(0);
    const [row] = await sql<{ trial_used_at: string | null }[]>`
      select trial_used_at from subscriptions where id = ${subId}`;
    expect(row.trial_used_at).not.toBeNull();
  });

  it("grants against the PRICE-RESOLVED plan, not the stale stored plan_key", async () => {
    // The real first-checkout shape: the row is still 'community' in the DB
    // (createOrgForUser's default) until THIS sync's UPDATE lands the new
    // plan from the Stripe price. Reading the stored plan_key at grant time
    // (rather than the resolved one) would look up 'community' — no
    // ai.credits.trial row — and silently grant 0.
    const { priceId } = await seedPlanWithTrialCredits(15);
    const orgId = await seedOrg();
    const subId = await setOrgPlan(orgId, "community");

    await syncSubscription(orgId, stripeSub({ id: "sub_upgrade", status: "active", priceId }));

    expect(await balance(subId)).toBe(15);
  });
});
