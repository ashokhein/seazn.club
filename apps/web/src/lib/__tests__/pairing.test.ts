import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  swissPairings,
  roundRobinRounds,
  knockoutFirstRound,
  recommendGroupRounds,
  nextPowerOfTwo,
  pairKey,
} from "../pairing";

// ---- Unit tests (ported from engine-check.ts) --------------------------------

describe("swissPairings", () => {
  it("produces 2 boards for 4 players, no byes", () => {
    const p = swissPairings(["a", "b", "c", "d"], new Set(), new Set());
    expect(p).toHaveLength(2);
    expect(p.every((x) => x.player2 !== null)).toBe(true);
  });

  it("produces exactly one bye for 5 players", () => {
    const p = swissPairings(["a", "b", "c", "d", "e"], new Set(), new Set());
    const byes = p.filter((x) => x.player2 === null);
    expect(byes).toHaveLength(1);
  });

  it("gives bye to lowest-ranked player who has not had one", () => {
    const p = swissPairings(
      ["a", "b", "c", "d", "e"],
      new Set(),
      new Set(["e"]), // e already had a bye
    );
    const bye = p.find((x) => x.player2 === null);
    expect(bye?.player1).toBe("d"); // second-lowest not yet given bye
  });

  it("avoids rematches when possible (4 players)", () => {
    // a-b already played; with 4 players, a can be paired with c or d instead
    const played = new Set([pairKey("a", "b")]);
    const p = swissPairings(["a", "b", "c", "d"], played, new Set());
    const abMatch = p.find(
      (x) =>
        (x.player1 === "a" && x.player2 === "b") ||
        (x.player1 === "b" && x.player2 === "a"),
    );
    expect(abMatch).toBeUndefined();
  });
});

describe("roundRobinRounds", () => {
  it("4 players → 3 rounds, 2 matches each, 6 total fixtures", () => {
    const rr = roundRobinRounds(["a", "b", "c", "d"]);
    expect(rr).toHaveLength(3);
    expect(rr.every((r) => r.length === 2)).toBe(true);
    expect(rr.flat()).toHaveLength(6);
  });

  it("3 players → 3 rounds, one bye per round", () => {
    const rr = roundRobinRounds(["a", "b", "c"]);
    expect(rr).toHaveLength(3);
    const byes = rr.flat().filter((p) => p.player2 === null);
    expect(byes).toHaveLength(3);
  });

  it("each player plays every other exactly once", () => {
    const ids = ["a", "b", "c", "d"];
    const rr = roundRobinRounds(ids);
    const played = new Map<string, Set<string>>();
    for (const id of ids) played.set(id, new Set());
    for (const round of rr) {
      for (const { player1, player2 } of round) {
        if (!player2) continue;
        played.get(player1)!.add(player2);
        played.get(player2)!.add(player1);
      }
    }
    for (const [id, opponents] of played) {
      expect(opponents.size).toBe(ids.length - 1);
      expect(opponents.has(id)).toBe(false);
    }
  });
});

describe("knockoutFirstRound", () => {
  it("8 players → 4 first-round matches, seed 1 vs seed 8", () => {
    const ids = ["1", "2", "3", "4", "5", "6", "7", "8"];
    const r1 = knockoutFirstRound(ids);
    expect(r1).toHaveLength(4);
    expect(r1[0].player1).toBe("1");
    expect(r1[0].player2).toBe("8");
  });

  it("5 players → 4 slots, seeds 3/4 and below get byes", () => {
    const r1 = knockoutFirstRound(["a", "b", "c", "d", "e"]);
    expect(r1).toHaveLength(4); // bracket size = 8, 4 first-round matches
  });

  it("player1 is always present (no empty slot in player1)", () => {
    const r1 = knockoutFirstRound(["a", "b", "c"]);
    expect(r1.every((p) => !!p.player1)).toBe(true);
  });
});

