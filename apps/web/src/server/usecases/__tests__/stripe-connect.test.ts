// ToS gate on Stripe Connect onboarding (PROMPT-55): the Express account is
// only created after the owner accepts the entry-fee chargeback terms; the
// acceptance timestamp is recorded on the Stripe account metadata. Real
// Postgres required; skipped without DATABASE_URL.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const stripeMock = vi.hoisted(() => {
  const accountCreate = vi.fn();
  const accountLinkCreate = vi.fn();
  return {
    accountCreate,
    accountLinkCreate,
    stripe: {
      accounts: { create: accountCreate },
      accountLinks: { create: accountLinkCreate },
    },
  };
});

vi.mock("@/lib/stripe", () => ({ getStripe: () => stripeMock.stripe }));

import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createConnectOnboardingLink } from "../stripe-connect";

const HAS_DB = !!process.env.DATABASE_URL;

async function seedProOrg(): Promise<{ owner: AuthCtx; orgId: string }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: ownerId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name)
    values (${`owner-${suffix}@test.local`}, 'owner') returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Connect Org " + suffix}, ${"cn-org-" + suffix}, ${ownerId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${ownerId}, 'owner')`;
  await sql`insert into subscriptions (org_id, plan_key, status)
            values (${orgId}, 'pro', 'active')
            on conflict (org_id) do update set plan_key = 'pro', status = 'active'`;
  return { owner: { orgId, via: "session", userId: ownerId, role: "owner", keyId: null }, orgId };
}

beforeEach(() => {
  stripeMock.accountCreate
    .mockReset()
    .mockImplementation(async () => ({ id: "acct_test_" + randomUUID().slice(0, 8) }));
  stripeMock.accountLinkCreate
    .mockReset()
    .mockResolvedValue({ url: "https://connect.stripe.test/onboard" });
});

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("Connect onboarding ToS gate (PROMPT-55)", () => {
  it("first connect without agreement → 422, no Stripe account created", async () => {
    const { owner, orgId } = await seedProOrg();
    await expect(
      createConnectOnboardingLink(owner, orgId, "http://test.local", "/settings/connect"),
    ).rejects.toMatchObject({ status: 422 });
    expect(stripeMock.accountCreate).not.toHaveBeenCalled();
    const [org] = await sql<{ stripe_account_id: string | null }[]>`
      select stripe_account_id from organizations where id = ${orgId}`;
    expect(org.stripe_account_id).toBeNull();
  });

  it("agreement creates the account with the acceptance stamped in metadata", async () => {
    const { owner, orgId } = await seedProOrg();
    const { url } = await createConnectOnboardingLink(
      owner, orgId, "http://test.local", "/settings/connect", true,
    );
    expect(url).toBe("https://connect.stripe.test/onboard");
    expect(stripeMock.accountCreate).toHaveBeenCalledTimes(1);
    const args = stripeMock.accountCreate.mock.calls[0][0] as {
      metadata: { org_id: string; tos_agreed_at: string };
    };
    expect(args.metadata.org_id).toBe(orgId);
    expect(new Date(args.metadata.tos_agreed_at).getTime()).not.toBeNaN();
    const [org] = await sql<{ stripe_account_id: string | null }[]>`
      select stripe_account_id from organizations where id = ${orgId}`;
    expect(org.stripe_account_id).not.toBeNull();
  });

  it("resuming onboarding on an existing account does not re-ask", async () => {
    const { owner, orgId } = await seedProOrg();
    await sql`update organizations set stripe_account_id = ${"acct_prior_" + orgId.slice(0, 8)}
              where id = ${orgId}`;
    const { url } = await createConnectOnboardingLink(
      owner, orgId, "http://test.local", "/settings/connect",
    );
    expect(url).toBe("https://connect.stripe.test/onboard");
    expect(stripeMock.accountCreate).not.toHaveBeenCalled();
  });
});
