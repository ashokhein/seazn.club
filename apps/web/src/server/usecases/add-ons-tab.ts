import "server-only";
import { sql } from "@/lib/db";
import { walletIdFor } from "@/lib/credits";
import {
  capacityBasis,
  groupOrgLimit,
  MAX_EXTRA_ORGS,
  purchasedCapacity,
  ridersInUse,
} from "@/lib/billing-group";
import { hasLiveSubscription } from "@/lib/subscription-status";
import { ORG_ADDON_FEATURE_KEY, orgAddonForPlan, orgAddonPriceMinor } from "@/lib/org-addons";
import type { Currency } from "@/lib/currency";

/**
 * The Add-ons tab's view model (v17 gap #293, SPEC-6 §A5).
 *
 * SCOPE, STATED PLAINLY SO NOBODY READS THIS AS A PARTIAL MOCK: today this
 * covers the extra-ORGANISATION rider and nothing else. SPEC-6 §A5 also draws a
 * seat picker and a size-pack list, but neither has ever had a UI — grepping
 * `apps/web/src/components` and `apps/web/src/app` for `setExtraSeats` /
 * `size-pack-checkout` finds zero call sites; both have been API-only since they
 * shipped, and building them is not #293's job. The route and nav are named
 * "Add-ons" (plural) so those rows land here later without a rename; there are
 * deliberately no "coming soon" placeholders for them.
 */
export interface AddOnsTabView {
  /** Raw `plan_key` on the group's subscription row — the same basis
   *  `setExtraOrgs` prices from, NOT the resolver's degraded effective plan. */
  planKey: string;
  isPayer: boolean;
  hasLiveSubscription: boolean;
  /** Can THIS plan buy the rider at all? False for community. */
  addonAvailable: boolean;
  /**
   * The organisations this bill CURRENTLY COVERS: plan-or-override base plus
   * every counting add-on, read without the entitlement resolver
   * (`purchasedCapacity`). null is unlimited, or a group with no live org.
   *
   * Deliberately NOT `groupOrgLimit`. That number governs ADMISSION and is
   * allowed to degrade — in dunning it collapses to the community cap, so a Pro
   * group with 5 organisations and 2 riders would render "using 5 of 1" beside
   * a stepper sitting at 2. The page states what the customer bought; the
   * degradation is surfaced as `capReduced` instead, in words.
   */
  orgCap: number | null;
  /**
   * The resolver's admission cap is BELOW what the group holds — dunning past
   * its 14-day grace, a never-paid first invoice, an expired trial, a suspended
   * organisation. Means "you cannot ADD an organisation right now", never "you
   * bought less than you thought".
   *
   * A boolean, not a second number: two caps on one screen is the confusion
   * this whole shape exists to avoid. It must NOT disable the control —
   * cancelling a rider they can no longer afford is exactly what a customer in
   * this state is here to do.
   */
  capReduced: boolean;
  liveOrgCount: number;
  /**
   * Riders the group is billed for right now — `status = 'active'` org_addons
   * only, so an admin comp (`status = 'granted'`, SPEC-3) never appears in the
   * stepper the customer can cancel. It still counts toward `orgCap`, because
   * it is real capacity.
   */
  extraOrgCount: number;
  /** Lowest count a reduction may go to, so the route's 423 is a backstop
   *  rather than the first thing a customer meets. */
  minExtraOrgs: number;
  /** The route's own ceiling, passed down rather than restated client-side. */
  maxExtraOrgs: number;
  /** One rider's MONTHLY price in `currency`'s minor units, from the SKU Stripe
   *  bills — null when the plan has no rider to sell. */
  priceMinor: number | null;
}

/**
 * @param userId the viewer, or null for a caller with no user behind it (an
 *   API key). Nullable because `AuthCtx.userId` is, and because the comparison
 *   below would otherwise be a trap: `subscriptions.owner_user_id` is nullable
 *   too, so `null === null` would silently make a keyed caller the payer.
 * @param currency resolved by the caller (`preferredCurrency` needs a request
 *   scope). Required, so every call site names the currency it is quoting and
 *   the wiring is testable without one.
 */
export async function getAddOnsTab(
  orgId: string,
  userId: string | null,
  currency: Currency,
): Promise<AddOnsTabView> {
  const walletId = await walletIdFor(orgId);
  const [group] = await sql<
    {
      plan_key: string;
      owner_user_id: string | null;
      stripe_subscription_id: string | null;
      status: string | null;
    }[]
  >`select plan_key, owner_user_id, stripe_subscription_id, status
      from subscriptions where id = ${walletId}`;
  // An org with no subscription row is a group-of-one whose wallet id is its
  // own org id (walletIdFor); community is the honest plan for it.
  const planKey = group?.plan_key ?? "community";

  const [basis, admissionCap, riderRows] = await Promise.all([
    capacityBasis(walletId, planKey, ORG_ADDON_FEATURE_KEY),
    // Read ONLY to detect degradation, never to render a number. Deriving the
    // displayed cap from it is the bug this call exists to expose.
    groupOrgLimit(walletId),
    // SUM, not `qty` of the first row: `setExtraOrgs` reconciles a set of items
    // because two concurrent calls can each create one, so a duplicate is a
    // representable state and reading one row would understate what the
    // customer is paying for. `target_org_id is null` matches what the webhook
    // writes for a group-wide rider (billing-events.ts), so a seat or a
    // competition-scoped grant on the same wallet can never be counted here.
    sql<{ qty: number }[]>`
      select coalesce(sum(qty), 0)::int as qty from org_addons
       where wallet_id = ${walletId} and feature_key = ${ORG_ADDON_FEATURE_KEY}
         and target_org_id is null and target_competition_id is null
         and status = 'active'`,
  ]);

  const orgCap = purchasedCapacity(basis);
  const extraOrgCount = riderRows[0]?.qty ?? 0;

  return {
    planKey,
    isPayer: !!userId && !!group?.owner_user_id && group.owner_user_id === userId,
    hasLiveSubscription: hasLiveSubscription(
      group
        ? { stripe_subscription_id: group.stripe_subscription_id, status: group.status }
        : undefined,
    ),
    addonAvailable: !!orgAddonForPlan(planKey),
    orgCap,
    // A null ADMISSION cap is unlimited — the resolver being more generous than
    // the receipt, which is not a reduction. A null PURCHASED cap is unlimited
    // too, and a finite admission cap below it IS a reduction: today no plan
    // grants unlimited `orgs.max_owned`, so `orgCap === null` only happens
    // alongside an unlimited override that survives degradation and the two
    // agree anyway — but nothing pins that, and this ordering stays correct if
    // an unlimited plan ever ships.
    capReduced: admissionCap !== null && (orgCap === null || admissionCap < orgCap),
    liveOrgCount: basis.liveOrgs,
    extraOrgCount,
    minExtraOrgs: ridersInUse(basis, extraOrgCount),
    maxExtraOrgs: MAX_EXTRA_ORGS,
    priceMinor: orgAddonPriceMinor(planKey, currency),
  };
}
