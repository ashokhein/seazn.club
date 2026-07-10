// Set-end boundary matrix — v3/09 §1 (PROMPT-38). The founder-reported
// badminton defects: (a) summary diverging from the event ledger, (b) set-end
// rules around deuce and the cap. The same parametric kernel drives badminton,
// table tennis and volleyball, so the matrix runs on all three presets — a
// preset-parameter bug here is probably shared (v3/09 §1b).
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { foldMatch, type EventEnvelope } from "../../core/events.ts";
import { mulberry32 } from "../../core/rng.ts";
import type { ModuleEvent } from "../../sport/module.ts";
import { defaultLineupPair, makeEnvelope } from "../../testkit/helpers.ts";
import { badminton } from "./badminton.ts";
import { tabletennis } from "./tabletennis.ts";
import { volleyball } from "./volleyball.ts";
import type { SetBasedState } from "./kernel.ts";

// Drive one rally set to exactly (h, a) alternating trailing points so no
// intermediate score is terminal by accident (winner's points last).
function ralliesTo(rallyType: string, h: number, a: number): ModuleEvent[] {
  const out: ModuleEvent[] = [];
  const lo = Math.min(h, a);
  for (let i = 0; i < lo; i++) {
    out.push({ type: rallyType, payload: { wonBy: "H" } });
    out.push({ type: rallyType, payload: { wonBy: "A" } });
  }
  const leader = h > a ? "H" : "A";
  for (let i = 0; i < Math.abs(h - a); i++) {
    out.push({ type: rallyType, payload: { wonBy: leader } });
  }
  return out;
}

function fold(module: typeof badminton, events: ModuleEvent[], cfg: unknown = {}) {
  const envs: EventEnvelope[] = events.map((e, i) => makeEnvelope(i, e));
  return foldMatch(module, module.configSchema.parse(cfg), defaultLineupPair(module.positions), [
    makeEnvelope(0, { type: "core.start", payload: {} }),
    ...envs.map((e, i) => ({ ...e, seq: i + 1, id: `e-${i + 1}` })),
  ]);
}

interface MatrixCase {
  score: [number, number];
  ends: boolean;
}

// One preset's boundary matrix: rally streams must end (or not end) the set at
// exactly these scores, and completed-set summaries must accept exactly the
// reachable ones.
function runMatrix(
  module: typeof badminton,
  rally: string,
  summaryType: string,
  cases: MatrixCase[],
  rejectedSummaries: [number, number][],
  cfg: unknown = {},
) {
  describe(`${module.key}: set-end matrix`, () => {
    for (const { score, ends } of cases) {
      const [h, a] = score;
      it(`rally to ${h}-${a} ${ends ? "ends" : "does NOT end"} the set`, () => {
        const state = fold(module, ralliesTo(rally, h, a), cfg) as SetBasedState;
        const set = state.sets[0];
        expect(set, "first set exists").toBeDefined();
        expect(set!.home).toBe(h);
        expect(set!.away).toBe(a);
        expect(set!.closed, `closed at ${h}-${a}`).toBe(ends);
      });
      if (ends) {
        it(`summary ${h}-${a} is accepted as a completed set`, () => {
          const state = fold(module, [{ type: summaryType, payload: { home: h, away: a } }], cfg) as SetBasedState;
          expect(state.sets[0]?.closed).toBe(true);
          expect(state.setsWon.home + state.setsWon.away).toBe(1);
        });
      }
    }
    for (const [h, a] of rejectedSummaries) {
      it(`summary ${h}-${a} is rejected (unreachable/overshoot)`, () => {
        expect(() =>
          fold(module, [{ type: summaryType, payload: { home: h, away: a } }], cfg),
        ).toThrowError(/reachable|INVALID/i);
      });
    }
  });
}

// Badminton (BWF, spec 04 §4): 21, win-by-2 from 20-20, hard cap 30.
runMatrix(
  badminton,
  "badminton.rally",
  "badminton.game.summary",
  [
    { score: [21, 19], ends: true },
    { score: [21, 20], ends: false }, // deuce: 20-20 was passed, needs 2 clear
    { score: [22, 20], ends: true },
    { score: [25, 23], ends: true },
    { score: [29, 28], ends: false }, // margin 1 below the cap
    { score: [30, 29], ends: true }, // golden point AT the cap
    { score: [30, 28], ends: true }, // 29-28 → +1 = win by 2 at 30
    { score: [21, 0], ends: true }, // no skunk rule
  ],
  [
    [31, 30], // beyond the cap
    [22, 19], // decided earlier at 21-19
    [30, 27], // cap score but 29-27 was already terminal
    [20, 18], // not terminal at all
  ],
);

