// Org landing (doc 09 §1): the org's `public` competitions. Unlisted ones are
// reachable by direct link only — never listed here.
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { ChevronRight } from "lucide-react";
import { getPublicOrg } from "@/server/public-site/data";
import { competitionChip, chipLabelKey } from "@/lib/public-site";
import { renderProse } from "@/lib/prose";
import { CompetitionProse } from "@/components/public-site/competition-prose";
import { getDictionary, t, type Dict } from "@/lib/i18n";
import { hasLocale, DEFAULT_LOCALE, type Locale } from "@/lib/i18n-constants";

/** Public pages render in the org's locale for every visitor — a pure function
 *  of the org (not the request), so the page stays ISR-cacheable. */
function orgLocale(defaultLocale: string): Locale {
  return hasLocale(defaultLocale) ? defaultLocale : DEFAULT_LOCALE;
}

export const revalidate = 30;

// ISR (task-8): a dynamic-param route with no generateStaticParams never
// gets ISR treatment in this Next version, regardless of `revalidate` above
// — empty array + default dynamicParams=true still enables on-demand ISR
// (first request renders + caches; docs: api-reference/functions/
// generate-static-params.md).
export async function generateStaticParams() {
  return [];
}

type Props = { params: Promise<{ orgSlug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { orgSlug } = await params;
  const data = await getPublicOrg(orgSlug);
  if (!data) return {};
  const dict = await getDictionary(orgLocale(data.org.default_locale), "public");
  return {
    title: data.org.name,
    description: t(dict, "org.competitionsBy", { org: data.org.name }),
  };
}

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

/** Spectator-language chip; the status → chip mapping lives in
    lib/public-site.ts (competitionChip) so it unit-tests without JSX. */
function statusChip(status: string, dict: Dict) {
  const chip = competitionChip(status);
  const label = t(dict, chipLabelKey(status));
  if (chip === "on-now") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-emerald-700 ring-1 ring-inset ring-emerald-200">
        <span className="animate-live-pulse h-1.5 w-1.5 rounded-full bg-emerald-500" />
        {label}
      </span>
    );
  }
  if (chip === "finished") {
    return (
      <span className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
        {label}
      </span>
    );
  }
  return (
    <span className="rounded-full bg-accent-soft px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-accent-strong ring-1 ring-inset ring-accent-line">
      {label}
    </span>
  );
}

export default async function OrgLandingPage({ params }: Props) {
  const { orgSlug } = await params;
  const data = await getPublicOrg(orgSlug);
  if (!data) notFound();
  const { org, competitions } = data;
  const dict = await getDictionary(orgLocale(org.default_locale), "public");

  return (
    <div>
      <section className="mb-8 overflow-hidden rounded-2xl bg-court text-court-ink shadow-lg">
        <div className="relative p-6 sm:p-10">
          <div
            aria-hidden
            className="absolute inset-0 opacity-50"
            style={{
              backgroundImage:
                "radial-gradient(560px 220px at 88% -20%, color-mix(in oklab, var(--ps-accent) 55%, transparent), transparent), radial-gradient(420px 260px at -8% 110%, color-mix(in oklab, var(--ps-accent) 30%, transparent), transparent)",
            }}
          />
          <div className="relative">
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-court-muted">
              {t(dict, "hero.eyebrow")}
            </p>
            <h1 className="mt-2 font-display text-5xl font-bold uppercase leading-none tracking-tight sm:text-6xl">
              {org.name}
            </h1>
            <p className="mt-3 max-w-xl text-sm text-court-muted">{t(dict, "hero.subhead")}</p>
          </div>
        </div>
        <div aria-hidden className="h-1 bg-accent" />
      </section>

      {org.about ? (
        <section className="mb-8">
          <h2 className="mb-3 font-display text-2xl font-semibold uppercase tracking-wide text-ink">
            {t(dict, "section.about")}
          </h2>
          <CompetitionProse html={await renderProse(org.about)} />
        </section>
      ) : null}

      <h2 className="mb-3 font-display text-2xl font-semibold uppercase tracking-wide text-ink">
        {t(dict, "section.competitions")}
      </h2>
      {competitions.length === 0 ? (
        <p className="rounded-xl border border-dashed border-zinc-300 bg-surface p-6 text-center text-sm text-ink-muted">
          {t(dict, "empty")}
        </p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {competitions.map((c) => (
            <li key={c.id}>
              <Link
                href={`/shared/${org.slug}/${c.slug}`}
                className="group flex h-full flex-col justify-between rounded-xl border border-zinc-200/80 bg-surface p-4 shadow-sm transition hover:-translate-y-0.5 hover:border-accent-line hover:shadow-md"
              >
                <div className="flex items-start justify-between gap-3">
                  <p className="font-display text-xl font-semibold leading-tight text-ink">
                    {c.name}
                  </p>
                  <ChevronRight
                    aria-hidden
                    className="mt-0.5 h-4 w-4 shrink-0 text-zinc-300 transition group-hover:translate-x-0.5 group-hover:text-accent"
                  />
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
                  {statusChip(c.status, dict)}
                  {c.starts_on ? (
                    <span>
                      {fmtDate(c.starts_on)}
                      {c.ends_on ? ` – ${fmtDate(c.ends_on)}` : ""}
                    </span>
                  ) : null}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
