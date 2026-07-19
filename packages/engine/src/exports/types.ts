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
  /** PROMPT-60: per-row badge URL aligned to `rows` (null = no badge). The
   *  renderer draws a small crest before the name cell; absent = no badges. */
  rowBadges: z.array(z.string().nullable()).optional(),
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
  /** Admit-ticket payload (v12/Task 11) — QR carried as a URL, never pixels. */
  ticket: z
    .object({
      maskedName: z.string(),
      competition: z.string(),
      dates: z.string(),
      ref: z.string(),
      status: z.string(),
      qrUrl: z.string(),
      seq: z.number(),
    })
    .optional(),
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
  "bracket",
  "audit",
]);
export type DocKind = z.infer<typeof DocKind>;

// PROMPT-62 §4 — the results-poster payload: the twoSidedBracket layout with
// names/headlines resolved. Landscape; renderer scales to one sheet.
export const DocBracketNode = z.object({
  fixtureId: z.string(),
  side: z.enum(["L", "R", "center"]),
  col: z.number().int(),
  row: z.number().int(),
  home: z.string(),
  away: z.string(),
  headline: z.string().nullable(),
  decided: z.boolean(),
});
export type DocBracketNode = z.infer<typeof DocBracketNode>;

export const DocBracket = z.object({
  nodes: z.array(DocBracketNode),
  connectors: z.array(
    z.object({
      side: z.enum(["L", "R"]),
      col: z.number().int(),
      fromRow: z.number().int(),
      toRow: z.number().int(),
    }),
  ),
  rounds: z.number().int(),
  colsPerSide: z.number().int(),
  rowsPerSide: z.number().int(),
  /** Column captions, outermost → Final (length = rounds). */
  roundLabels: z.array(z.string()),
  thirdPlaceId: z.string().optional(),
});
export type DocBracket = z.infer<typeof DocBracket>;

// G-audit follow-up — the double-elim poster payload: the doubleElimBracket
// two-lane layout with names/headlines resolved. Landscape like the
// single-elim poster; renderer scales both lanes onto one sheet.
export const DocBracketDeNode = z.object({
  fixtureId: z.string(),
  lane: z.enum(["WB", "LB", "GF"]),
  col: z.number().int(),
  row: z.number().int(),
  home: z.string(),
  away: z.string(),
  headline: z.string().nullable(),
  decided: z.boolean(),
});
export type DocBracketDeNode = z.infer<typeof DocBracketDeNode>;

export const DocBracketDe = z.object({
  nodes: z.array(DocBracketDeNode),
  connectors: z.array(
    z.object({
      lane: z.enum(["WB", "LB"]),
      col: z.number().int(),
      fromRow: z.number().int(),
      toRow: z.number().int(),
    }),
  ),
  k: z.number().int(), // winners-lane depth
  wbRows: z.number().int(),
  lbRows: z.number().int(),
  lbCols: z.number().int(),
  laneLabels: z.object({ winners: z.string(), losers: z.string(), grandFinal: z.string(), reset: z.string() }),
  resetId: z.string().optional(),
});
export type DocBracketDe = z.infer<typeof DocBracketDe>;

// Stepladder poster: bottom-up rungs, winner climbs. Portrait-friendly list.
export const DocLadderRung = z.object({
  fixtureId: z.string(),
  label: z.string(), // "Rung 1", …
  home: z.string(),
  away: z.string(),
  headline: z.string().nullable(),
  decided: z.boolean(),
});
export type DocLadderRung = z.infer<typeof DocLadderRung>;
export const DocLadder = z.object({ rungs: z.array(DocLadderRung) });
export type DocLadder = z.infer<typeof DocLadder>;

// Page playoffs (IPL, spec 2026-07-19): four named slots on one card.
export const DocPageSlot = z.enum(["q1", "eliminator", "q2", "final"]);
export const DocPageNode = z.object({
  fixtureId: z.string(),
  slot: DocPageSlot,
  home: z.string(),
  away: z.string(),
  headline: z.string().nullable(),
  decided: z.boolean(),
});
export const DocPagePlayoff = z.object({
  nodes: z.array(DocPageNode),
  slotLabels: z.object({ q1: z.string(), eliminator: z.string(), q2: z.string(), final: z.string() }),
});
export type DocPagePlayoff = z.infer<typeof DocPagePlayoff>;

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
  /** PROMPT-62 §4 — set only for kind:"bracket" (sections stay empty). */
  bracket: DocBracket.optional(),
  /** Double-elim edition of the bracket poster — exactly one of the three
   *  bracket payloads is set for kind:"bracket". */
  bracketDe: DocBracketDe.optional(),
  /** Stepladder edition. */
  ladder: DocLadder.optional(),
  /** Page-playoff (IPL) edition. */
  pagePlayoff: DocPagePlayoff.optional(),
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
  /** PROMPT-60: entrant crest URL (already resolved) — reaches the PDF. */
  badgeUrl?: string | null;
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

export interface ExportTicket {
  maskedName: string;
  competition: string;
  dates: string;
  ref: string;
  status: string; // "CONFIRMED" | "PAID" | ...
  qrUrl: string; // `${origin}/r/${ref}` — URL only, never pixels
  seq: number; // 1-based sequence for cutting
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
