// ToS gate on Stripe Connect onboarding (PROMPT-55): the Express account is
// only created after the owner accepts the entry-fee chargeback terms; the
// acceptance timestamp is recorded on the Stripe account metadata. Real
// Postgres required; skipped without DATABASE_URL.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const stripeMock = vi.hoisted(() => {
  const accountCreate = vi.fn();
  const accountLinkCreate = vi.fn();
  const loginLinkCreate = vi.fn();
  return {
    accountCreate,
    accountLinkCreate,
    loginLinkCreate,
    stripe: {
      accounts: { create: accountCreate, createLoginLink: loginLinkCreate },
      accountLinks: { create: accountLinkCreate },
    },
  };
});

vi.mock("@/lib/stripe", () => ({ getStripe: () => stripeMock.stripe }));

import type Stripe from "stripe";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import {
  connectStatus,
  createConnectDashboardLink,
  createConnectOnboardingLink,
  syncConnectAccount,
} from "../stripe-connect";

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
  stripeMock.loginLinkCreate
    .mockReset()
    .mockResolvedValue({ url: "https://connect.stripe.test/express-dash" });
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

describe.skipIf(!HAS_DB)("Express dashboard login link", () => {
  it("connected org gets a fresh login link for its account", async () => {
    const { owner, orgId } = await seedProOrg();
    const acctId = "acct_dash_" + orgId.slice(0, 8);
    await sql`update organizations set stripe_account_id = ${acctId} where id = ${orgId}`;
    const { url } = await createConnectDashboardLink(owner, orgId);
    expect(url).toBe("https://connect.stripe.test/express-dash");
    expect(stripeMock.loginLinkCreate).toHaveBeenCalledWith(acctId);
  });

  it("no Connect account → 409 before Stripe is touched", async () => {
    const { owner, orgId } = await seedProOrg();
    await expect(createConnectDashboardLink(owner, orgId)).rejects.toMatchObject({
      status: 409,
    });
    expect(stripeMock.loginLinkCreate).not.toHaveBeenCalled();
  });

  it("non-owner → 403", async () => {
    const { orgId } = await seedProOrg();
    await sql`update organizations set stripe_account_id = ${"acct_x_" + orgId.slice(0, 8)}
              where id = ${orgId}`;
    const scorer: AuthCtx = {
      orgId, via: "session", userId: randomUUID(), role: "scorer", keyId: null,
    };
    await expect(createConnectDashboardLink(scorer, orgId)).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe.skipIf(!HAS_DB)("Connect health mirror (P1-8)", () => {
  it("syncConnectAccount mirrors payouts/disabled-reason/requirements onto the org row", async () => {
    const { owner, orgId } = await seedProOrg();
    const acctId = "acct_health_" + orgId.slice(0, 8);
    await sql`update organizations set stripe_account_id = ${acctId} where id = ${orgId}`;

    const account = {
      id: acctId,
      charges_enabled: true,
      payouts_enabled: false,
      requirements: {
        currently_due: ["individual.id_number"],
        disabled_reason: "requirements.pending_verification",
      },
    } as unknown as Stripe.Account;
    await syncConnectAccount(account);

    const [org] = await sql<{
      stripe_charges_enabled: boolean;
      stripe_payouts_enabled: boolean;
      stripe_disabled_reason: string | null;
      stripe_requirements_due: number;
    }[]>`
      select stripe_charges_enabled, stripe_payouts_enabled,
             stripe_disabled_reason, stripe_requirements_due
      from organizations where id = ${orgId}`;
    expect(org.stripe_charges_enabled).toBe(true);
    expect(org.stripe_payouts_enabled).toBe(false);
    expect(org.stripe_disabled_reason).toBe("requirements.pending_verification");
    expect(org.stripe_requirements_due).toBe(1);

    const status = await connectStatus(owner, orgId);
    expect(status.connected).toBe(true);
    expect(status.charges_enabled).toBe(true);
    expect(status.payouts_enabled).toBe(false);
    expect(status.disabled_reason).toBe("requirements.pending_verification");
    expect(status.requirements_due).toBe(1);
  });
});