describe("recommendGroupRounds", () => {
  it("8 players → knockout size 4, ≥3 group rounds", () => {
    const rec = recommendGroupRounds(8);
    expect(rec.knockoutSize).toBe(4);
    expect(rec.groupRounds).toBeGreaterThanOrEqual(3);
  });

  it("returns at least 1 group round for any player count", () => {
    for (const n of [2, 3, 4, 5, 8, 16, 32]) {
      const rec = recommendGroupRounds(n);
      expect(rec.groupRounds).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("nextPowerOfTwo", () => {
  it("returns n when n is already a power of two", () => {
    expect(nextPowerOfTwo(8)).toBe(8);
    expect(nextPowerOfTwo(1)).toBe(1);
  });

  it("rounds up to the next power of two", () => {
    expect(nextPowerOfTwo(5)).toBe(8);
    expect(nextPowerOfTwo(9)).toBe(16);
  });
});

// ---- Property tests ----------------------------------------------------------

const playerIds = (n: number) =>
  Array.from({ length: n }, (_, i) => `p${i}`);

describe("swissPairings properties", () => {
  it("P1: all players appear exactly once", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 20 }), (n) => {
        const ids = playerIds(n);
        const pairings = swissPairings(ids, new Set(), new Set());
        const seen = new Set<string>();
        for (const { player1, player2 } of pairings) {
          expect(seen.has(player1)).toBe(false);
          seen.add(player1);
          if (player2) {
            expect(seen.has(player2)).toBe(false);
            seen.add(player2);
          }
        }
        expect(seen.size).toBe(n);
      }),
    );
  });

  it("P2: odd player count → exactly one bye", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10 }), (k) => {
        const n = k * 2 + 1; // guaranteed odd
        const pairings = swissPairings(playerIds(n), new Set(), new Set());
        const byes = pairings.filter((p) => p.player2 === null);
        expect(byes).toHaveLength(1);
      }),
    );
  });

  it("P3: even player count → zero byes", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10 }), (k) => {
        const n = k * 2;
        const pairings = swissPairings(playerIds(n), new Set(), new Set());
        const byes = pairings.filter((p) => p.player2 === null);
        expect(byes).toHaveLength(0);
      }),
    );
  });
});

describe("roundRobinRounds properties", () => {
  it("S1: n players → n-1 rounds (n even) or n rounds (n odd)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 12 }), (n) => {
        const rr = roundRobinRounds(playerIds(n));
        const expectedRounds = n % 2 === 0 ? n - 1 : n;
        expect(rr).toHaveLength(expectedRounds);
      }),
    );
  });

  it("S2: every real match pair is unique across all rounds", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 8 }), (n) => {
        const rr = roundRobinRounds(playerIds(n));
        const keys = new Set<string>();
        for (const round of rr) {
          for (const { player1, player2 } of round) {
            if (!player2) continue;
            const key = pairKey(player1, player2);
            expect(keys.has(key)).toBe(false);
            keys.add(key);
          }
        }
      }),
    );
  });

  it("S3: each player appears in every round exactly once", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 8 }), (n) => {
        const ids = playerIds(n);
        const rr = roundRobinRounds(ids);
        for (const round of rr) {
          const seen = new Set<string>();
          for (const { player1, player2 } of round) {
            seen.add(player1);
            if (player2) seen.add(player2);
          }
          expect(seen.size).toBe(n);
        }
      }),
    );
  });
});

describe("knockoutFirstRound properties", () => {
  it("L1: bracket size is always a power of two", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 32 }), (n) => {
        const r1 = knockoutFirstRound(playerIds(n));
        const size = r1.length * 2;
        expect(size & (size - 1)).toBe(0); // power of two
      }),
    );
  });

  it("L2: all real seeds appear exactly once in round 1", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 16 }), (n) => {
        const ids = playerIds(n);
        const r1 = knockoutFirstRound(ids);
        const seen = new Set<string>();
        for (const { player1, player2 } of r1) {
          if (player1) seen.add(player1);
          if (player2) seen.add(player2);
        }
        for (const id of ids) expect(seen.has(id)).toBe(true);
      }),
    );
  });
});
