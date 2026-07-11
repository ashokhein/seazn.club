import "server-only";
// Shared satori frame for every share card (v3/10 #1): court slab, accent
// keel, org masthead, seazn.club footer. ImageResponse supports flexbox
// only — every div declares display:flex.
import type { OgTheme } from "./model";

export const OG_SIZE = { width: 1200, height: 630 };

export function CardFrame({
  theme,
  orgName,
  logo,
  children,
}: {
  theme: OgTheme;
  orgName: string;
  logo: string | null;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: theme.court,
        color: theme.ink,
        fontFamily: "sans-serif",
      }}
    >
      {/* accent keel */}
      <div style={{ display: "flex", height: 10, background: theme.accent }} />
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 18,
          padding: "28px 56px 0",
        }}
      >
        {logo ? (
          // eslint-disable-next-line @next/next/no-img-element -- satori
          <img
            src={logo}
            alt=""
            width={52}
            height={52}
            style={{ borderRadius: 12, background: "#ffffff", objectFit: "contain" }}
          />
        ) : null}
        <div
          style={{
            display: "flex",
            fontSize: 24,
            letterSpacing: 5,
            textTransform: "uppercase",
            color: theme.muted,
          }}
        >
          {orgName}
        </div>
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          flexGrow: 1,
          padding: "12px 56px 0",
        }}
      >
        {children}
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "0 56px 26px",
          fontSize: 22,
          color: theme.muted,
        }}
      >
        <div style={{ display: "flex" }}>Live scores · fixtures · standings</div>
        <div style={{ display: "flex", fontWeight: 700, color: theme.ink }}>seazn.club</div>
      </div>
    </div>
  );
}

export function LivePill({ theme, label }: { theme: OgTheme; label: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        borderRadius: 999,
        border: `2px solid ${theme.accent}`,
        color: theme.ink,
        padding: "6px 18px",
        fontSize: 22,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: 3,
      }}
    >
      <div
        style={{
          display: "flex",
          width: 12,
          height: 12,
          borderRadius: 999,
          background: theme.accent,
        }}
      />
      {label}
    </div>
  );
}
