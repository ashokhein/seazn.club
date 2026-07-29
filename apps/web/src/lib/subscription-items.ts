import type Stripe from "stripe";
import { isSeatAddonItem } from "@/lib/seat-addons";
import { isOrgAddonItem } from "@/lib/org-addons";

/**
 * The PLAN item on a group's Stripe subscription.
 *
 * `items.data[0]` used to be an acceptable shorthand for this and is not any
 * more (#329). A group with an extra-organisation rider carries two items,
 * Stripe does not promise which comes first, and the two report DIFFERENT
 * `current_period_end` values — measured at 2027-07-27 (annual plan) against
 * 2026-08-27 (monthly rider) on one live test-mode subscription. Persisting
 * the wrong one dates an annual group eleven months early.
 *
 * Identified by ELIMINATION, because that is the direction that stays correct
 * as add-on families are added: every add-on family carries a metadata marker
 * (`target_org_id` + `members.max` for seats, `feature_key` for org riders) and
 * the plan item carries neither. A new add-on family that forgets to teach its
 * predicate here shows up as a plan item — loudly wrong at the first period
 * end — rather than as a silently mis-picked one.
 *
 * Returns null rather than falling back to `data[0]`. A subscription with no
 * identifiable plan item is a state we do not understand, and guessing there
 * is how the wrong period end got written in the first place — callers decide
 * whether that is a 500 or a skip, visibly.
 */
export function planItem(sub: Stripe.Subscription): Stripe.SubscriptionItem | null {
  for (const item of sub.items?.data ?? []) {
    if (isSeatAddonItem(item)) continue;
    if (isOrgAddonItem(item)) continue;
    return item;
  }
  return null;
}
