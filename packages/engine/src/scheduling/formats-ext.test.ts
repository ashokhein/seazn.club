// Format-extension tests (Jul3/08, PROMPT-28 acceptance): triple RR,
// americano/mexicano, custom byes, feed-graph DAG, Hammes preset.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { generateRoundRobin, roundRobinFixtureCount } from "./roundrobin.ts";
import { generateAmericano, pairMexicanoRound } from "./americano.ts";
import { generateSingleElim } from "./bracket.ts";
import { validateFeedGraph } from "./feedgraph.ts";
import { pairKey, pairRound, type SwissStanding } from "./swiss.ts";

describe("round robin legs > 2 (Jul3/08 §2)", () => {
  it("property: completeness = n(n−1)/2·legs and per-pair home/away balance", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 9 }),
        fc.integer({ min: 1, max: 5 }),
        (n, legs) => {
          const entrants = Array.from({ length: n }, (_, i) => `e${i}`);
          const { fixtures } = generateRoundRobin({ entrants, config: { legs } });
          expect(fixtures).toHaveLength(roundRobinFixtureCount(n, legs));
          // every unordered pair meets exactly `legs` times, home/away split
          // differs by at most 1
          const meet = new Map<string, { a: number; b: number }>();
          for (const f of fixtures) {
            const key = [f.home, f.away].sort().join("|");
            const entry = meet.get(key) ?? { a: 0, b: 0 };
            if (f.home < f.away) entry.a++;
            else entry.b++;
            meet.set(key, entry);
          }
          expect(meet.size).toBe((n * (n - 1)) / 2);
          for (const { a, b } of meet.values()) {
            expect(a + b).toBe(legs);
            expect(Math.abs(a - b)).toBeLessThanOrEqual(1);
          }
        },
      ),
      { numRuns: 80 },
    );
  });
});

describe("americano / mexicano (Jul3/08 §3)", () => {
  it("property: rotation covers pairings evenly for feasible counts (8 players)", () => {
    const players = Array.from({ length: 8 }, (_, i) => `p${i}`);
    const rounds = generateAmericano(players, { mode: "americano", courtCount: 2, rounds: 7 });
    expect(rounds).toHaveLength(7);
    const partnerCounts = new Map<string, number>();
    for (const round of rounds) {
      expect(round.byes).toEqual([]); // 8 = 2 courts × 4
      const seen = new Set<string>();
      for (const m of round.matches) {
        for (const p of [...m.team1, ...m.team2]) {
          expect(seen.has(p)).toBe(false); // nobody plays twice in a round
          seen.add(p);
        }
        for (const [x, y] of [m.team1, m.team2]) {
          const k = [x, y].sort().join("|");
          partnerCounts.set(k, (partnerCounts.get(k) ?? 0) + 1);
        }
      }
      expect(seen.size).toBe(8); // never silently drop a player (§9)
    }
    // even coverage: partner repetition spread stays tight
    const counts = [...partnerCounts.values()];
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(2);
  });

  it("uneven field: best-effort with byes + a warning, never a dropped player", () => {
    const players = Array.from({ length: 6 }, (_, i) => `p${i}`);
    const rounds = generateAmericano(players, { mode: "americano", courtCount: 2, rounds: 3 });
    expect(rounds[0]!.warnings.length).toBeGreaterThan(0);
    for (const round of rounds) {
      const involved = new Set([
        ...round.matches.flatMap((m) => [...m.team1, ...m.team2]),
        ...round.byes,
      ]);
      expect(involved.size).toBe(6);
    }
  });

  it("mexicano pairs 1+4 vs 2+3 from the current standings", () => {
    const round = pairMexicanoRound(
      [
        { playerId: "d", points: 1 },
        { playerId: "a", points: 10 },
        { playerId: "b", points: 8 },
        { playerId: "c", points: 5 },
      ],
      { courtCount: 1 },
      2,
    );
    expect(round.matches[0]).toMatchObject({ team1: ["a", "d"], team2: ["b", "c"] });
  });
});

describe("custom brackets + feeds (Jul3/08 §4)", () => {
  it("6-team bracket with organiser-chosen byes matches the expected layout", () => {
    const entrants = ["s1", "s2", "s3", "s4", "s5", "s6"];
    const seeds = new Map(entrants.map((e, i) => [e, i + 1]));
    // byes to seeds 3 and 5 instead of the default 1 and 2
    const custom = generateSingleElim({ entrants, seeds, byeEntrants: ["s3", "s5"] });
    const awards = custom.fixtures.filter((f) => f.award !== undefined).map((f) => f.award);
    expect(awards.sort()).toEqual(["s3", "s5"]);
    // wrong count fails closed
    expect(() => generateSingleElim({ entrants, seeds, byeEntrants: ["s3"] })).toThrowError(
      expect.objectContaining({ code: "CONFIG_INVALID" }),
    );
  });

  it("cyclic cross-format feed graph is rejected (fail closed, §9)", () => {
    expect(() =>
      validateFeedGraph([
        { from: "cl", to: "el" },
        { from: "el", to: "conf" },
      ]),
    ).not.toThrow();
    expect(() =>
      validateFeedGraph([
        { from: "cl", to: "el" },
        { from: "el", to: "cl" },
      ]),
    ).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
  });
});

describe("Hammes preset (Jul3/08 §7)", () => {
  it("5 rounds on 8 entrants, rank-adjacent pairing, zero rematches", () => {
    const ids = Array.from({ length: 8 }, (_, i) => `h${i + 1}`);
    const scores = new Map(ids.map((id) => [id, 0]));
    const played = new Set<string>();
    const playedPairs: [string, string][] = [];
    for (let r = 1; r <= 5; r++) {
      const standings: SwissStanding[] = ids
        .map((id, i) => ({ entrantId: id, score: scores.get(id)!, rank: i + 1 }))
        .sort((a, b) => b.score - a.score || a.rank - b.rank);
      const round = pairRound(standings, { played }, { pairing: "rank_adjacent" });
      expect(round.pairings).toHaveLength(4);
      for (const p of round.pairings) {
        expect(played.has(pairKey(p.home, p.away))).toBe(false); // no rematch
        played.add(pairKey(p.home, p.away));
        playedPairs.push([p.home, p.away]);
        // higher-ranked side wins deterministically
        const winner = standings.findIndex((s) => s.entrantId === p.home) <
          standings.findIndex((s) => s.entrantId === p.away)
          ? p.home
          : p.away;
        scores.set(winner, scores.get(winner)! + 1);
      }
    }
    // round 1 was adjacent: 1v2, 3v4, …
    expect(playedPairs.slice(0, 4).map((p) => p.map((x) => x).sort().join())).toContain("h1,h2");
  });
});
