import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import { NavScrollFlip } from "@/components/marketing/nav-scroll";

const LINKS = [
  { label: "Formats", href: "/formats" },
  { label: "Scheduling", href: "/scheduling" },
  { label: "Pricing", href: "/pricing" },
  { label: "Use cases", href: "/use-cases/clubs" },
];

/** Marketing nav (design/v3/12 §4.1). `night-scroll` starts transparent over
 *  the night hero and flips solid when the hero scrolls out; `light` is the
 *  solid style permanently (all non-home marketing pages). */
export async function MarketingNav({
  variant = "light",
}: {
  variant?: "night-scroll" | "light";
}) {
  const user = await getCurrentUser().catch(() => null);
  const night = variant === "night-scroll";
  return (
    <header
      data-mk-nav
      className={`sticky top-0 z-40 ${night ? "mk-nav mk-nav-night" : "mk-nav mk-nav-solid"}`}
    >
      {night ? <NavScrollFlip /> : null}
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
        <Link href="/" aria-label="Seazn Club — home" className="flex items-center gap-2">
          {/* logo-wide.png has a solid background — the night state uses a
              cream wordmark instead of inverting the bitmap. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-wide.png" alt="Seazn Club" className="mk-nav-logo-img h-9 w-auto" />
          <span aria-hidden className="mk-nav-logo-text mk-display text-xl font-bold tracking-[0.08em]">
            SEAZN CLUB
          </span>
        </Link>
        <nav className="flex items-center gap-1 sm:gap-2">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="mk-nav-link hidden rounded-lg px-3 py-1.5 text-sm md:inline-flex"
            >
              {l.label}
            </Link>
          ))}
          {user ? (
            <Link href="/dashboard" className="btn btn-primary text-sm">
              Dashboard →
            </Link>
          ) : (
            <>
              <Link href="/login" className="mk-nav-link btn btn-ghost text-sm">
                Log in
              </Link>
              <Link href="/login?tab=signup" className="mk-nav-cta btn text-sm font-semibold">
                Start free
              </Link>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}
