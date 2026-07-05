// Chaos scorer — PROMPT-14 §2. Interleaves invalid events (wrong phase,
// unknown entrant, post-decision, malformed/unknown core payloads) into valid
// streams for every shipped module and asserts:
//   1. every injection is rejected with a typed EngineError code, and
//   2. the ledger is never corrupted — refolding the valid stream afterwards
//      reproduces the baseline state and outcome exactly.
import { describe, expect, it } from "vitest";
import { EngineError, EngineErrorCode } from "../core/errors.ts";
import { foldMatch, type EventEnvelope } from "../core/events.ts";
import type { LineupPair } from "../core/types.ts";
import type { AnySportModule, ModuleEvent } from "../sport/module.ts";
import { builtinModules } from "../sports/index.ts";
import { defaultLineupPair, makeEnvelope } from "./helpers.ts";
import { deriveSeed, SIM_CONFIGS } from "./simulation.ts";
import { mulberry32 } from "../core/rng.ts";

const CHAOS_SEEDS = Number(process.env.SIM_RUNS ?? (process.env.CI ? 200 : 25));

interface DecidedStream {
  events: EventEnvelope[];
  decidedAt: number; // index of the event that decided the match
}

// Walk the module's generator until the match decides (like the simulator's
// playFixture, but the chaos suite needs the decision index).
function decidedStream(
  module: AnySportModule,
  cfg: unknown,
  lineups: LineupPair,
  seed: number,
): DecidedStream | null {
  const generate = module.arbitraryEvent;
  if (!generate) throw new Error(`module "${module.key}" lacks arbitraryEvent`);
  const rng = mulberry32(seed);
  let state = module.init(cfg, lineups);
  const events: EventEnvelope[] = [];
  for (let i = 0; i < 600; i++) {
    const next = generate.call(module, state, rng) as ModuleEvent | null;
    if (next === null) break;
    const env = makeEnvelope(events.length, next);
    state = module.apply(state, env);
    events.push(env);
    if (module.outcome(state) !== null) return { events, decidedAt: events.length - 1 };
  }
  return null;
}

// Rebuild an envelope stream with contiguous seqs after an insertion.
function withInserted(
  events: readonly EventEnvelope[],
  index: number,
  event: ModuleEvent,
): EventEnvelope[] {
  const spliced = [...events.slice(0, index), null, ...events.slice(index)];
  return spliced.map((entry, i) =>
    entry === null
      ? { ...makeEnvelope(i, event), id: `chaos-${i}` }
      : { ...entry, seq: i, id: `e-${i}` },
  );
}

function expectTypedRejection(
  module: AnySportModule,
  cfg: unknown,
  lineups: LineupPair,
  events: readonly EventEnvelope[],
  label: string,
): void {
  let thrown: unknown;
  try {
    foldMatch(module, cfg, lineups, events);
  } catch (err) {
    thrown = err;
  }
  expect(EngineError.is(thrown), `${label}: expected a typed EngineError, got ${String(thrown)}`).toBe(
    true,
  );
  expect(() => EngineErrorCode.parse((thrown as EngineError).code)).not.toThrow();
}

for (const module of builtinModules) {
  const cfg = module.configSchema.parse(SIM_CONFIGS[module.key] ?? {});
  const lineups = defaultLineupPair(module.positions);
  const postDecisionSafe = new Set(["core.note", "core.finalize", ...(module.postDecisionTypes ?? [])]);

  describe(`chaos scorer — ${module.key}@${module.version}`, () => {
    it(
      "rejects every interleaved invalid event with a typed code; ledger survives",
      { timeout: Math.max(60_000, CHAOS_SEEDS * 150) },
      () => {
      let exercised = 0;
      for (let seed = 1; seed <= CHAOS_SEEDS && exercised < CHAOS_SEEDS; seed++) {
        const stream = decidedStream(module, cfg, lineups, deriveSeed(seed, module.key, "chaos"));
        if (stream === null) continue;
        exercised++;
        const { events, decidedAt } = stream;
        const baseline = JSON.stringify(foldMatch(module, cfg, lineups, events));
        const rng = mulberry32(deriveSeed(seed, module.key, "chaos-pick"));
        const mid = Math.floor(rng() * (decidedAt + 1));

        // Unknown entrant — a forfeit by someone not in the fixture.
        expectTypedRejection(
          module,
          cfg,
          lineups,
          withInserted(events, mid, {
            type: "core.forfeit",
            payload: { by: "intruder", reason: "chaos" },
          }),
          "unknown entrant",
        );

        // Wrong phase — finalize before the match has decided.
        expectTypedRejection(
          module,
          cfg,
          lineups,
          withInserted(events, 0, { type: "core.finalize", payload: {} }),
          "finalize before decision",
        );

        // Post-decision — replay the deciding event after the decision.
        const decider = events[decidedAt] as EventEnvelope;
        if (!postDecisionSafe.has(decider.type)) {
          expectTypedRejection(
            module,
            cfg,
            lineups,
            [...events, { ...decider, id: `e-${events.length}`, seq: events.length }],
            "post-decision replay",
          );
        }

        // Unknown core namespace event.
        expectTypedRejection(
          module,
          cfg,
          lineups,
          withInserted(events, mid, { type: "core.chaos", payload: {} }),
          "unknown core event",
        );

        // Malformed core payload — forfeit without its required fields.
        expectTypedRejection(
          module,
          cfg,
          lineups,
          withInserted(events, mid, { type: "core.forfeit", payload: {} }),
          "malformed core payload",
        );

        // Ledger never corrupted: the valid stream still folds byte-identically.
        expect(JSON.stringify(foldMatch(module, cfg, lineups, events))).toBe(baseline);
      }
        // The generator must reach decisions or the suite proves nothing.
        expect(exercised).toBeGreaterThan(0);
      },
    );
  });
}
