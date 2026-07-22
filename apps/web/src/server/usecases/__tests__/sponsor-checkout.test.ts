// Sponsor monetization (v10 PROMPT-56): package CRUD gating, Connect
// checkout as a destination charge on the entry-fee rail, and replay-safe
// webhook activation. Stripe is stubbed at the getStripe() seam
// (registrations.test.ts pattern); real Postgres required.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const stripeMock = vi.hoisted(() => {
  const checkoutCreate = vi.fn();
  const refundCreate = vi.fn();
  return {
    checkoutCreate,
    refundCreate,
    stripe: {
      checkout: { sessions: { create: checkoutCreate } },
      refunds: { create: refundCreate },
    },
  };
});
vi.mock("@/lib/stripe", () => ({ getStripe: () => stripeMock.stripe }));

const emailMock = vi.hoisted(() => ({
  invoice: vi.fn().mockResolvedValue(true),
  receipt: vi.fn().mockResolvedValue(true),
  refund: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendSponsorInvoiceEmail: emailMock.invoice,
  sendSponsorReceiptEmail: emailMock.receipt,
  sendSponsorRefundEmail: emailMock.refund,
}));

import type Stripe from "stripe";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import {
  createSponsorPackage,
  deactivateSponsorPackage,
  handleSponsorChargeRefunded,
  handleSponsorPaymentFailed,
  handleSponsorPaymentSucceeded,
  listSponsorRows,
  refundSponsorOrder,
  startSponsorCheckout,
  type SponsorPackageRow,
} from "../sponsors";

import { setOrgPlan } from "@/lib/__tests__/_billing-group";
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
    await setOrgPlan(orgId, plan);
  }
  await invalidateOrgEntitlements(orgId);
  return {
    auth: { orgId, via: "session", userId: null, role: "owner", keyId: null },
    orgId,
  };
}

function fakeIntent(orderId: string, packageId = "", orgId = ""): Stripe.PaymentIntent {
  return {
    id: `pi_${randomUUID().slice(0, 8)}`,
    metadata: {
      kind: "sponsor",
      order_id: orderId,
      package_id: packageId,
      org_id: orgId,
    },
  } as unknown as Stripe.PaymentIntent;
}

beforeEach(() => {
  stripeMock.checkoutCreate.mockReset();
  stripeMock.refundCreate.mockReset().mockResolvedValue({ id: "re_test" });
  emailMock.invoice.mockClear();
  emailMock.receipt.mockClear();
  emailMock.refund.mockClear();
});

