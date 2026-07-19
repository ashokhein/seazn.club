export const dynamic = "force-dynamic";
// Player home (PROMPT-53, doc 16 §1.3): the claimed player's locker room —
// cross-org schedule with RSVP, recent results, teams, and the consent card.
// Deliberately NOT org-scoped and NO org nav: a player may belong to three
// clubs and none of their consoles. All plans, free included.
import Link from "next/link";
import { redirect } from "next/navigation";
import { getActiveOrgId, getCurrentUser, getUserOrgs } from "@/lib/auth";
import { routes } from "@/lib/routes";
import {
  getMySuspensions,
  listMyFixtures,
  listMyPersons,
  listMyPlayerStats,
  type MyFixture,
  type MyResult,
} from "@/server/usecases/me";
import { getMyOfficiating, listPendingOfficiatingClaims } from "@/server/usecases/me-officiating";
import { myMarksAverage } from "@/server/usecases/official-marks";
import { RsvpControl } from "@/components/me/rsvp-control";
import { OfficiatingLane } from "@/components/me/officiating-lane";
import { SuspensionsLane } from "@/components/me/suspensions-lane";
import { ConsentCard } from "@/components/me/consent-card";
import { LogoutButton } from "@/components/logout-button";
import { RunYourOwnCta } from "@/components/run-your-own-cta";
import { Zoned, ViewerTzProvider } from "@/components/client-time";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t } from "@/lib/i18n";
import { DictProvider } from "@/components/i18n/dict-provider";

