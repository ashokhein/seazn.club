import "server-only";
// Operator allocation console (design/v17-pricing-entitlements/SPEC-5 §1).
//
// A Pro Plus operator (federation/academy/county) runs ONE shared group wallet
// (SPEC-2 §11): every member org spends from the same credit pool. Without a
// control, one member can burn the whole month. `org_credit_allocation` (V329)
// lets the operator set a per-member HARD monthly cap; the cap is ENFORCED at
// spend time inside `reserve()`'s advisory-lock transaction (`lib/credits.ts`).
//
// This module is the WRITE (set/clear a member's cap) + READ (the console data:
// each member's cap, its burn this period, the pool balance) API. The console
// UI itself is SPEC-6 — this is data + gating only.
//
// Gating is PAYER-only, matching every sibling group route (attach/detach/
// transfer): billing belongs to whoever pays for the group
// (`subscriptions.owner_user_id`), never to a member org's owner. The write
// reuses `subscriptionIsOwnedBy` (the exact helper those routes gate on) —
// deriving the group from the target org and asserting the actor is its payer
// checks membership AND authorisation in one, and refuses an org in someone
// else's group with the same 403 the siblings return.
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { balance, spentThisPeriodByOrg } from "@/lib/credits";
import { subscriptionIsOwnedBy } from "@/server/usecases/billing-groups";

export interface MemberAllocation {
  orgId: string;
  orgName: string;
  /** null = unlimited share (an explicit NULL row, or no row at all). */
  monthlyCap: number | null;
  /** Net credits this org has spent from the shared wallet this calendar month
   *  (derived from the ledger — the SAME quantity `reserve()`'s cap checks). */
  spentThisPeriod: number;
}

export interface AllocationConsole {
  /** The group's wallet id (`coalesce(group_subscription_id, org_id)` = the
   *  group subscription id). */
  walletId: string;
  /** Credits in the shared pool right now (`credits.balance`). */
  poolBalance: number;
  members: MemberAllocation[];
}

/**
 * Set (or clear) a member org's monthly credit cap on the shared group wallet.
 * Payer-only.
 *
 * `monthlyCap`:
 *   * a non-negative integer → the hard monthly cap for that member;
 *   * `null` → clear to an unlimited share (an explicit NULL row, NOT a delete —
 *     it keeps the `updated_by`/`updated_at` audit trail, and both NULL and
 *     no-row skip the `reserve()` gate identically, so the auditable form is
 *     strictly better).
 *
 * The group is derived from the target org's own `subscription_id`, then the
 * actor is asserted to be that group's payer via `subscriptionIsOwnedBy` — so
 * an org in a DIFFERENT group (or one the actor doesn't pay for) is refused with
 * the sibling routes' 403, and an org that belongs to no billing group is 404.
 * Upserts on the `(wallet_id, org_id)` PK, so a re-set is idempotent.
 */
export async function setOrgAllocation(
  actorUserId: string,
  targetOrgId: string,
  monthlyCap: number | null,
): Promise<void> {
  if (monthlyCap !== null && (!Number.isInteger(monthlyCap) || monthlyCap < 0)) {
    throw new HttpError(400, "A credit cap must be a non-negative whole number, or null to clear it.");
  }

  const [org] = await sql<{ subscription_id: string | null; deleted_at: Date | null }[]>`
    select subscription_id, deleted_at from organizations where id = ${targetOrgId}`;
  if (!org || org.deleted_at) throw new HttpError(404, "Organisation not found.");
  const walletId = org.subscription_id;
  if (!walletId) throw new HttpError(404, "That organisation is not in a billing group.");

  // The payer gate — the exact helper attach/detach/transfer use. Also proves
  // the org is a member of the actor's group (the wallet was derived from it).
  await subscriptionIsOwnedBy(walletId, actorUserId);

  await sql`
    insert into org_credit_allocation (wallet_id, org_id, monthly_cap, updated_by, updated_at)
    values (${walletId}, ${targetOrgId}, ${monthlyCap}, ${actorUserId}, now())
    on conflict (wallet_id, org_id)
    do update set monthly_cap = ${monthlyCap}, updated_by = ${actorUserId}, updated_at = now()`;
}

/**
 * The operator console for the actor's own group wallet. Payer-only.
 *
 * Lists every member org (`organizations.subscription_id = wallet`, not
 * soft-deleted) with its cap (left-joined from `org_credit_allocation`) and its
 * burn this period (reusing `spentThisPeriodByOrg`, the SAME derive the spend
 * gate checks), plus the shared pool balance. Members are ordered by name.
 *
 * Group resolution: the actor is a payer (`subscriptions.owner_user_id`). A
 * payer may own SEVERAL groups (a real operator group plus group-of-one
 * Community subscriptions — see the `/api/billing/groups` "several groups"
 * case), so this resolves DETERMINISTICALLY to the group with the most live
 * member orgs (id tiebreak) — i.e. the actual operator group. A payer who owns
 * no group with a live org at all gets a 403. (When a payer runs more than one
 * multi-member group, SPEC-6's UI will pass an explicit group; the API's
 * single-group resolution is the sensible default until then.)
 */
export async function allocationConsole(actorUserId: string): Promise<AllocationConsole> {
  const [group] = await sql<{ id: string }[]>`
    select s.id from subscriptions s
     where s.owner_user_id = ${actorUserId}
       and exists (
             select 1 from organizations o
              where o.subscription_id = s.id and o.deleted_at is null)
     order by (
       select count(*) from organizations o
        where o.subscription_id = s.id and o.deleted_at is null
     ) desc, s.id
     limit 1`;
  if (!group) {
    throw new HttpError(403, "Only a billing-group payer can view the allocation console.");
  }
  const walletId = group.id;

  const memberRows = await sql<{ id: string; name: string; monthly_cap: number | null }[]>`
    select o.id, o.name, a.monthly_cap
      from organizations o
      left join org_credit_allocation a
        on a.wallet_id = ${walletId} and a.org_id = o.id
     where o.subscription_id = ${walletId} and o.deleted_at is null
     order by o.name, o.id`;

  const members: MemberAllocation[] = [];
  for (const m of memberRows) {
    members.push({
      orgId: m.id,
      orgName: m.name,
      monthlyCap: m.monthly_cap,
      spentThisPeriod: await spentThisPeriodByOrg(sql, walletId, m.id),
    });
  }

  return { walletId, poolBalance: await balance(walletId), members };
}
