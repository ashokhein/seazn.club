// Division home (doc 09 §2): Schedule / Standings / Entrants tabs. Standings
// columns are driven by the pinned SportModule's MetricSpec[] — zero
// per-sport table components. Knockout stages render brackets; stepladder a
// ladder. Roster names are consent-filtered in the view (initials otherwise).
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import type { Metadata } from "next";
import { resolveModule } from "@/server/engine-db";
import type { StandingsRow } from "@seazn/engine/competition";
import { getPublicDivision, resolveLogoUrl } from "@/server/public-site/data";
import { sharedRenameTarget } from "@/server/slug-resolve";
import { publicThemeStyle } from "@/lib/public-theme";
import { renderProse } from "@/lib/prose";
import { CompetitionProse } from "@/components/public-site/competition-prose";
import { ShareButton } from "@/components/share-button";
import { Tabs } from "@/components/public-site/tabs";
import { Schedule } from "@/components/public-site/schedule";
import { StandingsTable } from "@/components/public-site/standings-table";
import { Bracket } from "@/components/public-site/bracket";
import type { MetricSpecLike } from "@/lib/public-site";

export const revalidate = 30;

// ISR (task-8): empty-array generateStaticParams is required for on-demand
// ISR on a dynamic segment in this Next version — see generate-static-params.md.
export async function generateStaticParams() {
  return [];
}

