import "server-only";
// OG share-card models (v3/10 wave 1 #1): the PURE half of the renderer.
// Each template gets a model builder that decides colors and exactly which
// strings appear — so the youth rule (v3/11 gap 8: never player names) and
// the brand contrast guard (gap 7: failing accents → violet) are unit-tested
// here, without rendering a pixel.
import { resolvePublicTheme, publicBrandColor } from "@/lib/public-theme";

export interface OgTheme {
  /** Card background (court slab). */
  court: string;
  /** Accent keel + highlights. */
  accent: string;
  ink: string;
  muted: string;
}

// Platform defaults (globals.css --ps-* values) — the violet fallback.
const DEFAULT: OgTheme = {
  court: "#231738",
  accent: "#7c3aed",
  ink: "#f7f5fb",
  muted: "rgba(247,245,251,0.64)",
};

/** First branding blob (competition, then org) whose color passes the WCAG
 *  guard wins; anything else falls back to platform violet. */
export function ogTheme(...brandings: unknown[]): OgTheme {
  for (const b of brandings) {
    const vars = resolvePublicTheme(publicBrandColor(b));
    if (vars) {
      return {
        court: vars["--ps-court"],
        accent: vars["--ps-accent"],
        ink: vars["--ps-court-ink"],
        muted: vars["--ps-court-muted"],
      };
    }
  }
  return DEFAULT;
}

export interface StandingsCardRow {
  rank: number | null;
  name: string;
  played: number;
  points: number;
}

export interface StandingsCardModel {
  theme: OgTheme;
  orgName: string;
  competitionName: string;
  divisionName: string;
  logo: string | null;
  rows: StandingsCardRow[];
  /** Youth divisions of individuals/pairs list no names (gap 8). */
  fallbackLine: string | null;
}

interface StandingsInput {
  orgName: string;
  competitionName: string;
  divisionName: string;
  logo: string | null;
  branding: unknown[];
  youth: boolean;
  entrantKind: string | null;
  rows: { rank: number | null; entrantId: string; played: number; points: number }[];
  names: Record<string, string>;
}

export function standingsCardModel(input: StandingsInput): StandingsCardModel {
  const theme = ogTheme(...input.branding);
  const base = {
    theme,
    orgName: input.orgName,
    competitionName: input.competitionName,
    divisionName: input.divisionName,
    logo: input.logo,
  };
  // Youth rule (v3/11 gap 8): share images are platform-cached — a youth
  // division of individuals or pairs never prints entrant names at all.
  // Team names are fine (they name a side, not a child).
  if (input.youth && input.entrantKind !== "team") {
    return { ...base, rows: [], fallbackLine: "Standings live on seazn.club" };
  }
  const rows = input.rows
    .slice()
    .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))
    .slice(0, 6)
    .map((r) => ({
      rank: r.rank,
      name: input.names[r.entrantId] ?? "—",
      played: r.played,
      points: r.points,
    }));
  return {
    ...base,
    rows,
    fallbackLine: rows.length === 0 ? "Fixtures & standings on seazn.club" : null,
  };
}

export interface FixtureCardModel {
  theme: OgTheme;
  orgName: string;
  competitionName: string;
  divisionName: string;
  logo: string | null;
  home: string;
  away: string;
  headline: string | null;
  status: "scheduled" | "live" | "result";
}

interface FixtureInput {
  orgName: string;
  competitionName: string;
  divisionName: string;
  logo: string | null;
  branding: unknown[];
  youth: boolean;
  entrantKind: string | null;
  homeName: string | null;
  awayName: string | null;
  headline: string | null;
  fixtureStatus: string;
}

export function fixtureCardModel(input: FixtureInput): FixtureCardModel {
  const youthHide = input.youth && input.entrantKind !== "team";
  const status =
    input.fixtureStatus === "in_play"
      ? "live"
      : input.fixtureStatus === "decided" || input.fixtureStatus === "finalized"
        ? "result"
        : "scheduled";
  return {
    theme: ogTheme(...input.branding),
    orgName: input.orgName,
    competitionName: input.competitionName,
    divisionName: input.divisionName,
    logo: input.logo,
    // Youth (gap 8): the matchup renders as the division, never the players.
    home: youthHide ? input.divisionName : (input.homeName ?? "TBD"),
    away: youthHide ? "Match centre" : (input.awayName ?? "TBD"),
    headline: youthHide ? null : input.headline,
    status,
  };
}
