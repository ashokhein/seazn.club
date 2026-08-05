export const dynamic = "force-dynamic";
// Competition settings — moved off the overview into its own page.
import { requireCompetitionPage } from "@/server/page-auth";
import { routes } from "@/lib/routes";
import { getCompetition } from "@/server/usecases/competitions";
import { listDivisions } from "@/server/usecases/divisions";
import { CompetitionSettings } from "@/components/v2/competition-settings";
import { ArchivedDivisions } from "@/components/v2/archived-divisions";
import { archivedSlotsExplainRefusal } from "@/server/usecases/division-slots";
import { CompetitionPassEntry } from "@/components/competition-pass-entry";
import { formatMinor } from "@/lib/currency";
import { lowestPassRung, passActiveLabels, passEndedReasons } from "@/lib/pass-ladder";
import { preferredCurrency } from "@/lib/currency-server";
import { hasFeature } from "@/lib/entitlements";
import { sql, withTenant } from "@/lib/db";
import { checkoutTrialDays } from "@/lib/billing";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t } from "@/lib/i18n";
// The status nudge lived here as a private function until v17 gap #362. It moved
// to lib/ so the overview's wrap-up prompt and this page decide from ONE rule —
// an organiser who follows the prompt here must not arrive to find settings
// silent — and so the date arm is reachable from a unit test.
import { suggestStatus } from "@/lib/competition-wrapup";

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
  const [
    competition,
    discoveryBranding,
    themeBranding,
    allDivisions,
    currency,
    [subRow],
    explainArchivedSlots,
  ] = await Promise.all([
      getCompetition(auth, id),
      hasFeature(auth.orgId, "discovery.branding"),
      hasFeature(auth.orgId, "dashboard.branding"),
      listDivisions(auth, id, { includeArchived: true }),
      preferredCurrency(org.id),
      // v17 gap #354 — the "ended" pass card below offers a Go Pro link whose
      // label must not promise a trial the checkout won't grant. Same read
      // `checkoutTrialDays` (lib/billing.ts) itself consults.
      sql<{ trial_used_at: string | null }[]>`
        select s.trial_used_at from organizations o
        join subscriptions s on s.id = o.subscription_id
        where o.id = ${org.id}`,
      // Read before anyone is refused anything, because the refusal happens in
      // a client component after a DELETE this server render is long finished.
      // Restore is charged on exactly the count a create is charged on (V354),
      // so this surface owes the same explanation the wizard gives — and the
      // rows doing the charging are the ones this page is about to list.
      archivedSlotsExplainRefusal(auth, id),
    ]);
  const archivedDivisions = allDivisions.filter((d) => d.archived_at !== null);
  const trialAvailable = checkoutTrialDays(subRow) > 0;

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
  const suggestedStatus = suggestStatus(competition.status, competition.ends_on, agg);

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
              // The ladder's FLOOR, derived — the copy says "from" and this
              // link leads to the page where the rung is actually chosen.
              price: formatMinor(lowestPassRung(currency).amountMinor, currency),
            })}
            activeLabels={passActiveLabels(dict)}
            endedLabel={t(dict, "pass.entry.ended")}
            endedReasons={passEndedReasons(dict)}
            nextEditionHref={routes.competitionNew(orgSlug)}
            nextEditionLabel={t(dict, "pass.entry.ended.nextEdition")}
            closedLinks={{
              terminal: {
                href: routes.competitionNew(orgSlug),
                label: t(dict, "pass.entry.ended.nextEdition"),
              },
              past_ends_on: {
                href: routes.competitionSettings(orgSlug, compSlug),
                label: t(dict, "pass.entry.closed.updateEndDate"),
              },
            }}
            goProHref={routes.billing(orgSlug)}
            goProLabel={t(dict, trialAvailable ? "upgrade.proCard.cta" : "upgrade.proCard.ctaNoTrial")}
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
              archivedSlotsExplainRefusal={explainArchivedSlots}
            />
          }
        />
      </main>
    </>
  );
}
