// Site-wide share card: home, marketing pages, /live, the console and the
// slideshow all inherit this unless a segment ships its own (the /shared
// public tree does — v3/10 #1). Stadium-night brand frame: floodlit slab,
// the line-and-ball mark, the promise.
import { ImageResponse } from "next/og";
import { OG_SIZE } from "@/server/og/card";

export const alt = "Seazn Club — any sport, live in minutes";
export const size = OG_SIZE;
export const contentType = "image/png";

const NIGHT = "#150b36";
const NIGHT2 = "#1d1145";
const CREAM = "#f5f0e8";
const LIME = "#a3e635";
const LIVE = "#ef4444";

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "56px 72px",
          color: CREAM,
          fontFamily: "sans-serif",
          backgroundColor: NIGHT,
          backgroundImage: `radial-gradient(720px 420px at 10% -10%, rgba(163,230,53,0.14), transparent 60%), radial-gradient(780px 460px at 90% -10%, rgba(124,58,237,0.30), transparent 62%), linear-gradient(180deg, ${NIGHT2}, ${NIGHT})`,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            fontSize: 30,
            fontWeight: 700,
            letterSpacing: 6,
          }}
        >
          <span style={{ display: "flex" }}>SEAZN</span>
          <span style={{ display: "flex", color: LIME }}>CLUB</span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ display: "flex", fontSize: 104, fontWeight: 800, lineHeight: 1.02 }}>
            ANY SPORT.
          </div>
          <div style={{ display: "flex", fontSize: 104, fontWeight: 800, lineHeight: 1.02 }}>
            LIVE IN MINUTES.
          </div>
          {/* the mark: lime line, red ball resting at its end */}
          <div style={{ display: "flex", alignItems: "flex-end", marginTop: 34 }}>
            <div
              style={{
                display: "flex",
                width: 560,
                height: 12,
                borderRadius: 6,
                background: LIME,
              }}
            />
            <div
              style={{
                display: "flex",
                width: 40,
                height: 40,
                borderRadius: 20,
                background: LIVE,
                marginLeft: -20,
                marginBottom: 10,
              }}
            />
          </div>
        </div>

        <div style={{ display: "flex", fontSize: 26, color: "rgba(245,240,232,0.66)" }}>
          Fixtures, live scoring and standings for community clubs — seazn.club
        </div>
      </div>
    ),
    size,
  );
}
