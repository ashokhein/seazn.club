// Embeddable widgets (v3/10 #4): /embed/divisions/<id>/{standings|schedule|
// bracket} — read-only, minimal chrome, honours visibility (embed-data),
// keeps itself fresh via ISR. Clubs paste the snippet from the division
// console; the iframe never needs touching again.
import { notFound } from "next/navigation";
import { resolveModule } from "@/server/engine-db";
import { embedDivisionData } from "@/server/embed-data";
import { resolveLogoUrl } from "@/server/public-site/data";
import { publicThemeStyle } from "@/lib/public-theme";
import type { MetricSpecLike } from "@/lib/public-site";
import { StandingsTable } from "@/components/public-site/standings-table";
import { Schedule } from "@/components/public-site/schedule";
import { Bracket } from "@/components/public-site/bracket";
import type { StandingsRow } from "@seazn/engine/competition";

export const revalidate = 30;

// ISR (task-8): same fix as the /shared tree — empty-array generateStaticParams
// is required for on-demand ISR on a dynamic segment in this Next version
// (docs: api-reference/functions/generate-static-params.md).
export async function generateStaticParams() {
  return [];
}

const WIDGETS = new Set(["standings", "schedule", "bracket"]);
const BRACKET_KINDS = new Set(["knockout", "double_elim", "stepladder"]);

type Props = { params: Promise<{ id: string; widget: string }> };

export default async function EmbedWidgetPage({ params }: Props) {
  const { id, widget } = await params;
  if (!WIDGETS.has(widget)) notFound();
  const resolved = await embedDivisionData(id);
  // Both failure modes 404: a stranger's iframe is no place for a paywall.
  if (!resolved.ok) notFound();
  const { org, competition, division, stages, pools, fixtures, standings, entrants, tz } =
    resolved.data;

  let metricSpecs: MetricSpecLike[] = [];
  let cascade: readonly string[] = [];
  try {
    const module_ = resolveModule(division.sport_key, division.module_version);
    metricSpecs = module_.metrics;
    cascade = division.tiebreakers ?? module_.defaultTiebreakers;
  } catch {
    // retired module build — structural columns only
  }
  const entrantNames = Object.fromEntries(entrants.map((e) => [e.id, e.display_name]));
  const entrantLogos = Object.fromEntries(
    entrants.map((e) => [e.id, resolveLogoUrl(e.team_display?.logo_path ?? null, null)]),
  );
  const poolName = new Map(pools.map((p) => [p.id, p.name]));
  const publicPath = `/shared/${org.slug}/${competition.slug}/${division.slug}`;

  let body: React.ReactNode;
  if (widget === "schedule") {
    body = (
      <Schedule fixtures={fixtures} entrantNames={entrantNames} divisionPath={publicPath} tz={tz} />
    );
  } else if (widget === "bracket") {
    const stage = stages.find((s) => BRACKET_KINDS.has(s.kind));
    body = stage ? (
      <Bracket
        kind={stage.kind as "knockout" | "double_elim" | "stepladder"}
        fixtures={fixtures.filter((f) => f.stage_id === stage.id)}
        entrantNames={entrantNames}
        fixtureHref={(fixtureId) => `${publicPath}/fixtures/${fixtureId}`}
      />
    ) : (
      <p className="p-2 text-sm text-zinc-500">No bracket stage in this division.</p>
    );
  } else {
    body = (
      <div className="space-y-5">
        {stages.map((stage) => {
          const snaps = standings.filter((s) => s.stage_id === stage.id);
          if (snaps.length === 0) return null;
          return snaps.map((snap) => (
            <StandingsTable
              key={`${stage.id}-${snap.pool_id ?? "overall"}`}
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
          ));
        })}
      </div>
    );
  }

  return <div style={publicThemeStyle(competition.branding)}>{body}</div>;
}
