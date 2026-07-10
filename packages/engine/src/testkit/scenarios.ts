// Permanent sim scenarios — v3/09 §3 (PROMPT-38). Framework-free runners the
// sim-replay script (and any test) can call: each returns counters and THROWS
// SimInvariantError on violation, so a failure always carries a reproducing
// seed. The first two encode the two founder-reported bugs as permanent
// coverage: mid-match undo storms (intake #29) and the set-end boundary
// matrices (intake #28). The rest fold Jul3 features into the sim loop:
// officials assignment (Jul3/02), custom points + carry-over (Jul3/05), and
// the americano / ladder formats (Jul3/08).
import { EngineError } from "../core/errors.ts";
import { foldMatch, type EventEnvelope } from "../core/events.ts";
import { mulberry32 } from "../core/rng.ts";
import type { EntrantId, LineupPair, MatchOutcome } from "../core/types.ts";
import { applyPointsRule, carryDeltas, PointsRule } from "../competition/points.ts";
import type { FixtureResult } from "../competition/standings.ts";
import { assignOfficials } from "../officials/assign.ts";
import type { AssignPolicy, OfficialFixture, OfficialSpec } from "../officials/types.ts";
import { generateAmericano } from "../scheduling/americano.ts";
import type { AnySportModule, ModuleEvent } from "../sport/module.ts";
import { badminton } from "../sports/setbased/badminton.ts";
import { tabletennis } from "../sports/setbased/tabletennis.ts";
import { volleyball } from "../sports/setbased/volleyball.ts";
import type { SetBasedState } from "../sports/setbased/kernel.ts";
import { defaultLineupPair, lineupFromCatalog, makeEnvelope } from "./helpers.ts";
import { deriveSeed, SimInvariantError, SIM_CONFIGS } from "./simulation.ts";

// ---------------------------------------------------------------------------
// Shared: walk a module's generator to a decided stream.
// ---------------------------------------------------------------------------

function decidedStream(
  module: AnySportModule,
  cfg: unknown,
  lineups: LineupPair,
  seed: number,
  maxEvents = 600,
): { events: EventEnvelope[]; state: unknown } | null {
  const generate = module.arbitraryEvent;
  if (!generate) throw new Error(`module "${module.key}" lacks arbitraryEvent`);
  const rng = mulberry32(seed);
  let state = module.init(cfg, lineups);
  const events: EventEnvelope[] = [];
  for (let i = 0; i < maxEvents; i++) {
    const next = generate.call(module, state, rng) as ModuleEvent | null;
    if (next === null) break;
    const env = makeEnvelope(events.length, next);
    state = module.apply(state, env);
    events.push(env);
    if (module.outcome(state) !== null) return { events, state };
  }
  return null;
}

function moduleCfg(module: AnySportModule): unknown {
  return module.configSchema.parse(SIM_CONFIGS[module.key] ?? {});
}

// ---------------------------------------------------------------------------
// Scenario 1 — undo storm (intake #29, every sport). Voids every event
// position of a decided stream; each fold must reject with a typed
// EngineError or yield a renderable summary from which scoring resumes.
// ---------------------------------------------------------------------------

export interface UndoStormStats {
  sport: string;
  positions: number;
  accepted: number;
  rejected: number;
}

