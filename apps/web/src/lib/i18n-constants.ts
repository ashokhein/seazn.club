// Pure i18n constants — NO `server-only`, so proxy.ts (edge/runtime) and client
// components can import these. The server-only dictionary loader lives in
// lib/i18n.ts, which re-exports everything here.

// Cycle-1 set. hi/ta deferred (Noto fonts + native review) — see design spec.
export const LOCALES = ["en", "fr", "es", "nl"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

// Dev/CI-only pseudolocale. NEVER in LOCALES, never negotiated, never offered
// by the switcher — reached only via an explicit audit override.
export const PSEUDO_LOCALE = "en-XA" as const;

// Runtime source of truth for the namespace set (the drift guard iterates it).
// `console` is the shared authed-app chrome; dashboard/competitions/settings are
// the cycle-47 console feature-page domains (later batches add admin, developers,
// …). Truly shared strings (status enums, common nouns) live in `common`.
export const NAMESPACES = [
  "common",
  "marketing",
  "public",
  "console",
  "dashboard",
  "competitions",
  "settings",
  "emails",
  "errors",
  "metadata",
] as const;
export type Namespace = (typeof NAMESPACES)[number];

export type Dict = Record<string, unknown>;

/** Type guard narrowing an arbitrary string to a supported Locale. Rejects the
 *  pseudolocale and any unknown code. */
export function hasLocale(x: string): x is Locale {
  return (LOCALES as readonly string[]).includes(x);
}

/** Coerce a possibly-null stored value (e.g. users.locale, which is nullable
 *  when the user has never chosen) into a concrete Locale, falling back to the
 *  default. Handy at email/console call sites that read the DB value directly. */
export function toLocale(x: string | null | undefined): Locale {
  return x != null && hasLocale(x) ? x : DEFAULT_LOCALE;
}
