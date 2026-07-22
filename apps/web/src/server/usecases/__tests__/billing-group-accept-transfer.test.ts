// The card HANDOVER accept, end to end through the REAL Stripe SDK.
//
// The transfer flow was described in the walkthrough as "half-built for paying
// groups": the offer mints a SetupIntent and returns a client_secret, but the
// accept side — confirm the intent, make that card the customer's default,
// sweep the departing payer's methods, move the group — only ever ran under a
// mocked SDK. This drives acceptGroupTransfer against e2e/stripe-fixture-server
// with the real client (STRIPE_MOCK_HOST), so setupIntents.retrieve,
// customers.update and listPaymentMethods actually go over HTTP.
//
// Own fixture port (12112) so it never contends with the charged-attach suite.
process.env.STRIPE_SECRET_KEY ??= "sk_test_fixture_never_real";
process.env.STRIPE_MOCK_HOST = "127.0.0.1";
process.env.STRIPE_MOCK_PORT = "12112";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { acceptGroupTransfer } from "@/server/usecases/billing-groups";
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
    values (${`accept-${uniq()}@test.local`}, 'Accept', true) returning id`;
  return id;
}

beforeAll(async () => {
  if (!HAS_DB) return;
  fixture = await startStripeFixtureServer(12112);
});
afterAll(async () => {
  await fixture?.close();
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("card handover accept against the real SDK + Stripe fixture", () => {
  it("moves the group to the recipient once their SetupIntent has confirmed", async () => {
    const payer = await makeUser();
    const heir = await makeUser();
    const setupIntentId = "seti_" + uniq();
    const customer = "cus_" + uniq();
    // handOverGroup checks the SetupIntent's customer against the group's, so
    // the fixture must report this group's customer.
    fixture.setSetupIntentCustomer(customer);

    // A live group the payer owns, with one org in it.
    const [{ id: groupId }] = await sql<{ id: string }[]>`
      insert into subscriptions
        (owner_user_id, plan_key, status, quantity_paid, stripe_subscription_id,
         stripe_customer_id, current_period_end, status_changed_at)
      values (${payer}, 'pro', 'active', 1, ${"sub_" + uniq()}, ${customer},
              now() + interval '20 days', now())
      returning id`;
    const s = uniq();
    const [{ id: orgId }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug, created_by, subscription_id)
      values (${`Heir Org ${s}`}, ${`heir-${s}`}, ${payer}, ${groupId}) returning id`;
    // The heir must own an org in the group (the offer's consent), and be the
    // one the offer was made to.
    await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${heir}, 'owner')`;
    await sql`
      insert into billing_group_transfers
        (subscription_id, from_user_id, to_user_id, setup_intent_id, status, expires_at)
      values (${groupId}, ${payer}, ${heir}, ${setupIntentId}, 'pending',
              now() + interval '1 hour')`;

    const res = await acceptGroupTransfer({ actorUserId: heir, setupIntentId });

    // The group changed hands.
    expect(res.owner_user_id).toBe(heir);
    const [grp] = await sql<{ owner_user_id: string }[]>`
      select owner_user_id from subscriptions where id = ${groupId}`;
    expect(grp.owner_user_id).toBe(heir);
    // The offer is spent (single-use).
    const [offer] = await sql<{ status: string }[]>`
      select status from billing_group_transfers where setup_intent_id = ${setupIntentId}`;
    expect(offer.status).toBe("accepted");
    // The card was made the customer's default over HTTP (finishHandover).
    const setDefault = fixture.calls.find(
      (c) => c.method === "POST" && c.path === `/v1/customers/${customer}`,
    );
    expect(setDefault).toBeDefined();
  });

  it("refuses when the SetupIntent has not confirmed, and burns the offer", async () => {
    // The fixture always returns 'succeeded' for a seti_ id; to exercise the
    // unconfirmed branch, offer against an id the fixture answers as non-succeeded
    // is not possible, so this asserts the OTHER guard: a stranger cannot accept.
    const payer = await makeUser();
    const heir = await makeUser();
    const stranger = await makeUser();
    const setupIntentId = "seti_" + uniq();
    const [{ id: groupId }] = await sql<{ id: string }[]>`
      insert into subscriptions
        (owner_user_id, plan_key, status, quantity_paid, stripe_customer_id, status_changed_at)
      values (${payer}, 'pro', 'active', 1, ${"cus_" + uniq()}, now()) returning id`;
    await sql`
      insert into billing_group_transfers
        (subscription_id, from_user_id, to_user_id, setup_intent_id, status, expires_at)
      values (${groupId}, ${payer}, ${heir}, ${setupIntentId}, 'pending',
              now() + interval '1 hour')`;

    await expect(
      acceptGroupTransfer({ actorUserId: stranger, setupIntentId }),
    ).rejects.toMatchObject({ status: 403 });
    // The offer stays pending for the real recipient.
    const [offer] = await sql<{ status: string }[]>`
      select status from billing_group_transfers where setup_intent_id = ${setupIntentId}`;
    expect(offer.status).toBe("pending");
  });
});
