// #329: `items.data[0]` is not "the single item" any more. A group with an
// extra-organisation rider or extra seats carries TWO items, Stripe does not
// promise which comes first, and the two report DIFFERENT `current_period_end`
// — measured at 2027-07-27 (annual plan) against 2026-08-27 (monthly rider) on
// one live test-mode subscription. Pure unit test: no DB, no Stripe.
import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import { planItem } from "@/lib/subscription-items";
import { ORG_ADDON_FEATURE_KEY } from "@/lib/org-addons";
import { SEAT_ADDON } from "@/lib/seat-addons";

const item = (
  id: string,
  periodEnd: number,
  metadata: Record<string, string> = {},
): Stripe.SubscriptionItem =>
  ({
    id,
    current_period_end: periodEnd,
    metadata,
    // No `lookup_key`: the unexpanded-price shape, which is what forces both
    // isSeatAddonItem and isOrgAddonItem onto their metadata fallbacks — the
    // weaker of the two identifications, so the one worth pinning.
    price: { id: `price_${id}` },
  }) as unknown as Stripe.SubscriptionItem;

const sub = (items: Stripe.SubscriptionItem[]): Stripe.Subscription =>
  ({ items: { data: items } }) as unknown as Stripe.Subscription;

describe("planItem", () => {
  it("picks the plan item even when an add-on is FIRST in items.data (#329)", () => {
    const addon = item("si_addon", 1_787_000_000, { feature_key: ORG_ADDON_FEATURE_KEY });
    const plan = item("si_plan", 1_816_000_000);
    // Stripe does not guarantee order; the add-on landing first is what stamped
    // an annual group with the monthly rider's period end, eleven months early.
    expect(planItem(sub([addon, plan]))?.id).toBe("si_plan");
    expect(planItem(sub([addon, plan]))?.current_period_end).toBe(1_816_000_000);
  });

  it("ignores a seat add-on item (target_org_id + members.max, as extra-seats.ts stamps it)", () => {
    const seat = item("si_seat", 1_787_000_000, {
      target_org_id: "11111111-1111-1111-1111-111111111111",
      feature_key: SEAT_ADDON.featureKey,
    });
    const plan = item("si_plan", 1_816_000_000);
    expect(planItem(sub([seat, plan]))?.id).toBe("si_plan");
  });

  it("returns null rather than guessing when every item is an add-on", () => {
    const seat = item("si_seat", 1, {
      target_org_id: "11111111-1111-1111-1111-111111111111",
      feature_key: SEAT_ADDON.featureKey,
    });
    expect(planItem(sub([seat]))).toBeNull();
  });

  it("returns null on an empty subscription", () => {
    expect(planItem(sub([]))).toBeNull();
  });
});
