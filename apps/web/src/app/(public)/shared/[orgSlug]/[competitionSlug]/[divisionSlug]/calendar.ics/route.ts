// .ics calendar feed per division, optionally per entrant (?entrant=id) —
// doc 09 §2. Public-view reads only; 90-minute default event length.
import { notFound } from "next/navigation";
import { getPublicDivision } from "@/server/public-site/data";
import { buildIcs, type IcsEvent } from "@/lib/public-site";

export async function GET(
  req: Request,
  {
    params,
  }: {
    params: Promise<{ orgSlug: string; competitionSlug: string; divisionSlug: string }>;
  },
) {
  const { orgSlug, competitionSlug, divisionSlug } = await params;
  const data = await getPublicDivision(orgSlug, competitionSlug, divisionSlug);
  if (!data) notFound();

  const entrantId = new URL(req.url).searchParams.get("entrant");
  const entrantNames = Object.fromEntries(data.entrants.map((e) => [e.id, e.display_name]));

  const events: IcsEvent[] = data.fixtures
    .filter((f) => f.scheduled_at !== null)
    .filter(
      (f) =>
        !entrantId || f.home_entrant_id === entrantId || f.away_entrant_id === entrantId,
    )
    .map((f) => ({
      uid: f.id,
      start: new Date(f.scheduled_at as string),
      durationMinutes: 90,
      summary: `${f.home_entrant_id ? (entrantNames[f.home_entrant_id] ?? "TBD") : "TBD"} vs ${
        f.away_entrant_id ? (entrantNames[f.away_entrant_id] ?? "TBD") : "TBD"
      } — ${data.division.name}`,
      ...(f.venue
        ? { location: f.court_label ? `${f.venue} (${f.court_label})` : f.venue }
        : {}),
      description: `${data.competition.name} · https://seazn.club/shared/${data.org.slug}/${data.competition.slug}/${data.division.slug}/fixtures/${f.id}`,
    }));

  const name = entrantId
    ? `${entrantNames[entrantId] ?? "Entrant"} — ${data.division.name}`
    : `${data.division.name} — ${data.competition.name}`;

  return new Response(buildIcs(name, events), {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="${divisionSlug}.ics"`,
      "Cache-Control": "public, s-maxage=300, stale-while-revalidate=3600",
    },
  });
}
