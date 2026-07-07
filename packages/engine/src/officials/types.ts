// Officials assignment domain (Jul3/02 §3) — types first (PROMPT-00 §3).
// Same shape as the calendar pass (doc 05 §2.6): pure, deterministic, seeded,
// never silently drops a constraint.
import { z } from "zod";

// A fixture the pass can assign officials to. Times injected (epoch ms).
export const OfficialFixture = z.object({
  id: z.string(),
  startAt: z.number(),
  endAt: z.number(),
  court: z.string().optional(),
  poolId: z.string().optional(),
  divisionId: z.string().optional(),
  stageId: z.string().optional(),
  /** Playing entrant ids (empty/partial for TBD feeds). */
  entrants: z.array(z.string()),
});
export type OfficialFixture = z.infer<typeof OfficialFixture>;

export const OfficialSpec = z.object({
  id: z.string(),
  roleKeys: z.array(z.string()).min(1),
  homePoolId: z.string().optional(), // poolLock constraint target (20 Jun)
  maxPerDay: z.number().int().positive().optional(), // fairness cap (29 May)
  /** Entrants this official belongs to: the team-as-referee entrant plus any
   *  entrant the official's person plays for — the team-ref-self and
   *  plays-while-reffing checks key off this (27 May). */
  entrantIds: z.array(z.string()).optional(),
  homeDivisionId: z.string().optional(), // teamRefKeepDivision travel basis
});
export type OfficialSpec = z.infer<typeof OfficialSpec>;

export const FixtureOfficial = z.object({
  fixtureId: z.string(),
  officialId: z.string(),
  roleKey: z.string(),
  locked: z.boolean().optional(),
});
export type FixtureOfficial = z.infer<typeof FixtureOfficial>;

export const AssignPolicy = z.object({
  roles: z.array(z.string()).min(1), // required roles per fixture (25 Dec)
  poolLock: z.boolean().default(false), // official only refs own home_pool (20 Jun)
  blockStay: z.boolean().default(false), // prefer same court across a block (29 Jun)
  fairness: z.enum(["tournament", "per_day"]).default("tournament"), // (29 May)
  teamRefKeepDivision: z.boolean().default(false), // 27 May
  restMinMinutes: z.number().int().nonnegative().default(0),
  /** A gap ≥ this on a court ends a block (29 Jun "before break"). */
  blockGapMinutes: z.number().int().positive().default(30),
});
export type AssignPolicy = z.infer<typeof AssignPolicy>;

// Conflict taxonomy (Jul3/02 §4): block vs warn mirrors doc 12 §2.
export type OfficialConflictKind =
  | "official_overlap" // block: one official, two overlapping fixtures
  | "team_ref_self" // block: official's entrant plays in the fixture
  | "role_unfilled" // block: no eligible official for a required role
  | "pool_leak" // warn: assignment crosses the official's home pool
  | "fairness" // warn: per-official spread above 1 within the basis
  | "travel"; // warn: team-ref sent outside its division

export interface OfficialConflict {
  kind: OfficialConflictKind;
  severity: "block" | "warn";
  fixtureId?: string;
  officialId?: string;
  roleKey?: string;
  detail?: string;
}

export interface AssignInput {
  fixtures: readonly OfficialFixture[];
  officials: readonly OfficialSpec[];
  /** Pinned assignments — fixed obstacles the pass never moves. */
  locked: readonly FixtureOfficial[];
  policy: AssignPolicy;
  rngSeed: string;
}

export interface AssignResult {
  /** Locked (echoed) plus newly proposed assignments. */
  assignments: FixtureOfficial[];
  conflicts: OfficialConflict[];
}

// --- Phased sourcing (Jul3/02 §3, ideas 3 Jun / 17 Jun) ---------------------

export const RankSourcing = z.object({
  kind: z.literal("rank"),
  fromStage: z.string(),
  take: z.array(z.object({ poolId: z.string().optional(), rank: z.number().int().positive() })),
});
export const ResultSourcing = z.object({
  kind: z.literal("result"),
  fromFixture: z.string(),
  side: z.enum(["winner", "loser"]),
});
export const OfficialSourcing = z.discriminatedUnion("kind", [RankSourcing, ResultSourcing]);
export type OfficialSourcing = z.infer<typeof OfficialSourcing>;

export interface SourcingSnapshot {
  standings: readonly {
    stageId: string;
    poolId?: string;
    rows: readonly { entrantId: string; rank: number }[];
    /** Ranks are only meaningful once the stage/pool has fully decided. */
    decided: boolean;
  }[];
  fixtures: readonly {
    id: string;
    decided: boolean;
    winnerId?: string;
    loserId?: string;
  }[];
  /** Withdrawn entrants drop from the pool (Jul3/02 §6). */
  withdrawnEntrantIds?: readonly string[];
}

export interface SourcingResult {
  /** Entrants resolved into officiating duty, in source order. */
  resolved: { entrantId: string; source: OfficialSourcing }[];
  /** Sources that cannot resolve yet (undecided) or at all. */
  pending: { source: OfficialSourcing; reason: string }[];
}
