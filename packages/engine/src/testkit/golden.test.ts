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
  configStateKey,
  corpusStateDiff,
  corpusWriteGuard,
  declaredOptionalConfigFields,
  declaredOptionalFields,
  eventTypesIn,
  extendCorpus,
  formatCorpusStateDiff,
  payloadParseFailures,
  readCorpus,
  reachableStatePaths,
  rebaselineCorpus,
  recomputeStream,
  recordedStatePaths,
  sportPayloads,
  staleUnreachableConfigFields,
  staleUnreachableFields,
  staleUnreachableStatePaths,
  stateMismatch,
  tierEventTypes,
  uncoveredConfigFields,
  uncoveredStatePaths,
  uncoveredTierFields,
  uncoveredTierTypes,
  unreachableStatePathsGoneStale,
  writeCorpus,
} from "./golden.ts";

// #429 — the corpus-write guard. Both modes that rewrite a committed corpus are
// gated on a working tree that holds NOTHING but corpus changes, because the
// policy they exist under ("deliberate, isolated in its own commit, reviewed as
// a state diff" — see GOLDEN-POLICY.md) is unverifiable otherwise: a re-baseline
// landed on top of a half-finished branch produces a commit in which no reader
// can tell which state moved because the fold changed. The guard runs BEFORE any
// writing test is registered, so a refusal cannot half-write the corpus.
const corpusWriteRefusal =
  UPDATE_GOLDEN || REBASELINE_GOLDEN ? (() => {
    const verdict = corpusWriteGuard();
    return verdict.ok ? null : verdict.reason;
  })() : null;

