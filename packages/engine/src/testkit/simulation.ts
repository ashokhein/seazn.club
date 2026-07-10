// Tournament & property-simulation harness — PROMPT-14, spec 03 §6, spec 04
// §9, spec 05 §6. Simulates a FULL division for any sport module × any
// stage-graph template: generate fixtures, drive every match with the module's
// arbitraryEvent stream, progress stages through qualification, and check the
// global invariants (assertDivisionInvariants). Everything derives from one
// 32-bit seed, so `sport:format:seed` reproduces a run exactly (sim:replay).
import {
  completeBracketStage,
  completeTableStage,
  isBracketStageComplete,
  isTableStageComplete,
  openStage,
  type BracketFixture,
  type BracketStage,
  type DivisionEvent,
  type TableFixture,
  type TableStage,
} from "../competition/stage.ts";
import {
  qualificationSize,
  resolveQualification,
  type QualificationSpec,
  type StageTables,
} from "../competition/qualification.ts";
import type { FixtureResult } from "../competition/standings.ts";
import { EngineError } from "../core/errors.ts";
import { foldMatch, type EventEnvelope } from "../core/events.ts";
import { mulberry32, type Rng } from "../core/rng.ts";
import type { EntrantId, LineupPair, MatchOutcome, StageCtx, StageKind } from "../core/types.ts";
import {
  generateDoubleElim,
  generateSingleElim,
  generateStepladder,
  type BracketFixtureGen,
  type BracketSlotRef,
} from "../scheduling/bracket.ts";
import { generateRoundRobin, roundRobinFixtureCount } from "../scheduling/roundrobin.ts";
import {
  pairKey,
  pairRound,
  type Colour,
  type SwissStanding,
} from "../scheduling/swiss.ts";
import type { AnySportModule, ModuleEvent, TiebreakerKey } from "../sport/module.ts";
import { lineupFromCatalog, TEST_INSTANT } from "./helpers.ts";

// ---------------------------------------------------------------------------
// Templates & options
// ---------------------------------------------------------------------------

// The stage-graph templates the harness exercises (PROMPT-14 §1; v3/09 §3
// added league_legs2 — the Jul3/08 §2 multi-leg round robin).
export const FORMAT_TEMPLATES = [
  "league",
  "league_legs2",
  "group_knockout",
  "swiss_knockout",
  "double_elim",
  "stepladder",
] as const;
export type FormatTemplate = (typeof FORMAT_TEMPLATES)[number];

// Per-sport simulation configs. Most modules default-parse ({}); generic has
// no defaults (v1 semantics are explicit), cricket is shortened to 5-over
// innings so ball-by-ball streams stay affordable at CI run counts.
export const SIM_CONFIGS: Record<string, unknown> = {
  generic: {
    resultMode: "score",
    allowDraws: true,
    points: { w: 3, d: 1, l: 0 },
    progressScore: false,
  },
  cricket: { ballsPerInnings: 30 },
};

export interface SimOptions {
  module: AnySportModule;
  cfg?: unknown; // raw config, parsed through module.configSchema (default {})
  format: FormatTemplate;
  seed: number; // master seed — determines entrant count, streams, injection
  entrantCount?: number; // override the seed-derived count (2–64)
  maxEventsPerFixture?: number; // stream budget per attempt (default 600)
  injectVoid?: boolean; // mid-tournament random void injection (PROMPT-14 §1)
}

export interface SimFixtureRecord {
  id: string;
  stageId: string;
  poolId?: string;
  roundNo?: number;
  home?: EntrantId;
  away?: EntrantId;
  status: "decided" | "walkover" | "void";
  events: EventEnvelope[]; // empty for walkover/void (structural decisions)
  outcome: MatchOutcome | null;
  result?: FixtureResult; // table stages: the [home, away] standings deltas
  winner?: EntrantId;
  loser?: EntrantId;
  isFinal?: boolean;
  round?: number; // bracket stages
}

export interface SimStageRecord {
  id: string;
  kind: StageKind;
  entrants: EntrantId[];
  fixtures: SimFixtureRecord[];
  tables?: StageTables;
  cascade?: TiebreakerKey[]; // table stages: the ranking cascade applied
  legs?: number; // round robins: pairings repeat exactly this often (Jul3/08 §2)
  finalRanks: EntrantId[];
  qualification?: { spec: QualificationSpec; seeds: EntrantId[] }; // feed to the next stage
}

export interface SimInjectionRecord {
  fixtureId: string;
  voidedEventId: string;
  applied: boolean; // false = the refold rejected the void; ledger unchanged
  rejectedCode?: string; // EngineError code when rejected
  outcomeChanged: boolean;
}

export interface SimulationResult {
  seedToken: string; // `${sport}:${format}:${seed}` — sim:replay input
  sport: string;
  format: FormatTemplate;
  seed: number;
  entrants: EntrantId[];
  stages: SimStageRecord[];
  divisionEvents: DivisionEvent[];
  champion: EntrantId;
  finalRanks: EntrantId[];
  injection?: SimInjectionRecord;
}

// An invariant violation — carries enough context for the failure artifact.
export class SimInvariantError extends Error {
  readonly detail?: unknown;
  constructor(message: string, detail?: unknown) {
    super(message);
    this.name = "SimInvariantError";
    this.detail = detail;
  }
}

export function makeSeedToken(sport: string, format: FormatTemplate, seed: number): string {
  return `${sport}:${format}:${seed}`;
}

