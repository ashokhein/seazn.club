// DocModel (Jul3/06 §2) — a serialisable, layout-agnostic description of a
// printable document: WHAT to print, never pixels. Pure and deterministic —
// `printedAt` is an input (PROMPT-00 §3), so goldens assert the model.
import { z } from "zod";

export const DocCell = z.union([z.string(), z.number()]);
export type DocCell = z.infer<typeof DocCell>;

export const DocTable = z.object({
  columns: z.array(z.string()),
  rows: z.array(z.array(DocCell)),
  /** Landscape hint for very wide tables (29 May: never clip names). */
  landscape: z.boolean().optional(),
});
export type DocTable = z.infer<typeof DocTable>;

export const DocSection = z.object({
  heading: z.string().optional(), // "Preliminary round" vs "Knockout" (1 Sep)
  subheading: z.string().optional(),
  table: DocTable.optional(),
  /** Blank form lines ("Team: ______") for sign-at-start rosters (13 May). */
  formLines: z.array(z.string()).optional(),
  /** Signature blocks ("Referee", "Captain A", …) — 12 Jun scoresheets. */
  signatures: z.array(z.string()).optional(),
  /** Kit colour swatches next to team names (10 Jun / 8 Jun). */
  swatches: z.array(z.object({ label: z.string(), color: z.string() })).optional(),
  /** Layout hint: 2 = two of these per page (12 Jun "two per A4"). */
  columnsHint: z.number().int().min(1).max(2).optional(),
  /** Start this section on a fresh page (per-pitch / per-team scoping). */
  pageBreakBefore: z.boolean().optional(),
});
export type DocSection = z.infer<typeof DocSection>;

export const DocBranding = z.object({
  orgName: z.string().optional(),
  colors: z.record(z.string(), z.string()).optional(),
  logos: z.array(z.string()).optional(), // storage paths
  sponsors: z.array(z.object({ name: z.string(), tier: z.string() })).optional(),
});
export type DocBranding = z.infer<typeof DocBranding>;

export const DocKind = z.enum([
  "timetable",
  "scoresheet",
  "roster",
  "standings",
  "match_report",
  "participants",
  "officials_rota",
  "admit_ticket",
]);
export type DocKind = z.infer<typeof DocKind>;

export const PageBreaks = z.enum(["auto", "per_pitch", "per_team", "per_division"]);
export type PageBreaks = z.infer<typeof PageBreaks>;

export const DocModel = z.object({
  kind: DocKind,
  title: z.string(), // tournament + division name (1 Sep)
  description: z.string().optional(), // one-line "what this sheet is"
  meta: z.object({
    printedAt: z.string(), // supplied by the caller — never Date.now()
    footerNote: z.string().optional(),
    liveUrl: z.string().optional(), // live-page QR payload (Task 12 draws it)
  }),
  branding: DocBranding.optional(), // Pro `exports.branded` — nulled server-side otherwise
  sections: z.array(DocSection),
  pageBreaks: PageBreaks.default("auto"),
});
export type DocModel = z.infer<typeof DocModel>;

// --- build inputs (sport-neutral kinds) -------------------------------------

export interface ExportFixture {
  id: string;
  at: string | null; // ISO or null (flexible mode / unscheduled)
  court: string | null;
  stageName: string;
  round: number | null;
  home: string; // display labels — TBD feeds arrive as "Winner of QF1"
  away: string;
  homeColor?: string;
  awayColor?: string;
  divisionName?: string;
  result?: string; // "3–1" when decided
}

export interface ExportStandingsRow {
  name: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  points: number;
  metrics: Record<string, number>;
}

export interface ExportRosterTeam {
  teamName: string;
  clubName?: string;
  players: { name: string; dob?: string; number?: number }[];
}

export interface ExportParticipantRow {
  club: string;
  team: string;
  division: string;
  entrant: string; // Empty-Spot labels preserved (30 Jan)
  player: string;
  number: number | null;
  position: string;
}

export interface ExportOfficialDuty {
  at: string; // pre-formatted venue-local time string (built server-side)
  court: string | null;
  compDivision: string;
  role: string;
  opponents: string; // "Falcons vs Hawks"
  response: "pending" | "accepted" | "declined";
}

export interface ExportOfficialSchedule {
  officialName: string;
  duties: ExportOfficialDuty[];
}

export interface BuildOpts {
  printedAt: string;
  pageBreaks?: PageBreaks;
  branding?: DocBranding;
  footerNote?: string;
  liveUrl?: string;
  description?: string;
  landscape?: boolean;
  metricColumns?: string[]; // standings extra columns, in order
}
