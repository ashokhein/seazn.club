// Football golden-replay gate — v6/00 §6.2 / PROMPT-49 task 4. The period-
// kernel extraction must leave football's folds BYTE-IDENTICAL: this suite
// replays a committed corpus of seeded ledgers (generated pre-refactor) and
// compares state, summary, outcome and both StandingsDeltas as serialized
// JSON. If it fails, the refactor changed fold behavior — stop and surface
// (module_version stays 1.0.0 only while this passes).
//
// Regenerate ONLY when intentionally changing football's fold behavior:
//   UPDATE_GOLDEN=1 npx vitest run src/sports/football/football.golden.test.ts
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { foldMatch, type CoreEv, type EventEnvelope } from "../../core/events.ts";
import { mulberry32 } from "../../core/rng.ts";
import type { ModuleEvent } from "../../sport/module.ts";
import type { FootballEv } from "./football.ts";
import { defaultLineupPair, makeEnvelope } from "../../testkit/helpers.ts";
import { football } from "./football.ts";

const GOLDEN_PATH = join(dirname(fileURLToPath(import.meta.url)), "football.golden.json");
const UPDATE = process.env.UPDATE_GOLDEN === "1";

// Three shapes that exercise every phase path: league default (draws),
// knockout (ET + pens through the shared shootout primitive), group-stage
// shootout points split.
const CONFIGS: Record<string, unknown> = {
  league: {},
  knockout: { extraTime: { enabled: true, halfMinutes: 15 }, shootout: true },
  groupSO: { shootout: true, points: { win: 3, draw: 1, loss: 0, shootoutWin: 2, shootoutLoss: 1 } },
};
const SEEDS_PER_CONFIG = 25;
const lineups = defaultLineupPair(football.positions);

interface GoldenEntry {
  config: string;
  seed: number;
  events: { type: string; payload: unknown }[];
  snapshot: string; // JSON of {state, summary, outcome, deltas}
}

function generateStream(cfgKey: string, seed: number): { type: string; payload: unknown }[] {
  const cfg = football.configSchema.parse(CONFIGS[cfgKey]);
  const rng = mulberry32(seed * 7919 + cfgKey.length);
  let state = football.init(cfg, lineups);
  const out: { type: string; payload: unknown }[] = [];
  for (let i = 0; i < 400; i++) {
    const next = football.arbitraryEvent?.(state, rng) as ModuleEvent | null;
    if (next === null || next === undefined) break;
    const env = makeEnvelope(out.length, next) as EventEnvelope<FootballEv | CoreEv>;
    state = football.apply(state, env);
    out.push({ type: env.type, payload: env.payload });
    if (football.outcome(state) !== null) break;
  }
  return out;
}

function snapshotOf(cfgKey: string, events: { type: string; payload: unknown }[]): string {
  const cfg = football.configSchema.parse(CONFIGS[cfgKey]);
  const envs: EventEnvelope[] = events.map((event, i) => makeEnvelope(i, event));
  const state = foldMatch(football, cfg, lineups, envs);
  const outcome = football.outcome(state);
  const summary = football.summary(state);
  const deltas =
    outcome === null || (outcome.kind === "draw" && false)
      ? null
      : outcome.kind === "draw"
        ? football.standingsDelta(outcome, cfg, { kind: "league" }, state)
        : football.standingsDelta(outcome, cfg, { kind: "knockout" }, state);
  return JSON.stringify({ state, summary, outcome, deltas });
}

function generateCorpus(): GoldenEntry[] {
  const corpus: GoldenEntry[] = [];
  for (const cfgKey of Object.keys(CONFIGS)) {
    for (let seed = 1; seed <= SEEDS_PER_CONFIG; seed++) {
      const events = generateStream(cfgKey, seed);
      corpus.push({ config: cfgKey, seed, events, snapshot: snapshotOf(cfgKey, events) });
    }
  }
  return corpus;
}

describe("football golden replay (v6/00 §6.2 gate)", () => {
  if (UPDATE) {
    it("regenerates the golden corpus", () => {
      const corpus = generateCorpus();
      writeFileSync(GOLDEN_PATH, JSON.stringify(corpus));
      expect(corpus.length).toBe(Object.keys(CONFIGS).length * SEEDS_PER_CONFIG);
    });
    return;
  }

  const corpus = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as GoldenEntry[];

  it("carries a full corpus with decided ledgers in every config", () => {
    expect(corpus.length).toBe(Object.keys(CONFIGS).length * SEEDS_PER_CONFIG);
    for (const cfgKey of Object.keys(CONFIGS)) {
      const decided = corpus.filter(
        (entry) => entry.config === cfgKey && JSON.parse(entry.snapshot).outcome !== null,
      );
      expect(decided.length, `${cfgKey}: decided ledgers`).toBeGreaterThan(0);
    }
  });

  it("folds every committed ledger byte-identically", () => {
    for (const entry of corpus) {
      expect(
        snapshotOf(entry.config, entry.events),
        `config=${entry.config} seed=${entry.seed}`,
      ).toBe(entry.snapshot);
    }
  });
});
