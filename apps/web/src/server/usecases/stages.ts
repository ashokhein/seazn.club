import "server-only";
// Stage use-cases (doc 08 §3): define the stage graph, generate fixtures
// (idempotent — regeneration diffs against what exists, keyed by the pure
// generator's stable ids), guarded completion, standings reads.
import type postgres from "postgres";
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { EngineError } from "@seazn/engine/core";
import {
  generateRoundRobin,
  generateSingleElim,
  generateDoubleElim,
  generateStepladder,
  pairRound,
  pairKey,
  type BracketFixtureGen,
  type GeneratedBracket,
  type SwissStanding,
  type Colour,
} from "@seazn/engine/scheduling";
import { completeStageIfReady, recomputeStandings, type CompleteResult } from "@/server/engine-db";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { CreateStages } from "@/server/api-v1/schemas";
import { z } from "zod";
import { CreateStage } from "@/server/api-v1/schemas";

type Tx = postgres.TransactionSql;
type StageInput = z.infer<typeof CreateStage>;

export interface StageRow {
  id: string;
  division_id: string;
  seq: number;
  kind: string;
  name: string;
  config: Record<string, unknown>;
  qualification: Record<string, unknown> | null;
  status: string;
}

const STAGE_COLS = ["id", "division_id", "seq", "kind", "name", "config", "qualification", "status"] as const;

export const FIXTURE_COLS = [
  "id", "stage_id", "division_id", "pool_id", "round_no", "seq_in_round",
  "home_entrant_id", "away_entrant_id", "scheduled_at", "venue", "court_label",
  "officials", "status", "outcome", "created_at",
] as const;

export interface FixtureRow {
  id: string;
  stage_id: string;
  division_id: string;
  pool_id: string | null;
  round_no: number;
  seq_in_round: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  scheduled_at: string | null;
  venue: string | null;
  court_label: string | null;
  officials: unknown[];
  status: string;
  outcome: unknown;
  created_at: string;
}

export async function listStages(auth: AuthCtx, divisionId: string): Promise<StageRow[]> {
  return withTenant(auth.orgId, async (tx) => {
    const [division] = await tx`select 1 from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    return tx<StageRow[]>`
      select ${tx(STAGE_COLS)} from stages where division_id = ${divisionId} order by seq`;
  });
}

/** Define (part of) the stage graph for a division. */
export async function createStages(
  auth: AuthCtx,
  divisionId: string,
  input: CreateStages,
): Promise<StageRow[]> {
  const inputs: StageInput[] = Array.isArray(input) ? input : [input];
  return withTenant(auth.orgId, async (tx) => {
    const [division] = await tx`select 1 from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    const rows: StageRow[] = [];
    for (const s of inputs) {
      const [dupe] = await tx`
        select 1 from stages where division_id = ${divisionId} and seq = ${s.seq}`;
      if (dupe) throw new HttpError(409, `stage seq ${s.seq} already exists`);
      const [row] = await tx<StageRow[]>`
        insert into stages (division_id, seq, kind, name, config, qualification)
        values (${divisionId}, ${s.seq}, ${s.kind}, ${s.name}, ${tx.json(s.config as never)},
                ${s.qualification ? tx.json(s.qualification as never) : null})
        returning ${tx(STAGE_COLS)}`;
      rows.push(row);
    }
    return rows;
  });
}

// ---------------------------------------------------------------------------
// Fixture generation (doc 08 §3 — idempotent, returns diff)
// ---------------------------------------------------------------------------

// A generator fixture normalised for persistence, identity = ext_key (the pure
// generator's stable id, spec 05 §6 — regeneration is byte-identical).
interface GenFixture {
  extKey: string;
  roundNo: number;
  seqInRound: number;
  home: string | null;
  away: string | null;
  homeFrom?: { extKey: string; side: "winner" | "loser" };
  awayFrom?: { extKey: string; side: "winner" | "loser" };
  award?: string; // bye: auto-advancing entrant
}

interface ActiveEntrant {
  id: string;
  seed: number | null;
}

