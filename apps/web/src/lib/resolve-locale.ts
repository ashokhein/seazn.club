import "server-only";
import { cookies, headers } from "next/headers";
import { getCurrentUser } from "@/lib/auth";
import { DEFAULT_LOCALE, hasLocale, type Locale } from "@/lib/i18n";

/**
 * Resolve the locale for a server render (v5 i18n spec §4). Order:
 *   1. `seazn_locale` cookie (explicit switcher pick)
 *   2. signed-in user's `users.locale`
 *   3. `orgDefault` — the owning org's default, for public league pages only
 *   4. `x-seazn-locale` request header (proxy's Accept-Language negotiation)
 *   5. en
 *
 * Marketing `[lang]` pages don't call this — the path segment is authoritative
 * there (see the marketing layout).
 *
 * Note: this reads cookies()/headers(), so any component that calls it opts
 * into dynamic rendering. The static root layout deliberately does NOT call it.
 */
export async function resolveLocale(opts?: { orgDefault?: Locale }): Promise<Locale> {
  const cookieLocale = (await cookies()).get("seazn_locale")?.value;
  if (cookieLocale && hasLocale(cookieLocale)) return cookieLocale;

  const user = await getCurrentUser().catch(() => null);
  if (user?.locale && hasLocale(user.locale)) return user.locale;

  if (opts?.orgDefault) return opts.orgDefault;

  const headerLocale = (await headers()).get("x-seazn-locale");
  return headerLocale && hasLocale(headerLocale) ? headerLocale : DEFAULT_LOCALE;
}
