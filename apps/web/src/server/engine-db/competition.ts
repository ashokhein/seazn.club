import "server-only";
import type postgres from "postgres";
import { withTenant } from "@/lib/db";
import { EngineError, type MatchOutcome, type StageCtx } from "@seazn/engine/core";
import {
  completeTableStage,
  isBracketStageComplete,
  isTableStageComplete,
  type BracketFixture,
  type DivisionEvent,
  type FixtureStatus,
  type StandingsRow,
  type TableFixture,
  type TableStage,
} from "@seazn/engine/competition";
import type { AnySportModule } from "@seazn/engine/sport";
import { resolveModule } from "./registry";

type Tx = postgres.TransactionSql;

const TABLE_KINDS = new Set(["league", "group", "swiss"]);

// DB fixtures.status → engine FixtureStatus (spec 05 §1 vocabulary).
function toEngineStatus(dbStatus: string): FixtureStatus {
  switch (dbStatus) {
    case "decided":
    case "finalized":
      return "decided";
    case "forfeited":
      return "walkover";
    case "abandoned":
    case "cancelled":
      return "void";
    case "in_play":
      return "in_play";
    default:
      return "scheduled";
  }
}

interface StageRow {
  id: string;
  division_id: string;
  kind: string;
  config: { rngSeed?: number; rounds?: number } | null;
  status: string;
}
interface DivisionRow {
  config: unknown;
  sport_key: string;
  module_version: string;
  tiebreakers: string[] | null;
  seq: number;
}
interface FixtureRow {
  id: string;
  status: string;
  round_no: number;
  pool_id: string | null;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  outcome: unknown;
  state: unknown;
}

interface StageInputs {
  stage: StageRow;
  division: DivisionRow;
  module: AnySportModule;
  cfg: unknown;
  fixtures: FixtureRow[];
  tableFixtures: TableFixture[];
  entrants: string[];
  seeds: Map<string, number>;
}

// Load a stage's fixtures and turn each decided fixture into a StandingsDelta
// pair via the pinned sport module (spec 03 §4.3). Shared by recompute +
// complete so deltas are computed once per pass.
async function loadStageInputs(tx: Tx, stageId: string): Promise<StageInputs> {
  const [stage] = await tx<StageRow[]>`
    select id, division_id, kind, config, status from stages where id = ${stageId}
  `;
  if (!stage) throw new EngineError("STAGE_NOT_READY", `stage ${stageId} not found`, { stageId });

  const [division] = await tx<DivisionRow[]>`
    select config, sport_key, module_version, tiebreakers, seq
    from divisions where id = ${stage.division_id}
  `;
  if (!division) throw new EngineError("CONFIG_INVALID", "division not found", { stageId });

  const sportModule = resolveModule(division.sport_key, division.module_version);
  const ctxBase: StageCtx = { kind: stage.kind as StageCtx["kind"] };

  const fixtures = await tx<FixtureRow[]>`
    select f.id, f.status, f.round_no, f.pool_id, f.home_entrant_id, f.away_entrant_id,
           f.outcome, m.state
    from fixtures f left join match_states m on m.fixture_id = f.id
    where f.stage_id = ${stageId}
    order by f.round_no, f.seq_in_round
  `;

  const tableFixtures: TableFixture[] = fixtures.map((f) => {
    const base: TableFixture = {
      id: f.id,
      status: toEngineStatus(f.status),
      ...(f.pool_id ? { poolId: f.pool_id } : {}),
      roundNo: f.round_no,
    };
    // Only decided fixtures with a folded state contribute a delta pair.
    if (f.outcome && f.state && f.home_entrant_id && f.away_entrant_id) {
      const ctx: StageCtx = { ...ctxBase, roundNo: f.round_no, ...(f.pool_id ? { poolId: f.pool_id } : {}) };
      const [home, away] = sportModule.standingsDelta(
        f.outcome as MatchOutcome,
        division.config,
        ctx,
        f.state,
      );
      base.result = [home, away];
    }
    return base;
  });

  const entrantSet = new Set<string>();
  for (const f of fixtures) {
    if (f.home_entrant_id) entrantSet.add(f.home_entrant_id);
    if (f.away_entrant_id) entrantSet.add(f.away_entrant_id);
  }
  const entrants = [...entrantSet];

  const seeds = new Map<string, number>();
  if (entrants.length > 0) {
    const seedRows = await tx<{ id: string; seed: number | null }[]>`
      select id, seed from entrants where id in ${tx(entrants)}
    `;
    for (const r of seedRows) if (r.seed != null) seeds.set(r.id, r.seed);
  }

  return {
    stage,
    division,
    module: sportModule,
    cfg: division.config,
    fixtures,
    tableFixtures,
    entrants,
    seeds,
  };
}

function cascadeFor(inputs: StageInputs): readonly string[] {
  return inputs.division.tiebreakers ?? inputs.module.defaultTiebreakers;
}

function toTableStage(inputs: StageInputs): TableStage {
  return {
    id: inputs.stage.id,
    kind: inputs.stage.kind as TableStage["kind"],
    entrants: inputs.entrants,
    cascade: cascadeFor(inputs) as TableStage["cascade"],
    ...(inputs.seeds.size > 0 ? { seeds: inputs.seeds } : {}),
    ...(inputs.stage.config?.rngSeed != null ? { rngSeed: inputs.stage.config.rngSeed } : {}),
    ...(inputs.stage.config?.rounds != null ? { rounds: inputs.stage.config.rounds } : {}),
    ...(inputs.stage.kind === "swiss" ? { swiss: true } : {}),
  };
}