// The canonical options for a seed token — the CI suite and sim:replay MUST
// build runs through this so a token reproduces the exact division (including
// the every-4th-seed void injection).
export function simOptionsFor(
  module: AnySportModule,
  format: FormatTemplate,
  seed: number,
): SimOptions {
  const cfg = SIM_CONFIGS[module.key];
  return {
    module,
    ...(cfg === undefined ? {} : { cfg }),
    format,
    seed,
    injectVoid: seed % 4 === 0,
  };
}

export function parseSeedToken(token: string): { sport: string; format: FormatTemplate; seed: number } {
  const parts = token.split(":");
  if (parts.length !== 3) throw new Error(`bad seed token "${token}" (want sport:format:seed)`);
  const [sport, format, seedStr] = parts as [string, string, string];
  if (!(FORMAT_TEMPLATES as readonly string[]).includes(format)) {
    throw new Error(`bad seed token "${token}": unknown format "${format}"`);
  }
  const seed = Number(seedStr);
  if (!Number.isInteger(seed)) throw new Error(`bad seed token "${token}": seed not an integer`);
  return { sport, format: format as FormatTemplate, seed };
}

// ---------------------------------------------------------------------------
// Seed derivation — one master seed fans out to per-purpose streams via FNV-1a.
// ---------------------------------------------------------------------------

export function deriveSeed(seed: number, ...parts: readonly (string | number)[]): number {
  let hash = (seed >>> 0) ^ 0x811c9dc5;
  for (const part of parts) {
    const text = String(part);
    for (let i = 0; i < text.length; i++) {
      hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
    }
    hash = Math.imul(hash ^ 0x1f, 0x01000193) >>> 0; // part separator
  }
  return hash >>> 0;
}

// Entrant count 2–64 (PROMPT-14 §1), skewed small so O(n²) round robins stay
// affordable at CI run counts while the tail still reaches 64.
export function drawEntrantCount(seed: number): number {
  const rng = mulberry32(deriveSeed(seed, "entrants"));
  return Math.min(64, 2 + Math.floor(rng() * rng() * 63));
}

const SWISS_ONLY_KEYS: ReadonlySet<TiebreakerKey> = new Set([
  "buchholz",
  "buchholz_cut1",
  "sberger",
  "direct",
]);

// The stage cascade: the module's official cascade, minus Swiss-ledger keys
// outside a swiss stage (they need the assembled ledger, spec 05 §4.1).
function stageCascade(module: AnySportModule, swiss: boolean): TiebreakerKey[] {
  return module.defaultTiebreakers.filter((key) => swiss || !SWISS_ONLY_KEYS.has(key));
}

// ---------------------------------------------------------------------------
// Fixture play — walk the module's arbitraryEvent generator to a decision.
// ---------------------------------------------------------------------------

function envelope(
  fixtureId: string,
  seq: number,
  event: ModuleEvent,
  voids?: string,
): EventEnvelope {
  return {
    id: `${fixtureId}-e${seq}`,
    fixtureId,
    seq,
    type: event.type,
    payload: event.payload,
    recordedAt: TEST_INSTANT,
    recordedBy: "sim",
    ...(voids === undefined ? {} : { voids }),
  };
}

interface PlayedMatch {
  events: EventEnvelope[];
  state: unknown;
  outcome: MatchOutcome;
}

const DECISIVE_KINDS: ReadonlySet<MatchOutcome["kind"]> = new Set(["win", "award"]);

// Play one fixture to completion. `decisive` (bracket fixtures) additionally
// requires a win/award — indecisive attempts (draw/tie/no_result, or a stream
// that exhausts its budget) replay from a derived seed, like a real knockout
// replays an abandoned tie. Deterministic: seed ⇒ identical stream.
function playFixture(
  module: AnySportModule,
  cfg: unknown,
  lineups: LineupPair,
  fixtureId: string,
  seed: number,
  opts: { maxEvents: number; decisive: boolean },
): PlayedMatch {
  const generate = module.arbitraryEvent;
  if (!generate) throw new Error(`module "${module.key}" does not implement arbitraryEvent`);

  const MAX_ATTEMPTS = 100;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const rng = mulberry32(deriveSeed(seed, "fixture", fixtureId, attempt));
    let state = module.init(cfg, lineups);
    const events: EventEnvelope[] = [];
    for (let i = 0; i < opts.maxEvents; i++) {
      const next = generate.call(module, state, rng) as ModuleEvent | null;
      if (next === null) break;
      const env = envelope(fixtureId, events.length, next);
      state = module.apply(state, env);
      events.push(env);
    }
    const outcome = module.outcome(state) as MatchOutcome | null;
    if (outcome === null) continue; // budget exhausted undecided — replay
    if (opts.decisive && !DECISIVE_KINDS.has(outcome.kind)) continue; // knockout replay
    return { events, state, outcome };
  }
  throw new SimInvariantError(
    `fixture "${fixtureId}" never reached a ${opts.decisive ? "decisive " : ""}outcome in ${MAX_ATTEMPTS} attempts`,
    { fixtureId, sport: module.key },
  );
}

// ---------------------------------------------------------------------------
// Void injection — PROMPT-14 §1: void a random event mid-tournament, refold.
// ---------------------------------------------------------------------------

// Division-level void guard (spec 05 §3): once a stage has completed — its
// final ranks are locked and may already have seeded the next stage — a void
// that could reopen a fixture is refused. This is the rule the persistence
// adapter enforces; the simulator and its tests assert it here.
export function canVoidFixtureEvent(
  divisionEvents: readonly DivisionEvent[],
  stageId: string,
): { ok: true } | { ok: false; code: "rank_locked" } {
  const completed = divisionEvents.some(
    (event) => event.type === "stage_completed" && event.stageId === stageId,
  );
  return completed ? { ok: false, code: "rank_locked" } : { ok: true };
}

