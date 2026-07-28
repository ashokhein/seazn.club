import "server-only";
import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { HttpError } from "@/lib/errors";
import type { Currency } from "@/lib/currency";
import stripePlans from "@/config/stripe-plans.json";

// Extra-organisation recurring add-on (v17 gap #293, design/v17-pricing-
// entitlements SPEC-2 §3/§7). Structurally like lib/seat-addons.ts — a
// RECURRING line item that rides the billing group's EXISTING subscription as
// an extra subscription item (one invoice, one cycle, Stripe-native proration,
// never a second subscription) — but ONE CATALOG ENTRY PER PLAN, because the
// rate differs by tier ($9 Pro / $19 Pro Plus), where extra_seat has only one
// flat rate. That difference is load-bearing, not cosmetic: at one flat rate
// "Pro + extras" would undercut Pro Plus. Every tier still lifts the SAME
// feature by the SAME amount — only the PRICE differs — so featureKey/deltaEach
// are pinned ONCE below (ORG_ADDON_FEATURE_KEY/ORG_ADDON_DELTA_EACH), exactly
// like SEAT_ADDON pins them for its one entry; only the lookup_key varies.

/** One plan's extra-org SKU. The live Stripe price id is NOT here — it is
 *  resolved by lookup_key at request time (no `plans` row, exactly like a seat
 *  or a credit pack). `featureKey`/`deltaEach` are OUR fields: which cap the
 *  webhook lifts and by how much per unit; never sent to Stripe. */
export interface OrgAddonCatalogEntry {
  planKey: string;
  featureKey: string;
  deltaEach: number;
  lookupKey: string;
}

const orgAddonSeed = stripePlans.org_addons ?? [];

/** Derived from config/stripe-plans.json's `org_addons` array — the same file
 *  stripe-sync.ts seeds Stripe from, so the catalog and the live prices can
 *  never drift out of key-naming step. */
export const ORG_ADDONS: OrgAddonCatalogEntry[] = orgAddonSeed.map((e) => ({
  planKey: e.plan_key,
  featureKey: e.feature_key,
  deltaEach: e.delta_each,
  lookupKey: e.price.lookup_key,
}));

/** Every tier lifts the SAME cap by the SAME amount — only price differs by
 *  plan. Pinned once here, not trusted per-item, exactly like SEAT_ADDON, so
 *  the webhook can pin feature/delta without knowing which tier an item was
 *  bought at. The literal fallbacks only apply to an EMPTY seed (extra orgs
 *  simply cannot be sold then — ORG_ADDONS is empty, orgAddonForPlan returns
 *  undefined and the purchase route refuses), which is a degradation, not a
 *  wrong lift. A seed that disagrees WITH ITSELF is the dangerous case — a
 *  silently wrong feature_key would be a stuck cap lift no reconcile could
 *  find — so that one fails closed at import time. */
export const ORG_ADDON_FEATURE_KEY: string = orgAddonSeed[0]?.feature_key ?? "orgs.max_owned";
export const ORG_ADDON_DELTA_EACH: number = orgAddonSeed[0]?.delta_each ?? 1;
if (
  ORG_ADDONS.some(
    (e) => e.featureKey !== ORG_ADDON_FEATURE_KEY || e.deltaEach !== ORG_ADDON_DELTA_EACH,
  )
) {
  throw new Error(
    "config/stripe-plans.json org_addons: every tier must lift the SAME feature_key by the SAME " +
      "delta_each — only the price may differ by plan.",
  );
}

const LOOKUP_KEYS = new Set(ORG_ADDONS.map((e) => e.lookupKey));

/**
 * Is this subscription item one of the recurring extra-org SKUs (any tier)?
 * Matched on the price `lookup_key` (the durable identity, stable across price
 * replacements via transfer_lookup_key), falling back to the item metadata
 * marker the usecase stamps for the case a payload arrives without the price
 * expanded. Used by the webhook (billing-events.ts) to pick org-addon items
 * out of a subscription that may also carry the plan item and seat items.
 *
 * The metadata fallback is checked only when the lookup_key does NOT identify a
 * different SKU: a seat item carries `feature_key: members.max`, so the two can
 * never be confused, but an item whose price IS known and is NOT an org addon
 * must never be claimed on metadata alone.
 */
export function isOrgAddonItem(item: Stripe.SubscriptionItem): boolean {
  if (item.price?.lookup_key) return LOOKUP_KEYS.has(item.price.lookup_key);
  return item.metadata?.feature_key === ORG_ADDON_FEATURE_KEY;
}

/** The catalog entry for a plan, or undefined when that plan has no add-on
 *  (community: exceeding a free org is an upgrade, not a purchase). */
export function orgAddonForPlan(planKey: string): OrgAddonCatalogEntry | undefined {
  return ORG_ADDONS.find((e) => e.planKey === planKey);
}

/**
 * What ONE extra-organisation rider costs PER MONTH on this plan, in the
 * currency's minor units — read from the `org_addons` SKU that Stripe actually
 * bills (v17 gap #293, Task 6).
 *
 * NOT `extraOrgPrice()` (lib/currency.ts), and the difference is a wrong number
 * rather than a stylistic one. That helper reads the PLAN's graduated `up_to:
 * "inf"` tier — what one more organisation costs INSIDE the plan's cap, on the
 * plan's own interval. The two agree monthly and diverge annually: an annual
 * Pro group's existing extra organisations cost 7900/year each, while this
 * rider is 900/MONTH (~10800/year, about 37% more) on a separate monthly
 * cadence. Quoting the tier to an annual group would understate the rider by a
 * third and imply a yearly charge that will arrive monthly.
 *
 * So the interval is not a parameter: the rider is a monthly recurring price on
 * every plan (`org-addon-catalog-parity.test.ts` pins `interval: "month"` for
 * every entry), and any surface rendering this number must SAY monthly.
 *
 * Keyed on the group's CURRENT `plan_key`, never on what the customer last
 * paid: a tier change re-prices the rider (`setExtraOrgs` swaps the item onto
 * the new plan's lookup_key), so the old rate is not what they will be billed.
 *
 * Returns null when the plan has no rider SKU (community) — the caller has
 * nothing to sell and must not render a price at all.
 */
export function orgAddonPriceMinor(planKey: string, currency: Currency): number | null {
  const seed = orgAddonSeed.find((e) => e.plan_key === planKey);
  if (!seed) return null;
  if (currency === "usd") return seed.price.unit_amount;
  // Same fallback shape as lib/currency.ts's `amountFor`: a currency absent
  // from currency_options bills at the usd amount, because that is what Stripe
  // does with a price whose currency_options omit it.
  return (
    (seed.price.currency_options as Record<string, number> | undefined)?.[currency] ??
    seed.price.unit_amount
  );
}

/**
 * The live Stripe price id for a plan's org-addon SKU, resolved by
 * `lookup_key` at request time (mirrors resolveSeatPriceId) — there is no
 * `plans` row to cache it on. 503s (matching every other checkout route) when
 * `stripe:sync` has not yet been run against this Stripe account; 400s when
 * the plan simply has no add-on (community).
 */
export async function resolveOrgAddonPriceId(planKey: string): Promise<string> {
  const entry = orgAddonForPlan(planKey);
  if (!entry) {
    throw new HttpError(400, `Extra organisations are not available on the ${planKey} plan.`);
  }
  const found = await getStripe().prices.list({ lookup_keys: [entry.lookupKey], limit: 1 });
  const price = found.data[0];
  if (!price) {
    throw new HttpError(503, "Billing is not yet configured. Please contact support.");
  }
  return price.id;
}
