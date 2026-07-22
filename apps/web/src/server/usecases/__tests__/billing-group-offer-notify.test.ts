// Task B: offerGroupTransfer must NOTIFY the recipient. Today the offer is
// created and nothing is sent, so the recipient never learns. This drives
// offerGroupTransfer on a live-sub group through the real Stripe fixture (it
// mints a SetupIntent) and asserts the email is fired to the recipient — and,
// critically, that the email is BEST-EFFORT: a send that throws or returns false
// must not roll back the committed offer row.
//
// Own fixture port (12118) so it never contends with the other transfer suites.
process.env.STRIPE_SECRET_KEY ??= "sk_test_fixture_never_real";
process.env.STRIPE_MOCK_HOST = "127.0.0.1";
process.env.STRIPE_MOCK_PORT = "12118";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// Mock the email module so no real send happens and we can spy/steer it.
// vi.mock is hoisted above imports, so the fn must come from vi.hoisted.
const { sendTransferOfferEmail } = vi.hoisted(() => ({
  sendTransferOfferEmail: vi.fn<
    (to: string, payerName: string, groupName: string, link: string, locale?: string) => Promise<boolean>
  >(async () => true),
}));
vi.mock("@/lib/email", () => ({ sendTransferOfferEmail }));

import { sql } from "@/lib/db";
import { offerGroupTransfer } from "@/server/usecases/billing-groups";
import {
  startStripeFixtureServer,
  type StripeFixtureServer,
} from "../../../../e2e/stripe-fixture-server";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);
let fixture: StripeFixtureServer;

async function makeUser(name = "Payer"): Promise<{ id: string; email: string }> {
  const email = `offer-${uniq()}@test.local`;
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${email}, ${name}, true) returning id`;
  return { id, email };
}

/** A live pro group the payer owns, one org in it that the heir owns, and no
 *  standing pending offer. Returns ids + the recipient's email. */
async function seedLiveGroup() {
  const payer = await makeUser("Dana Payer");
  const heir = await makeUser("Rae Heir");
  const customer = "cus_" + uniq();
  fixture.setSetupIntentCustomer(customer);

  const [{ id: groupId }] = await sql<{ id: string }[]>`
    insert into subscriptions
      (owner_user_id, plan_key, status, quantity_paid, stripe_subscription_id,
       stripe_customer_id, current_period_end, status_changed_at)
    values (${payer.id}, 'pro', 'active', 1, ${"sub_" + uniq()}, ${customer},
            now() + interval '20 days', now())
    returning id`;
  const s = uniq();
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by, subscription_id)
    values (${`Riverside ${s}`}, ${`riverside-${s}`}, ${payer.id}, ${groupId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${heir.id}, 'owner')`;
  return { payer, heir, groupId, orgId };
}

beforeAll(async () => {
  if (!HAS_DB) return;
  fixture = await startStripeFixtureServer(12118);
});
afterAll(async () => {
  await fixture?.close();
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});
beforeEach(() => {
  sendTransferOfferEmail.mockReset();
  sendTransferOfferEmail.mockResolvedValue(true);
});

describe.skipIf(!HAS_DB)("offerGroupTransfer notifies the recipient", () => {
  it("emails the recipient with their address when a live-sub group is offered", async () => {
    const { payer, heir, groupId } = await seedLiveGroup();

    const res = await offerGroupTransfer({
      actorUserId: payer.id,
      subscriptionId: groupId,
      newOwnerUserId: heir.id,
    });
    expect(res.status).toBe("pending_card");

    expect(sendTransferOfferEmail).toHaveBeenCalledTimes(1);
    const [to, payerName, groupName, link] = sendTransferOfferEmail.mock.calls[0];
    expect(to).toBe(heir.email);
    expect(payerName).toBe("Dana Payer");
    expect(typeof groupName).toBe("string");
    expect(link).toMatch(/\/o\/riverside-[a-z0-9]+\/settings\/billing$/);
  });

  it("is best-effort: an email that throws does not roll back the committed offer", async () => {
    const { payer, heir, groupId } = await seedLiveGroup();
    sendTransferOfferEmail.mockRejectedValueOnce(new Error("resend down"));

    // The offer must still resolve.
    const res = await offerGroupTransfer({
      actorUserId: payer.id,
      subscriptionId: groupId,
      newOwnerUserId: heir.id,
    });
    expect(res.status).toBe("pending_card");

    // And the offer row is present and pending — not rolled back.
    const [offer] = await sql<{ status: string; to_user_id: string }[]>`
      select status, to_user_id from billing_group_transfers
       where subscription_id = ${groupId}`;
    expect(offer.status).toBe("pending");
    expect(offer.to_user_id).toBe(heir.id);
  });

  it("is best-effort: an email that returns false still commits the offer", async () => {
    const { payer, heir, groupId } = await seedLiveGroup();
    sendTransferOfferEmail.mockResolvedValueOnce(false);

    const res = await offerGroupTransfer({
      actorUserId: payer.id,
      subscriptionId: groupId,
      newOwnerUserId: heir.id,
    });
    expect(res.status).toBe("pending_card");
    const [offer] = await sql<{ status: string }[]>`
      select status from billing_group_transfers where subscription_id = ${groupId}`;
    expect(offer.status).toBe("pending");
  });
});
