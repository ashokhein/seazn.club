import { z } from "zod";
import { createSession, postAuthLanding } from "@/lib/auth";
import { handler } from "@/lib/http";
import { consumeLoginLink } from "@/lib/login-link";
import { rateLimit, AUTH_LIMIT } from "@/lib/rate-limit";
import { headers } from "next/headers";

// `next` is the post-login redirect carried by the emailed link (invite
// pages); postAuthLanding re-validates it via safeNextPath.
const schema = z
  .object({
    token: z.string().min(10),
    next: z.string().max(500).optional(),
  })
  .strict();

/** Consume a passwordless sign-in token and start a session. */
export async function POST(req: Request) {
  return handler(async () => {
    const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    await rateLimit(`magic-link-consume:${ip}`, AUTH_LIMIT);

    const body = schema.parse(await req.json());
    const { token, next } = body;

    const userId = await consumeLoginLink(token);
    if (!userId) {
      throw new Error("This sign-in link is invalid or has expired");
    }

    await createSession(userId);

    const landing = await postAuthLanding(userId, next);
    return {
      has_org: landing.hasOrg,
      org_id: landing.orgId,
      redirect: landing.redirect,
    };
  });
}
