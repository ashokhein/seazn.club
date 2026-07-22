// Task 6C — staff-only removal of an org's default card. Mocked Stripe, real
// Postgres so has_payment_method and staff_audit_log land for real. The
// customer-facing removePaymentMethod's default-card refusal is exercised
// here too, as the regression this branch must never re-open: staff getting
// a new escape hatch must not loosen the guard the product deliberately kept
// for customers.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const stripeMock = vi.hoisted(() => ({
  retrieveCustomer: vi.fn(),
  listPaymentMethods: vi.fn(),
  retrievePaymentMethod: vi.fn(),
  detachPaymentMethod: vi.fn(),
}));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({
    customers: {
      retrieve: stripeMock.retrieveCustomer,
      listPaymentMethods: stripeMock.listPaymentMethods,
    },
    paymentMethods: {
      retrieve: stripeMock.retrievePaymentMethod,
      detach: stripeMock.detachPaymentMethod,
    },
  }),
}));
vi.mock("@/lib/auth", () => ({
  getActiveOrgId: vi.fn(),
  requireOrgRole: vi.fn(),
  requireUser: vi.fn(),
}));
vi.mock("@/lib/posthog-server", () => ({ captureServer: vi.fn() }));
vi.mock("@/lib/entitlements", () => ({ invalidateOrgEntitlements: vi.fn() }));

import { sql } from "@/lib/db";
import { removePaymentMethod, staffRemovePaymentMethod } from "@/server/usecases/billing-manage";

const HAS_DB = !!process.env.DATABASE_URL;

async function seedOrg(
  opts: { hasFlag?: boolean } = {},
): Promise<{ orgId: string; actorId: string; customerId: string }> {
  const s = randomUUID().slice(0, 8);
  // The group's payer (subscriptions.owner_user_id) — carried here by
  // organizations.created_by so the group can be seeded from the org.
  const [{ id: payerId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name)
    values (${"payer6c-" + s + "@test.local"}, 'Payer') returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"PM6C " + s}, ${"pm6c-" + s}, ${payerId}) returning id`;
  const customerId = `cus_pm6c_${s}`;
  await sql`
    with s as (
      insert into subscriptions
        (owner_user_id, plan_key, status, stripe_customer_id, stripe_subscription_id,
         has_payment_method)
      select o.created_by, 'pro', 'active', ${customerId}, ${"sub_" + s}, ${opts.hasFlag ?? true}
        from organizations o where o.id = ${orgId}
      returning id
    )
    update organizations o set subscription_id = s.id from s where o.id = ${orgId}`;
  const [{ id: actorId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, is_staff, staff_role)
    values (${"staff6c-" + s + "@test.local"}, 'Staff', true, 'support') returning id`;
  return { orgId, actorId, customerId };
}

async function flagOf(orgId: string): Promise<boolean | null> {
  const [row] = await sql<{ has_payment_method: boolean }[]>`
    select has_payment_method from subscriptions where id = (select subscription_id from organizations where id = ${orgId})`;
  return row ? row.has_payment_method : null;
}

