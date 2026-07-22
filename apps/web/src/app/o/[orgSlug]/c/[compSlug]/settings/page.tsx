export const dynamic = "force-dynamic";
// Competition settings — moved off the overview into its own page.
import { requireCompetitionPage } from "@/server/page-auth";
import { routes } from "@/lib/routes";
import { getCompetition } from "@/server/usecases/competitions";
import { listDivisions } from "@/server/usecases/divisions";
import { CompetitionSettings } from "@/components/v2/competition-settings";
import { ArchivedDivisions } from "@/components/v2/archived-divisions";
import { CompetitionPassEntry } from "@/components/competition-pass-entry";
import { formatMinor, passPrice } from "@/lib/currency";
import { preferredCurrency } from "@/lib/currency-server";
import { hasFeature } from "@/lib/entitlements";
import { withTenant } from "@/lib/db";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t } from "@/lib/i18n";

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
  params: Promise<{ orgSlug: string; compSlug: string }>;
}) {
  const { orgSlug, compSlug } = await params;
  const page = await requireCompetitionPage(orgSlug, compSlug, { tail: "/settings" });
  const { auth, org, canEdit } = page;
  const id = page.competition.id;
  const locale = await resolveLocale();
  const dict = await getDictionary(locale, "ui");
  const [competition, discoveryBranding, themeBranding, allDivisions, currency] =
    await Promise.all([
      getCompetition(auth, id),
      hasFeature(auth.orgId, "discovery.branding"),
      hasFeature(auth.orgId, "dashboard.branding"),
      listDivisions(auth, id, { includeArchived: true }),
      preferredCurrency(org.id),
    ]);
  const archivedDivisions = allDivisions.filter((d) => d.archived_at !== null);

  // Youth flag (v3/11 gap 8): any live division with a U-age eligibility rule
  // raises the guardian-consent interstitial before the competition leaves
  // Private. Org slug feeds the picker's share URL.
  const [youthRow] = await withTenant(auth.orgId, (tx) =>
    tx<{ youth: boolean }[]>`
      select exists(
        select 1 from divisions d,
               jsonb_array_elements(d.eligibility) r
        where d.competition_id = ${id} and d.archived_at is null
          and r->>'kind' = 'age'
          and coalesce((r->>'maxAgeAt')::int, 99) < 18
      ) as youth`,
  );

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
      <main className="mx-auto max-w-2xl px-4 py-8">
        <div className="mb-6">
          {/* Same entry point as the competition header — settings is where an
              organiser goes when a limit is on their mind, and the pass is the
              cheapest answer to most of them. */}
          <CompetitionPassEntry
            href={routes.competitionUpgrade(orgSlug, compSlug)}
            buyLabel={t(dict, "pass.entry.buy", {
              price: formatMinor(passPrice(currency), currency),
            })}
            activeLabel={t(dict, "pass.entry.active")}
            canBuy={canEdit}
          />
          <h1 className="mt-1 text-xl font-semibold tracking-tight text-slate-900">
            {t(dict, "comp.settings.title", { name: competition.name })}
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
          orgId={org.id}
          canEdit={canEdit}
          discoveryBranding={discoveryBranding}
          themeBranding={themeBranding}
          orgBranding={org.branding}
          suggestedStatus={suggestedStatus}
          sharePath={routes.shared(orgSlug, competition.slug)}
          hasYouthDivisions={youthRow?.youth ?? false}
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
