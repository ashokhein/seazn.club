export const dynamic = "force-dynamic";
// Division console (PROMPT-15 task 1): entrants & rosters, fixture console
// (per stage: generate/complete/schedule), standings with the cascade trace.
import Link from "next/link";
import { ClipboardList, MonitorPlay, Printer } from "lucide-react";
import { StatusChip, divisionChipState } from "@/components/ui/status-chip";
import { routes } from "@/lib/routes";
import { requireDivisionPage } from "@/server/page-auth";
import { getDivision, listVariantOptions } from "@/server/usecases/divisions";
import { getCompetition } from "@/server/usecases/competitions";
import { listStages, getStandings } from "@/server/usecases/stages";
import { listDivisionFixtures } from "@/server/usecases/fixtures";
import { listEntrants } from "@/server/usecases/entrants";
import { getScheduleSettings } from "@/server/usecases/schedule";
import { hasFeature } from "@/lib/entitlements";
import { listEntrantLogoUrls } from "@/server/usecases/teams";
import { resolveModule } from "@/server/engine-db";
import { withTenant } from "@/lib/db";
import { DivisionDangerZone } from "@/components/v2/division-danger-zone";
import { EmbedSnippet } from "@/components/v2/embed-snippet";
import { DivisionSettings } from "@/components/v2/division-settings";
import { formatLocked } from "@/lib/format-lock";
import { EntrantsPanel } from "@/components/v2/entrants-panel";
import { StagesPanel } from "@/components/v2/stages-panel";
import { LaunchActions } from "@/components/v2/launch-actions";
import { InviteScorer } from "@/components/v2/invite-scorer";
import { StandingsTable } from "@/components/public-site/standings-table";
import { StatsPanel } from "@/components/v2/stats-panel";
import { LadderPanel } from "@/components/v2/ladder-panel";
import { AmericanoPanel } from "@/components/v2/americano-panel";
import { tieBreakLabel, type StandingsRow } from "@seazn/engine/competition";
import type { MetricSpecLike } from "@/lib/public-site";

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
  const entrantNames = Object.fromEntries(entrants.map((e) => [e.id, e.display_name]));
  // Badge chips on standings rows (v3/03 §5) — resolved once per render.
  const entrantLogos =
    tab === "standings" ? await listEntrantLogoUrls(auth, id) : undefined;
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
                      snap: await getStandings(auth, stage.id, p.id),
                    })),
                  )
                : [{ caption: stage.name, snap: await getStandings(auth, stage.id) }];
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
            <StatusChip state={divisionChipState(division.status)} />
            {frozen && <StatusChip state="frozen" />}
            <div className="flex-1" />
            {/* Icon + label on desktop, icon-only under `sm` (v3/02 pattern 5). */}
            <Link
              href={routes.slideshowDivision(id)}
              target="_blank"
              aria-label="Slideshow (opens in a new tab)"
              className="btn btn-ghost gap-1.5"
            >
              <MonitorPlay className="h-4 w-4" strokeWidth={1.75} />
              <span className="hidden sm:inline">Slideshow ↗</span>
            </Link>
            <Link
              href={routes.divisionRegistrations(orgSlug, compSlug, divSlug)}
              aria-label="Registrations"
              className="btn btn-ghost gap-1.5"
            >
              <ClipboardList className="h-4 w-4" strokeWidth={1.75} />
              <span className="hidden sm:inline">Registrations</span>
            </Link>
            {competition.visibility !== "private" && (
              // v3/10 #3: division-scoped QR poster PDF for the venue wall.
              <a
                href={`/shared/${orgSlug}/${competition.slug}/poster.pdf?division=${divSlug}`}
                target="_blank"
                aria-label="QR poster (PDF, opens in a new tab)"
                className="btn btn-ghost gap-1.5"
              >
                <Printer className="h-4 w-4" strokeWidth={1.75} />
                <span className="hidden sm:inline">QR</span>
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
            {editable && (
              <InviteScorer
                orgId={auth.orgId}
                divisionId={id}
                officialLabel={sportModule.officialLabel.scorer}
              />
            )}
          </div>
        </div>

        {/* v3/02 §3.3: tabs scroll horizontally with an edge fade — never wrap. */}
        <nav className="scroll-x scroll-x-fade mb-6 flex gap-1 whitespace-nowrap border-b border-slate-200">
          {(canEdit ? EDIT_TABS : TABS).map((t) => (
            <Link
              key={t}
              href={routes.division(orgSlug, compSlug, divSlug, t)}
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

        {tab === "entrants" && (
          <EntrantsPanel
            divisionId={id}
            entrants={entrants}
            canEdit={editable}
            positionGroups={sportModule.positions.groups}
            roles={sportModule.positions.roles ?? []}
            eligibility={division.eligibility as Record<string, unknown>[]}
          />
        )}

        {tab === "fixtures" && (
          <>
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
                No table stages in this division — standings apply to league, group
                and swiss stages.
              </p>
            )}
            {standings.map(({ stage, tables }) => (
              <section key={stage.id} className="card p-5">
                {tables.map(({ caption, snap }) => (
                  <div key={caption} className="mb-6 last:mb-0">
                    <StandingsTable
                      rows={snap.rows as StandingsRow[]}
                      metricSpecs={sportModule.metrics as MetricSpecLike[]}
                      cascade={cascade}
                      entrantNames={entrantNames}
                      entrantLogos={entrantLogos}
                      caption={caption}
                    />
                  </div>
                ))}
                {/* Cascade trace (doc 05 §4): the exact tie-break order in force. */}
                <p className="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-500">
                  Tie-break cascade:{" "}
                  {cascade.map((key, i) => (
                    <span key={key}>
                      {i > 0 && " → "}
                      <span className="text-slate-500">{tieBreakLabel(key)}</span>
                    </span>
                  ))}
                  {division.tiebreakers ? " (division override)" : " (sport default)"}
                </p>
              </section>
            ))}
          </div>
        )}

        {tab === "stats" && <StatsPanel divisionId={id} />}

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
              logo_url: division.logo_url,
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
                  This competition is private, so there is nothing to embed. Set it to
                  unlisted or public in competition settings first.
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
