export const dynamic = "force-dynamic";
// Clubs directory (Jul3/01, PROMPT-21): parent clubs across competitions,
// bulk logo assignment, teams-across-divisions detail.
import Link from "next/link";
import { Nav } from "@/components/nav";
import { requirePageAuth } from "@/server/page-auth";
import { listClubs } from "@/server/usecases/clubs";
import { ClubsPanel } from "@/components/v2/clubs-panel";

export default async function ClubsPage() {
  const { auth, canEdit } = await requirePageAuth();
  const clubs = await listClubs(auth);
  const storageBase = `${process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""}/storage/v1/object/public/assets`;

  return (
    <>
      <Nav />
      <main className="mx-auto max-w-4xl px-4 py-8">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-slate-900">Clubs</h1>
            <p className="mt-1 text-sm text-slate-500">
              Parent clubs group teams across age groups and divisions. A club&apos;s badge
              and colours cascade to every team that doesn&apos;t set its own.
            </p>
          </div>
          {canEdit && (
            <Link href="/import" className="btn">
              Bulk import participants
            </Link>
          )}
        </div>
        <ClubsPanel
          clubs={clubs.map((c) => ({
            id: c.id,
            name: c.name,
            short_name: c.short_name,
            logo_path: c.logo_path,
            external_ref: c.external_ref,
          }))}
          storageBase={storageBase}
          canEdit={canEdit}
        />
      </main>
    </>
  );
}
