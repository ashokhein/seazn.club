// Qualification resolution — spec 05 §3. When a stage completes the engine
// resolves the next stage's qualification spec into an ORDERED seed list that
// feeds the next stage's generator. Pure and idempotent: identical inputs yield
// an identical list (property test), so regeneration is deterministic.
import { EngineError } from "../core/errors.ts";
import type { EntrantId } from "../core/types.ts";
import {
  foldResults,
  resultsAmong,
  type FixtureResult,
  type StandingsRow,
} from "./standings.ts";
import { rankStandings } from "./tiebreakers.ts";

// spec 05 §3 — the three qualification shapes.
export interface PoolRankPick {
  pool: string;
  rank: number;
}
export interface TakePicks {
  from?: string;
  take: readonly PoolRankPick[];
}
export interface TopN {
  from?: string;
  topN: number;
}
export interface BestOfRank {
  from?: string;
  bestOfRank: {
    rank: number;
    count: number;
    // UEFA "best third-placed" across unequal pools: normalise by dropping each
    // candidate's results vs its pool's lowest-ranked member before comparing
    // (spec 05 §3). Default false ⇒ plain metric comparison.
    normaliseUnequalPools?: boolean;
  };
}
export type QualificationSpec = TakePicks | TopN | BestOfRank;

// A completed stage's ranked tables. `results` (pool fixtures) is needed only
// for best-of-rank normalisation.
export interface PoolTable {
  pool: string;
  rows: readonly StandingsRow[]; // ranked: rank = 1..n, distinct
  results?: readonly FixtureResult[];
}
export interface StageTables {
  pools: readonly PoolTable[];
  overall?: readonly StandingsRow[]; // league / topN source
}

function isTake(spec: QualificationSpec): spec is TakePicks {
  return "take" in spec;
}
function isTopN(spec: QualificationSpec): spec is TopN {
  return "topN" in spec;
}

// The seed count a spec must produce — the next stage's generator input size
// (spec 05 §6 invariant: qualification output size matches next stage input).
export function qualificationSize(spec: QualificationSpec): number {
  if (isTake(spec)) return spec.take.length;
  if (isTopN(spec)) return spec.topN;
  return spec.bestOfRank.count;
}

function rowAtRank(table: PoolTable, rank: number): StandingsRow {
  const row = table.rows.find((entry) => entry.rank === rank);
  if (row === undefined) {
    throw new EngineError(
      "STAGE_NOT_READY",
      `pool "${table.pool}" has no entrant ranked ${rank} (table incomplete?)`,
      { pool: table.pool, rank },
    );
  }
  return row;
}

function poolByName(tables: StageTables, name: string): PoolTable {
  const table = tables.pools.find((pool) => pool.pool === name);
  if (table === undefined) {
    throw new EngineError("STAGE_NOT_READY", `no pool named "${name}" in the completed stage`, {
      pool: name,
    });
  }
  return table;
}

// Recompute a candidate's row with its results vs the pool's lowest-ranked
// member dropped (UEFA normalisation, spec 05 §3). If the candidate *is* the
// bottom member (shouldn't happen for third-placed picks), nothing is dropped.
function normalisedRow(table: PoolTable, candidateId: EntrantId): StandingsRow {
  const results = table.results ?? [];
  const bottom = table.rows[table.rows.length - 1];
  if (bottom === undefined || bottom.entrantId === candidateId || results.length === 0) {
    const full = table.rows.find((row) => row.entrantId === candidateId);
    if (full === undefined) {
      throw new EngineError("STAGE_NOT_READY", `candidate "${candidateId}" not in its pool table`, {
        candidateId,
      });
    }
    return full;
  }
  const survivors = table.rows
    .map((row) => row.entrantId)
    .filter((id) => id !== bottom.entrantId);
  const kept = resultsAmong(new Set(survivors), results);
  const refolded = foldResults(survivors, kept);
  const row = refolded.find((entry) => entry.entrantId === candidateId);
  if (row === undefined) {
    throw new EngineError("STAGE_NOT_READY", `candidate "${candidateId}" not in its pool table`, {
      candidateId,
    });
  }
  return row;
}

// Order candidates by a simple metric cascade (spec 05 §3 default: points →
// diff → for → wins), with a deterministic seed→id fallback. No head-to-head:
// candidates come from different pools and never met.
function orderCandidates(rows: StandingsRow[]): StandingsRow[] {
  return rankStandings(rows, {
    cascade: ["points", "diff", "for", "wins"],
  }).rows;
}

// Resolve a qualification spec against a completed stage's tables → ordered
// seed list (spec 05 §3).
export function resolveQualification(spec: QualificationSpec, tables: StageTables): EntrantId[] {
  if (isTake(spec)) {
    return spec.take.map((pick) => rowAtRank(poolByName(tables, pick.pool), pick.rank).entrantId);
  }

  if (isTopN(spec)) {
    const source =
      tables.overall ??
      (tables.pools.length === 1 ? (tables.pools[0] as PoolTable).rows : undefined);
    if (source === undefined) {
      throw new EngineError("STAGE_NOT_READY", "topN needs an overall table (or a single pool)", {
        topN: spec.topN,
      });
    }
    if (source.length < spec.topN) {
      throw new EngineError("STAGE_NOT_READY", `topN=${spec.topN} exceeds ${source.length} entrants`, {
        topN: spec.topN,
      });
    }
    return [...source]
      .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity))
      .slice(0, spec.topN)
      .map((row) => row.entrantId);
  }

  // bestOfRank — "the N best rank-R finishers across pools".
  const { rank, count, normaliseUnequalPools } = spec.bestOfRank;
  const candidates = tables.pools.map((pool) => {
    const picked = rowAtRank(pool, rank);
    return normaliseUnequalPools === true ? normalisedRow(pool, picked.entrantId) : picked;
  });
  if (candidates.length < count) {
    throw new EngineError(
      "STAGE_NOT_READY",
      `bestOfRank needs ${count} pools with a rank-${rank} finisher, found ${candidates.length}`,
      { rank, count },
    );
  }
  return orderCandidates(candidates)
    .slice(0, count)
    .map((row) => row.entrantId);
}
