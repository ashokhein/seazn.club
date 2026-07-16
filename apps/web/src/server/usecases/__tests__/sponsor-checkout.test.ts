// Sponsor monetization (v10 PROMPT-56): package CRUD gating, Connect
// checkout as a destination charge on the entry-fee rail, and replay-safe
// webhook activation. Stripe is stubbed at the getStripe() seam
// (registrations.test.ts pattern); real Postgres required.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const stripeMock = vi.hoisted(() => {
  const checkoutCreate = vi.fn();
  return {
    checkoutCreate,
    stripe: { checkout: { sessions: { create: checkoutCreate } } },
  };
});
vi.mock("@/lib/stripe", () => ({ getStripe: () => stripeMock.stripe }));

const emailMock = vi.hoisted(() => ({
  invoice: vi.fn().mockResolvedValue(true),
  receipt: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendSponsorInvoiceEmail: emailMock.invoice,
  sendSponsorReceiptEmail: emailMock.receipt,
}));

import type Stripe from "stripe";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import {
  createSponsorPackage,
  deactivateSponsorPackage,
  handleSponsorPaymentFailed,
  handleSponsorPaymentSucceeded,
  startSponsorCheckout,
  type SponsorPackageRow,
} from "../sponsors";

const HAS_DB = !!process.env.DATABASE_URL;

