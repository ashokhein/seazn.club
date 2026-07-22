import { handler } from "@/lib/http";
import { safeNextPath } from "@/lib/auth";
import { resolveOrCreateUser } from "@/lib/users";
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
