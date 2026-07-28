import "server-only";
// Billing groups (spec 2026-07-21 billing-groups §"The model"): a subscription
// row IS the group, and organizations.subscription_id points at it. This module
// owns the org <-> group lookups and the one quantity rule, so the ~20 call
// sites that used to say `where org_id = $1` have a single place to go through
// instead of each inventing its own join.
//
// Deliberately NOT here: anything that talks to Stripe (lib/billing.ts,
// server/usecases/billing-manage.ts) and anything that resolves entitlements
// (lib/entitlements.ts, which stays a leaf module). This is lookups and
// arithmetic only, so it can be imported from either side without a cycle.
import { sql } from "@/lib/db";
import { HttpError, PaymentRequiredError } from "@/lib/errors";
import {
  addonBonusForWallet,
  addonBonusForWalletByStatus,
  getLimit,
  overrideRow,
} from "@/lib/entitlements";

/** The group an org bills through, or null if it has none. */
export async function subscriptionIdForOrg(orgId: string): Promise<string | null> {
  const [row] = await sql<{ subscription_id: string | null }[]>`
    select subscription_id from organizations where id = ${orgId}`;
  return row?.subscription_id ?? null;
}

/**
 * The group an org bills through. Throws rather than returning null: every org
 * gets a group at creation (V310 backfilled the rest), so a missing one is a
 * broken invariant, not a state a caller should branch on.
 */
export async function requireSubscriptionIdForOrg(orgId: string): Promise<string> {
  const id = await subscriptionIdForOrg(orgId);
  if (!id) throw new HttpError(500, "Organisation has no billing group");
  return id;
}

/** Every org billing through a group, including suspended and soft-deleted. */
export async function orgIdsInGroup(subscriptionId: string): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    select id from organizations where subscription_id = ${subscriptionId} order by created_at`;
  return rows.map((r) => r.id);
}

/** Orgs that still exist — the set the bill, the cap and the plan all resolve
 *  against. Same predicate as activeOrgCount, which is the point. */
export async function liveOrgIdsInGroup(subscriptionId: string): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    select id from organizations
     where subscription_id = ${subscriptionId} and deleted_at is null
     order by created_at`;
  return rows.map((r) => r.id);
}

/**
 * Orgs that count toward the bill.
 *
 * A SUSPENDED org still counts, deliberately: suspension is moderation, not
 * billing, and the customer keeps paying for the slot. Only soft-deleted orgs
 * stop counting — and even then the deferred-decrement rule below means the
 * money does not move until renewal.
 */
export async function activeOrgCount(subscriptionId: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n from organizations
     where subscription_id = ${subscriptionId} and deleted_at is null`;
  return Number(row?.n ?? 0);
}

/**
 * Seats to BUY at checkout: `max(active_org_count, quantity_paid)`.
 *
 * Note this is not the same number as the live subscription's item quantity,
 * which syncGroupQuantity keeps on the plain active count (Stripe cuts renewal
 * invoices from that item, so a quantity we never lower is a quantity that never
 * comes down). The two differ only inside a period where a slot has been paid
 * for and freed, and the difference is deliberate: a re-add costs nothing, but a
 * NEW subscription cannot inherit the old one's paid slots, so a re-buy quotes
 * the higher of the two and `quantity_paid` is reset when a subscription dies.
 *
 * Direction of travel is where the money is; see syncGroupQuantity for the
 * proration rules that keep add/remove cycling from ever producing a credit.
 */
export async function billedQuantity(subscriptionId: string): Promise<number> {
  const [row] = await sql<{ quantity_paid: number }[]>`
    select quantity_paid from subscriptions where id = ${subscriptionId}`;
  const paid = row?.quantity_paid ?? 1;
  const active = await activeOrgCount(subscriptionId);
  return Math.max(active, paid);
}

// `needsQuantityIncrease` lived here and was deleted rather than kept "for the
// UI": it had no callers and it answered `active + 1 > quantity_paid`, which is
// not the test syncGroupQuantity actually applies (that also weighs what Stripe
// currently holds). A second, unused statement of the pricing rule is a trap —
// whoever wires up an "adding this org will cost you $9" label would have got a
// different answer from the one the charge uses.

/** Groups a user pays for. Usually one; several only after a detach. */
export async function groupIdsOwnedBy(userId: string): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    select id from subscriptions where owner_user_id = ${userId} order by updated_at`;
  return rows.map((r) => r.id);
}

