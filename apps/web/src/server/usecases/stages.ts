import "server-only";
// Stage use-cases (doc 08 §3): define the stage graph, generate fixtures
// (idempotent — regeneration diffs against what exists, keyed by the pure
// generator's stable ids), guarded completion, standings reads.
import type postgres from "postgres";
import { withTenant } from "@/lib/db";
import { fireDivisionRevalidate } from "@/server/public-site/revalidate";
import { HttpError, PaymentRequiredError } from "@/lib/errors";
import { requireFeature, withinLimit } from "@/lib/entitlements";
import { assertCompetitionNotFrozen } from "./entitlement-freeze";
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
  validateFeedGraph,
  generateAmericano,
  pairMexicanoRound,
  type AmericanoRound,
} from "@seazn/engine/scheduling";
import {
  PointsRule,
  carryDeltas,
  resolveQualification,
  validatePointsRule,
  type QualificationSpec,
  type StandingsRow,
} from "@seazn/engine/competition";
import { completeStageIfReady, recomputeStandings, type CompleteResult } from "@/server/engine-db";
import { resolveModule } from "@/server/engine-db";
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
  "officials", "status", "outcome", "schedule_source", "schedule_locked", "created_at",
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
  schedule_source: "none" | "auto" | "manual";
  schedule_locked: boolean;
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
  // Doc 10 §1: `formats.double_elim` is Pro — gate before any insert.
  if (inputs.some((s) => s.kind === "double_elim")) {
    await requireFeature(auth.orgId, "formats.double_elim");
  }
  // Jul3/08 §8: new kinds + custom byes + cross-stage feeds + placements are
  // the advanced-formats Pro layer; basic RR/KO/group+KO stays Community.
  const advanced = inputs.some((s) => {
    const cfg = s.config as {
      byes?: unknown; cross_feeds?: unknown; placements?: unknown;
    } | undefined;
    return (
      s.kind === "americano" || s.kind === "ladder" ||
      cfg?.byes !== undefined || cfg?.cross_feeds !== undefined ||
      cfg?.placements !== undefined
    );
  });
  if (advanced) await requireFeature(auth.orgId, "formats.advanced");
  // Jul3/08 §9: the cross-stage feed graph must be a DAG (fail closed).
  {
    const edges: { from: string; to: string }[] = [];
    for (const s of inputs) {
      const feeds = (s.config as { cross_feeds?: { to_stage_seq: number }[] } | undefined)
        ?.cross_feeds;
      for (const f of feeds ?? []) {
        edges.push({ from: String(s.seq), to: String(f.to_stage_seq) });
      }
      if (s.qualification !== undefined && s.qualification !== null) {
        // qualification always flows from an earlier stage
        edges.push({ from: String(s.seq - 1), to: String(s.seq) });
      }
    }
    validateFeedGraph(edges);
  }
  // Jul3/05 §7: base win/draw/loss numbers are free; bonuses + forfeit points
  // + circular-H2H + carry-over are the Pro layer.
  for (const s of inputs) {
    const cfg = s.config as { points?: unknown; h2h_scope?: string } | undefined;
    if (cfg?.points !== undefined) {
      const rule = PointsRule.parse(cfg.points);
      if (rule.bonuses.length > 0 || rule.forfeit !== undefined) {
        await requireFeature(auth.orgId, "standings.custom_points");
      }
    }
    if (cfg?.h2h_scope === "overall") {
      await requireFeature(auth.orgId, "tiebreakers.custom");
    }
    const q = s.qualification as { carry?: string } | null | undefined;
    if (q?.carry !== undefined && q.carry !== "none") {
      await requireFeature(auth.orgId, "standings.carry_over");
    }
  }
  return withTenant(auth.orgId, async (tx) => {
    const [division] = await tx<{ competition_id: string; sport_key: string; module_version: string }[]>`
      select competition_id, sport_key, module_version from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    // fail closed (Jul3/05 §8): a points rule needing metrics the sport
    // doesn't emit never reaches play
    for (const s of inputs) {
      const cfg = s.config as { points?: unknown } | undefined;
      if (cfg?.points !== undefined) {
        const sportModule = resolveModule(division.sport_key, division.module_version);
        validatePointsRule(PointsRule.parse(cfg.points), sportModule.metrics);
      }
    }
    await assertCompetitionNotFrozen(auth.orgId, division.competition_id, tx);

    // Doc 10 §1: `stages.per_division.max` (2/4/∞) — the batch must fit,
    // counted in the same tx as the inserts (doc 10 §2 rule 1).
    const [{ n }] = await tx<{ n: number }[]>`
      select count(*)::int as n from stages where division_id = ${divisionId}`;
    const quota = await withinLimit(auth.orgId, "stages.per_division.max", n + inputs.length);
    if (!quota.ok) throw new PaymentRequiredError("stages.per_division.max");

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
    // Adding a stage to a completed division (e.g. finals after the league
    // wrapped the graph) reopens it — 'completed' must mean "nothing left".
    await tx`
      update divisions set status = 'active'
      where id = ${divisionId} and status = 'completed'`;
    return rows;
  });
}

/**
 * Delete a stage (organiser added it by mistake). Only the last stage of the
 * graph is deletable — removing a middle stage would orphan the qualification
 * chain — and never one with played fixtures (in_play / decided / finalized).
 * Bye/walkover awards ('forfeited') don't block: every fresh knockout with a
 * non-power-of-two field holds them. Pools, fixtures, snapshots go via
 * ON DELETE CASCADE.
 */
export async function deleteStage(auth: AuthCtx, stageId: string): Promise<{ deleted: true }> {
  const divisionId = await withTenant(auth.orgId, async (tx) => {
    const [stage] = await tx<
      { id: string; division_id: string; seq: number; kind: string; name: string; competition_id: string }[]
    >`
      select s.id, s.division_id, s.seq, s.kind, s.name, d.competition_id
      from stages s join divisions d on d.id = s.division_id
      where s.id = ${stageId}`;
    if (!stage) throw new HttpError(404, "stage not found");
    await assertCompetitionNotFrozen(auth.orgId, stage.competition_id, tx);
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + stage.division_id}))`;

    const [later] = await tx`
      select 1 from stages where division_id = ${stage.division_id} and seq > ${stage.seq} limit 1`;
    if (later) {
      throw new HttpError(409, "only the last stage can be deleted — remove later stages first");
    }
    const [played] = await tx`
      select 1 from fixtures
      where stage_id = ${stageId} and status in ('in_play', 'decided', 'finalized') limit 1`;
    if (played) {
      throw new HttpError(409, "stage has played fixtures and cannot be deleted");
    }

    await tx`delete from stages where id = ${stageId}`;

    // Structural ledger + division watermark (same pattern as stage_seeded).
    const [{ seq: last }] = await tx<{ seq: number }[]>`
      select coalesce(max(seq), 0)::int as seq from division_events
      where division_id = ${stage.division_id}`;
    await tx`
      insert into division_events (division_id, seq, type, payload)
      values (${stage.division_id}, ${last + 1}, 'stage_deleted',
              ${tx.json({ stageId, kind: stage.kind, name: stage.name, seq: stage.seq } as never)})`;
    await tx`update divisions set seq = ${last + 1} where id = ${stage.division_id}`;

    return { divisionId: stage.division_id, competitionId: stage.competition_id };
  });
  fireDivisionRevalidate(divisionId.divisionId, divisionId.competitionId);
  return { deleted: true };
}