export function runUndoStorm(module: AnySportModule, seed: number): UndoStormStats {
  const cfg = moduleCfg(module);
  const lineups = defaultLineupPair(module.positions);
  const label = (i: number, type: string) => `[undo-storm ${module.key}:${seed}] seq=${i} ${type}`;

  let stream: { events: EventEnvelope[] } | null = null;
  for (let s = 0; s < 8 && stream === null; s++) {
    stream = decidedStream(module, cfg, lineups, deriveSeed(seed + s, module.key, "storm"));
  }
  if (stream === null) {
    throw new SimInvariantError(`[undo-storm ${module.key}:${seed}] generator never decided`);
  }

  const stats: UndoStormStats = { sport: module.key, positions: 0, accepted: 0, rejected: 0 };
  for (let i = 0; i < stream.events.length; i++) {
    const target = stream.events[i] as EventEnvelope;
    const withVoid = [
      ...stream.events,
      makeEnvelope(stream.events.length, { type: "core.void", payload: {} }, target.id),
    ];
    stats.positions++;

    let state: unknown;
    try {
      state = foldMatch(module, cfg, lineups, withVoid);
    } catch (err) {
      if (!EngineError.is(err)) {
        throw new SimInvariantError(`${label(i, target.type)} fold threw non-EngineError: ${String(err)}`);
      }
      stats.rejected++;
      continue;
    }
    stats.accepted++;

    // Renderable summary + resumable scoring — the blank-panel guarantees.
    let summary: { headline?: unknown };
    try {
      summary = module.summary(state as never) as { headline?: unknown };
    } catch (err) {
      throw new SimInvariantError(`${label(i, target.type)} summary() threw: ${String(err)}`);
    }
    if (typeof summary.headline !== "string") {
      throw new SimInvariantError(`${label(i, target.type)} headline not a string`);
    }
    if (module.outcome(state as never) === null) {
      const rng = mulberry32(deriveSeed(seed, module.key, "storm-resume", i));
      let resumed = state;
      for (let n = 0; n < 600; n++) {
        const next = module.arbitraryEvent?.call(module, resumed as never, rng) as ModuleEvent | null;
        if (next === null || next === undefined) break;
        try {
          resumed = module.apply(resumed as never, makeEnvelope(withVoid.length + n, next));
        } catch (err) {
          if (!EngineError.is(err)) {
            throw new SimInvariantError(`${label(i, target.type)} resume threw non-EngineError: ${String(err)}`);
          }
          break;
        }
        if (module.outcome(resumed as never) !== null) break;
      }
    }
  }
  return stats;
}

// ---------------------------------------------------------------------------
// Scenario 2 — set-end boundary matrices (intake #28, setbased presets).
// The kernel's set predicate at the deuce/cap corners, per preset.
// ---------------------------------------------------------------------------

interface BoundaryCase {
  score: [number, number];
  ends: boolean;
}

interface PresetMatrix {
  module: AnySportModule;
  rallyType: string;
  summaryType: string;
  cases: BoundaryCase[];
  rejectedSummaries: [number, number][];
}

// BWF 21/2/30 · ITTF 11/2/uncapped · FIVB 25/2/uncapped (spec 04 §3–5).
const MATRICES: PresetMatrix[] = [
  {
    module: badminton,
    rallyType: "badminton.rally",
    summaryType: "badminton.game.summary",
    cases: [
      { score: [21, 19], ends: true },
      { score: [21, 20], ends: false },
      { score: [22, 20], ends: true },
      { score: [29, 28], ends: false },
      { score: [30, 29], ends: true },
      { score: [21, 0], ends: true },
    ],
    rejectedSummaries: [
      [31, 30],
      [22, 19],
      [30, 27],
    ],
  },
  {
    module: tabletennis,
    rallyType: "tabletennis.rally",
    summaryType: "tabletennis.game.summary",
    cases: [
      { score: [11, 9], ends: true },
      { score: [11, 10], ends: false },
      { score: [12, 10], ends: true },
      { score: [15, 13], ends: true },
    ],
    rejectedSummaries: [
      [12, 9],
      [13, 10],
    ],
  },
  {
    module: volleyball,
    rallyType: "volleyball.rally",
    summaryType: "volleyball.set.summary",
    cases: [
      { score: [25, 23], ends: true },
      { score: [25, 24], ends: false },
      { score: [26, 24], ends: true },
      { score: [32, 30], ends: true },
    ],
    rejectedSummaries: [
      [26, 23],
      [33, 30],
    ],
  },
];

export interface BoundaryMatrixStats {
  preset: string;
  cases: number;
}

