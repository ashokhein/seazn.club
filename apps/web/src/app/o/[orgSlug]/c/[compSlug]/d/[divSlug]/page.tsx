export const dynamic = "force-dynamic";
// Division console (PROMPT-15 task 1): entrants & rosters, fixture console
// (per stage: generate/complete/schedule), standings with the cascade trace.
import Link from "@/components/ui/console-link";
import { ClipboardList, Globe, MonitorPlay, Printer } from "lucide-react";
import { StatusChip, divisionChipState } from "@/components/ui/status-chip";
import { routes } from "@/lib/routes";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t } from "@/lib/i18n";
import { requireDivisionPage } from "@/server/page-auth";
import { getDivision, listVariantOptions } from "@/server/usecases/divisions";
import { getCompetition } from "@/server/usecases/competitions";
import { listStages, getStandings } from "@/server/usecases/stages";
import { listDivisionFixtures, listFixtureHeadlines } from "@/server/usecases/fixtures";
import { BracketPanel } from "@/components/v2/bracket-panel";
import { listEntrants } from "@/server/usecases/entrants";
import { getScheduleSettings } from "@/server/usecases/schedule";
import { hasFeature } from "@/lib/entitlements";
import { listEntrantLogoUrls } from "@/server/usecases/teams";
import { resolveModule } from "@/server/engine-db";
import { effectiveEntrantModel } from "@seazn/engine/sport";
import { withTenant } from "@/lib/db";
import { DivisionDangerZone } from "@/components/v2/division-danger-zone";
import { EmbedSnippet } from "@/components/v2/embed-snippet";
import { DivisionSettings } from "@/components/v2/division-settings";
import { formatLocked } from "@/lib/format-lock";
import { resolveLogoUrl } from "@/server/public-site/data";
import { EntrantsPanel } from "@/components/v2/entrants-panel";
import { StagesPanel } from "@/components/v2/stages-panel";
import { LaunchActions } from "@/components/v2/launch-actions";
import { StandingsTable } from "@/components/public-site/standings-table";
import { ResultsMatrix } from "@/components/public-site/results-matrix";
import { StatsPanel } from "@/components/v2/stats-panel";
import { LadderPanel } from "@/components/v2/ladder-panel";
import { AmericanoPanel } from "@/components/v2/americano-panel";
import type { StandingsRow } from "@seazn/engine/competition";
import type { MetricSpecLike } from "@/lib/public-site";
import { localizedTieBreakLabel } from "@/lib/tiebreak-label";

const TABS = ["entrants", "fixtures", "standings", "stats"] as const;
// v8: editors get a Settings tab (general/format/sharing/danger).
const EDIT_TABS = [...TABS, "settings"] as const;
type Tab = (typeof EDIT_TABS)[number];
const TABLE_KINDS = new Set(["league", "group", "swiss"]);