async function seedOrg(
  plan: "community" | "pro",
  connect = true,
): Promise<{ auth: AuthCtx; orgId: string }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, stripe_account_id, stripe_charges_enabled)
    values (${"Mon " + suffix}, ${"mon-" + suffix},
            ${connect ? "acct_" + suffix : null}, ${connect})
    returning id`;
  if (plan !== "community") {
    await sql`
      insert into subscriptions (org_id, plan_key, status)
      values (${orgId}, ${plan}, 'active')
      on conflict (org_id) do update set plan_key = ${plan}`;
  }
  await invalidateOrgEntitlements(orgId);
  return { auth: { orgId, via: "session", userId: null, role: "owner", keyId: null }, orgId };
}

function fakeIntent(orderId: string, packageId = "", orgId = ""): Stripe.PaymentIntent {
  return {
    id: `pi_${randomUUID().slice(0, 8)}`,
    metadata: { kind: "sponsor", order_id: orderId, package_id: packageId, org_id: orgId },
  } as unknown as Stripe.PaymentIntent;
}

beforeEach(() => {
  stripeMock.checkoutCreate.mockReset();
  emailMock.invoice.mockClear();
  emailMock.receipt.mockClear();
});

describe.skipIf(!HAS_DB)("sponsor monetization", () => {
  it("packages are Pro sponsors.monetize; deactivate is a soft flip", async () => {
    const { auth: free } = await seedOrg("community");
    await expect(
      createSponsorPackage(free, {
        name: "Gold", price_cents: 10_000, currency: "gbp", tier: "gold",
      }),
    ).rejects.toMatchObject({ status: 402 });

    const { auth: pro } = await seedOrg("pro");
    const pkg = await createSponsorPackage(pro, {
      name: "Gold", price_cents: 10_000, currency: "gbp", tier: "gold",
    });
    const retired = await deactivateSponsorPackage(pro, pkg.id);
    expect(retired.active).toBe(false);
  });

  it("refuses checkout when the org is not Connect-onboarded (409)", async () => {
    const { auth } = await seedOrg("pro", false);
    const pkg = await createSponsorPackage(auth, {
      name: "Silver", price_cents: 5_000, currency: "gbp", tier: "silver",
    });
    await expect(
      startSponsorCheckout(
        auth,
        { package_id: pkg.id, sponsor_name: "Acme", sponsor_email: "a@acme.test" },
        "https://app.test",
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(stripeMock.checkoutCreate).not.toHaveBeenCalled();
    // No half-started rail: the refusal happens before the order row exists.
    const orders = await sql<{ id: string }[]>`
      select id from sponsor_orders where org_id = ${auth.orgId}`;
    expect(orders).toHaveLength(0);
  });

  it("checkout: pending order first, destination charge with fee + metadata + idempotency", async () => {
    const { auth, orgId } = await seedOrg("pro");
    const pkg = await createSponsorPackage(auth, {
      name: "Title package", price_cents: 50_000, currency: "gbp", tier: "title",
    });

    let orderExistedAtCreate = false;
    stripeMock.checkoutCreate.mockImplementation(
      async (params: { metadata: { order_id: string } }) => {
        const rows = await sql<{ status: string }[]>`
          select status from sponsor_orders where id = ${params.metadata.order_id}`;
        orderExistedAtCreate = rows[0]?.status === "pending";
        return { id: "cs_test", url: "https://stripe.test/session" };
      },
    );

    const { order, checkout_url } = await startSponsorCheckout(
      auth,
      { package_id: pkg.id, sponsor_name: "Acme Corp", sponsor_email: "pay@acme.test" },
      "https://app.test",
    );
    expect(checkout_url).toBe("https://stripe.test/session");
    expect(order.status).toBe("pending");
    expect(orderExistedAtCreate).toBe(true); // row inserted BEFORE the Stripe call

    const [params, opts] = stripeMock.checkoutCreate.mock.calls[0]!;
    expect(opts).toEqual({ idempotencyKey: `sponsor-order-${order.id}` });
    expect(params.metadata).toMatchObject({ kind: "sponsor", order_id: order.id, org_id: orgId });
    expect(params.line_items[0].price_data.unit_amount).toBe(50_000);
    expect(params.payment_intent_data).toMatchObject({
      // Pro entry-fee percent is 2 → 2% of 50000.
      application_fee_amount: 1000,
      transfer_data: { destination: expect.stringMatching(/^acct_/) },
      metadata: { kind: "sponsor", order_id: order.id, package_id: pkg.id, org_id: orgId },
    });

    expect(emailMock.invoice).toHaveBeenCalledOnce();
    expect(emailMock.invoice.mock.calls[0]![0]).toMatchObject({
      to: "pay@acme.test",
      checkoutUrl: "https://stripe.test/session",
      amountCents: 50_000,
    });
  });

  it("webhook: paid activates exactly once under replay; failed flips pending only", async () => {
    const { auth, orgId } = await seedOrg("pro");
    stripeMock.checkoutCreate.mockResolvedValue({ id: "cs_x", url: "https://stripe.test/s" });
    const pkg = await createSponsorPackage(auth, {
      name: "Gold package", price_cents: 20_000, currency: "gbp", tier: "gold",
    });
    const { order } = await startSponsorCheckout(
      auth,
      { package_id: pkg.id, sponsor_name: "Bolt Ltd", sponsor_email: "b@bolt.test" },
      "https://app.test",
    );

    const intent = fakeIntent(order.id, pkg.id, orgId);
    await handleSponsorPaymentSucceeded(intent);
    await handleSponsorPaymentSucceeded(intent); // /admin/billing-events replay

    const sponsors = await sql<{ id: string; tier: string; status: string }[]>`
      select id, tier, status from sponsors where org_id = ${orgId} and name = 'Bolt Ltd'`;
    expect(sponsors).toHaveLength(1); // no double activation
    expect(sponsors[0]).toMatchObject({ tier: "gold", status: "active" });

    const [paid] = await sql<{ status: string; sponsor_id: string | null; payment_intent_id: string }[]>`
      select status, sponsor_id, payment_intent_id from sponsor_orders where id = ${order.id}`;
    expect(paid).toMatchObject({
      status: "paid",
      sponsor_id: sponsors[0]!.id,
      payment_intent_id: intent.id,
    });
    expect(emailMock.receipt).toHaveBeenCalledOnce();

    // A late failure event never clobbers the paid order.
    await handleSponsorPaymentFailed(intent);
    const [still] = await sql<{ status: string }[]>`
      select status from sponsor_orders where id = ${order.id}`;
    expect(still.status).toBe("paid");
  });

  it("webhook: pending order fails on payment_failed; stray intents are ignored", async () => {
    const { auth, orgId } = await seedOrg("pro");
    stripeMock.checkoutCreate.mockResolvedValue({ id: "cs_y", url: "https://stripe.test/s" });
    const pkg = await createSponsorPackage(auth, {
      name: "Partner package", price_cents: 3_000, currency: "gbp", tier: "partner",
    });
    const { order } = await startSponsorCheckout(
      auth,
      { package_id: pkg.id, sponsor_name: "Slow Pay", sponsor_email: "s@slow.test" },
      "https://app.test",
    );

    await handleSponsorPaymentFailed(fakeIntent(order.id));
    const [failed] = await sql<{ status: string }[]>`
      select status from sponsor_orders where id = ${order.id}`;
    expect(failed.status).toBe("failed");

    // Non-sponsor intent (registration entry fee): both handlers no-op.
    const stray = {
      id: "pi_stray",
      metadata: { registration_id: randomUUID(), org_id: orgId },
    } as unknown as Stripe.PaymentIntent;
    await expect(handleSponsorPaymentSucceeded(stray)).resolves.toBeUndefined();
    await expect(handleSponsorPaymentFailed(stray)).resolves.toBeUndefined();
    const sponsors = await sql<{ id: string }[]>`
      select id from sponsors where org_id = ${orgId}`;
    expect(sponsors).toHaveLength(0);
    expect(emailMock.receipt).not.toHaveBeenCalled();
  });
});

afterAll(async () => {
  if (!HAS_DB) return;
  await sql.end();
});
