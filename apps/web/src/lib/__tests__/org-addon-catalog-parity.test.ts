// The extra-org ADD-ON price (v17 gap #293) must never drift from the
// graduated tier-2 rate `extraOrgPrice()` already advertises — the decision
// is "same as tier-2", not "close to it". No DB, no Stripe: pure JSON +
// pure-function checks, mirroring extra-org-price-parity.test.ts's style.
import { describe, expect, it } from "vitest";
import stripePlans from "@/config/stripe-plans.json";
import { extraOrgPrice, SUPPORTED_CURRENCIES } from "@/lib/currency";
import {
  ORG_ADDONS,
  ORG_ADDON_DELTA_EACH,
  ORG_ADDON_FEATURE_KEY,
  isOrgAddonItem,
  orgAddonForPlan,
} from "@/lib/org-addons";
import { ORG_ADDON_PLAN_KEYS, planSellsExtraOrg } from "@/lib/org-addon-plans";

describe("extra-organisation add-on catalog (v17 gap #293)", () => {
  it("has exactly one recurring price per paid plan", () => {
    expect(ORG_ADDONS.map((e) => e.planKey).sort()).toEqual(["pro", "pro_plus"]);
  });

  it("lifts orgs.max_owned by 1 per unit, for every plan tier", () => {
    for (const entry of ORG_ADDONS) {
      expect(entry.featureKey).toBe("orgs.max_owned");
      expect(entry.deltaEach).toBe(1);
    }
    expect(ORG_ADDON_FEATURE_KEY).toBe("orgs.max_owned");
    expect(ORG_ADDON_DELTA_EACH).toBe(1);
  });

  it("orgAddonForPlan resolves pro/pro_plus and refuses community", () => {
    expect(orgAddonForPlan("pro")?.lookupKey).toBe(
      ORG_ADDONS.find((e) => e.planKey === "pro")!.lookupKey,
    );
    expect(orgAddonForPlan("pro_plus")?.lookupKey).toBe(
      ORG_ADDONS.find((e) => e.planKey === "pro_plus")!.lookupKey,
    );
    expect(orgAddonForPlan("community")).toBeUndefined();
  });

  it("the CLIENT-safe plan list is the same catalog, not a second opinion", () => {
    // `lib/org-addons.ts` is server-only, so a client surface deciding whether
    // to offer the purchase reads `lib/org-addon-plans.ts` instead. Two
    // derivations of one catalog is exactly how a "buy another slot" link ends
    // up on a tier that sells nothing.
    expect([...ORG_ADDON_PLAN_KEYS]).toEqual(ORG_ADDONS.map((e) => e.planKey));
    for (const planKey of ["pro", "pro_plus", "community", "unknown_plan"]) {
      expect(planSellsExtraOrg(planKey), planKey).toBe(!!orgAddonForPlan(planKey));
    }
    expect(planSellsExtraOrg("community")).toBe(false);
  });

  it("prices each tier at EXACTLY what extraOrgPrice() advertises — same as tier-2, #293", () => {
    const proSpec = stripePlans.org_addons!.find((o) => o.plan_key === "pro")!;
    const proPlusSpec = stripePlans.org_addons!.find((o) => o.plan_key === "pro_plus")!;
    for (const currency of SUPPORTED_CURRENCIES) {
      const proAmount =
        currency === "usd" ? proSpec.price.unit_amount : proSpec.price.currency_options[currency];
      const proPlusAmount =
        currency === "usd"
          ? proPlusSpec.price.unit_amount
          : proPlusSpec.price.currency_options[currency];
      expect(proAmount, `pro ${currency}`).toBe(extraOrgPrice("pro", "monthly", currency));
      expect(proPlusAmount, `pro_plus ${currency}`).toBe(
        extraOrgPrice("pro_plus", "monthly", currency),
      );
    }
  });

  it("is a RECURRING monthly price — rides the subscription like extra-seat, never one-time", () => {
    expect(stripePlans.org_addons?.length).toBeGreaterThan(0);
    for (const entry of stripePlans.org_addons ?? []) {
      expect(entry.price.interval, entry.key).toBe("month");
    }
  });

  it("charges less for Pro than Pro Plus, mirroring the plan ladder itself", () => {
    const pro = stripePlans.org_addons!.find((o) => o.plan_key === "pro")!;
    const proPlus = stripePlans.org_addons!.find((o) => o.plan_key === "pro_plus")!;
    expect(pro.price.unit_amount).toBeLessThan(proPlus.price.unit_amount);
    // The $9-vs-$19 gap is what stops "Pro + extras" undercutting Pro Plus, so
    // it is load-bearing in EVERY currency, not just the usd headline.
    for (const currency of ["eur", "gbp", "inr", "aud"] as const) {
      expect(
        proPlus.price.currency_options[currency],
        `${currency}: Pro Plus extras must cost more than Pro extras`,
      ).toBeGreaterThan(pro.price.currency_options[currency]);
    }
  });

  it("recognises an org-addon subscription item by lookup_key, and only that SKU", () => {
    const asItem = (over: Record<string, unknown>) =>
      over as unknown as Parameters<typeof isOrgAddonItem>[0];
    for (const entry of ORG_ADDONS) {
      expect(isOrgAddonItem(asItem({ price: { lookup_key: entry.lookupKey } }))).toBe(true);
    }
    // The plan item and the seat item ride the SAME subscription — neither may
    // be mistaken for an org add-on or the webhook would lift the wrong cap.
    expect(isOrgAddonItem(asItem({ price: { lookup_key: "seazn_pro_monthly" } }))).toBe(false);
    expect(isOrgAddonItem(asItem({ price: { lookup_key: "seazn_seat_monthly" } }))).toBe(false);
    expect(
      isOrgAddonItem(asItem({ price: { lookup_key: "seazn_seat_monthly" }, metadata: { feature_key: "members.max" } })),
    ).toBe(false);
    // Fallback for a payload that arrives without the price expanded.
    expect(isOrgAddonItem(asItem({ metadata: { feature_key: "orgs.max_owned" } }))).toBe(true);
  });
});
