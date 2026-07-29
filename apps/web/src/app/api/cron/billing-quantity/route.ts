import { headers } from "next/headers";
import { handler } from "@/lib/http";
import { HttpError } from "@/lib/errors";
import {
  countOrgsWithoutGroup,
  reconcileGroupQuantities,
  sweepOrphanGroups,
} from "@/server/usecases/billing-groups";
import { sweepStaleOrgAddonPrices } from "@/server/usecases/billing-events";

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
    // orphanOrgs is the #232 P2 invariant guard: 0 in a healthy database. The
    // schedule warns when reconcile corrects drift or an orphan appears.
    //
    // addonPrices rides this schedule rather than the hourly billing-events one
    // (#332). Same subscription ITEMS as reconcileGroupQuantities above, one
    // field over: that call puts the item's QUANTITY back on the truth, this one
    // reports items whose PRICE no longer matches the plan's rider. Daily is
    // also the honest cadence for its cost — it reads one Stripe price per
    // active rider, so hourly would multiply that by 24 to re-derive an answer
    // that changes only when a price does.
    //
    // Report-only, deliberately: a repairing sweep would be an unattended bulk
    // billing mutation, and whatever left a group on a stale price is likely
    // still there to do it again. `mismatched > 0` is the signal to look.
    //
    // orphanGroups is the mirror image of orphanOrgs (#375): an org with no
    // group, versus a GROUP with no orgs. It retires the second in place from
    // Stripe's own answer — the state `cancelGroupIfEmpty` declines to touch,
    // most often an abandoned first checkout stuck at `incomplete`. Daily is
    // the right cadence: Stripe expires such a subscription within 23 hours and
    // the sweep only looks at rows untouched for a day, so an earlier run would
    // read a checkout somebody is still paying. `stillLive > 0` is the signal
    // to look — a subscription alive at Stripe with nobody on the bill.
    const [reconcile, orphanOrgs, addonPrices, orphanGroups] = await Promise.all([
      reconcileGroupQuantities(),
      countOrgsWithoutGroup(),
      sweepStaleOrgAddonPrices(),
      sweepOrphanGroups(),
    ]);
    return { ...reconcile, orphanOrgs, addonPrices, orphanGroups };
  });
}
