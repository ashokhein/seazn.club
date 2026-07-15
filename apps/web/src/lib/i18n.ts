import "server-only";

// Cycle-1 locale set. hi/ta (Devanagari/Tamil) are DEFERRED — they need Noto
// fonts across app+OG+PDF and native translation review; see the design spec
// §7/§15. Re-add them here (plus their dictionaries/{hi,ta}/*.json + font work)
// when that cycle lands. Pure exports live in lib/i18n-constants (proxy-safe);
// this module owns the server-only dictionary loading.
export {
  LOCALES,
  NAMESPACES,
  DEFAULT_LOCALE,
  PSEUDO_LOCALE,
  hasLocale,
  toLocale,
  type Locale,
  type Namespace,
  type Dict,
} from "@/lib/i18n-constants";

import { DEFAULT_LOCALE, type Dict, type Locale, type Namespace } from "@/lib/i18n-constants";
import { buildPseudoDictionary } from "@/lib/pseudo";

// t/plural are pure and shared with client islands (via the DictProvider hooks),
// so they live in lib/i18n-runtime (no `server-only`) and are re-exported here
// for the many server call sites that import them from @/lib/i18n.
export { t, plural, type TKey } from "@/lib/i18n-runtime";

// Namespaces are enumerated as literal import() calls so the bundler can see
// every chunk (a template-string import is not statically analyzable).
type Loader = () => Promise<{ default: Dict }>;

const loaders: Record<Locale, Record<Namespace, Loader>> = {
  en: {
    common: () => import("@/dictionaries/en/common.json"),
    marketing: () => import("@/dictionaries/en/marketing.json"),
    public: () => import("@/dictionaries/en/public.json"),
    console: () => import("@/dictionaries/en/console.json"),
    ui: () => import("@/dictionaries/en/ui.json"),
    emails: () => import("@/dictionaries/en/emails.json"),
    errors: () => import("@/dictionaries/en/errors.json"),
    metadata: () => import("@/dictionaries/en/metadata.json"),
  },
  fr: {
    common: () => import("@/dictionaries/fr/common.json"),
    marketing: () => import("@/dictionaries/fr/marketing.json"),
    public: () => import("@/dictionaries/fr/public.json"),
    console: () => import("@/dictionaries/fr/console.json"),
    ui: () => import("@/dictionaries/fr/ui.json"),
    emails: () => import("@/dictionaries/fr/emails.json"),
    errors: () => import("@/dictionaries/fr/errors.json"),
    metadata: () => import("@/dictionaries/fr/metadata.json"),
  },
  es: {
    common: () => import("@/dictionaries/es/common.json"),
    marketing: () => import("@/dictionaries/es/marketing.json"),
    public: () => import("@/dictionaries/es/public.json"),
    console: () => import("@/dictionaries/es/console.json"),
    ui: () => import("@/dictionaries/es/ui.json"),
    emails: () => import("@/dictionaries/es/emails.json"),
    errors: () => import("@/dictionaries/es/errors.json"),
    metadata: () => import("@/dictionaries/es/metadata.json"),
  },
  nl: {
    common: () => import("@/dictionaries/nl/common.json"),
    marketing: () => import("@/dictionaries/nl/marketing.json"),
    public: () => import("@/dictionaries/nl/public.json"),
    console: () => import("@/dictionaries/nl/console.json"),
    ui: () => import("@/dictionaries/nl/ui.json"),
    emails: () => import("@/dictionaries/nl/emails.json"),
    errors: () => import("@/dictionaries/nl/errors.json"),
    metadata: () => import("@/dictionaries/nl/metadata.json"),
  },
};

/** Load a namespace for `locale`, merged over `en` so any key absent in the
 *  locale falls back to English (never a missing string in the UI). */
export async function getDictionary(locale: Locale, ns: Namespace): Promise<Dict> {
  const en = (await loaders[DEFAULT_LOCALE][ns]()).default;
  // Dev/CI pseudolocale (§8): render every extracted string as en-XA so the
  // Playwright audit can flag anything that ISN'T pseudo (= hardcoded). Never
  // set in production, so this branch is dead there.
  if (process.env.SEAZN_PSEUDO === "1") return buildPseudoDictionary(en);
  if (locale === DEFAULT_LOCALE || !loaders[locale]) return en;
  const other = (await loaders[locale][ns]()).default;
  return { ...en, ...other };
}
