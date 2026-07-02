// Conformance suite — PROMPT-03 §4. Any module's test file invokes
// conformanceSuite(module) and gets every spec 04 §9 cross-sport invariant
// asserted over property-generated event streams (spec 03 §6).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { foldMatch, resolveVoids, type CoreEv, type EventEnvelope } from "../core/events.ts";
import {
  MatchOutcome,
  MetricSpec,
  ScoreSummary,
  StandingsDelta,
  type LineupPair,
  type StageCtx,
} from "../core/types.ts";
import { PositionCatalog, validateLineup } from "../sport/catalog.ts";
import { FidelityTier, type SportModule } from "../sport/module.ts";
import { parseSemver } from "../sport/registry.ts";
import { buildStream, defaultLineupPair, makeEnvelope } from "./helpers.ts";

export interface ConformanceOpts {
  cfg?: unknown; // raw config, parsed through module.configSchema (default {})
  lineups?: LineupPair; // default: minimal lineups from the position catalog
  stageCtxs?: StageCtx[]; // contexts for standingsDelta (default league + knockout)
  numRuns?: number; // fast-check runs per invariant (default 300)
  maxEvents?: number; // stream length cap (default 40)
  label?: string; // disambiguates multiple suites for one module
}

export function conformanceSuite<Cfg, Ev, State>(
  module: SportModule<Cfg, Ev, State>,
  opts: ConformanceOpts = {},
): void {
  const cfg = module.configSchema.parse(opts.cfg ?? {});
  const lineups = opts.lineups ?? defaultLineupPair(module.positions);
  const stageCtxs = opts.stageCtxs ?? [{ kind: "league" as const }, { kind: "knockout" as const }];
  const numRuns = opts.numRuns ?? 300;
  const maxEvents = opts.maxEvents ?? 40;

  const fold = (events: readonly EventEnvelope[]) => foldMatch(module, cfg, lineups, events);
  // Envelopes from generators carry `unknown` payloads; the module's own
  // generator only emits its Ev | CoreEv union.
  const asModuleEvent = (event: EventEnvelope) => event as EventEnvelope<Ev | CoreEv>;
  const streamArb = fc
    .tuple(fc.nat(), fc.integer({ min: 1, max: maxEvents }))
    .map(([seed, length]) => buildStream(module, cfg, lineups, seed, length));

  // Streams that reached a decision — §9.2/9.3/9.4 need decided outcomes.
  function decidedOnly(events: EventEnvelope[]): { state: State; outcome: MatchOutcome } | null {
    const state = fold(events);
    const outcome = module.outcome(state);
    return outcome === null ? null : { state, outcome };
  }

  const suiteName = `conformance — ${module.key}@${module.version}${opts.label ? ` (${opts.label})` : ""}`;

  describe(suiteName, () => {
    it("declares a well-formed identity (spec 03 §3, doc 14 §2, doc 13 §1)", () => {
      expect(module.key.length).toBeGreaterThan(0);
      parseSemver(module.version); // throws on non-semver
      PositionCatalog.parse(module.positions);
      expect(module.fidelityTiers.length).toBeGreaterThan(0);
      for (const tier of module.fidelityTiers) FidelityTier.parse(tier);
      expect(module.officialLabel.scorer.length).toBeGreaterThan(0);
      for (const metric of module.metrics) MetricSpec.parse(metric);
      expect(module.defaultTiebreakers.length).toBeGreaterThan(0);
      const pointsSets = module.declaredPointsSets(cfg);
      expect(pointsSets.length).toBeGreaterThan(0);
      for (const total of pointsSets) expect(Number.isFinite(total)).toBe(true);
    });

    it("accepts the conformance lineups against its own catalog (spec 02 §3)", () => {
      expect(validateLineup(module.positions, lineups.home)).toEqual([]);
      expect(validateLineup(module.positions, lineups.away)).toEqual([]);
    });

    // §9.1 — apply is pure & total on valid input.
    it("§9.1 init/apply are pure and deterministic", () => {
      expect(module.init(cfg, lineups)).toEqual(module.init(cfg, lineups));
      fc.assert(
        fc.property(streamArb, (events) => {
          expect(fold(events)).toEqual(fold(events));
          // apply must not mutate its input state or the event payload.
          let state = module.init(cfg, lineups);
          for (const event of resolveVoids(events)) {
            const stateBefore = JSON.stringify(state);
            const payloadBefore = JSON.stringify(event.payload ?? null);
            const next = module.apply(state, asModuleEvent(event));
            expect(JSON.stringify(state)).toBe(stateBefore);
            expect(JSON.stringify(event.payload ?? null)).toBe(payloadBefore);
            state = next;
          }
        }),
        { numRuns },
      );
    });

    // §9.2 — outcome never returns to null, never changes identity after
    // decision; post-decision annotations leave it untouched.
    it("§9.2 outcome is monotone and stable after decision", () => {
      fc.assert(
        fc.property(streamArb, (events) => {
          let state = module.init(cfg, lineups);
          let decided: MatchOutcome | null = null;
          for (const event of events) {
            state = module.apply(state, asModuleEvent(event));
            const outcome = module.outcome(state);
            if (decided !== null) {
              expect(outcome).toEqual(decided);
            } else if (outcome !== null) {
              MatchOutcome.parse(outcome);
              decided = outcome;
            }
          }
          if (decided !== null) {
            const annotated = fold([
              ...events,
              makeEnvelope(events.length, { type: "core.note", payload: { text: "conformance" } }),
            ]);
            expect(module.outcome(annotated)).toEqual(decided);
          }
        }),
        { numRuns },
      );
    });

    // §9.3 — Σ points awarded per fixture ∈ the sport's declared set.
    it("§9.3 standingsDelta conserves the declared points sets", () => {
      const allowed = module.declaredPointsSets(cfg);
      let decidedSeen = 0;
      fc.assert(
        fc.property(streamArb, (events) => {
          const decided = decidedOnly(events);
          if (!decided) return;
          decidedSeen++;
          for (const ctx of stageCtxs) {
            if (decided.outcome.kind === "draw" && !module.supportsDraws(cfg, ctx.kind)) continue;
            const [home, away] = module.standingsDelta(decided.outcome, cfg, ctx, decided.state);
            StandingsDelta.parse(home);
            StandingsDelta.parse(away);
            expect(allowed).toContain(home.points + away.points);
          }
        }),
        { numRuns },
      );
      // The generator must actually reach decisions, or §9.2–9.4 prove nothing.
      expect(decidedSeen).toBeGreaterThan(0);
    });

    // §9.4 — integers or exact rationals, never floats: rational metrics are
    // stored as separate integer numerator/denominator keys (NRR: runs_for +
    // balls_faced_eff, spec 04 §2.4) and computed at comparison time.
    it("§9.4 standings deltas carry an integer ledger", () => {
      fc.assert(
        fc.property(streamArb, (events) => {
          const decided = decidedOnly(events);
          if (!decided) return;
          for (const ctx of stageCtxs) {
            if (decided.outcome.kind === "draw" && !module.supportsDraws(cfg, ctx.kind)) continue;
            for (const delta of module.standingsDelta(decided.outcome, cfg, ctx, decided.state)) {
              for (const [key, value] of Object.entries(delta.metrics)) {
                expect(Number.isInteger(value), `metric "${key}" must be an integer`).toBe(true);
              }
              // Points allow exact halves (boardgame draws, spec 04 §6.1).
              expect(Number.isInteger(delta.points * 2)).toBe(true);
            }
          }
        }),
        { numRuns },
      );
    });

    // §9.5 — live UI safety: summary defined at every prefix.
    it("§9.5 summary is well-formed on every prefix", () => {
      fc.assert(
        fc.property(streamArb, (events) => {
          let state = module.init(cfg, lineups);
          ScoreSummary.parse(module.summary(state));
          for (const event of events) {
            state = module.apply(state, asModuleEvent(event));
            ScoreSummary.parse(module.summary(state));
          }
        }),
        { numRuns },
      );
    });

    // spec 02 §4 — bad configs can never reach play; parsing is idempotent.
    it("config schema round-trips every named variant", () => {
      const base = (opts.cfg ?? {}) as Record<string, unknown>;
      for (const [name, preset] of Object.entries(module.variants)) {
        const merged = module.configSchema.parse({ ...base, ...preset });
        expect(module.configSchema.parse(merged), `variant "${name}"`).toEqual(merged);
      }
    });

    // §9.6 — opt-in dual-fidelity: coarse and fine streams describing the
    // same match fold to identical outcomes and summaries.
    if (module.coarsen) {
      it("§9.6 dual-fidelity: coarse fold ≡ fine fold", () => {
        const coarsen = module.coarsen as NonNullable<typeof module.coarsen>;
        fc.assert(
          fc.property(streamArb, (events) => {
            const active = resolveVoids(events).map(asModuleEvent);
            const coarse = coarsen
              .call(module, active)
              .map((event, i) => makeEnvelope(i, event));
            const fine = fold(events);
            const folded = fold(coarse);
            expect(module.outcome(folded)).toEqual(module.outcome(fine));
            expect(module.summary(folded)).toEqual(module.summary(fine));
          }),
          { numRuns },
        );
      });
    }
  });
}
