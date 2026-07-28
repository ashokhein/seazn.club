// WHICH PLANS sell the recurring extra-organisation rider — the one slice of
// the org-addon catalog a CLIENT surface needs (v17 gap #293, Task 7).
//
// `lib/org-addons.ts` owns the catalog, but it imports `server-only` (it
// resolves live Stripe price ids), so a "use client" island offering the
// purchase cannot import it. The alternative — writing `["pro", "pro_plus"]`
// into the component — would be a second source of truth that silently keeps
// offering a rider on a tier whose SKU was withdrawn, or hides one on a tier
// that gained it. Both read to the customer as a link that leads to a page
// saying the opposite of the link.
//
// So this derives from the SAME `config/stripe-plans.json` seed the catalog and
// `stripe:sync` read, and `lib/__tests__/org-addon-catalog-parity.test.ts` pins
// the two derivations against each other.
import stripePlans from "@/config/stripe-plans.json";

/** Plan keys with an extra-organisation SKU, in catalog order. */
export const ORG_ADDON_PLAN_KEYS: readonly string[] = (stripePlans.org_addons ?? []).map(
  (e) => e.plan_key,
);

/**
 * Can this plan buy extra organisations at all?
 *
 * False for Community, and that is not a corner case: a Community group is
 * `max_orgs: 1` with one organisation on it, so it is permanently "full" — the
 * commonest way any surface reaches a full-group branch. Exceeding it is an
 * upgrade, not a purchase, so a "buy another slot" offer must never render for
 * one.
 */
export function planSellsExtraOrg(planKey: string): boolean {
  return ORG_ADDON_PLAN_KEYS.includes(planKey);
}
