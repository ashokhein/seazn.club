// Bracket generation — spec 05 §2.3–2.5, invariants §6.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  crossPoolSeedOrder,
  generateDoubleElim,
  generateSingleElim,
  generateStepladder,
  nextPowerOfTwo,
  seedPositions,
  type BracketFixtureGen,
} from "./bracket.ts";

const field = (n: number): string[] => Array.from({ length: n }, (_, i) => `s${i + 1}`);

// mulberry32 — a seeded coin for resolving brackets in the property tests.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Play a bracket out to completion, following winner/loser feeds. Byes (`award`)
// and walkovers (a feed from a bye's non-existent loser) advance without a loss.
// Skips conditional (bracket-reset) games. Returns per-entrant loss counts and
// the champion (winner of the last isFinal game resolved).
function resolveBracket(
  fixtures: readonly BracketFixtureGen[],
  coin: () => number,
): { losses: Map<string, number>; champion: string | undefined } {
  const winner = new Map<string, string | undefined>();
  const loser = new Map<string, string | undefined>();
  const losses = new Map<string, number>();
  const resolved = new Set<string>();
  const ready = (ref?: { fixtureId: string }): boolean => ref === undefined || resolved.has(ref.fixtureId);
  const val = (ref?: { fixtureId: string; side: "winner" | "loser" }): string | undefined =>
    ref === undefined ? undefined : ref.side === "winner" ? winner.get(ref.fixtureId) : loser.get(ref.fixtureId);

  for (let guard = 0; guard < fixtures.length + 2; guard++) {
    let progress = false;
    for (const fx of fixtures) {
      if (resolved.has(fx.id) || fx.conditional === true) continue;
      if (!ready(fx.homeFrom) || !ready(fx.awayFrom)) continue;
      if (fx.award !== undefined) {
        winner.set(fx.id, fx.award);
        loser.set(fx.id, undefined);
        resolved.add(fx.id);
        progress = true;
        continue;
      }
      const home = fx.home ?? val(fx.homeFrom);
      const away = fx.away ?? val(fx.awayFrom);
      if (home === undefined && away === undefined) continue;
      if (home === undefined || away === undefined) {
        // Walkover — the present side advances.
        const solo = (home ?? away) as string;
        winner.set(fx.id, solo);
        loser.set(fx.id, undefined);
        resolved.add(fx.id);
        progress = true;
        continue;
      }
      const w = coin() < 0.5 ? home : away;
      const l = w === home ? away : home;
      winner.set(fx.id, w);
      loser.set(fx.id, l);
      losses.set(l, (losses.get(l) ?? 0) + 1);
      resolved.add(fx.id);
      progress = true;
    }
    if (!progress) break;
  }

  const finals = fixtures.filter((f) => f.isFinal === true && resolved.has(f.id));
  const last = finals[finals.length - 1];
  return { losses, champion: last === undefined ? undefined : winner.get(last.id) };
}

describe("seedPositions — golden standard fold (spec 05 §2.3)", () => {
  it("matches the published 8-seed layout", () => {
    expect(seedPositions(8)).toEqual([1, 8, 5, 4, 3, 6, 7, 2]);
  });

  it("matches the standard 1–16 fold layout", () => {
    expect(seedPositions(16)).toEqual([1, 16, 9, 8, 5, 12, 13, 4, 3, 14, 11, 6, 7, 10, 15, 2]);
  });

  it("seed 1 and seed 2 are in opposite halves (meet only in the final)", () => {
    for (const size of [2, 4, 8, 16, 32, 64]) {
      const pos = seedPositions(size);
      expect(pos[0]).toBe(1);
      expect(pos[size - 1]).toBe(2);
    }
  });
});

