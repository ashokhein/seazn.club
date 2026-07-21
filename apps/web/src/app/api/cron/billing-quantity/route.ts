import { headers } from "next/headers";
import { handler } from "@/lib/http";
import { HttpError } from "@/lib/errors";
import { reconcileGroupQuantities } from "@/server/usecases/billing-groups";

/** POST /api/cron/billing-quantity — daily: for every live billing group whose
 *  paid-for seat count disagrees with its organisation count, put the Stripe
 *  subscription item back on the truth. Drift is silent by nature (an attach or
 *  detach whose sync failed, an org created into a paid group during a Stripe
 *  outage, a renewal whose sync threw), and Stripe cuts every renewal invoice
 *  from that item — so an uncorrected drift over-bills or under-bills for ever.
 *  Groups merely holding a freed slot are visited too and correct nothing; that
 *  is the cost of a filter that a failed sync cannot satisfy. Cron-shaped like
 *  /api/cron/billing-events: x-cron-secret header (CRON_SECRET env). Idempotent
 *  — it writes only where Stripe and the org count actually disagree. */
export async function POST() {
  return handler(async () => {
    const secret = process.env.CRON_SECRET;
    if (!secret) throw new HttpError(503, "CRON_SECRET is not configured");
    const given = (await headers()).get("x-cron-secret");
    if (given !== secret) throw new HttpError(401, "Bad cron secret");
    return reconcileGroupQuantities();
  });
}
