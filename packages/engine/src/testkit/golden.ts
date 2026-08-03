// Cross-sport golden-replay harness — W4 step 0 (#407 programme).
//
// WHY THIS EXISTS. `conformance.ts` generates its streams with fast-check at
// run time, so it re-derives its inputs from whatever the schemas currently
// are: it can never prove that a schema change was *additive*. This harness
// freezes a corpus of pre-change event streams to disk and replays them
// against the live module. A committed stream that no longer folds to the
// recorded state — or no longer parses against `eventSchema` — is a
// back-compat break, whatever the version number says.
//
// Generalised from the football-only gate that used to live in
// sports/football/football.golden.test.ts (same mulberry32 seeded walk over
// `module.arbitraryEvent`, same UPDATE_GOLDEN convention, now with per-event
// folded state and an eventSchema re-parse on every recorded payload).
//
// Regenerate ONLY when a fold change is intended:
//   UPDATE_GOLDEN=1 npx vitest run src/testkit/golden.test.ts
//
// Purity note: this file lives in testkit and may touch node:fs. Nothing under
// src/sport/** or src/sports/** may import it — @seazn/engine ships with zero
// runtime dependencies.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { foldMatch, isCoreEventType, type EventEnvelope } from "../core/events.ts";
import type { LineupPair, StageCtx } from "../core/types.ts";
import { resolvePositions } from "../sport/catalog.ts";
import type { AnySportModule } from "../sport/module.ts";
import { buildStream, defaultLineupPair, makeEnvelope } from "./helpers.ts";

// ---------------------------------------------------------------- generation

/** Streams shorter than this are "trivial" — a module that can reach it must. */
export const MIN_EVENTS = 20;
/** Hard cap on a recorded stream (keeps the committed corpus a sane size). */
export const MAX_EVENTS = 40;
/** Seeds always recorded, long or short — these catch the early-exit branches
 *  (forfeit / abandon / instant result) that a length filter would discard. */
const COVERAGE_SEEDS = 3;
/** Extra seeds picked purely for length, scanning up to SEED_SCAN. */
const LONG_PICKS = 2;
const SEED_SCAN = 500;
/** Modules that decide in one or two events by design (boardgame, generic)
 *  cannot give depth, so they get breadth instead: enough seeds that every
 *  branch of the result union — win / draw / agreement / forfeit / abandon —
 *  lands in the corpus. */
const SHORT_FALLBACK_SEEDS = 24;
/** Cap on configs per module (default + named variants + EXTRA_CONFIGS). */
const MAX_CONFIGS = 4;

/** Stage contexts standingsDelta is recorded under. */
const STAGE_CTXS: StageCtx[] = [{ kind: "league" }, { kind: "knockout" }];

// Hand-picked configs that no `variants` entry reaches but that own real fold
// paths. Football's pre-existing golden covered extra-time + shootout and the
// group-stage shootout points split; keeping them here preserves that coverage
// through the migration onto this harness.
const EXTRA_CONFIGS: Record<string, Record<string, unknown>> = {
  football: {
    knockout: { extraTime: { enabled: true, halfMinutes: 15 }, shootout: true },
    groupSO: {
      shootout: true,
      points: { win: 3, draw: 1, loss: 0, shootoutWin: 2, shootoutLoss: 1 },
    },
  },
};

// Where each module's golden lives: next to its implementation. The setbased
// trio share one directory, so the file name (not the directory) is the key.
const SPORT_DIRS: Record<string, string> = {
  football: "football",
  cricket: "cricket",
  boardgame: "boardgame",
  carrom: "carrom",
  generic: "generic",
  volleyball: "setbased",
  badminton: "setbased",
  tabletennis: "setbased",
  tennis: "tennis",
  icehockey: "icehockey",
  hockey: "hockey",
};

const HERE = dirname(fileURLToPath(import.meta.url));

export function goldenPath(key: string): string {
  const dir = SPORT_DIRS[key];
  if (dir === undefined) {
    throw new Error(`no golden directory registered for sport module "${key}"`);
  }
  return join(HERE, "..", "sports", dir, `${key}.golden.json`);
}

// ------------------------------------------------------------------- corpus

export interface GoldenEvent {
  type: string;
  payload: unknown;
}

export interface GoldenStream {
  /** Key into GoldenCorpus.configs. */
  config: string;
  seed: number;
  events: GoldenEvent[];
  /** JSON of the folded state after each event — states[i] is the fold of
   *  events[0..i]. Length always equals events.length. */
  states: string[];
  /** JSON of module.outcome(finalState) — "null" while undecided. */
  outcome: string;
  /** JSON of module.summary(finalState). */
  summary: string;
  /** JSON of { [stageKind]: [homeDelta, awayDelta] | null }. */
  deltas: string;
}

