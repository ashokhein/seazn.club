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
import { getLimit } from "@/lib/entitlements";

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
  // Oldest non-suspended live org first; a suspended one only if that is all
  // there is. `status = 'suspended'` orders false (0) before true (1).
  const [pick] = await sql<{ id: string; status: string }[]>`
    select id, status from organizations
     where subscription_id = ${subscriptionId} and deleted_at is null
     order by (status = 'suspended'), created_at
     limit 1`;
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
  return pe?.int_value ?? null;
}

/** Apply a limit resolved by groupOrgLimit to a count read under the lock.
 *  Pure, so it is safe to call from inside a transaction. */
export function assertWithinGroupCap(currentOrgCount: number, limit: number | null): void {
  // null is UNLIMITED; 0 means the plan has no row for the key at all, and both
  // that and a real 1 correctly refuse a group that already holds one org.
  if (limit === null) return;
  if (currentOrgCount + 1 > limit) throw new PaymentRequiredError("orgs.max_owned");
}
