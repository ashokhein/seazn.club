import { sql } from "@/lib/db";
import { createSession, postAuthLanding, verifyPassword } from "@/lib/auth";
import { stampTermsAcceptance } from "@/lib/legal";
import { handler } from "@/lib/http";
import { baseUrl } from "@/lib/oauth";
import { sendVerificationEmail } from "@/lib/email";
import { createVerificationToken } from "@/lib/verification";
import { loginSchema } from "@/lib/types";
import { rateLimit, AUTH_LIMIT } from "@/lib/rate-limit";
import { headers } from "next/headers";

export async function POST(req: Request) {
  return handler(async () => {
    const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    await rateLimit(`login:${ip}`, AUTH_LIMIT);

    const body = await req.json();
    const { email, password } = loginSchema.parse(body);
    const next = (body as { next?: unknown })?.next;
    const rows = await sql<
      {
        id: string;
        password_hash: string | null;
        display_name: string;
        email: string;
        email_verified: boolean;
      }[]
    >`select id, password_hash, display_name, email, email_verified
      from users where email = ${email} limit 1`;
    const user = rows[0];
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      throw new Error("Invalid email or password");
    }

    // Password accounts must verify their email first. Re-send the link so a
    // user who lost the email can recover without a separate step.
    if (!user.email_verified) {
      const token = await createVerificationToken(user.id);
      await sendVerificationEmail(
        user.email,
        `${baseUrl(req)}/verify-email?token=${token}`,
      );
      throw new Error(
        "Your email isn't verified yet — we've re-sent the verification link.",
      );
    }

    await createSession(user.id);
    // Login happened under the clickwrap notice (GDPR spec 2026-07-14) —
    // backfills pre-policy accounts; no-op once stamped.
    await stampTermsAcceptance(user.id);

    const landing = await postAuthLanding(user.id, next);
    return {
      id: user.id,
      email: user.email,
      display_name: user.display_name,
      has_org: landing.hasOrg,
      redirect: landing.redirect,
    };
  });
}
