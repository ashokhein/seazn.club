import { sql } from "@/lib/db";
import { hashPassword, safeNextPath } from "@/lib/auth";
import { stampTermsAcceptance } from "@/lib/legal";
import { handler } from "@/lib/http";
import { baseUrl } from "@/lib/oauth";
import { sendVerificationEmail } from "@/lib/email";
import { createVerificationToken } from "@/lib/verification";
import { signupSchema } from "@/lib/types";
import { rateLimit, AUTH_LIMIT } from "@/lib/rate-limit";
import { headers } from "next/headers";

/** Turn an email into a friendly default display name (the part before @). */
function displayNameFromEmail(email: string): string {
  const local = email.split("@")[0] || "Member";
  const cleaned = local.replace(/[._-]+/g, " ").trim();
  return cleaned
    .split(" ")
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ") || "Member";
}

export async function POST(req: Request) {
  return handler(async () => {
    const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    await rateLimit(`signup:${ip}`, AUTH_LIMIT);

    const body = await req.json();
    const { email, password } = signupSchema.parse(body);
    const next = safeNextPath((body as { next?: unknown })?.next);

    if ((await sql`select 1 from users where email = ${email}`).length)
      throw new Error("An account with that email already exists");

    const password_hash = await hashPassword(password);
    const display_name = displayNameFromEmail(email);
    const [user] = await sql<{ id: string }[]>`
      insert into users (email, password_hash, display_name, email_verified)
      values (${email}, ${password_hash}, ${display_name}, false)
      returning id`;
    // Sign-up happened under the clickwrap notice (GDPR spec 2026-07-14).
    await stampTermsAcceptance(user.id);

    // Email a single-use verification link. The account stays inactive (no
    // session) until the link is opened. A safe `next` (e.g. an invite) is
    // carried through so the user returns to it after verifying.
    const token = await createVerificationToken(user.id);
    const nextQuery = next ? `&next=${encodeURIComponent(next)}` : "";
    const link = `${baseUrl(req)}/verify-email?token=${token}${nextQuery}`;
    const emailSent = await sendVerificationEmail(email, link);

    return {
      needs_verification: true,
      email,
      email_sent: emailSent,
      // Dev convenience so the flow is testable without a verified domain.
      ...(process.env.NODE_ENV !== "production"
        ? { verify_token: token, verify_url: link }
        : {}),
    };
  });
}
