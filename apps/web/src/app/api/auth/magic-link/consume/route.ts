import { z } from "zod";
import { createSession, postAuthLanding } from "@/lib/auth";
import { handler } from "@/lib/http";
import { consumeLoginLink } from "@/lib/login-link";
import { rateLimit, AUTH_LIMIT } from "@/lib/rate-limit";
import { headers } from "next/headers";

const schema = z.object({ token: z.string().min(10) }).strict();

/** Consume a passwordless sign-in token and start a session. */
export async function POST(req: Request) {
  return handler(async () => {
    const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    await rateLimit(`magic-link-consume:${ip}`, AUTH_LIMIT);

    const body = await req.json();
    const { token } = schema.parse(body);
    const next = (body as { next?: unknown })?.next;

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
