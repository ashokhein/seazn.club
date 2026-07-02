import { z } from "zod";
import { sql } from "@/lib/db";
import { createSession, postAuthLanding } from "@/lib/auth";
import { handler } from "@/lib/http";
import { consumeVerificationToken } from "@/lib/verification";

const schema = z.object({ token: z.string().min(10) }).strict();

/** Verify an email token, mark the account verified, and sign the user in. */
export async function POST(req: Request) {
  return handler(async () => {
    const body = await req.json();
    const { token } = schema.parse(body);
    const next = (body as { next?: unknown })?.next;

    const userId = await consumeVerificationToken(token);
    if (!userId) {
      throw new Error("This verification link is invalid or has expired");
    }

    await sql`update users set email_verified = true where id = ${userId}`;
    await createSession(userId);

    const landing = await postAuthLanding(userId, next);
    return {
      has_org: landing.hasOrg,
      org_id: landing.orgId,
      redirect: landing.redirect,
    };
  });
}
