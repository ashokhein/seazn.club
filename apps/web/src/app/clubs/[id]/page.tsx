export const dynamic = "force-dynamic";
// Club hub (W1 §5.2): a per-club workspace reached from the Directory Clubs tab.
// This task ships the Overview tab only; Teams/Entries extend TABS in W1 tasks
// 9/10. The bare /clubs path still redirects to /directory?tab=clubs.
import { notFound } from "next/navigation";
import Link from "@/components/ui/console-link";
import { BackLink } from "@/components/back-link";
import { Nav } from "@/components/nav";
import { requirePageAuth } from "@/server/page-auth";
import { getClub } from "@/server/usecases/clubs";
import { HttpError } from "@/lib/errors";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t } from "@/lib/i18n";
import { DictProvider } from "@/components/i18n/dict-provider";
import { OverviewTab } from "@/components/v2/club-hub/overview-tab";
import { TeamsTab } from "@/components/v2/club-hub/teams-tab";
import { EntriesTab } from "@/components/v2/club-hub/entries-tab";
import { kitStripeStyle } from "@/components/v2/club-hub/kit-style";

const TABS = ["overview", "teams", "entries"] as const;
type Tab = (typeof TABS)[number];

export default async function ClubHubPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const [{ id }, { tab: rawTab }] = await Promise.all([params, searchParams]);
  const tab: Tab = (TABS as readonly string[]).includes(rawTab ?? "") ? (rawTab as Tab) : "overview";
  const { auth, canEdit } = await requirePageAuth();
  const locale = await resolveLocale();
  const ui = await getDictionary(locale, "ui");
  const club = await getClub(auth, id).catch((err) => {
    if (err instanceof HttpError && err.status === 404) notFound();
    throw err;
  });
  const storageBase = `${process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""}/storage/v1/object/public/assets`;
  const colors = (club.colors ?? null) as Record<string, string> | null;

  return (
    <DictProvider dict={ui} locale={locale}>
      <Nav />
      <main className="mx-auto max-w-4xl px-4 py-8">
        <BackLink href="/directory?tab=clubs" label={t(ui, "clubs.hub.back")} />

        {/* Hub header: crest tile + name. The kit stripe below is the one bold
            element; everything else stays quiet. */}
        <div className="mb-3 flex items-center gap-4">
          {club.logo_path ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`${storageBase}/${club.logo_path}`}
              alt=""
              aria-hidden
              className="h-14 w-14 rounded-xl bg-slate-50 object-contain p-1 ring-1 ring-slate-200"
            />
          ) : (
            <div className="h-14 w-14 rounded-xl bg-slate-50 ring-1 ring-slate-200" aria-hidden />
          )}
          <div className="min-w-0">
            <p className="app-eyebrow mb-1">{t(ui, "clubs.hub.eyebrow")}</p>
            <h1 className="page-title">{club.name}</h1>
          </div>
        </div>
        <div className="mb-6 h-[3px] rounded-full" style={kitStripeStyle(colors)} aria-hidden />

        <nav className="mb-6 flex gap-1 overflow-x-auto whitespace-nowrap border-b border-slate-200">
          {TABS.map((k) => (
            <Link
              key={k}
              href={`/clubs/${id}?tab=${k}`}
              className={`inline-flex min-h-[44px] shrink-0 items-center border-b-2 px-4 py-2 text-sm font-medium transition ${
                tab === k
                  ? "border-purple-600 text-purple-700"
                  : "border-transparent text-slate-500 hover:text-slate-800"
              }`}
            >
              {t(ui, `clubs.hub.tab.${k}`)}
            </Link>
          ))}
        </nav>

        {tab === "overview" && (
          <OverviewTab
            club={{
              id: club.id,
              name: club.name,
              short_name: club.short_name,
              slug: club.slug,
              logo_path: club.logo_path,
              colors,
              external_ref: club.external_ref,
              home_ground: club.home_ground,
              website: club.website,
              notes: club.notes,
              contacts: club.contacts,
            }}
            canEdit={canEdit}
          />
        )}

        {tab === "teams" && (
          <TeamsTab
            club={{
              id: club.id,
              name: club.name,
              short_name: club.short_name,
              logo_path: club.logo_path,
              teams: club.teams as {
                id: string;
                name: string;
                short_name?: string | null;
                logo_path: string | null;
                entries: { division_id: string; division_name: string }[];
              }[],
            }}
            canEdit={canEdit}
            storageBase={storageBase}
          />
        )}

        {tab === "entries" && (
          <EntriesTab
            club={{
              teams: club.teams as {
                id: string;
                name: string;
                entries: { division_id: string; division_name: string }[];
              }[],
            }}
          />
        )}
      </main>
    </DictProvider>
  );
}
