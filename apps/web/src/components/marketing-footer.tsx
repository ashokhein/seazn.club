import Link from "next/link";
import { CookieSettingsButton } from "@/components/cookie-settings-button";

const COLS: Array<{ head: string; links: Array<{ label: string; href: string }> }> = [
  {
    head: "Product",
    links: [
      { label: "Formats", href: "/formats" },
      { label: "Scheduling", href: "/scheduling" },
      { label: "Pricing", href: "/pricing" },
      { label: "Live now", href: "/discover" },
      { label: "Games", href: "/games" },
    ],
  },
  {
    head: "Who it's for",
    links: [
      { label: "Sports clubs", href: "/use-cases/clubs" },
      { label: "Tournaments & events", href: "/use-cases/events" },
      { label: "Schools & youth", href: "/use-cases/schools" },
    ],
  },
  {
    head: "Developers",
    links: [
      { label: "API reference", href: "/developers/reference" },
      { label: "Guides", href: "/developers/guides" },
      { label: "Changelog", href: "/developers/changelog" },
      { label: "Help centre", href: "/help" },
    ],
  },
  {
    head: "Legal",
    links: [
      { label: "Privacy", href: "/legal/privacy" },
      { label: "Terms", href: "/legal/terms" },
      { label: "Cookie policy", href: "/legal/cookie-policy" },
      { label: "DPA", href: "/legal/dpa" },
      { label: "Sub-processors", href: "/legal/sub-processors" },
    ],
  },
];

/** Night footer (design/v3/12 §4.9) — closes the matchday arc. */
export function MarketingFooter() {
  return (
    <footer className="bg-[var(--mk-night)]">
      <div className="mx-auto max-w-6xl px-4 py-12">
        <div className="grid gap-8 text-center sm:grid-cols-2 sm:text-left lg:grid-cols-4">
          {COLS.map((col) => (
            <div key={col.head}>
              <p className="mk-display mb-3 text-xs font-semibold uppercase tracking-[0.16em] text-[var(--mk-cream)]">
                {col.head}
              </p>
              <ul className="space-y-2 text-sm">
                {col.links.map((l) => (
                  <li key={l.href}>
                    <Link href={l.href} className="text-[#8d7fc0] hover:text-[var(--mk-lime)]">
                      {l.label}
                    </Link>
                  </li>
                ))}
                {col.head === "Legal" ? (
                  <li>
                    <CookieSettingsButton className="text-[#8d7fc0] hover:text-[var(--mk-lime)]" />
                  </li>
                ) : null}
              </ul>
            </div>
          ))}
        </div>
        <div className="mt-10 flex flex-col items-center justify-between gap-2 border-t border-[#2b1d5c] pt-6 text-xs text-[#8d7fc0] sm:flex-row">
          <span>© {new Date().getFullYear()} Seazn Club. All rights reserved.</span>
          <span className="mk-display tracking-[0.2em]">ANY SPORT · LIVE IN MINUTES</span>
        </div>
      </div>
    </footer>
  );
}
