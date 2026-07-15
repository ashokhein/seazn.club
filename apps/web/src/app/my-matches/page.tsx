export const dynamic = "force-dynamic";
// The scorer console (doc 13 §3/§4, PROMPT-18): assigned fixtures for today
// and upcoming, straight into the scoring pad. Deliberately NO org nav and no
// admin surface — a parent volunteer gets a link, taps winners, done.
import Link from "next/link";
import { routes } from "@/lib/routes";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { listAssignedFixtures } from "@/server/usecases/scorers";
import { resolveModule } from "@/server/engine-db";
import { LogoutButton } from "@/components/logout-button";
import { Zoned, ViewerTzProvider } from "@/components/client-time";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t } from "@/lib/i18n";

export default async function MyMatchesPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/my-matches");
  const fixtures = await listAssignedFixtures(user.id);
  const dict = await getDictionary(await resolveLocale(), "console");

  const today = fixtures.filter(
    (f) => f.scheduled_at !== null && sameDay(new Date(f.scheduled_at), new Date()),
  );
  const later = fixtures.filter((f) => !today.includes(f));

  return (
    <ViewerTzProvider tz={user.timezone}>
      {/* Scorer console gets the same night gantry as the org chrome. */}
      <header className="app-gantry">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3">
          <span className="app-display text-base font-bold leading-none text-cream">
            Seazn <span className="text-lime-400">Club</span>
          </span>
          <span className="text-sm text-cream/60">My matches</span>
          <div className="flex-1" />
          <span className="text-xs text-cream/60">{user.display_name}</span>
          <LogoutButton label={t(dict, "nav.signOut")} />
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-8">
        <h1 className="page-title mb-6">
          My matches
        </h1>

        {fixtures.length === 0 && (
          <p className="card p-6 text-sm text-slate-500">
            Nothing assigned to you right now. Your organiser assigns matches —
            when they do, they show up here ready to score.
          </p>
        )}

        {today.length > 0 && <Section title="Today" fixtures={today} />}
        {later.length > 0 && <Section title="Upcoming" fixtures={later} />}
      </main>
    </ViewerTzProvider>
  );
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

type Assigned = Awaited<ReturnType<typeof listAssignedFixtures>>[number];

function Section({ title, fixtures }: { title: string; fixtures: Assigned[] }) {
  return (
    <section className="mb-8">
      <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">
        {title}
      </h2>
      <ul className="space-y-2">
        {fixtures.map((f) => (
          <li key={f.id}>
            <Link
              href={routes.fixture(f.org_slug, f.competition_slug, f.division_slug, f.fixture_no)}
              className="card flex flex-wrap items-center gap-3 p-4 hover:border-purple-300"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-slate-800">
                  {f.home_name ?? "TBD"} <span className="text-slate-400">vs</span>{" "}
                  {f.away_name ?? "TBD"}
                </p>
                <p className="mt-0.5 text-xs text-slate-400">
                  {f.competition_name} · {f.division_name} · Round {f.round_no}
                  {" · "}you are the {officialLabel(f)}
                </p>
              </div>
              <div className="text-right text-xs text-slate-500">
                <p>
                  {f.scheduled_at ? (
                    <Zoned
                      value={f.scheduled_at}
                      tz={f.venue_tz ?? "UTC"}
                      mode="datetime"
                      showZone
                      you="subtitle"
                    />
                  ) : (
                    "unscheduled"
                  )}
                </p>
                <p className="text-slate-400">
                  {[f.venue, f.court_label].filter(Boolean).join(" · ")}
                </p>
              </div>
              <span
                className={`badge ${
                  f.status === "in_play"
                    ? "bg-amber-100 text-amber-700"
                    : "bg-slate-100 text-slate-600"
                }`}
              >
                {f.status === "in_play" ? "in play" : "ready"}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

// Sport-aware official title (doc 13 §1): "you are the Umpire/Referee/Arbiter".
function officialLabel(f: Assigned): string {
  try {
    return resolveModule(f.sport_key, f.module_version).officialLabel.scorer;
  } catch {
    return "Scorer";
  }
}