// Void a seeded-random event of a just-played fixture and refold. Three legal
// outcomes, all asserted valid downstream:
//  - the refold throws a typed EngineError (e.g. voiding core.start makes a
//    later event WRONG_PHASE) ⇒ the void is rejected, ledger unchanged;
//  - the refold leaves the match undecided ⇒ the scorer keeps scoring — the
//    generator resumes on the refolded state until a (compatible) decision;
//  - the refolded decision differs ⇒ downstream progression recomputes.
function injectVoidIntoMatch(
  module: AnySportModule,
  cfg: unknown,
  lineups: LineupPair,
  fixtureId: string,
  played: PlayedMatch,
  rng: Rng,
  opts: { maxEvents: number; decisive: boolean },
): { match: PlayedMatch; record: SimInjectionRecord } {
  const target = played.events[Math.floor(rng() * played.events.length)] as EventEnvelope;
  const voidEnv = envelope(fixtureId, played.events.length, { type: "core.void", payload: {} }, target.id);
  const events = [...played.events, voidEnv];

  const rejected = (code: string): { match: PlayedMatch; record: SimInjectionRecord } => ({
    match: played,
    record: {
      fixtureId,
      voidedEventId: target.id,
      applied: false,
      rejectedCode: code,
      outcomeChanged: false,
    },
  });

  let state: unknown;
  try {
    state = foldMatch(module, cfg, lineups, events);
  } catch (err) {
    if (EngineError.is(err)) return rejected(err.code); // typed rejection — ledger stays
    throw err;
  }

  // Refold OK — if the void reopened the match, keep scoring to a decision.
  let outcome = module.outcome(state) as MatchOutcome | null;
  const generate = module.arbitraryEvent as NonNullable<AnySportModule["arbitraryEvent"]>;
  for (let i = events.length; outcome === null && i < events.length + opts.maxEvents; i++) {
    const next = generate.call(module, state, rng) as ModuleEvent | null;
    if (next === null) break;
    const env = envelope(fixtureId, i, next);
    state = module.apply(state, env);
    events.push(env);
    outcome = module.outcome(state) as MatchOutcome | null;
  }
  if (outcome === null || (opts.decisive && !DECISIVE_KINDS.has(outcome.kind))) {
    // Can't complete the reopened match within budget/constraints — a real
    // scorer would re-record; the simulator treats the void as rejected.
    return rejected("SIM_UNDECIDED");
  }

  return {
    match: { events, state, outcome },
    record: {
      fixtureId,
      voidedEventId: target.id,
      applied: true,
      outcomeChanged: JSON.stringify(outcome) !== JSON.stringify(played.outcome),
    },
  };
}

// ---------------------------------------------------------------------------
// The division simulator
// ---------------------------------------------------------------------------

interface SimContext {
  module: AnySportModule;
  cfg: unknown;
  seed: number;
  maxEvents: number;
  lineups: Map<EntrantId, ReturnType<typeof lineupFromCatalog>>;
  divisionEvents: DivisionEvent[];
  // Void injection: fires once, at the `injectAt`-th fixture played.
  injectAt: number; // -1 = no injection
  fixturesPlayed: number;
  injection?: SimInjectionRecord;
}

function lineupPairFor(ctx: SimContext, home: EntrantId, away: EntrantId): LineupPair {
  let homeLineup = ctx.lineups.get(home);
  if (homeLineup === undefined) {
    homeLineup = lineupFromCatalog(ctx.module.positions, home);
    ctx.lineups.set(home, homeLineup);
  }
  let awayLineup = ctx.lineups.get(away);
  if (awayLineup === undefined) {
    awayLineup = lineupFromCatalog(ctx.module.positions, away);
    ctx.lineups.set(away, awayLineup);
  }
  return { home: homeLineup, away: awayLineup };
}

// Play a fixture inside a stage, applying the one-shot void injection when its
// turn comes (only while the stage is still open — the rank_locked guard).
function playInStage(
  ctx: SimContext,
  stageId: string,
  fixtureId: string,
  home: EntrantId,
  away: EntrantId,
  decisive: boolean,
): PlayedMatch {
  const lineups = lineupPairFor(ctx, home, away);
  let match = playFixture(ctx.module, ctx.cfg, lineups, fixtureId, ctx.seed, {
    maxEvents: ctx.maxEvents,
    decisive,
  });

  if (ctx.fixturesPlayed === ctx.injectAt && ctx.injection === undefined) {
    const guard = canVoidFixtureEvent(ctx.divisionEvents, stageId);
    if (guard.ok) {
      const rng = mulberry32(deriveSeed(ctx.seed, "inject", fixtureId));
      const injected = injectVoidIntoMatch(ctx.module, ctx.cfg, lineups, fixtureId, match, rng, {
        maxEvents: ctx.maxEvents,
        decisive,
      });
      match = injected.match;
      ctx.injection = injected.record;
    }
  }
  ctx.fixturesPlayed++;
  return match;
}

// The [home, away] standings deltas of a decided table fixture.
function tableResult(
  ctx: SimContext,
  match: PlayedMatch,
  stageCtx: StageCtx,
): FixtureResult {
  const [home, away] = ctx.module.standingsDelta(match.outcome, ctx.cfg, stageCtx, match.state);
  return [home, away];
}

