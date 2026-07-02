// Shared primitives — spec 03 §3 (MatchOutcome, ScoreSummary, StandingsDelta,
// MetricSpec, StageCtx), spec 02 §2/§3/§5 (entrants, lineups, stage kinds).
// Zod schemas first, inferred types second (conventions PROMPT-00 §3).
import { z } from "zod";

// spec 02 §2 — the competition engine pairs/ranks entrants and never cares
// what's inside them (team | individual | pair).
export const EntrantId = z.string().min(1);
export type EntrantId = z.infer<typeof EntrantId>;

// spec 02 §5 — a division's format is an ordered list of stages.
export const StageKind = z.enum([
  "league",
  "group",
  "swiss",
  "knockout",
  "double_elim",
  "stepladder",
]);
export type StageKind = z.infer<typeof StageKind>;

// spec 03 §3 — context the sport module receives when computing standings
// deltas (knockout football forbids draws; group cricket shares points, …).
export const StageCtx = z.object({
  kind: StageKind,
  poolId: z.string().min(1).optional(),
  roundNo: z.number().int().positive().optional(),
});
export type StageCtx = z.infer<typeof StageCtx>;

// spec 03 §3 — all five kinds. `tie` (cricket) ≠ `draw`: different points in
// some competitions. `award` covers forfeit/DQ with an awarded score.
export const MatchOutcome = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("win"),
    winner: EntrantId,
    loser: EntrantId,
    // 'regulation' | 'extra_time' | 'shootout' | 'super_over' | 'dls' |
    // 'walkover' | 'timeout' — sport modules may extend, so plain string.
    method: z.string().min(1).optional(),
  }),
  z.object({ kind: z.literal("draw") }),
  z.object({ kind: z.literal("tie") }),
  z.object({ kind: z.literal("no_result") }),
  z.object({
    kind: z.literal("award"),
    winner: EntrantId,
    score: z.unknown().optional(),
  }),
]);
export type MatchOutcome = z.infer<typeof MatchOutcome>;

// spec 03 §3 — structured, render-agnostic: UI and public API render it
// without knowing the sport.
export const SideSummary = z.object({
  entrantId: EntrantId,
  line: z.string(), // '252/8 (50)', '3–1', '2½'
});
export type SideSummary = z.infer<typeof SideSummary>;

export const ScoreSummary = z.object({
  headline: z.string(), // '252/8 (50) — 253/4 (48.2)'
  perSide: z.array(SideSummary),
  detail: z.unknown().optional(), // sport-specific breakdown
});
export type ScoreSummary = z.infer<typeof ScoreSummary>;

// spec 02 §7 — additive contribution of one decided fixture to a StandingsRow;
// the competition engine folds deltas and ranks via the tiebreaker cascade.
export const StandingsDelta = z.object({
  entrantId: EntrantId,
  played: z.number().int().nonnegative(),
  won: z.number().int().nonnegative(),
  drawn: z.number().int().nonnegative(),
  lost: z.number().int().nonnegative(),
  points: z.number(),
  // sport ledger contributions: gf/ga · runs_for/overs_faced · sets_won …
  metrics: z.record(z.string(), z.number()),
});
export type StandingsDelta = z.infer<typeof StandingsDelta>;

// spec 03 §3 — declares a ledger field the sport maintains (gd, nrr,
// set_ratio…) so the standings UI and tiebreaker cascade can consume it.
export const MetricSpec = z.object({
  key: z.string().min(1), // 'gd', 'nrr', 'set_ratio'
  label: z.string().min(1), // 'Goal difference'
  direction: z.enum(["desc", "asc"]), // desc = higher is better
  decimals: z.number().int().nonnegative().optional(), // display precision
});
export type MetricSpec = z.infer<typeof MetricSpec>;

// spec 02 §3 — person selected for a specific fixture. orderNo = batting
// order in cricket, board order in team chess.
export const LineupSlot = z.object({
  personId: z.string().min(1),
  positionKey: z.string().min(1).optional(),
  slot: z.enum(["starting", "bench"]),
  orderNo: z.number().int().positive(),
  // Role keys from the sport's PositionCatalog (captain, wicketkeeper, …).
  // PROMPT-03 deviation: doc 02 §3 kept roles on RosterEntry only, but
  // validateLineup (spec 02 §3 "unique roles") checks them per fixture, so
  // the lineup carries the fixture-specific assignment.
  roles: z.array(z.string().min(1)).optional(),
});
export type LineupSlot = z.infer<typeof LineupSlot>;

export const Lineup = z.object({
  entrantId: EntrantId,
  slots: z.array(LineupSlot),
});
export type Lineup = z.infer<typeof Lineup>;

// spec 03 §3 — SportModule.init(cfg, lineups: LineupPair).
export const LineupPair = z.object({
  home: Lineup,
  away: Lineup,
});
export type LineupPair = z.infer<typeof LineupPair>;
