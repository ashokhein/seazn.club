// POST /api/billing/checkout — the join between the two halves of the
// pass-to-Pro upgrade (v3/07, D12/D13). The credit usecase and the session
// builder are each tested where they live (server/usecases/__tests__/
// pass-credit.test.ts, lib/__tests__/billing-checkout.test.ts); what is only
// testable HERE is that the route actually calls them, and in the right order:
// the balance credit must exist on the customer BEFORE Stripe draws the first
// invoice, and requireCard must reach the session builder.
//
// Everything outside the route's own contract is mocked (auth, DB, Stripe,
// currency), the same idiom as api/admin/orgs/[id]/restore-trial's route test.
import { beforeEach, describe, expect, it, vi } from "vitest";

const requireUserMock = vi.fn<() => Promise<{ email: string }>>();
const requireBillingOwnerMock =
  vi.fn<() => Promise<{ orgId: string; subscriptionId: string }>>();
const billedQuantityMock = vi.fn<() => Promise<number>>();
vi.mock("@/lib/auth", () => ({ requireUser: () => requireUserMock() }));
// Billing groups: the checkout is the GROUP payer's and buys one seat per org.
vi.mock("@/server/usecases/billing-manage", () => ({
  requireBillingOwner: () => requireBillingOwnerMock(),
}));
vi.mock("@/lib/billing-group", () => ({ billedQuantity: () => billedQuantityMock() }));

// Dispatched on the query TEXT rather than call order, because the route also
// calls sql() as a plain function to interpolate the price column name.
const sqlMock = vi.fn(async (...args: unknown[]) => {
  const head = args[0];
  if (!Array.isArray(head)) return []; // sql("stripe_price_id_monthly") fragment
  const text = head.join(" ");
  if (text.includes("from plans")) return [{ price_id: "price_pro_monthly" }];
  if (text.includes("from subscriptions"))
    return [
      {
        stripe_customer_id: "cus_1",
        stripe_subscription_id: null,
        status: null,
        trial_used_at: null,
      },
    ];
  if (text.includes("from organizations")) return [{ slug: "riverside" }];
  return [];
});
vi.mock("@/lib/db", () => ({ sql: (...args: unknown[]) => sqlMock(...args) }));

const createSessionMock = vi.fn<(params: unknown) => Promise<{ client_secret: string }>>();
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({ checkout: { sessions: { create: createSessionMock } } }),
}));

vi.mock("@/lib/currency-server", () => ({ preferredCurrency: async () => "gbp" }));
vi.mock("@/lib/oauth", () => ({ baseUrl: () => "https://app.test" }));

const creditMock = vi.fn<(orgId: string) => Promise<{ outcome: string }>>();
const holdsPassMock = vi.fn<(orgId: string) => Promise<boolean>>();
vi.mock("@/server/usecases/pass-credit", () => ({
  creditPassTowardSubscription: (orgId: string) => creditMock(orgId),
  orgHoldsAnyPass: (orgId: string) => holdsPassMock(orgId),
}));

import { POST } from "../route";

const post = () =>
  POST(
    new Request("http://test/api/billing/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plan_key: "pro", interval: "monthly" }),
    }),
  );

/** The params the route handed buildEmbeddedCheckoutParams' output to Stripe. */
const sessionParams = () => createSessionMock.mock.calls[0][0] as Record<string, unknown>;

beforeEach(() => {
  requireUserMock.mockReset().mockResolvedValue({ email: "owner@test.local" });
  requireBillingOwnerMock.mockReset().mockResolvedValue({ orgId: "org-1", subscriptionId: "sub-1" });
  billedQuantityMock.mockReset().mockResolvedValue(1);
  createSessionMock.mockReset().mockResolvedValue({ client_secret: "cs_test_secret" });
  creditMock.mockReset().mockResolvedValue({ outcome: "credited" });
  holdsPassMock.mockReset().mockResolvedValue(false);
  sqlMock.mockClear();
});

describe("POST /api/billing/checkout — pass-to-Pro", () => {
  it("credits the org's pass before creating the checkout session", async () => {
    const res = await post();

    expect(res.status).toBe(200);
    expect(creditMock).toHaveBeenCalledWith("org-1");
    // Order matters: a credit granted after the session is created can miss the
    // first invoice Stripe draws for a no-trial subscription.
    expect(creditMock.mock.invocationCallOrder[0]).toBeLessThan(
      createSessionMock.mock.invocationCallOrder[0],
    );
  });

  it("requires a card when the org holds a pass, even though a trial is on offer", async () => {
    holdsPassMock.mockResolvedValue(true);

    await post();

    const params = sessionParams();
    // trial_used_at is null, so this org still gets its 14 days…
    expect((params.subscription_data as { trial_period_days?: number }).trial_period_days).toBe(14);
    // …but Stripe collects a card up front instead of "if_required".
    expect("payment_method_collection" in params).toBe(false);
  });

  it("keeps the no-card trial for an org that holds no pass", async () => {
    await post();
    expect(sessionParams().payment_method_collection).toBe("if_required");
  });

  it("still creates the session when nothing was creditable", async () => {
    creditMock.mockResolvedValue({ outcome: "unpaid_pass" });

    const res = await post();

    // A declined credit is a normal outcome, not a checkout failure.
    expect(res.status).toBe(200);
    expect(createSessionMock).toHaveBeenCalledTimes(1);
  });
});