// ---------------------------------------------------------------------------
// Fixture generation (doc 08 §3 — idempotent, returns diff)
// ---------------------------------------------------------------------------

// A generator fixture normalised for persistence, identity = ext_key (the pure
// generator's stable id, spec 05 §6 — regeneration is byte-identical).
// ---------------------------------------------------------------------------
// Americano / Mexicano (Jul3/08 §3, 21 May): individuals rotate partners; the
// stage creates `pair` entrants on the fly for each fixture. Americano is a
// fixed seeded rotation generated upfront; mexicano derives each next round
// from the current per-person points (rank-quartet pairing).
// ---------------------------------------------------------------------------

async function pairEntrantFor(
  tx: Tx,
  divisionId: string,
  people: [string, string],
): Promise<string> {
  const sorted = [...people].sort();
  const [hit] = await tx<{ id: string }[]>`
    select e.id from entrants e
    where e.division_id = ${divisionId} and e.kind = 'pair'
      and (select array_agg(em.person_id order by em.person_id)
           from entrant_members em where em.entrant_id = e.id) = ${sorted}::uuid[]`;
  if (hit) return hit.id;
  const names = await tx<{ id: string; full_name: string }[]>`
    select id, full_name from persons where id in ${tx(sorted)}`;
  const label = sorted
    .map((id) => names.find((n) => n.id === id)?.full_name ?? id)
    .join(" / ");
  const [row] = await tx<{ id: string }[]>`
    insert into entrants (division_id, kind, display_name)
    values (${divisionId}, 'pair', ${label}) returning id`;
  for (const personId of sorted) {
    await tx`insert into entrant_members (entrant_id, person_id, is_captain)
             values (${row!.id}, ${personId}, false)`;
  }
  return row!.id;
}

