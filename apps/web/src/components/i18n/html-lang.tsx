"use client";
import { useEffect } from "react";

/**
 * Corrects <html lang> on the client for locale-prefixed marketing pages.
 * The root layout is kept static (lang="en") to preserve ISR — see resolve-
 * locale.ts — so per-locale SSR lang isn't available there. hreflang alternates
 * (emitted in each page's generateMetadata) carry the primary SEO signal; this
 * fixes the accessibility/`:lang()` value after hydration.
 */
export function HtmlLang({ lang }: { lang: string }) {
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  return null;
}
