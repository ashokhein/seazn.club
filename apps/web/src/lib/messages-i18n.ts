import "server-only";
// Server-side localized reads of the `ui` copy catalog (v5 i18n cycle 47). Server
// components (status chip, entity card, feature pages) resolve the request locale
// and call msgFor(locale, key). Bundles all locales — server-only, so the extra
// languages never reach the client (client islands use useMsg() instead, which
// ships only the active locale via <DictProvider>).
import { DEFAULT_LOCALE, type Locale } from "@/lib/i18n-constants";
import { interpolate } from "@/lib/i18n-runtime";
import type { MessageKey } from "@/lib/messages";
import en from "@/dictionaries/en/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import es from "@/dictionaries/es/ui.json";
import nl from "@/dictionaries/nl/ui.json";

const BY_LOCALE: Record<Locale, Record<string, string>> = {
  en: en as Record<string, string>,
  fr: fr as Record<string, string>,
  es: es as Record<string, string>,
  nl: nl as Record<string, string>,
};

/** Localized `ui` copy lookup with `{placeholder}` interpolation, falling back to
 *  English on any missing key/locale. Never throws. */
export function msgFor(
  locale: Locale,
  key: MessageKey,
  vars?: Record<string, string | number>,
): string {
  const en = BY_LOCALE[DEFAULT_LOCALE];
  const table = BY_LOCALE[locale] ?? en;
  const raw = table[key] ?? en[key] ?? String(key);
  return interpolate(raw, vars);
}
