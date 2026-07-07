// Competition home (doc 09 §2): hero + branding (Pro — nulled in the view for
// non-entitled orgs), division cards, live-now strip. Unlisted competitions
// render with noindex; private ones never reach here (the view 404s them).
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getPublicCompetition } from "@/server/public-site/data";
import { publicRegistrationInfo } from "@/server/usecases/registrations";

export const revalidate = 30;

type Props = { params: Promise<{ orgSlug: string; competitionSlug: string }> };

interface Branding {
  logo?: string;
  banner?: string;
  colors?: { primary?: string };
  sponsors?: { name: string; url?: string; logo?: string }[];
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { orgSlug, competitionSlug } = await params;
  const data = await getPublicCompetition(orgSlug, competitionSlug);
  if (!data) return {};
  return {
    title: `${data.competition.name} — ${data.org.name}`,
    description: data.competition.description?.slice(0, 160) ?? undefined,
    // Doc 09 §1: unlisted = link-only. Keep crawlers out but the page up.
    ...(data.competition.visibility === "unlisted"
      ? { robots: { index: false, follow: false } }
      : {}),
  };
}

export default async function CompetitionHomePage({ params }: Props) {
  const { orgSlug, competitionSlug } = await params;
  const data = await getPublicCompetition(orgSlug, competitionSlug);
  if (!data) notFound();
  const { org, competition, divisions, liveNow } = data;
  const branding = (competition.branding ?? {}) as Branding;
  // Register CTA (doc 16 §1.1): shown while any division accepts submissions.
  const registration = await publicRegistrationInfo(orgSlug, competitionSlug).catch(() => null);
  const registrationOpen = registration?.divisions.some((d) => d.open) ?? false;

  const fmtDate = (d: string) =>
    new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const dateLine = [
    competition.starts_on ? fmtDate(competition.starts_on) : null,
    competition.ends_on ? fmtDate(competition.ends_on) : null,
  ]
    .filter(Boolean)
    .join(" – ");
  const totalEntrants = divisions.reduce((n, d) => n + d.entrant_count, 0);

  return (
    <div>
      {/* Hero — banner photo when branded (Pro), gradient otherwise */}
      <section className="relative mb-6 overflow-hidden rounded-2xl bg-gradient-to-br from-purple-700 via-purple-600 to-fuchsia-600 text-white shadow-lg">
        {branding.banner ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={branding.banner}
              alt=""
              className="absolute inset-0 h-full w-full object-cover"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-slate-950/80 via-slate-950/40 to-slate-950/20" />
          </>
        ) : (
          <div
            aria-hidden
            className="absolute inset-0 opacity-40"
            style={{
              backgroundImage:
                "radial-gradient(600px 200px at 85% 0%, rgba(255,255,255,0.25), transparent), radial-gradient(400px 300px at 0% 100%, rgba(255,255,255,0.12), transparent)",
            }}
          />
        )}
        <div className="relative flex flex-col gap-4 p-6 sm:p-8">
          <div className="flex items-start gap-4">
            {branding.logo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={branding.logo}
                alt=""
                className="h-14 w-14 rounded-xl bg-white/90 object-contain p-1 shadow"
              />
            ) : null}
            <div className="min-w-0 flex-1">
              <h1 className="text-3xl font-bold tracking-tight">{competition.name}</h1>
              {dateLine ? <p className="mt-1 text-sm text-white/80">{dateLine}</p> : null}
            </div>
            {registrationOpen ? (
              <Link
                href={`/${org.slug}/${competition.slug}/register`}
                className="shrink-0 rounded-lg bg-white px-4 py-2 text-sm font-semibold text-purple-700 shadow hover:bg-purple-50"
              >
                Register now
              </Link>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2 text-xs font-medium">
            <span className="rounded-full bg-white/15 px-3 py-1 backdrop-blur">
              {divisions.length} division{divisions.length === 1 ? "" : "s"}
            </span>
            <span className="rounded-full bg-white/15 px-3 py-1 backdrop-blur">
              {totalEntrants} entrant{totalEntrants === 1 ? "" : "s"}
            </span>
            {liveNow.length > 0 ? (
              <span className="flex items-center gap-1.5 rounded-full bg-emerald-400/20 px-3 py-1 text-emerald-100 backdrop-blur">
                <span className="animate-live-pulse h-1.5 w-1.5 rounded-full bg-emerald-300" />
                {liveNow.length} live now
              </span>
            ) : null}
          </div>
        </div>
      </section>

      {liveNow.length > 0 ? (
        <section className="mb-6">
          <h2 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-emerald-700">
            <span className="animate-live-pulse h-2 w-2 rounded-full bg-emerald-500" />
            Live now
          </h2>
          <ul className="flex gap-3 overflow-x-auto pb-1">
            {liveNow.map((f) => {
              const division = divisions.find((d) => d.id === f.division_id);
              return (
                <li key={f.id} className="min-w-56 shrink-0">
                  <Link
                    href={`/${org.slug}/${competition.slug}/${division?.slug}/fixtures/${f.id}`}
                    className="block rounded-xl border border-emerald-200 bg-gradient-to-br from-emerald-50 to-white p-3 text-sm shadow-sm transition hover:-translate-y-0.5 hover:border-emerald-400 hover:shadow"
                  >
                    <p className="text-xs text-zinc-500">{division?.name}</p>
                    <p className="mt-1 font-semibold tabular-nums text-zinc-800">
                      {f.summary?.headline ?? "In play"}
                    </p>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {competition.description ? (
        <section className="prose-sm mb-6 max-w-none whitespace-pre-line text-sm text-zinc-700">
          {competition.description}
        </section>
      ) : null}

      <section>
        <h2 className="mb-3 text-lg font-semibold">Divisions</h2>
        {divisions.length === 0 ? (
          <p className="text-sm text-zinc-500">No divisions published yet.</p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {divisions.map((d) => (
              <li key={d.id}>
                <Link
                  href={`/${org.slug}/${competition.slug}/${d.slug}`}
                  className="group block rounded-xl border border-purple-100 bg-white p-4 shadow-sm transition hover:-translate-y-0.5 hover:border-purple-300 hover:shadow-md"
                >
                  <p className="flex items-center justify-between font-semibold">
                    {d.name}
                    <span className="text-purple-300 transition group-hover:translate-x-0.5 group-hover:text-purple-500">
                      →
                    </span>
                  </p>
                  <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                    <span>{d.sport_name ?? d.sport_key}</span>
                    <span className="rounded-full bg-purple-50 px-2 py-0.5 uppercase text-purple-700">
                      {d.variant_key}
                    </span>
                    <span>{d.entrant_count} entrants</span>
                    <span
                      className={`rounded-full px-2 py-0.5 capitalize ${
                        d.status === "in_play" || d.status === "active"
                          ? "bg-emerald-50 text-emerald-700"
                          : "bg-zinc-100 text-zinc-600"
                      }`}
                    >
                      {d.status}
                    </span>
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {branding.sponsors && branding.sponsors.length > 0 ? (
        <section className="mt-8 border-t border-purple-100 pt-4">
          <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-zinc-400">
            Sponsors
          </h2>
          <ul className="flex flex-wrap items-center gap-3">
            {branding.sponsors.map((s) => {
              const inner = (
                <span className="flex items-center gap-2 rounded-lg border border-purple-100 bg-white px-3 py-2 text-sm text-zinc-600 shadow-sm">
                  {s.logo ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={s.logo} alt="" className="h-6 w-6 object-contain" />
                  ) : null}
                  {s.name}
                </span>
              );
              return (
                <li key={s.name}>
                  {s.url ? (
                    <a href={s.url} rel="nofollow noopener" className="hover:opacity-80">
                      {inner}
                    </a>
                  ) : (
                    inner
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