/**
 * Refuse to put another org into a group that is already at its plan's
 * `orgs.max_owned` — community 1, Pro 5, Pro Plus 10 (V310).
 *
 * The limit is resolved through a member org because entitlements are
 * org-addressed; every org in the group resolves the same plan, so any of them
 * answers for the group. An empty group has no cap to exceed.
 *
 * This bounds a GROUP. `assertMayOwnAnotherOrg` bounds a PERSON, and both are
 * enforced: a user holding two community groups would satisfy this check twice
 * over while owning two free orgs.
 *
 * NOT callable from inside a transaction — see groupOrgLimit.
 *
 * Has no production caller left: both real call sites (attach, createOrgForUser)
 * need the count taken under a row lock, so they use groupOrgLimit +
 * assertWithinGroupCap directly. It survives because it is a pure COMPOSITION of
 * those same two primitives rather than a second statement of the rule — unlike
 * the deleted `needsQuantityIncrease`, it cannot drift from what production
 * enforces — and because it keeps the cap independently testable.
 */
export async function assertGroupMayHoldAnotherOrg(subscriptionId: string): Promise<void> {
  // LIVE orgs only, matching activeOrgCount. A soft-deleted org bills nothing
  // and holds no quota, so counting it would refuse a Pro group its fifth real
  // org because two dead ones still carry the pointer — and resolving the
  // group's limit through a deleted org is the wrong org to ask.
  const orgIds = await liveOrgIdsInGroup(subscriptionId);
  if (orgIds.length === 0) return;
  const limit = await groupOrgLimit(subscriptionId);
  assertWithinGroupCap(orgIds.length, limit);
}

/**
 * The member organisation whose per-org entitlements speak for the WHOLE
 * group's `orgs.max_owned` — the oldest live one that is NOT suspended, and a
 * suspended one only if that is all there is.
 *
 * Extracted so there is exactly ONE statement of "which org answers for the
 * group's cap". `groupOrgLimit` resolves the cap through it; `extraOrgsInUse`
 * (server/usecases/extra-orgs.ts) reads that org's `org_entitlement_overrides`
 * row through it. A second copy of this pick would let the purchase floor and
 * the admission cap silently disagree about which override applies.
 */
export async function groupCapResolvingOrg(
  subscriptionId: string,
): Promise<{ id: string; status: string } | null> {
  // `status = 'suspended'` orders false (0) before true (1).
  const [pick] = await sql<{ id: string; status: string }[]>`
    select id, status from organizations
     where subscription_id = ${subscriptionId} and deleted_at is null
     order by (status = 'suspended'), created_at
     limit 1`;
  return pick ?? null;
}

/**
 * The group's `orgs.max_owned`, resolved WITHOUT a transaction. null means
 * unlimited, or that there is no member org to resolve a plan through.
 *
 * Split out because `getLimit` queries through this module's own pool
 * connection (and Redis), and calling it from inside a `sql.begin` acquires a
 * SECOND connection while the first holds row locks. `DB_POOL_MAX` defaults to
 * 5 and postgres.js queues acquisitions with no timeout, so five concurrent
 * attaches would deadlock the whole process's database access — not just
 * billing. Callers that need the cap under a lock resolve it here first and
 * apply it with assertWithinGroupCap inside the transaction.
 *
 * Resolved through a NON-SUSPENDED org, deliberately. The cap is a property of
 * the GROUP's plan, but `getLimit` runs the org entitlement resolver, and that
 * resolver maps a suspended org to `community` (moderation, scoped to one org).
 * Asking the oldest org for the cap therefore let a single suspended club shrink
 * the WHOLE group to the community cap of 1 — a Pro group with a suspended
 * eldest read "Room for 1" and refused every attach — which is precisely the
 * sibling degradation every other path here bends over backwards to avoid. So
 * the resolving org is the oldest one that is NOT suspended.
 */
