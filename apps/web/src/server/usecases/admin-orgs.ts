import "server-only";
// Staff moderation actions on an organization (v3/08 §1). Billing-shaped staff
// tools live in admin-plan.ts; this file is the moderation side, which is
// deliberately kept away from the money — see setOrgSuspension.
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { logStaffAction } from "@/lib/admin";

export type SuspensionAction = "suspend" | "reactivate";

/**
 * Suspend or reactivate an organization.
 *
 * organizations.status ONLY. Suspension used to also stamp
 * subscriptions.status = 'suspended', which was harmless while a subscription
 * belonged to exactly one org. Since V314 a subscription is a shared BILLING
 * GROUP: writing to it would stop billing and degrade entitlements for every
 * OTHER org in the group — orgs that may belong to uninvolved people and have
 * done nothing wrong. Suspension is moderation, not billing, so the money and
 * the plan are left completely alone and a suspended org keeps counting toward
 * the group's paid quantity (billing-group.ts activeOrgCount).
 */
export async function setOrgSuspension(
  actorId: string,
  orgId: string,
  action: SuspensionAction,
  reason: string,
): Promise<"suspended" | "active"> {
  const newStatus = action === "suspend" ? "suspended" : "active";
  // `returning id`, and a throw when it comes back empty. The route in front of
  // this looks the org up and 404s first, so today the update always matches —
  // but that guard belongs to the route, not to this function, and the next
  // caller (a cron, a staff script, a second route) inherits none of it. Without
  // this, an unknown or already-deleted org id updates zero rows and the use
  // case still busts a cache, writes a staff-action log naming an org that was
  // never touched, and RETURNS the status as though it had applied it. Failing
  // here keeps the audit log truthful; the route's own 404 still fires first and
  // its semantics are unchanged.
  const [row] = await sql<{ id: string }[]>`
    update organizations set status = ${newStatus} where id = ${orgId} returning id`;
  if (!row) throw new Error(`setOrgSuspension: no organization ${orgId}`);

  // organizations.status is a resolver INPUT — `when o.status = 'suspended'
  // then 'community'` is the first arm of both orgPlanKey and the SQL
  // org_has_feature — and resolved answers cache for ENT_TTL_SECONDS (300s).
  // Without this the suspension took up to 5 minutes to bite, and an
  // unsuspension took up to 5 minutes to give the org back. Org-scoped, not
  // group-scoped: suspension is moderation of ONE org and must not disturb the
  // siblings sharing its billing group.
  //
  // Fail-open by construction: cacheDelPattern swallows every Redis error, so
  // no try/catch. Deliberately AFTER the write and outside any transaction — a
  // cache bust must never be able to roll the moderation action back.
  await invalidateOrgEntitlements(orgId);

  await logStaffAction(actorId, action, "org", orgId, { reason });
  return newStatus;
}
