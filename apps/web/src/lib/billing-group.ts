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
 * gets a group at creation (V309 backfilled the rest), so a missing one is a
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
 * The quantity Stripe should be on:
 *
 *     stripe_quantity = max(active_org_count, quantity_paid)
 *
 * Increments prorate and charge immediately. Decrements make no Stripe call and
 * let renewal true them up, which is what makes a removed org's slot reusable at
 * no charge until the period ends — worth up to eleven months on an annual plan.
 *
 * It also removes every refund path: because the quantity never drops mid
 * period, add/remove cycling can only ever cost the customer money it has
 * already agreed to, and can never produce a credit to farm.
 */
export async function billedQuantity(subscriptionId: string): Promise<number> {
  const [row] = await sql<{ quantity_paid: number }[]>`
    select quantity_paid from subscriptions where id = ${subscriptionId}`;
  const paid = row?.quantity_paid ?? 1;
  const active = await activeOrgCount(subscriptionId);
  return Math.max(active, paid);
}

/**
 * Whether adding one more org to this group would need a Stripe quantity bump.
 * False when a previously-freed slot is still paid for, which is exactly the
 * case that must not be charged twice.
 */
export async function needsQuantityIncrease(subscriptionId: string): Promise<boolean> {
  const [row] = await sql<{ quantity_paid: number }[]>`
    select quantity_paid from subscriptions where id = ${subscriptionId}`;
  const paid = row?.quantity_paid ?? 1;
  const active = await activeOrgCount(subscriptionId);
  return active + 1 > paid;
}

/** Groups a user pays for. Usually one; several only after a detach. */
export async function groupIdsOwnedBy(userId: string): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    select id from subscriptions where owner_user_id = ${userId} order by updated_at`;
  return rows.map((r) => r.id);
}

/**
 * Refuse to put another org into a group that is already at its plan's
 * `orgs.max_owned` — community 1, Pro 5, Pro Plus 10 (V309).
 *
 * The limit is resolved through a member org because entitlements are
 * org-addressed; every org in the group resolves the same plan, so any of them
 * answers for the group. An empty group has no cap to exceed.
 *
 * This bounds a GROUP. `assertMayOwnAnotherOrg` bounds a PERSON, and both are
 * enforced: a user holding two community groups would satisfy this check twice
 * over while owning two free orgs.
 *
 * `knownOrgIds` lets a caller that is already inside a transaction holding
 * `select ... for update` on the group pass the membership it read THERE, so
 * the cap is counted against the same snapshot the lock protects. Two
 * concurrent attaches would otherwise both count through this module's own
 * connection and could both see the pre-move state.
 */
export async function assertGroupMayHoldAnotherOrg(
  subscriptionId: string,
  knownOrgIds?: string[],
): Promise<void> {
  const orgIds = knownOrgIds ?? (await orgIdsInGroup(subscriptionId));
  if (orgIds.length === 0) return;
  const limit = await getLimit(orgIds[0], "orgs.max_owned");
  // null is UNLIMITED; 0 means the plan has no row for the key at all, and both
  // that and a real 1 correctly refuse a group that already holds one org.
  if (limit === null) return;
  if (orgIds.length + 1 > limit) throw new PaymentRequiredError("orgs.max_owned");
}
