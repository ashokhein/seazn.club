// Task 7 (Pro Plus tier): live-subscription plan change Pro ↔ Pro Plus.
// resolvePriceChange generalizes resolveIntervalChange to look the target
// price up by `planKey` instead of the subscription's current plan — these
// tests exercise the refusal case + price-id selection through the exported
// previewPlanChange/applyPlanChange, with Stripe + db + downstream
// entitlement/analytics calls mocked (no network, no DATABASE_URL needed).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { proPlusPrice, proPrice } from "@/lib/currency";

type SubFixture = {
  plan_key: string;
  status: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_end: string | null;
  trial_end: string | null;
  cancel_at_period_end: boolean;
  currency: string | null;
};

type PlanRow = {
  stripe_price_id_monthly: string | null;
  stripe_price_id_annual: string | null;
};

const db = vi.hoisted(() => ({
  sub: null as SubFixture | null,
  plans: {} as Record<string, PlanRow>,
}));
vi.mock("@/lib/db", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(" ");
    if (text.includes("from subscriptions")) return Promise.resolve(db.sub ? [db.sub] : []);
    if (text.includes("from plans")) {
      const key = values[0] as string;
      const row = db.plans[key];
      return Promise.resolve(row ? [row] : []);
    }
    if (text.includes("from organizations")) return Promise.resolve([{ created_by: "user_1" }]);
    return Promise.resolve([]);
  },
}));

const stripeMock = vi.hoisted(() => ({
  retrieveSubscription: vi.fn(),
  createPreview: vi.fn(),
  updateSubscription: vi.fn(),
}));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({
    subscriptions: {
      retrieve: stripeMock.retrieveSubscription,
      update: stripeMock.updateSubscription,
    },
    invoices: { createPreview: stripeMock.createPreview },
  }),
}));

vi.mock("@/lib/auth", () => ({
  getActiveOrgId: vi.fn(),
  requireOrgRole: vi.fn(),
  requireUser: vi.fn(),
}));

const billingMock = vi.hoisted(() => ({ syncSubscription: vi.fn() }));
vi.mock("@/lib/billing", () => ({
  syncSubscription: billingMock.syncSubscription,
}));

// V310: the plan change lands on the billing GROUP, so the cache drop is
// invalidateEntitlementsForOrgGroup — still called with the org id.
const entitlementsMock = vi.hoisted(() => ({
  invalidateOrgEntitlements: vi.fn(),
  invalidateEntitlementsForOrgGroup: vi.fn(),
}));
vi.mock("@/lib/entitlements", () => ({
  invalidateOrgEntitlements: entitlementsMock.invalidateOrgEntitlements,
  invalidateEntitlementsForOrgGroup: entitlementsMock.invalidateEntitlementsForOrgGroup,
}));

vi.mock("@/lib/posthog-server", () => ({ captureServer: vi.fn() }));

import { applyPlanChange, previewPlanChange } from "../billing-manage";

const ORG_ID = "org_1";

function sub(over: Partial<SubFixture> = {}): SubFixture {
  return {
    plan_key: "pro",
    status: "active",
    stripe_customer_id: "cus_1",
    stripe_subscription_id: "sub_1",
    current_period_end: new Date(Date.now() + 15 * 86_400_000).toISOString(),
    trial_end: null,
    cancel_at_period_end: false,
    currency: "usd",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.sub = null;
  db.plans = {
    pro: {
      stripe_price_id_monthly: "price_pro_m",
      stripe_price_id_annual: "price_pro_y",
    },
    pro_plus: {
      stripe_price_id_monthly: "price_plus_m",
      stripe_price_id_annual: "price_plus_y",
    },
  };
});

describe("previewPlanChange refusal (resolvePriceChange)", () => {
  it("refuses when the target plan+interval is already the live price", async () => {
    db.sub = sub({ plan_key: "pro_plus" });
    stripeMock.retrieveSubscription.mockResolvedValue({
      status: "active",
      currency: "usd",
      items: { data: [{ id: "si_1", price: { id: "price_plus_m" } }] },
    });

    await expect(previewPlanChange(ORG_ID, "pro_plus", "monthly")).rejects.toMatchObject({
      status: 400,
      message: "Already on this plan",
    });
    expect(stripeMock.createPreview).not.toHaveBeenCalled();
  });
});

/** Two previews are taken per plan change, and they must not be confused:
 *  the PRORATION one (no preview_mode) drives "due today"/credit, and the
 *  RECURRING one (preview_mode: "recurring") drives the renewal quote. Distinct
 *  totals here so each assertion proves which call it came from. */
