import "server-only";
import { getStripe } from "@/lib/stripe";
import { sql } from "@/lib/db";
import { deferred } from "@/lib/deferred";
import { HttpError } from "@/lib/errors";
import { sendExtraOrgAllowanceAlertEmail } from "@/lib/email";
import { hasLiveSubscription } from "@/lib/subscription-status";
import { capacityBasis, MAX_EXTRA_ORGS, ridersInUse } from "@/lib/billing-group";
import { requireBillingOwner } from "@/server/usecases/billing-manage";
import {
  ORG_ADDON_FEATURE_KEY,
  orgAddonForPlan,
  resolveOrgAddonPriceId,
  isOrgAddonItem,
} from "@/lib/org-addons";

/** Re-exported, not defined here: the bound moved to `lib/billing-group.ts`
 *  beside the capacity arithmetic so the Add-ons tab can render it as the
 *  control's `max` without pulling this module's Stripe client and email sender
 *  into a view model's graph. Existing importers are unaffected — and one
 *  definition means the control's ceiling and the route's refusal cannot
 *  drift. See that declaration for why this refuses where the >= 25 alert does
 *  not. */
export { MAX_EXTRA_ORGS };

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
 *   400 — SESSION / ORG-SELECTION state, and nothing else. `requireBillingOwner`
 *         raises it for "No active organization" and "No billing account for
 *         the selected organization" (billing-manage.ts:130,136), both
 *         reachable from a stale or foreign org cookie. Remedy is "pick an
 *         organisation again". The count refusal deliberately does NOT share
 *         this status — telling someone to fix a number when they need to
 *         reselect an org is the mis-copy this split exists to prevent.
 *   401 — not signed in (AuthError, from requireBillingOwner).
 *   403 — signed in, but not this billing group's payer.
 *   409 — the GROUP cannot hold the add-on at all: no live paid subscription,
 *         or a plan with no extra-org SKU. Remedy is "move to Pro / Pro Plus".
 *   422 — `count` is not an integer in 0..MAX_EXTRA_ORGS, OR the request body
 *         was unparseable (bad JSON, wrong type, unknown field). Remedy is
 *         "choose a different number"; unreachable from a correct control. The
 *         route converts EVERY body-parse failure to this, so a 400 from this
 *         endpoint ALWAYS means org state and junk input never pages anyone.
 *   423 — the reduction would take the group below the organisations it is
 *         ACTUALLY USING. Remedy is "move an organisation out of the group
 *         first" — a different ACTION from 409's "change plan" and from 422's
 *         "pick another number", which is why it is neither. See
 *         `extraOrgsInUse`.
 *   503 — the Stripe catalog has not been synced for this account
 *         (resolveOrgAddonPriceId). Remedy is "try later / contact support".
 *   500 — anything unexpected, notably a Stripe API failure, which escapes
 *         `handler` carrying raw English. T6 needs a generic key for this;
 *         never render the body's `error`.
 *
 * @param count total extra organisations this group should hold beyond its
 *   plan's base cap (0 removes the add-on).
 */
