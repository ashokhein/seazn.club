"use client";
import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { LOCALES, type Locale } from "@/lib/i18n-constants";

const LABELS: Record<Locale, string> = {
  en: "English",
  fr: "Français",
  es: "Español",
  nl: "Nederlands",
};

function pathLocale(pathname: string): Locale {
  const seg = pathname.split("/")[1] ?? "";
  return (LOCALES as readonly string[]).includes(seg) ? (seg as Locale) : "en";
}

/** The `seazn_locale` cookie this switcher writes — the source of truth on
 *  unprefixed routes ("/", console) where the URL carries no locale. Client
 *  only (document is undefined during SSR). */
function cookieLocale(): Locale | null {
  if (typeof document === "undefined") return null;
  const m = document.cookie.match(/(?:^|;\s*)seazn_locale=([^;]+)/);
  return m && (LOCALES as readonly string[]).includes(m[1]) ? (m[1] as Locale) : null;
}

/**
 * Language picker (v5 i18n §9). Writes the `seazn_locale` cookie — which
 * resolveLocale() reads first, so the pick drives locale for anon and signed-in
 * visitors alike. On a marketing `[lang]` route it also swaps the path segment
 * so the URL matches; elsewhere it refreshes to re-render in the new locale.
 */
export function LocaleSwitcher() {
  const router = useRouter();
  const pathname = usePathname();
  // Initialize from the path only so server and client agree at hydration. The
  // effect then reflects the cookie: on unprefixed routes the URL has no locale,
  // and this also re-runs when router.refresh() remounts the subtree — without
  // it the select snaps back to en while the page is already localized.
  const [value, setValue] = useState<Locale>(() => pathLocale(pathname));
  useEffect(() => {
    setValue(cookieLocale() ?? pathLocale(pathname));
  }, [pathname]);

  function onChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value as Locale;
    setValue(next);
    document.cookie = `seazn_locale=${next}; path=/; max-age=31536000; samesite=lax`;
    const seg = pathname.split("/")[1] ?? "";
    if ((LOCALES as readonly string[]).includes(seg)) {
      router.push(`/${next}${pathname.replace(/^\/[^/]+/, "")}`);
    } else {
      router.refresh();
    }
  }

  return (
    <label className="inline-flex items-center gap-2 text-sm">
      <span className="sr-only">Language</span>
      <select
        data-testid="locale-switcher"
        value={value}
        onChange={onChange}
        className="rounded-md border border-zinc-300 bg-surface px-2 py-1 text-sm text-ink"
      >
        {LOCALES.map((l) => (
          <option key={l} value={l}>
            {LABELS[l]}
          </option>
        ))}
      </select>
    </label>
  );
}