export async function groupOrgLimit(subscriptionId: string): Promise<number | null> {
  const pick = await groupCapResolvingOrg(subscriptionId);
  if (!pick) return null;
  if (pick.status !== "suspended") return getLimit(pick.id, "orgs.max_owned");

  // Every live org is suspended: the resolver would answer community for all of
  // them, so read the group's plan cap straight from plan_entitlements rather
  // than let moderation state set a billing limit. Per-org overrides are lost in
  // this degenerate case, but there is no un-suspended org to carry a meaningful
  // one anyway.
  const [grp] = await sql<{ plan_key: string }[]>`
    select plan_key from subscriptions where id = ${subscriptionId}`;
  if (!grp) return null;
  const [pe] = await sql<{ int_value: number | null }[]>`
    select int_value from plan_entitlements
     where plan_key = ${grp.plan_key} and feature_key = 'orgs.max_owned'`;
  // The plan base is only half the cap (v17 gap #293): the branch above sums
  // purchased extra-organisation add-ons via getLimit, and this one must too, or
  // suspending the last un-suspended org silently revokes capacity the group is
  // paying $9/$19 a month for. `subscriptionId` IS the wallet id, so no org is
  // needed to resolve one — which is the whole point, since none is available.
  //
  // TWO different states reach this short-circuit, and only ONE of them agrees
  // with getLimit. Named separately because a later reader who "tightens" the
  // wrong half breaks the correct one:
  //
  //  - `int_value` NULL = UNLIMITED. Exact parity with getLimit: no add-on can
  //    raise "no cap", so both answer unlimited and skipping the bonus round
  //    trip changes nothing.
  //
  //  - NO ROW AT ALL for the key. NOT parity: getLimit reports a missing row as
  //    base 0 and adds the bonus on top, i.e. it REFUSES; this returns null,
  //    i.e. UNLIMITED. Pre-existing behaviour, unchanged by v17 gap #293 and
  //    reachable only in this degenerate branch (every live org in the group
  //    suspended AND the plan carrying no orgs.max_owned row). Anyone closing
  //    that divergence must close only THIS half.
  if (pe?.int_value == null) return null;
  return pe.int_value + (await addonBonusForWallet(subscriptionId, "orgs.max_owned"));
}

/**
 * Self-serve bound on the extra-organisation RIDER (v17 gap #293). The group's
 * own plan cap (10 on Pro Plus today) is far smaller than this; a request for
 * hundreds is a bug or abuse, not a real purchase. Deliberately NOT the point
 * at which a human gets involved — that is `ORG_ALLOWANCE_ALERT_THRESHOLD`
 * (server/usecases/extra-orgs.ts), which alerts without ever refusing. This one
 * refuses.
 *
 * It lives HERE, beside the capacity arithmetic, rather than in the usecase
 * that enforces it: the Add-ons tab renders it as the control's `max`, and
 * importing it from `server/usecases/extra-orgs` dragged that module's Stripe
 * client and email sender into a view model's graph for the sake of one
 * integer. `setExtraOrgs` re-exports it, so its existing importers are
 * unaffected.
 */
export const MAX_EXTRA_ORGS = 50;

/**
 * The raw ingredients of a group's capacity for ONE cap, read WITHOUT the
 * entitlement resolver (v17 gap #293, Task 6).
 *
 * Lifted out of `extraOrgsInUse` (server/usecases/extra-orgs.ts) so the
 * purchase refusal and the Add-ons tab compute from ONE read instead of two
 * hand-written copies — `entitlements-duplicate-resolvers.test.ts` exists
 * because three places once re-implemented resolution in raw SQL and drifted.
 * It lives here rather than in the usecase because a usecase that reaches
 * Stripe has no business being imported for a number; everything below is
 * `sql` and arithmetic, which is exactly what this module is for.
 *
 * WHY NOT `resolve()` / `getLimit` / `groupOrgLimit`. The resolver applies
 * READ-TIME DEGRADATIONS that have nothing to do with what was bought: it
 * collapses `past_due` beyond 14 days, `incomplete`, an expired `trialing` and
 * a `suspended` ORG to the community plan (lib/entitlements.ts), while
 * `hasLiveSubscription` admits `past_due` and `incomplete`
 * (lib/subscription-status.ts) — so both reach this code. Measured on a Pro
 * group with 5 live organisations and 2 purchased riders: healthy,
 * `groupOrgLimit` is 7; in dunning it is 1. A cap that governs ADMISSION may
 * degrade, because admission is forward-looking. A statement about what the
 * customer ALREADY BOUGHT must not, or the tab reads "using 5 of 1
 * organisations" while the customer's stepper sits at 2, and a reduction is
 * refused with a floor of riders they never purchased.
 *
 * A worthwhile side effect: `resolve()` is Redis-cached for 300 seconds and
 * the add-on sums deliberately are not, so a staff override written to rescue
 * a group takes effect here at once. A refusal that outlives its cause is
 * worse than a stale admission.
 */
