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
    <div className="flex min-h-screen flex-col bg-zinc-50 text-zinc-900">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-3">
          <Link href={`/${org.slug}`} className="font-semibold">
            {org.name}
          </Link>
        </div>
      </header>
      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-6">{children}</main>
      <footer className="border-t border-zinc-200 bg-white py-4 text-center text-xs text-zinc-500">
        {/* Doc 09 §4: fixed platform footer for Community; removable for Pro
            (branding entitlement, resolved server-side). */}
        {org.branded ? null : (
          <p>
            Powered by{" "}
            <a href="https://seazn.club" className="font-medium text-zinc-700 underline">
              seazn.club
            </a>
          </p>
        )}
      </footer>
    </div>
  );
}
