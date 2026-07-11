import { z } from "zod";
import { headers } from "next/headers";
import { handler } from "@/lib/http";
import { rateLimit, AUTH_LIMIT } from "@/lib/rate-limit";
import { sql } from "@/lib/db";
import { createSession, setActiveOrgId } from "@/lib/auth";
import { consumeFunnelDraft, createFromDraft } from "@/lib/funnel";
import { captureServer } from "@/lib/posthog-server";
import { EVENTS } from "@/lib/analytics-events";

const schema = z.object({ token: z.string().min(10) }).strict();

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

/** Find-or-create the account for a claimed draft. Opening the emailed link
 *  proves control of the address, so the account lands verified — the funnel
 *  token IS the magic link (v3/07 §6). */
async function resolveOrCreateVerifiedUser(email: string): Promise<string | null> {
  const existing = await sql<{ id: string }[]>`
    select id from users where email = ${email} and deleted_at is null limit 1`;
  if (existing[0]) {
    await sql`update users set email_verified = true where id = ${existing[0].id}`;
    return existing[0].id;
  }
  const created = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${email}, ${displayNameFromEmail(email)}, true)
    on conflict (email) do nothing
    returning id`;
  if (created[0]) return created[0].id;
  const again = await sql<{ id: string }[]>`
    select id from users where email = ${email} and deleted_at is null limit 1`;
  return again[0]?.id ?? null;
}

/** POST /api/funnel/claim — consume the draft token, sign the visitor in
 *  (creating the account if new), build org + competition + division from the
 *  draft, and return where to land: inside the competition. */
export async function POST(req: Request) {
  return handler(async () => {
    const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    await rateLimit(`funnel-claim:${ip}`, AUTH_LIMIT);

    const { token } = schema.parse(await req.json());
    const draft = await consumeFunnelDraft(token);
    if (!draft) {
      throw new Error("This setup link is invalid, expired, or already used.");
    }

    const userId = await resolveOrCreateVerifiedUser(draft.email);
    if (!userId) throw new Error("Could not resolve an account for this email.");
    await createSession(userId);

    const { redirect, orgId } = await createFromDraft(userId, draft);
    await setActiveOrgId(orgId);

    await captureServer({
      event: EVENTS.FUNNEL_CLAIMED,
      distinctId: userId,
      properties: { sport: draft.payload.sport, entrants: draft.payload.entrants },
    });

    return { redirect };
  });
}