export interface CapacityBasis {
  /** The org the cap resolves through (`groupCapResolvingOrg`), or null when
   *  the group holds no live organisation at all. */
  repOrgId: string | null;
  /** The live override's value if there is one, else the plan row's. An
   *  override REPLACES the plan base (`resolve()` returns `int_value:
   *  ov.int_value`, deliberately not a coalesce), including when that value is
   *  NULL — which means UNLIMITED, not "no answer". */
  base: number | null;
  /** No override AND no `plan_entitlements` row: the cap cannot be read. */
  baseUnknown: boolean;
  /** Capacity the group was GIVEN (`status = 'granted'`, SPEC-3) — comps, not
   *  purchases. */
  grantedBonus: number;
  /** Every add-on that COUNTS toward the cap (`active` + `granted`) — the same
   *  sum `getLimit` adds on top of the plan base. */
  totalBonus: number;
  /** Live (not soft-deleted) organisations billing through this group. */
  liveOrgs: number;
}

/**
 * Read a group's capacity ingredients for `featureKey`, bypassing the resolver.
 *
 * Every sum goes through `addonBonusForWallet*`, so the `target_org_id` /
 * `target_competition_id` scope predicates cannot drift from the resolver's —
 * an earlier hand-written copy dropped both, and an add-on granted to a
 * DIFFERENT organisation silently lowered a floor.
 */
export async function capacityBasis(
  subscriptionId: string,
  planKey: string,
  featureKey: string,
): Promise<CapacityBasis> {
  let repOrgId = (await groupCapResolvingOrg(subscriptionId))?.id ?? null;
  let liveOrgs: number;

  if (repOrgId) {
    const [orgs] = await sql<{ n: number }[]>`
      select count(*)::int as n from organizations
       where subscription_id = ${subscriptionId} and deleted_at is null`;
    liveOrgs = orgs?.n ?? 0;
  } else {
    // A GROUP OF ONE whose `organizations.subscription_id` is still null: its
    // wallet id IS its org id (`walletIdFor` = coalesce(subscription_id, id)),
    // so nothing "bills through" it and the lookup above finds no member. The
    // organisation is nonetheless real and on a plan, and answering "no basis"
    // would render its cap as unlimited on a surface whose whole job is to say
    // how many organisations the bill covers. `subscription_id` is a uuid FK to
    // `subscriptions(id)`, so an org id can never collide with a group id and
    // this second lookup is unambiguous.
    const [self] = await sql<{ id: string }[]>`
      select id from organizations where id = ${subscriptionId} and deleted_at is null`;
    repOrgId = self?.id ?? null;
    liveOrgs = self ? 1 : 0;
  }

  // Genuinely nothing to resolve through — a group whose every organisation has
  // been soft-deleted. Nothing can be standing on a rider, and there is no org
  // to carry an override. Same answer groupOrgLimit gives (null).
  if (!repOrgId) {
    return {
      repOrgId: null,
      base: null,
      baseUnknown: false,
      grantedBonus: 0,
      totalBonus: 0,
      liveOrgs: 0,
    };
  }

  // The SAME statement `resolve()` runs, not a copy of it — including the
  // expiry predicate, without which a comp that ended keeps setting the base.
  // This read used to be hand-copied here and the copy is what made the drift
  // possible; `overrideRow` is now the single place it is written.
  //
  // It also selects `bool_value`, and this caller DISCARDS it — deliberately.
  // That column is the on/off half of an entitlement (`hasFeature`), and every
  // cap here is the `int_value` half; a numeric cap has no boolean to read. It
  // is on the row only because `resolve()`, the other caller, coalesces it. Do
  // not wire it into the arithmetic below on the strength of it being fetched.
  const override = await overrideRow(repOrgId, featureKey);

  let base: number | null = null;
  let baseUnknown = false;
  if (override) {
    base = override.int_value;
  } else {
    const [planRow] = await sql<{ int_value: number | null }[]>`
      select int_value from plan_entitlements
       where plan_key = ${planKey} and feature_key = ${featureKey}`;
    if (planRow) base = planRow.int_value;
    else baseUnknown = true;
  }

  const [grantedBonus, totalBonus] = await Promise.all([
    addonBonusForWalletByStatus(subscriptionId, featureKey, ["granted"], repOrgId),
    addonBonusForWallet(subscriptionId, featureKey, repOrgId),
  ]);

  return { repOrgId, base, baseUnknown, grantedBonus, totalBonus, liveOrgs };
}

