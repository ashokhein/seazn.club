import { headers } from "next/headers";
import { handler } from "@/lib/http";
import { HttpError } from "@/lib/errors";
import { grantMonthlyForAllWallets } from "@/lib/credits";

/** POST /api/cron/billing-grant — daily: grant every live billing wallet its
 *  `ai.credits.monthly(plan) * quantity_paid` allowance for this period
 *  (SPEC-2 §5.4/§11.2, v17 Task 6) — Community wallets included, flat 10
 *  (see `grantMonthlyForAllWallets`'s own docstring for the calendar-month
 *  idempotency this relies on to make a daily loop safe). Cron-shaped like
 *  /api/cron/billing-quantity: x-cron-secret header (CRON_SECRET env). */
export async function POST() {
  return handler(async () => {
    const secret = process.env.CRON_SECRET;
    if (!secret) throw new HttpError(503, "CRON_SECRET is not configured");
    const given = (await headers()).get("x-cron-secret");
    if (given !== secret) throw new HttpError(401, "Bad cron secret");
    return grantMonthlyForAllWallets();
  });
}