async function americanoGen(
  tx: Tx,
  divisionId: string,
  stageId: string,
  cfg: Record<string, unknown>,
  entrants: ActiveEntrant[],
): Promise<GenFixture[]> {
  // players = the PERSONS behind the individual entrants
  const entrantIds = entrants.map((e) => e.id);
  if (entrantIds.length === 0) return [];
  const memberRows = await tx<{ entrant_id: string; person_id: string }[]>`
    select entrant_id, person_id from entrant_members
    where entrant_id in ${tx(entrantIds)}`;
  const personOf = new Map(memberRows.map((r) => [r.entrant_id, r.person_id]));
  const players = entrantIds
    .map((id) => personOf.get(id))
    .filter((p): p is string => p !== undefined);
  if (players.length < 4) {
    throw new EngineError("STAGE_NOT_READY", "americano needs at least 4 individual players with linked persons", {
      players: players.length,
    });
  }
  const mode = cfg.mode === "mexicano" ? "mexicano" : "americano";
  const courtCount =
    typeof cfg.courtCount === "number" ? cfg.courtCount : Math.max(1, Math.floor(players.length / 4));
  const rounds = typeof cfg.rounds === "number" ? cfg.rounds : Math.max(3, players.length - 1);

  let planned: AmericanoRound[];
  if (mode === "americano") {
    planned = generateAmericano(players, { mode, courtCount, rounds });
  } else {
    // mexicano: next round only once every prior fixture decided
    const existing = await tx<{ round_no: number; status: string }[]>`
      select round_no, status from fixtures where stage_id = ${stageId}`;
    const playedRounds = existing.length > 0 ? Math.max(...existing.map((f) => f.round_no)) : 0;
    if (existing.some((f) => f.status !== "decided")) return []; // wait
    if (playedRounds >= rounds) return [];
    // per-person points: sum of each player's pair score across decided games
    const scores = await tx<{ person_id: string; pts: number }[]>`
      select em.person_id, coalesce(sum(
        case when f.home_entrant_id = em.entrant_id
             then (m.state->'score'->>'home')::numeric
             else (m.state->'score'->>'away')::numeric end), 0) as pts
      from fixtures f
      join match_states m on m.fixture_id = f.id
      join entrant_members em on em.entrant_id in (f.home_entrant_id, f.away_entrant_id)
      where f.stage_id = ${stageId} and f.status = 'decided'
      group by em.person_id`;
    const pts = new Map(scores.map((r) => [r.person_id, Number(r.pts)]));
    planned = [
      pairMexicanoRound(
        players.map((p) => ({ playerId: p, points: pts.get(p) ?? 0 })),
        { courtCount },
        playedRounds + 1,
      ),
    ];
  }

  const gen: GenFixture[] = [];
  for (const round of planned) {
    for (const m of round.matches) {
      const home = await pairEntrantFor(tx, divisionId, m.team1);
      const away = await pairEntrantFor(tx, divisionId, m.team2);
      gen.push({
        extKey: m.id,
        roundNo: m.roundNo,
        seqInRound: m.court,
        home,
        away,
      });
    }
  }
  return gen;
}