describe.skipIf(!HAS_DB)("sponsor monetization", () => {
  it("packages are Pro sponsors.monetize; deactivate is a soft flip", async () => {
    const { auth: free } = await seedOrg("community");
    await expect(
      createSponsorPackage(free, {
        name: "Gold",
        price_cents: 10_000,
        currency: "gbp",
        tier: "gold",
      }),
    ).rejects.toMatchObject({ status: 402 });

    const { auth: pro } = await seedOrg("pro");
    const pkg = await createSponsorPackage(pro, {
      name: "Gold",
      price_cents: 10_000,
      currency: "gbp",
      tier: "gold",
    });
    const retired = await deactivateSponsorPackage(pro, pkg.id);
    expect(retired.active).toBe(false);
  });

  it("refuses checkout when the org is not Connect-onboarded (409)", async () => {
    const { auth } = await seedOrg("pro", false);
    const pkg = await createSponsorPackage(auth, {
      name: "Silver",
      price_cents: 5_000,
      currency: "gbp",
      tier: "silver",
    });
    await expect(
      startSponsorCheckout(
        auth,
        {
          package_id: pkg.id,
          sponsor_name: "Acme",
          sponsor_email: "a@acme.test",
        },
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
      name: "Title package",
      price_cents: 50_000,
      currency: "gbp",
      tier: "title",
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
      {
        package_id: pkg.id,
        sponsor_name: "Acme Corp",
        sponsor_email: "pay@acme.test",
      },
      "https://app.test",
    );
    expect(checkout_url).toBe("https://stripe.test/session");
    expect(order.status).toBe("pending");
    expect(orderExistedAtCreate).toBe(true); // row inserted BEFORE the Stripe call

    const [params, opts] = stripeMock.checkoutCreate.mock.calls[0]!;
    expect(opts).toEqual({ idempotencyKey: `sponsor-order-${order.id}` });
    expect(params.metadata).toMatchObject({
      kind: "sponsor",
      order_id: order.id,
      org_id: orgId,
    });
    expect(params.line_items[0].price_data.unit_amount).toBe(50_000);
    expect(params.payment_intent_data).toMatchObject({
      // Pro entry-fee percent is 2 → 2% of 50000.
      application_fee_amount: 1000,
      transfer_data: { destination: expect.stringMatching(/^acct_/) },
      metadata: {
        kind: "sponsor",
        order_id: order.id,
        package_id: pkg.id,
        org_id: orgId,
      },
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
    stripeMock.checkoutCreate.mockResolvedValue({
      id: "cs_x",
      url: "https://stripe.test/s",
    });
    const pkg = await createSponsorPackage(auth, {
      name: "Gold package",
      price_cents: 20_000,
      currency: "gbp",
      tier: "gold",
    });
    const { order } = await startSponsorCheckout(
      auth,
      {
        package_id: pkg.id,
        sponsor_name: "Bolt Ltd",
        sponsor_email: "b@bolt.test",
      },
      "https://app.test",
    );

    const intent = fakeIntent(order.id, pkg.id, orgId);
    await handleSponsorPaymentSucceeded(intent);
    await handleSponsorPaymentSucceeded(intent); // /admin/billing-events replay

    const sponsors = await sql<{ id: string; tier: string; status: string }[]>`
      select id, tier, status from sponsors where org_id = ${orgId} and name = 'Bolt Ltd'`;
    expect(sponsors).toHaveLength(1); // no double activation
    expect(sponsors[0]).toMatchObject({ tier: "gold", status: "active" });

    const [paid] = await sql<
      { status: string; sponsor_id: string | null; payment_intent_id: string }[]
    >`
      select status, sponsor_id, payment_intent_id from sponsor_orders where id = ${order.id}`;
    expect(paid).toMatchObject({
      status: "paid",
      sponsor_id: sponsors[0]!.id,
      payment_intent_id: intent.id,
    });
    expect(emailMock.receipt).toHaveBeenCalledOnce();
    // The "See it live" link must be absolute — mail clients have no origin
    // to resolve "/shared/…" against (stg regression: NEXT_PUBLIC_APP_URL was
    // never set anywhere, so every receipt shipped a relative link).
    expect(emailMock.receipt.mock.calls[0]![0]).toMatchObject({
      publicUrl: expect.stringMatching(/^https?:\/\/.+\/shared\//),
    });

    // A late failure event never clobbers the paid order.
    await handleSponsorPaymentFailed(intent);
    const [still] = await sql<{ status: string }[]>`
      select status from sponsor_orders where id = ${order.id}`;
    expect(still.status).toBe("paid");

    // The manager list ties the bought placement back to its order.
    const listed = await listSponsorRows(orgId);
    expect(listed.find((s) => s.name === "Bolt Ltd")?.paid_order_id).toBe(order.id);

    // charge.refunded (dashboard refund): order → refunded, placement off
    // the public pages; a replay is a no-op.
    const charge = {
      id: "ch_refund",
      payment_intent: intent.id,
      refunded: true,
    } as unknown as Stripe.Charge;
    await handleSponsorChargeRefunded(charge);
    await handleSponsorChargeRefunded(charge);
    const [refunded] = await sql<{ status: string }[]>`
      select status from sponsor_orders where id = ${order.id}`;
    expect(refunded.status).toBe("refunded");
    const [inactive] = await sql<{ status: string }[]>`
      select status from sponsors where id = ${sponsors[0]!.id}`;
    expect(inactive.status).toBe("inactive");

    // A stray non-sponsor refunded charge touches nothing.
    await expect(
      handleSponsorChargeRefunded({
        id: "ch_stray",
        payment_intent: "pi_not_ours",
        refunded: true,
      } as unknown as Stripe.Charge),
    ).resolves.toBeUndefined();
  });

  it("console refund: entry-fee shape, order → refunded, placement deactivated", async () => {
    const { auth, orgId } = await seedOrg("pro");
    stripeMock.checkoutCreate.mockResolvedValue({
      id: "cs_r",
      url: "https://stripe.test/s",
    });
    const pkg = await createSponsorPackage(auth, {
      name: "Silver package",
      price_cents: 8_000,
      currency: "gbp",
      tier: "silver",
    });
    const { order } = await startSponsorCheckout(
      auth,
      {
        package_id: pkg.id,
        sponsor_name: "Refundable Ltd",
        sponsor_email: "r@ref.test",
      },
      "https://app.test",
    );
    // Refunding an unpaid order is refused before Stripe is touched.
    await expect(refundSponsorOrder(auth, order.id)).rejects.toMatchObject({
      status: 422,
    });
    expect(stripeMock.refundCreate).not.toHaveBeenCalled();

    await handleSponsorPaymentSucceeded(fakeIntent(order.id, pkg.id, orgId));
    const refunded = await refundSponsorOrder(auth, order.id);
    expect(refunded.status).toBe("refunded");

    const [params, opts] = stripeMock.refundCreate.mock.calls[0]!;
    expect(params).toMatchObject({
      reverse_transfer: true,
      refund_application_fee: true,
    });
    expect(params.payment_intent).toMatch(/^pi_/);
    expect(opts).toEqual({ idempotencyKey: `sponsor-refund-${order.id}` });

    const [sponsor] = await sql<{ status: string }[]>`
      select status from sponsors where org_id = ${orgId} and name = 'Refundable Ltd'`;
    expect(sponsor.status).toBe("inactive");

    // The sponsor hears about it — once (the later Stripe event replay
    // finds the order already refunded and stays silent).
    expect(emailMock.refund).toHaveBeenCalledOnce();
    expect(emailMock.refund.mock.calls[0]![0]).toMatchObject({
      to: "r@ref.test",
      amountCents: 8_000,
      packageName: "Silver package",
    });
  });

  it("webhook: pending order fails on payment_failed; stray intents are ignored", async () => {
    const { auth, orgId } = await seedOrg("pro");
    stripeMock.checkoutCreate.mockResolvedValue({
      id: "cs_y",
      url: "https://stripe.test/s",
    });
    const pkg = await createSponsorPackage(auth, {
      name: "Partner package",
      price_cents: 3_000,
      currency: "gbp",
      tier: "partner",
    });
    const { order } = await startSponsorCheckout(
      auth,
      {
        package_id: pkg.id,
        sponsor_name: "Slow Pay",
        sponsor_email: "s@slow.test",
      },
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