function toRecord(
  stageId: string,
  fixtureId: string,
  home: EntrantId,
  away: EntrantId,
  match: PlayedMatch,
  extra: Partial<SimFixtureRecord> = {},
): SimFixtureRecord {
  const outcome = match.outcome;
  const winner =
    outcome.kind === "win" || outcome.kind === "award" ? outcome.winner : undefined;
  const loser =
    outcome.kind === "win" ? outcome.loser : outcome.kind === "award" ? (outcome.winner === home ? away : home) : undefined;
  return {
    id: fixtureId,
    stageId,
    home,
    away,
    status: "decided",
    events: match.events,
    outcome,
    ...(winner === undefined ? {} : { winner }),
    ...(loser === undefined ? {} : { loser }),
    ...extra,
  };
}

// --- Table stages (league / group / swiss) ---------------------------------

interface PlayedTableStage {
  record: SimStageRecord;
  tables: StageTables;
  finalRanks: EntrantId[];
}

function playRoundRobinStage(
  ctx: SimContext,
  stageId: string,
  kind: Extract<StageKind, "league" | "group">,
  pools: readonly { poolId: string; entrants: readonly EntrantId[] }[],
  seeds: ReadonlyMap<EntrantId, number>,
  legs = 1,
): PlayedTableStage {
  ctx.divisionEvents.push(...openStage(stageId));

  const allEntrants = pools.flatMap((pool) => [...pool.entrants]);
  const records: SimFixtureRecord[] = [];
  const tableFixtures: TableFixture[] = [];

  for (const pool of pools) {
    const schedule = generateRoundRobin({ entrants: pool.entrants, seeds, config: { legs } });
    if (schedule.fixtures.length !== roundRobinFixtureCount(pool.entrants.length, legs)) {
      throw new SimInvariantError(
        `round robin incomplete: pool "${pool.poolId}" produced ${schedule.fixtures.length} fixtures for ${pool.entrants.length} entrants over ${legs} legs`,
      );
    }
    for (const fixture of schedule.fixtures) {
      const fixtureId = `${stageId}-${pool.poolId}-${fixture.id}`;
      const match = playInStage(ctx, stageId, fixtureId, fixture.home, fixture.away, false);
      const stageCtx: StageCtx = { kind, roundNo: fixture.roundNo, poolId: pool.poolId };
      const result = tableResult(ctx, match, stageCtx);
      records.push(
        toRecord(stageId, fixtureId, fixture.home, fixture.away, match, {
          poolId: pool.poolId,
          roundNo: fixture.roundNo,
          result,
        }),
      );
      tableFixtures.push({
        id: fixtureId,
        poolId: pool.poolId,
        roundNo: fixture.roundNo,
        status: "decided",
        result,
      });
    }
  }

  const stage: TableStage = {
    id: stageId,
    kind,
    entrants: allEntrants,
    cascade: stageCascade(ctx.module, false),
    seeds,
    rngSeed: deriveSeed(ctx.seed, "lots", stageId),
  };
  if (!isTableStageComplete(stage, tableFixtures)) {
    throw new SimInvariantError(`stage "${stageId}" not complete after playing every fixture`);
  }
  const completed = completeTableStage(stage, tableFixtures);
  ctx.divisionEvents.push(...completed.events);

  const done = completed.events.find((e) => e.type === "stage_completed");
  const finalRanks = done?.type === "stage_completed" ? done.finalRanks : [];
  return {
    record: {
      id: stageId,
      kind,
      entrants: allEntrants,
      fixtures: records,
      tables: completed.tables,
      cascade: [...stage.cascade],
      ...(legs === 1 ? {} : { legs }),
      finalRanks,
    },
    tables: completed.tables,
    finalRanks,
  };
}

