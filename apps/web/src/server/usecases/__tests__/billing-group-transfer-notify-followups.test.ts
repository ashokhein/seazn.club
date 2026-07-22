// Follow-ups to the billing-group transfer notifications (PR #227):
//
//  1. The offer email link must target an org the RECIPIENT can actually reach —
//     an org IN THE GROUP they are a member of — not the group's oldest org,
//     which they may not be able to open.
//  2. The COMMUNITY (immediate) handover path must also email the recipient, with
//     a DIFFERENT, informational message ("you now pay for this group"). It must
//     be best-effort: a throw cannot fail the transfer.
//
// Own fixture port (12119) so it never contends with the other transfer suites.
process.env.STRIPE_SECRET_KEY ??= "sk_test_fixture_never_real";
process.env.STRIPE_MOCK_HOST = "127.0.0.1";
process.env.STRIPE_MOCK_PORT = "12119";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// Mock the email module so no real send happens and we can spy/steer BOTH sends.
const { sendTransferOfferEmail, sendTransferCompleteEmail } = vi.hoisted(() => ({
  sendTransferOfferEmail: vi.fn<
    (to: string, payerName: string, groupName: string, link: string, locale?: string) => Promise<boolean>
  >(async () => true),
  sendTransferCompleteEmail: vi.fn<
    (to: string, payerName: string, groupName: string, link: string, locale?: string) => Promise<boolean>
  >(async () => true),
}));
vi.mock("@/lib/email", () => ({ sendTransferOfferEmail, sendTransferCompleteEmail }));

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
  const email = `fnu-${uniq()}@test.local`;
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${email}, ${name}, true) returning id`;
  return { id, email };
}

/** A live pro group with TWO orgs: the OLDEST (primary) org owned by the payer,
 *  and a NEWER org the recipient is a member of. The recipient-reachable link
 *  must pick the newer, recipient-owned org — proving it is not just "oldest". */
async function seedLiveGroupTwoOrgs() {
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

  // Primary / oldest org — recipient is NOT a member of it.
  const s1 = uniq();
  const primarySlug = `primary-${s1}`;
  await sql`
    insert into organizations (name, slug, created_by, subscription_id, created_at)
    values (${`Primary ${s1}`}, ${primarySlug}, ${payer.id}, ${groupId}, now() - interval '1 hour')`;

  // Newer org the recipient owns.
  const s2 = uniq();
  const recipSlug = `recip-${s2}`;
  const [{ id: recipOrg }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by, subscription_id, created_at)
    values (${`Recip ${s2}`}, ${recipSlug}, ${heir.id}, ${groupId}, now())
    returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${recipOrg}, ${heir.id}, 'owner')`;

  return { payer, heir, groupId, primarySlug, recipSlug };
}

/** A COMMUNITY group (no live Stripe subscription) the payer owns, with one org
 *  the recipient owns — the immediate-handover path requires the recipient to
 *  already own an org in the group. */
async function seedCommunityGroup() {
  const payer = await makeUser("Dana Payer");
  const heir = await makeUser("Rae Heir");
  const [{ id: groupId }] = await sql<{ id: string }[]>`
    insert into subscriptions (owner_user_id, plan_key, status, quantity_paid, status_changed_at)
    values (${payer.id}, 'community', 'active', 1, now())
    returning id`;
  const s = uniq();
  const slug = `community-${s}`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by, subscription_id)
    values (${`Community ${s}`}, ${slug}, ${heir.id}, ${groupId})
    returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${heir.id}, 'owner')`;
  return { payer, heir, groupId, slug };
}

beforeAll(async () => {
  if (!HAS_DB) return;
  fixture = await startStripeFixtureServer(12119);
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
  sendTransferCompleteEmail.mockReset();
  sendTransferCompleteEmail.mockResolvedValue(true);
});

describe.skipIf(!HAS_DB)("Follow-up 1: offer email link targets a recipient-reachable org", () => {
  it("uses the slug of an org the recipient is a member of, not the group's oldest org", async () => {
    const { payer, heir, groupId, primarySlug, recipSlug } = await seedLiveGroupTwoOrgs();

    const res = await offerGroupTransfer({
      actorUserId: payer.id,
      subscriptionId: groupId,
      newOwnerUserId: heir.id,
    });
    expect(res.status).toBe("pending_card");

    expect(sendTransferOfferEmail).toHaveBeenCalledTimes(1);
    const [to, , , link] = sendTransferOfferEmail.mock.calls[0];
    expect(to).toBe(heir.email);
    expect(link).toContain(`/o/${recipSlug}/settings/billing`);
    expect(link).not.toContain(primarySlug);
  });
});

describe.skipIf(!HAS_DB)("Follow-up 2: community handover emails the recipient", () => {
  it("sends the transfer-complete email to the recipient after an immediate handover", async () => {
    const { payer, heir, groupId, slug } = await seedCommunityGroup();

    const res = await offerGroupTransfer({
      actorUserId: payer.id,
      subscriptionId: groupId,
      newOwnerUserId: heir.id,
    });
    expect(res.status).toBe("transferred");
    expect(res.owner_user_id).toBe(heir.id);

    // Informational email, not the offer email.
    expect(sendTransferOfferEmail).not.toHaveBeenCalled();
    expect(sendTransferCompleteEmail).toHaveBeenCalledTimes(1);
    const [to, payerName, , link] = sendTransferCompleteEmail.mock.calls[0];
    expect(to).toBe(heir.email);
    expect(payerName).toBe("Dana Payer");
    expect(link).toContain(`/o/${slug}/settings/billing`);
  });

  it("is best-effort: an email that throws does not roll back the completed transfer", async () => {
    const { payer, heir, groupId } = await seedCommunityGroup();
    sendTransferCompleteEmail.mockRejectedValueOnce(new Error("resend down"));

    const res = await offerGroupTransfer({
      actorUserId: payer.id,
      subscriptionId: groupId,
      newOwnerUserId: heir.id,
    });
    expect(res.status).toBe("transferred");

    // Ownership actually moved despite the email failure.
    const [group] = await sql<{ owner_user_id: string }[]>`
      select owner_user_id from subscriptions where id = ${groupId}`;
    expect(group.owner_user_id).toBe(heir.id);
  });
});
