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

/** Record a staff action in the audit log. */
export async function logStaffAction(
  actorId: string,
  action: string,
  targetType: "org" | "user" | "entitlement" | "coupon",
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
