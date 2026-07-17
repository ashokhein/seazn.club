import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import { NavScrollFlip } from "@/components/marketing/nav-scroll";
import { MarketingMobileNav } from "@/components/marketing/mobile-nav";
import { getDictionary, t } from "@/lib/i18n";
import { toLocale } from "@/lib/i18n-constants";

const LINKS = [
  { key: "nav.formats", href: "/formats" },
  { key: "nav.scheduling", href: "/scheduling" },
  { key: "nav.pricing", href: "/pricing" },
  { key: "nav.useCases", href: "/use-cases/clubs" },
];

/** Marketing nav (design/v3/12 §4.1). `night-scroll` starts transparent over
 *  the night hero and flips solid when the hero scrolls out; `light` is the
 *  solid style permanently (all non-home marketing pages). */
export async function MarketingNav({
  variant = "light",
  lang = "en",
}: {
  variant?: "night-scroll" | "light";
  lang?: string;
}) {
  const [user, d] = await Promise.all([
    getCurrentUser().catch(() => null),
    getDictionary(toLocale(lang), "marketing"),
  ]);
  const night = variant === "night-scroll";
  return (
    <header
      data-mk-nav
      className={`sticky top-0 z-40 ${night ? "mk-nav mk-nav-night" : "mk-nav mk-nav-solid"}`}
    >
      {night ? <NavScrollFlip /> : null}
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
        <Link href="/" aria-label="Seazn Club — home" className="flex items-center gap-2">
          {/* logo-wide.png is the night-ink wordmark for light navs; the night
              state swaps to logo-wide-night.png — the cream wordmark carrying
              the lime pitch line + red ball, legible over the floodlit hero.
              Exactly one shows at a time via CSS (globals.css §mk-nav). */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-wide.png" alt="Seazn Club" className="mk-nav-logo-img h-9 w-auto" />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-wide-night.png" alt="Seazn Club" className="mk-nav-logo-img-night h-9 w-auto" />
        </Link>
        <nav className="flex items-center gap-1 sm:gap-2">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="mk-nav-link hidden rounded-lg px-3 py-1.5 text-sm md:inline-flex"
            >
              {t(d, l.key)}
            </Link>
          ))}
          {user ? (
            <Link href="/dashboard" className="btn btn-primary text-sm">
              {t(d, "nav.dashboard")} →
            </Link>
          ) : (
            <>
              <Link href="/login" className="mk-nav-link btn btn-ghost text-sm">
                {t(d, "nav.login")}
              </Link>
              <Link href="/login?tab=signup" className="mk-nav-cta btn text-sm font-semibold">
                {t(d, "nav.startFree")}
              </Link>
            </>
          )}
          <MarketingMobileNav
            links={LINKS.map((l) => ({ href: l.href, label: t(d, l.key) }))}
            openLabel={t(d, "nav.openMenu")}
            closeLabel={t(d, "nav.closeMenu")}
            night={night}
          />
        </nav>
      </div>
    </header>
  );
}
