import crypto from "node:crypto";
import { sql } from "@/lib/db";
import { requireStaff, logStaffAction } from "@/lib/admin";
import { handler, HttpError } from "@/lib/http";
import { sendVerificationEmail } from "@/lib/email";
import { baseUrl } from "@/lib/oauth";

/** Resend email verification link on behalf of a user. Support or superadmin. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handler(async () => {
    const { id } = await params;
    const staff = await requireStaff();

    const [user] = await sql<{ id: string; email: string; email_verified: boolean }[]>`
      select id, email, email_verified from users where id = ${id} and deleted_at is null`;
    if (!user) throw new HttpError(404, "User not found");
    if (user.email_verified) throw new HttpError(400, "Email already verified");

    // Invalidate old tokens and issue a fresh one
    await sql`delete from email_verifications where user_id = ${id}`;
    const token = crypto.randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await sql`
      insert into email_verifications (user_id, token, expires_at)
      values (${id}, ${token}, ${expires.toISOString()})`;

    const link = `${baseUrl(req)}/api/auth/verify-email?token=${token}`;
    await sendVerificationEmail(user.email, link);
    await logStaffAction(staff.id, "resend_verification", "user", id);

    return { ok: true };
  });
}
