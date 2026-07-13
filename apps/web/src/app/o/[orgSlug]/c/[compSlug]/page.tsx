export const dynamic = "force-dynamic";
// Competition overview: divisions as match-day cards (v3/03 §2); settings
// live on their own page.
import Link from "@/components/ui/console-link";
import { CalendarRange, Globe, MonitorPlay, Printer, Settings } from "lucide-react";
import { requireCompetitionPage } from "@/server/page-auth";
import { getCompetition } from "@/server/usecases/competitions";
import { listDivisions } from "@/server/usecases/divisions";
import { listDivisionCardStats, nextLine, formatLabel } from "@/server/usecases/card-stats";
import { EntityCard } from "@/components/ui/entity-card";
import { CardMenu } from "@/components/ui/card-menu";
import { ViewToggleContainer } from "@/components/ui/view-toggle";
import { StatusChip, divisionChipState, CHIP_SORT } from "@/components/ui/status-chip";
import { divisionAccent, monogram } from "@/lib/division-hue";
import { resolveLogoUrl } from "@/server/public-site/data";
import { routes } from "@/lib/routes";
import { msg } from "@/lib/messages";

export default async function CompetitionPage({
  params,
}: {
  params: Promise<{ orgSlug: string; compSlug: string }>;
}) {
  const { orgSlug, compSlug } = await params;
  const page = await requireCompetitionPage(orgSlug, compSlug);
  const { auth, canEdit } = page;
  const id = page.competition.id;
  const [competition, divisions, stats] = await Promise.all([
    getCompetition(auth, id),
    listDivisions(auth, id),
    listDivisionCardStats(auth, id),
  ]);
  const publicPath =
    competition.visibility !== "private" ? routes.shared(orgSlug, competition.slug) : null;

  return (
    <>
      <main className="mx-auto max-w-6xl px-4 py-8">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="page-title mt-1 truncate">
              {competition.name}
            </h1>
          </div>
          {/* Header actions: icon + label on desktop, icon-only under `sm`
              (v3/02 pattern 5 — labels move into aria-label, 44px targets). */}
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={routes.slideshowCompetition(competition.id)}
              target="_blank"
              aria-label="Slideshow (opens in a new tab)"
              className="btn btn-ghost gap-1.5"
            >
              <MonitorPlay className="h-4 w-4" strokeWidth={1.75} />
              <span className="hidden sm:inline">Slideshow ↗</span>
            </Link>
            <Link
              href={routes.competitionSchedule(orgSlug, compSlug)}
              aria-label="Schedule Board"
              className="btn btn-ghost gap-1.5"
            >
              <CalendarRange className="h-4 w-4" strokeWidth={1.75} />
              <span className="hidden sm:inline">Schedule Board</span>
            </Link>
            {publicPath && (
              <Link
                href={publicPath}
                target="_blank"
                aria-label="View Public Page (opens in a new tab)"
                className="btn btn-ghost gap-1.5"
              >
                <Globe className="h-4 w-4" strokeWidth={1.75} />
                <span className="hidden sm:inline">View Public Page ↗</span>
              </Link>
            )}
            {publicPath && (
              // v3/10 #3: A4 PDF with a big QR to the dashboard — print it,
              // tape it to the venue door.
              <a
                href={`${publicPath}/poster.pdf`}
                target="_blank"
                aria-label="QR poster (PDF, opens in a new tab)"
                className="btn btn-ghost gap-1.5"
              >
                <Printer className="h-4 w-4" strokeWidth={1.75} />
                <span className="hidden sm:inline">QR</span>
              </a>
            )}
            <Link
              href={routes.competitionSettings(orgSlug, compSlug)}
              aria-label="Settings"
              className="btn btn-ghost gap-1.5"
            >
              <Settings className="h-4 w-4" strokeWidth={1.75} />
              <span className="hidden sm:inline">Settings</span>
            </Link>
          </div>
        </div>

          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-700">Divisions</h2>
              {canEdit && !competition.frozen && (
                <Link
                  href={routes.divisionNew(orgSlug, compSlug)}
                  className="btn btn-primary"
                >
                  + Add division
                </Link>
              )}
            </div>
            {divisions.length === 0 ? (
              <div className="card p-6 text-center text-sm text-slate-500">
                <p>{msg("card.empty.divisions")}</p>
                {canEdit && !competition.frozen && (
                  <Link href={routes.divisionNew(orgSlug, compSlug)} className="btn btn-primary mt-4">
                    {msg("card.empty.divisions.cta")}
                  </Link>
                )}
              </div>
            ) : (
              <ViewToggleContainer storageKey="seazn.view.divisions" toggle={divisions.length > 20}>
                {divisions
                  .map((d) => ({
                    d,
                    chip: divisionChipState(d.status, {
                      registrationOpen: stats.get(d.id)?.registration_open,
                    }),
                  }))
                  .sort((a, b) => CHIP_SORT[a.chip] - CHIP_SORT[b.chip])
                  .map(({ d, chip }) => {
                    const s = stats.get(d.id);
                    const entrantsLabel = s
                      ? `${s.entrants}${s.capacity ? `/${s.capacity}` : ""} entrant${s.entrants === 1 && !s.capacity ? "" : "s"}`
                      : null;
                    return (
                      <EntityCard
                        key={d.id}
                        href={routes.division(orgSlug, compSlug, d.slug)}
                        media={{
                          kind: "tile",
                          logoUrl: resolveLogoUrl(d.logo_storage_path, d.logo_url),
                          monogram: monogram(d.name),
                          hue: divisionAccent(d.id),
                        }}
                        name={d.name}
                        accent={divisionAccent(d.id)}
                        chip={<StatusChip state={chip} />}
                        meta={[formatLabel(s?.stage_kinds ?? []), entrantsLabel]
                          .filter(Boolean)
                          .join(" · ")}
                        next={s ? nextLine(s.next) : null}
                        progress={s ? { played: s.played, total: s.total } : null}
                        menu={
                          <CardMenu
                            name={d.name}
                            items={[
                              { label: "Schedule", href: routes.divisionSchedule(orgSlug, compSlug, d.slug) },
                              { label: "Registrations", href: routes.divisionRegistrations(orgSlug, compSlug, d.slug) },
                              { label: "Slideshow", href: routes.slideshowDivision(d.id), external: true },
                            ]}
                          />
                        }
                      />
                    );
                  })}
              </ViewToggleContainer>
            )}
          </section>
      </main>
    </>
  );
}