// Table tennis (ITTF, spec 04 §5): 11, win-by-2, NO cap (deuce runs 12-10…).
runMatrix(
  tabletennis,
  "tabletennis.rally",
  "tabletennis.game.summary",
  [
    { score: [11, 9], ends: true },
    { score: [11, 10], ends: false },
    { score: [12, 10], ends: true },
    { score: [15, 13], ends: true }, // uncapped deuce endgame
    { score: [11, 0], ends: true },
  ],
  [
    [12, 9], // decided at 11-9
    [11, 10], // margin 1, no cap to save it
    [13, 10], // decided at 12-10
  ],
);

// Volleyball (FIVB indoor, spec 04 §3): 25, win-by-2, no cap; 5th set to 15.
runMatrix(
  volleyball,
  "volleyball.rally",
  "volleyball.set.summary",
  [
    { score: [25, 23], ends: true },
    { score: [25, 24], ends: false },
    { score: [26, 24], ends: true },
    { score: [32, 30], ends: true },
    { score: [25, 0], ends: true },
  ],
  [
    [26, 23], // decided at 25-23
    [33, 30], // decided at 32-30
  ],
);

// Deciding-set target: volleyball's 5th set plays to 15 — a 15-13 summary must
// close it, and a 25-23 fifth-set summary is an overshoot (decided at 15-13).
describe("volleyball: deciding set uses finalSetTo", () => {
  const summaries = (scores: [number, number][]): ModuleEvent[] =>
    scores.map(([home, away]) => ({ type: "volleyball.set.summary", payload: { home, away } }));

  it("closes the 5th set at 15-13", () => {
    const state = fold(volleyball, [
      ...summaries([[25, 20], [20, 25], [25, 20], [20, 25]]),
      ...summaries([[15, 13]]),
    ]) as SetBasedState;
    expect(state.setsWon).toEqual({ home: 3, away: 2 });
    expect(state.outcome?.kind).toBe("win");
  });

  it("rejects an overshoot in the 5th set (decided earlier under finalSetTo)", () => {
    // 25-20 with a to-15 target: 24-20 was already terminal, so 25-20 is
    // unreachable. (25-23 would be legal — an uncapped deuce from 14-14.)
    expect(() =>
      fold(volleyball, [
        ...summaries([[25, 20], [20, 25], [25, 20], [20, 25]]),
        ...summaries([[25, 20]]),
      ]),
    ).toThrowError(/reachable/i);
  });
});

// Badminton `short` variant (11/15 cap): the cap must follow the variant, not
// the shipped default — a wrong parameter here is the "set ends at the wrong
// score" class of bug.
describe("badminton short variant: 11 with cap 15", () => {
  const cfg = { setTo: 11, finalSetTo: 11, cap: 15 };
  it("golden point at 15-14; 16-15 impossible", () => {
    const state = fold(badminton, ralliesTo("badminton.rally", 15, 14), cfg) as SetBasedState;
    expect(state.sets[0]?.closed).toBe(true);
    expect(() =>
      fold(badminton, [{ type: "badminton.game.summary", payload: { home: 16, away: 15 } }], cfg),
    ).toThrowError(/reachable/i);
  });
});

// Property (v3/09 §1): after EVERY event, the summary of the incrementally
// folded state equals the summary of a from-scratch recount of the same
// prefix. This is the engine half of the "chosen score not reflected in the
// top score" decision tree — any incremental-vs-recount divergence fails here.
describe("summary equals recount-from-events at every prefix", () => {
  for (const module of [badminton, tabletennis, volleyball]) {
    it(`${module.key}: incremental fold and recount agree at every prefix`, () => {
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 10_000 }), (seed) => {
          const cfg = module.configSchema.parse({});
          const pair = defaultLineupPair(module.positions);
          const rng = mulberry32(seed);
          let state = module.init(cfg, pair);
          const events: EventEnvelope[] = [];
          for (let i = 0; i < 200; i++) {
            const next = module.arbitraryEvent?.call(module, state, rng);
            if (!next) break;
            const env = makeEnvelope(events.length, next);
            state = module.apply(state, env as never);
            events.push(env);
            const recount = foldMatch(module, cfg, pair, events);
            expect(JSON.stringify(module.summary(recount as never))).toBe(
              JSON.stringify(module.summary(state as never)),
            );
            if (module.outcome(state as never) !== null) break;
          }
        }),
        { numRuns: Number(process.env.SIM_RUNS ?? 25) },
      );
    });
  }
});
