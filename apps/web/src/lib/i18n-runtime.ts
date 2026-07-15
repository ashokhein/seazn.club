// Pure i18n runtime — NO `server-only`, so client islands (via the DictProvider
// hooks) and the server `t()`/`plural()` in lib/i18n.ts share one implementation.
// Dictionary LOADING stays server-only in lib/i18n.ts; this module only reads a
// dict already in hand.
import type { Dict, Locale } from "@/lib/i18n-constants";
import type { DictionaryKey } from "@/lib/i18n-keys";

// Authored keys autocomplete; `& {}` keeps arbitrary strings (dynamic paths,
// keys added before the next `i18n:gen-keys`) assignable without a cast.
export type TKey = DictionaryKey | (string & {});

export function lookup(dict: Dict, key: string): unknown {
  // A literal flat key ("items.one") wins; otherwise walk nested objects
  // ("nested.deep"). Supports both authoring styles / generator outputs.
  if (Object.prototype.hasOwnProperty.call(dict, key)) return dict[key];
  return key.split(".").reduce<unknown>(
    (acc, part) => (acc && typeof acc === "object" ? (acc as Dict)[part] : undefined),
    dict,
  );
}

export function interpolate(s: string, vars?: Record<string, string | number>): string {
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
