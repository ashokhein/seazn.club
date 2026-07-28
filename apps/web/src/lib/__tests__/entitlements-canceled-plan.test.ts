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
import { groupOrgLimit } from "@/lib/billing-group";
import { processStripeEvent } from "@/server/usecases/billing-events";
import type Stripe from "stripe";

// Same separator the sibling comp-liveness suite uses: `exports` is true on both
// matrices and so cannot fail, while competitions.max_active is finite on
// community and unlimited (null) on pro. Proves WHICH MATRIX was resolved.
const COMMUNITY_MAX_ACTIVE = 10;

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
  // V314: the subscription IS the group and the org points at it.
  const [{ id: subId }] = await sql<{ id: string }[]>`
    insert into subscriptions
      (owner_user_id, plan_key, status, stripe_subscription_id,
       comped_until, comped_at, status_changed_at)
    values (${ownerId}, ${over.planKey ?? "pro"}, ${over.status}, ${"sub_" + suffix},
            ${
              over.compedDaysFromNow === undefined
                ? null
                : sql`now() + (${over.compedDaysFromNow} * interval '1 day')`
            },
            ${comped ? sql`now()` : null},
            now() - interval '1 day')
    returning id`;
  await sql`update organizations set subscription_id = ${subId} where id = ${orgId}`;
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

// v17 gap #293, acceptance item 4 ("cancelling the add-on drops the cap").
//
// The plan degrades on churn because handleSubscriptionDeleted writes
// plan_key='community' — but the RECURRING add-on rows are a second axis the
// resolver sums on TOP of that base, and nothing was cancelling them. The
// add-on sweep (syncOrgAddonsForSubscription) runs only on
// `customer.subscription.updated`, and a DELETED subscription still reports its
// items, so the sweep never sees an empty list and never fires. Net effect: a
// churned group kept `community base 1 + N` orgs.max_owned for ever, unpaid —
// V314:244-245's "silent reseller", reached by cancelling outright.
//
// The self-serve guard added with the purchase usecase covers only
// setExtraOrgs; churn bypasses it entirely, which is why the fix lives in the
// webhook handler.
const COMMUNITY_MAX_OWNED = 1;

/** A group with a Stripe subscription id, one org, and add-on rows on three
 *  distinct axes: a PURCHASED extra-org rider, an ADMIN comp of the same cap,
 *  and a purchased SEAT rider. Only the first may die with the subscription. */