describe("generateSingleElim — structure, byes & feeds (spec 05 §2.3)", () => {
  it("byes = S − n are awarded to the top seeds", () => {
    // 6 entrants ⇒ bracket of 8, 2 byes ⇒ seeds s1, s2 auto-advance.
    const { fixtures } = generateSingleElim({ entrants: field(6) });
    const awards = fixtures.filter((f) => f.award !== undefined).map((f) => f.award);
    expect(new Set(awards)).toEqual(new Set(["s1", "s2"]));
  });

  it("adds a 3rd-place playoff fed by the two semifinal losers", () => {
    const { fixtures } = generateSingleElim({ entrants: field(4), thirdPlace: true });
    const tp = fixtures.find((f) => f.thirdPlace === true);
    expect(tp).toBeDefined();
    expect(tp?.homeFrom?.side).toBe("loser");
    expect(tp?.awayFrom?.side).toBe("loser");
  });

  it("depth is log2(S), one final, and resolves to a single champion (n up to 64)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 64 }), fc.integer(), (n, seed) => {
        const bracket = generateSingleElim({ entrants: field(n) });
        const size = nextPowerOfTwo(n);
        expect(bracket.rounds).toBe(Math.log2(size));
        expect(bracket.fixtures.filter((f) => f.isFinal === true)).toHaveLength(1);
        // S − 1 games decide a single-elim of S slots (byes included as awards).
        expect(bracket.fixtures).toHaveLength(size - 1);
        const { champion } = resolveBracket(bracket.fixtures, rng(seed));
        expect(champion).toBeDefined();
      }),
    );
  });

  it("is idempotent — regeneration is byte-identical", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 64 }), (n) => {
        expect(generateSingleElim({ entrants: field(n), thirdPlace: true })).toEqual(
          generateSingleElim({ entrants: field(n), thirdPlace: true }),
        );
      }),
    );
  });
});

describe("crossPoolSeedOrder — group→KO template (spec 05 §2.3)", () => {
  it("produces the A1–B2 / B1–A2 first round for two pools", () => {
    const order = crossPoolSeedOrder([
      ["A1", "A2"],
      ["B1", "B2"],
    ]);
    expect(order).toEqual(["A1", "B1", "A2", "B2"]);
    const { fixtures } = generateSingleElim({ entrants: order });
    const r0 = fixtures
      .filter((f) => f.round === 0)
      .map((f) => new Set([f.home, f.away]));
    // A1 vs B2 and A2 vs B1 — winners face the other pool's runner-up.
    expect(r0).toContainEqual(new Set(["A1", "B2"]));
    expect(r0).toContainEqual(new Set(["A2", "B1"]));
  });
});

describe("generateDoubleElim — invariants (spec 05 §2.4, §6)", () => {
  it("2n−2 games for a power-of-two field", () => {
    for (const n of [2, 4, 8, 16]) {
      const { fixtures } = generateDoubleElim({ entrants: field(n) });
      expect(fixtures).toHaveLength(2 * n - 2);
    }
  });

  it("champion has ≤ 2 losses and every other entrant ≥ 1 (n ∈ {2,4,8,16,32})", () => {
    fc.assert(
      fc.property(fc.constantFrom(2, 4, 8, 16, 32), fc.integer(), (n, seed) => {
        const { fixtures } = generateDoubleElim({ entrants: field(n) });
        const { losses, champion } = resolveBracket(fixtures, rng(seed));
        expect(champion).toBeDefined();
        expect(losses.get(champion as string) ?? 0).toBeLessThanOrEqual(2);
        for (const id of field(n)) {
          if (id === champion) continue;
          expect(losses.get(id) ?? 0).toBeGreaterThanOrEqual(1);
        }
      }),
    );
  });

  it("emits a conditional bracket-reset final when configured", () => {
    const { fixtures } = generateDoubleElim({ entrants: field(8), bracketReset: true });
    const reset = fixtures.find((f) => f.id === "gf-reset");
    expect(reset?.conditional).toBe(true);
    expect(reset?.homeFrom).toEqual({ fixtureId: "gf", side: "winner" });
    expect(reset?.awayFrom).toEqual({ fixtureId: "gf", side: "loser" });
  });
});

describe("generateStepladder — rank ladder (spec 05 §2.5)", () => {
  it("R4 v R3 → winner v R2 → winner v R1", () => {
    const { fixtures, rounds } = generateStepladder({ entrants: ["R1", "R2", "R3", "R4"] });
    expect(rounds).toBe(3);
    expect(fixtures[0]).toMatchObject({ id: "sl-g0", home: "R3", away: "R4" });
    expect(fixtures[1]).toMatchObject({ id: "sl-g1", home: "R2", awayFrom: { fixtureId: "sl-g0", side: "winner" } });
    expect(fixtures[2]).toMatchObject({
      id: "sl-g2",
      home: "R1",
      isFinal: true,
      awayFrom: { fixtureId: "sl-g1", side: "winner" },
    });
  });

  it("resolves to a single champion for any size", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 20 }), fc.integer(), (k, seed) => {
        const { fixtures } = generateStepladder({ entrants: field(k) });
        expect(fixtures).toHaveLength(k - 1);
        const { champion } = resolveBracket(fixtures, rng(seed));
        expect(champion).toBeDefined();
      }),
    );
  });
});
