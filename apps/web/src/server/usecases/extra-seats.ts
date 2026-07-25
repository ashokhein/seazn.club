import "server-only";
import { getStripe } from "@/lib/stripe";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { hasLiveSubscription } from "@/lib/subscription-status";
import { requireBillingOwner } from "@/server/usecases/billing-manage";
import { SEAT_ADDON, resolveSeatPriceId, isSeatAddonItem } from "@/lib/seat-addons";

/** Sanity bound — a request for thousands of seats is a bug or an abuse, not a
 *  real purchase. The real cap is the customer's card. */
const MAX_SEATS = 999;

/**
 * Add / adjust / remove the extra-seat recurring add-on for the caller's ACTIVE
 * org (v17 SPEC-2 §3/§11.3, Phase 3 Task 3a). $4/seat/month, +1 members.max per
 * seat, scoped to the one org even though the paying subscription may cover a
 * whole billing group.
 *
 * The seat rides the group's EXISTING Stripe subscription as an extra
 * subscription ITEM (one invoice, one billing cycle, Stripe-native proration) —
 * never a second subscription, which would double-invoice the customer. This
 * mutates STRIPE ONLY: the org_addons row is written by the
 * customer.subscription.updated webhook (syncSeatAddonsForSubscription,
 * billing-events.ts), the single writer, so Stripe and the DB can never
 * diverge. Do NOT write org_addons here.
 *
 * Group-payer gated (`requireBillingOwner`, the same gate the credit-pack
 * checkout uses — the wallet is the group's shared pool, charged on the group's
 * one payer, SPEC-2 §11.3/§11.4): a non-payer (or a stale/foreign active-org
 * cookie) is refused with 403 BEFORE any Stripe call fires.
 *
 * @param seatCount total seats this org should hold (0 removes the add-on).
 */
export async function setExtraSeats(seatCount: number): Promise<{ orgId: string; seats: number }> {
  if (!Number.isInteger(seatCount) || seatCount < 0 || seatCount > MAX_SEATS) {
    throw new HttpError(400, `seats must be an integer between 0 and ${MAX_SEATS}.`);
  }
  const { orgId, subscriptionId } = await requireBillingOwner();

  const [group] = await sql<
    { stripe_subscription_id: string | null; status: string | null }[]
  >`select stripe_subscription_id, status from subscriptions where id = ${subscriptionId}`;
  // hasLiveSubscription is a type predicate — narrow the value it is called on,
  // so stripe_subscription_id reads as non-null below.
  const groupRow = group ?? undefined;
  if (!hasLiveSubscription(groupRow)) {
    // Community (no Stripe subscription) has nothing to attach a seat item to.
    throw new HttpError(400, "Extra seats require an active paid subscription.");
  }
  const stripeSubId = groupRow.stripe_subscription_id;

  const live = await getStripe().subscriptions.retrieve(stripeSubId);
  // A seat item scoped to THIS org (the subscription may carry seat items for
  // several member orgs, plus the plan item itself).
  const existing = live.items.data.find(
    (it) => isSeatAddonItem(it) && it.metadata?.target_org_id === orgId,
  );

  if (seatCount === 0) {
    // Removal is a DELETE in Stripe — a subscription item cannot hold
    // quantity 0. The webhook then flips the org_addons row to canceled
    // (freeze-not-delete). Removing seats does not refund mid-cycle.
    if (existing) {
      await getStripe().subscriptionItems.del(existing.id, { proration_behavior: "none" });
    }
    return { orgId, seats: 0 };
  }

  if (existing) {
    // Raising prorates the extra seats now; lowering takes effect with no
    // mid-cycle refund — mirrors syncGroupQuantity's org-seat proration rule.
    const raising = seatCount > (existing.quantity ?? 0);
    await getStripe().subscriptionItems.update(existing.id, {
      quantity: seatCount,
      proration_behavior: raising ? "create_prorations" : "none",
    });
  } else {
    const priceId = await resolveSeatPriceId();
    await getStripe().subscriptionItems.create({
      subscription: stripeSubId,
      price: priceId,
      quantity: seatCount,
      proration_behavior: "create_prorations",
      // The webhook reads target_org_id + feature_key off THIS metadata to know
      // which org's cap to lift (the subscription itself may span the group).
      metadata: { target_org_id: orgId, feature_key: SEAT_ADDON.featureKey },
    });
  }
  return { orgId, seats: seatCount };
}
