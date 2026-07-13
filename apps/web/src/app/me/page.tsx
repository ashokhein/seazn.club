export const dynamic = "force-dynamic";
// Player home (PROMPT-53, doc 16 §1.3): the claimed player's locker room —
// cross-org schedule with RSVP, recent results, teams, and the consent card.
// Deliberately NOT org-scoped and NO org nav: a player may belong to three
// clubs and none of their consoles. All plans, free included.
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { routes } from "@/lib/routes";
import { msg } from "@/lib/messages";
import { listMyFixtures, listMyPersons, type MyFixture, type MyResult } from "@/server/usecases/me";
import { RsvpControl } from "@/components/me/rsvp-control";
import { ConsentCard } from "@/components/me/consent-card";
import { LogoutButton } from "@/components/logout-button";

export default async function MePage({
  searchParams,
}: {
  searchParams: Promise<{ claimed?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/me");
  const [{ upcoming, results, teams }, persons] = await Promise.all([
    listMyFixtures(user.id),
    listMyPersons(user.id),
  ]);
  const { claimed } = await searchParams;
  const [next, ...rest] = upcoming;

  return (
    <>
      <header className="app-gantry">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3">
          <span className="app-display text-base font-bold leading-none text-cream">
            Seazn <span className="text-lime-400">Club</span>
          </span>
          <span className="text-sm text-cream/60">{msg("me.eyebrow")}</span>
          <div className="flex-1" />
          <span className="text-xs text-cream/60">{user.display_name}</span>
          <LogoutButton />
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-8">
        {claimed && (
          <p className="mb-6 rounded-lg bg-lime-100 px-4 py-3 text-sm font-medium text-lime-900">
            {msg("me.claimed")}
          </p>
        )}
        <h1 className="page-title mb-6">{msg("me.title")}</h1>

        {upcoming.length === 0 && results.length === 0 && (
          <p className="card p-6 text-sm text-slate-500">{msg("me.empty")}</p>
        )}

        {next && (
          <section className="app-empty-tile mb-8 rounded-2xl p-5 sm:p-6">
            <p className="app-eyebrow mb-3 !text-lime-400">{msg("me.next.title")}</p>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="app-display text-2xl font-bold leading-tight text-cream sm:text-3xl">
                  {next.entrant_name ?? "TBD"}{" "}
                  <span className="text-cream/50">vs</span>{" "}
                  {next.opponent_name ?? "TBD"}
                </p>
                <p className="mt-1.5 text-sm text-cream/70">
                  <FixtureContext f={next} /> · {when(next.scheduled_at)}
                  {next.venue ? ` · ${next.venue}` : ""}
                  {next.court_label ? ` · ${next.court_label}` : ""}
                </p>
                {publicHref(next) && (
                  <Link
                    href={publicHref(next)!}
                    className="mt-1 inline-block text-xs text-lime-400 underline decoration-lime-400/40 underline-offset-2 hover:decoration-lime-400"
                  >
                    Match page
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
              {msg("me.upcoming.title")}
            </h2>
            <ul className="space-y-2">
              {rest.map((f) => (
                <li key={`${f.id}:${f.person_id}`} className="card space-y-2 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-slate-800">
                        {f.entrant_name ?? "TBD"} <span className="text-slate-400">vs</span>{" "}
                        {f.opponent_name ?? "TBD"}
                      </p>
                      <p className="mt-0.5 text-xs text-slate-400">
                        <FixtureContext f={f} /> · {when(f.scheduled_at)}
                        {f.venue ? ` · ${f.venue}` : ""}
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

        {results.length > 0 && (
          <section className="mb-8">
            <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">
              {msg("me.results.title")}
            </h2>
            <ul className="space-y-2">
              {results.map((r) => (
                <li key={r.id} className="card flex flex-wrap items-center gap-3 p-4">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-800">
                      {r.entrant_name ?? "TBD"} <span className="text-slate-400">vs</span>{" "}
                      {r.opponent_name ?? "TBD"}
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
              {msg("me.teams.title")}
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

        {persons.length > 0 && <ConsentCard persons={persons} />}

        {/* Growth seam (PROMPT-53): every claimed player is a future
            organiser. Quiet, last, and only when they run nothing yet. */}
        <p className="mt-10 text-center text-xs text-slate-400">
          Run your own league or tournament?{" "}
          <Link href="/orgs/new" className="text-purple-600 hover:underline">
            Create an organisation
          </Link>
        </p>
      </main>
    </>
  );
}

function FixtureContext({ f }: { f: MyFixture }) {
  return (
    <>
      {f.competition_name} · {f.division_name} · {f.org_name}
    </>
  );
}

function when(iso: string | null): string {
  if (!iso) return "unscheduled";
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** Spectator link — only competitions with a public page get one. */
function publicHref(f: MyFixture): string | null {
  if (f.competition_visibility !== "public" && f.competition_visibility !== "unlisted") return null;
  return routes.sharedFixture(f.org_slug, f.competition_slug, f.division_slug, f.id);
}

function headline(r: MyResult): string | null {
  const s = r.summary as { headline?: string } | null;
  return s?.headline ?? null;
}
