// Division standings share card (v3/10 #1): the top of the table as a
// branded mini-scoreboard. Youth rule (v3/11 gap 8): individual/pair youth
// divisions never print player names — the model decides, this renders.
import { ImageResponse } from "next/og";
import { sql } from "@/lib/db";
import { getPublicDivision } from "@/server/public-site/data";
import { standingsCardModel } from "@/server/og/model";
import { CardFrame, OG_SIZE } from "@/server/og/card";
import type { StandingsSnapshotRow } from "@/server/public-site/data";

export const size = OG_SIZE;
export const contentType = "image/png";
export const revalidate = 300;

type Props = {
  params: Promise<{ orgSlug: string; competitionSlug: string; divisionSlug: string }>;
};

export default async function Image({ params }: Props) {
  const { orgSlug, competitionSlug, divisionSlug } = await params;
  const data = await getPublicDivision(orgSlug, competitionSlug, divisionSlug);

  // Youth flag lives outside the public views on purpose — read it directly.
  const [priv] = data
    ? await sql<{ youth: boolean }[]>`select youth from divisions where id = ${data.division.id}`
    : [];

  const rows = (data?.standings[0]?.rows ?? []) as StandingsSnapshotRow[];
  const model = standingsCardModel({
    orgName: data?.org.name ?? "seazn.club",
    competitionName: data?.competition.name ?? "",
    divisionName: data?.division.name ?? "Division",
    logo: data?.org.logo ?? null,
    branding: [data?.competition.branding, data?.org.branding],
    youth: priv?.youth ?? false,
    entrantKind: data?.entrants[0]?.kind ?? null,
    rows: rows.map((r) => ({
      rank: r.rank ?? null,
      entrantId: r.entrantId,
      played: r.played,
      points: r.points,
    })),
    names: Object.fromEntries((data?.entrants ?? []).map((e) => [e.id, e.display_name])),
  });
  const theme = model.theme;

  return new ImageResponse(
    (
      <CardFrame theme={theme} orgName={model.orgName} logo={model.logo}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div
            style={{
              display: "flex",
              fontSize: 54,
              fontWeight: 800,
              textTransform: "uppercase",
              lineHeight: 1.05,
            }}
          >
            {model.divisionName}
          </div>
          <div style={{ display: "flex", fontSize: 26, color: theme.muted }}>
            {model.competitionName}
          </div>
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flexGrow: 1,
            marginTop: 22,
          }}
        >
          {model.fallbackLine ? (
            <div
              style={{
                display: "flex",
                flexGrow: 1,
                alignItems: "center",
                fontSize: 34,
                color: theme.muted,
              }}
            >
              {model.fallbackLine}
            </div>
          ) : (
            model.rows.map((row, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "9px 0",
                  borderBottom: "1px solid rgba(255,255,255,0.14)",
                  fontSize: 28,
                }}
              >
                <div style={{ display: "flex", gap: 24, alignItems: "center" }}>
                  <div
                    style={{
                      display: "flex",
                      width: 44,
                      color: i === 0 ? theme.accent : theme.muted,
                      fontWeight: 800,
                    }}
                  >
                    {row.rank ?? "–"}
                  </div>
                  <div style={{ display: "flex", fontWeight: 700 }}>{row.name}</div>
                </div>
                <div style={{ display: "flex", gap: 36, color: theme.muted }}>
                  <div style={{ display: "flex" }}>{`P ${row.played}`}</div>
                  <div style={{ display: "flex", color: theme.ink, fontWeight: 700 }}>
                    {`Pts ${row.points}`}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </CardFrame>
    ),
    size,
  );
}