export interface GoldenCorpus {
  key: string;
  /** The module version the corpus was recorded against. Replay asserts
   *  golden.version <= module.version — minor bumps are expected. */
  version: string;
  recordedBy: "testkit/golden.ts";
  params: { minEvents: number; maxEvents: number };
  /** Config name -> the RAW config object, re-parsed at replay time. */
  configs: Record<string, unknown>;
  streams: GoldenStream[];
}

// ------------------------------------------------------------------ recording

function configsFor(module: AnySportModule): Record<string, unknown> {
  const extra = EXTRA_CONFIGS[module.key] ?? {};
  const candidates: [string, unknown][] = [
    ["default", {}],
    ...Object.entries(extra),
    ...Object.entries(module.variants as Record<string, unknown>),
  ];
  const out: Record<string, unknown> = {};
  const seen = new Set<string>();
  for (const [name, raw] of candidates) {
    let fingerprint: string;
    try {
      fingerprint = JSON.stringify(module.configSchema.parse(raw));
    } catch {
      continue; // e.g. generic has no valid empty config — its variants cover it
    }
    if (seen.has(fingerprint)) continue; // 11-a-side ≡ football's default
    seen.add(fingerprint);
    out[name] = raw;
    if (Object.keys(out).length >= MAX_CONFIGS) break;
  }
  if (Object.keys(out).length === 0) {
    throw new Error(`module "${module.key}" has no parseable config`);
  }
  return out;
}

function seedsFor(module: AnySportModule, cfg: unknown, lineups: LineupPair): number[] {
  const picks = new Set<number>();
  for (let seed = 1; seed <= COVERAGE_SEEDS; seed++) picks.add(seed);
  let long = 0;
  for (let seed = 1; seed <= SEED_SCAN && long < LONG_PICKS; seed++) {
    if (buildStream(module, cfg, lineups, seed, MAX_EVENTS).length >= MIN_EVENTS) {
      picks.add(seed);
      long++;
    }
  }
  if (long === 0) {
    for (let seed = 1; seed <= SHORT_FALLBACK_SEEDS; seed++) picks.add(seed);
  }
  return [...picks].sort((a, b) => a - b);
}

/** Recomputes everything a GoldenStream records, from the module as it is
 *  RIGHT NOW. Replay compares this against the committed values; recording
 *  simply stores it. Deliberately never calls arbitraryEvent — a recorded
 *  corpus must be independent of the generator. */
export function recomputeStream(
  module: AnySportModule,
  rawConfig: unknown,
  events: readonly GoldenEvent[],
): Pick<GoldenStream, "states" | "outcome" | "summary" | "deltas"> {
  const cfg = module.configSchema.parse(rawConfig);
  const lineups = defaultLineupPair(resolvePositions(module, cfg));
  const envelopes: EventEnvelope[] = events.map((event, i) => makeEnvelope(i, event));

  const states = envelopes.map((_, i) =>
    JSON.stringify(foldMatch(module, cfg, lineups, envelopes.slice(0, i + 1))),
  );
  const finalState = foldMatch(module, cfg, lineups, envelopes);
  const outcome = module.outcome(finalState);

  const deltas: Record<string, unknown> = {};
  for (const ctx of STAGE_CTXS) {
    deltas[ctx.kind] =
      outcome === null || (outcome.kind === "draw" && !module.supportsDraws(cfg, ctx.kind))
        ? null
        : module.standingsDelta(outcome, cfg, ctx, finalState);
  }

  return {
    states,
    outcome: JSON.stringify(outcome ?? null),
    summary: JSON.stringify(module.summary(finalState)),
    deltas: JSON.stringify(deltas),
  };
}

export function buildCorpus(module: AnySportModule): GoldenCorpus {
  const configs = configsFor(module);
  const streams: GoldenStream[] = [];

  for (const [name, raw] of Object.entries(configs)) {
    const cfg = module.configSchema.parse(raw);
    const lineups = defaultLineupPair(resolvePositions(module, cfg));
    for (const seed of seedsFor(module, cfg, lineups)) {
      const envelopes = buildStream(module, cfg, lineups, seed, MAX_EVENTS);
      const events: GoldenEvent[] = envelopes.map((e) => ({ type: e.type, payload: e.payload }));
      streams.push({ config: name, seed, events, ...recomputeStream(module, raw, events) });
    }
  }

  return {
    key: module.key,
    version: module.version,
    recordedBy: "testkit/golden.ts",
    params: { minEvents: MIN_EVENTS, maxEvents: MAX_EVENTS },
    configs,
    streams,
  };
}