function playSwissStage(
  ctx: SimContext,
  stageId: string,
  entrants: readonly EntrantId[],
  seeds: ReadonlyMap<EntrantId, number>,
): PlayedTableStage {
  ctx.divisionEvents.push(...openStage(stageId));
  const chess = ctx.module.key === "boardgame";
  const targetRounds = Math.min(entrants.length - 1, Math.max(1, Math.ceil(Math.log2(entrants.length))));

  const records: SimFixtureRecord[] = [];
  const tableFixtures: TableFixture[] = [];
  const results: FixtureResult[] = [];
  const played = new Set<string>();
  const colours = new Map<EntrantId, Colour[]>();
  const byes = new Set<EntrantId>();
  const floats = new Map<EntrantId, number>();
  const points = new Map<EntrantId, number>(entrants.map((id) => [id, 0]));

  let roundsPlayed = 0;
  for (let round = 1; round <= targetRounds; round++) {
    const standings: SwissStanding[] = entrants.map((id) => ({
      entrantId: id,
      score: points.get(id) ?? 0,
      rank: seeds.get(id) ?? Number.MAX_SAFE_INTEGER,
    }));
    const paired = pairRound(standings, { played, colours, byes, floats }, { chess });
    if (paired.pairings.length === 0 && entrants.length >= 2) break; // no legal matching left
    if (paired.bye !== undefined) byes.add(paired.bye);
    for (const id of paired.floated) floats.set(id, (floats.get(id) ?? 0) + 1);

    for (let board = 0; board < paired.pairings.length; board++) {
      const pairing = paired.pairings[board] as { home: EntrantId; away: EntrantId };
      const key = pairKey(pairing.home, pairing.away);
      if (played.has(key)) {
        throw new SimInvariantError(`swiss rematch paired: ${key} in round ${round}`);
      }
      played.add(key);
      if (chess) {
        colours.set(pairing.home, [...(colours.get(pairing.home) ?? []), "W"]);
        colours.set(pairing.away, [...(colours.get(pairing.away) ?? []), "B"]);
      }

      const fixtureId = `${stageId}-r${round}-b${board + 1}`;
      const match = playInStage(ctx, stageId, fixtureId, pairing.home, pairing.away, false);
      const stageCtx: StageCtx = { kind: "swiss", roundNo: round };
      const result = tableResult(ctx, match, stageCtx);
      results.push(result);
      points.set(pairing.home, (points.get(pairing.home) ?? 0) + result[0].points);
      points.set(pairing.away, (points.get(pairing.away) ?? 0) + result[1].points);
      records.push(
        toRecord(stageId, fixtureId, pairing.home, pairing.away, match, {
          roundNo: round,
          result,
        }),
      );
      tableFixtures.push({ id: fixtureId, roundNo: round, status: "decided", result });
    }
    roundsPlayed = round;
  }

  const stage: TableStage = {
    id: stageId,
    kind: "swiss",
    entrants: [...entrants],
    cascade: stageCascade(ctx.module, true),
    swiss: true,
    seeds,
    rngSeed: deriveSeed(ctx.seed, "lots", stageId),
    rounds: roundsPlayed,
  };
  if (roundsPlayed === 0 || !isTableStageComplete(stage, tableFixtures)) {
    throw new SimInvariantError(`swiss stage "${stageId}" has no complete rounds`);
  }
  const completed = completeTableStage(stage, tableFixtures);
  ctx.divisionEvents.push(...completed.events);
  const done = completed.events.find((e) => e.type === "stage_completed");
  const finalRanks = done?.type === "stage_completed" ? done.finalRanks : [];
  return {
    record: {
      id: stageId,
      kind: "swiss",
      entrants: [...entrants],
      fixtures: records,
      tables: completed.tables,
      cascade: [...stage.cascade],
      finalRanks,
    },
    tables: completed.tables,
    finalRanks,
  };
}

// --- Bracket stages (knockout / double_elim / stepladder) -------------------

interface PlayedBracketStage {
  record: SimStageRecord;
  finalRanks: EntrantId[];
}

function playBracketStage(
  ctx: SimContext,
  stageId: string,
  kind: Extract<StageKind, "knockout" | "double_elim" | "stepladder">,
  generated: readonly BracketFixtureGen[],
  seeds: ReadonlyMap<EntrantId, number>,
): PlayedBracketStage {
  ctx.divisionEvents.push(...openStage(stageId));

  const byId = new Map<string, BracketFixture>();
  const records: SimFixtureRecord[] = [];
  const bracketFixtures: BracketFixture[] = [];

  const resolveRef = (ref: BracketSlotRef): EntrantId | undefined => {
    const source = byId.get(ref.fixtureId);
    if (source === undefined) {
      throw new SimInvariantError(`orphan feed: "${ref.fixtureId}" referenced before generation`, ref);
    }
    return ref.side === "winner" ? source.winner : source.loser;
  };

  for (const gen of generated) {
    const fixtureId = `${stageId}-${gen.id}`;
    const home = gen.home ?? (gen.homeFrom ? resolveRef(gen.homeFrom) : undefined);
    const away = gen.away ?? (gen.awayFrom ? resolveRef(gen.awayFrom) : undefined);
    const base: BracketFixture = {
      id: fixtureId,
      round: gen.round,
      ...(gen.bracket === undefined ? {} : { bracket: gen.bracket }),
      ...(gen.isFinal === undefined ? {} : { isFinal: gen.isFinal }),
      ...(gen.thirdPlace === undefined ? {} : { thirdPlace: gen.thirdPlace }),
      ...(home === undefined ? {} : { home }),
      ...(away === undefined ? {} : { away }),
      status: "scheduled",
    };
    const recordBase: SimFixtureRecord = {
      id: fixtureId,
      stageId,
      status: "void",
      events: [],
      outcome: null,
      round: gen.round,
      ...(gen.isFinal === undefined ? {} : { isFinal: gen.isFinal }),
      ...(home === undefined ? {} : { home }),
      ...(away === undefined ? {} : { away }),
    };

    // DE bracket-reset decider: played only when the LB champion won GF1 —
    // otherwise voided (void counts as settled for completion, spec 05 §2.4).
    const skipConditional =
      gen.conditional === true &&
      (() => {
        const gf1 = gen.homeFrom ? byId.get(gen.homeFrom.fixtureId) : undefined;
        // GF1 home = WB champion; if the WB champion won, no reset is needed.
        return gf1 !== undefined && gf1.winner !== undefined && gf1.winner === gf1.home;
      })();

    if (gen.award !== undefined) {
      // Bye — auto-decided at generation: the entrant is awarded through.
      const fixture: BracketFixture = { ...base, status: "walkover", winner: gen.award };
      byId.set(gen.id, fixture);
      bracketFixtures.push(fixture);
      records.push({ ...recordBase, status: "walkover", winner: gen.award });
    } else if (skipConditional) {
      const fixture: BracketFixture = { ...base, status: "void" };
      byId.set(gen.id, fixture);
      bracketFixtures.push(fixture);
      records.push(recordBase);
    } else if (home !== undefined && away !== undefined) {
      const match = playInStage(ctx, stageId, fixtureId, home, away, true);
      const winner = (match.outcome as { winner: EntrantId }).winner;
      const loser = winner === home ? away : home;
      const fixture: BracketFixture = { ...base, status: "decided", winner, loser };
      byId.set(gen.id, fixture);
      bracketFixtures.push(fixture);
      records.push({
        ...toRecord(stageId, fixtureId, home, away, match, {
          round: gen.round,
          ...(gen.isFinal === undefined ? {} : { isFinal: gen.isFinal }),
        }),
      });
    } else if (home !== undefined || away !== undefined) {
      // One feed produced nobody (void/bye cascade) — the present side walks over.
      const winner = (home ?? away) as EntrantId;
      const fixture: BracketFixture = { ...base, status: "walkover", winner };
      byId.set(gen.id, fixture);
      bracketFixtures.push(fixture);
      records.push({ ...recordBase, status: "walkover", winner });
    } else {
      const fixture: BracketFixture = { ...base, status: "void" };
      byId.set(gen.id, fixture);
      bracketFixtures.push(fixture);
      records.push(recordBase);
    }
  }

  const stage: BracketStage = { id: stageId, kind, seeds };
  if (!isBracketStageComplete(stage, bracketFixtures)) {
    throw new SimInvariantError(`bracket stage "${stageId}" not complete after playing every fixture`);
  }
  const completed = completeBracketStage(stage, bracketFixtures);
  ctx.divisionEvents.push(...completed.events);

  const entrants = new Set<EntrantId>();
  for (const fixture of bracketFixtures) {
    if (fixture.home !== undefined) entrants.add(fixture.home);
    if (fixture.away !== undefined) entrants.add(fixture.away);
    if (fixture.winner !== undefined) entrants.add(fixture.winner);
  }

  return {
    record: {
      id: stageId,
      kind,
      entrants: [...entrants],
      fixtures: records,
      finalRanks: completed.finalRanks,
    },
    finalRanks: completed.finalRanks,
  };
}

