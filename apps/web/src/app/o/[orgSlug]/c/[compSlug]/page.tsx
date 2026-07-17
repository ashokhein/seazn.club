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
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t, plural } from "@/lib/i18n";

export default async function CompetitionPage({
  params,
}: {
  params: Promise<{ orgSlug: string; compSlug: string }>;
}) {
  const { orgSlug, compSlug } = await params;
  const page = await requireCompetitionPage(orgSlug, compSlug);
  const { auth, canEdit } = page;
  const id = page.competition.id;
  const locale = await resolveLocale();
  const dict = await getDictionary(locale, "ui");
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
              aria-label={t(dict, "aria.slideshowNewTab")}
              className="btn btn-ghost gap-1.5"
            >
              <MonitorPlay className="h-4 w-4" strokeWidth={1.75} />
              <span className="hidden sm:inline">{t(dict, "action.slideshow")} ↗</span>
            </Link>
            <Link
              href={routes.competitionSchedule(orgSlug, compSlug)}
              aria-label={t(dict, "aria.scheduleBoard")}
              className="btn btn-ghost gap-1.5"
            >
              <CalendarRange className="h-4 w-4" strokeWidth={1.75} />
              <span className="hidden sm:inline">{t(dict, "action.scheduleBoard")}</span>
            </Link>
            {publicPath && (
              <Link
                href={publicPath}
                target="_blank"
                aria-label={t(dict, "aria.viewPublicNewTab")}
                className="btn btn-ghost gap-1.5"
              >
                <Globe className="h-4 w-4" strokeWidth={1.75} />
                <span className="hidden sm:inline">{t(dict, "action.viewPublic")} ↗</span>
              </Link>
            )}
            {publicPath && (
              // v3/10 #3: A4 PDF with a big QR to the dashboard — print it,
              // tape it to the venue door.
              <a
                href={`${publicPath}/poster.pdf`}
                target="_blank"
                aria-label={t(dict, "aria.qrPoster")}
                className="btn btn-ghost gap-1.5"
              >
                <Printer className="h-4 w-4" strokeWidth={1.75} />
                <span className="hidden sm:inline">{t(dict, "action.qr")}</span>
              </a>
            )}
            <Link
              href={routes.competitionSettings(orgSlug, compSlug)}
              aria-label={t(dict, "aria.settings")}
              className="btn btn-ghost gap-1.5"
            >
              <Settings className="h-4 w-4" strokeWidth={1.75} />
              <span className="hidden sm:inline">{t(dict, "action.settings")}</span>
            </Link>
          </div>
        </div>

          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-700">{t(dict, "comp.detail.divisions")}</h2>
              {canEdit && !competition.frozen && (
                <Link
                  href={routes.divisionNew(orgSlug, compSlug)}
                  className="btn btn-primary"
                >
                  + {t(dict, "action.addDivision")}
                </Link>
              )}
            </div>
            {divisions.length === 0 ? (
              <div className="card p-6 text-center text-sm text-slate-500">
                <p>{t(dict, "card.empty.divisions")}</p>
                {canEdit && !competition.frozen && (
                  <Link href={routes.divisionNew(orgSlug, compSlug)} className="btn btn-primary mt-4">
                    {t(dict, "card.empty.divisions.cta")}
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
                    // Plural picks the noun; the count string keeps the "used/cap"
                    // form, so force the plural noun whenever a capacity is shown.
                    const entrantsLabel = s
                      ? `${s.entrants}${s.capacity ? `/${s.capacity}` : ""} ${plural(dict, "card.meta.entrants", s.capacity ? 2 : s.entrants, locale)}`
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
                        locale={locale}
                        chip={<StatusChip state={chip} locale={locale} />}
                        meta={[formatLabel(s?.stage_kinds ?? []), entrantsLabel]
                          .filter(Boolean)
                          .join(" · ")}
                        next={s ? nextLine(s.next, locale) : null}
                        progress={s ? { played: s.played, total: s.total } : null}
                        menu={
                          <CardMenu
                            name={d.name}
                            items={[
                              { label: t(dict, "action.schedule"), href: routes.divisionSchedule(orgSlug, compSlug, d.slug) },
                              { label: t(dict, "action.registrations"), href: routes.divisionRegistrations(orgSlug, compSlug, d.slug) },
                              { label: t(dict, "action.slideshow"), href: routes.slideshowDivision(d.id), external: true },
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
