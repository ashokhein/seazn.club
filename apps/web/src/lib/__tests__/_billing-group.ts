// Fixture helper for billing groups (V310).
//
// Billing moved off the org: `subscriptions` is now the GROUP (its own id,
// its own owner_user_id payer) and `organizations.subscription_id` points at
// it. The old fixture one-liner
//
//   insert into subscriptions (org_id, plan_key, status) values (..)
//   on conflict (org_id) do update set plan_key = ..
//
// therefore has no direct translation: there is no org_id to conflict on, and
// the insert alone leaves the org pointing nowhere. `setOrgPlan` is that
// upsert's replacement — one org, one group of its own, idempotent.
//
// Fixtures that need extra subscription columns (stripe ids, comped_until,
// dated status_changed_at, ...) write the CTE inline instead; only the plain
// plan/status case lives here.
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";

/** A throwaway user to carry subscriptions.owner_user_id for orgs seeded
 *  without any member (see setOrgPlan). */
async function makePayer(): Promise<string> {
  const [user] = await sql<{ id: string }[]>`
    insert into users (email, display_name)
    values (${`group-payer-${randomUUID().slice(0, 12)}@test.local`}, 'Group Payer')
    returning id`;
  return user!.id;
}

/**
 * Put `orgId` on `plan` in a billing group of its OWN.
 *
 * Idempotent: if the org already points at a group (every org created through
 * createOrgForUser does — a community one), that group is repriced in place
 * rather than orphaned, which is what `on conflict (org_id) do update` used to
 * do. The payer is the org's owner member, falling back to created_by.
 *
 * @returns the subscription (group) id.
 */
export async function setOrgPlan(orgId: string, plan = "pro", status = "active"): Promise<string> {
  const [org] = await sql<{ subscription_id: string | null; owner: string | null }[]>`
    select o.subscription_id,
           coalesce(
             (select m.user_id from org_members m
               where m.org_id = o.id and m.role = 'owner'
               order by m.created_at limit 1),
             o.created_by,
             (select m.user_id from org_members m
               where m.org_id = o.id order by m.created_at limit 1)) as owner
      from organizations o
     where o.id = ${orgId}`;
  if (!org) throw new Error(`setOrgPlan: no organization ${orgId}`);

  if (org.subscription_id) {
    await sql`
      update subscriptions set plan_key = ${plan}, status = ${status}
       where id = ${org.subscription_id}`;
    return org.subscription_id;
  }
  // Most engine/usecase fixtures seed a bare `insert into organizations (name,
  // slug)` with no user at all — their AuthCtx carries userId: null. There is
  // genuinely no owner to bill, so mint one rather than relax owner_user_id
  // (NOT NULL by design: an ownerless group cannot be billed or managed). The
  // org row is left untouched — nothing is claiming this user OWNS the org.
  const payer = org.owner ?? (await makePayer());
  const [group] = await sql<{ id: string }[]>`
    insert into subscriptions (owner_user_id, plan_key, status)
    values (${payer}, ${plan}, ${status})
    returning id`;
  await sql`update organizations set subscription_id = ${group!.id} where id = ${orgId}`;
  return group!.id;
}

/** The group `orgId` bills through, or null if it has none. */
export async function orgGroupId(orgId: string): Promise<string | null> {
  const [row] = await sql<{ subscription_id: string | null }[]>`
    select subscription_id from organizations where id = ${orgId}`;
  return row?.subscription_id ?? null;
}
