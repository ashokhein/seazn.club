import "server-only";

// Cycle-1 locale set. hi/ta (Devanagari/Tamil) are DEFERRED — they need Noto
// fonts across app+OG+PDF and native translation review; see the design spec
// §7/§15. Re-add them here (plus their dictionaries/{hi,ta}/*.json + font work)
// when that cycle lands. Pure exports live in lib/i18n-constants (proxy-safe);
// this module owns the server-only dictionary loading.
export {
  LOCALES,
  DEFAULT_LOCALE,
  PSEUDO_LOCALE,
  hasLocale,
  toLocale,
  type Locale,
  type Namespace,
  type Dict,
} from "@/lib/i18n-constants";

import { DEFAULT_LOCALE, type Dict, type Locale, type Namespace } from "@/lib/i18n-constants";
import type { DictionaryKey } from "@/lib/i18n-keys";
import { buildPseudoDictionary } from "@/lib/pseudo";

// Authored keys autocomplete; `& {}` keeps arbitrary strings (dynamic paths,
// keys added before the next `i18n:gen-keys`) assignable without a cast.
type TKey = DictionaryKey | (string & {});

function lookup(dict: Dict, key: string): unknown {
  // A literal flat key ("items.one") wins; otherwise walk nested objects
  // ("nested.deep"). Supports both authoring styles / generator outputs.
  if (Object.prototype.hasOwnProperty.call(dict, key)) return dict[key];
  return key.split(".").reduce<unknown>(
    (acc, part) => (acc && typeof acc === "object" ? (acc as Dict)[part] : undefined),
    dict,
  );
}

function interpolate(s: string, vars?: Record<string, string | number>): string {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`));
}

/** Dot-key lookup + `{var}` interpolation. Never throws: on a miss it warns in
 *  dev and returns the key (callers already loaded an en-merged dict, so a real
 *  miss is a genuine gap, not a locale hole). */
export function t(dict: Dict, key: TKey, vars?: Record<string, string | number>): string {
  const val = lookup(dict, key);
  if (typeof val === "string") return interpolate(val, vars);
  if (process.env.NODE_ENV !== "production") console.warn(`[i18n] missing key: ${key}`);
  return key;
}

/** Plural selection via Intl.PluralRules; keys `foo.one` / `foo.other` (+ locale
 *  extras). `{count}` is always available for interpolation. */
export function plural(
  dict: Dict,
  key: string,
  count: number,
  locale: Locale,
  vars?: Record<string, string | number>,
): string {
  const cat = new Intl.PluralRules(locale).select(count);
  const chosen = lookup(dict, `${key}.${cat}`) ?? lookup(dict, `${key}.other`);
  const s = typeof chosen === "string" ? chosen : key;
  return interpolate(s, { count, ...vars });
}

// Namespaces are enumerated as literal import() calls so the bundler can see
// every chunk (a template-string import is not statically analyzable).
type Loader = () => Promise<{ default: Dict }>;

const loaders: Record<Locale, Record<Namespace, Loader>> = {
  en: {
    common: () => import("@/dictionaries/en/common.json"),
    marketing: () => import("@/dictionaries/en/marketing.json"),
    public: () => import("@/dictionaries/en/public.json"),
    emails: () => import("@/dictionaries/en/emails.json"),
    errors: () => import("@/dictionaries/en/errors.json"),
    metadata: () => import("@/dictionaries/en/metadata.json"),
  },
  fr: {
    common: () => import("@/dictionaries/fr/common.json"),
    marketing: () => import("@/dictionaries/fr/marketing.json"),
    public: () => import("@/dictionaries/fr/public.json"),
    emails: () => import("@/dictionaries/fr/emails.json"),
    errors: () => import("@/dictionaries/fr/errors.json"),
    metadata: () => import("@/dictionaries/fr/metadata.json"),
  },
  es: {
    common: () => import("@/dictionaries/es/common.json"),
    marketing: () => import("@/dictionaries/es/marketing.json"),
    public: () => import("@/dictionaries/es/public.json"),
    emails: () => import("@/dictionaries/es/emails.json"),
    errors: () => import("@/dictionaries/es/errors.json"),
    metadata: () => import("@/dictionaries/es/metadata.json"),
  },
  nl: {
    common: () => import("@/dictionaries/nl/common.json"),
    marketing: () => import("@/dictionaries/nl/marketing.json"),
    public: () => import("@/dictionaries/nl/public.json"),
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