if (corpusWriteRefusal !== null) {
  describe("golden corpus write guard (#429)", () => {
    it("refuses to rewrite the corpus from a dirty working tree", () => {
      expect.fail(corpusWriteRefusal);
    });
  });
} else if (UPDATE_GOLDEN) {
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
  // Coverage extension (#429 / W4 review item 3, widened by W4a T10). APPENDS
  // streams that reach the fidelity-tier event types no recorded stream ever
  // exercised AND the optional payload fields no recorded stream ever wrote;
  // every existing stream is preserved byte for byte, which the assertion below
  // is the whole point of.
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
        // The third clause of the policy, made mechanical: print WHAT MOVED —
        // per stream, which step indices and which top-level state keys, plus
        // whether outcome/summary/deltas moved. That printout is the state diff
        // a reviewer is supposed to be reviewing.
        const diff = corpusStateDiff(before, after);
        expect(diff.eventsMoved, `${module.key}: a re-baseline must keep the ledger`).toBe(false);
        // eslint-disable-next-line no-console
        console.log(formatCorpusStateDiff(diff));
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

      // W4 review item 3 — `types.length > 2` was the whole coverage claim, and
      // it was nowhere near what the gate advertised: football recorded 4 of
      // its 7 declared tier types, cricket 3 of 15, so adding a required field
      // to the PRE-EXISTING FootballSub left all 45 golden tests green. A
      // module's `fidelityTiers` is its own claim about what a scorer can
      // record; every one of those types has to be in the corpus or the
      // back-compat tripwire simply does not cover it.
      //
      // LIMIT — this is TYPE coverage, and one recorded event of a type
      // satisfies it. That is enough to red a new REQUIRED field on the branch
      // (the recorded payload stops parsing) and nothing more: a narrowed enum,
      // a tightened `min`, or a renamed optional key reds only if some recorded
      // payload actually carries the value. It did not: `converted: false` was
      // dropped from the hockey and icehockey corpora during the W4 rename with
      // nothing put back, leaving one set piece per period sport with `outcome`
      // ABSENT — so no AttemptOutcome token was covered at all and `scored`
      // never incremented in any replay. The FIELD assertion below is that
      // second dimension (W4a T10); read a green HERE as "every type appears".
      it("records every event type the module declares in a fidelity tier", () => {
        const missing = uncoveredTierTypes(module, corpus);
        expect(
          missing,
          `${module.key} declares ${tierEventTypes(module).length} tier event types and its ` +
            `corpus never exercises ${missing.length} of them, so a tightening of those ` +
            `branches would not red anything. Extend the corpus: ` +
            `EXTEND_GOLDEN=1 npx vitest run src/testkit/golden.test.ts`,
        ).toEqual([]);
      });

      // W4a (#425) T10 — the FIELD dimension, and the one the wave's own
      // deliverable was blind to. `at` was added to eleven modules and to every
      // generator, and after the sanctioned EXTEND_GOLDEN pass 0 of football's
      // 274 and 0 of icehockey's 148 recorded events carried it: both already
      // covered every TYPE they declare, so `extendCorpus` appended nothing for
      // them, and a generator that starts emitting a field does not
      // retroactively reach a frozen corpus. Old payloads without `at` still
      // fold byte-identically — that much was genuinely proven — but a FUTURE
      // tightening (making `at` required, renaming it, reshaping `GameTime`,
      // narrowing `DurationSeconds`) reddened nothing at all.
      //
      // LIMIT, and it is a real one: the paths are pooled across the whole event
      // union, because its branches carry no discriminator (see
      // `declaredOptionalFields`). A green here means SOME recorded payload
      // writes the field, not that every branch declaring it has one.
      it("writes every optional payload field the module's event union declares", () => {
        const missing = uncoveredTierFields(module, corpus);
        expect(
          missing,
          `${module.key} declares ${declaredOptionalFields(module).length} optional payload ` +
            `fields and its corpus never writes ${missing.length} of them, so renaming, ` +
            `reshaping or narrowing those fields would not red anything. Extend the corpus: ` +
            `EXTEND_GOLDEN=1 npx vitest run src/testkit/golden.test.ts — and for a field no ` +
            `seeded walk of arbitraryEvent can reach, add a COVERAGE_CONFIGS entry, or an ` +
            `UNREACHABLE_FIELDS entry stating WHY it cannot be reached.`,
        ).toEqual([]);
      });

      // The other half of that gate. An exemption that the ledger has since
      // started writing is stale: it reads as a considered decision while
      // suppressing nothing, which is how an allow-list rots into a rubber stamp.
      it("allow-lists no optional field the corpus actually writes", () => {
        expect(
          staleUnreachableFields(module, corpus),
          `${module.key}: UNREACHABLE_FIELDS claims these cannot be reached, but the ` +
            `corpus writes them — delete the entries`,
        ).toEqual([]);
      });

      // T2 (#425 follow-up) — the CONFIG dimension. The two tests above ask the
      // additive question of `eventSchema`; nothing asked it of `configSchema`,
      // so a knob no recorded config sets and no frozen state carries could be
      // narrowed, renamed or reshaped with all eleven corpora green. Every W4a
      // config addition was in exactly that position: `subWindows`,
      // `periodSeconds`, `clock.delay`, `releaseOnGoal`.
      //
      // LIMIT: a knob pinned only by the frozen state (a `.default()` no config
      // overrides) is guarded against a rename or a changed value, not against
      // a domain narrowing that still admits the default. `pinnedConfigFields`
      // spells out which pin is which.
      it("pins every optional config field the module's config schema declares", () => {
        const missing = uncoveredConfigFields(module, corpus);
        expect(
          missing,
          `${module.key} declares ${declaredOptionalConfigFields(module).length} optional ` +
            `config fields and its corpus pins ${missing.length} of them nowhere — no ` +
            `recorded config sets them and no frozen state carries them, so narrowing, ` +
            `renaming or reshaping those knobs would not red anything. Add a ` +
            `COVERAGE_CONFIGS entry that sets them and extend the corpus: ` +
            `EXTEND_GOLDEN=1 npx vitest run src/testkit/golden.test.ts — or an ` +
            `UNREACHABLE_CONFIG_FIELDS entry stating WHY no config can set them.`,
        ).toEqual([]);
      });

      it("allow-lists no config field the corpus actually pins", () => {
        expect(
          staleUnreachableConfigFields(module, corpus),
          `${module.key}: UNREACHABLE_CONFIG_FIELDS claims these cannot be reached, but ` +
            `the corpus pins them — delete the entries`,
        ).toEqual([]);
      });

      // T2 (#425 follow-up) — the STATE dimension, and the one with no schema
      // behind it. `stateMismatch` already compares everything outside `cfg` as
      // exact string equality, so any path the corpus WRITES is fully pinned in
      // both directions. A path it never writes is pinned by nothing, and that
      // was where the wave's own state fields sat: `overran` / `overCount` need
      // a `cfg.interruptions` allowance no shipped variant declares, and
      // football's `at` stamp reached cards and shoot-out penalties in the live
      // generator while no frozen stream carried one.
      //
      // The declared side is a seeded sweep of the module's OWN generator (see
      // the section note in golden.ts) — there is no `stateSchema` to walk.
      it("records every state path its own generator can still reach", () => {
        const missing = uncoveredStatePaths(module, corpus);
        expect(
          missing,
          `${module.key}: its generator can reach ${reachableStatePaths(module, corpus).length} ` +
            `state paths and the corpus records ${recordedStatePaths(module, corpus).length}; ` +
            `${missing.length} live-reachable paths are written by no frozen stream, so ` +
            `narrowing or renaming those state fields would red nothing. Extend the ` +
            `corpus: EXTEND_GOLDEN=1 npx vitest run src/testkit/golden.test.ts — or add an ` +
            `UNREACHABLE_STATE_PATHS entry stating WHY no stream can record them.`,
        ).toEqual([]);
      });

      it("allow-lists no state path the corpus records, nor one nothing reaches", () => {
        expect(
          staleUnreachableStatePaths(module, corpus),
          `${module.key}: UNREACHABLE_STATE_PATHS claims these cannot be recorded, but ` +
            `the corpus records them — delete the entries`,
        ).toEqual([]);
        expect(
          unreachableStatePathsGoneStale(module, corpus),
          `${module.key}: UNREACHABLE_STATE_PATHS names paths no generator can reach at ` +
            `all — the entries suppress nothing and are now noise`,
        ).toEqual([]);
      });

      // The additive-only tripwire. Payloads written under the OLD schema must
      // still satisfy the CURRENT one; a new required field or a renamed key
      // reds this test while every generated conformance run stays green.
      //
      // Against the BRANCH, not the union (W4 review item 2). The union's
      // branches carry no discriminator — the envelope's `type` does, and
      // `apply` is what reads it — so a union parse passes whenever a sibling
      // branch is a superset of the payload. Tightening `PeriodSuspensionEnd`
      // used to leave this green for hockey and icehockey on the strength of
      // `PeriodSuspensionStart` accepting the same shape.
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
          // WHERE the config lives comes from the module (#429 item 4), never
          // from the literal key name "cfg" — see configStateKey.
          const configKey = configStateKey(module, raw, stream.lineups);
          for (let i = 0; i < stream.states.length; i++) {
            // Exact everywhere except `cfg`, which is compared as a subset: a
            // new OPTIONAL config knob is additive and must not red a corpus it
            // cannot affect (W4 item 5). A changed value on a recorded cfg key,
            // and every fold change, still reds — golden-compare.test.ts pins
            // that both ways.
            expect(
              stateMismatch(actual.states[i] as string, stream.states[i] as string, configKey),
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
