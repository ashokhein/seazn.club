// Dynamic OG image: standings snapshot for the division (doc 09 §3).
// ImageResponse supports flexbox only — keep the layout simple.
import { ImageResponse } from "next/og";
import { getPublicDivision } from "@/server/public-site/data";
import type { StandingsSnapshotRow } from "@/server/public-site/data";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const revalidate = 300;

type Props = {
  params: Promise<{ orgSlug: string; competitionSlug: string; divisionSlug: string }>;
};

export default async function Image({ params }: Props) {
  const { orgSlug, competitionSlug, divisionSlug } = await params;
  const data = await getPublicDivision(orgSlug, competitionSlug, divisionSlug);

  const rows: StandingsSnapshotRow[] = (data?.standings[0]?.rows ?? [])
    .slice()
    .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))
    .slice(0, 6);
  const names = Object.fromEntries((data?.entrants ?? []).map((e) => [e.id, e.display_name]));

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background: "#fafafa",
          padding: 64,
          fontSize: 28,
          color: "#18181b",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", marginBottom: 32 }}>
          <div style={{ fontSize: 44, fontWeight: 700 }}>
            {data?.division.name ?? "Division"}
          </div>
          <div style={{ fontSize: 28, color: "#71717a", marginTop: 8 }}>
            {data ? `${data.competition.name} · ${data.org.name}` : "seazn.club"}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", flexGrow: 1 }}>
          {rows.length === 0 ? (
            <div style={{ color: "#71717a" }}>Fixtures & standings on seazn.club</div>
          ) : (
            rows.map((row) => (
              <div
                key={row.entrantId}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  padding: "10px 0",
                  borderBottom: "1px solid #e4e4e7",
                }}
              >
                <div style={{ display: "flex", gap: 24 }}>
                  <div style={{ width: 40, color: "#a1a1aa" }}>{row.rank}</div>
                  <div style={{ fontWeight: 600 }}>
                    {names[row.entrantId] ?? row.entrantId}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 32, color: "#52525b" }}>
                  <div>P {row.played}</div>
                  <div>Pts {row.points}</div>
                </div>
              </div>
            ))
          )}
        </div>
        <div style={{ display: "flex", color: "#a1a1aa", fontSize: 24 }}>seazn.club</div>
      </div>
    ),
    size,
  );
}
