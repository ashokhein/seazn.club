import "server-only";
import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { HttpError } from "@/lib/errors";
import stripePlans from "@/config/stripe-plans.json";

// Extra-seat recurring add-on (design/v17-pricing-entitlements/SPEC-2 §3,
// §11.3, v17 Phase 3 Task 3a). Unlike an AI credit pack (a one-time Checkout
// Session, lib/credit-packs.ts), a seat is a RECURRING line item that rides the
// billing group's EXISTING subscription as an extra subscription item — one
// invoice, one billing cycle, Stripe-native proration. It lifts members.max by
// `delta_each` per unit (qty = seat count). Built per the
// `stripe:stripe-best-practices` skill (billing reference): Billing APIs +
// subscription items for seat-based recurring billing, never a second
// subscription and never a manual PaymentIntent renewal loop; the customer's
// currency is already locked by the existing subscription, so no currency is
// sent when adding the item.

/** The seat SKU's catalog facts that are NOT the live Stripe price id (that is
 *  resolved by lookup_key at request time — no `plans` row, exactly like a
 *  credit pack). `deltaEach`/`featureKey` are OUR fields: what cap the webhook
 *  lifts and by how much per unit; never sent to Stripe. */
export interface SeatAddonCatalogEntry {
  featureKey: string;
  deltaEach: number;
  lookupKey: string;
}

const seatSeed = (stripePlans.seats ?? [])[0];

/** Derived from config/stripe-plans.json's `seats` entry — the same file
 *  stripe-sync.ts seeds Stripe from, so the catalog and the live price can
 *  never drift out of key-naming step. */
export const SEAT_ADDON: SeatAddonCatalogEntry = {
  featureKey: seatSeed?.feature_key ?? "members.max",
  deltaEach: seatSeed?.delta_each ?? 1,
  lookupKey: seatSeed?.price?.lookup_key ?? "seazn_seat_monthly",
};

/**
 * Is this subscription item the recurring extra-seat SKU? Matched on the price
 * `lookup_key` (the durable identity, stable across price replacements via
 * transfer_lookup_key), falling back to the item metadata marker the route
 * stamps for the case a payload arrives without the price expanded. Used by the
 * webhook (billing-events.ts) to pick seat items out of a subscription that may
 * also carry the plan item (and, later, other add-on items).
 */
export function isSeatAddonItem(item: Stripe.SubscriptionItem): boolean {
  if (item.price?.lookup_key === SEAT_ADDON.lookupKey) return true;
  return (
    item.metadata?.feature_key === SEAT_ADDON.featureKey && !!item.metadata?.target_org_id
  );
}

/**
 * The live Stripe price id for the seat SKU, resolved by `lookup_key` at
 * request time (mirrors resolveCreditPackPriceId) — there is no `plans` row to
 * cache it on. 503s (matching the plan/pass/pack checkout shape) when
 * `stripe:sync` has not yet been run against this Stripe account.
 */
export async function resolveSeatPriceId(): Promise<string> {
  const found = await getStripe().prices.list({ lookup_keys: [SEAT_ADDON.lookupKey], limit: 1 });
  const price = found.data[0];
  if (!price) {
    throw new HttpError(503, "Billing is not yet configured. Please contact support.");
  }
  return price.id;
}
