// Schedule history domain (Jul3/03 §3) — undo as ledger navigation. Types
// first (PROMPT-00 §3). The ledger is the existing division_events stream;
// this module never sees the database.
import { z } from "zod";

export const LedgerEvent = z.object({
  seq: z.number().int().positive(),
  type: z.string(),
  payload: z.record(z.string(), z.unknown()),
});
export type LedgerEvent = z.infer<typeof LedgerEvent>;

// Placement of one fixture on the timetable.
export const Placement = z.object({
  at: z.string().nullable(), // ISO timestamp | null = unscheduled
  court: z.string().nullable(),
});
export type Placement = z.infer<typeof Placement>;

// The disposable fold cache (same principle as MatchState, doc 02 §6):
// fold(events ≤ watermark) rebuilds it from the ledger at any time.
export interface FixtureScheduleState {
  exists: boolean;
  at: string | null;
  court: string | null;
  locked: boolean;
}
export interface DivisionScheduleState {
  fixtures: Record<string, FixtureScheduleState>;
}

// The event the app should append (under the division aggregate lock) plus
// the new watermark to persist.
export interface HistoryStep {
  event: { type: string; payload: Record<string, unknown> };
  newWatermark: number;
}

export type HistoryErrorCode =
  | "NOTHING_TO_UNDO"
  | "NOTHING_TO_REDO"
  | "UNDO_BLOCKED_HAS_RESULTS"; // Jul3/03 §3 results-guard

export class HistoryError extends Error {
  constructor(
    readonly code: HistoryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HistoryError";
  }
}

// A fixture snapshot rich enough to re-insert the row on undo/redo of a
// destructive op (fixtures_cleared / pool_entrants_cleared payloads).
export const FixtureSnapshot = z.object({
  id: z.string(),
  stage_id: z.string().optional(),
  pool_id: z.string().nullable().optional(),
  round_no: z.number().int().optional(),
  seq_in_round: z.number().int().optional(),
  home_entrant_id: z.string().nullable().optional(),
  away_entrant_id: z.string().nullable().optional(),
  at: z.string().nullable().optional(),
  court: z.string().nullable().optional(),
  locked: z.boolean().optional(),
});
export type FixtureSnapshot = z.infer<typeof FixtureSnapshot>;

// Scoped clear (Jul3/03 §5) — mirrors the generation filters (4 Jul ask).
export const ClearScope = z.object({
  stageId: z.string().optional(),
  poolIds: z.array(z.string()).optional(),
  rounds: z.array(z.number().int()).optional(),
  courts: z.array(z.string()).optional(),
  excludeLocked: z.boolean().default(true),
});
export type ClearScope = z.infer<typeof ClearScope>;

// What clearSchedule needs to know about a fixture to decide scope membership.
export interface ClearableFixture {
  id: string;
  stageId: string;
  poolId: string | null;
  roundNo: number | null;
  court: string | null;
  at: string | null;
  locked: boolean;
  decided: boolean;
}
