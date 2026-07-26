// The TRIAL seat-accounting rule, end to end through the REAL Stripe SDK.
//
// Like billing-group-charged-attach.test.ts, this does NOT mock @/lib/stripe: it
// points the real client at e2e/stripe-fixture-server so syncGroupQuantity does
// its retrieve→update round trip for real. What it pins is the trial branch: a
// trial defers every charge to its end invoice, so attaching/detaching an org
// mid-trial must NOT move `quantity_paid` (doing so minted a phantom "paid seat
// free" line on a group that had paid nothing — reproduced live as quantity_paid
// going {1, 2, 2, 1} across attach/detach/trial-end). The Stripe ITEM still syncs
// to the active count so the trial-end invoice bills the right number, and the
// renewal path is what finally sets `quantity_paid`. An ACTIVE (non-trial) group
// is asserted to still inflate quantity_paid, so the fix is scoped to trials.

// BEFORE any import pulls in @/lib/stripe: a fake key (the fixture ignores it)
// and the host override, so getStripe() builds a client aimed at the fixture.
process.env.STRIPE_SECRET_KEY ??= "sk_test_fixture_never_real";
process.env.STRIPE_MOCK_HOST = "127.0.0.1";
process.env.STRIPE_MOCK_PORT = "12118";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import {
  attachOrgToGroup,
  detachOrgFromGroup,
  previewAttachCharge,
  syncGroupQuantity,
} from "@/server/usecases/billing-groups";
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
    values (${`trial-${uniq()}@test.local`}, 'Trial', true) returning id`;
  return id;
}

/** A live group + one org in it, owned by `ownerId`. `status` lets a test build
 *  a trialing group as easily as an active one. */
async function makeGroupWithOrg(
  ownerId: string,
  opts: {
    stripeSubId: string;
    stripeCustomerId?: string;
    quantityPaid?: number;
    status?: "trialing" | "active";
  },
): Promise<{ groupId: string; orgId: string }> {
  const [{ id: groupId }] = await sql<{ id: string }[]>`
    insert into subscriptions
      (owner_user_id, plan_key, status, quantity_paid, stripe_subscription_id,
       stripe_customer_id, current_period_end, status_changed_at)
    values (${ownerId}, 'pro', ${opts.status ?? "trialing"}, ${opts.quantityPaid ?? 1},
            ${opts.stripeSubId}, ${opts.stripeCustomerId ?? "cus_" + uniq()},
            now() + interval '20 days', now())
    returning id`;
  const s = uniq();
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by, subscription_id)
    values (${`Trial ${s}`}, ${`trial-${s}`}, ${ownerId}, ${groupId}) returning id`;
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

async function quantityPaid(groupId: string): Promise<number> {
  const [{ quantity_paid }] = await sql<{ quantity_paid: number }[]>`
    select quantity_paid from subscriptions where id = ${groupId}`;
  return quantity_paid;
}

beforeAll(async () => {
  if (!HAS_DB) return;
  fixture = await startStripeFixtureServer(12118);
});
beforeEach(() => fixture?.reset());
afterAll(async () => {
  await fixture?.close();
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("trial seat accounting against the real SDK + Stripe fixture", () => {
  it("freezes quantity_paid through a trial attach and detach", async () => {
    const payer = await makeUser();
    const subId = "sub_" + uniq();
    const { groupId } = await makeGroupWithOrg(payer, {
      stripeSubId: subId,
      quantityPaid: 1,
      status: "trialing",
    });
    fixture.seedSubscription({ id: subId, customer: "cus_seed", quantity: 1, scheme: "tiered" });
    const joiner = await makeCommunityOrg(payer);

    // Attach DURING the trial: the item syncs to 2 so the trial-end invoice bills
    // two, but nothing is charged now and quantity_paid must not move off 1.
    const attach = await attachOrgToGroup({ actorUserId: payer, orgId: joiner, subscriptionId: groupId });
    expect(attach.quantity).toBe(2);
    expect(attach.charged).toBe(false);
    expect(await quantityPaid(groupId)).toBe(1);

    // The item reached Stripe at quantity 2 but with NO proration (deferred to
    // trial end), not create_prorations.
    const up = fixture.calls.find(
      (c) => c.method === "POST" && c.path === `/v1/subscriptions/${subId}`,
    );
    expect(up).toBeDefined();
    expect(up!.body["items[0][quantity]"]).toBe("2");
    expect(up!.body["proration_behavior"]).toBe("none");

    // Detach it again: still mid-trial, quantity_paid stays 1 (no phantom freed
    // paid seat left behind).
    await detachOrgFromGroup({ actorUserId: payer, orgId: joiner });
    expect(await quantityPaid(groupId)).toBe(1);
  });

  it("previews a trial attach as free", async () => {
    const payer = await makeUser();
    const subId = "sub_" + uniq();
    const { groupId } = await makeGroupWithOrg(payer, {
      stripeSubId: subId,
      quantityPaid: 1,
      status: "trialing",
    });
    fixture.seedSubscription({ id: subId, customer: "cus_seed", quantity: 1, scheme: "tiered" });
    // Even with a proration seeded, a trialing group previews free — the trial
    // defers it, so the confirm dialog must not promise "charged now".
    fixture.setUpcomingProration(900, "gbp");
    expect(await previewAttachCharge(groupId)).toBeNull();
  });

  it("lets the trial-end renewal set quantity_paid to the active count", async () => {
    const payer = await makeUser();
    const subId = "sub_" + uniq();
    const { groupId } = await makeGroupWithOrg(payer, {
      stripeSubId: subId,
      quantityPaid: 1,
      status: "trialing",
    });
    fixture.seedSubscription({ id: subId, customer: "cus_seed", quantity: 2, scheme: "tiered" });
    // A second org rode the trial (item already at 2, quantity_paid frozen at 1).
    const s = uniq();
    await sql`
      insert into organizations (name, slug, created_by, subscription_id)
      values (${`Rider ${s}`}, ${`rider-${s}`}, ${payer}, ${groupId})`;
    expect(await quantityPaid(groupId)).toBe(1);

    // The trial converts: the renewal invoice is the authoritative setter, and it
    // records the two seats it actually billed.
    await syncGroupQuantity(groupId, { renewal: true, invoicedQuantity: 2 });
    expect(await quantityPaid(groupId)).toBe(2);
  });

  it("still inflates quantity_paid on an ACTIVE (non-trial) group", async () => {
    const payer = await makeUser();
    const subId = "sub_" + uniq();
    const { groupId } = await makeGroupWithOrg(payer, {
      stripeSubId: subId,
      quantityPaid: 1,
      status: "active",
    });
    fixture.seedSubscription({ id: subId, customer: "cus_seed", quantity: 1, scheme: "tiered" });
    const joiner = await makeCommunityOrg(payer);

    // The non-trial path is unchanged: the second seat is a real charge and
    // quantity_paid rises to match.
    const attach = await attachOrgToGroup({ actorUserId: payer, orgId: joiner, subscriptionId: groupId });
    expect(attach.charged).toBe(true);
    expect(attach.quantity).toBe(2);
    expect(await quantityPaid(groupId)).toBe(2);

    const up = fixture.calls.find(
      (c) => c.method === "POST" && c.path === `/v1/subscriptions/${subId}`,
    );
    expect(up!.body["proration_behavior"]).toBe("create_prorations");
  });
});