// --------------------------------------------------------------------- io

export const UPDATE_GOLDEN = process.env.UPDATE_GOLDEN === "1";

export function readCorpus(key: string): GoldenCorpus {
  return JSON.parse(readFileSync(goldenPath(key), "utf8")) as GoldenCorpus;
}

export function writeCorpus(corpus: GoldenCorpus): void {
  writeFileSync(goldenPath(corpus.key), `${JSON.stringify(corpus, null, 0)}\n`);
}

// ------------------------------------------------------------- comparison
//
// W4 (#407) — the recorded state carries the module's parsed `cfg` inside it,
// so comparing the two JSON strings byte-for-byte made the harness reject a
// change it exists to bless: adding an OPTIONAL config knob with a zod
// `.default()` shifts the resolved cfg and would red every stream for that
// module, though it cannot change a single fold. That pushed the period family
// into a compile-time preset field instead of a config field — a workaround for
// a harness defect.
//
// So `cfg` is compared as a SUBSET: every key the golden recorded must still be
// present with an identical value, while new keys are allowed. Everything else
// — key order included — stays exact string equality, because that is the fold
// itself.

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** First path at which `expected` is not reproduced by `actual`, or null.
 *  Objects are subsets (extra keys in `actual` are fine); arrays must match
 *  element for element; leaves must be identical. */
function subsetMismatch(actual: unknown, expected: unknown, path: string): string | null {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return `${path}: expected an array, got ${JSON.stringify(actual)}`;
    if (actual.length !== expected.length) {
      return `${path}: expected ${expected.length} entries, got ${actual.length}`;
    }
    for (let i = 0; i < expected.length; i++) {
      const hit = subsetMismatch(actual[i], expected[i], `${path}[${i}]`);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) return `${path}: expected an object, got ${JSON.stringify(actual)}`;
    for (const [key, value] of Object.entries(expected)) {
      if (!Object.hasOwn(actual, key)) return `${path}.${key}: recorded key is gone`;
      const hit = subsetMismatch(actual[key], value, `${path}.${key}`);
      if (hit !== null) return hit;
    }
    return null;
  }
  return Object.is(actual, expected)
    ? null
    : `${path}: recorded ${JSON.stringify(expected)}, replayed ${JSON.stringify(actual)}`;
}

/** Everything but `cfg`, re-serialised in the order it was parsed — so the
 *  non-config half of the state stays an exact string comparison. */
function withoutCfg(state: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(state).filter(([k]) => k !== "cfg")));
}

/** Why a replayed state differs from the recorded one, or null if it does not.
 *  Exact everywhere except `cfg`, which is a subset (see the note above). */
export function stateMismatch(actual: string, expected: string): string | null {
  if (actual === expected) return null;

  let parsedActual: unknown;
  let parsedExpected: unknown;
  try {
    parsedActual = JSON.parse(actual);
    parsedExpected = JSON.parse(expected);
  } catch {
    return `state is not JSON: recorded ${expected}, replayed ${actual}`;
  }
  // Only a state that RECORDED a cfg gets the subset rule; anything else is a
  // plain fold and must reproduce byte for byte.
  if (
    !isPlainObject(parsedActual) ||
    !isPlainObject(parsedExpected) ||
    !Object.hasOwn(parsedExpected, "cfg")
  ) {
    return `recorded ${expected}, replayed ${actual}`;
  }

  const rest = withoutCfg(parsedActual);
  const expectedRest = withoutCfg(parsedExpected);
  if (rest !== expectedRest) return `state outside cfg: recorded ${expectedRest}, replayed ${rest}`;

  return subsetMismatch(parsedActual.cfg, parsedExpected.cfg, "cfg");
}

/** Every non-core payload in the corpus, for the additive-only tripwire. */
export function sportPayloads(corpus: GoldenCorpus): { type: string; payload: unknown }[] {
  return corpus.streams
    .flatMap((stream) => stream.events)
    .filter((event) => !isCoreEventType(event.type) && !event.type.startsWith("core."));
}

/** Distinct event-type literals the corpus exercises (core.* included). */
export function eventTypesIn(corpus: GoldenCorpus): string[] {
  return [...new Set(corpus.streams.flatMap((s) => s.events.map((e) => e.type)))].sort();
}
