// Shared shapes for the v3 schedule board (v3/04 §2). The server pages feed
// these straight from the usecases; everything client-side derives from them.

import type { FeedLabelPair } from "@/lib/schedule-board";

export interface BoardDivision {
  id: string;
  name: string;
  slug: string;
  status: string;
  /** Optimistic-concurrency token (v3/11 gap 10): divisions.seq at render. */
  seq: number;
  /** Whole-division freeze (Jul3/03 §4) — every schedule edit 422s while on. */
  schedule_locked?: boolean;
}

export interface BoardStage {
  id: string;
  division_id: string;
  seq: number;
  kind: string;
  name: string;
  status: string;
}

export interface BoardFixture {
  id: string;
  stage_id: string;
  division_id: string;
  round_no: number;
  seq_in_round: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  /** ISO string over the wire, Date when it crosses straight from an RSC. */
  scheduled_at: string | Date | null;
  venue: string | null;
  court_label: string | null;
  status: string;
  schedule_source: string;
  schedule_locked: boolean;
  outcome: unknown;
}

export interface BoardConfig {
  startAt?: string | null;
  endAt?: string | null;
  matchMinutes: number;
  gapMinutes: number;
  courts: string[];
  perEntrantMinRest: number;
  blackouts: { court?: string; from: string; to: string }[];
  sessionWindows: { from: string; to: string }[];
  roundMinutes?: number | null;
}

export interface BoardConflict {
  fixture_id: string;
  code: string;
  blocking: boolean;
  detail?: string;
}

export const CONFLICT_LABEL: Record<string, string> = {
  "conflict.court": "court clash",
  "warn.rest": "rest",
  "warn.person_overlap": "person overlap",
  "warn.order": "plays before feeder",
  "warn.blackout": "blackout",
  "warn.no_slot": "no slot",
  "warn.official_declined": "umpire declined",
  "warn.official_unavailable": "umpire unavailable",
};

// Plain-English explanations shown to organisers (no codes, no UUIDs).
export const CONFLICT_HELP: Record<string, string> = {
  "conflict.court": "Two matches would use the same court at the same time.",
  "warn.rest": "There isn't enough rest between matches for a team or player.",
  "warn.person_overlap": "Someone would be playing in two matches at once.",
  "warn.order": "This match feeds a later one, so it can't start before the earlier match finishes.",
  "warn.blackout": "This time falls inside a blackout period.",
  "warn.no_slot": "There's no free slot for this match at that time.",
  "warn.official_declined": "An assigned official has declined — re-assign this match.",
  "warn.official_unavailable": "An assigned official is unavailable at this time.",
};

export function cardTitle(
  f: BoardFixture,
  names: Record<string, string>,
  feeds: Record<string, FeedLabelPair>,
): string {
  const home = f.home_entrant_id
    ? (names[f.home_entrant_id] ?? "?")
    : (feeds[f.id]?.home ?? "TBD");
  const away = f.away_entrant_id
    ? (names[f.away_entrant_id] ?? "?")
    : (feeds[f.id]?.away ?? "TBD");
  return `${home} vs ${away}`;
}

/** One proposal block painted over the grid while an AI proposal is on screen
 *  (v4 Task 13, design/v4/02 §3). Positioned by the PROPOSED slot (`at`/`court`),
 *  not the fixture's current one; `tone` is its state-palette bucket. The block
 *  shows code + JR/Final marker + matchup + time only — move provenance lives in
 *  the diff list, never here. */
export interface GhostBlock {
  id: string;
  code: string;
  matchup: string;
  isFinal: boolean;
  isJunior: boolean;
  /** Proposed kick-off, epoch ms. */
  at: number;
  /** Proposed court (null → unassigned column). */
  court: string | null;
  tone: "moved" | "placed" | "unchanged" | "blocking";
  /** Referee just flagged this fixture — pulse red for ~1.5s (§0.3). */
  pulse?: boolean;
}

/** Board density modes (v3/04 §2). Week view lives inside Board mode — the
 *  cross-day drag affordance predates v3 and stays (no regression). */
export type Density = "board" | "agenda" | "lanes";

export const DENSITY_STORAGE_KEY = "seazn:board:density";

/** The single "Unassigned venue" fallback column label (v3/04 §2) — a
 *  sentinel, never persisted: placing here writes court_label = null. */
export const UNASSIGNED = " unassigned";
