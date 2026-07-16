export const dynamic = "force-dynamic";
// Org directory (People + Clubs merged into one nav item). People = the
// person register (DOB/consent, doc 07); Clubs = parent clubs that group teams
// across divisions (Jul3/01). Both are org-wide entities, so they live behind
// one "Directory" menu with a tab each.
import Link from "@/components/ui/console-link";
import { BackLink } from "@/components/back-link";
import { Nav } from "@/components/nav";
import { requirePageAuth } from "@/server/page-auth";
import { listPersons } from "@/server/usecases/persons";
import { listClubs } from "@/server/usecases/clubs";
import { listOfficialsForConsole } from "@/server/usecases/officials";
import { hasFeature } from "@/lib/entitlements";
import { PersonsPanel } from "@/components/v2/persons-panel";
import { ClubsPanel } from "@/components/v2/clubs-panel";
import { OfficialsDirectoryPanel } from "@/components/v2/officials-directory-panel";
import { Tip } from "@/components/ui/tip";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t, type Dict } from "@/lib/i18n";
import { DictProvider } from "@/components/i18n/dict-provider";

const TABS = ["players", "clubs", "officials"] as const;
type Tab = (typeof TABS)[number];

export default async function DirectoryPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab: rawTab } = await searchParams;
  const tab: Tab = (TABS as readonly string[]).includes(rawTab ?? "") ? (rawTab as Tab) : "players";
  await requirePageAuth();
  const locale = await resolveLocale();
  const ui = await getDictionary(locale, "ui");

  return (
    <DictProvider dict={ui} locale={locale}>
      <Nav />
      <main className="mx-auto max-w-4xl px-4 py-8">
        <BackLink href="/dashboard" label={t(ui, "common.dashboard")} />
        <div className="mb-6">
          <p className="app-eyebrow mb-1">{t(ui, "directory.eyebrow")}</p>
          <h1 className="page-title">{t(ui, "directory.title")}</h1>
          <p className="mt-1 text-sm text-slate-500">
            {t(ui, "directory.desc")}
          </p>
        </div>

        <nav className="mb-6 flex gap-1 border-b border-slate-200">
          {TABS.map((tabKey) => (
            <Link
              key={tabKey}
              href={`/directory?tab=${tabKey}`}
              className={`border-b-2 px-4 py-2 text-sm font-medium transition ${
                tab === tabKey
                  ? "border-purple-600 text-purple-700"
                  : "border-transparent text-slate-500 hover:text-slate-800"
              }`}
            >
              {t(ui, `directory.tab.${tabKey}`)}
            </Link>
          ))}
        </nav>

        {tab === "players" && <PlayersTab ui={ui} />}
        {tab === "clubs" && <ClubsTab ui={ui} />}
        {tab === "officials" && <OfficialsTab ui={ui} />}
      </main>
    </DictProvider>
  );
}

async function PlayersTab({ ui }: { ui: Dict }) {
  const { auth, canEdit } = await requirePageAuth();
  const { items } = await listPersons(auth, { cursor: null, limit: 200 });
  const storageBase = `${process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""}/storage/v1/object/public/assets`;
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500">
        {t(ui, "directory.players.desc")} <strong>{t(ui, "directory.players.merge")}</strong>
        <Tip id="persons.merge" className="ml-0.5 align-middle" />
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
          user_id: p.user_id,
          claim_pending: p.claim_pending,
        }))}
        storageBase={storageBase}
        canEdit={canEdit}
      />
    </div>
  );
}

async function ClubsTab({ ui }: { ui: Dict }) {
  const { auth, canEdit } = await requirePageAuth();
  const clubs = await listClubs(auth);
  const storageBase = `${process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""}/storage/v1/object/public/assets`;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-xl text-sm text-slate-500">
          {t(ui, "directory.clubs.desc")}
        </p>
        {canEdit && (
          <Link href="/import" className="btn btn-ghost text-sm">
            {t(ui, "directory.clubs.import")}
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

async function OfficialsTab({ ui }: { ui: Dict }) {
  const { auth, canEdit } = await requirePageAuth();
  const [officials, rolesMultiAllowed] = await Promise.all([
    listOfficialsForConsole(auth),
    hasFeature(auth.orgId, "officials.roles_multi"),
  ]);
  return (
    <div className="space-y-4">
      <p className="max-w-xl text-sm text-slate-500">{t(ui, "directory.officials.desc")}</p>
      <OfficialsDirectoryPanel
        officials={officials.map((o) => ({
          id: o.id,
          display_name: o.display_name,
          role_keys: o.role_keys,
          entrant_id: o.entrant_id,
          email: o.email,
          max_per_day: o.max_per_day,
          claimed: o.claimed,
          invite_pending: o.invite_pending,
        }))}
        canEdit={canEdit}
        rolesMultiAllowed={rolesMultiAllowed}
      />
    </div>
  );
}
