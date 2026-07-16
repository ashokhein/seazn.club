import Link from "next/link";
import { CookieSettingsButton } from "@/components/cookie-settings-button";
import { LocaleSwitcher } from "@/components/i18n/locale-switcher";
import { getDictionary, t } from "@/lib/i18n";
import { toLocale } from "@/lib/i18n-constants";

const COLS: Array<{ headKey: string; links: Array<{ key: string; href: string }> }> = [
  {
    headKey: "footer.col.product",
    links: [
      { key: "nav.formats", href: "/formats" },
      { key: "nav.scheduling", href: "/scheduling" },
      { key: "nav.pricing", href: "/pricing" },
      { key: "footer.link.liveNow", href: "/discover" },
      { key: "footer.link.games", href: "/games" },
    ],
  },
  {
    headKey: "footer.col.who",
    links: [
      { key: "footer.link.sportsClubs", href: "/use-cases/clubs" },
      { key: "footer.link.events", href: "/use-cases/events" },
      { key: "footer.link.schools", href: "/use-cases/schools" },
    ],
  },
  {
    headKey: "footer.col.developers",
    links: [
      { key: "footer.link.apiRef", href: "/developers/reference" },
      { key: "footer.link.guides", href: "/developers/guides" },
      { key: "footer.link.changelog", href: "/developers/changelog" },
      { key: "footer.link.help", href: "/help" },
    ],
  },
  {
    headKey: "footer.col.legal",
    links: [
      { key: "footer.link.privacy", href: "/legal/privacy" },
      { key: "footer.link.terms", href: "/legal/terms" },
      { key: "footer.link.cookiePolicy", href: "/legal/cookie-policy" },
      { key: "footer.link.dpa", href: "/legal/dpa" },
      { key: "footer.link.subProcessors", href: "/legal/sub-processors" },
    ],
  },
];

/** Night footer (design/v3/12 §4.9) — closes the matchday arc. */
export async function MarketingFooter({ lang = "en" }: { lang?: string }) {
  const d = await getDictionary(toLocale(lang), "marketing");
  return (
    <footer className="bg-[var(--mk-night)]">
      <div className="mx-auto max-w-6xl px-4 py-12">
        <div className="grid gap-8 text-center sm:grid-cols-2 sm:text-left lg:grid-cols-4">
          {COLS.map((col) => (
            <div key={col.headKey}>
              <p className="mk-display mb-3 text-xs font-semibold uppercase tracking-[0.16em] text-[var(--mk-cream)]">
                {t(d, col.headKey)}
              </p>
              <ul className="space-y-2 text-sm">
                {col.links.map((l) => (
                  <li key={l.href}>
                    <Link href={l.href} className="text-[#8d7fc0] hover:text-[var(--mk-lime)]">
                      {t(d, l.key)}
                    </Link>
                  </li>
                ))}
                {col.headKey === "footer.col.legal" ? (
                  <li>
                    <CookieSettingsButton className="text-[#8d7fc0] hover:text-[var(--mk-lime)]">
                      {t(d, "footer.cookieSettings")}
                    </CookieSettingsButton>
                  </li>
                ) : null}
              </ul>
            </div>
          ))}
        </div>
        <div className="mt-10 flex flex-col items-center justify-between gap-2 border-t border-[#2b1d5c] pt-6 text-xs text-[#8d7fc0] sm:flex-row">
          <span>{t(d, "footer.rights", { year: new Date().getFullYear() })}</span>
          <LocaleSwitcher />
          <span className="mk-display tracking-[0.2em]">{t(d, "footer.tagline")}</span>
        </div>
      </div>
    </footer>
  );
}
