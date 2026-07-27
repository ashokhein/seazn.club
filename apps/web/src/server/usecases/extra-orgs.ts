import "server-only";
import { getStripe } from "@/lib/stripe";
import { sql } from "@/lib/db";
import { deferred } from "@/lib/deferred";
import { HttpError } from "@/lib/errors";
import { sendExtraOrgAllowanceAlertEmail } from "@/lib/email";
import { hasLiveSubscription } from "@/lib/subscription-status";
import { requireBillingOwner } from "@/server/usecases/billing-manage";
import { orgAddonForPlan, resolveOrgAddonPriceId, isOrgAddonItem } from "@/lib/org-addons";

/** Self-serve bound on the RIDER, not on the business. The group's own plan cap
 *  (10 on Pro Plus today) is far smaller than this; a request for hundreds is a
 *  bug or abuse, not a real purchase. Deliberately NOT the point at which a
 *  human gets involved — that is ORG_ALLOWANCE_ALERT_THRESHOLD below, which
 *  alerts without ever refusing. This one refuses. */
export const MAX_EXTRA_ORGS = 50;

/** Total organisations (plan base + purchased extras) at which a purchase
 *  starts a sales conversation (v17 gap #293 Q2, owner decision 2026-07-27).
 *  Base caps are pro 5 / pro_plus 10, so it trips at roughly 20 / 15 extras.
 *
 *  It is a TOTAL, not a rider count: V314's `orgs.max_owned` seed recorded the
 *  intent that a group of this size "becomes an enterprise conversation rather
 *  than a silent reseller", and that is a statement about how many
 *  organisations exist under one bill — a Pro Plus group reaches it with fewer
 *  purchased riders than a Pro one, which is correct. */
export const ORG_ALLOWANCE_ALERT_THRESHOLD = 25;

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
  const { orgId, subscriptionId } = await requireBillingOwner();

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
  const previousExtraOrgs = existing?.quantity ?? 0;

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
    const raising = count > previousExtraOrgs;
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

  // Enterprise watch (v17 gap #293 Q2). Registered as TAIL WORK: it costs a
  // query and an email send, and the buyer's request must not wait on staff
  // telemetry — nor can it fail for it (deferred swallows, and
  // maybeAlertOrgAllowance is wrapped in its own right). Deliberately AFTER
  // the Stripe mutation succeeded: an alert about a purchase that did not
  // happen is worse than no alert.
  deferred(() =>
    maybeAlertOrgAllowance({
      subscriptionId,
      orgId,
      planKey,
      extraOrgs: count,
      previousExtraOrgs,
    }),
  );
  return { subscriptionId, extraOrgs: count };
}

/**
 * Does this change warrant a staff alert? Pure, so the rule is testable
 * without a database, Stripe or an inbox.
 *
 * Only a PURCHASE counts — an increase. Dropping from 45 riders to 40 leaves a
 * group far above the threshold but is the opposite of the signal we want, and
 * a no-op re-save is not a sales moment either.
 *
 * `baseCap === null` is an UNLIMITED plan (the resolver's convention): there is
 * no total allowance for a purchase to take to 25, so it is silent rather than
 * always-alerting. Buying riders on an unlimited plan is a separate oddity, and
 * no plan is unlimited on orgs.max_owned today.
 */
export function shouldAlertOnOrgAllowance(opts: {
  baseCap: number | null;
  extraOrgs: number;
  previousExtraOrgs: number;
}): boolean {
  if (opts.extraOrgs <= opts.previousExtraOrgs) return false;
  if (opts.baseCap === null) return false;
  return opts.baseCap + opts.extraOrgs >= ORG_ALLOWANCE_ALERT_THRESHOLD;
}

/**
 * Best-effort staff alert (v17 gap #293): a purchase just took a billing
 * group's TOTAL organisation allowance to ORG_ALLOWANCE_ALERT_THRESHOLD or
 * more. NEVER THROWS — a telemetry failure must not fail a purchase Stripe has
 * already accepted (the same discipline as maybeAlertExpensiveRun and every
 * other post-commit alert here). Silent when `STAFF_ALERT_EMAIL` is unset,
 * matching every other alert in billing-events.ts / ai-runs-admin.ts.
 *
 * Exported so the never-throws contract can be tested DIRECTLY rather than
 * through deferred()'s own swallow, which would hide a missing wrapper.
 */
export async function maybeAlertOrgAllowance(opts: {
  subscriptionId: string;
  orgId: string;
  planKey: string;
  extraOrgs: number;
  previousExtraOrgs: number;
}): Promise<void> {
  try {
    // Cheap guards FIRST: the common case is an unconfigured alert address or
    // an ordinary small purchase, and neither should pay for a query.
    const alertTo = process.env.STAFF_ALERT_EMAIL;
    if (!alertTo) return;
    if (opts.extraOrgs <= opts.previousExtraOrgs) return;

    // The plan's own cap, READ rather than assumed: hardcoding "pro 5" here
    // would make the threshold silently wrong the day a base cap moves.
    const [row] = await sql<{ int_value: number | null }[]>`
      select int_value from plan_entitlements
       where plan_key = ${opts.planKey} and feature_key = 'orgs.max_owned'`;
    // No row at all means this plan grants the feature nothing — not
    // "unlimited". Only an explicit NULL int_value is unlimited.
    if (!row) return;
    const baseCap = row.int_value;
    if (
      !shouldAlertOnOrgAllowance({
        baseCap,
        extraOrgs: opts.extraOrgs,
        previousExtraOrgs: opts.previousExtraOrgs,
      })
    ) {
      return;
    }
    // shouldAlertOnOrgAllowance already answers false for a null (unlimited)
    // baseCap — this is a narrowing for the compiler, not a second rule.
    if (baseCap === null) return;

    await sendExtraOrgAllowanceAlertEmail({
      to: alertTo,
      subscriptionId: opts.subscriptionId,
      orgId: opts.orgId,
      planKey: opts.planKey,
      baseCap,
      extraOrgs: opts.extraOrgs,
      previousExtraOrgs: opts.previousExtraOrgs,
      totalAllowance: baseCap + opts.extraOrgs,
      threshold: ORG_ALLOWANCE_ALERT_THRESHOLD,
    });
  } catch (err) {
    console.error(
      `[billing] extra-org allowance alert failed (group ${opts.subscriptionId})`,
      err,
    );
  }
}
