// The CHARGED attach, end to end through the REAL Stripe SDK.
//
// Every other billing-group test mocks `@/lib/stripe` — the SDK is replaced, so
// the wire format and the retrieve→update round trip are never exercised. This
// one does NOT mock it: it points the real client at e2e/stripe-fixture-server
// (via STRIPE_MOCK_HOST, set below before anything calls getStripe) and drives
// `attachOrgToGroup` against a LIVE group, so syncGroupQuantity actually
// retrieves the subscription item, sees the seat count rise past what is paid
// for, and issues the prorated quantity update — the path that is `charged:
// false` for every non-live group and so never ran in a browser or here.
//
// What it proves: the charge branch fires (charged: true), sends the right
// quantity and proration_behavior over HTTP, and a re-add into a freed slot does
// NOT charge again. What it can't: whether Stripe bills that seat at half rate —
// the fixture returns what it is told to. That needs a real test-mode account.

// BEFORE any import pulls in @/lib/stripe: a fake key (the fixture ignores it)
// and the host override, so getStripe() builds a client aimed at the fixture.
process.env.STRIPE_SECRET_KEY ??= "sk_test_fixture_never_real";
process.env.STRIPE_MOCK_HOST = "127.0.0.1";
process.env.STRIPE_MOCK_PORT = "12111";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { attachOrgToGroup, previewAttachCharge } from "@/server/usecases/billing-groups";
import {
  startStripeFixtureServer,
  type StripeFixtureServer,
} from "../../../../e2e/stripe-fixture-server";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

let fixture: StripeFixtureServer;

async function makeUser(): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`charged-${uniq()}@test.local`}, 'Charged', true) returning id`;
  return id;
}

/** A group + one org in it, owned by `ownerId`. */
async function makeGroupWithOrg(
  ownerId: string,
  opts: { stripeSubId?: string; stripeCustomerId?: string; quantityPaid?: number } = {},
): Promise<{ groupId: string; orgId: string }> {
  const [{ id: groupId }] = await sql<{ id: string }[]>`
    insert into subscriptions
      (owner_user_id, plan_key, status, quantity_paid, stripe_subscription_id,
       stripe_customer_id, current_period_end, status_changed_at)
    values (${ownerId}, 'pro', 'active', ${opts.quantityPaid ?? 1},
            ${opts.stripeSubId ?? null}, ${opts.stripeCustomerId ?? null},
            now() + interval '20 days', now())
    returning id`;
  const s = uniq();
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by, subscription_id)
    values (${`Charged ${s}`}, ${`charged-${s}`}, ${ownerId}, ${groupId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${ownerId}, 'owner')`;
  return { groupId, orgId };
}

/** A community group of its own for the org that will be attached. */
async function makeCommunityOrg(ownerId: string): Promise<string> {
  const [{ id: subId }] = await sql<{ id: string }[]>`
    insert into subscriptions (owner_user_id, plan_key, status, quantity_paid)
    values (${ownerId}, 'community', 'active', 1) returning id`;
  const s = uniq();
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by, subscription_id)
    values (${`Joiner ${s}`}, ${`joiner-${s}`}, ${ownerId}, ${subId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${ownerId}, 'owner')`;
  return orgId;
}

beforeAll(async () => {
  if (!HAS_DB) return;
  fixture = await startStripeFixtureServer(12111);
});
beforeEach(() => fixture?.reset());
afterAll(async () => {
  await fixture?.close();
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("charged attach against the real SDK + Stripe fixture", () => {
  it("charges a prorated seat when an org joins a live, fully-paid group", async () => {
    const payer = await makeUser();
    const subId = "sub_" + uniq();
    const { groupId } = await makeGroupWithOrg(payer, {
      stripeSubId: subId,
      stripeCustomerId: "cus_" + uniq(),
      quantityPaid: 1, // the one org already there is paid for
    });
    fixture.seedSubscription({ id: subId, customer: "cus_seed", quantity: 1, scheme: "tiered" });
    const joiner = await makeCommunityOrg(payer);

    const res = await attachOrgToGroup({ actorUserId: payer, orgId: joiner, subscriptionId: groupId });

    // The second seat is genuinely new (2 > 1 held AND 2 > 1 paid), so it charges.
    expect(res.charged).toBe(true);
    expect(res.quantity).toBe(2);

    // And it reached Stripe over HTTP with the right shape.
    const update = fixture.calls.find(
      (c) => c.method === "POST" && c.path === `/v1/subscriptions/${subId}`,
    );
    expect(update).toBeDefined();
    expect(update!.body["items[0][quantity]"]).toBe("2");
    expect(update!.body["proration_behavior"]).toBe("create_prorations");
  });

  it("does NOT charge when re-adding into a slot already paid for", async () => {
    const payer = await makeUser();
    const subId = "sub_" + uniq();
    // Two seats already PAID for, one org present: a freed, still-paid slot.
    const { groupId } = await makeGroupWithOrg(payer, {
      stripeSubId: subId,
      stripeCustomerId: "cus_" + uniq(),
      quantityPaid: 2,
    });
    fixture.seedSubscription({ id: subId, customer: "cus_seed", quantity: 2, scheme: "tiered" });
    const joiner = await makeCommunityOrg(payer);

    const res = await attachOrgToGroup({ actorUserId: payer, orgId: joiner, subscriptionId: groupId });

    // active becomes 2, which is NOT past the 2 already paid — free.
    expect(res.charged).toBe(false);
    // The item was already at 2, so no quantity update is sent at all.
    const update = fixture.calls.find(
      (c) => c.method === "POST" && c.path === `/v1/subscriptions/${subId}`,
    );
    expect(update).toBeUndefined();
  });

  it("previews the exact prorated amount on a live, fully-paid group", async () => {
    const payer = await makeUser();
    const subId = "sub_" + uniq();
    const { groupId } = await makeGroupWithOrg(payer, {
      stripeSubId: subId,
      stripeCustomerId: "cus_" + uniq(),
      quantityPaid: 1,
    });
    fixture.seedSubscription({ id: subId, customer: "cus_seed", quantity: 1 });
    fixture.setUpcomingProration(900, "gbp"); // £9.00 prorated

    const preview = await previewAttachCharge(groupId);
    expect(preview).toEqual({ amount_minor: 900, currency: "gbp" });
  });

  it("previews null (free) for a non-live group and for a paid freed slot", async () => {
    const payer = await makeUser();
    // Non-live (community, no Stripe subscription).
    const [{ id: community }] = await sql<{ id: string }[]>`
      insert into subscriptions (owner_user_id, plan_key, status, quantity_paid)
      values (${payer}, 'community', 'active', 1) returning id`;
    const c = uniq();
    await sql`insert into organizations (name, slug, created_by, subscription_id)
              values (${`NL ${c}`}, ${`nl-${c}`}, ${payer}, ${community})`;
    expect(await previewAttachCharge(community)).toBeNull();

    // Live but with a freed, still-paid slot (quantity_paid 2, one org).
    const subId = "sub_" + uniq();
    const { groupId } = await makeGroupWithOrg(payer, {
      stripeSubId: subId,
      stripeCustomerId: "cus_" + uniq(),
      quantityPaid: 2,
    });
    fixture.seedSubscription({ id: subId, customer: "cus_seed2", quantity: 2 });
    expect(await previewAttachCharge(groupId)).toBeNull();
  });
});
