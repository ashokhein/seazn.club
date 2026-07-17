// Public dashboard shell (doc 09 §1). No auth anywhere under this tree — all
// reads go through the public_*_v views. Reserved slugs 404 before the DB is
// touched; a missing org 404s identically (no existence leak).
//
// Visual system: "courtside" — a dark court-slab masthead over a light page,
// scoreboard typography (Barlow Condensed, mounted only on this tree), and
// one accent color driven by the --ps-* vars (lib/public-theme.ts) so an org
// can re-brand the whole surface later without touching components.
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import Image from "next/image";
import { Barlow_Condensed } from "next/font/google";
import { AttributionLink } from "@/components/attribution-link";
import { isReservedSlug } from "@/lib/public-site";
import { publicThemeStyle } from "@/lib/public-theme";
import { getPublicOrg } from "@/server/public-site/data";
import { sharedRenameTarget } from "@/server/slug-resolve";

const displayFont = Barlow_Condensed({
  weight: ["500", "600", "700"],
  subsets: ["latin"],
  variable: "--ps-font-display",
});

export const revalidate = 30;

function monogram(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export default async function PublicOrgLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  if (isReservedSlug(orgSlug)) notFound();
  const data = await getPublicOrg(orgSlug);
  if (!data) {
    // Renamed org? The old slug keeps working (v3/01 §2).
    const renamed = await sharedRenameTarget(orgSlug);
    if (renamed) permanentRedirect(renamed);
    notFound();
  }
  const { org } = data;

  return (
    <div
      // Org brand color themes the whole public tree (Pro dashboard.branding,
      // emptied in-query otherwise); competition pages override deeper via
      // their own inline vars — the CSS cascade is the resolution chain.
      style={publicThemeStyle(org.branding)}
      className={`${displayFont.variable} flex min-h-screen flex-col bg-canvas text-ink`}
    >
      <header className="sticky top-0 z-40 bg-court text-court-ink shadow-md">
        <div className="mx-auto flex h-[52px] max-w-5xl items-center gap-3 px-4">
          {org.logo ? (
            // resolveLogoUrl(...) output — storage-served, covered by remotePatterns.
            <Image
              src={org.logo}
              alt=""
              width={32}
              height={32}
              className="h-8 w-8 shrink-0 rounded-md bg-white/10 object-cover"
            />
          ) : (
            <span
              aria-hidden
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent font-display text-sm font-bold text-accent-ink"
            >
              {monogram(org.name)}
            </span>
          )}
          <Link
            href={`/shared/${org.slug}`}
            className="min-w-0 truncate font-display text-xl font-semibold uppercase tracking-wide hover:text-white"
          >
            {org.name}
          </Link>
          {/* Was `hidden sm:block` — silently dropped below `sm` with no
              replacement (design/fix-ui README.md cross-cutting #3). This is
              a plain descriptor, not links to other pages (Live/Schedule/
              Standings live as sections/tabs further down each competition
              page, not top-level routes off this org-level layout), so
              there's nothing to reach via a hamburger — the fix is to stop
              hiding it. Kept inline (with the primary row's real estate) at
              `sm`+; below that it moves to its own line instead so it never
              crowds the org name/logo on a narrow header. */}
          <span className="ml-auto hidden shrink-0 text-[11px] font-medium uppercase tracking-[0.18em] text-court-muted sm:block">
            Live scores · Schedules · Standings
          </span>
        </div>
        <div className="border-t border-white/10 px-4 py-1 text-center text-[10px] font-medium uppercase tracking-[0.18em] text-court-muted sm:hidden">
          Live scores · Schedules · Standings
        </div>
        {/* Accent keel — the one line of brand color on the slab. */}
        <div aria-hidden className="h-0.5 bg-accent" />
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6">{children}</main>
      <footer className="mt-8 py-6 text-center text-xs text-ink-muted">
        {/* Doc 09 §4: fixed platform footer for Community; removable for Pro
            (branding entitlement, resolved server-side). */}
        {org.branded ? null : (
          <p>
            Powered by <span className="font-medium">Seazn Club</span> ·{" "}
            <AttributionLink surface="badge" />
          </p>
        )}
      </footer>
    </div>
  );
}
