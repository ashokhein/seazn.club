import "server-only";
import { cookies, headers } from "next/headers";
import { sql } from "@/lib/db";
import {
  CURRENCY_COOKIE,
  currencyFromAcceptLanguage,
  isSupportedCurrency,
  type Currency,
} from "@/lib/currency";

/**
 * The currency a checkout for this org should charge in (v3/07 §4):
 * an existing subscription's currency wins (renewals/upgrades never switch),
 * then the pricing-page switcher cookie, then an Accept-Language guess.
 */
export async function preferredCurrency(
  orgId: string | null,
  req?: Request,
): Promise<Currency> {
  if (orgId) {
    const [sub] = await sql<{ currency: string | null }[]>`
      select currency from subscriptions where org_id = ${orgId}`;
    if (isSupportedCurrency(sub?.currency)) return sub.currency;
  }
  const jar = await cookies();
  const fromCookie = jar.get(CURRENCY_COOKIE)?.value;
  if (isSupportedCurrency(fromCookie)) return fromCookie;
  const acceptLanguage =
    req?.headers.get("accept-language") ?? (await headers()).get("accept-language");
  return currencyFromAcceptLanguage(acceptLanguage);
}
