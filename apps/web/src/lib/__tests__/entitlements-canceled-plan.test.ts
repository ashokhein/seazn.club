// A CANCELLED subscription must not convey its plan.
//
// Before the `status = 'canceled'` arm in orgPlanKey, the only thing degrading a
// departed org was the `customer.subscription.deleted` handler writing
// plan_key = 'community' (billing-events.ts). The resolver itself had no arm for
// it, so any row that reached status='canceled' with plan_key='pro' — by a missed
// webhook plus the past_due self-heal re-syncing plan_key from the subscription's
// price — resolved as Pro for ever, and needsRenewalResync returns false for
// canceled so nothing revisited it.
//
// The comp guard is the other half: compOrg deliberately leaves a dead
// subscription's cancelled status in place (admin-plan.ts), so 'canceled' + a
// running comp is a legitimate staff grant. Degrading that would revoke every
// comp handed to an org that once subscribed — the regression this suite exists
// to catch as much as the leak itself.
//
// Real Postgres required; skipped without DATABASE_URL. Seeds are run-unique.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { getLimit, hasFeature, orgPlanKey } from "@/lib/entitlements";

// Same separator the sibling comp-liveness suite uses: `exports` is true on both
// matrices and so cannot fail, while competitions.max_active is finite on
// community and unlimited (null) on pro. Proves WHICH MATRIX was resolved.
const COMMUNITY_MAX_ACTIVE = 5;

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

/** Seed a pro org with an explicit subscription status and comp window.
 *  `compedDaysFromNow` positions comped_until; omit for no comp at all.
 *
 *  A comp also stamps `comped_at`, because that is what compToPro writes and it
 *  is what the cancelled arm reads. Seeding comped_until alone would describe a
 *  row production never produces. `indefinite` is the forever-comp: comped_at
 *  set, comped_until null — the case that makes comped_until unusable as the
 *  guard. */
async function seedOrg(over: {
  status: string;
  compedDaysFromNow?: number;
  indefinite?: boolean;
  planKey?: string;
}): Promise<string> {
  const suffix = uniq();
  const [{ id: ownerId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`cancelplan-${suffix}@test.local`}, 'Cancel Owner', true) returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Cancel Org " + suffix}, ${"cancel-org-" + suffix}, ${ownerId}) returning id`;
  const comped = over.compedDaysFromNow !== undefined || over.indefinite === true;
  await sql`
    insert into subscriptions
      (org_id, plan_key, status, stripe_subscription_id,
       comped_until, comped_at, status_changed_at)
    values (${orgId}, ${over.planKey ?? "pro"}, ${over.status}, ${"sub_" + suffix},
            ${
              over.compedDaysFromNow === undefined
                ? null
                : sql`now() + (${over.compedDaysFromNow} * interval '1 day')`
            },
            ${comped ? sql`now()` : null},
            now() - interval '1 day')`;
  return orgId;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("a cancelled subscription does not convey its plan", () => {
  // THE leak. This is the exact row shape the missed-webhook + self-heal chain
  // produces: Stripe cancelled it, plan_key was rewritten from the price.
  it("canceled + plan_key='pro' with no comp resolves as community", async () => {
    const orgId = await seedOrg({ status: "canceled" });
    expect(await orgPlanKey(orgId)).toBe("community");
    expect(await hasFeature(orgId, "exports.branded")).toBe(false);
    // Community matrix, not a blanket deny.
    expect(await getLimit(orgId, "competitions.max_active")).toBe(COMMUNITY_MAX_ACTIVE);
  });

  it("the same shape at pro_plus also degrades", async () => {
    const orgId = await seedOrg({ status: "canceled", planKey: "pro_plus" });
    expect(await orgPlanKey(orgId)).toBe("community");
  });

  // The guard. compOrg leaves status='canceled' on a departed row on purpose, so
  // this is what a staff comp on a previously-subscribed org actually looks like.
  it("canceled + a RUNNING comp still conveys pro — staff grants survive", async () => {
    const orgId = await seedOrg({ status: "canceled", compedDaysFromNow: 30 });
    expect(await orgPlanKey(orgId)).toBe("pro");
    expect(await hasFeature(orgId, "exports.branded")).toBe(true);
  });

  // The case that rules comped_until out as the guard, and the reason V313
  // exists: a forever-comp writes comped_until = null, so a `comped_until is
  // null` guard would revoke it. Provenance, not a deadline.
  it("canceled + an INDEFINITE comp (comped_until null) still conveys pro", async () => {
    const orgId = await seedOrg({ status: "canceled", indefinite: true });
    expect(await orgPlanKey(orgId)).toBe("pro");
    expect(await hasFeature(orgId, "exports.branded")).toBe(true);
  });

  it("canceled + a LAPSED comp degrades (first arm, unchanged)", async () => {
    const orgId = await seedOrg({ status: "canceled", compedDaysFromNow: -1 });
    expect(await orgPlanKey(orgId)).toBe("community");
  });

  // Ordering regression guard: the new arm sits after past_due and must not
  // shadow it, nor swallow a live subscription.
  it("an active subscription is untouched", async () => {
    const orgId = await seedOrg({ status: "active" });
    expect(await orgPlanKey(orgId)).toBe("pro");
    expect(await hasFeature(orgId, "exports.branded")).toBe(true);
  });

  it("past_due inside its 14-day grace still conveys pro", async () => {
    const orgId = await seedOrg({ status: "past_due" });
    expect(await orgPlanKey(orgId)).toBe("pro");
  });
});