function previewByMode(prorationTotal: number, recurringTotal: number) {
  return (params: { preview_mode?: string }) =>
    Promise.resolve({
      total: params.preview_mode === "recurring" ? recurringTotal : prorationTotal,
      currency: "usd",
      lines: { data: [{ period: { end: 1_800_000_000 } }] },
    });
}

describe("previewPlanChange price-id selection", () => {
  it("looks the target price up under the TARGET plan key, not the current one", async () => {
    db.sub = sub({ plan_key: "pro" });
    stripeMock.retrieveSubscription.mockResolvedValue({
      status: "active",
      currency: "usd",
      items: { data: [{ id: "si_1", price: { id: "price_pro_m" } }] },
    });
    stripeMock.createPreview.mockImplementation(previewByMode(2500, 5800));

    const preview = await previewPlanChange(ORG_ID, "pro_plus", "monthly");

    expect(stripeMock.createPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        subscription_details: expect.objectContaining({
          items: [{ id: "si_1", price: "price_plus_m" }],
        }),
      }),
    );
    // V310: the renewal quote is Stripe's own recurring preview, NOT
    // proPlusPrice(). Prices are tiers_mode: graduated now, so the flat helper
    // under-quotes every multi-org group — 5800 here is base + one extra org,
    // a number the flat lookup cannot produce.
    expect(preview.renewalAmountMinor).toBe(5800);
    expect(preview.renewalAmountMinor).not.toBe(proPlusPrice("monthly", "usd"));
    // …and the recurring preview is asked for the TARGET price, same as the
    // proration one.
    expect(stripeMock.createPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        preview_mode: "recurring",
        subscription_details: { items: [{ id: "si_1", price: "price_plus_m" }] },
      }),
    );
  });

  it("quotes a Pro Plus → Pro downgrade from the recurring preview, credit from the proration one", async () => {
    db.sub = sub({ plan_key: "pro_plus" });
    stripeMock.retrieveSubscription.mockResolvedValue({
      status: "active",
      currency: "usd",
      items: { data: [{ id: "si_1", price: { id: "price_plus_m" } }] },
    });
    stripeMock.createPreview.mockImplementation(previewByMode(-1500, 2800));

    const preview = await previewPlanChange(ORG_ID, "pro", "monthly");

    expect(stripeMock.createPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        subscription_details: expect.objectContaining({
          items: [{ id: "si_1", price: "price_pro_m" }],
        }),
      }),
    );
    // Renewal from the recurring preview; credit still from the proration one.
    expect(preview.renewalAmountMinor).toBe(2800);
    expect(preview.renewalAmountMinor).not.toBe(proPrice("monthly", "usd"));
    expect(preview.creditMinor).toBe(1500);
  });

  it("degrades to a null renewal quote rather than failing the whole preview", async () => {
    db.sub = sub({ plan_key: "pro" });
    stripeMock.retrieveSubscription.mockResolvedValue({
      status: "active",
      currency: "usd",
      items: { data: [{ id: "si_1", price: { id: "price_pro_m" } }] },
    });
    stripeMock.createPreview.mockImplementation((params: { preview_mode?: string }) =>
      params.preview_mode === "recurring"
        ? Promise.reject(new Error("stripe down"))
        : Promise.resolve({
            total: 2500,
            currency: "usd",
            lines: { data: [{ period: { end: 1_800_000_000 } }] },
          }),
    );

    const preview = await previewPlanChange(ORG_ID, "pro_plus", "monthly");

    // One line of the confirm dialog goes missing; "due today" still renders.
    expect(preview.renewalAmountMinor).toBeNull();
    expect(preview.dueTodayMinor).toBe(2500);
  });
});

describe("applyPlanChange", () => {
  it("invalidates cached entitlements after syncSubscription — plan_key changes here", async () => {
    db.sub = sub({ plan_key: "pro" });
    stripeMock.retrieveSubscription.mockResolvedValue({
      status: "active",
      currency: "usd",
      items: { data: [{ id: "si_1", price: { id: "price_pro_m" } }] },
    });
    const updated = {
      status: "active",
      currency: "usd",
      items: { data: [{ id: "si_1", price: { id: "price_plus_m" } }] },
      latest_invoice: null,
    };
    stripeMock.updateSubscription.mockResolvedValue(updated);

    const result = await applyPlanChange(ORG_ID, "pro_plus", "monthly", 1_770_000_000);

    expect(billingMock.syncSubscription).toHaveBeenCalledWith(ORG_ID, updated);
    expect(entitlementsMock.invalidateEntitlementsForOrgGroup).toHaveBeenCalledWith(ORG_ID);
    expect(result).toEqual({ requires_action: false });
  });
});