function bracketToGen(bracket: GeneratedBracket, laneDepth: number): GenFixture[] {
  // Per-(lane, round) counters give a stable seq_in_round in emission order.
  const counters = new Map<string, number>();
  const laneOffset = (f: BracketFixtureGen): number =>
    f.bracket === "LB" ? laneDepth : f.bracket === "GF" ? laneDepth * 2 : 0;
  return bracket.fixtures.map((f) => {
    const roundNo = laneOffset(f) + f.round + 1;
    const n = (counters.get(`${f.bracket ?? "WB"}:${roundNo}`) ?? 0) + 1;
    counters.set(`${f.bracket ?? "WB"}:${roundNo}`, n);
    return {
      extKey: f.id,
      roundNo,
      seqInRound: n,
      home: f.home ?? f.award ?? null,
      away: f.away ?? null,
      ...(f.homeFrom ? { homeFrom: { extKey: f.homeFrom.fixtureId, side: f.homeFrom.side } } : {}),
      ...(f.awayFrom ? { awayFrom: { extKey: f.awayFrom.fixtureId, side: f.awayFrom.side } } : {}),
      ...(f.award ? { award: f.award } : {}),
    };
  });
}

const DECIDED = new Set(["decided", "finalized", "forfeited"]);

// Swiss next round (spec 05 §2.2): score groups from prior outcomes (win 1,
// draw/tie ½, bye 1), history from persisted fixtures, then pairRound.
async function swissGen(
  tx: Tx,
  stageId: string,
  cfg: Record<string, unknown>,
  entrants: ActiveEntrant[],
  existing: { ext_key: string | null; round_no: number; status: string; home_entrant_id: string | null; away_entrant_id: string | null; outcome: unknown }[],
): Promise<GenFixture[]> {
  const rounds = typeof cfg.rounds === "number" ? cfg.rounds : null;
  const maxRound = existing.reduce((m, f) => Math.max(m, f.round_no), 0);
  if (rounds !== null && maxRound >= rounds) return [];
  const pending = existing.some((f) => !DECIDED.has(f.status));
  if (pending) {
    throw new EngineError("STAGE_NOT_READY", "current swiss round has undecided fixtures", { stageId });
  }

  const score = new Map<string, number>(entrants.map((e) => [e.id, 0]));
  const played = new Set<string>();
  const colours = new Map<string, Colour[]>();
  const byes = new Set<string>();
  const inRound = new Map<number, Set<string>>();
  for (const f of existing) {
    if (!f.home_entrant_id || !f.away_entrant_id) continue;
    played.add(pairKey(f.home_entrant_id, f.away_entrant_id));
    const forRound = inRound.get(f.round_no) ?? new Set<string>();
    forRound.add(f.home_entrant_id).add(f.away_entrant_id);
    inRound.set(f.round_no, forRound);
    (colours.get(f.home_entrant_id) ?? colours.set(f.home_entrant_id, []).get(f.home_entrant_id)!).push("W");
    (colours.get(f.away_entrant_id) ?? colours.set(f.away_entrant_id, []).get(f.away_entrant_id)!).push("B");
    const o = f.outcome as { kind?: string; winner?: string } | null;
    if (o?.kind === "win" && o.winner) score.set(o.winner, (score.get(o.winner) ?? 0) + 1);
    else if (o?.kind === "draw" || o?.kind === "tie") {
      score.set(f.home_entrant_id, (score.get(f.home_entrant_id) ?? 0) + 0.5);
      score.set(f.away_entrant_id, (score.get(f.away_entrant_id) ?? 0) + 0.5);
    }
  }
  // An entrant absent from a played round sat out = bye (scored 1).
  for (let r = 1; r <= maxRound; r++) {
    const seen = inRound.get(r) ?? new Set();
    for (const e of entrants) {
      if (!seen.has(e.id)) {
        byes.add(e.id);
        score.set(e.id, (score.get(e.id) ?? 0) + 1);
      }
    }
  }

  const standings: SwissStanding[] = entrants.map((e, i) => ({
    entrantId: e.id,
    score: score.get(e.id) ?? 0,
    rank: e.seed ?? 1000 + i,
  }));
  const round = pairRound(standings, { played, colours, byes }, { chess: cfg.chess === true });
  const roundNo = maxRound + 1;
  return round.pairings.map((p, i) => ({
    extKey: `sw-r${roundNo}-b${i + 1}`,
    roundNo,
    seqInRound: i + 1,
    home: p.home,
    away: p.away,
  }));
}