export default async function DivisionPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; compSlug: string; divSlug: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const [{ orgSlug, compSlug, divSlug }, { tab: rawTab }] = await Promise.all([
    params,
    searchParams,
  ]);
  const page = await requireDivisionPage(orgSlug, compSlug, divSlug);
  const { auth, canEdit } = page;
  const id = page.division.id;
  const locale = await resolveLocale();
  const dict = await getDictionary(locale, "ui");
  const division = await getDivision(auth, id);
  // Landing tab follows the division's life: while you're building the field
  // it's entrants; once the tournament starts, match day lives on fixtures.
  const defaultTab: Tab =
    division.status === "active" || division.status === "completed" ? "fixtures" : "entrants";
  const requested: Tab | null = (EDIT_TABS as readonly string[]).includes(rawTab ?? "")
    ? (rawTab as Tab)
    : null;
  const tab: Tab = requested === "settings" && !canEdit ? defaultTab : (requested ?? defaultTab);
  const [competition, stages, fixtures, entrants, scheduleSettings, canExport] = await Promise.all([
    getCompetition(auth, division.competition_id),
    listStages(auth, id),
    listDivisionFixtures(auth, id),
    listEntrants(auth, id),
    getScheduleSettings(auth, id),
    hasFeature(auth.orgId, "exports"),
  ]);
  const sportModule = resolveModule(division.sport_key, division.module_version);
  // Effective entrant model (sport default ← config.entrants override) — shared
  // by the entrants panel (add form + roster editor) and the Settings tab.
  const entrantModel = effectiveEntrantModel(sportModule.entrantModel ?? null, division.config);
  const entrantNames = Object.fromEntries(entrants.map((e) => [e.id, e.display_name]));
  const hasKnockout = stages.some((s) => s.kind === "knockout");
  // Badge chips on standings rows (v3/03 §5) — resolved once per render.
  // PROMPT-62: the bracket panel on the fixtures tab shows them too.
  const entrantLogos =
    tab === "standings" || (tab === "fixtures" && hasKnockout)
      ? await listEntrantLogoUrls(auth, id)
      : undefined;
  // PROMPT-62: score headlines for bracket nodes (match_states join).
  const headlines =
    (tab === "fixtures" && hasKnockout) || tab === "standings"
      ? await listFixtureHeadlines(auth, id)
      : undefined;
  const cascade = division.tiebreakers ?? sportModule.defaultTiebreakers;

  // Standings per table stage (+ per pool), with pool labels.
  const tableStages = stages.filter((s) => TABLE_KINDS.has(s.kind));
  const standings =
    tab === "standings"
      ? await Promise.all(
          tableStages.map(async (stage) => {
            const pools = await withTenant(auth.orgId, (tx) =>
              tx<{ id: string; key: string; name: string }[]>`
                select id, key, name from pools where stage_id = ${stage.id} order by key`,
            );
            const tables =
              pools.length > 0
                ? await Promise.all(
                    pools.map(async (p) => ({
                      caption: `${stage.name} — ${p.name}`,
                      poolId: p.id as string | null,
                      snap: await getStandings(auth, stage.id, p.id),
                    })),
                  )
                : [{ caption: stage.name, poolId: null as string | null, snap: await getStandings(auth, stage.id) }];
            return { stage, tables };
          }),
        )
      : [];

  const frozen = competition.frozen ?? false;
  const editable = canEdit && !frozen;

  return (
    <>
      <main className="mx-auto max-w-6xl px-4 py-8">
        <div className="mb-6">
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <h1 className="page-title">
              {division.name}
            </h1>
            <span className="chip">
              {division.sport_key} · {division.variant_key}
            </span>
            <StatusChip state={divisionChipState(division.status)} locale={locale} />
            {frozen && <StatusChip state="frozen" locale={locale} />}
            <div className="flex-1" />
            {/* Icon + label on desktop, icon-only under `sm` (v3/02 pattern 5). */}
            <Link
              href={routes.slideshowDivision(id)}
              target="_blank"
              aria-label={t(dict, "aria.slideshowNewTab")}
              className="btn btn-ghost gap-1.5"
            >
              <MonitorPlay className="h-4 w-4" strokeWidth={1.75} />
              <span className="hidden sm:inline">{t(dict, "action.slideshow")} ↗</span>
            </Link>
            <Link
              href={routes.divisionRegistrations(orgSlug, compSlug, divSlug)}
              aria-label={t(dict, "aria.registrations")}
              className="btn btn-ghost gap-1.5"
            >
              <ClipboardList className="h-4 w-4" strokeWidth={1.75} />
              <span className="hidden sm:inline">{t(dict, "action.registrations")}</span>
            </Link>
            {competition.visibility !== "private" && (
              // G9: straight to this division's public page.
              <a
                href={`/shared/${orgSlug}/${competition.slug}/${divSlug}`}
                target="_blank"
                aria-label={t(dict, "aria.viewPublic")}
                className="btn btn-ghost gap-1.5"
              >
                <Globe className="h-4 w-4" strokeWidth={1.75} />
                <span className="hidden sm:inline">{t(dict, "action.viewPublic")} ↗</span>
              </a>
            )}
            {competition.visibility !== "private" && (
              // v3/10 #3: division-scoped QR poster PDF for the venue wall.
              <a
                href={`/shared/${orgSlug}/${competition.slug}/poster.pdf?division=${divSlug}`}
                target="_blank"
                aria-label={t(dict, "aria.qrPoster")}
                className="btn btn-ghost gap-1.5"
              >
                <Printer className="h-4 w-4" strokeWidth={1.75} />
                <span className="hidden sm:inline">{t(dict, "action.qr")}</span>
              </a>
            )}
          </div>
          {/* v8: primary actions live on their own row under the title —
              Start / Schedule / Invite wrap cleanly at 390px. */}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <LaunchActions
              divisionId={id}
              orgSlug={orgSlug}
              compSlug={compSlug}
              divSlug={divSlug}
              status={division.status}
              canEdit={editable}
            />
          </div>
        </div>

        {/* v3/02 §3.3: tabs scroll horizontally with an edge fade — never wrap. */}
        <nav className="scroll-x scroll-x-fade mb-6 flex gap-1 whitespace-nowrap border-b border-slate-200">
          {(canEdit ? EDIT_TABS : TABS).map((tabKey) => (
            <Link
              key={tabKey}
              href={routes.division(orgSlug, compSlug, divSlug, tabKey)}
              className={`border-b-2 px-4 py-2 text-sm font-medium transition ${
                tab === tabKey
                  ? "border-purple-600 text-purple-700"
                  : "border-transparent text-slate-500 hover:text-slate-800"
              }`}
            >
              {t(dict, `div.detail.tab.${tabKey}`)}
            </Link>
          ))}
        </nav>

        {tab === "entrants" && (
          <EntrantsPanel
            divisionId={id}
            entrants={entrants}
            canEdit={editable}
            positionGroups={sportModule.positions.groups}
            roles={sportModule.positions.roles ?? []}
            eligibility={division.eligibility as Record<string, unknown>[]}
            entrantModel={entrantModel}
          />
        )}

        {tab === "fixtures" && (
          <>
            {/* PROMPT-62: two-sided tree for each knockout stage, above the
                flat list (which keeps scheduling + Documents). Renders nothing
                until the bracket is generated or for non-single-elim shapes. */}
            {stages
              .filter((st) => st.kind === "knockout")
              .map((st) => (
                <div key={st.id} className="mb-6">
                  <BracketPanel
                    fixtures={fixtures.filter((f) => f.stage_id === st.id)}
                    entrantNames={entrantNames}
                    entrantBadges={entrantLogos}
                    headlines={headlines}
                    orgSlug={orgSlug}
                    compSlug={compSlug}
                    divSlug={divSlug}
                  />
                </div>
              ))}
            {stages
              .filter((st) => st.kind === "americano")
              .map((st) => (
                <AmericanoPanel key={st.id} stageId={st.id} canEdit={editable} />
              ))}
            {stages
              .filter((st) => st.kind === "ladder")
              .map((st) => (
                <div key={st.id} className="mb-6">
                  <h2 className="mb-2 text-lg font-semibold text-slate-900">{st.name}</h2>
                  <LadderPanel
                    stageId={st.id}
                    order={(st.config.ladder_order as string[] | undefined) ?? []}
                    entrants={entrantNames}
                    canEdit={editable}
                  />
                </div>
              ))}
            <StagesPanel
              divisionId={id}
              competitionId={competition.id}
              orgSlug={orgSlug}
              compSlug={compSlug}
              divSlug={divSlug}
              stages={stages}
              fixtures={fixtures}
              entrantNames={entrantNames}
              canEdit={editable}
              tz={scheduleSettings.tz}
              canExport={canExport}
            />
          </>
        )}

        {tab === "standings" && (
          <div className="space-y-8">
            {standings.length === 0 && (
              <p className="text-sm text-slate-500">
                {t(dict, "div.detail.standings.empty")}
              </p>
            )}
            {standings.map(({ stage, tables }) => (
              <section key={stage.id} className="card p-5">
                {tables.map(({ caption, poolId, snap }) => {
                  const poolFixtures = fixtures
                    .filter(
                      (f) =>
                        f.stage_id === stage.id && (f.pool_id ?? null) === poolId,
                    )
                    .map((f) => ({
                      ...f,
                      summary:
                        headlines?.[f.id] !== undefined
                          ? { headline: headlines[f.id] }
                          : null,
                    }));
                  const ranked = [...(snap.rows as StandingsRow[])].sort(
                    (a, b) => (a.rank ?? 99) - (b.rank ?? 99),
                  );
                  return (
                    <div key={caption} className="mb-6 last:mb-0 space-y-3">
                      <StandingsTable
                        rows={snap.rows as StandingsRow[]}
                        metricSpecs={sportModule.metrics as MetricSpecLike[]}
                        cascade={cascade}
                        entrantNames={entrantNames}
                        entrantLogos={entrantLogos}
                        caption={caption}
                      />
                      {poolFixtures.length > 0 && (
                        <details>
                          <summary className="cursor-pointer text-xs font-medium text-slate-500 hover:text-slate-700">
                            {t(dict, "div.detail.resultsGrid")}
                          </summary>
                          <div className="mt-2">
                            <ResultsMatrix
                              entrantIds={ranked.map((r) => r.entrantId)}
                              entrantNames={entrantNames}
                              entrantLogos={entrantLogos}
                              fixtures={poolFixtures as never}
                              fixtureHref={(fid) => {
                                const row = fixtures.find((f) => f.id === fid);
                                return row
                                  ? routes.fixture(orgSlug, compSlug, divSlug, row.fixture_no)
                                  : "#";
                              }}
                            />
                          </div>
                        </details>
                      )}
                    </div>
                  );
                })}
                {/* Cascade trace (doc 05 §4): the exact tie-break order in force. */}
                <p className="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-500">
                  {t(dict, "div.detail.tiebreak.label")}{" "}
                  {cascade.map((key, i) => (
                    <span key={key}>
                      {i > 0 && " → "}
                      <span className="text-slate-500">{localizedTieBreakLabel(dict, key)}</span>
                    </span>
                  ))}
                  {" "}
                  {division.tiebreakers
                    ? t(dict, "div.detail.tiebreak.override")
                    : t(dict, "div.detail.tiebreak.default")}
                </p>
              </section>
            ))}
          </div>
        )}

        {tab === "stats" && (
          <StatsPanel
            divisionId={id}
            publicBase={
              competition.visibility !== "private"
                ? `/shared/${orgSlug}/${compSlug}`
                : null
            }
          />
        )}

        {/* v8 spec §2: settings tab collects general/format/sharing/danger —
            the embed snippet and danger zone moved here from the page bottom. */}
        {tab === "settings" && canEdit && (
          <DivisionSettings
            division={{
              id,
              name: division.name,
              sport_key: division.sport_key,
              variant_key: division.variant_key,
              config: division.config,
              // Uploads store the storage path; resolve it so the tile
              // survives remounts (tab switches) — same fix as the card.
              logo_url: resolveLogoUrl(division.logo_storage_path, division.logo_url),
              logo_storage_path: division.logo_storage_path,
            }}
            variants={await listVariantOptions(auth, division.sport_key)}
            locked={formatLocked([{ fixture_count: fixtures.length }])}
            stages={stages.map((st) => ({
              name: st.name,
              kind: st.kind,
              config: (st.config ?? null) as Record<string, unknown> | null,
              qualification: (st.qualification ?? null) as Record<string, unknown> | null,
            }))}
            canEdit={editable}
            entrantModel={entrantModel}
            entrantModelSource={
              (() => {
                const e = (division.config as { entrants?: unknown } | null)?.entrants;
                return e && typeof e === "object" ? "override" : "sport";
              })()
            }
            divisionPathPrefix={`/o/${orgSlug}/c/${compSlug}/d/`}
            fixturesHref={routes.division(orgSlug, compSlug, divSlug, "fixtures")}
            embed={
              competition.visibility !== "private" ? (
                <EmbedSnippet
                  divisionId={id}
                  entitled={await hasFeature(auth.orgId, "embeds.enabled")}
                />
              ) : (
                <p className="text-xs text-slate-500">
                  {t(dict, "div.detail.embed.private")}
                </p>
              )
            }
            danger={
              <DivisionDangerZone
                divisionId={id}
                divisionName={division.name}
                orgSlug={orgSlug}
                compSlug={compSlug}
              />
            }
          />
        )}
      </main>
    </>
  );
}
