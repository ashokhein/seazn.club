export const dynamic = "force-dynamic";
// Org directory (People + Clubs merged into one nav item). People = the
// person register (DOB/consent, doc 07); Clubs = parent clubs that group teams
// across divisions (Jul3/01). Both are org-wide entities, so they live behind
// one "Directory" menu with a tab each.
import Link from "next/link";
import { Nav } from "@/components/nav";
import { requirePageAuth } from "@/server/page-auth";
import { listPersons } from "@/server/usecases/persons";
import { listClubs } from "@/server/usecases/clubs";
import { PersonsPanel } from "@/components/v2/persons-panel";
import { ClubsPanel } from "@/components/v2/clubs-panel";

const TABS = ["players", "clubs"] as const;
type Tab = (typeof TABS)[number];

export default async function DirectoryPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab: rawTab } = await searchParams;
  const tab: Tab = (TABS as readonly string[]).includes(rawTab ?? "") ? (rawTab as Tab) : "players";
  await requirePageAuth();

  return (
    <>
      <Nav />
      <main className="mx-auto max-w-4xl px-4 py-8">
        <div className="mb-6">
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">Directory</h1>
          <p className="mt-1 text-sm text-slate-500">
            Your organisation&apos;s players and clubs — reused across every competition.
          </p>
        </div>

        <nav className="mb-6 flex gap-1 border-b border-slate-200">
          {TABS.map((t) => (
            <Link
              key={t}
              href={`/directory?tab=${t}`}
              className={`border-b-2 px-4 py-2 text-sm font-medium capitalize transition ${
                tab === t
                  ? "border-purple-600 text-purple-700"
                  : "border-transparent text-slate-500 hover:text-slate-800"
              }`}
            >
              {t}
            </Link>
          ))}
        </nav>

        {tab === "players" ? <PlayersTab /> : <ClubsTab />}
      </main>
    </>
  );
}

async function PlayersTab() {
  const { auth, canEdit } = await requirePageAuth();
  const { items } = await listPersons(auth, { cursor: null, limit: 200 });
  const storageBase = `${process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""}/storage/v1/object/public/assets`;
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500">
        Players rostered into entrants across competitions. Date of birth is used only for
        eligibility and is never shown publicly; names appear on public pages only with consent.
      </p>
      <PersonsPanel
        persons={items.map((p) => ({
          id: p.id,
          full_name: p.full_name,
          dob: p.dob,
          gender: p.gender,
          consent: p.consent as { public_name?: boolean; public_photo?: boolean },
          external_ref: p.external_ref,
          photo_path: p.photo_path,
        }))}
        storageBase={storageBase}
        canEdit={canEdit}
      />
    </div>
  );
}

async function ClubsTab() {
  const { auth, canEdit } = await requirePageAuth();
  const clubs = await listClubs(auth);
  const storageBase = `${process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""}/storage/v1/object/public/assets`;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-xl text-sm text-slate-500">
          Parent clubs group teams across age groups and divisions. A club&apos;s badge and colours
          cascade to every team that doesn&apos;t set its own.
        </p>
        {canEdit && (
          <Link href="/import" className="btn btn-ghost text-sm">
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
    </div>
  );
}
