// Round-robin generation — spec 05 §2.1, invariants §6.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  generateRoundRobin,
  roundRobinFixtureCount,
  type RoundRobinSchedule,
} from "./roundrobin.ts";

const field = (n: number): string[] => Array.from({ length: n }, (_, i) => `e${i}`);
const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

describe("generateRoundRobin — golden 6-team circle method (spec 05 §2.1)", () => {
  // The textbook circle-method schedule (fix team 1, rotate the rest): the
  // canonical published 6-team single round robin. Pair sets per round:
  const PUBLISHED: string[][] = [
    ["1|6", "2|5", "3|4"],
    ["1|5", "4|6", "2|3"],
    ["1|4", "3|5", "2|6"],
    ["1|3", "2|4", "5|6"],
    ["1|2", "3|6", "4|5"],
  ];
  const schedule = generateRoundRobin({ entrants: ["1", "2", "3", "4", "5", "6"], config: { legs: 2 } });

  const roundPairs = (roundNo: number): Set<string> =>
    new Set(
      (schedule.rounds.find((r) => r.roundNo === roundNo)?.fixtures ?? []).map((f) =>
        pairKey(f.home, f.away),
      ),
    );

  it("leg 1 rounds match the published circle-method table", () => {
    for (let r = 1; r <= 5; r++) {
      expect(roundPairs(r)).toEqual(new Set(PUBLISHED[r - 1]));
    }
  });

  it("leg 2 mirrors leg 1 (same pairings, home/away swapped)", () => {
    for (let r = 1; r <= 5; r++) {
      expect(roundPairs(r + 5)).toEqual(new Set(PUBLISHED[r - 1]));
    }
    // Each leg-1 fixture has an away/home-swapped twin in leg 2.
    const leg1 = schedule.fixtures.filter((f) => f.leg === 1).map((f) => `${f.home}>${f.away}`);
    const leg2Swapped = schedule.fixtures.filter((f) => f.leg === 2).map((f) => `${f.away}>${f.home}`);
    expect(new Set(leg1)).toEqual(new Set(leg2Swapped));
  });

  it("double round robin has n(n−1)/2·legs = 30 fixtures", () => {
    expect(schedule.fixtures).toHaveLength(30);
    expect(schedule.fixtures).toHaveLength(roundRobinFixtureCount(6, 2));
  });

  it("board assignment rotates — the pivot's game is not always court 1", () => {
    const pivotCourts = new Set(
      schedule.fixtures.filter((f) => f.home === "1" || f.away === "1").map((f) => f.court),
    );
    expect(pivotCourts.size).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// Property suites — spec 05 §6 (fast-check, n up to 64)
// ---------------------------------------------------------------------------

// Every entrant appears exactly once per round (playing or on the bye).
function eachEntrantOncePerRound(schedule: RoundRobinSchedule, entrants: string[]): void {
  for (const round of schedule.rounds) {
    const seen = new Set<string>();
    for (const f of round.fixtures) {
      expect(seen.has(f.home)).toBe(false);
      expect(seen.has(f.away)).toBe(false);
      seen.add(f.home);
      seen.add(f.away);
    }
    if (round.bye !== undefined) {
      expect(seen.has(round.bye)).toBe(false);
      seen.add(round.bye);
    }
    expect(seen).toEqual(new Set(entrants));
  }
}

describe("generateRoundRobin — invariants (spec 05 §6)", () => {
  const nArb = fc.integer({ min: 2, max: 64 });
  const legsArb = fc.constantFrom<1 | 2>(1, 2);

  it("completeness: fixture count is n(n−1)/2·legs", () => {
    fc.assert(
      fc.property(nArb, legsArb, (n, legs) => {
        const schedule = generateRoundRobin({ entrants: field(n), config: { legs } });
        expect(schedule.fixtures).toHaveLength(roundRobinFixtureCount(n, legs));
      }),
    );
  });

  // Heavy property test: sits near vitest's 5s default under full-suite
  // worker contention — budget it explicitly (chaos.test.ts precedent).
  it("uniqueness: every pair meets exactly once per leg, ≤1 fixture per entrant per round", { timeout: 20_000 }, () => {
    fc.assert(
      fc.property(nArb, legsArb, (n, legs) => {
        const schedule = generateRoundRobin({ entrants: field(n), config: { legs } });
        eachEntrantOncePerRound(schedule, field(n));
        for (let leg = 1; leg <= legs; leg++) {
          const counts = new Map<string, number>();
          for (const f of schedule.fixtures.filter((x) => x.leg === leg)) {
            const key = pairKey(f.home, f.away);
            counts.set(key, (counts.get(key) ?? 0) + 1);
          }
          // n(n−1)/2 distinct pairs, each once.
          expect(counts.size).toBe((n * (n - 1)) / 2);
          for (const c of counts.values()) expect(c).toBe(1);
        }
      }),
    );
  });

  it("home/away balance: |home−away| ≤ 1 per entrant per leg", () => {
    fc.assert(
      fc.property(nArb, legsArb, (n, legs) => {
        const schedule = generateRoundRobin({ entrants: field(n), config: { legs } });
        for (let leg = 1; leg <= legs; leg++) {
          const home = new Map<string, number>();
          const away = new Map<string, number>();
          for (const f of schedule.fixtures.filter((x) => x.leg === leg)) {
            home.set(f.home, (home.get(f.home) ?? 0) + 1);
            away.set(f.away, (away.get(f.away) ?? 0) + 1);
          }
          for (const id of field(n)) {
            expect(Math.abs((home.get(id) ?? 0) - (away.get(id) ?? 0))).toBeLessThanOrEqual(1);
          }
        }
      }),
    );
  });

  it("idempotence: regeneration is byte-identical (spec 05 §6)", () => {
    fc.assert(
      fc.property(nArb, legsArb, fc.integer(), (n, legs, rngSeed) => {
        const a = generateRoundRobin({ entrants: field(n), config: { legs }, rngSeed });
        const b = generateRoundRobin({ entrants: field(n), config: { legs }, rngSeed });
        expect(a).toEqual(b);
      }),
    );
  });

  it("odd fields: exactly one bye per round, each entrant byes (n−1)/… times evenly", () => {
    fc.assert(
      fc.property(fc.integer({ min: 3, max: 63 }).filter((n) => n % 2 === 1), (n) => {
        const schedule = generateRoundRobin({ entrants: field(n) });
        const byeCounts = new Map<string, number>();
        for (const round of schedule.rounds) {
          expect(round.bye).toBeDefined();
          byeCounts.set(round.bye as string, (byeCounts.get(round.bye as string) ?? 0) + 1);
        }
        // Over a full single RR each entrant sits out exactly once.
        for (const id of field(n)) expect(byeCounts.get(id)).toBe(1);
      }),
    );
  });
});
