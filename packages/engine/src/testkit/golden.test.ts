// Back-compat golden replay for every builtin SportModule — W4 step 0.
//
// The corpus in sports/**/<key>.golden.json was frozen against the schemas as
// they were BEFORE the W4 additive extensions. Replaying it proves three
// things the fast-check conformance kit structurally cannot:
//   1. folds are unchanged (per-event state, outcome, summary, standingsDelta);
//   2. payloads recorded under the old schema STILL PARSE under the new one —
//      i.e. the schema change was additive, not a rename/tightening;
//   3. the version only ever moves forward (<=, not ==: minor bumps land next).
//
// Regenerate ONLY when a fold change is intended, and say why in the commit:
//   UPDATE_GOLDEN=1 npx vitest run src/testkit/golden.test.ts
import { describe, expect, it } from "vitest";
import { compareSemver } from "../sport/registry.ts";
import { builtinModules } from "../sports/index.ts";
import {
  EXTEND_GOLDEN,
  MIN_EVENTS,
  REBASELINE_GOLDEN,
  UPDATE_GOLDEN,
  buildCorpus,
  eventTypesIn,
  extendCorpus,
  payloadParseFailures,
  readCorpus,
  rebaselineCorpus,
  recomputeStream,
  sportPayloads,
  stateMismatch,
  tierEventTypes,
  uncoveredTierTypes,
  writeCorpus,
} from "./golden.ts";

if (UPDATE_GOLDEN) {
  describe("golden corpus regeneration (UPDATE_GOLDEN=1)", () => {
    for (const module of builtinModules) {
      it(`records ${module.key}`, () => {
        const corpus = buildCorpus(module);
        writeCorpus(corpus);
        expect(corpus.streams.length).toBeGreaterThan(0);
      });
    }
  });
} else if (EXTEND_GOLDEN) {
  // Coverage extension (#429 / W4 review item 3). APPENDS streams that reach
  // the fidelity-tier event types no recorded stream ever exercised; every
  // existing stream is preserved byte for byte, which the assertion below is
  // the whole point of.
  describe("golden corpus coverage extension (EXTEND_GOLDEN=1)", () => {
    for (const module of builtinModules) {
      it(`extends ${module.key} without replacing anything`, () => {
        const before = readCorpus(module.key);
        const { corpus, gained, stillMissing, appended } = extendCorpus(module, before);
        expect(corpus.streams.slice(0, before.streams.length)).toEqual(before.streams);
        // eslint-disable-next-line no-console
        console.log(
          `[extend] ${module.key}: +${appended.length} streams ${JSON.stringify(appended)} ` +
            `gained ${JSON.stringify(gained)} stillMissing ${JSON.stringify(stillMissing)}`,
        );
        if (appended.length > 0) writeCorpus(corpus);
      });
    }
  });
} else if (REBASELINE_GOLDEN) {
  // Same ledger, recomputed fold (#429). Every recorded EVENT survives; only
  // the derived states/outcome/summary/deltas move, so the commit diff is the
  // behaviour change itself and nothing hides inside a fresh generator walk.
  describe("golden corpus re-baseline (REBASELINE_GOLDEN=1)", () => {
    for (const module of builtinModules) {
      it(`re-folds ${module.key} without touching its events`, () => {
        const before = readCorpus(module.key);
        const after = rebaselineCorpus(module, before);
        expect(after.streams.map((s) => s.events)).toEqual(before.streams.map((s) => s.events));
        writeCorpus(after);
      });
    }
  });
} else {
  // Every builtin gets a golden — a module added without one fails here rather
  // than silently shipping with no back-compat tripwire.
  describe("golden coverage", () => {
    it("every builtin module has a committed golden corpus", () => {
      const missing = builtinModules
        .filter((module) => {
          try {
            readCorpus(module.key);
            return false;
          } catch {
            return true;
          }
        })
        .map((module) => module.key);
      expect(missing).toEqual([]);
      expect(builtinModules.length).toBe(11);
    });
  });

  for (const module of builtinModules) {
    describe(`golden replay — ${module.key}`, () => {
      const corpus = readCorpus(module.key);

      it("was recorded for this module at a version no newer than the live one", () => {
        expect(corpus.key).toBe(module.key);
        // NOT equality: W4 bumps every module's minor. A golden recorded on a
        // NEWER version than the code means the corpus outran the module.
        expect(
          compareSemver(corpus.version, module.version),
          `golden ${corpus.version} vs module ${module.version}`,
        ).toBeLessThanOrEqual(0);
      });

      it("carries a non-trivial corpus", () => {
        const lengths = corpus.streams.map((stream) => stream.events.length);
        const total = lengths.reduce((a, b) => a + b, 0);
        const types = eventTypesIn(corpus);
        expect(corpus.streams.length).toBeGreaterThanOrEqual(3);
        expect(total, "total recorded events").toBeGreaterThanOrEqual(MIN_EVENTS);
        // More than one event-type literal, always — a single-branch corpus
        // would pin nothing about the union.
        expect(types.length, `event types: ${types.join(",")}`).toBeGreaterThan(1);
        // Modules whose generator can reach a long rally must record one.
        // boardgame + generic decide in a single result event by design.
        const canGoLong = !["boardgame", "generic"].includes(module.key);
        if (canGoLong) {
          expect(Math.max(...lengths), "longest recorded stream").toBeGreaterThanOrEqual(
            MIN_EVENTS,
          );
          expect(types.length).toBeGreaterThan(2);
        }
        for (const stream of corpus.streams) {
          expect(stream.states).toHaveLength(stream.events.length);
        }
      });

      it("every recorded payload still parses against the branch apply selects", () => {
        expect(sportPayloads(corpus).length, "sport payloads in corpus").toBeGreaterThan(0);
        for (const stream of corpus.streams) {
          const failures = payloadParseFailures(
            module,
            corpus.configs[stream.config],
            stream.events,
            stream.lineups,
          );
          expect(
            failures.map((f) => `#${f.index} ${f.type}: ${JSON.stringify(f.issues)}`),
            `${module.key} config=${stream.config} seed=${stream.seed} — a recorded ` +
              `payload no longer parses against its own branch (schema change was ` +
              `not additive)`,
          ).toEqual([]);
        }
      });

      it("replays every committed stream to identical state, outcome and summary", () => {
        for (const stream of corpus.streams) {
          const raw = corpus.configs[stream.config];
          const label = `${module.key} config=${stream.config} seed=${stream.seed}`;
          const actual = recomputeStream(module, raw, stream.events, stream.lineups);
          for (let i = 0; i < stream.states.length; i++) {
            // Exact everywhere except `cfg`, which is compared as a subset: a
            // new OPTIONAL config knob is additive and must not red a corpus it
            // cannot affect (W4 item 5). A changed value on a recorded cfg key,
            // and every fold change, still reds — golden-compare.test.ts pins
            // that both ways.
            expect(
              stateMismatch(actual.states[i] as string, stream.states[i] as string),
              `${label} state after event ${i} (${stream.events[i]?.type})`,
            ).toBeNull();
          }
          expect(actual.outcome, `${label} outcome`).toBe(stream.outcome);
          expect(actual.summary, `${label} summary`).toBe(stream.summary);
          expect(actual.deltas, `${label} standingsDelta`).toBe(stream.deltas);
        }
      });
    });
  }
}
