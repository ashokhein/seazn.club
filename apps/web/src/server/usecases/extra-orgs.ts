import "server-only";
import { getStripe } from "@/lib/stripe";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { hasLiveSubscription } from "@/lib/subscription-status";
import { requireBillingOwner } from "@/server/usecases/billing-manage";
import { orgAddonForPlan, resolveOrgAddonPriceId, isOrgAddonItem } from "@/lib/org-addons";

/** Self-serve bound on the RIDER. The group's own plan cap (10 on Pro Plus
 *  today) is far smaller than this; a request for hundreds is a bug or abuse,
 *  not a real purchase. The real cap is the customer's card. */
export const MAX_EXTRA_ORGS = 50;

/**
 * Add / adjust / remove the extra-organisation recurring add-on for the
 * caller's billing GROUP (v17 gap #293, design/v17-pricing-entitlements
 * SPEC-2 §3/§7). Priced per plan tier ($9/mo Pro, $19/mo Pro Plus — the two
 * rates are load-bearing: one flat rate would let "Pro + extras" undercut Pro
 * Plus); +1 orgs.max_owned per unit, GROUP-WIDE (not scoped to one org, unlike
 * a seat, which lifts one org's members.max).
 *
 * Rides the group's EXISTING Stripe subscription as an extra subscription ITEM
 * (one invoice, one billing cycle, Stripe-native proration) — never a second
 * subscription. This mutates STRIPE ONLY: the org_addons row is written by the
 * customer.subscription.updated webhook (syncOrgAddonsForSubscription,
 * billing-events.ts), the single writer, so Stripe and the DB can never
 * diverge. Do NOT write org_addons here.
 *
 * Group-payer gated (`requireBillingOwner`, the same gate extra-seat and the
 * credit-pack checkout use) — a non-payer is refused 403 BEFORE any Stripe call
 * fires.
 *
 * FAILURE MODES ARE DISTINGUISHED BY STATUS, not by prose: this module's
 * messages are hardcoded English and must never be rendered verbatim into the
 * four-locale UI. The client maps status -> DictionaryKey (the
 * `passCheckoutErrorKey` pattern):
 *   400 — `count` is not an integer in 0..MAX_EXTRA_ORGS (client-side bug).
 *   401 — not signed in (AuthError, from requireBillingOwner).
 *   403 — signed in, but not this billing group's payer.
 *   409 — the GROUP cannot hold the add-on at all: no live paid subscription,
 *         or a plan with no extra-org SKU. Remedy is "move to Pro / Pro Plus",
 *         not "retry" — which is why it is not folded into the 400.
 *   503 — the Stripe catalog has not been synced for this account
 *         (resolveOrgAddonPriceId). Remedy is "try later / contact support".
 *
 * @param count total extra organisations this group should hold beyond its
 *   plan's base cap (0 removes the add-on).
 */
export async function setExtraOrgs(
  count: number,
): Promise<{ subscriptionId: string; extraOrgs: number }> {
  if (!Number.isInteger(count) || count < 0 || count > MAX_EXTRA_ORGS) {
    throw new HttpError(
      400,
      `extra organisations must be an integer between 0 and ${MAX_EXTRA_ORGS}.`,
    );
  }
  const { subscriptionId } = await requireBillingOwner();

  const [group] = await sql<
    { stripe_subscription_id: string | null; status: string | null; plan_key: string }[]
  >`select stripe_subscription_id, status, plan_key
      from subscriptions where id = ${subscriptionId}`;
  // hasLiveSubscription is a type predicate — narrow the value it is called on,
  // so stripe_subscription_id reads as non-null below.
  const groupRow = group ?? undefined;
  if (!hasLiveSubscription(groupRow)) {
    // Community (no Stripe subscription) has nothing to attach an item to.
    // 409, not 400: the request was well-formed, the GROUP is in the wrong
    // state, and the remedy is a plan change rather than a different number.
    throw new HttpError(409, "Extra organisations require an active paid subscription.");
  }
  const stripeSubId = groupRow.stripe_subscription_id;
  // subscriptions.plan_key is `text not null references plans(key) default
  // 'community'` (V023) — there is no null to swallow with `?? ""`, and
  // pretending otherwise would turn a schema guarantee into a nonsense
  // message about "the  plan".
  const planKey = groupRow.plan_key;

  const addon = orgAddonForPlan(planKey);
  if (!addon) {
    // A live subscription on a plan with no extra-org SKU (community, or a
    // future tier not yet in the seed). Same 409 class as above on purpose:
    // from the buyer's side both mean "this group cannot hold extra
    // organisations until its plan changes", and T6 maps one key for both.
    throw new HttpError(409, `Extra organisations are not available on the ${planKey} plan.`);
  }

  const live = await getStripe().subscriptions.retrieve(stripeSubId);
  // Group-wide: there is only ever ONE org-addon item on a subscription
  // (unlike seats, which carry one item per target org), so any match wins.
  const existing = live.items.data.find((it) => isOrgAddonItem(it));

  if (count === 0) {
    // Removal is a DELETE in Stripe — a subscription item cannot hold
    // quantity 0. The webhook then flips the org_addons row to canceled
    // (freeze-not-delete). Removing does not refund mid-cycle.
    if (existing) {
      await getStripe().subscriptionItems.del(existing.id, { proration_behavior: "none" });
    }
    return { subscriptionId, extraOrgs: 0 };
  }

  if (existing) {
    // Raising prorates now; lowering takes effect with no mid-cycle refund —
    // mirrors setExtraSeats' and syncGroupQuantity's proration rule.
    const raising = count > (existing.quantity ?? 0);
    await getStripe().subscriptionItems.update(existing.id, {
      quantity: count,
      proration_behavior: raising ? "create_prorations" : "none",
    });
  } else {
    const priceId = await resolveOrgAddonPriceId(planKey);
    await getStripe().subscriptionItems.create({
      subscription: stripeSubId,
      price: priceId,
      quantity: count,
      proration_behavior: "create_prorations",
      // Group-wide: no target_org_id (unlike a seat item). The webhook reads
      // feature_key off THIS metadata only as the unexpanded-price fallback
      // match (isOrgAddonItem primarily matches on lookup_key) — dropping the
      // stamp would silently cost the customer a cap they paid for.
      metadata: { feature_key: addon.featureKey },
    });
  }

  return { subscriptionId, extraOrgs: count };
}