async function seedChurnGroup(): Promise<{
  orgId: string;
  subId: string;
  stripeSubId: string;
}> {
  const suffix = uniq();
  const stripeSubId = `sub_churn_${suffix}`;
  const [{ id: ownerId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`churn-${suffix}@test.local`}, 'Churn Owner', true) returning id`;
  const [{ id: subId }] = await sql<{ id: string }[]>`
    insert into subscriptions
      (owner_user_id, plan_key, status, stripe_subscription_id, status_changed_at)
    values (${ownerId}, 'pro', 'active', ${stripeSubId}, now() - interval '1 day')
    returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by, subscription_id)
    values (${"Churn Org " + suffix}, ${"churn-org-" + suffix}, ${ownerId}, ${subId})
    returning id`;
  await sql`insert into org_members (org_id, user_id, role)
            values (${orgId}, ${ownerId}, 'owner')`;
  await sql`
    insert into org_addons
      (wallet_id, target_org_id, feature_key, delta_each, qty, stripe_item_id, status)
    values
      (${subId}, null, 'orgs.max_owned', 1, 2, ${`si_org_${suffix}`}, 'active'),
      (${subId}, null, 'orgs.max_owned', 1, 1, null, 'granted'),
      (${subId}, null, 'members.max', 1, 3, ${`si_seat_${suffix}`}, 'active')`;
  return { orgId, subId, stripeSubId };
}

function deletedEvent(stripeSubId: string, subId: string): Stripe.Event {
  return {
    id: `evt_${uniq()}`,
    type: "customer.subscription.deleted",
    data: {
      object: {
        id: stripeSubId,
        status: "canceled",
        customer: `cus_${uniq()}`,
        metadata: { subscription_id: subId },
        // A deleted subscription STILL reports its items — the whole reason the
        // updated-only reconcile sweep can never see this group go empty.
        items: { data: [{ id: "si_plan", quantity: 1 }] },
      },
    },
  } as unknown as Stripe.Event;
}

describe.skipIf(!HAS_DB)("churn cancels the recurring add-ons it was renting", () => {
  it("drops orgs.max_owned back to community base and freezes the purchased row", async () => {
    const { orgId, subId, stripeSubId } = await seedChurnGroup();
    // pro base 5 + purchased 2 + admin comp 1
    expect(await getLimit(orgId, "orgs.max_owned")).toBe(8);

    await processStripeEvent(deletedEvent(stripeSubId, subId));

    // community base 1 + the admin comp only. Before the fix this answered 4:
    // the $9/$19 rider outlived the subscription that paid for it.
    expect(await orgPlanKey(orgId)).toBe("community");
    expect(await getLimit(orgId, "orgs.max_owned")).toBe(COMMUNITY_MAX_OWNED + 1);
    expect(await groupOrgLimit(subId)).toBe(COMMUNITY_MAX_OWNED + 1);

    // FROZEN, not deleted (V323/V324): the row and its qty survive for history
    // and for a re-buy.
    const rows = await sql<{ feature_key: string; qty: number; status: string }[]>`
      select feature_key, qty, status from org_addons
       where wallet_id = ${subId} and stripe_item_id is not null
         and feature_key = 'orgs.max_owned'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("canceled");
    expect(rows[0]!.qty).toBe(2);
  });

  // An INVARIANT. This assertion must never go red: an admin comp is capacity
  // the group was GIVEN, not something Stripe was billing, so no cancel path
  // may ever revoke it. Deliberately split from the seat assertion below, which
  // pins a BUG — bundling the two meant fixing that bug would red a test whose
  // name promised a permanent rule.
  it("leaves the admin comp alone — a grant is not something Stripe was billing", async () => {
    const { subId, stripeSubId } = await seedChurnGroup();

    await processStripeEvent(deletedEvent(stripeSubId, subId));

    // status='granted', null stripe_item_id — the same scoping the add-on sweep
    // uses, so both agree on what a comp is.
    const [granted] = await sql<{ status: string }[]>`
      select status from org_addons
       where wallet_id = ${subId} and feature_key = 'orgs.max_owned'
         and stripe_item_id is null`;
    expect(granted!.status).toBe("granted");
  });

  // PINNED BUG, not an invariant. Seats have the same churn hole this describe
  // block closes for orgs.max_owned: a `members.max` rider outlives the
  // subscription that paid for it. That is INHERITED, not introduced by v17 gap
  // #293, and is tracked as issue #330. This test records TODAY's behaviour so
  // the #293 cancel is proven not to reach across feature keys; when #330 is
  // fixed, THIS is the test that should go red, and flipping it to 'canceled'
  // is the expected edit.
  it("PINNED BUG #330: the seat rider survives churn — it must go red when #330 is fixed", async () => {
    const { subId, stripeSubId } = await seedChurnGroup();

    await processStripeEvent(deletedEvent(stripeSubId, subId));

    const [seat] = await sql<{ status: string }[]>`
      select status from org_addons
       where wallet_id = ${subId} and feature_key = 'members.max'`;
    expect(seat!.status).toBe("active");
  });

  it("refuses to cancel another group's rows when the delete may not write", async () => {
    // mayWriteGroup's P1-5 guard: a late `deleted` for a REPLACED subscription
    // must not touch the resubscribed group. The add-on cancel sits after that
    // return, so it inherits the protection — assert it, because a cancel
    // placed before the guard would strip a paying customer's caps.
    const { orgId, subId } = await seedChurnGroup();
    await processStripeEvent(deletedEvent(`sub_stale_${uniq()}`, subId));

    expect(await orgPlanKey(orgId)).toBe("pro");
    expect(await getLimit(orgId, "orgs.max_owned")).toBe(8);
  });
});