type Props = {
  params: Promise<{ orgSlug: string; competitionSlug: string; divisionSlug: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { orgSlug, competitionSlug, divisionSlug } = await params;
  const data = await getPublicDivision(orgSlug, competitionSlug, divisionSlug);
  if (!data) return {};
  return {
    title: `${data.division.name} — ${data.competition.name}`,
    description: `Schedule, standings and entrants for ${data.division.name} at ${data.competition.name}`,
    ...(data.competition.visibility === "unlisted"
      ? { robots: { index: false, follow: false } }
      : {}),
  };
}

const BRACKET_KINDS = new Set(["knockout", "double_elim", "stepladder"]);

export default async function DivisionHomePage({ params }: Props) {
  const { orgSlug, competitionSlug, divisionSlug } = await params;
  const data = await getPublicDivision(orgSlug, competitionSlug, divisionSlug);
  if (!data) {
    const renamed = await sharedRenameTarget(orgSlug, competitionSlug, divisionSlug);
    if (renamed) permanentRedirect(renamed);
    notFound();
  }
  const { org, competition, division, stages, pools, fixtures, standings, entrants, tz } = data;

  // MetricSpec[] + cascade from the division's PINNED module version.
  let metricSpecs: MetricSpecLike[] = [];
  let cascade: readonly string[] = [];
  try {
    const module_ = resolveModule(division.sport_key, division.module_version);
    metricSpecs = module_.metrics;
    cascade = division.tiebreakers ?? module_.defaultTiebreakers;
  } catch {
    // Unknown module version (e.g. retired build) — structural columns only.
  }

  const entrantNames = Object.fromEntries(entrants.map((e) => [e.id, e.display_name]));
  // Badge chips (v3/03 §5): team → club resolved by the view; URL resolved here.
  const entrantLogos = Object.fromEntries(
    entrants.map((e) => [e.id, resolveLogoUrl(e.team_display?.logo_path ?? null, null)]),
  );
  const basePath = `/shared/${org.slug}/${competition.slug}/${division.slug}`;
  const poolName = new Map(pools.map((p) => [p.id, p.name]));
  const stageById = new Map(stages.map((s) => [s.id, s]));

  // Live stage first: the knockout that's underway reads before the finished
  // league table it qualified from.
  const stagesByRelevance = [...stages].sort(
    (a, b) =>
      (a.status === "complete" ? 1 : 0) - (b.status === "complete" ? 1 : 0) || a.seq - b.seq,
  );

  // Champion (v1 parity): once the decisive stage is done, crown the winner
  // above the table. Bracket → winner of the last-round fixture; league/group
  // → rank 1 of the final overall standings.
  const championId: string | null = (() => {
    const decisive = [...stages].sort((a, b) => b.seq - a.seq)[0];
    if (!decisive) return null;
    // Crown when the stage is flagged complete OR every one of its fixtures is
    // already decided (a fully-played stage isn't always flipped to complete).
    const stageFixtures = fixtures.filter((f) => f.stage_id === decisive.id);
    const finished = (f: (typeof fixtures)[number]) =>
      f.status === "decided" || f.status === "finalized" || f.outcome?.winner != null;
    const stageDone =
      decisive.status === "complete" ||
      (stageFixtures.length > 0 && stageFixtures.every(finished));
    if (!stageDone) return null;
    if (BRACKET_KINDS.has(decisive.kind)) {
      const decided = stageFixtures.filter((f) => f.outcome?.winner);
      if (decided.length === 0) return null;
      const final = decided.reduce((a, b) => (b.round_no > a.round_no ? b : a));
      return final.outcome?.winner ?? null;
    }
    const snap =
      standings.find((s) => s.stage_id === decisive.id && !s.pool_id) ??
      standings.find((s) => s.stage_id === decisive.id);
    if (!snap) return null;
    const top = (snap.rows as StandingsRow[]).find((r) => r.rank === 1);
    return top?.entrantId ?? null;
  })();

  // Rendered at the very top of the division page (above the tabs) so the
  // winner is visible on Schedule/Standings/Entrants alike — v1 parity.
  // Gold is fixed podium vocabulary, deliberately outside the org theme.
  const championBanner = championId ? (
    <div className="relative mb-6 overflow-hidden rounded-xl bg-court p-4 text-court-ink shadow-md">
      <span aria-hidden className="absolute inset-y-0 left-0 w-1 bg-amber-400" />
      <div className="flex items-center gap-4 pl-2">
        <span className="animate-trophy text-4xl" aria-hidden>🏆</span>
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-amber-300">
            Champion
          </p>
          <p className="truncate font-display text-3xl font-bold uppercase leading-tight tracking-tight">
            {entrantNames[championId] ?? "—"}
          </p>
        </div>
      </div>
    </div>
  ) : null;

  const standingsPanel = (
    <div className="space-y-8">
      {stagesByRelevance.map((stage) => {
        if (BRACKET_KINDS.has(stage.kind)) {
          const stageFixtures = fixtures.filter((f) => f.stage_id === stage.id);
          if (stageFixtures.length === 0) return null;
          return (
            <section key={stage.id}>
              <h3 className="mb-3 font-display text-lg font-semibold text-ink">{stage.name}</h3>
              <Bracket
                kind={stage.kind as "knockout" | "double_elim" | "stepladder"}
                fixtures={stageFixtures}
                entrantNames={entrantNames}
                fixtureHref={(id) => `${basePath}/fixtures/${id}`}
              />
            </section>
          );
        }
        const snapshots = standings
          .filter((s) => s.stage_id === stage.id)
          .sort((a, b) => (a.pool_id ?? "").localeCompare(b.pool_id ?? ""));
        if (snapshots.length === 0) return null;
        return (
          <section key={stage.id}>
            {snapshots.map((snap) => (
              <div key={snap.pool_id ?? "overall"} className="mb-6">
                <StandingsTable
                  rows={snap.rows as StandingsRow[]}
                  metricSpecs={metricSpecs}
                  cascade={cascade}
                  entrantNames={entrantNames}
                  entrantLogos={entrantLogos}
                  caption={
                    snap.pool_id
                      ? `${stage.name} — ${poolName.get(snap.pool_id) ?? "Pool"}`
                      : stage.name
                  }
                />
              </div>
            ))}
          </section>
        );
      })}
      {standings.length === 0 && !stages.some((s) => BRACKET_KINDS.has(s.kind)) ? (
        <p className="rounded-xl border border-dashed border-zinc-300 bg-surface p-6 text-center text-sm text-ink-muted">
          Standings appear after the first results.
        </p>
      ) : null}
    </div>
  );

  const entrantsPanel = (
    <ul className="grid gap-3 sm:grid-cols-2">
      {entrants.map((e) => (
        <li
          key={e.id}
          className="rounded-xl border border-zinc-200/80 bg-surface p-4 shadow-sm"
        >
          <p className="flex items-baseline justify-between gap-2 font-display text-lg font-semibold text-ink">
            <span className="truncate">{e.display_name}</span>
            {e.seed ? (
              <span className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 font-sans text-[11px] font-medium text-accent-strong">
                Seed {e.seed}
              </span>
            ) : null}
          </p>
          {e.members.length > 0 ? (
            <ul className="mt-2 space-y-1 text-sm text-zinc-600">
              {e.members.map((m, i) => (
                <li key={i} className="flex items-center gap-2">
                  {m.squad_number != null ? (
                    <span className="w-6 text-right font-display text-xs font-semibold tabular-nums text-ink-muted">
                      {m.squad_number}
                    </span>
                  ) : null}
                  {m.person_id ? (
                    <Link
                      href={`/shared/${org.slug}/${competition.slug}/players/${m.person_id}`}
                      className="underline decoration-accent-line underline-offset-2 hover:text-accent-strong hover:decoration-accent"
                    >
                      {m.name}
                    </Link>
                  ) : (
                    // No public-name consent: initials, no link (doc 06 §4.7).
                    <span>{m.name}</span>
                  )}
                  {m.position ? (
                    <span className="text-xs text-ink-muted">{m.position}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
      {entrants.length === 0 ? (
        <p className="text-sm text-ink-muted">No entrants yet.</p>
      ) : null}
    </ul>
  );

  return (
    <div style={publicThemeStyle(competition.branding)}>
      <nav className="mb-4 text-xs text-ink-muted">
        <Link href={`/shared/${org.slug}`} className="hover:text-accent-strong hover:underline">
          {org.name}
        </Link>{" "}
        /{" "}
        <Link
          href={`/shared/${org.slug}/${competition.slug}`}
          className="hover:text-accent-strong hover:underline"
        >
          {competition.name}
        </Link>
      </nav>
      <div className="mb-2 flex flex-wrap items-start justify-between gap-3">
        <h1 className="font-display text-4xl font-bold uppercase leading-none tracking-tight text-ink sm:text-5xl">
          {division.name}
        </h1>
        {/* Standings share (v3/10 #2) — the link unfurls into the OG card. */}
        <ShareButton
          title={`${division.name} — ${competition.name}`}
          text={`${division.name} standings & fixtures — ${competition.name}:`}
          url={`/shared/${org.slug}/${competition.slug}/${division.slug}`}
        />
      </div>
      <p className="mb-6 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
        <span className="font-medium text-zinc-600">
          {division.sport_name ?? division.sport_key}
        </span>
        <span className="rounded-full bg-accent-soft px-2 py-0.5 uppercase text-accent-strong">
          {division.variant_key}
        </span>
        {stages.map((s) => (
          <span
            key={s.id}
            className={`rounded-full px-2 py-0.5 ${
              s.status === "complete"
                ? "bg-emerald-50 text-emerald-700"
                : "bg-zinc-100 text-zinc-600"
            }`}
          >
            {stageById.get(s.id)?.name}
            {s.status === "complete" ? " ✓" : ""}
          </span>
        ))}
      </p>

      {championBanner}

      {division.description ? (
        <section className="mb-6">
          <CompetitionProse html={await renderProse(division.description)} />
        </section>
      ) : null}

      <Tabs labels={["Schedule", "Standings", "Entrants"]}>
        {[
          <Schedule
            key="schedule"
            fixtures={fixtures}
            entrantNames={entrantNames}
            divisionPath={basePath}
            tz={tz}
          />,
          standingsPanel,
          entrantsPanel,
        ]}
      </Tabs>
    </div>
  );
}
