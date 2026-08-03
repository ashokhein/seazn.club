// Phase order for period sports — W4a (#425) §7.
//
// The guard in the fold and the ordering a module does inside apply() must come
// from ONE function, or the two disagree and an event the guard accepted is
// backwards a layer down. These tests pin that single source: not just that the
// two lists happen to be equal today, but that they are the SAME function, so a
// sport wiring apply() to a separately-built list fails here rather than in
// production.
import { describe, expect, it } from "vitest";
import { EngineError } from "../../core/errors.ts";
import { foldMatch, type EventEnvelope } from "../../core/events.ts";
import { defaultLineupPair, makeEnvelope } from "../../testkit/helpers.ts";
import type { ModuleEvent } from "../../sport/module.ts";
import type { SportModule } from "../../sport/module.ts";
import { icehockey } from "../icehockey/icehockey.ts";
import { hockey } from "../hockey/hockey.ts";
import { periodLabels, playPhases, type PeriodCfg } from "./kernel.ts";

type PeriodModule = SportModule<PeriodCfg, unknown, unknown>;

const presets: [string, PeriodModule][] = [
  ["icehockey", icehockey as unknown as PeriodModule],
  ["hockey", hockey as unknown as PeriodModule],
];

// Every named variant plus the bare default, because the list is cfg-derived:
// a variant that switches overtime or the shootout off changes it.
function cfgsOf(mod: PeriodModule): [string, PeriodCfg][] {
  return [
    ["default", mod.configSchema.parse({})],
    ...Object.keys(mod.variants).map(
      (key) => [key, mod.configSchema.parse(mod.variants[key])] as [string, PeriodCfg],
    ),
  ];
}

describe("period phase order (§7)", () => {
  it.each(presets)("%s declares the shared function itself, not a copy of its output", (_, mod) => {
    // Reference identity, deliberately. An equality check on the VALUES would
    // pass for a sport that built its own list that happens to match today —
    // which is round 1's two-disagreeing-orders defect, one layer down. The
    // only way to satisfy this is to hand the kernel's exported function
    // straight to the module, and for apply() to call that same export.
    //
    // Both typeof checks are load-bearing: `undefined === undefined` is what a
    // bare toBe() asserted while neither side existed, and it passed.
    expect(playPhases).toBeTypeOf("function");
    expect(mod.playPhases).toBeTypeOf("function");
    expect(mod.playPhases).toBe(playPhases);
  });

  it.each(presets)("%s: the declared list covers every phase a stamp may name", (_, mod) => {
    for (const [name, cfg] of cfgsOf(mod)) {
      const phases = playPhases(cfg);
      const labels = periodLabels(cfg);
      // "pre" first: cards are legal before the opening whistle (kernel's
      // suspensionAllowed), so a stamped one must be orderable.
      expect(phases[0], name).toBe("pre");
      // The regulation periods, in their own order, immediately after it.
      expect(phases.slice(1, 1 + labels.length), name).toEqual(labels);
      // A shootout is the last thing that happens, after any overtime — and it
      // is listed only when this cfg can actually reach it.
      if (cfg.shootout === null) {
        expect(phases, name).not.toContain("SHOOTOUT");
      } else {
        expect(phases[phases.length - 1], name).toBe("SHOOTOUT");
        if (cfg.overtime !== null) {
          const ot = phases.findIndex((p) => p.startsWith("OT"));
          expect(ot, name).toBeGreaterThan(0);
          expect(ot, name).toBeLessThan(phases.length - 1);
        }
      }
      // Overtime present exactly when the cfg has it.
      expect(phases.some((p) => p.startsWith("OT")), name).toBe(cfg.overtime !== null);
      // "done" is absent on purpose: no stamped event is legal once the match
      // is decided (core.note / core.finalize / core.award carry no `at`).
      expect(phases, name).not.toContain("done");
      // The fold refuses a duplicated order outright, so the source must not
      // produce one — a 1-period sport with sudden-death OT is the near miss.
      expect(new Set(phases).size, name).toBe(phases.length);
    }
  });
});

describe("a stamped event in a non-play phase folds (§3.3)", () => {
  const lineups = defaultLineupPair(icehockey.positions);
  const cfg = icehockey.configSchema.parse({});
  const fold = (events: ModuleEvent[]): unknown =>
    foldMatch(
      icehockey,
      cfg,
      lineups,
      events.map((event, i) => makeEnvelope(i, event)) as EventEnvelope[],
    );

  // core.suspend / core.resume are the only stamped payloads today, so they are
  // the available probe; a stamped card in the same phase (T2) travels the same
  // guard. The list the module used to hold was periodLabels + otLabels, which
  // has neither of these phases in it — both folds below threw.
  const suspendAt = (period: string): ModuleEvent[] => [
    { type: "core.suspend", payload: { reason: "power failure", at: { period, elapsed: 30 } } },
    { type: "core.resume", payload: { at: { period, elapsed: 30 } } },
  ];

  it("accepts a stamp during the shootout", () => {
    expect(() => fold(suspendAt("SHOOTOUT"))).not.toThrow();
  });

  it("accepts a stamp before the opening whistle", () => {
    expect(() => fold(suspendAt("pre"))).not.toThrow();
  });

  it("still refuses a period this sport does not have", () => {
    // Over-rejection guard's mirror: widening the list must not make it accept
    // anything. "SO" is the FIH abbreviation, not a phase label.
    let caught: unknown;
    try {
      fold(suspendAt("SO"));
      expect.unreachable("an unknown period must be refused");
    } catch (err) {
      caught = err;
    }
    expect(EngineError.is(caught, "INVALID_EVENT")).toBe(true);
  });
});
