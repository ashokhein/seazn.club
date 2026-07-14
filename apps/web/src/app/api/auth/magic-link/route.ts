import { sql } from "@/lib/db";
import { handler } from "@/lib/http";
import { safeNextPath } from "@/lib/auth";
import { stampTermsAcceptance } from "@/lib/legal";
import { sendMagicLinkEmail } from "@/lib/email";
import { createLoginLink } from "@/lib/login-link";
import { baseUrl } from "@/lib/oauth";
import { z } from "zod";
import { rateLimit, EMAIL_LIMIT } from "@/lib/rate-limit";
import { headers } from "next/headers";

// `next` is the post-login redirect (e.g. /join/{token} invite pages send it);
// it is re-validated by safeNextPath before use.
const schema = z
  .object({
    email: z.string().email().max(120),
    next: z.string().max(500).optional(),
  })
  .strict();

/** Turn an email into a friendly default display name (the part before @). */
function displayNameFromEmail(email: string): string {
  const local = email.split("@")[0] || "Member";
  const cleaned = local.replace(/[._-]+/g, " ").trim();
  return (
    cleaned
      .split(" ")
      .filter(Boolean)
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join(" ") || "Member"
  );
}

/**
 * Resolve the account for `email`, creating an inert one on first sight. The
 * account carries no session and stays unverified until the emailed link is
 * opened, so a create is harmless — this is our passwordless sign-up path.
 */
async function resolveOrCreateUser(email: string): Promise<string | null> {
  const existing = await sql<{ id: string }[]>`
    select id from users where email = ${email} and deleted_at is null limit 1`;
  if (existing[0]) return existing[0].id;

  const created = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${email}, ${displayNameFromEmail(email)}, false)
    on conflict (email) do nothing
    returning id`;
  if (created[0]) return created[0].id;

  // Lost a create race (or the email is held by a soft-deleted row) — re-read.
  const again = await sql<{ id: string }[]>`
    select id from users where email = ${email} and deleted_at is null limit 1`;
  return again[0]?.id ?? null;
}

/** Email a passwordless sign-in link, creating the account if it's new. The
 *  response is identical whether or not the account already existed. */
export async function POST(req: Request) {
  return handler(async () => {
    const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    await rateLimit(`magic-link:${ip}`, EMAIL_LIMIT);

    const body = schema.parse(await req.json());
    const { email } = body;
    const next = safeNextPath(body.next);

    const userId = await resolveOrCreateUser(email);

    let devLink: string | undefined;
    if (userId) {
      // The submit sat under the "By continuing, you agree…" notice (GDPR
      // spec 2026-07-14) — record acceptance; no-op if already stamped.
      await stampTermsAcceptance(userId);
      const token = await createLoginLink(userId);
      const nextQuery = next ? `&next=${encodeURIComponent(next)}` : "";
      const link = `${baseUrl(req)}/magic-link?token=${token}${nextQuery}`;
      const sent = await sendMagicLinkEmail(email, link);
      // Dev convenience so the flow is testable without a verified domain.
      if (!sent || process.env.NODE_ENV !== "production") devLink = link;
    }

    return {
      message: "Check your email — a sign-in link is on its way.",
      ...(devLink ? { login_url: devLink } : {}),
    };
  });
}
