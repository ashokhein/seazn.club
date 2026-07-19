import "server-only";
// SPEC-2 / PROMPT-83 — the news share card, one satori layout feeding BOTH the
// post OG image (1200×630) and the downloadable story PNG (1080×1350). Night
// background, kind-colored accent bar, crest pair + scoreline dominant for
// result posts (title dominant otherwise). Branding split mirrors the existing
// dashboard.branding rule: free tier carries the seazn badge (attribution rail),
// Pro carries org branding via public-theme (ogTheme). The PURE model decides
// theme + badge + scoreline so the free/Pro split unit-tests without a pixel
// (mirrors server/og/model.ts). ImageResponse supports flexbox only — every div
// declares display:flex.
import { ogTheme, type OgTheme } from "./model";
import { OG_SIZE } from "./card";
import {
  kindEyebrow,
  parseScoreline,
  crestMonogram,
  type EyebrowTone,
  type Scoreline,
} from "@/lib/news-presentation";
import type { PostKind } from "@/server/usecases/org-posts";

export const STORY_SIZE = { width: 1080, height: 1350 };
export { OG_SIZE };

const TONE_COLOR: Record<EyebrowTone, string> = {
  lime: "#a3e635",
  white: "#f7f5fb",
  red: "#ef4444",
  muted: "rgba(247,245,251,0.64)",
};

export interface PostCardInput {
  branding: unknown[];
  /** Pro branding entitlement (org.branded) — drops the seazn badge. */
  branded: boolean;
  orgName: string;
  logo: string | null;
  kind: PostKind;
  title: string;
}

export interface PostCardModel {
  theme: OgTheme;
  orgName: string;
  logo: string | null;
  tone: EyebrowTone;
  accent: string;
  /** dict key for the kind eyebrow; the route resolves the label. */
  eyebrowKey: string;
  /** Result posts with a numeric scoreline render the scorebug; else null. */
  scoreline: Scoreline | null;
  title: string;
  /** Free tier only — the "Run your own on seazn.club" acquisition badge. */
  showBadge: boolean;
}

export function postCardModel(input: PostCardInput): PostCardModel {
  const theme = ogTheme(...input.branding);
  const eb = kindEyebrow(input.kind);
  const tone = eb.tone;
  const scoreline = input.kind === "result" ? parseScoreline(input.title) : null;
  return {
    theme,
    orgName: input.orgName,
    logo: input.logo,
    tone,
    accent: tone === "muted" ? theme.muted : TONE_COLOR[tone],
    eyebrowKey: eb.labelKey,
    scoreline,
    title: input.title,
    showBadge: !input.branded,
  };
}

function Monogram({ name, color, s }: { name: string; color: string; s: number }) {
  return (
    <div
      style={{
        display: "flex",
        width: s,
        height: s,
        borderRadius: 999,
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(255,255,255,0.10)",
        border: `3px solid ${color}`,
        fontSize: s * 0.42,
        fontWeight: 800,
      }}
    >
      {crestMonogram(name)}
    </div>
  );
}

/** Shared satori card. `eyebrow` is the resolved kind label (route-localized). */
export function PostShareCard({
  model,
  eyebrow,
  size,
}: {
  model: PostCardModel;
  eyebrow: string;
  size: "og" | "story";
}) {
  const story = size === "story";
  const { theme, scoreline } = model;
  const pad = story ? 72 : 56;
  const crestS = story ? 180 : 132;
  const scoreFs = story ? 210 : 150;
  const titleFs = story ? 78 : 60;
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
      {/* kind accent bar */}
      <div style={{ display: "flex", height: story ? 16 : 12, background: model.accent }} />
      {/* masthead: org crest + name */}
      <div style={{ display: "flex", alignItems: "center", gap: 18, padding: `${pad * 0.5}px ${pad}px 0` }}>
        {model.logo ? (
          // eslint-disable-next-line @next/next/no-img-element -- satori
          <img
            src={model.logo}
            alt=""
            width={story ? 64 : 52}
            height={story ? 64 : 52}
            style={{ borderRadius: 12, background: "#ffffff", objectFit: "contain" }}
          />
        ) : null}
        <div
          style={{
            display: "flex",
            fontSize: story ? 30 : 24,
            letterSpacing: 5,
            textTransform: "uppercase",
            color: theme.muted,
          }}
        >
          {model.orgName}
        </div>
      </div>
      {/* eyebrow */}
      <div style={{ display: "flex", padding: `${pad * 0.4}px ${pad}px 0` }}>
        <div
          style={{
            display: "flex",
            fontSize: story ? 34 : 26,
            fontWeight: 800,
            letterSpacing: 6,
            textTransform: "uppercase",
            color: model.accent,
          }}
        >
          {eyebrow}
        </div>
      </div>
      {/* body: scorebug for results, else the headline */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          flexGrow: 1,
          justifyContent: "center",
          padding: `0 ${pad}px`,
        }}
      >
        {scoreline ? (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 24 }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16, width: crestS + 40 }}>
              <Monogram name={scoreline.home} color={model.accent} s={crestS} />
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: story ? 22 : 16,
                fontSize: scoreFs,
                fontWeight: 800,
                lineHeight: 1,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              <div style={{ display: "flex" }}>{scoreline.homeScore}</div>
              <div style={{ display: "flex", color: theme.muted }}>–</div>
              <div style={{ display: "flex" }}>{scoreline.awayScore}</div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16, width: crestS + 40 }}>
              <Monogram name={scoreline.away} color={model.accent} s={crestS} />
            </div>
          </div>
        ) : (
          <div
            style={{
              display: "flex",
              fontSize: titleFs,
              fontWeight: 800,
              lineHeight: 1.05,
              textTransform: "uppercase",
            }}
          >
            {model.title}
          </div>
        )}
        {scoreline ? (
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              marginTop: 22,
              fontSize: story ? 30 : 24,
              color: theme.muted,
              textTransform: "uppercase",
              letterSpacing: 2,
            }}
          >
            <div style={{ display: "flex", maxWidth: "45%" }}>{scoreline.home}</div>
            <div style={{ display: "flex", maxWidth: "45%", justifyContent: "flex-end" }}>{scoreline.away}</div>
          </div>
        ) : null}
      </div>
      {/* footer: seazn badge (free) or brand line (Pro) */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: `0 ${pad}px ${pad * 0.5}px`,
          fontSize: story ? 26 : 22,
          color: theme.muted,
        }}
      >
        {model.showBadge ? (
          <div style={{ display: "flex", fontWeight: 700, color: theme.ink }}>
            Live on seazn.club
          </div>
        ) : (
          <div style={{ display: "flex" }}>{model.orgName}</div>
        )}
        <div style={{ display: "flex", fontWeight: 700, color: theme.ink }}>seazn.club</div>
      </div>
    </div>
  );
}
