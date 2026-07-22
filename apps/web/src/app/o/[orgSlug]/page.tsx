export const dynamic = "force-dynamic";
// Org home — competitions as match-day cards (v3/03 §2). Nav comes from the
// /o layout; auth comes from the URL (PROMPT-30).
import Link from "@/components/ui/console-link";
import { Ticket, Trophy } from "lucide-react";
import { BillingBanner } from "@/components/billing-banner";
import { requireOrgPage } from "@/server/page-auth";
import { listCompetitions } from "@/server/usecases/competitions";
import { listCompetitionCardStats, nextLine } from "@/server/usecases/card-stats";
import { EntityCard } from "@/components/ui/entity-card";
import { sportEmoji } from "@/components/discovery-cards";
import { sportTint } from "@/lib/sport-tints";
import { CardMenu } from "@/components/ui/card-menu";
import { ViewToggleContainer } from "@/components/ui/view-toggle";
import { StatusChip, competitionChipState, CHIP_SORT } from "@/components/ui/status-chip";
import { sql } from "@/lib/db";
import { isPaidPlan, orgPlanKey } from "@/lib/entitlements";
import { formatMinor, passPrice } from "@/lib/currency";
import { preferredCurrency } from "@/lib/currency-server";
import { routes } from "@/lib/routes";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t, plural } from "@/lib/i18n";