// --- Qualification glue -----------------------------------------------------

function qualify(
  stageRecord: SimStageRecord,
  spec: QualificationSpec,
  tables: StageTables,
): EntrantId[] {
  const seeds = resolveQualification(spec, tables);
  stageRecord.qualification = { spec, seeds };
  if (seeds.length !== qualificationSize(spec)) {
    throw new SimInvariantError(
      `qualification produced ${seeds.length} seeds, spec wants ${qualificationSize(spec)}`,
      { spec },
    );
  }
  if (new Set(seeds).size !== seeds.length) {
    throw new SimInvariantError(`qualification seeds not distinct`, { seeds });
  }
  return seeds;
}

const seedMap = (order: readonly EntrantId[]): Map<EntrantId, number> =>
  new Map(order.map((id, i) => [id, i + 1]));

// ---------------------------------------------------------------------------
// simulateDivision — the entry point.
// ---------------------------------------------------------------------------

export function simulateDivision(opts: SimOptions): SimulationResult {
  const module = opts.module;
  const cfg = module.configSchema.parse(opts.cfg ?? {});
  const seed = opts.seed;
  const n = opts.entrantCount ?? drawEntrantCount(seed);
  if (n < 2 || n > 64) throw new Error(`entrantCount ${n} outside 2–64`);

  const entrants: EntrantId[] = Array.from({ length: n }, (_, i) =>
    `t${String(i + 1).padStart(2, "0")}`,
  );
  const seeds = seedMap(entrants);

  const ctx: SimContext = {
    module,
    cfg,
    seed,
    maxEvents: opts.maxEventsPerFixture ?? 600,
    lineups: new Map(),
    divisionEvents: [],
    injectAt: opts.injectVoid === true ? deriveSeed(seed, "injectAt") % 3 : -1,
    fixturesPlayed: 0,
  };

  const stages: SimStageRecord[] = [];
  let finalRanks: EntrantId[] = [];

  switch (opts.format) {
    case "league": {
      const stage = playRoundRobinStage(ctx, "league", "league", [{ poolId: "P1", entrants }], seeds);
      stages.push(stage.record);
      finalRanks = stage.finalRanks;
      break;
    }

    case "league_legs2": {
      // Jul3/08 §2 — double round robin: every pairing twice, mirrored venues.
      const stage = playRoundRobinStage(
        ctx,
        "league",
        "league",
        [{ poolId: "P1", entrants }],
        seeds,
        2,
      );
      stages.push(stage.record);
      finalRanks = stage.finalRanks;
      break;
    }

    case "group_knockout": {
      // Pools of ~4 dealt by seed; single pool below 8 entrants.
      const poolCount = Math.max(1, Math.floor(n / 4));
      const pools = Array.from({ length: poolCount }, (_, p) => ({
        poolId: `P${p + 1}`,
        entrants: entrants.filter((_, i) => i % poolCount === p),
      }));
      const groups = playRoundRobinStage(ctx, "groups", "group", pools, seeds);
      stages.push(groups.record);

      const spec: QualificationSpec =
        poolCount === 1
          ? { from: "groups", topN: Math.min(4, n) }
          : {
              from: "groups",
              take: [1, 2].flatMap((rank) =>
                pools.map((pool) => ({ pool: pool.poolId, rank })),
              ),
            };
      const qualified = qualify(groups.record, spec, groups.tables);
      const koSeeds = seedMap(qualified);
      const ko = playBracketStage(
        ctx,
        "ko",
        "knockout",
        generateSingleElim({ entrants: qualified, seeds: koSeeds }).fixtures,
        koSeeds,
      );
      stages.push(ko.record);
      finalRanks = ko.finalRanks;
      break;
    }

    case "swiss_knockout": {
      const swiss = playSwissStage(ctx, "swiss", entrants, seeds);
      stages.push(swiss.record);

      const spec: QualificationSpec = { from: "swiss", topN: Math.min(4, n) };
      const qualified = qualify(swiss.record, spec, swiss.tables);
      const koSeeds = seedMap(qualified);
      const ko = playBracketStage(
        ctx,
        "ko",
        "knockout",
        generateSingleElim({ entrants: qualified, seeds: koSeeds }).fixtures,
        koSeeds,
      );
      stages.push(ko.record);
      finalRanks = ko.finalRanks;
      break;
    }

    case "double_elim": {
      const bracketReset = mulberry32(deriveSeed(seed, "reset"))() < 0.5;
      const de = playBracketStage(
        ctx,
        "de",
        "double_elim",
        generateDoubleElim({ entrants, seeds, bracketReset }).fixtures,
        seeds,
      );
      stages.push(de.record);
      finalRanks = de.finalRanks;
      break;
    }

    case "stepladder": {
      const sl = playBracketStage(
        ctx,
        "sl",
        "stepladder",
        generateStepladder({ entrants, seeds }).fixtures,
        seeds,
      );
      stages.push(sl.record);
      finalRanks = sl.finalRanks;
      break;
    }
  }

  const champion = finalRanks[0];
  if (champion === undefined) {
    throw new SimInvariantError("champion undefined: empty final ranks", { finalRanks });
  }

  return {
    seedToken: makeSeedToken(module.key, opts.format, seed),
    sport: module.key,
    format: opts.format,
    seed,
    entrants,
    stages,
    divisionEvents: ctx.divisionEvents,
    champion,
    finalRanks,
    ...(ctx.injection === undefined ? {} : { injection: ctx.injection }),
  };
}

