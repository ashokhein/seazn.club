// Undo sweep — v3/09 §2 (PROMPT-38). For EVERY sport module and EVERY event
// position of a simulated match: append a core.void of that event and assert
// the fold either rejects it with a typed EngineError (ledger unchanged) or
// yields a state whose summary is renderable — headline string, two perSide
// lines — and from which scoring can continue to a decision. The cricket
// "undo last made scoring disappear" regression (intake #29) is exactly a
// fold that neither rejected nor produced a renderable state.
import { describe, expect, it } from "vitest";
import { EngineError } from "../core/errors.ts";
import { foldMatch, type EventEnvelope } from "../core/events.ts";
import { mulberry32 } from "../core/rng.ts";
import type { LineupPair, MatchOutcome, ScoreSummary } from "../core/types.ts";
import type { AnySportModule, ModuleEvent } from "../sport/module.ts";
import { builtinModules } from "../sports/index.ts";
import { defaultLineupPair, makeEnvelope } from "./helpers.ts";
import { deriveSeed, SIM_CONFIGS } from "./simulation.ts";

const SWEEP_SEEDS = Number(process.env.SIM_RUNS ?? (process.env.CI ? 12 : 4));

// Walk the module's generator to a decision (chaos.test.ts pattern).
function decidedStream(
  module: AnySportModule,
  cfg: unknown,
  lineups: LineupPair,
  seed: number,
): EventEnvelope[] | null {
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
    if (module.outcome(state) !== null) return events;
  }
  return null;
}

// A summary the scoring panel can always render (spec 03 §3 summary contract).
function expectRenderable(module: AnySportModule, summary: ScoreSummary, label: string): void {
  expect(typeof summary.headline, `${label}: headline must be a string`).toBe("string");
  expect(summary.perSide.length, `${label}: perSide must list both sides`).toBe(2);
  for (const side of summary.perSide) {
    expect(typeof side.entrantId, `${label}: perSide entrantId`).toBe("string");
    expect(typeof side.line, `${label}: perSide line`).toBe("string");
  }
}

for (const module of builtinModules) {
  const cfg = module.configSchema.parse(SIM_CONFIGS[module.key] ?? {});
  const lineups = defaultLineupPair(module.positions);

  describe(`undo sweep — ${module.key}@${module.version}`, () => {
    it(
      "undo of every event position folds to a renderable state or a typed rejection, then scoring continues",
      { timeout: 120_000 },
      () => {
        let exercised = 0;
        for (let seed = 1; exercised < SWEEP_SEEDS && seed <= SWEEP_SEEDS * 4; seed++) {
          const events = decidedStream(module, cfg, lineups, deriveSeed(seed, module.key, "undo-sweep"));
          if (events === null) continue;
          exercised++;

          for (let i = 0; i < events.length; i++) {
            const target = events[i] as EventEnvelope;
            const label = `${module.key} seed=${seed} void seq=${i} (${target.type})`;
            const withVoid = [
              ...events,
              makeEnvelope(events.length, { type: "core.void", payload: {} }, target.id),
            ];

            let state: unknown;
            try {
              state = foldMatch(module, cfg, lineups, withVoid);
            } catch (err) {
              // A rejection is legal — but it MUST be a typed EngineError, and
              // the pre-void ledger must still fold (ledger never corrupted).
              expect(
                EngineError.is(err),
                `${label}: fold threw a non-EngineError: ${String(err)}`,
              ).toBe(true);
              expect(() => foldMatch(module, cfg, lineups, events), `${label}: baseline refold`).not.toThrow();
              continue;
            }

            // Accepted void → summary + outcome must be derivable (the panel
            // renders these; a throw here is the blank-screen bug).
            let summary: ScoreSummary | undefined;
            expect(() => {
              summary = module.summary(state as never);
            }, `${label}: summary() must not throw after an accepted void`).not.toThrow();
            expectRenderable(module, summary as ScoreSummary, label);
            let outcome: MatchOutcome | null = null;
            expect(() => {
              outcome = module.outcome(state as never);
            }, `${label}: outcome() must not throw after an accepted void`).not.toThrow();

            // Scoring must be able to CONTINUE on the post-undo state: the
            // generator resumes and every generated event applies cleanly.
            if (outcome === null) {
              const rng = mulberry32(deriveSeed(seed, module.key, "undo-resume", i));
              let resumed = state;
              let decided = false;
              for (let n = 0; n < 600 && !decided; n++) {
                const next = module.arbitraryEvent?.call(module, resumed as never, rng) as ModuleEvent | null;
                if (next === null || next === undefined) break;
                const env = makeEnvelope(withVoid.length + n, next);
                try {
                  resumed = module.apply(resumed as never, env);
                } catch (err) {
                  expect(
                    EngineError.is(err),
                    `${label}: resume apply threw non-EngineError: ${String(err)}`,
                  ).toBe(true);
                  break;
                }
                decided = module.outcome(resumed as never) !== null;
              }
              expect(() => module.summary(resumed as never), `${label}: post-resume summary`).not.toThrow();
            }
          }
        }
        expect(exercised, "generator must reach decisions or the sweep proves nothing").toBeGreaterThan(0);
      },
    );

    it("undoing with nothing to undo is a typed rejection, never a crash", () => {
      // core.void as the only event: no prior target can exist.
      const orphanVoid = [makeEnvelope(0, { type: "core.void", payload: {} }, "no-such-event")];
      let thrown: unknown;
      try {
        foldMatch(module, cfg, lineups, orphanVoid);
      } catch (err) {
        thrown = err;
      }
      expect(EngineError.is(thrown), `expected typed EngineError, got ${String(thrown)}`).toBe(true);

      // core.void without any target id at all.
      const bareVoid = [makeEnvelope(0, { type: "core.void", payload: {} })];
      let bare: unknown;
      try {
        foldMatch(module, cfg, lineups, bareVoid);
      } catch (err) {
        bare = err;
      }
      expect(EngineError.is(bare), `expected typed EngineError, got ${String(bare)}`).toBe(true);
    });
  });
}