function generate(
  kind: string,
  cfg: Record<string, unknown>,
  entrants: ActiveEntrant[],
): GenFixture[] {
  const ids = entrants.map((e) => e.id);
  const seeds = new Map(entrants.filter((e) => e.seed != null).map((e) => [e.id, e.seed as number]));
  switch (kind) {
    case "league":
    case "group": {
      const legs = cfg.legs === 2 ? 2 : 1;
      const schedule = generateRoundRobin({ entrants: ids, seeds, config: { legs } });
      return schedule.fixtures.map((f) => ({
        extKey: f.id,
        roundNo: f.roundNo,
        seqInRound: f.court,
        home: f.home,
        away: f.away,
      }));
    }
    case "knockout": {
      const bracket = generateSingleElim({ entrants: ids, seeds, thirdPlace: cfg.thirdPlace === true });
      return bracketToGen(bracket, bracket.rounds);
    }
    case "double_elim": {
      const bracket = generateDoubleElim({ entrants: ids, seeds, bracketReset: cfg.bracketReset === true });
      return bracketToGen(bracket, bracket.rounds);
    }
    case "stepladder": {
      const bracket = generateStepladder({ entrants: ids, seeds });
      return bracketToGen(bracket, bracket.rounds);
    }
    default:
      throw new EngineError("CONFIG_INVALID", `cannot generate fixtures for stage kind '${kind}'`, { kind });
  }
}

export interface GenerateOutcome {
  created: number;
  existing: number;
  fixtures: FixtureRow[];
}

/**
 * Generate a stage's fixtures (doc 08 §3). Idempotent: the generator's stable
 * ids are persisted as fixtures.ext_key, so a re-run inserts only what's
 * missing and reports the diff. Feed wiring (winner_to/loser_to) and bye
 * awards are applied after insert, under the division advisory lock.
 */
