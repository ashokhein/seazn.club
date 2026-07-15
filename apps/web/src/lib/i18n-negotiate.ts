// Pure Accept-Language negotiation — no `server-only`, so proxy.ts (runtime)
// can call it. Maps the browser's language preferences onto our supported set.
import { match } from "@formatjs/intl-localematcher";
import Negotiator from "negotiator";
import { LOCALES, DEFAULT_LOCALE, type Locale } from "@/lib/i18n-constants";

export function negotiateLocale(acceptLanguage: string | null): Locale {
  if (!acceptLanguage) return DEFAULT_LOCALE;
  const langs = new Negotiator({ headers: { "accept-language": acceptLanguage } }).languages();
  try {
    return match(langs, [...LOCALES], DEFAULT_LOCALE) as Locale;
  } catch {
    return DEFAULT_LOCALE;
  }
}
