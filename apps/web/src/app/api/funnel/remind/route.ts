import { headers } from "next/headers";
import { handler } from "@/lib/http";
import { HttpError } from "@/lib/errors";
import { sql } from "@/lib/db";
import { baseUrl } from "@/lib/oauth";
import { sendFunnelReminderEmail } from "@/lib/email";
import { funnelPayloadSchema } from "@/lib/funnel";

/** POST /api/funnel/remind — sweep unclaimed drafts older than 24h and send
 *  the single reminder (v3/07 §6). No scheduler exists in-repo, so this is a
 *  cron-shaped endpoint: wire it to Vercel Cron / any scheduler with the
 *  x-cron-secret header (CRON_SECRET env). Idempotent — reminded_at marks
 *  each draft, and expired drafts are never revived. */
export async function POST(req: Request) {
  return handler(async () => {
    const secret = process.env.CRON_SECRET;
    if (!secret) throw new HttpError(503, "CRON_SECRET is not configured");
    const given = (await headers()).get("x-cron-secret");
    if (given !== secret) throw new HttpError(401, "Bad cron secret");

    const due = await sql<{ id: string; token: string; email: string; payload: unknown }[]>`
      select id, token, email, payload from funnel_drafts
      where used_at is null
        and reminded_at is null
        and created_at < now() - interval '24 hours'
        and expires_at > now()
      order by created_at
      limit 200`;

    let sent = 0;
    for (const draft of due) {
      const parsed = funnelPayloadSchema.safeParse(draft.payload);
      if (parsed.success) {
        const ok = await sendFunnelReminderEmail(draft.email, {
          competitionName: parsed.data.name,
          sport: parsed.data.sport,
          link: `${baseUrl(req)}/start/claim?token=${draft.token}`,
        });
        if (ok) sent++;
      }
      // Malformed payloads are marked too — never retried forever.
      await sql`update funnel_drafts set reminded_at = now() where id = ${draft.id}`;
    }

    return { due: due.length, sent };
  });
}