/**
 * The capacity the group ACTUALLY HOLDS: plan-or-override base plus every
 * counting add-on. `getLimit`'s arithmetic with the degradations left out, so
 * it agrees with `groupOrgLimit` for every healthy group and disagrees only
 * where the resolver has degraded one (dunning, a never-paid first invoice, an
 * expired trial, a suspended org). That disagreement is the signal a surface
 * should surface as "you cannot add more right now", never as a smaller number.
 *
 * null is UNLIMITED — or that there is no organisation to resolve through,
 * matching `groupOrgLimit`'s own null.
 *
 * Pure: takes a basis, does no I/O, so the rule is testable without a database.
 */
export function purchasedCapacity(basis: CapacityBasis): number | null {
  if (!basis.repOrgId) return null;
  // An unreadable base is 0 here, matching getLimit ("Returns 0 if the feature
  // key is not in the plan's entitlement matrix") rather than groupOrgLimit's
  // degenerate suspended-only branch, which answers unlimited. A DISPLAY must
  // not invent capacity; a REFUSAL must not invent usage — which is why
  // `ridersInUse` reads the same field the other way.
  if (basis.baseUnknown) return basis.totalBonus;
  if (basis.base === null) return null;
  return basis.base + basis.totalBonus;
}

/**
 * How many PURCHASED riders the group is actually standing on — the lowest
 * count a reduction may go to.
 *
 *     liveOrgs − base − granted,   clamped to [0, purchased]
 *
 * Admin comps are SUBTRACTED: capacity the group was GIVEN is not capacity it
 * is renting, so a group whose eleventh organisation stands on a comp is using
 * no purchased rider and must never be told to buy one to keep what it was
 * given.
 *
 * THE UPPER CLAMP IS AN INVARIANT, NOT A SAFETY NET. You cannot stand on more
 * riders than you purchased, so a floor above `purchased` is incoherent by
 * construction. It is reachable without anything being broken: caps here are
 * ADMISSION-ONLY (`assertWithinGroupCap` checks `count + 1 > limit` on the way
 * IN and is never re-evaluated against organisations that already exist), so a
 * plan downgrade or an expiring comp leaves a group holding more organisations
 * than its total capacity, and the raw arithmetic then attributes the whole
 * overhang to riders. Task 6 renders this number as a control's lower bound, so
 * an incoherent value here becomes incoherent UI.
 *
 * TWO SEPARATE ZERO-RETURNS, and only one of them is a trade-off:
 *  - **unlimited** (`base === null`, or no member org): 0 is CORRECT BY
 *    DEFINITION — an unlimited cap means riders carry no capacity, so none can
 *    be in use. Not a compromise; do not "tighten" it.
 *  - **`baseUnknown`**: 0 is a deliberate FAIL-OPEN. Treating a missing row as
 *    base 0 would make the floor the entire organisation count and trap every
 *    group on that plan. Refusing on a cap we cannot read is the one
 *    unrecoverable outcome here; leaking a rider is recoverable.
 *
 * @param purchased riders the group is ACTUALLY billed for. Required, not
 *   optional: an optional clamp is a clamp somebody forgets.
 */
export function ridersInUse(basis: CapacityBasis, purchased: number): number {
  if (!basis.repOrgId) return 0;
  if (basis.baseUnknown) return 0;
  if (basis.base === null) return 0;
  const standingOnRiders = basis.liveOrgs - basis.base - basis.grantedBonus;
  return Math.max(0, Math.min(standingOnRiders, purchased));
}

/** Apply a limit resolved by groupOrgLimit to a count read under the lock.
 *  Pure, so it is safe to call from inside a transaction.
 *
 *  `addonAvailable` (v17 gap #293): can the refused plan buy its way past the
 *  cap? Resolved by the caller BEFORE the transaction — same reason `limit`
 *  itself is — so the refusal can point at a real purchase instead of a
 *  dead-end "upgrade". Keeping it a plain argument is what keeps this function
 *  pure and transaction-safe; do not turn it into a lookup here. Defaults to
 *  false (no offer) for the one caller that cannot cheaply know
 *  (assertGroupMayHoldAnotherOrg, which has no production caller left). */
export function assertWithinGroupCap(
  currentOrgCount: number,
  limit: number | null,
  addonAvailable = false,
): void {
  // null is UNLIMITED; 0 means the plan has no row for the key at all, and both
  // that and a real 1 correctly refuse a group that already holds one org.
  if (limit === null) return;
  if (currentOrgCount + 1 > limit) {
    throw new PaymentRequiredError(
      "orgs.max_owned",
      addonAvailable ? { offer: "extra_org" } : undefined,
    );
  }
}