// ---------------------------------------------------------------------------
// Global invariants — PROMPT-14 §1.
// ---------------------------------------------------------------------------

const TERMINAL: ReadonlySet<SimFixtureRecord["status"]> = new Set([
  "decided",
  "walkover",
  "void",
]);

function fail(sim: SimulationResult, message: string, detail?: unknown): never {
  throw new SimInvariantError(`[${sim.seedToken}] ${message}`, detail);
}

export function assertDivisionInvariants(
  sim: SimulationResult,
  module: AnySportModule,
  rawCfg?: unknown,
): void {
  const cfg = module.configSchema.parse(rawCfg ?? {}) as unknown;
  const entrantSet = new Set(sim.entrants);

  // Champion well-defined.
  if (!entrantSet.has(sim.champion)) fail(sim, `champion "${sim.champion}" is not an entrant`);
  if (new Set(sim.finalRanks).size !== sim.finalRanks.length) {
    fail(sim, "final ranks contain duplicates", sim.finalRanks);
  }
  for (const id of sim.finalRanks) {
    if (!entrantSet.has(id)) fail(sim, `final rank lists non-entrant "${id}"`);
  }

  // Every fixture terminal; event envelopes well-formed and globally unique.
  const allEventIds = new Set<string>();
  const allowedTotals = module.declaredPointsSets(cfg) as readonly number[];
  for (const stage of sim.stages) {
    for (const fixture of stage.fixtures) {
      if (!TERMINAL.has(fixture.status)) {
        fail(sim, `fixture "${fixture.id}" ended non-terminal: ${fixture.status}`);
      }
      fixture.events.forEach((event, i) => {
        if (event.seq !== i) fail(sim, `fixture "${fixture.id}" seq gap at ${i} (got ${event.seq})`);
        if (allEventIds.has(event.id)) fail(sim, `duplicate event id "${event.id}"`);
        allEventIds.add(event.id);
      });
      if (fixture.status === "decided" && fixture.outcome === null) {
        fail(sim, `decided fixture "${fixture.id}" has no outcome`);
      }
    }

    // Table-stage invariants: conservation, played counts, ledger sums, ranks.
    if (stage.tables !== undefined) {
      const counted = stage.fixtures.filter(
        (fixture) => fixture.status === "decided" && fixture.result !== undefined,
      );
      let expectPlayed = 0;
      let expectPoints = 0;
      let expectWon = 0;
      let expectLost = 0;
      const ledger = new Map<string, number>();
      for (const fixture of counted) {
        const [home, away] = fixture.result as FixtureResult;
        const total = home.points + away.points;
        if (!allowedTotals.includes(total)) {
          fail(
            sim,
            `fixture "${fixture.id}" points total ${total} outside declared set [${allowedTotals.join(", ")}]`,
            fixture.outcome,
          );
        }
        expectPlayed += home.played + away.played;
        expectPoints += total;
        expectWon += home.won + away.won;
        expectLost += home.lost + away.lost;
        for (const delta of [home, away]) {
          for (const [key, value] of Object.entries(delta.metrics)) {
            if (!Number.isInteger(value)) {
              fail(sim, `fixture "${fixture.id}" metric "${key}" not an integer ledger entry`);
            }
            ledger.set(key, (ledger.get(key) ?? 0) + value);
          }
        }
      }

      const rows = stage.tables.pools.flatMap((pool) => [...pool.rows]);
      const sum = (pick: (row: (typeof rows)[number]) => number): number =>
        rows.reduce((acc, row) => acc + pick(row), 0);
      if (sum((row) => row.played) !== expectPlayed) {
        fail(sim, `stage "${stage.id}" played counts diverge from fixtures`);
      }
      if (sum((row) => row.points) !== expectPoints) {
        fail(sim, `stage "${stage.id}" points not conserved across the fold`);
      }
      if (sum((row) => row.won) !== expectWon || sum((row) => row.lost) !== expectLost) {
        fail(sim, `stage "${stage.id}" won/lost tallies diverge from fixtures`);
      }
      for (const [key, value] of ledger) {
        // Swiss cascade columns are materialised display metrics, not fixture
        // ledger sums — only fixture-sourced keys are conserved.
        const folded = rows.reduce((acc, row) => acc + (row.metrics[key] ?? 0), 0);
        if (folded !== value) {
          fail(sim, `stage "${stage.id}" ledger "${key}" not conserved (${folded} ≠ ${value})`);
        }
      }

      for (const pool of stage.tables.pools) {
        const ranks = pool.rows.map((row) => row.rank);
        const want = pool.rows.map((_, i) => i + 1);
        if (JSON.stringify([...ranks].sort((a, b) => (a ?? 0) - (b ?? 0))) !== JSON.stringify(want)) {
          fail(sim, `stage "${stage.id}" pool "${pool.pool}" ranks not a total order 1..n`, ranks);
        }
        // Cascade sanity (the comparator-flip catcher): every builtin cascade
        // ranks on points first, so rank order must be non-increasing in points.
        if (stage.cascade?.[0] === "points") {
          const sorted = [...pool.rows].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
          for (let i = 1; i < sorted.length; i++) {
            const prev = sorted[i - 1] as (typeof sorted)[number];
            const here = sorted[i] as (typeof sorted)[number];
            if (here.points > prev.points) {
              fail(
                sim,
                `stage "${stage.id}" pool "${pool.pool}" rank order contradicts points (rank ${prev.rank}: ${prev.points} < rank ${here.rank}: ${here.points})`,
              );
            }
          }
        }
      }
    }

    // Swiss structural invariants: no rematch, ≤1 fixture per entrant per round.
    if (stage.kind === "swiss" || stage.kind === "league" || stage.kind === "group") {
      const pairs = new Map<string, number>();
      const perRound = new Map<string, Set<EntrantId>>();
      for (const fixture of stage.fixtures) {
        if (fixture.home === undefined || fixture.away === undefined) continue;
        const key = `${fixture.poolId ?? ""}|${pairKey(fixture.home, fixture.away)}`;
        pairs.set(key, (pairs.get(key) ?? 0) + 1);
        const roundKey = `${fixture.poolId ?? ""}|${fixture.roundNo ?? 0}`;
        const inRound = perRound.get(roundKey) ?? new Set<EntrantId>();
        if (inRound.has(fixture.home) || inRound.has(fixture.away)) {
          fail(sim, `stage "${stage.id}" entrant plays twice in round ${fixture.roundNo}`);
        }
        inRound.add(fixture.home);
        inRound.add(fixture.away);
        perRound.set(roundKey, inRound);
      }
      // Multi-leg round robins (Jul3/08 §2) meet exactly `legs` times.
      const maxMeets = stage.legs ?? 1;
      for (const [key, count] of pairs) {
        if (count > maxMeets) {
          fail(sim, `stage "${stage.id}" pair met ${count} times (legs=${maxMeets}): ${key}`);
        }
      }
    }

    // Bracket invariants: eliminations require losses; champion (nearly) unbeaten.
    if (stage.kind === "knockout" || stage.kind === "double_elim" || stage.kind === "stepladder") {
      const losses = new Map<EntrantId, number>();
      for (const fixture of stage.fixtures) {
        if (fixture.loser !== undefined) {
          losses.set(fixture.loser, (losses.get(fixture.loser) ?? 0) + 1);
        }
      }
      const isChampionStage = stage.finalRanks[0] === sim.champion;
      if (isChampionStage) {
        const championLosses = losses.get(sim.champion) ?? 0;
        const cap = stage.kind === "double_elim" ? 2 : 0;
        if (championLosses > cap) {
          fail(sim, `champion "${sim.champion}" has ${championLosses} losses in a ${stage.kind}`);
        }
        for (const id of stage.entrants) {
          if (id === sim.champion) continue;
          if ((losses.get(id) ?? 0) < 1) {
            fail(sim, `non-champion "${id}" was never beaten in ${stage.kind} "${stage.id}"`);
          }
        }
      }
    }

    // Qualification counts (spec 05 §6): output size = next stage's input size.
    if (stage.qualification !== undefined) {
      const { spec, seeds } = stage.qualification;
      if (seeds.length !== qualificationSize(spec)) {
        fail(sim, `stage "${stage.id}" qualification size mismatch`, stage.qualification);
      }
      for (const id of seeds) {
        if (!entrantSet.has(id)) fail(sim, `qualified non-entrant "${id}"`);
      }
    }
  }

  // Division ledger sanity: stages opened before completed, exactly once each.
  const opened = new Set<string>();
  const completed = new Set<string>();
  for (const event of sim.divisionEvents) {
    if (event.type === "stage_opened") {
      if (opened.has(event.stageId)) fail(sim, `stage "${event.stageId}" opened twice`);
      opened.add(event.stageId);
    }
    if (event.type === "stage_completed") {
      if (!opened.has(event.stageId)) fail(sim, `stage "${event.stageId}" completed before opening`);
      if (completed.has(event.stageId)) fail(sim, `stage "${event.stageId}" completed twice`);
      completed.add(event.stageId);
    }
  }
  for (const stage of sim.stages) {
    if (!completed.has(stage.id)) fail(sim, `stage "${stage.id}" never completed`);
  }
}