interface GenFixture {
  extKey: string;
  roundNo: number;
  seqInRound: number;
  home: string | null;
  away: string | null;
  homeFrom?: { extKey: string; side: "winner" | "loser" };
  awayFrom?: { extKey: string; side: "winner" | "loser" };
  award?: string; // bye: auto-advancing entrant
  poolId?: string; // group stages: which pool this fixture belongs to
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

// Distribute seed-ordered entrants into `count` pools by seeded snake
// (doc 05 §1: assignment seeded_snake) — 1..N, then N..1, repeating.
export function snakeDistribute<T>(ordered: readonly T[], count: number): T[][] {
  const pools: T[][] = Array.from({ length: count }, () => []);
  for (const [i, entrant] of ordered.entries()) {
    const lap = Math.floor(i / count);
    const pos = i % count;
    const pool = lap % 2 === 0 ? pos : count - 1 - pos;
    pools[pool].push(entrant);
  }
  return pools;
}

const POOL_KEYS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function poolCount(cfg: Record<string, unknown>): number {
  const pools = cfg.pools as { count?: unknown } | undefined;
  const count = typeof pools?.count === "number" ? pools.count : 1;
  if (!Number.isInteger(count) || count < 1 || count > POOL_KEYS.length) {
    throw new EngineError("CONFIG_INVALID", `invalid pool count ${String(count)}`, { count });
  }
  return count;
}

function roundRobinGen(
  entrants: ActiveEntrant[],
  legs: number,
  extPrefix = "",
  poolId?: string,
): GenFixture[] {
  const ids = entrants.map((e) => e.id);
  const seeds = new Map(entrants.filter((e) => e.seed != null).map((e) => [e.id, e.seed as number]));
  const schedule = generateRoundRobin({ entrants: ids, seeds, config: { legs } });
  return schedule.fixtures.map((f) => ({
    extKey: extPrefix + f.id,
    roundNo: f.roundNo,
    seqInRound: f.court,
    home: f.home,
    away: f.away,
    ...(poolId ? { poolId } : {}),
  }));
}

function generate(
  kind: string,
  cfg: Record<string, unknown>,
  entrants: ActiveEntrant[],
  poolIds: Map<string, string>, // pool key ('A'…) → pools.id
): GenFixture[] {
  const ids = entrants.map((e) => e.id);
  const seeds = new Map(entrants.filter((e) => e.seed != null).map((e) => [e.id, e.seed as number]));
  switch (kind) {
    case "league":
    case "group": {
      // Jul3/08 §2: legs > 2 allowed (triple/quad RR), capped at 8
      const rawLegs = typeof cfg.legs === "number" ? Math.trunc(cfg.legs) : 1;
      const legs = Math.min(Math.max(rawLegs, 1), 8);
      const count = kind === "group" ? poolCount(cfg) : 1;
      if (count === 1) return roundRobinGen(entrants, legs);
      // Seeded-snake pools, each playing its own round robin (doc 05 §1).
      const ordered = [...entrants].sort(
        (a, b) => (a.seed ?? Number.MAX_SAFE_INTEGER) - (b.seed ?? Number.MAX_SAFE_INTEGER),
      );
      return snakeDistribute(ordered, count).flatMap((poolEntrants, i) => {
        const key = POOL_KEYS[i];
        return roundRobinGen(poolEntrants, legs, `p${key}-`, poolIds.get(key));
      });
    }
    case "knockout": {
      const bracket = generateSingleElim({
        entrants: ids,
        seeds,
        thirdPlace: cfg.thirdPlace === true,
        // Jul3/08 §4 (7 Jan): organiser-chosen bye recipients
        ...(Array.isArray(cfg.byes) ? { byeEntrants: cfg.byes as string[] } : {}),
      });
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
// Fixture-shape changes (generation, stage completion) must refresh the public
// dashboard's ISR pages just like scoring writes do (doc 09 §3).
async function fireStageRevalidate(orgId: string, stageId: string): Promise<void> {
  const row = await withTenant(orgId, async (tx) => {
    const [r] = await tx<{ division_id: string; competition_id: string }[]>`
      select s.division_id, d.competition_id
      from stages s join divisions d on d.id = s.division_id
      where s.id = ${stageId}`;
    return r ?? null;
  });
  if (row) fireDivisionRevalidate(row.division_id, row.competition_id);
}

export async function generateStageFixtures(auth: AuthCtx, stageId: string): Promise<GenerateOutcome> {
  // A qualification stage must draw from the previous stage's final table
  // (config.qualified), never from the whole entrant list. If it isn't seeded
  // yet: seed it now when the previous stage is complete (stage added after
  // the fact), otherwise refuse — generating early would bracket everyone.
  {
    const pre = await withTenant(auth.orgId, async (tx) => {
      const [stage] = await tx<StageRow[]>`
        select ${tx(STAGE_COLS)} from stages where id = ${stageId}`;
      if (!stage) throw new HttpError(404, "stage not found");
      if (!stage.qualification || Array.isArray(stage.config.qualified)) return null;
      const [prev] = await tx<{ id: string; status: string }[]>`
        select id, status from stages
        where division_id = ${stage.division_id} and seq < ${stage.seq}
        order by seq desc limit 1`;
      return prev ?? null;
    });
    if (pre) {
      if (pre.status !== "complete") {
        throw new EngineError(
          "STAGE_NOT_READY",
          "this stage draws its entrants from the previous stage's final table — complete the previous stage first",
          { stageId, previousStageId: pre.id },
        );
      }
      await seedNextStage(auth, pre.id);
    }
  }
  const outcome = await withTenant(auth.orgId, async (tx) => {
    const [stage] = await tx<StageRow[]>`
      select ${tx(STAGE_COLS)} from stages where id = ${stageId}`;
    if (!stage) throw new HttpError(404, "stage not found");
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + stage.division_id}))`;

    const active = await tx<ActiveEntrant[]>`
      select id, seed from entrants
      where division_id = ${stage.division_id} and status in ('registered', 'confirmed')
      order by seed nulls last, created_at, id`;

    // A seeded stage (qualification resolved at the previous stage's completion,
    // stored as config.qualified) draws from that ordered list — its order IS
    // the seeding. Otherwise: every active division entrant.
    const qualified = Array.isArray(stage.config.qualified)
      ? (stage.config.qualified as string[])
      : null;
    let entrants: ActiveEntrant[];
    if (qualified) {
      const activeIds = new Set(active.map((e) => e.id));
      entrants = qualified
        .filter((id) => activeIds.has(id))
        .map((id, i) => ({ id, seed: i + 1 }));
    } else {
      entrants = active;
    }
    if (entrants.length < 2) {
      throw new EngineError("STAGE_NOT_READY", "need at least 2 active entrants to generate", {
        stageId,
        entrants: entrants.length,
      });
    }

    // Group stages with pools: materialise the pools rows first (idempotent),
    // so generated fixtures can reference them.
    const poolIds = new Map<string, string>();
    if (stage.kind === "group" && poolCount(stage.config) > 1) {
      const existing = await tx<{ id: string; key: string }[]>`
        select id, key from pools where stage_id = ${stageId}`;
      for (const pool of existing) poolIds.set(pool.key, pool.id);
      for (let i = 0; i < poolCount(stage.config); i++) {
        const key = POOL_KEYS[i];
        if (poolIds.has(key)) continue;
        const [row] = await tx<{ id: string }[]>`
          insert into pools (stage_id, key, name)
          values (${stageId}, ${key}, ${"Pool " + key}) returning id`;
        poolIds.set(key, row.id);
      }
    }

    const existing = await tx<
      { id: string; ext_key: string | null; round_no: number; status: string; home_entrant_id: string | null; away_entrant_id: string | null; outcome: unknown }[]
    >`
      select id, ext_key, round_no, status, home_entrant_id, away_entrant_id, outcome
      from fixtures where stage_id = ${stageId}`;

    const gen =
      stage.kind === "swiss"
        ? await swissGen(tx, stageId, stage.config, entrants, existing)
        : stage.kind === "americano"
          ? await americanoGen(tx, stage.division_id, stageId, stage.config, entrants)
          : stage.kind === "ladder"
            ? [] // Jul3/08 §6: ladder fixtures come from challenges, on demand
            : generate(stage.kind, stage.config, entrants, poolIds);

    const byKey = new Map<string, string>(); // ext_key → fixture uuid
    for (const f of existing) if (f.ext_key) byKey.set(f.ext_key, f.id);

    let created = 0;
    const createdIds: string[] = [];
    for (const g of gen) {
      if (byKey.has(g.extKey)) continue;
      const award = g.award !== undefined;
      const [row] = await tx<{ id: string }[]>`
        insert into fixtures (stage_id, division_id, pool_id, round_no, seq_in_round,
                              home_entrant_id, away_entrant_id, ext_key, status, outcome)
        values (${stageId}, ${stage.division_id}, ${g.poolId ?? null}, ${g.roundNo}, ${g.seqInRound},
                ${g.home}, ${g.away}, ${g.extKey},
                ${award ? "forfeited" : "scheduled"},
                ${award ? tx.json({ kind: "award", winner: g.award } as never) : null})
        returning id`;
      byKey.set(g.extKey, row.id);
      createdIds.push(row.id);
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
    // Cross-format feeds (Jul3/08 §4): winner_to/loser_to may target another
    // stage (CL loser → EL slot). Wire every entry whose source and target
    // both exist; the per-decided-fixture fillSlot then follows them like any
    // other feed.
    await wireCrossFeeds(tx, stage.division_id);

    // Undoable generation (Jul3/03 §3): the ledger records which fixtures this
    // pass created so undo can remove exactly them (results-guarded).
    if (created > 0) {
      const [{ seq: last }] = await tx<{ seq: number }[]>`
        select coalesce(max(seq), 0)::int as seq from division_events
        where division_id = ${stage.division_id}`;
      await tx`
        insert into division_events (division_id, seq, type, payload)
        values (${stage.division_id}, ${last + 1}, 'fixtures_generated',
                ${tx.json({ stage_id: stageId, fixture_ids: createdIds } as never)})`;
      await tx`update divisions set seq = ${last + 1}, edit_watermark = null
               where id = ${stage.division_id}`;
    }
    return { created, existing: gen.length - created, fixtures };
  });
  void fireStageRevalidate(auth.orgId, stageId);
  return outcome;
}

interface CrossFeed {
  from_ext_key: string;
  side: "winner" | "loser";
  to_stage_seq: number;
  to_ext_key: string;
  slot: 1 | 2;
}

async function wireCrossFeeds(tx: Tx, divisionId: string): Promise<void> {
  const stages = await tx<{ id: string; seq: number; config: Record<string, unknown> }[]>`
    select id, seq, config from stages where division_id = ${divisionId}`;
  const bySeq = new Map(stages.map((s) => [s.seq, s]));
  for (const stage of stages) {
    const feeds = stage.config.cross_feeds as CrossFeed[] | undefined;
    if (!Array.isArray(feeds)) continue;
    for (const feed of feeds) {
      const target = bySeq.get(feed.to_stage_seq);
      if (!target) continue;
      const [source] = await tx<{ id: string }[]>`
        select id from fixtures where stage_id = ${stage.id} and ext_key = ${feed.from_ext_key}`;
      const [dest] = await tx<{ id: string }[]>`
        select id from fixtures where stage_id = ${target.id} and ext_key = ${feed.to_ext_key}`;
      if (!source || !dest) continue; // wired once both stages generated
      if (feed.side === "winner") {
        await tx`update fixtures set winner_to_fixture = ${dest.id}, winner_to_slot = ${feed.slot}
                 where id = ${source.id} and winner_to_fixture is null`;
      } else {
        await tx`update fixtures set loser_to_fixture = ${dest.id}, loser_to_slot = ${feed.slot}
                 where id = ${source.id} and loser_to_fixture is null`;
      }
    }
  }
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

const TABLE_KINDS = new Set(["league", "group", "swiss", "americano"]);

export interface SeededStage {
  stage_id: string;
  entrants: string[];
}

export interface CompleteStageResult extends CompleteResult {
  /** Set when completion resolved the next stage's qualification spec. */
  qualified?: SeededStage;
  /** Fixtures auto-generated for the seeded next stage. */
  next_stage_fixtures?: number;
  /** True when this was the last stage — the division is now completed. */
  division_completed?: boolean;
}

/**
 * Guarded progression (doc 08 §3): no-op unless the completion predicate
 * holds. On completion, if the next stage declares a qualification spec
 * (doc 05 §3), resolve it against this stage's ranked tables into an ordered
 * seed list, snapshotted as the next stage's `config.qualified` — and then
 * generate that stage's fixtures so the bracket appears immediately (the
 * organiser shouldn't have to know a second Generate click is needed).
 * Idempotent: an already-seeded stage is not re-seeded.
 */
export async function completeStage(auth: AuthCtx, stageId: string): Promise<CompleteStageResult> {
  await withTenant(auth.orgId, async (tx) => {
    const [stage] = await tx`select 1 from stages where id = ${stageId}`;
    if (!stage) throw new HttpError(404, "stage not found");
  });
  const result = await completeStageIfReady(auth.orgId, stageId);
  if (!result.completed) return result;
  const qualified = await seedNextStage(auth, stageId);
  void fireStageRevalidate(auth.orgId, stageId);
  if (!qualified) {
    // No stage follows: the division itself is done (doc 02 lifecycle
    // setup → active → completed). Idempotent — re-completing is a no-op.
    const divisionCompleted = await withTenant(auth.orgId, async (tx) => {
      const [stage] = await tx<{ division_id: string }[]>`
        select division_id from stages where id = ${stageId}`;
      if (!stage) return false;
      await tx`select pg_advisory_xact_lock(hashtext(${"division:" + stage.division_id}))`;
      const [remaining] = await tx`
        select 1 from stages
        where division_id = ${stage.division_id} and status <> 'complete' limit 1`;
      if (remaining) return false;
      const [row] = await tx<{ id: string }[]>`
        update divisions set status = 'completed'
        where id = ${stage.division_id} and status <> 'completed'
        returning id`;
      if (!row) return false;
      const [{ seq: last }] = await tx<{ seq: number }[]>`
        select coalesce(max(seq), 0)::int as seq from division_events
        where division_id = ${stage.division_id}`;
      await tx`
        insert into division_events (division_id, seq, type, payload)
        values (${stage.division_id}, ${last + 1}, 'division_completed',
                ${tx.json({ lastStageId: stageId } as never)})`;
      await tx`update divisions set seq = ${last + 1} where id = ${stage.division_id}`;
      return true;
    });
    return divisionCompleted ? { ...result, division_completed: true } : result;
  }
  // Best-effort: completion stands even if generation trips (e.g. paywall).
  let generated: number | undefined;
  try {
    generated = (await generateStageFixtures(auth, qualified.stage_id)).created;
  } catch {
    generated = undefined;
  }
  return { ...result, qualified, ...(generated !== undefined ? { next_stage_fixtures: generated } : {}) };
}

// Resolve the next pending stage's qualification against the completed stage's
// standings snapshots. Pool names in specs are the pools.key letters ('A'…);
// a single-table stage is the unnamed pool '' / `overall`.
async function seedNextStage(auth: AuthCtx, completedStageId: string): Promise<SeededStage | null> {
  return withTenant(auth.orgId, async (tx) => {
    const [current] = await tx<{ division_id: string; seq: number; kind: string }[]>`
      select division_id, seq, kind from stages where id = ${completedStageId}`;
    if (!current) return null;
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + current.division_id}))`;

    const [next] = await tx<StageRow[]>`
      select ${tx(STAGE_COLS)} from stages
      where division_id = ${current.division_id} and seq > ${current.seq}
      order by seq limit 1`;
    if (!next || !next.qualification) return null;
    if (Array.isArray(next.config.qualified)) {
      // Already seeded (idempotent re-complete).
      return { stage_id: next.id, entrants: next.config.qualified as string[] };
    }
    if (!TABLE_KINDS.has(current.kind)) {
      throw new EngineError(
        "STAGE_NOT_READY",
        "qualification from a bracket stage is not supported yet — use a table stage as the source",
        { stageId: completedStageId, kind: current.kind },
      );
    }

    const spec = next.qualification as unknown;
    const isSpec =
      typeof spec === "object" && spec !== null &&
      ("take" in spec || "topN" in spec || "bestOfRank" in spec);
    if (!isSpec) {
      throw new EngineError("CONFIG_INVALID", "unrecognised qualification spec", {
        stageId: next.id,
      });
    }

    // Ranked tables from the completion snapshots; translate pool uuids back
    // to their spec-facing keys.
    const poolRows = await tx<{ id: string; key: string }[]>`
      select id, key from pools where stage_id = ${completedStageId}`;
    const keyOf = new Map(poolRows.map((p) => [p.id, p.key]));
    const snapshots = await tx<{ pool_id: string | null; rows: StandingsRow[] }[]>`
      select pool_id, rows from standings_snapshots where stage_id = ${completedStageId}`;
    if (snapshots.length === 0) {
      throw new EngineError("STAGE_NOT_READY", "completed stage has no standings snapshots", {
        stageId: completedStageId,
      });
    }
    const pools = snapshots.map((s) => ({
      pool: s.pool_id ? (keyOf.get(s.pool_id) ?? s.pool_id) : "",
      rows: s.rows,
    }));
    const overall = pools.find((p) => p.pool === "")?.rows;
    const entrants = resolveQualification(spec as QualificationSpec, {
      pools,
      ...(overall ? { overall } : {}),
    });

    // Carry-over (Jul3/05 §3): seed the next stage with opening deltas from
    // the completed tables — prior points/metrics arrive as data, prior H2H
    // is never replayed.
    const carryMode = (spec as { carry?: "none" | "points" | "full" }).carry ?? "none";
    let carriedDeltas: unknown[] | undefined;
    if (carryMode !== "none") {
      const qualifiedSet = new Set(entrants);
      const sourceRows = pools
        .flatMap((p) => p.rows)
        .filter((r) => qualifiedSet.has(r.entrantId));
      carriedDeltas = carryDeltas(sourceRows, carryMode);
    }
    await tx`
      update stages set config = ${tx.json({
        ...next.config,
        qualified: entrants,
        ...(carriedDeltas !== undefined ? { carry_deltas: carriedDeltas } : {}),
      } as never)}
      where id = ${next.id}`;

    // Structural ledger + division watermark (same pattern as stage_completed).
    const [{ seq: last }] = await tx<{ seq: number }[]>`
      select coalesce(max(seq), 0)::int as seq from division_events
      where division_id = ${current.division_id}`;
    await tx`
      insert into division_events (division_id, seq, type, payload)
      values (${current.division_id}, ${last + 1}, 'stage_seeded',
              ${tx.json({ stageId: next.id, from: completedStageId, entrants } as never)})`;
    let seq = last + 1;
    if (carriedDeltas !== undefined) {
      // auditable carry (Jul3/05 §3)
      await tx`
        insert into division_events (division_id, seq, type, payload)
        values (${current.division_id}, ${seq + 1}, 'standings_carried',
                ${tx.json({ stageId: next.id, from: completedStageId, mode: carryMode, entrants } as never)})`;
      seq += 1;
    }
    await tx`update divisions set seq = ${seq} where id = ${current.division_id}`;

    return { stage_id: next.id, entrants };
  });
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

// ---------------------------------------------------------------------------
// Manual rank override (Jul3/05 §4) — placement games decide final positions
// without faking points. Stored on stages.config.rank_overrides; the fold's
// rank pass pins them (applyRankLocks) on every recompute.
// ---------------------------------------------------------------------------

export async function overrideStandings(
  auth: AuthCtx,
  stageId: string,
  input: { rows: { entrant_id: string; rank: number; reason: string }[] },
): Promise<{ overridden: number }> {
  await requireFeature(auth.orgId, "tiebreakers.custom");
  const out = await withTenant(auth.orgId, async (tx) => {
    const [stage] = await tx<{ division_id: string; config: Record<string, unknown> }[]>`
      select division_id, config from stages where id = ${stageId}`;
    if (!stage) throw new HttpError(404, "stage not found");
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + stage.division_id}))`;
    const ids = input.rows.map((r) => r.entrant_id);
    const known = await tx<{ id: string }[]>`
      select id from entrants where id in ${tx(ids)} and division_id = ${stage.division_id}`;
    if (known.length !== ids.length) {
      throw new HttpError(422, "override references an entrant outside this division");
    }
    const ranks = new Set(input.rows.map((r) => r.rank));
    if (ranks.size !== input.rows.length) throw new HttpError(422, "duplicate ranks in override");

    await tx`
      update stages set config = ${tx.json({
        ...stage.config,
        rank_overrides: input.rows.map((r) => ({ entrant_id: r.entrant_id, rank: r.rank })),
      } as never)}
      where id = ${stageId}`;

    // audit (actor + reason, hash-chained per the 011 pattern)
    const [{ seq: last }] = await tx<{ seq: number }[]>`
      select coalesce(max(seq), 0)::int as seq from division_events
      where division_id = ${stage.division_id}`;
    await tx`
      insert into division_events (division_id, seq, type, payload, actor_id)
      values (${stage.division_id}, ${last + 1}, 'rank_overridden',
              ${tx.json({ stage_id: stageId, rows: input.rows } as never)}, ${auth.userId})`;
    await tx`update divisions set seq = ${last + 1} where id = ${stage.division_id}`;
    return { overridden: input.rows.length };
  });
  // pinned ranks land in the snapshots immediately
  await recomputeStandings(auth.orgId, stageId);
  return out;
}

// ---------------------------------------------------------------------------
// Ladder challenges (Jul3/08 §6): no pre-generated fixtures — players issue
// challenges within range; the result reorders the ladder (scoring hook).
// ---------------------------------------------------------------------------

export async function issueChallenge(
  auth: AuthCtx,
  stageId: string,
  input: { challenger_id: string; opponent_id: string },
): Promise<{ fixture_id: string; ladder_order: string[] }> {
  await requireFeature(auth.orgId, "formats.advanced");
  return withTenant(auth.orgId, async (tx) => {
    const [stage] = await tx<{ division_id: string; kind: string; config: Record<string, unknown> }[]>`
      select division_id, kind, config from stages where id = ${stageId}`;
    if (!stage) throw new HttpError(404, "stage not found");
    if (stage.kind !== "ladder") throw new HttpError(422, "challenges only exist on ladder stages");
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + stage.division_id}))`;

    // ladder order initialises from seed order on first use
    let order = stage.config.ladder_order as string[] | undefined;
    if (!Array.isArray(order) || order.length === 0) {
      const entrants = await tx<{ id: string }[]>`
        select id from entrants
        where division_id = ${stage.division_id} and status in ('registered','confirmed')
        order by seed nulls last, created_at, id`;
      order = entrants.map((e) => e.id);
      await tx`update stages set config = ${tx.json({ ...stage.config, ladder_order: order } as never)}
               where id = ${stageId}`;
    }
    const ci = order.indexOf(input.challenger_id);
    const oi = order.indexOf(input.opponent_id);
    if (ci < 0 || oi < 0) throw new HttpError(422, "both players must be on the ladder");
    if (oi >= ci) throw new HttpError(422, "you can only challenge upward");
    const range = typeof stage.config.challengeRange === "number" ? stage.config.challengeRange : 3;
    if (ci - oi > range) {
      throw new HttpError(422, `challenges reach at most ${range} places up the ladder`);
    }
    const [{ n }] = await tx<{ n: number }[]>`
      select count(*)::int as n from fixtures where stage_id = ${stageId}`;
    const [fixture] = await tx<{ id: string }[]>`
      insert into fixtures (stage_id, division_id, round_no, seq_in_round,
                            home_entrant_id, away_entrant_id, ext_key, status)
      values (${stageId}, ${stage.division_id}, ${n + 1}, 1,
              ${input.challenger_id}, ${input.opponent_id}, ${"ch-" + String(n + 1)}, 'scheduled')
      returning id`;
    if (stage.config.ladder_order === undefined) stage.config.ladder_order = order;
    return { fixture_id: fixture!.id, ladder_order: order };
  });
}
