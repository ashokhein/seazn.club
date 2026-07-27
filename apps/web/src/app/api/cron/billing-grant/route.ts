import { headers } from "next/headers";
import { handler } from "@/lib/http";
import { HttpError } from "@/lib/errors";
import { grantMonthlyForAllWallets } from "@/lib/credits";

/** POST /api/cron/billing-grant — daily: grant every billing wallet its
 *  `ai.credits.monthly(plan) * quantity_paid` allowance for this period
 *  (SPEC-2 §5.4/§11.2, v17 Task 6) — Community wallets included, flat 10.
 *  A TRIALING paid wallet multiplies by `max(quantity_paid, live_org_count)`
 *  instead (#291; see `grantMonthlyForAllWallets`'s docstring for why).
 *  Each grant first EXPIRES any unspent `grant`-bucket balance left over
 *  from the prior period (D1, use-or-lose) before adding the new period's
 *  allowance; the `pack` bucket (purchased packs, D2) is never touched here
 *  (see `grantMonthly`'s own docstring). Scheduled by
 *  `.github/workflows/billing-grant.yml`, same daily cadence as
 *  billing-quantity.
 *
 *  **Anchor (README §7 item 7; Cadence fix, SPEC-2 §5.4):** every wallet —
 *  paid or Community — resets on the plain calendar month, never on
 *  `subscriptions.current_period_end`. Keying paid wallets off the Stripe
 *  billing-cycle boundary was tried and reverted: an annual-interval
 *  subscription's `current_period_end` only advances once a year, so that
 *  anchor collapsed 12 monthly grants into a single lump — a cadence
 *  regression, not the "regardless of billing cadence" behavior SPEC-2 §5.4
 *  requires (see `grantMonthlyForAllWallets`'s docstring).
 *
 *  Cron-shaped like /api/cron/billing-quantity: x-cron-secret header
 *  (CRON_SECRET env). */
export async function POST() {
  return handler(async () => {
    const secret = process.env.CRON_SECRET;
    if (!secret) throw new HttpError(503, "CRON_SECRET is not configured");
    const given = (await headers()).get("x-cron-secret");
    if (given !== secret) throw new HttpError(401, "Bad cron secret");
    return grantMonthlyForAllWallets();
  });
}
