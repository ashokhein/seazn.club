// Client-safe dictionary access for the few components that must localize
// OUTSIDE a server render — e.g. the consent banner, which lives in the static
// (ISR) root layout and can't receive a server-resolved dict. Bundles the small
// `common` namespace for every locale and reads the seazn_locale cookie for the
// active one. Do NOT use for large surfaces: server getDictionary() is the
// default; this exists only for root-layout client islands.
import en from "@/dictionaries/en/common.json";
import fr from "@/dictionaries/fr/common.json";
import es from "@/dictionaries/es/common.json";
import nl from "@/dictionaries/nl/common.json";
import { DEFAULT_LOCALE, hasLocale, type Locale } from "@/lib/i18n-constants";

const COMMON: Record<Locale, Record<string, string>> = {
  en: en as Record<string, string>,
  fr: fr as Record<string, string>,
  es: es as Record<string, string>,
  nl: nl as Record<string, string>,
};

/** Active locale from the seazn_locale cookie (client only); en on the server. */
export function readLocaleCookie(): Locale {
  if (typeof document === "undefined") return DEFAULT_LOCALE;
  const m = document.cookie.match(/(?:^|;\s*)seazn_locale=([^;]+)/);
  const v = m ? decodeURIComponent(m[1]) : "";
  return hasLocale(v) ? v : DEFAULT_LOCALE;
}

/** The locale of a `[lang]` route from its first path segment, or null when the
 *  path carries no locale (root `/`, or non-localized routes like `/login`,
 *  `/o/…`). Pure — the testable core of readActiveLocale. */
export function localeFromPath(pathname: string): Locale | null {
  const seg = pathname.split("/")[1] ?? "";
  return hasLocale(seg) ? seg : null;
}

/** Locale a root-layout client island should render in: match the visible
 *  `[lang]` path first (so the banner is English on /en even if the cookie says
 *  fr), and fall back to the cookie on paths without a locale segment. */
export function readActiveLocale(): Locale {
  if (typeof window !== "undefined") {
    const fromPath = localeFromPath(window.location.pathname);
    if (fromPath) return fromPath;
  }
  return readLocaleCookie();
}

/** Look up a `common`-namespace key for `locale`, falling back to en then key. */
export function clientCommon(locale: Locale, key: string): string {
  return COMMON[locale]?.[key] ?? COMMON[DEFAULT_LOCALE][key] ?? key;
}