export default async function OrgHomePage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const { auth, org, canEdit } = await requireOrgPage(orgSlug);

  // Reaching the dashboard is the end of first-run: mark onboarding done so a
  // user who left the wizard by any route (nav, back button) isn't sent back
  // to /onboarding on their next login. Idempotent — a no-op once set.
  if (auth.userId) {
    const { markOnboardingDone } = await import("@/lib/activation");
    await markOnboardingDone(auth.userId);
  }

  const locale = await resolveLocale();
  const dict = await getDictionary(locale, "ui");

  const { items: competitions } = await listCompetitions(auth, { cursor: null, limit: 100 });
  const stats = await listCompetitionCardStats(auth);

  // Event Pass state for the list (task 19, entry point 4 of 4).
  //
  // Under a paid plan neither half applies and neither read happens: the pass
  // must not be OFFERED (Pro's matrix is a strict superset — the $29 would buy
  // strictly less), and a pass row that survives a later upgrade must not be
  // ADVERTISED either, because the resolver stops consulting it the moment the
  // plan is paid. That is exactly what `usePassGateState()` collapses to
  // "paid_plan"; the same precedence, from the same predicate, on the server.
  const paidPlan = isPaidPlan(await orgPlanKey(org.id));
  const [passRows, currency] = await Promise.all([
    paidPlan
      ? []
      : // Presence, never payment: a staff-granted pass has a null
        // `stripe_payment_intent` and is fully active.
        sql<{ competition_id: string }[]>`
          select competition_id from competition_passes where org_id = ${org.id}`,
    preferredCurrency(org.id),
  ]);
  const passed = new Set(passRows.map((r) => r.competition_id));
  const passLabel = formatMinor(passPrice(currency), currency);

  // Live first, then Registration open, Draft, Completed (v3/03 §2);
  // secondary = the query's recency order, kept by stable sort.
  const sorted = competitions
    .map((c) => ({ c, chip: competitionChipState(c.status) }))
    .sort((a, b) => CHIP_SORT[a.chip] - CHIP_SORT[b.chip]);

  return (
    <>
      <BillingBanner orgId={org.id} />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <div className="mb-8 flex flex-wrap items-start justify-between gap-4 border-b border-slate-100 pb-6">
          <div className="min-w-0">
            <p className="app-eyebrow mb-1">{t(dict, "org.home.eyebrow")}</p>
            <div className="flex items-center gap-3">
              <h1 className="page-title">
                {t(dict, "org.home.title")}
              </h1>
              <span className={`badge ${roleBadge(org.role)}`}>{org.role}</span>
            </div>
            <p className="mt-1 text-sm text-slate-500">
              {canEdit
                ? t(dict, "org.home.subtitle.editor")
                : t(dict, "org.home.subtitle.viewer")}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link href="/directory" className="btn btn-ghost">
              {t(dict, "org.home.directory")}
            </Link>
            {canEdit && (
              <Link href={routes.competitionNew(orgSlug)} data-tour="new-competition" className="btn btn-primary">
                {t(dict, "org.home.newCompetition")}
              </Link>
            )}
          </div>
        </div>

        {competitions.length === 0 ? (
          canEdit ? (
            <div className="mt-12 flex flex-col items-center gap-6 text-center">
              {/* An unlit stadium waiting for a season (spec §5). */}
              <div className="app-empty-tile grid h-16 w-16 place-items-center rounded-2xl">
                <Trophy className="h-8 w-8" strokeWidth={1.5} />
              </div>
              <div>
                <h2 className="text-xl font-semibold text-slate-800">
                  {t(dict, "card.empty.competitions")}
                </h2>
              </div>
              <Link href={routes.competitionNew(orgSlug)} className="btn btn-primary">
                {t(dict, "card.empty.competitions.cta")}
              </Link>
            </div>
          ) : (
            <p className="text-sm text-slate-500">{t(dict, "org.home.empty.viewer")}</p>
          )
        ) : (
          <ViewToggleContainer storageKey="seazn.view.competitions" toggle={competitions.length > 20}>
            {sorted.map(({ c, chip }) => {
              const s = stats.get(c.id);
              const held = passed.has(c.id);
              return (
                <EntityCard
                  key={c.id}
                  href={routes.competition(orgSlug, c.slug)}
                  name={c.name}
                  media={{
                    kind: "banner",
                    emoji: sportEmoji(s?.top_sport),
                    tint: sportTint(s?.top_sport),
                  }}
                  locale={locale}
                  chip={
                    <span className="flex shrink-0 items-center gap-1.5">
                      <StatusChip state={c.frozen ? "frozen" : chip} locale={locale} />
                      {/* A seal, not a second word. The card's one wide slot is
                          the competition's NAME, and a text badge here took
                          enough of it to truncate "Spring Social" to
                          "Spring S…". The status chip already owns the card's
                          word; this says the pass is on and gets out of the
                          way, carrying its label on the element itself. */}
                      {held && (
                        <span
                          data-pass-held
                          role="img"
                          aria-label={t(dict, "pass.entry.active")}
                          title={t(dict, "pass.entry.active")}
                          className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-lime-100 text-lime-800 ring-1 ring-inset ring-lime-300"
                        >
                          <Ticket className="h-3 w-3" strokeWidth={2.25} aria-hidden />
                        </span>
                      )}
                    </span>
                  }
                  meta={
                    s
                      ? `${plural(dict, "org.home.meta.divisions", s.divisions, locale)} · ${plural(dict, "org.home.meta.entrants", s.entrants, locale)}`
                      : null
                  }
                  next={s ? nextLine(s.next, locale) : null}
                  progress={s ? { played: s.played, total: s.total } : null}
                  menu={
                    <CardMenu
                      name={c.name}
                      items={[
                        { label: t(dict, "org.home.menu.schedule"), href: routes.competitionSchedule(orgSlug, c.slug) },
                        { label: t(dict, "org.home.menu.settings"), href: routes.competitionSettings(orgSlug, c.slug) },
                        { label: t(dict, "org.home.menu.slideshow"), href: routes.slideshowCompetition(c.id), external: true },
                        // The pass, where every other per-competition action
                        // lives. Absent once held (the chip says so) and absent
                        // on a paid plan (`passed` is empty and `paidPlan`
                        // suppresses the offer) — never re-sold, never a
                        // downgrade. Editors only: the buy itself is owner-only.
                        ...(!paidPlan && !held && canEdit
                          ? [
                              {
                                label: t(dict, "pass.menu.buy", { price: passLabel }),
                                href: routes.competitionUpgrade(orgSlug, c.slug),
                              },
                            ]
                          : []),
                      ]}
                    />
                  }
                />
              );
            })}
          </ViewToggleContainer>
        )}
      </main>
    </>
  );
}

function roleBadge(role: string): string {
  if (role === "owner") return "bg-amber-100 text-amber-700";
  if (role === "admin") return "bg-purple-100 text-purple-700";
  return "bg-slate-100 text-slate-600";
}
