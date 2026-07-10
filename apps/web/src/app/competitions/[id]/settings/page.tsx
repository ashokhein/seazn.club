export const dynamic = "force-dynamic";
// Competition settings — moved off the overview into its own page.
import Link from "next/link";
import { Nav } from "@/components/nav";
import { requireResourcePageAuth } from "@/server/page-auth";
import { getCompetition } from "@/server/usecases/competitions";
import { listDivisions } from "@/server/usecases/divisions";
import { CompetitionSettings } from "@/components/v2/competition-settings";
import { ArchivedDivisions } from "@/components/v2/archived-divisions";
import { hasFeature } from "@/lib/entitlements";
import { withTenant } from "@/lib/db";

/** State-derived status nudge: published → live → completed as matches progress. */
function suggestStatus(
  status: string,
  agg: { total: number; underway: number; done: number; scheduled: number },
): string | null {
  if (agg.total === 0) return null;
  if (status === "live" && agg.done === agg.total) return "completed";
  if ((status === "draft" || status === "published") && agg.underway > 0) return "live";
  if (status === "draft" && agg.scheduled > 0) return "published";
  return null;
}

export default async function CompetitionSettingsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { auth, org, canEdit } = await requireResourcePageAuth("competition", id);
  const [competition, discoveryBranding, themeBranding, allDivisions] = await Promise.all([
    getCompetition(auth, id),
    hasFeature(auth.orgId, "discovery.branding"),
    hasFeature(auth.orgId, "dashboard.branding"),
    listDivisions(auth, id, { includeArchived: true }),
  ]);
  const archivedDivisions = allDivisions.filter((d) => d.archived_at !== null);

  const [agg] = await withTenant(auth.orgId, (tx) =>
    tx<{ total: number; underway: number; done: number; scheduled: number }[]>`
      select
        count(*)::int as total,
        count(*) filter (where f.status in ('in_play','decided','finalized'))::int as underway,
        count(*) filter (where f.status in ('decided','finalized','cancelled','forfeited','abandoned'))::int as done,
        count(*) filter (where f.scheduled_at is not null)::int as scheduled
      from fixtures f
      join divisions d on d.id = f.division_id
      where d.competition_id = ${id}`,
  );
  const suggestedStatus = suggestStatus(competition.status, agg);

  return (
    <>
      <Nav />
      <main className="mx-auto max-w-2xl px-4 py-8">
        <div className="mb-6">
          <p className="text-xs text-slate-400">
            <Link href="/dashboard" className="hover:text-purple-600">
              Competitions
            </Link>{" "}
            / {org.name} /{" "}
            <Link href={`/competitions/${competition.id}`} className="hover:text-purple-600">
              {competition.name}
            </Link>
          </p>
          <h1 className="mt-1 text-xl font-semibold tracking-tight text-slate-900">
            Settings — {competition.name}
          </h1>
        </div>
        <CompetitionSettings
          competition={{
            id: competition.id,
            name: competition.name,
            slug: competition.slug,
            description: competition.description,
            starts_on: competition.starts_on,
            ends_on: competition.ends_on,
            visibility: competition.visibility,
            status: competition.status,
            frozen: competition.frozen ?? false,
            discoverable: competition.discoverable,
            discovery: (competition.discovery ?? {}) as Record<string, string | null>,
            branding: competition.branding,
          }}
          canEdit={canEdit}
          discoveryBranding={discoveryBranding}
          themeBranding={themeBranding}
          orgBranding={org.branding}
          suggestedStatus={suggestedStatus}
          archivedCount={archivedDivisions.length}
          archivedPanel={
            /* v3/09 §4 — restore/purge surface for archived divisions. */
            <ArchivedDivisions
              divisions={archivedDivisions.map((d) => ({
                id: d.id,
                name: d.name,
                sport_key: d.sport_key,
                archived_at: d.archived_at as string,
              }))}
              canEdit={canEdit}
            />
          }
        />
      </main>
    </>
  );
}