async function writeSnapshot(
  tx: Tx,
  stageId: string,
  poolId: string | null,
  rows: readonly StandingsRow[],
  through: number,
): Promise<void> {
  await tx`
    insert into standings_snapshots (stage_id, pool_id, rows, computed_through_seq)
    values (${stageId}, ${poolId}, ${tx.json(rows as never)}, ${through})
    on conflict on constraint standings_snapshots_pkey do update set
      rows = excluded.rows, computed_through_seq = excluded.computed_through_seq, updated_at = now()
  `;
}

/**
 * Recompute + cache the standings snapshot for one (stage, pool). Folds every
 * decided fixture's delta and ranks via the tiebreaker cascade (spec 03 §4.3),
 * under a division advisory lock. `poolId` null = the single non-pool table.
 */
export async function recomputeStandings(
  orgId: string,
  stageId: string,
  poolId?: string,
): Promise<readonly StandingsRow[]> {
  return withTenant(orgId, async (tx) => {
    const inputs = await loadStageInputs(tx, stageId);
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + inputs.stage.division_id}))`;

    // completeTableStage folds + ranks each pool; pick the one we were asked for.
    const { tables } = completeTableStage(toTableStage(inputs), inputs.tableFixtures);
    const target = tables.pools.find((p) => (p.pool || null) === (poolId ?? null)) ?? tables.pools[0];
    const rows = target ? target.rows : [];
    await writeSnapshot(tx, stageId, poolId ?? null, rows, inputs.division.seq);
    return rows;
  });
}

// Append a division_event under the division lock, assigning a gapless per-
// division seq (doc 07 note 3). Returns the new seq.
async function appendDivisionEvent(
  tx: Tx,
  divisionId: string,
  type: string,
  payload: unknown,
): Promise<number> {
  const [{ seq: last }] = await tx<{ seq: number }[]>`
    select coalesce(max(seq), 0)::int as seq from division_events where division_id = ${divisionId}
  `;
  const seq = last + 1;
  await tx`
    insert into division_events (division_id, seq, type, payload)
    values (${divisionId}, ${seq}, ${type}, ${tx.json(payload as never)})
  `;
  return seq;
}

export interface CompleteResult {
  completed: boolean;
  events: DivisionEvent[];
}

/**
 * If a stage's completion predicate holds (spec 05 §1), mark it complete, cache
 * its final standings, and record the structural division_events
 * (stage_completed + any rank-lock) — all under the division advisory lock and
 * idempotent (a re-run on an already-complete stage is a no-op).
 *
 * Table stages (league/group/swiss) are fully handled. Bracket stages
 * (knockout/double_elim/stepladder) detect completion and emit stage_completed;
 * their next-stage generation lands in PROMPT-09.
 */
export async function completeStageIfReady(
  orgId: string,
  stageId: string,
): Promise<CompleteResult> {
  return withTenant(orgId, async (tx) => {
    const inputs = await loadStageInputs(tx, stageId);
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + inputs.stage.division_id}))`;

    if (inputs.stage.status === "complete") return { completed: true, events: [] };

    const isTable = TABLE_KINDS.has(inputs.stage.kind);
    let events: DivisionEvent[] = [];

    if (isTable) {
      const tableStage = toTableStage(inputs);
      if (!isTableStageComplete(tableStage, inputs.tableFixtures)) {
        return { completed: false, events: [] };
      }
      const completed = completeTableStage(tableStage, inputs.tableFixtures);
      events = completed.events;
      for (const pool of completed.tables.pools) {
        await writeSnapshot(tx, stageId, pool.pool || null, pool.rows, inputs.division.seq);
      }
    } else {
      const bracketFixtures: BracketFixture[] = inputs.fixtures.map((f) => ({
        id: f.id,
        round: f.round_no,
        // A fixture whose winner feeds nowhere is the bracket's deciding game.
        isFinal: true,
        status: toEngineStatus(f.status),
      }));
      // Refine: only fixtures with no onward winner feed are finals.
      const feeders = await tx<{ id: string }[]>`
        select id from fixtures where stage_id = ${stageId} and winner_to_fixture is not null
      `;
      const feederIds = new Set(feeders.map((r) => r.id));
      for (const bf of bracketFixtures) if (feederIds.has(bf.id)) bf.isFinal = false;

      if (!isBracketStageComplete({ id: stageId, kind: inputs.stage.kind as never }, bracketFixtures)) {
        return { completed: false, events: [] };
      }
      const final = inputs.fixtures.find((f) => !feederIds.has(f.id) && f.outcome);
      const finalRanks: string[] = [];
      if (final?.outcome && (final.outcome as MatchOutcome).kind === "win") {
        const o = final.outcome as Extract<MatchOutcome, { kind: "win" }>;
        finalRanks.push(o.winner, o.loser);
      }
      events = [{ type: "stage_completed", stageId, finalRanks }];
    }

    // Persist the structural events, then mark the stage complete and advance
    // the division watermark to the last division_event seq.
    let lastSeq = inputs.division.seq;
    for (const ev of events) {
      lastSeq = await appendDivisionEvent(tx, inputs.stage.division_id, ev.type, ev);
    }
    await tx`update stages set status = 'complete' where id = ${stageId}`;
    await tx`update divisions set seq = ${lastSeq} where id = ${inputs.stage.division_id}`;

    return { completed: true, events };
  });
}
