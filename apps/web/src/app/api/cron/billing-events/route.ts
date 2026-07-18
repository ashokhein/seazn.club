import { headers } from "next/headers";
import { handler } from "@/lib/http";
import { HttpError } from "@/lib/errors";
import { sweepStuckEvents } from "@/server/usecases/billing-events";

/** POST /api/cron/billing-events — hourly (spec P1-7): auto-replay webhook
 *  events stuck in `received` (a deploy crash or transient DB error mid-handler
 *  leaves the ledger row un-processed forever, and /admin/billing-events only
 *  exposes manual replay). Cron-shaped like /api/cron/registrations: wire it to
 *  Vercel Cron / any scheduler with the x-cron-secret header (CRON_SECRET env).
 *  Idempotent — handlers are replay-safe by contract; attempts are capped, then
 *  staff are alerted once. */
export async function POST() {
  return handler(async () => {
    const secret = process.env.CRON_SECRET;
    if (!secret) throw new HttpError(503, "CRON_SECRET is not configured");
    const given = (await headers()).get("x-cron-secret");
    if (given !== secret) throw new HttpError(401, "Bad cron secret");
    return sweepStuckEvents();
  });
}
