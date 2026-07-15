"use client";
// Client i18n context (v5 i18n cycle 47). A server feature page resolves the
// active locale's dict once (getDictionary(locale, ns), server-only) and wraps
// its island subtree in <DictProvider dict locale>. Islands read copy with
// useT()/usePlural()/useLocale() instead of taking dozens of per-string props.
// Only the ACTIVE locale's dict crosses the RSC boundary (a plain object) — no
// multi-locale bundle bloat, no server-only import in client code.
import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { plural as pluralRuntime, t as tRuntime, type TKey } from "@/lib/i18n-runtime";

type DictContextValue = { dict: Dict; locale: Locale };

const DictContext = createContext<DictContextValue | null>(null);

export function DictProvider({
  dict,
  locale,
  children,
}: {
  dict: Dict;
  locale: Locale;
  children: ReactNode;
}) {
  const value = useMemo<DictContextValue>(() => ({ dict, locale }), [dict, locale]);
  return <DictContext.Provider value={value}>{children}</DictContext.Provider>;
}

function useDictContext(): DictContextValue {
  const ctx = useContext(DictContext);
  if (!ctx) {
    throw new Error("useT/usePlural/useLocale must be used within a <DictProvider>");
  }
  return ctx;
}

/** Bound `t(key, vars)` for the provided dict. Same lookup + interpolation as
 *  the server `t()`; falls back to the key on a miss (never throws). */
export function useT(): (key: TKey, vars?: Record<string, string | number>) => string {
  const { dict } = useDictContext();
  return useMemo(() => (key: TKey, vars?: Record<string, string | number>) => tRuntime(dict, key, vars), [dict]);
}

/** Bound `plural(key, count, vars)` using the provider's locale. */
export function usePlural(): (
  key: string,
  count: number,
  vars?: Record<string, string | number>,
) => string {
  const { dict, locale } = useDictContext();
  return useMemo(
    () => (key: string, count: number, vars?: Record<string, string | number>) =>
      pluralRuntime(dict, key, count, locale, vars),
    [dict, locale],
  );
}

/** The resolved active locale, for islands that need it directly (formatting). */
export function useLocale(): Locale {
  return useDictContext().locale;
}
