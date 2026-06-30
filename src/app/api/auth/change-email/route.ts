import crypto from "node:crypto";
import { sql } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { handler, HttpError } from "@/lib/http";
import { changeEmailSchema } from "@/lib/types";
import { sendEmailChangeConfirmation, sendEmailChangeNotice } from "@/lib/email";
import { baseUrl } from "@/lib/oauth";

/** Request an email-address change. Sends a confirmation link to the new address. */
export async function POST(req: Request) {
  return handler(async () => {
    const user = await requireUser();
    const { new_email } = changeEmailSchema.parse(await req.json());

    if (new_email.toLowerCase() === user.email.toLowerCase()) {
      throw new HttpError(400, "New email is the same as your current email");
    }

    // Reject if new address is already taken by another account
    const [existing] = await sql<{ id: string }[]>`
      select id from users where lower(email) = lower(${new_email}) limit 1`;
    if (existing) throw new HttpError(409, "That email address is already in use");

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 h

    // Invalidate any prior pending requests for this user
    await sql`delete from email_change_requests where user_id = ${user.id} and not confirmed`;

    await sql`
      insert into email_change_requests (user_id, old_email, new_email, token, expires_at)
      values (${user.id}, ${user.email}, ${new_email}, ${token}, ${expiresAt.toISOString()})`;

    const link = `${baseUrl(req)}/api/auth/change-email/confirm?token=${token}`;
    await sendEmailChangeConfirmation(new_email, link);
    await sendEmailChangeNotice(user.email, new_email);

    return { message: "A confirmation link has been sent to your new email address." };
  });
}
