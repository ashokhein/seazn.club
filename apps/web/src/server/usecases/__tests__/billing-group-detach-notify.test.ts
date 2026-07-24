// Detach notifications: the party that did NOT initiate the removal is emailed.
//  - the payer pushes an org out  -> the departing org's OWNER is told (what
//    happened to the plan, and that they now own its billing);
//  - the org's own owner leaves    -> the PAYER is told their bill changed.
// When the actor owns both the org and the group there is no one else to tell.
// Both sends are best-effort: a throw cannot roll back a completed detach.
process.env.STRIPE_SECRET_KEY ??= "sk_test_fixture_never_real";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// Mock the email module so nothing sends and we can spy on every path. All four
// billing-group senders are provided: billing-groups.ts imports the transfer
// pair too, and an unmocked import would be undefined.
const {
  sendGroupOrgRemovedEmail,
  sendGroupOrgLeftEmail,
  sendTransferOfferEmail,
  sendTransferCompleteEmail,
} = vi.hoisted(() => ({
  sendGroupOrgRemovedEmail: vi.fn<
    (to: string, payerName: string, orgName: string, ridesOutUntil: string | null, link: string, locale?: string) => Promise<boolean>
  >(async () => true),
  sendGroupOrgLeftEmail: vi.fn<
    (to: string, orgName: string, seatFreed: boolean, link: string, locale?: string) => Promise<boolean>
  >(async () => true),
  sendTransferOfferEmail: vi.fn(async () => true),
  sendTransferCompleteEmail: vi.fn(async () => true),
}));
vi.mock("@/lib/email", () => ({
  sendGroupOrgRemovedEmail,
  sendGroupOrgLeftEmail,
  sendTransferOfferEmail,
  sendTransferCompleteEmail,
}));

import { sql } from "@/lib/db";
import { detachOrgFromGroup } from "@/server/usecases/billing-groups";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

async function makeUser(name: string): Promise<{ id: string; email: string }> {
  const email = `dnu-${uniq()}@test.local`;
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${email}, ${name}, true) returning id`;
  return { id, email };
}

/** A paying pro group (status active, a paid-through period) but NO live Stripe
 *  subscription — so syncGroupQuantity returns before any Stripe call and the
 *  test needs no fixture. The payer owns the primary org; a SECOND org is owned
 *  by someone else, so detaching it is a genuine cross-party removal. */
async function seedLiveGroup() {
  const payer = await makeUser("Dana Payer");
  const owner = await makeUser("Ola Owner");
  const [{ id: groupId }] = await sql<{ id: string }[]>`
    insert into subscriptions
      (owner_user_id, plan_key, status, quantity_paid, current_period_end, status_changed_at)
    values (${payer.id}, 'pro', 'active', 2, now() + interval '20 days', now())
    returning id`;
  const s1 = uniq();
  const [{ id: primaryId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by, subscription_id, created_at)
    values (${`Primary ${s1}`}, ${`primary-${s1}`}, ${payer.id}, ${groupId}, now() - interval '1 hour')
    returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${primaryId}, ${payer.id}, 'owner')`;
  const s2 = uniq();
  const orgName = `Northside ${s2}`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by, subscription_id, created_at)
    values (${orgName}, ${`northside-${s2}`}, ${owner.id}, ${groupId}, now())
    returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${owner.id}, 'owner')`;
  return { payer, owner, groupId, orgId, primaryId, orgName };
}

beforeEach(() => {
  for (const m of [
    sendGroupOrgRemovedEmail,
    sendGroupOrgLeftEmail,
    sendTransferOfferEmail,
    sendTransferCompleteEmail,
  ]) {
    m.mockReset();
    m.mockResolvedValue(true);
  }
});
afterAll(async () => {
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("detach notifies the non-acting party", () => {
  it("payer pushes an org out -> the departing org owner is emailed", async () => {
    const { payer, owner, orgId, orgName } = await seedLiveGroup();

    await detachOrgFromGroup({ actorUserId: payer.id, orgId, mode: "ride_out" });

    expect(sendGroupOrgRemovedEmail).toHaveBeenCalledTimes(1);
    const [to, payerName, on, ridesOutUntil] = sendGroupOrgRemovedEmail.mock.calls[0];
    expect(to).toBe(owner.email);
    expect(payerName).toBe("Dana Payer");
    expect(on).toBe(orgName);
    // ride_out on a paying group -> it keeps its plan to the period end.
    expect(ridesOutUntil).toBeTruthy();
    expect(sendGroupOrgLeftEmail).not.toHaveBeenCalled();
  });

  it("the org owner leaves -> the payer is emailed, not the owner", async () => {
    const { payer, owner, orgId } = await seedLiveGroup();

    await detachOrgFromGroup({ actorUserId: owner.id, orgId, mode: "ride_out" });

    expect(sendGroupOrgLeftEmail).toHaveBeenCalledTimes(1);
    const [to] = sendGroupOrgLeftEmail.mock.calls[0];
    expect(to).toBe(payer.email);
    expect(sendGroupOrgRemovedEmail).not.toHaveBeenCalled();
  });

  it("release tells the payer the seat is freed (reusable)", async () => {
    const { owner, orgId } = await seedLiveGroup();

    await detachOrgFromGroup({ actorUserId: owner.id, orgId, mode: "release" });

    expect(sendGroupOrgLeftEmail).toHaveBeenCalledTimes(1);
    const [, , seatFreed] = sendGroupOrgLeftEmail.mock.calls[0];
    expect(seatFreed).toBe(true);
  });

  it("no email when the actor owns both the org and the group", async () => {
    const { payer, primaryId } = await seedLiveGroup();

    // Payer removes their OWN primary org; the group still has the other org, so
    // this is a valid detach and the actor is both parties — nobody to tell.
    await detachOrgFromGroup({ actorUserId: payer.id, orgId: primaryId });

    expect(sendGroupOrgRemovedEmail).not.toHaveBeenCalled();
    expect(sendGroupOrgLeftEmail).not.toHaveBeenCalled();
  });

  it("best-effort: a notification throw does not roll back the detach", async () => {
    const { payer, orgId } = await seedLiveGroup();
    sendGroupOrgRemovedEmail.mockRejectedValueOnce(new Error("resend down"));

    const res = await detachOrgFromGroup({ actorUserId: payer.id, orgId });

    // The org still moved to a new group of its own.
    expect(res.subscription_id).toBeTruthy();
    const [o] = await sql<{ subscription_id: string }[]>`
      select subscription_id from organizations where id = ${orgId}`;
    expect(o.subscription_id).toBe(res.subscription_id);
  });
});
