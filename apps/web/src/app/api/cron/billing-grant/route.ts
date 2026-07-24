import { headers } from "next/headers";
import { handler } from "@/lib/http";
import { HttpError } from "@/lib/errors";
import { grantMonthlyForAllWallets } from "@/lib/credits";

/** POST /api/cron/billing-grant — daily: grant every live billing wallet its
 *  `ai.credits.monthly(plan) * quantity_paid` allowance for this period
 *  (SPEC-2 §5.4/§11.2, v17 Task 6) — Community wallets included, flat 10.
 *  Each grant first EXPIRES any unspent `grant`-bucket balance left over
 *  from the prior period (D1, use-or-lose) before adding the new period's
 *  allowance; the `pack` bucket (purchased packs, D2) is never touched here
 *  (see `grantMonthly`'s own docstring). Scheduled by
 *  `.github/workflows/billing-grant.yml`, same daily cadence as
 *  billing-quantity.
 *
 *  **Anchor (README §7 item 7):** paid wallets reset on the real Stripe
 *  billing-cycle boundary (`subscriptions.current_period_end`); Community
 *  wallets — which carry no Stripe period — fall back to plain calendar
 *  month, an accepted simplification (see `grantMonthlyForAllWallets`'s
 *  docstring for why this is safe: bounded skew, never a double-grant or a
 *  skipped month).
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