export default async function MePage({
  searchParams,
}: {
  searchParams: Promise<{ claimed?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/me");
  const locale = await resolveLocale();
  const [dict, ui] = await Promise.all([
    getDictionary(locale, "console"),
    getDictionary(locale, "ui"),
  ]);
  const [
    { upcoming, results, teams },
    officiating,
    pendingOfficiatingClaims,
    persons,
    stats,
    orgs,
    activeOrgId,
    mySuspensions,
    myAverage,
  ] = await Promise.all([
      listMyFixtures(user.id),
      getMyOfficiating(user.id),
      // Pending invites run regardless of is_official (PROMPT-57 v11.1) — a
      // brand-new official with no linked row yet still needs to see (and
      // accept) their very first invite.
      listPendingOfficiatingClaims(user.email),
      listMyPersons(user.id),
      listMyPlayerStats(user.id),
      // Dual-role seam: organisers who are also players get a door back.
      // Read-only resolve — resolveActiveOrg repairs the cookie, which a
      // Server Component render is not allowed to do.
      getUserOrgs(user.id),
      getActiveOrgId(),
      getMySuspensions(user.id),
      // The official's own cross-org average (D4) — null below 3 marks.
      myMarksAverage(user.id),
    ]);
  const activeOrg = orgs.find((o) => o.id === activeOrgId) ?? orgs[0] ?? null;
  const { claimed } = await searchParams;
  const [next, ...rest] = upcoming;

  return (
    <ViewerTzProvider tz={user.timezone}>
      <DictProvider dict={ui} locale={locale}>
      <header className="app-gantry">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3">
          <span className="app-display text-base font-bold leading-none text-cream">
            Seazn <span className="text-lime-400">Club</span>
          </span>
          <span className="text-sm text-cream/60">{t(ui, "me.eyebrow")}</span>
          <div className="flex-1" />
          {activeOrg && (
            <Link
              href={routes.orgHome(activeOrg.slug)}
              className="rounded-md px-2.5 py-1.5 text-sm font-medium text-cream/70 transition-colors hover:bg-cream/10 hover:text-cream"
            >
              ← {t(ui, "me.console")}
            </Link>
          )}
          <span className="text-xs text-cream/60">{user.display_name}</span>
          <LogoutButton label={t(dict, "nav.signOut")} />
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-8">
        {claimed && (
          <p className="mb-6 rounded-lg bg-lime-100 px-4 py-3 text-sm font-medium text-lime-900">
            {t(ui, "me.claimed")}
          </p>
        )}
        <h1 className="page-title mb-6">{t(ui, "me.title")}</h1>

        <RunYourOwnCta label={t(ui, "me.runYourOwn.title")} cta={t(ui, "me.runYourOwn.cta")} />

        {!officiating.is_official &&
          pendingOfficiatingClaims.length === 0 &&
          meEmptyState(upcoming.length, results.length, teams.length) === "unrostered" && (
            <p className="card flex min-h-[40vh] items-center justify-center p-6 text-center text-sm text-slate-500">
              {t(ui, "me.empty")}
            </p>
          )}

        {!officiating.is_official &&
          pendingOfficiatingClaims.length === 0 &&
          meEmptyState(upcoming.length, results.length, teams.length) === "rostered" && (
            <p className="card p-6 text-sm text-slate-500">{t(ui, "me.emptyRostered")}</p>
          )}

        {next && (
          <section className="app-empty-tile mb-8 rounded-2xl p-5 sm:p-6">
            <p className="app-eyebrow mb-3 !text-lime-400">{t(ui, "me.next.title")}</p>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="app-display text-2xl font-bold leading-tight text-cream sm:text-3xl">
                  {next.entrant_name ?? t(ui, "me.tbd")}{" "}
                  <span className="text-cream/50">vs</span>{" "}
                  {next.opponent_name ?? t(ui, "me.tbd")}
                </p>
                <p className="mt-1.5 text-sm text-cream/70">
                  <FixtureContext f={next} />
                  {next.venue ? ` · ${next.venue}` : ""}
                  {next.court_label ? ` · ${next.court_label}` : ""}
                </p>
                <p className="mt-1 text-sm font-medium text-cream/90">
                  {next.scheduled_at ? (
                    <Zoned
                      value={next.scheduled_at}
                      tz={next.venue_tz ?? "UTC"}
                      mode="datetime"
                      showZone
                      you="subtitle"
                    />
                  ) : (
                    t(ui, "me.unscheduled")
                  )}
                </p>
                {publicHref(next) && (
                  <Link
                    href={publicHref(next)!}
                    className="mt-1 inline-block text-xs text-lime-400 underline decoration-lime-400/40 underline-offset-2 hover:decoration-lime-400"
                  >
                    {t(ui, "me.matchPage")}
                  </Link>
                )}
              </div>
              <div className="w-full sm:w-auto sm:min-w-[16rem]">
                <RsvpControl
                  fixtureId={next.id}
                  initial={next.availability}
                  checkedInAt={next.checked_in_at}
                  onDark
                />
              </div>
            </div>
          </section>
        )}

        {rest.length > 0 && (
          <section className="mb-8">
            <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">
              {t(ui, "me.upcoming.title")}
            </h2>
            <ul className="space-y-2">
              {rest.map((f) => (
                <li key={`${f.id}:${f.person_id}`} className="card space-y-2 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-slate-800">
                        {f.entrant_name ?? t(ui, "me.tbd")} <span className="text-slate-400">vs</span>{" "}
                        {f.opponent_name ?? t(ui, "me.tbd")}
                      </p>
                      <p className="mt-0.5 text-xs text-slate-400">
                        <FixtureContext f={f} />
                        {f.venue ? ` · ${f.venue}` : ""}
                      </p>
                      <p className="mt-0.5 text-xs font-medium text-slate-600">
                        {f.scheduled_at ? (
                          <Zoned
                            value={f.scheduled_at}
                            tz={f.venue_tz ?? "UTC"}
                            mode="datetime"
                            showZone
                            you="subtitle"
                          />
                        ) : (
                          "Unscheduled"
                        )}
                      </p>
                    </div>
                    {publicHref(f) && (
                      <Link
                        href={publicHref(f)!}
                        className="text-xs text-purple-600 hover:underline"
                      >
                        Match page
                      </Link>
                    )}
                  </div>
                  <RsvpControl
                    fixtureId={f.id}
                    initial={f.availability}
                    checkedInAt={f.checked_in_at}
                  />
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Officiating lane (PROMPT-57, v11.1 pending invites): shows once a
            claimed official points at this login OR an invite is waiting on
            this email — a pure player with neither never sees it. */}
        {(officiating.is_official || pendingOfficiatingClaims.length > 0) && (
          <OfficiatingLane
            isOfficial={officiating.is_official}
            assignments={officiating.assignments}
            completed={officiating.completed}
            blackouts={officiating.blackouts}
            pendingClaims={pendingOfficiatingClaims}
            myAverage={myAverage}
          />
        )}

        {/* Own active suspensions (SPEC-1) — any org the player is banned in. */}
        <SuspensionsLane suspensions={mySuspensions} />

        {results.length > 0 && (
          <section className="mb-8">
            <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">
              {t(ui, "me.results.title")}
            </h2>
            <ul className="space-y-2">
              {results.map((r) => (
                <li key={r.id} className="card flex flex-wrap items-center gap-3 p-4">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-800">
                      {r.entrant_name ?? t(ui, "me.tbd")} <span className="text-slate-400">vs</span>{" "}
                      {r.opponent_name ?? t(ui, "me.tbd")}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-400">
                      {r.competition_name} · {r.division_name} · {r.org_name}
                    </p>
                  </div>
                  <span className="app-display text-lg font-bold text-slate-700">
                    {headline(r) ?? "—"}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {teams.length > 0 && (
          <section className="mb-8">
            <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">
              {t(ui, "me.teams.title")}
            </h2>
            <ul className="flex flex-wrap gap-2">
              {teams.map((t) => (
                <li
                  key={t.entrant_id}
                  className="rounded-full border border-slate-200 bg-surface px-3 py-1.5 text-xs text-slate-600"
                >
                  <span className="font-medium text-slate-800">{t.entrant_name}</span>{" "}
                  · {t.division_name} · {t.org_name}
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* G6 — my stat blocks (PROMPT-65 self-view): every snapshot for my
            claimed persons, private competitions included; the public-profile
            link shows only where the public card would actually render
            (public competition + name consent). */}
        {stats.length > 0 && (
          <section className="mb-8" data-testid="me-stats">
            <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">
              {t(ui, "me.stats.title")}
            </h2>
            <ul className="space-y-3">
              {stats.map((s) => {
                const consented =
                  persons.find((p) => p.id === s.person_id)?.consent.public_name === true;
                return (
                  <li key={`${s.person_id}:${s.division_slug}`} className="card space-y-2 p-4">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="text-sm font-medium text-slate-800">
                        {s.division_name} · {s.competition_name}
                        <span className="ml-1.5 text-xs text-slate-400">{s.org_name}</span>
                      </p>
                      {s.competition_public && consented && (
                        <Link
                          href={`/shared/${s.org_slug}/${s.competition_slug}/players/${s.person_id}`}
                          className="text-xs font-medium text-purple-700 hover:underline"
                        >
                          {t(ui, "me.stats.publicProfile")}
                        </Link>
                      )}
                    </div>
                    <dl className="flex flex-wrap gap-x-6 gap-y-2">
                      {s.metrics.map((m) => (
                        <div key={m.key} className="min-w-16">
                          <dt className="text-[11px] uppercase tracking-wide text-slate-400">
                            {m.label}
                          </dt>
                          <dd className="font-display text-2xl font-bold tabular-nums text-slate-900">
                            {m.value}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {persons.length > 0 && <ConsentCard persons={persons} />}

        {/* Growth seam (PROMPT-53): every claimed player is a future
            organiser. Quiet, last, and only when they run nothing yet. */}
        <p className="mt-10 text-center text-xs text-slate-400">
          {t(ui, "me.growth.q")}{" "}
          <Link href="/orgs/new" className="text-purple-600 hover:underline">
            {t(ui, "me.growth.cta")}
          </Link>
        </p>
      </main>
      </DictProvider>
    </ViewerTzProvider>
  );
}

function FixtureContext({ f }: { f: MyFixture }) {
  return (
    <>
      {f.competition_name} · {f.division_name} · {f.org_name}
    </>
  );
}

/** Spectator link — only competitions with a public page get one. */
function publicHref(f: MyFixture): string | null {
  if (f.competition_visibility !== "public" && f.competition_visibility !== "unlisted") return null;
  return routes.sharedFixture(f.org_slug, f.competition_slug, f.division_slug, f.id);
}

/**
 * "Not rostered anywhere" and "rostered but nothing scheduled yet" are
 * different situations that need different copy — see fix-ui audit
 * 04-account-public-embed.md.
 */
export function meEmptyState(
  upcomingCount: number,
  resultsCount: number,
  teamsCount: number,
): "unrostered" | "rostered" | null {
  if (upcomingCount > 0 || resultsCount > 0) return null;
  return teamsCount > 0 ? "rostered" : "unrostered";
}

function headline(r: MyResult): string | null {
  const s = r.summary as { headline?: string } | null;
  return s?.headline ?? null;
}
