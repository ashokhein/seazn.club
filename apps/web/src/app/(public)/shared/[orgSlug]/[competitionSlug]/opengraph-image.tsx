// Competition hero share card (v3/10 #1): every WhatsApp/iMessage/X preview
// of the dashboard link becomes a branded mini-poster.
import { ImageResponse } from "next/og";
import { getPublicCompetition } from "@/server/public-site/data";
import { ogTheme } from "@/server/og/model";
import { CardFrame, LivePill, OG_SIZE } from "@/server/og/card";

export const size = OG_SIZE;
export const contentType = "image/png";
export const revalidate = 300; // ISR-aligned with the page (gap 15)

type Props = { params: Promise<{ orgSlug: string; competitionSlug: string }> };

export default async function Image({ params }: Props) {
  const { orgSlug, competitionSlug } = await params;
  const data = await getPublicCompetition(orgSlug, competitionSlug);
  const theme = ogTheme(data?.competition.branding, data?.org.branding);

  const fmt = (d: string) =>
    new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const dates = data?.competition.starts_on
    ? `${fmt(data.competition.starts_on)}${
        data.competition.ends_on ? ` – ${fmt(data.competition.ends_on)}` : ""
      }`
    : null;
  const divisions = data?.divisions.length ?? 0;
  const entrants = data?.divisions.reduce((n, d) => n + d.entrant_count, 0) ?? 0;
  const live = data?.liveNow.length ?? 0;

  return new ImageResponse(
    (
      <CardFrame theme={theme} orgName={data?.org.name ?? "seazn.club"} logo={data?.org.logo ?? null}>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flexGrow: 1,
            justifyContent: "center",
            gap: 22,
          }}
        >
          <div
            style={{
              display: "flex",
              fontSize: 76,
              fontWeight: 800,
              lineHeight: 1.05,
              textTransform: "uppercase",
            }}
          >
            {data?.competition.name ?? "Competition"}
          </div>
          {dates ? (
            <div style={{ display: "flex", fontSize: 30, color: theme.muted }}>{dates}</div>
          ) : null}
          <div style={{ display: "flex", gap: 16, marginTop: 6 }}>
            {live > 0 ? <LivePill theme={theme} label={`${live} live now`} /> : null}
            <div
              style={{
                display: "flex",
                borderRadius: 999,
                background: "rgba(255,255,255,0.12)",
                padding: "8px 20px",
                fontSize: 22,
              }}
            >
              {`${divisions} division${divisions === 1 ? "" : "s"}`}
            </div>
            <div
              style={{
                display: "flex",
                borderRadius: 999,
                background: "rgba(255,255,255,0.12)",
                padding: "8px 20px",
                fontSize: 22,
              }}
            >
              {`${entrants} entrant${entrants === 1 ? "" : "s"}`}
            </div>
          </div>
        </div>
      </CardFrame>
    ),
    size,
  );
}
