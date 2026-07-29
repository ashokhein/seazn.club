import "server-only";
import crypto from "node:crypto";
import { sql } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { AuthError } from "@/lib/errors";
import type { User } from "@/lib/types";

export type StaffRole = "support" | "superadmin";

export interface StaffUser extends User {
  is_staff: boolean;
  staff_role: StaffRole | null;
}

/** Require caller to be staff. Returns full staff user row. */
export async function requireStaff(): Promise<StaffUser> {
  const user = await requireUser();
  const [row] = await sql<StaffUser[]>`
    select id, display_name, email, avatar_url, is_staff, staff_role
    from users where id = ${user.id} limit 1`;
  if (!row?.is_staff) throw new AuthError("Staff access required");
  return row;
}

/** Require caller to be a superadmin. */
export async function requireSuperadmin(): Promise<StaffUser> {
  const staff = await requireStaff();
  if (staff.staff_role !== "superadmin") throw new AuthError("Superadmin access required");
  return staff;
}

/**
 * Actions written to `staff_audit_log` by a CUSTOMER acting on their own
 * account, not by staff (v17 gap #308).
 *
 * The table is the schema's only generic actor+target+detail sink, so two
 * self-service billing effects record themselves here for accountability — a
 * departing organisation's forfeited wallet balance (#285) and the comped plan
 * a `ride_out` detach hands out (#306). Both carry the CUSTOMER as `actor_id`,
 * because the customer is who did it.
 *
 * That is right for the record and wrong for `/admin`, which reads the same
 * table as "what staff did". Unfiltered, a busy day of ordinary detaches reads
 * as staff activity, so the number people glance at to spot unusual staff
 * behaviour is mostly not staff behaviour.
 *
 * These happen to be dot-namespaced where everything `logStaffAction` writes is
 * a bare name, but that convention is enforced nowhere and a future author has
 * no reason to know it. Hence an explicit list, plus a guard test that fails
 * when a direct insert appears with an action that is not on it.
 */
export const CUSTOMER_SELF_SERVICE_AUDIT_ACTIONS = [
  "billing_group.detach_wallet_not_carried",
  "billing_group.detach_comp_granted",
] as const;

/** Record a staff action in the audit log. */
export async function logStaffAction(
  actorId: string,
  action: string,
  targetType: "org" | "user" | "entitlement" | "coupon" | "size_pack" | "platform",
  targetId: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  // sql.json → real jsonb object (a pre-stringified value lands as a jsonb
  // *string* and detail->>'reason' style reads come back empty).
  await sql`
    insert into staff_audit_log (actor_id, action, target_type, target_id, detail)
    values (${actorId}, ${action}, ${targetType}, ${targetId}, ${detail ? sql.json(detail as never) : null})`;
}

/** Create a time-boxed impersonation token (1 hour). */
export async function createImpersonationToken(
  actorId: string,
  targetId: string,
): Promise<string> {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  await sql`
    insert into impersonation_sessions (actor_id, target_id, token, expires_at)
    values (${actorId}, ${targetId}, ${token}, ${expiresAt.toISOString()})`;
  await logStaffAction(actorId, "impersonate_start", "user", targetId);
  return token;
}
