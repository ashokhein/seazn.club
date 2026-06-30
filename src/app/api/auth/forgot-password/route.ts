import { sql } from "@/lib/db";
import { handler } from "@/lib/http";
import { sendPasswordResetEmail } from "@/lib/email";
import { createPasswordResetToken } from "@/lib/password-reset";
import { baseUrl } from "@/lib/oauth";
import { z } from "zod";
import { rateLimit, EMAIL_LIMIT } from "@/lib/rate-limit";
import { headers } from "next/headers";

const schema = z.object({ email: z.string().email().max(120) }).strict();

export async function POST(req: Request) {
  return handler(async () => {
    const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    await rateLimit(`forgot-password:${ip}`, EMAIL_LIMIT);

    const { email } = schema.parse(await req.json());

    // Always respond the same way — do not reveal whether an email exists.
    const rows = await sql<{ id: string }[]>`
      select id from users where email = ${email} limit 1`;

    if (rows[0]) {
      const token = await createPasswordResetToken(rows[0].id);
      const link = `${baseUrl(req)}/reset-password?token=${token}`;
      await sendPasswordResetEmail(email, link);
    }

    return {
      message:
        "If an account with that email exists you will receive a reset link shortly.",
    };
  });
}