export async function setExtraOrgs(
  count: number,
): Promise<{ subscriptionId: string; extraOrgs: number }> {
  if (!Number.isInteger(count) || count < 0 || count > MAX_EXTRA_ORGS) {
    throw new HttpError(
      422,
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
  // FILTER, not find. "There is only ever one org-addon item" is an
  // assumption, not an invariant: two concurrent calls both see an empty item
  // list and both create one. A `find` would then see only the first, so a
  // cancel would strand the second (billed for ever, invisible to the UI), the
  // previous count would be understated, and the resolver — which SUMS
  // org_addons rows — would quietly hand out double the cap. Every branch
  // below therefore reconciles the whole set down to at most one item.
  const addonItems = live.items.data.filter((it) => isOrgAddonItem(it));
  // The total the customer is actually being billed for, across duplicates.
  // Both the usage floor and the >= 25 alert read this, so a stranded second
  // item cannot make either of them compute against the wrong number.
  const previousExtraOrgs = addonItems.reduce((n, it) => n + (it.quantity ?? 0), 0);

  // The usage floor. Caps here are ADMISSION-ONLY — `assertMayOwnAnotherOrg`
  // and `assertWithinGroupCap` both check `count + 1 > limit` on the way IN and
  // are never re-evaluated against organisations that already exist. Without
  // this, the add-on is optional after month one: buy it, create org #11,
  // cancel it, and the group keeps 11 working organisations while paying for
  // 10 — the "silent reseller" V314__billing_groups.sql:244-245 names.
  //
  // Only REDUCTIONS are checked. Since `extraOrgsInUse` is clamped to the
  // riders actually purchased, this condition is now provably REDUNDANT for
  // correctness — `floor <= previousExtraOrgs`, so `count >= previousExtraOrgs`
  // already implies `count >= floor`. It survives purely to skip three queries
  // on the common increase path; removing it would change no answer.
  if (count < previousExtraOrgs) {
    const floor = await extraOrgsInUse(subscriptionId, planKey, previousExtraOrgs);
    if (count < floor) {
      throw new HttpError(
        423,
        `This billing group is using ${floor} extra organisation(s); it cannot go below that ` +
          `until one is moved out of the group.`,
      );
    }
  }

  if (count === 0) {
    // Removal is a DELETE in Stripe — a subscription item cannot hold
    // quantity 0. The webhook then flips the org_addons row to canceled
    // (freeze-not-delete). Removing does not refund mid-cycle.
    // EVERY item, not just the first: a stranded duplicate would otherwise
    // keep billing after the customer has cancelled.
    for (const item of addonItems) {
      await getStripe().subscriptionItems.del(item.id, { proration_behavior: "none" });
    }
    return { subscriptionId, extraOrgs: 0 };
  }

  // The survivor is an item already on the price for the group's CURRENT plan.
  // Matching on the plan's own lookup_key — not merely on "is an org add-on" —
  // is what makes a tier change re-price. `isOrgAddonItem` matches BOTH tiers'
  // keys, so a Pro group that bought riders at $9 and then upgraded to Pro Plus
  // would otherwise keep paying $9 per rider for ever, and every later purchase
  // would take the update branch and never re-resolve the price. That is the
  // exact "Pro + extras undercuts Pro Plus" arbitrage the two rates exist to
  // close, reached by upgrading rather than by staying put; the mirror case
  // (Pro Plus -> Pro) overcharges instead. Neither is acceptable.
  //
  // A legitimate CURRENT-tier item also fails this match right after a drift
  // replacement, because `transfer_lookup_key` leaves it reporting
  // `lookup_key: null` — so it is deleted and recreated onto the replacement
  // price. That is expected, not a defect: the two prices carry the same
  // amount, so net proration is ~zero, it self-heals on the first call, and the
  // metadata stamp keeps the item inside `addonItems` so it is reconciled
  // rather than stranded — while never letting a keyless item BE the survivor,
  // which is what would freeze it on a dead price.
  const survivor = addonItems.find((it) => it.price?.lookup_key === addon.lookupKey);

  // Resolve the replacement price BEFORE deleting anything. The delete loop is
  // destructive and `resolveOrgAddonPriceId` can throw 503 (catalog not synced
  // for this account), so resolving afterwards meant a tier change against an
  // unsynced catalog deleted the customer's working rider and THEN failed:
  // they were left with no add-on at all and had to retry, having lost the one
  // that worked. Resolving first turns that case into a clean no-op refusal.
  // The remaining window is the `create` call alone; closing that too needs a
  // single `subscriptions.update({ items: [...] })`, which is a follow-up.
  const priceId = survivor ? null : await resolveOrgAddonPriceId(planKey);

  // Everything else goes: duplicates from a concurrent create, AND any item
  // stranded on another tier's price by a plan change.
  for (const item of addonItems) {
    if (survivor && item.id === survivor.id) continue;
    // Prorated, unlike the cancel path above: this is a SWAP, not a customer
    // choosing to stop, so the unused remainder is credited and the
    // replacement charged pro-rata. The customer pays the difference, which is
    // what a plan change does to the plan item itself.
    await getStripe().subscriptionItems.del(item.id, { proration_behavior: "create_prorations" });
  }

  if (survivor) {
    // Raising prorates now; lowering takes effect with no mid-cycle refund —
    // mirrors setExtraSeats' and syncGroupQuantity's proration rule. Measured
    // against the TOTAL previously billed, not the survivor's own quantity, so
    // consolidating duplicates reads as the reduction the customer sees.
    const raising = count > previousExtraOrgs;
    await getStripe().subscriptionItems.update(survivor.id, {
      quantity: count,
      proration_behavior: raising ? "create_prorations" : "none",
    });
  } else {
    await getStripe().subscriptionItems.create({
      subscription: stripeSubId,
      price: priceId!,
      quantity: count,
      proration_behavior: "create_prorations",
      // Group-wide: no target_org_id (unlike a seat item), so feature_key is
      // the whole stamp.
      //
      // NOT optional, and not merely a belt-and-braces fallback. Recognition
      // (isOrgAddonItem) normally goes through price.lookup_key — but a drift
      // replacement moves the key with `transfer_lookup_key`, so an item
      // already riding a live subscription starts reporting
      // `price.lookup_key: null` and recognition falls ENTIRELY to this
      // metadata. T2's sweep cancels every org-addon row whose item it no
      // longer sees, so an unstamped item is silently cancelled and the
      // customer loses a cap they are still paying for. Same reason
      // extra-seats.ts:86 stamps its own. Pinned to the catalog constant the
      // webhook actually compares against, not to the per-entry copy.
      metadata: { feature_key: ORG_ADDON_FEATURE_KEY },
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
 * How many PURCHASED extra organisations this group is actually standing on —
 * the lowest `count` a reduction may go to.
 *
 * A thin wrapper over `capacityBasis` + `ridersInUse` (lib/billing-group.ts),
 * where the whole rule and its rationale now live: the base is the live
 * `org_entitlement_overrides` row else the plan row, read DIRECTLY rather than
 * through `resolve()`/`groupOrgLimit`, because the resolver's read-time
 * degradations (dunning, a never-paid first invoice, an expired trial, a
 * suspended org) would invent riders the customer never bought; admin comps are
 * subtracted; and the result is clamped to what is actually billed.
 *
 * Counts organisations in the **billing group**, not organisations a user owns,
 * because the only exit is `detachOrgFromGroup` — there is no org deletion
 * anywhere in the product (no `deleteOrg`; `/api/orgs/[id]` has PATCH only).
 * Counting the wrong set would leave a customer paying for ever with no way
 * out, which is a far worse failure than the leak this closes.
 *
 * @param purchasedExtraOrgs the riders the group is ACTUALLY billed for — from
 *   Stripe in `setExtraOrgs`, because Stripe is the source of truth for what is
 *   charged and the webhook may be lagging. Required, not optional: an optional
 *   clamp is a clamp somebody forgets.
 *
 *   The clamp is therefore only as good as that retrieve — and a retrieve that
 *   UNDER-reports is not the safe direction here, whatever the general instinct
 *   says. It lowers the floor, and a lower floor lets a reduction through. This
 *   guard's entire job is to refuse a reduction, so permissiveness IS the
 *   failure it defends against: the silent reseller keeps org #11 and stops
 *   paying the rider. (Over-reporting is the recoverable direction — it refuses
 *   a cancellation the customer is entitled to, loudly, with support as the
 *   exit.) What contains it is that `setExtraOrgs` reads the live subscription
 *   ONCE and derives both `previousExtraOrgs` and this argument from that same
 *   read, so the floor cannot disagree with the number being reduced from; a
 *   retrieve that is wrong is wrong about the whole operation, not just about
 *   the clamp.
 *
 * Kept here (rather than moved wholesale) so `setExtraOrgs` reads as one story.
 * The Add-ons tab does NOT call it: `getAddOnsTab` already holds the basis for
 * the capacity it renders, so it calls `ridersInUse` on that same basis instead
 * of paying for the read twice.
 */
export async function extraOrgsInUse(
  subscriptionId: string,
  planKey: string,
  purchasedExtraOrgs: number,
): Promise<number> {
  // The read AND the arithmetic both live in lib/billing-group.ts now (Task 6),
  // because the Add-ons tab renders this floor as a control's lower bound and
  // renders `purchasedCapacity(basis)` beside it. Two hand-written copies of
  // "the base, without the resolver" is precisely the drift
  // entitlements-duplicate-resolvers.test.ts was written about; every rule
  // documented above is now documented on `ridersInUse` and enforced in one
  // place for both callers.
  const basis = await capacityBasis(subscriptionId, planKey, ORG_ADDON_FEATURE_KEY);
  return ridersInUse(basis, purchasedExtraOrgs);
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