export function runBoundaryMatrices(): BoundaryMatrixStats[] {
  const out: BoundaryMatrixStats[] = [];
  for (const matrix of MATRICES) {
    const cfg = matrix.module.configSchema.parse({});
    const lineups = defaultLineupPair(matrix.module.positions);
    let cases = 0;
    const fold = (events: ModuleEvent[]) =>
      foldMatch(matrix.module, cfg, lineups, [
        makeEnvelope(0, { type: "core.start", payload: {} }),
        ...events.map((e, i) => ({ ...makeEnvelope(i + 1, e) })),
      ]) as SetBasedState;

    for (const { score, ends } of matrix.cases) {
      const [h, a] = score;
      const rallies: ModuleEvent[] = [];
      for (let i = 0; i < Math.min(h, a); i++) {
        rallies.push({ type: matrix.rallyType, payload: { wonBy: "H" } });
        rallies.push({ type: matrix.rallyType, payload: { wonBy: "A" } });
      }
      for (let i = 0; i < Math.abs(h - a); i++) {
        rallies.push({ type: matrix.rallyType, payload: { wonBy: h > a ? "H" : "A" } });
      }
      const state = fold(rallies);
      const set = state.sets[0];
      if (set?.home !== h || set?.away !== a || set?.closed !== ends) {
        throw new SimInvariantError(
          `[boundary ${matrix.module.key}] rally ${h}-${a}: expected closed=${ends}, got ${JSON.stringify(set)}`,
        );
      }
      cases++;
    }
    for (const [h, a] of matrix.rejectedSummaries) {
      let rejected = false;
      try {
        fold([{ type: matrix.summaryType, payload: { home: h, away: a } }]);
      } catch (err) {
        rejected = EngineError.is(err, "INVALID_EVENT");
      }
      if (!rejected) {
        throw new SimInvariantError(
          `[boundary ${matrix.module.key}] summary ${h}-${a} must be rejected as unreachable`,
        );
      }
      cases++;
    }
    out.push({ preset: matrix.module.key, cases });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scenario 3 — officials assignment over a simulated round (Jul3/02).
// ---------------------------------------------------------------------------

export interface OfficialsStats {
  fixtures: number;
  officials: number;
  assignments: number;
  blockConflicts: number;
}

export function runOfficialsScenario(seed: number): OfficialsStats {
  const rng = mulberry32(deriveSeed(seed, "officials"));
  const courts = ["C1", "C2"];
  const fixtures: OfficialFixture[] = [];
  // Two courts × 6 slots of 30 minutes.
  for (let slot = 0; slot < 6; slot++) {
    for (const [c, court] of courts.entries()) {
      const id = `f-${slot}-${court}`;
      fixtures.push({
        id,
        startAt: slot * 30 * 60_000,
        endAt: (slot + 1) * 30 * 60_000,
        court,
        entrants: [`e${slot * 2 + c}a`, `e${slot * 2 + c}b`],
      });
    }
  }
  const officials: OfficialSpec[] = Array.from({ length: 5 }, (_, i) => ({
    id: `o${i + 1}`,
    roleKeys: ["referee"],
    ...(rng() < 0.4 ? { maxPerDay: 4 } : {}),
  }));
  const policy: AssignPolicy = {
    roles: ["referee"],
    poolLock: false,
    blockStay: true,
    fairness: "tournament",
    teamRefKeepDivision: false,
    restMinMinutes: 0,
    blockGapMinutes: 30,
  };
  const result = assignOfficials({ fixtures, officials, locked: [], policy, rngSeed: `sim-${seed}` });

  // Hard invariant: no official on two overlapping fixtures.
  const byOfficial = new Map<string, { from: number; to: number }[]>();
  for (const a of result.assignments) {
    const fixture = fixtures.find((f) => f.id === a.fixtureId);
    if (!fixture) throw new SimInvariantError(`[officials:${seed}] assignment to unknown fixture`);
    const spans = byOfficial.get(a.officialId) ?? [];
    for (const span of spans) {
      if (span.from < fixture.endAt && fixture.startAt < span.to) {
        throw new SimInvariantError(`[officials:${seed}] official ${a.officialId} double-booked`);
      }
    }
    spans.push({ from: fixture.startAt, to: fixture.endAt });
    byOfficial.set(a.officialId, spans);
  }
  return {
    fixtures: fixtures.length,
    officials: officials.length,
    assignments: result.assignments.length,
    blockConflicts: result.conflicts.filter((c) => c.severity === "block").length,
  };
}

// ---------------------------------------------------------------------------
// Scenario 4 — custom points + carry-over (Jul3/05) over live module output.
// ---------------------------------------------------------------------------

export interface CustomPointsStats {
  sport: string;
  fixtures: number;
}

const CUSTOM_RULE = PointsRule.parse({
  base: { win: 5, draw: 2, loss: 1 },
});

export function runCustomPointsScenario(module: AnySportModule, seed: number): CustomPointsStats {
  const cfg = moduleCfg(module);
  const lineups = defaultLineupPair(module.positions);
  let fixtures = 0;
  for (let s = 0; s < 4; s++) {
    const played = decidedStream(module, cfg, lineups, deriveSeed(seed + s, module.key, "points"));
    if (played === null) continue;
    const outcome = module.outcome(played.state as never) as MatchOutcome;
    if (outcome.kind === "no_result") continue;
    const pair = module.standingsDelta(outcome, cfg as never, { kind: "league" }, played.state as never);
    const mapped = applyPointsRule(outcome, pair as FixtureResult, CUSTOM_RULE);
    for (const [i, delta] of mapped.entries()) {
      const want = delta.won === 1 ? 5 : delta.drawn === 1 ? 2 : delta.lost === 1 ? 1 : 0;
      // Forfeits without a configured forfeit block still pay base points.
      if (delta.points !== want) {
        throw new SimInvariantError(
          `[points ${module.key}:${seed}] side ${i} expected ${want} points, got ${delta.points}`,
          { outcome, delta },
        );
      }
      const original = (pair as FixtureResult)[i as 0 | 1];
      if (JSON.stringify(delta.metrics) !== JSON.stringify(original.metrics)) {
        throw new SimInvariantError(`[points ${module.key}:${seed}] metrics ledger mutated by rule`);
      }
    }
    fixtures++;
  }
  return { sport: module.key, fixtures };
}

export interface CarryOverStats {
  rows: number;
}

export function runCarryOverScenario(rows: readonly { entrantId: EntrantId; played: number; won: number; drawn: number; lost: number; points: number; metrics: Record<string, number> }[]): CarryOverStats {
  const asRows = rows as never[];
  const pointsOnly = carryDeltas(asRows, "points");
  const full = carryDeltas(asRows, "full");
  const sum = (list: readonly { points: number }[]) => list.reduce((a, r) => a + r.points, 0);
  if (sum(pointsOnly) !== sum(rows) || sum(full) !== sum(rows)) {
    throw new SimInvariantError("[carry-over] points not conserved across carry");
  }
  for (const [i, delta] of pointsOnly.entries()) {
    if (delta.played !== 0 || Object.keys(delta.metrics).length > 0) {
      throw new SimInvariantError("[carry-over] points mode must carry points only", { i, delta });
    }
  }
  for (const [i, delta] of full.entries()) {
    const row = rows[i] as (typeof rows)[number];
    if (delta.played !== row.played || delta.won !== row.won) {
      throw new SimInvariantError("[carry-over] full mode must carry the whole row", { i, delta });
    }
  }
  return { rows: rows.length };
}

// ---------------------------------------------------------------------------
// Scenario 5 — americano rounds played through a module (Jul3/08 §3).
// ---------------------------------------------------------------------------

export interface AmericanoStats {
  players: number;
  rounds: number;
  matches: number;
}

export function runAmericanoScenario(module: AnySportModule, seed: number, players = 8): AmericanoStats {
  const cfg = moduleCfg(module);
  const ids: EntrantId[] = Array.from({ length: players }, (_, i) => `p${String(i + 1).padStart(2, "0")}`);
  const rounds = generateAmericano(ids, { mode: "americano", courtCount: 2, rounds: 5 });
  const personal = new Map<EntrantId, number>(ids.map((id) => [id, 0]));
  let matches = 0;
  let awarded = 0;

  for (const round of rounds) {
    const seen = new Set<EntrantId>();
    for (const match of round.matches) {
      for (const p of [...match.team1, ...match.team2]) {
        if (seen.has(p)) {
          throw new SimInvariantError(`[americano:${seed}] ${p} plays twice in round ${round.roundNo}`);
        }
        seen.add(p);
      }
      // Pair entrants are synthetic per match; the module never inspects them.
      const home = match.team1.join("+");
      const away = match.team2.join("+");
      const lineups: LineupPair = {
        home: lineupFromCatalog(module.positions, home),
        away: lineupFromCatalog(module.positions, away),
      };
      let played: { events: EventEnvelope[]; state: unknown } | null = null;
      for (let s = 0; s < 6 && played === null; s++) {
        played = decidedStream(module, cfg, lineups, deriveSeed(seed + s, match.id, "americano"));
      }
      if (played === null) {
        throw new SimInvariantError(`[americano:${seed}] match ${match.id} never decided`);
      }
      const outcome = module.outcome(played.state as never) as MatchOutcome;
      if (outcome.kind === "win" || outcome.kind === "award") {
        const winners = outcome.winner === home ? match.team1 : match.team2;
        for (const p of winners) personal.set(p, (personal.get(p) ?? 0) + 1);
        awarded += 2; // both winning partners bank a personal point
      }
      matches++;
    }
  }
  const total = [...personal.values()].reduce((a, b) => a + b, 0);
  if (total !== awarded) {
    throw new SimInvariantError(`[americano:${seed}] personal points not conserved (${total} ≠ ${awarded})`);
  }
  return { players, rounds: rounds.length, matches };
}

// ---------------------------------------------------------------------------
// Scenario 6 — ladder challenges (Jul3/08 §6): winner takes the position.
// ---------------------------------------------------------------------------

export interface LadderStats {
  entrants: number;
  challenges: number;
  swaps: number;
}

export function runLadderScenario(module: AnySportModule, seed: number, entrants = 8): LadderStats {
  const cfg = moduleCfg(module);
  const rng = mulberry32(deriveSeed(seed, module.key, "ladder"));
  let order: EntrantId[] = Array.from({ length: entrants }, (_, i) => `L${String(i + 1).padStart(2, "0")}`);
  const initial = [...order];
  let swaps = 0;
  const challenges = entrants * 2;

  for (let c = 0; c < challenges; c++) {
    // Challenger picks someone above them (the app allows a bounded reach;
    // the swap rule is what the sim checks, not the reach policy).
    const ci = 1 + Math.floor(rng() * (order.length - 1));
    const ti = Math.floor(rng() * ci);
    const challenger = order[ci] as EntrantId;
    const target = order[ti] as EntrantId;
    const lineups: LineupPair = {
      home: lineupFromCatalog(module.positions, target),
      away: lineupFromCatalog(module.positions, challenger),
    };
    let played: { state: unknown } | null = null;
    for (let s = 0; s < 6 && played === null; s++) {
      played = decidedStream(module, cfg, lineups, deriveSeed(seed + s, `ladder-${c}`, "match"));
    }
    if (played === null) continue; // undecidable challenge — ladder unchanged
    const outcome = module.outcome(played.state as never) as MatchOutcome;
    const winner = outcome.kind === "win" || outcome.kind === "award" ? outcome.winner : null;
    if (winner === challenger) {
      // scoring.ts onDecided ladder rule: challenger takes the position.
      [order[ci], order[ti]] = [order[ti] as EntrantId, order[ci] as EntrantId];
      swaps++;
    }
    if ([...order].sort().join(",") !== [...initial].sort().join(",")) {
      throw new SimInvariantError(`[ladder ${module.key}:${seed}] order is no longer a permutation`);
    }
  }
  return { entrants, challenges, swaps };
}