export async function generateStageFixtures(auth: AuthCtx, stageId: string): Promise<GenerateOutcome> {
  return withTenant(auth.orgId, async (tx) => {
    const [stage] = await tx<StageRow[]>`
      select ${tx(STAGE_COLS)} from stages where id = ${stageId}`;
    if (!stage) throw new HttpError(404, "stage not found");
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + stage.division_id}))`;

    const entrants = await tx<ActiveEntrant[]>`
      select id, seed from entrants
      where division_id = ${stage.division_id} and status in ('registered', 'confirmed')
      order by seed nulls last, created_at, id`;
    if (entrants.length < 2) {
      throw new EngineError("STAGE_NOT_READY", "need at least 2 active entrants to generate", {
        stageId,
        entrants: entrants.length,
      });
    }

    const existing = await tx<
      { id: string; ext_key: string | null; round_no: number; status: string; home_entrant_id: string | null; away_entrant_id: string | null; outcome: unknown }[]
    >`
      select id, ext_key, round_no, status, home_entrant_id, away_entrant_id, outcome
      from fixtures where stage_id = ${stageId}`;

    const gen =
      stage.kind === "swiss"
        ? await swissGen(tx, stageId, stage.config, entrants, existing)
        : generate(stage.kind, stage.config, entrants);

    const byKey = new Map<string, string>(); // ext_key → fixture uuid
    for (const f of existing) if (f.ext_key) byKey.set(f.ext_key, f.id);

    let created = 0;
    for (const g of gen) {
      if (byKey.has(g.extKey)) continue;
      const award = g.award !== undefined;
      const [row] = await tx<{ id: string }[]>`
        insert into fixtures (stage_id, division_id, round_no, seq_in_round,
                              home_entrant_id, away_entrant_id, ext_key, status, outcome)
        values (${stageId}, ${stage.division_id}, ${g.roundNo}, ${g.seqInRound},
                ${g.home}, ${g.away}, ${g.extKey},
                ${award ? "forfeited" : "scheduled"},
                ${award ? tx.json({ kind: "award", winner: g.award } as never) : null})
        returning id`;
      byKey.set(g.extKey, row.id);
      created += 1;
    }

    // Second pass: feeds. A target's homeFrom/awayFrom becomes the SOURCE
    // fixture's winner_to/loser_to (+slot 1=home, 2=away).
    for (const g of gen) {
      const targetId = byKey.get(g.extKey);
      if (!targetId) continue;
      for (const [feed, slot] of [
        [g.homeFrom, 1],
        [g.awayFrom, 2],
      ] as const) {
        if (!feed) continue;
        const sourceId = byKey.get(feed.extKey);
        if (!sourceId) continue;
        if (feed.side === "winner") {
          await tx`update fixtures set winner_to_fixture = ${targetId}, winner_to_slot = ${slot}
                   where id = ${sourceId} and winner_to_fixture is null`;
        } else {
          await tx`update fixtures set loser_to_fixture = ${targetId}, loser_to_slot = ${slot}
                   where id = ${sourceId} and loser_to_fixture is null`;
        }
      }
    }

    // Third pass: propagate bye awards into their winner feeds.
    for (const g of gen) {
      if (g.award === undefined) continue;
      const sourceId = byKey.get(g.extKey);
      if (!sourceId) continue;
      const [source] = await tx<{ winner_to_fixture: string | null; winner_to_slot: number | null }[]>`
        select winner_to_fixture, winner_to_slot from fixtures where id = ${sourceId}`;
      if (source?.winner_to_fixture && source.winner_to_slot) {
        await fillSlot(tx, source.winner_to_fixture, source.winner_to_slot, g.award);
      }
    }

    if (stage.status === "pending") {
      await tx`update stages set status = 'active' where id = ${stageId}`;
    }

    const fixtures = await tx<FixtureRow[]>`
      select ${tx(FIXTURE_COLS)} from fixtures
      where stage_id = ${stageId} order by round_no, seq_in_round`;
    return { created, existing: gen.length - created, fixtures };
  });
}

/** Fill one side of a fixture (slot 1=home, 2=away) if still open. */
export async function fillSlot(
  tx: Tx,
  fixtureId: string,
  slot: number,
  entrantId: string,
): Promise<void> {
  if (slot === 1) {
    await tx`update fixtures set home_entrant_id = ${entrantId}
             where id = ${fixtureId} and home_entrant_id is null`;
  } else {
    await tx`update fixtures set away_entrant_id = ${entrantId}
             where id = ${fixtureId} and away_entrant_id is null`;
  }
}

/** Guarded progression (doc 08 §3): no-op unless the completion predicate holds. */
export async function completeStage(auth: AuthCtx, stageId: string): Promise<CompleteResult> {
  await withTenant(auth.orgId, async (tx) => {
    const [stage] = await tx`select 1 from stages where id = ${stageId}`;
    if (!stage) throw new HttpError(404, "stage not found");
  });
  return completeStageIfReady(auth.orgId, stageId);
}

export interface StandingsOut {
  stage_id: string;
  pool_id: string | null;
  rows: unknown[];
  computed_through_seq: number;
  updated_at: string | null;
}

/** Standings snapshot for a stage (recomputed on demand when absent). */
export async function getStandings(auth: AuthCtx, stageId: string, poolId?: string): Promise<StandingsOut> {
  const snapshot = await withTenant(auth.orgId, async (tx) => {
    const [stage] = await tx`select 1 from stages where id = ${stageId}`;
    if (!stage) throw new HttpError(404, "stage not found");
    const [snap] = await tx<StandingsOut[]>`
      select stage_id, pool_id, rows, computed_through_seq, updated_at
      from standings_snapshots
      where stage_id = ${stageId} and pool_id is not distinct from ${poolId ?? null}`;
    return snap ?? null;
  });
  if (snapshot) return snapshot;
  const rows = await recomputeStandings(auth.orgId, stageId, poolId);
  return {
    stage_id: stageId,
    pool_id: poolId ?? null,
    rows: rows as unknown[],
    computed_through_seq: 0,
    updated_at: null,
  };
}
