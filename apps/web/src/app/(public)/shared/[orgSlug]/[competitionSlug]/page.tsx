// Competition home (doc 09 §2): hero + branding (Pro — nulled in the view for
// non-entitled orgs), division cards, live-now strip. Unlisted competitions
// render with noindex; private ones never reach here (the view 404s them).
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import Image from "next/image";
import type { Metadata } from "next";
import { ChevronRight } from "lucide-react";
import { getPublicCompetition } from "@/server/public-site/data";
import { sharedRenameTarget } from "@/server/slug-resolve";
import { publicRegistrationInfo } from "@/server/usecases/registrations";
import { publicThemeStyle } from "@/lib/public-theme";
import { hasFeature } from "@/lib/entitlements";
import { resolveSponsors, type SponsorTier } from "@/server/usecases/sponsors";
import { renderProse } from "@/lib/prose";
import { CompetitionProse } from "@/components/public-site/competition-prose";
import { ShareBar } from "@/components/share-bar";

export const revalidate = 30;

// ISR (task-8): empty-array generateStaticParams is required for on-demand
// ISR on a dynamic segment in this Next version — see generate-static-params.md.
export async function generateStaticParams() {
  return [];
}

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
  if (!data) {
    const renamed = await sharedRenameTarget(orgSlug, competitionSlug);
    if (renamed) permanentRedirect(renamed);
    notFound();
  }
  const { org, competition, divisions, liveNow } = data;
  const branding = (competition.branding ?? {}) as Branding;
  // Sponsors (v10 PROMPT-56): table rows via the resolver (blob shim only for
  // un-backfilled orgs). Tier grouping is Pro `sponsors.tiers` — without it
  // every row collapses to the free flat partner strip.
  const tiered = await hasFeature(org.id, "sponsors.tiers", competition.id);
  const sponsors = await resolveSponsors(org.id, competition.id, { tiered });
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
    // Pro orgs with branding.colors.primary re-theme this whole subtree —
    // the contrast guard in publicThemeStyle falls back to violet.
    <div style={publicThemeStyle(competition.branding)}>
      <nav className="mb-4 text-xs text-ink-muted">
        <Link href={`/shared/${org.slug}`} className="hover:text-accent-strong hover:underline">
          ← {org.name}
        </Link>
      </nav>

      {/* Hero — court slab; banner photo (Pro) sits under a slab-tinted wash */}
      <section className="relative mb-6 overflow-hidden rounded-2xl bg-court text-court-ink shadow-lg">
        {branding.banner ? (
          <>
            {/* competition branding.banner — raw jsonb (z.record(string, unknown)),
                not routed through resolveLogoUrl and has no upload UI today, so it
                isn't provably a storage URL; stays <img> until that's confirmed
                (task-4 report: skipped-ambiguous-source) */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={branding.banner}
              alt=""
              className="absolute inset-0 h-full w-full object-cover"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-court via-court/75 to-court/40" />
          </>
        ) : (
          <div
            aria-hidden
            className="absolute inset-0 opacity-50"
            style={{
              backgroundImage:
                "radial-gradient(560px 220px at 88% -20%, color-mix(in oklab, var(--ps-accent) 55%, transparent), transparent), radial-gradient(420px 260px at -8% 110%, color-mix(in oklab, var(--ps-accent) 30%, transparent), transparent)",
            }}
          />
        )}
        <div className="relative flex flex-col gap-5 p-6 sm:p-8">
          <div className="flex flex-wrap items-start gap-4">
            {branding.logo ? (
              // competition branding.logo — same unconstrained jsonb / no-upload-UI
              // situation as branding.banner above; skipped-ambiguous-source.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={branding.logo}
                alt=""
                className="h-14 w-14 rounded-xl bg-white/95 object-contain p-1 shadow"
              />
            ) : null}
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-court-muted">
                {org.name}
              </p>
              <h1 className="mt-1 font-display text-4xl font-bold uppercase leading-none tracking-tight sm:text-5xl">
                {competition.name}
              </h1>
              {dateLine ? <p className="mt-2 text-sm text-court-muted">{dateLine}</p> : null}
              <div className="mt-4">
                <ShareBar
                  path={`/shared/${org.slug}/${competition.slug}`}
                  title={competition.name}
                />
              </div>
            </div>
            {registrationOpen ? (
              <Link
                href={`/shared/${org.slug}/${competition.slug}/register`}
                className="shrink-0 rounded-lg bg-surface px-4 py-2 text-sm font-semibold text-accent-strong shadow transition hover:bg-accent-soft"
              >
                Register now
              </Link>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2 text-xs font-medium">
            <span className="rounded-full bg-white/12 px-3 py-1 backdrop-blur">
              {divisions.length} division{divisions.length === 1 ? "" : "s"}
            </span>
            <span className="rounded-full bg-white/12 px-3 py-1 backdrop-blur">
              {totalEntrants} entrant{totalEntrants === 1 ? "" : "s"}
            </span>
            {liveNow.length > 0 ? (
              <span className="flex items-center gap-1.5 rounded-full bg-emerald-400/20 px-3 py-1 text-emerald-200 backdrop-blur">
                <span className="animate-live-pulse h-1.5 w-1.5 rounded-full bg-emerald-300" />
                {liveNow.length} live now
              </span>
            ) : null}
          </div>
        </div>
        <div aria-hidden className="h-1 bg-accent" />
      </section>

      {liveNow.length > 0 ? (
        <section className="mb-6">
          <h2 className="mb-2 flex items-center gap-2 font-display text-sm font-semibold uppercase tracking-[0.18em] text-emerald-700">
            <span className="animate-live-pulse h-2 w-2 rounded-full bg-emerald-500" />
            Live now
          </h2>
          <ul className="flex gap-3 overflow-x-auto pb-1">
            {liveNow.map((f) => {
              const division = divisions.find((d) => d.id === f.division_id);
              return (
                <li key={f.id} className="min-w-60 shrink-0">
                  <Link
                    href={`/shared/${org.slug}/${competition.slug}/${division?.slug}/fixtures/${f.id}`}
                    className="block rounded-xl bg-court p-3.5 text-sm text-court-ink shadow-md ring-1 ring-emerald-400/40 transition hover:-translate-y-0.5 hover:ring-emerald-400"
                  >
                    <p className="text-[11px] uppercase tracking-wide text-court-muted">
                      {division?.name}
                    </p>
                    <p className="mt-1.5 font-display text-xl font-semibold tabular-nums leading-tight">
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
        <section className="mb-6">
          {/* Markdown → sanitized HTML — the editor's Preview runs this
              exact pipeline, so what organisers saw is what ships. */}
          <CompetitionProse html={await renderProse(competition.description)} />
        </section>
      ) : null}

      <section>
        <h2 className="mb-3 font-display text-2xl font-semibold uppercase tracking-wide text-ink">
          Divisions
        </h2>
        {divisions.length === 0 ? (
          <p className="rounded-xl border border-dashed border-zinc-300 bg-surface p-6 text-center text-sm text-ink-muted">
            No divisions published yet.
          </p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {divisions.map((d) => (
              <li key={d.id}>
                <Link
                  href={`/shared/${org.slug}/${competition.slug}/${d.slug}`}
                  className="group flex h-full flex-col justify-between rounded-xl border border-zinc-200/80 bg-surface p-4 shadow-sm transition hover:-translate-y-0.5 hover:border-accent-line hover:shadow-md"
                >
                  <div className="flex items-start gap-3">
                    <span
                      aria-hidden
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft font-display text-base font-bold uppercase text-accent-strong"
                    >
                      {(d.sport_name ?? d.sport_key).slice(0, 1)}
                    </span>
                    <p className="min-w-0 flex-1 font-display text-xl font-semibold leading-tight text-ink">
                      {d.name}
                    </p>
                    <ChevronRight
                      aria-hidden
                      className="mt-1 h-4 w-4 shrink-0 text-zinc-300 transition group-hover:translate-x-0.5 group-hover:text-accent"
                    />
                  </div>
                  <p className="mt-3 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
                    <span>{d.sport_name ?? d.sport_key}</span>
                    <span className="rounded-full bg-accent-soft px-2 py-0.5 uppercase text-accent-strong">
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

      {sponsors.length > 0
        ? (() => {
            // Perimeter board (v10): sponsors render the way a venue shows
            // them — panels on the court-slab band that bookends the hero.
            // Tier is encoded physically: title = "presented by" lockup on
            // the board, gold/silver = sized panels, partners = the quiet
            // ticker line beneath. The board itself is the Pro presentation:
            // free (un-tiered) orgs keep the modest flat chip strip so a
            // community sponsor never reads like a paid title placement.
            const titleRow = tiered ? sponsors.filter((s) => s.tier === "title") : [];
            const boardRows = tiered
              ? sponsors.filter((s) => s.tier === "gold" || s.tier === "silver")
              : [];
            const tickerRows = tiered ? sponsors.filter((s) => s.tier === "partner") : [];

            const PANEL: Record<SponsorTier, { text: string; logo: number; logoCls: string }> = {
              title: { text: "font-display text-3xl font-bold uppercase tracking-tight sm:text-4xl", logo: 48, logoCls: "h-12 w-12" },
              gold: { text: "font-display text-xl font-semibold uppercase tracking-tight", logo: 32, logoCls: "h-8 w-8" },
              silver: { text: "text-sm font-semibold text-court-muted", logo: 24, logoCls: "h-6 w-6" },
              partner: { text: "text-sm font-semibold text-court-muted", logo: 20, logoCls: "h-5 w-5" },
            };
            const c = (s: (typeof sponsors)[number]) => PANEL[tiered ? s.tier : "partner"];
            // One shared logo site (public-image-contract pins this pair).
            // Logos sit on a light chip so dark marks survive the slab.
            const sponsorLogo = (s: (typeof sponsors)[number]) =>
              s.logo ? (
                <span className="shrink-0 rounded bg-white/95 p-0.5">
                  <Image
                    src={s.logo}
                    alt=""
                    width={c(s).logo}
                    height={c(s).logo}
                    className={`${c(s).logoCls} object-contain`}
                  />
                </span>
              ) : null;
            // Table rows go through the tracked /s redirect; blob-shim
            // entries (id null) link straight out.
            const hrefFor = (s: (typeof sponsors)[number]) =>
              s.url ? (s.id ? `/s/${s.id}` : s.url) : null;
            const linked = (s: (typeof sponsors)[number], node: React.ReactNode) => {
              const href = hrefFor(s);
              // New tab: the reader keeps their place at the competition;
              // `sponsored` marks the paid placement for crawlers.
              return href ? (
                <a
                  href={href}
                  target="_blank"
                  rel="nofollow noopener sponsored"
                  className="transition hover:opacity-85"
                >
                  {node}
                </a>
              ) : (
                node
              );
            };

            return (
              <section className="mt-10">
                <h2 className="mb-3 text-xs font-medium uppercase tracking-[0.18em] text-ink-muted">
                  Sponsors
                </h2>
                {titleRow.length > 0 || boardRows.length > 0 ? (
                  <div className="overflow-hidden rounded-2xl bg-court text-court-ink shadow-lg">
                    {/* Accent line mirrors the hero's — the two slabs bookend the page. */}
                    <div aria-hidden className="h-1 bg-accent" />
                    {titleRow.length > 0 ? (
                      <div
                        className={`px-6 py-6 text-center ${boardRows.length > 0 ? "border-b border-white/10" : ""}`}
                      >
                        <p className="text-[10px] font-semibold uppercase tracking-[0.3em] text-court-muted">
                          Presented by
                        </p>
                        <div className="mt-2.5 flex flex-wrap items-center justify-center gap-x-10 gap-y-3">
                          {titleRow.map((s) => (
                            <span key={s.name}>
                              {linked(
                                s,
                                <span className="flex items-center gap-3.5">
                                  {sponsorLogo(s)}
                                  <span className={PANEL.title.text}>{s.name}</span>
                                </span>,
                              )}
                            </span>
                          ))}
                        </div>
                      </div>
                    ) : null}
                    {boardRows.length > 0 ? (
                      <ul className="flex flex-wrap items-center justify-center gap-2 px-4 py-3.5">
                        {boardRows.map((s) => (
                          <li key={s.name}>
                            {linked(
                              s,
                              <span
                                className={`flex items-center gap-2.5 rounded-lg bg-white/5 px-5 py-2.5 ring-1 ring-white/10 transition hover:bg-white/10 ${c(s).text}`}
                              >
                                {sponsorLogo(s)}
                                {s.name}
                              </span>,
                            )}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ) : null}
                {tickerRows.length > 0 ? (
                  <p className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-ink-muted">
                    <span className="text-[10px] font-semibold uppercase tracking-[0.22em]">
                      Partners
                    </span>
                    {tickerRows.map((s, i) => (
                      <span key={s.name} className="inline-flex items-baseline gap-x-3">
                        {i > 0 ? <span aria-hidden>·</span> : null}
                        {linked(s, <span>{s.name}</span>)}
                      </span>
                    ))}
                  </p>
                ) : null}
                {!tiered ? (
                  // Free strip: quiet light chips, no board, no hierarchy.
                  <ul className="flex flex-wrap items-center gap-3">
                    {sponsors.map((s) => (
                      <li key={s.name}>
                        {linked(
                          s,
                          <span className="flex items-center gap-2 rounded-lg border border-zinc-200/80 bg-surface px-3 py-2 text-sm text-zinc-600 shadow-sm">
                            {sponsorLogo(s)}
                            {s.name}
                          </span>,
                        )}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </section>
            );
          })()
        : null}
    </div>
  );
}
