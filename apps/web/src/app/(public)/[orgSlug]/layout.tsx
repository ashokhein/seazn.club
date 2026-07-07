// Public dashboard shell (doc 09 §1). No auth anywhere under this tree — all
// reads go through the public_*_v views. Reserved slugs 404 before the DB is
// touched; a missing org 404s identically (no existence leak).
import Link from "next/link";
import { notFound } from "next/navigation";
import { isReservedSlug } from "@/lib/public-site";
import { getPublicOrg } from "@/server/public-site/data";

export const revalidate = 30;

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
  if (!data) notFound();
  const { org } = data;

  return (
    <div className="flex min-h-screen flex-col text-zinc-900">
      <div className="h-1 bg-gradient-to-r from-purple-600 via-fuchsia-500 to-purple-600" />
      <header className="sticky top-0 z-40 border-b border-purple-100 bg-white/80 backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center gap-3 px-4 py-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-purple-600 to-fuchsia-500 text-sm font-bold text-white">
            {org.name.slice(0, 1).toUpperCase()}
          </span>
          <Link href={`/${org.slug}`} className="truncate font-semibold hover:text-purple-700">
            {org.name}
          </Link>
        </div>
      </header>
      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-6">{children}</main>
      <footer className="border-t border-purple-100 bg-white/70 py-4 text-center text-xs text-zinc-500 backdrop-blur">
        {/* Doc 09 §4: fixed platform footer for Community; removable for Pro
            (branding entitlement, resolved server-side). */}
        {org.branded ? null : (
          <p>
            Powered by{" "}
            <a href="https://seazn.club" className="font-medium text-purple-700 underline">
              seazn.club
            </a>
          </p>
        )}
      </footer>
    </div>
  );
}
