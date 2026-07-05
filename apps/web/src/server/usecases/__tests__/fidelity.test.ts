// PROMPT-13: the event-type → feature map must DERIVE from each module's
// fidelityTiers declaration (doc 14 §4), not a hand-kept table. Pure — no DB.
import { describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import type { AnySportModule } from "@seazn/engine/sport";
import { requiredFeatureForEvent } from "../fidelity";

const byKey = new Map(builtinModules.map((m) => [m.key, m]));
const football = byKey.get("football")!;
const cricket = byKey.get("cricket")!;
const boardgame = byKey.get("boardgame")!;
const generic = byKey.get("generic")!;
const volleyball = byKey.get("volleyball")!;

describe("requiredFeatureForEvent (doc 14 §4 derivation)", () => {
  // [module key, eventType, required feature | null]
  const cases: [string, string, string | null][] = [
    // Tier 0/1 always passes — coarse scoring is never paywalled (doc 14 §3).
    ["cricket", "cricket.innings.summary", null],
    ["cricket", "cricket.toss", null],
    ["cricket", "cricket.revise", null], // fidelity-free; the DLS gate is separate
    ["football", "football.goal", null], // Tier 1 final score AND Tier 2 timeline → free
    ["football", "football.period", null],
    ["volleyball", "volleyball.set.summary", null],
    ["boardgame", "boardgame.result", null],
    ["generic", "generic.result", null],
    // Fine-grained tiers carry their declared entitlement (doc 10 §1).
    ["cricket", "cricket.ball", "scoring.ball_by_ball"],
    ["cricket", "cricket.player.line", "stats.player"], // the Tier-2 scorecard
    ["football", "football.card", "scoring.match_timeline"],
    ["football", "football.sub", "scoring.match_timeline"],
    ["volleyball", "volleyball.rally", "scoring.rally_by_rally"],
  ];

  it.each(cases)("%s: %s → %s", (moduleKey, eventType, expected) => {
    const sportModule = byKey.get(moduleKey) as AnySportModule;
    expect(requiredFeatureForEvent(sportModule, eventType)).toBe(expected);
  });

  it("core.* events are always free", () => {
    for (const sportModule of [cricket, football, volleyball, boardgame, generic]) {
      expect(requiredFeatureForEvent(sportModule, "core.start")).toBeNull();
      expect(requiredFeatureForEvent(sportModule, "core.void")).toBeNull();
      expect(requiredFeatureForEvent(sportModule, "core.finalize")).toBeNull();
    }
  });

  it("unknown event types are not paywalled (the module 422s them instead)", () => {
    expect(requiredFeatureForEvent(football, "football.nonsense")).toBeNull();
  });

  it("every declared tier>1 event type across shipped modules resolves to a feature", () => {
    // Guards the doc 10 §1 contract: a module may not declare a paid tier
    // without naming the entitlement that unlocks it.
    for (const sportModule of [cricket, football, volleyball, boardgame, generic]) {
      const free = new Set(
        sportModule.fidelityTiers.filter((t) => t.tier <= 1).flatMap((t) => t.eventTypes),
      );
      for (const tier of sportModule.fidelityTiers.filter((t) => t.tier > 1)) {
        for (const type of tier.eventTypes) {
          if (free.has(type)) continue; // coarse alias — free by design
          expect(
            requiredFeatureForEvent(sportModule, type),
            `${sportModule.key}:${type}`,
          ).toBeTruthy();
        }
      }
    }
  });
});
