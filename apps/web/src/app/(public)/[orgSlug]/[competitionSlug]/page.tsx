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

  return (
    <div>
      {branding.banner ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={branding.banner}
          alt=""
          className="mb-4 max-h-48 w-full rounded-lg object-cover"
        />
      ) : null}
      <div className="mb-6 flex items-start gap-4">
        {branding.logo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={branding.logo} alt="" className="h-14 w-14 rounded object-contain" />
        ) : null}
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold">{competition.name}</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {competition.starts_on
              ? new Date(competition.starts_on).toLocaleDateString("en-GB", {
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                })
              : null}
            {competition.ends_on
              ? ` – ${new Date(competition.ends_on).toLocaleDateString("en-GB", {
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                })}`
              : null}
          </p>
        </div>
        {registrationOpen ? (
          <Link
            href={`/${org.slug}/${competition.slug}/register`}
            className="shrink-0 rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700"
          >
            Register
          </Link>
        ) : null}
      </div>

      {liveNow.length > 0 ? (
        <section className="mb-6">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-red-600">
            Live now
          </h2>
          <ul className="flex gap-3 overflow-x-auto pb-1">
            {liveNow.map((f) => {
              const division = divisions.find((d) => d.id === f.division_id);
              return (
                <li key={f.id} className="min-w-56 shrink-0">
                  <Link
                    href={`/${org.slug}/${competition.slug}/${division?.slug}/fixtures/${f.id}`}
                    className="block rounded-lg border border-red-200 bg-white p-3 text-sm shadow-sm hover:border-red-400"
                  >
                    <p className="text-xs text-zinc-500">{division?.name}</p>
                    <p className="mt-1 font-medium tabular-nums">
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
        <h2 className="mb-3 text-lg font-medium">Divisions</h2>
        {divisions.length === 0 ? (
          <p className="text-sm text-zinc-500">No divisions published yet.</p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {divisions.map((d) => (
              <li key={d.id}>
                <Link
                  href={`/${org.slug}/${competition.slug}/${d.slug}`}
                  className="block rounded-lg border border-zinc-200 bg-white p-4 shadow-sm hover:border-zinc-400"
                >
                  <p className="font-medium">{d.name}</p>
                  <p className="mt-1 flex flex-wrap gap-2 text-xs text-zinc-500">
                    <span>{d.sport_name ?? d.sport_key}</span>
                    <span className="rounded bg-zinc-100 px-1.5 py-0.5 uppercase">
                      {d.variant_key}
                    </span>
                    <span>{d.entrant_count} entrants</span>
                    <span>{d.status}</span>
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {branding.sponsors && branding.sponsors.length > 0 ? (
        <section className="mt-8 border-t border-zinc-200 pt-4">
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-400">
            Sponsors
          </h2>
          <ul className="flex flex-wrap items-center gap-4">
            {branding.sponsors.map((s) => (
              <li key={s.name} className="text-sm text-zinc-600">
                {s.url ? (
                  <a href={s.url} rel="nofollow noopener" className="underline">
                    {s.name}
                  </a>
                ) : (
                  s.name
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