/** Point the mocked Stripe customer at N cards on file (post-detach state). */
function stripeHasCards(customerId: string, count: number) {
  stripeMock.retrieveCustomer.mockResolvedValue({
    id: customerId,
    deleted: false,
    invoice_settings: {
      default_payment_method: count > 0 ? "pm_default" : null,
    },
  });
  stripeMock.listPaymentMethods.mockResolvedValue({
    data: Array.from({ length: count }, (_, i) => ({ id: `pm_${i}` })),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

describe.skipIf(!HAS_DB)("staffRemovePaymentMethod", () => {
  it("requires a reason before touching Stripe at all", async () => {
    const { orgId, actorId } = await seedOrg();
    await expect(staffRemovePaymentMethod(actorId, orgId, "pm_x", "   ")).rejects.toThrow(
      /reason/i,
    );
    expect(stripeMock.retrievePaymentMethod).not.toHaveBeenCalled();
  });

  it("leaves has_payment_method TRUE when another card remains after removal", async () => {
    const { orgId, actorId, customerId } = await seedOrg({ hasFlag: true });
    stripeMock.retrievePaymentMethod.mockResolvedValue({
      id: "pm_old",
      customer: customerId,
      card: { brand: "visa", last4: "4242" },
    });
    stripeMock.detachPaymentMethod.mockResolvedValue({ id: "pm_old" });
    stripeHasCards(customerId, 1); // one card still on file after the detach

    await staffRemovePaymentMethod(actorId, orgId, "pm_old", "fraud cleanup");

    expect(await flagOf(orgId)).toBe(true);
  });

  it("clears has_payment_method when it removes the LAST card — the fifth writer of Task 4C's mirror", async () => {
    const { orgId, actorId, customerId } = await seedOrg({ hasFlag: true });
    stripeMock.retrievePaymentMethod.mockResolvedValue({
      id: "pm_last",
      customer: customerId,
      card: { brand: "mastercard", last4: "1111" },
    });
    stripeMock.detachPaymentMethod.mockResolvedValue({ id: "pm_last" });
    stripeHasCards(customerId, 0); // no cards left after the detach

    await staffRemovePaymentMethod(actorId, orgId, "pm_last", "erasure request");

    expect(await flagOf(orgId)).toBe(false);
  });

  it("audits the reason AND the card identity (brand/last4), so the log says WHICH card", async () => {
    const { orgId, actorId, customerId } = await seedOrg();
    stripeMock.retrievePaymentMethod.mockResolvedValue({
      id: "pm_audit",
      customer: customerId,
      card: { brand: "amex", last4: "9999" },
    });
    stripeMock.detachPaymentMethod.mockResolvedValue({ id: "pm_audit" });
    stripeHasCards(customerId, 0);

    await staffRemovePaymentMethod(actorId, orgId, "pm_audit", "chargeback dispute cleanup");

    const [audit] = await sql<
      { detail: { reason: string; card: { brand: string; last4: string } } }[]
    >`
      select detail from staff_audit_log
      where target_id = ${orgId} and action = 'remove_payment_method'
      order by created_at desc limit 1`;
    expect(audit.detail.reason).toBe("chargeback dispute cleanup");
    expect(audit.detail.card).toEqual({ brand: "amex", last4: "9999" });
  });

  it("refuses a card that does not belong to this org's Stripe customer", async () => {
    const { orgId, actorId } = await seedOrg();
    stripeMock.retrievePaymentMethod.mockResolvedValue({
      id: "pm_other",
      customer: "cus_someone_else",
    });
    await expect(staffRemovePaymentMethod(actorId, orgId, "pm_other", "test")).rejects.toThrow(
      /does not belong/i,
    );
    expect(stripeMock.detachPaymentMethod).not.toHaveBeenCalled();
  });
});

// Regression (brief-required): the customer-facing surface must gain NO
// card-removal affordance for the default card. Task 6C adds a SEPARATE staff
// usecase precisely so this guard never has to move — proven here by
// exercising it directly, not by inference from the staff path's tests above.
describe.skipIf(!HAS_DB)(
  "removePaymentMethod (customer path) — default-card guard, unchanged",
  () => {
    it("still 400s when asked to remove the customer's default card", async () => {
      const { orgId, customerId } = await seedOrg();
      stripeMock.retrievePaymentMethod.mockResolvedValue({
        id: "pm_default",
        customer: customerId,
      });
      stripeMock.retrieveCustomer.mockResolvedValue({
        id: customerId,
        deleted: false,
        invoice_settings: { default_payment_method: "pm_default" },
      });
      await expect(removePaymentMethod(orgId, "pm_default")).rejects.toThrow(
        "Make another card the default before removing this one.",
      );
      expect(stripeMock.detachPaymentMethod).not.toHaveBeenCalled();
    });

    // The pair that proves the guard is keyed on card IDENTITY, not a blanket
    // refusal to remove anything — without this, gutting the guard entirely
    // (always throw, or always allow) could still pass the case above alone.
    it("still allows removing a NON-default card", async () => {
      const { orgId, customerId } = await seedOrg();
      stripeMock.retrievePaymentMethod.mockResolvedValue({
        id: "pm_secondary",
        customer: customerId,
      });
      stripeMock.retrieveCustomer.mockResolvedValue({
        id: customerId,
        deleted: false,
        invoice_settings: { default_payment_method: "pm_default" },
      });
      stripeMock.detachPaymentMethod.mockResolvedValue({ id: "pm_secondary" });
      stripeHasCards(customerId, 1);
      await expect(removePaymentMethod(orgId, "pm_secondary")).resolves.toBeUndefined();
      expect(stripeMock.detachPaymentMethod).toHaveBeenCalledWith("pm_secondary");
    });
  },
);
