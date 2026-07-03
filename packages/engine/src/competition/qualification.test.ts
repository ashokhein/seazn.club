// Qualification resolution — spec 05 §3 (PROMPT-08 §4).
import { describe, expect, it } from "vitest";
import type { StandingsDelta } from "../core/types.ts";
import { foldResults, type FixtureResult, type StandingsRow } from "./standings.ts";
import { rankStandings } from "./tiebreakers.ts";
import { qualificationSize, resolveQualification, type PoolTable } from "./qualification.ts";

function fb(home: string, away: string, hg: number, ag: number): FixtureResult {
  const draw = hg === ag;
  const homeWon = hg > ag;
  const side = (id: string, gf: number, ga: number, w: number, d: number, l: number, pts: number): StandingsDelta => ({
    entrantId: id,
    played: 1,
    won: w,
    drawn: d,
    lost: l,
    points: pts,
    metrics: { gf, ga, gd: gf - ga },
  });
  return [
    side(home, hg, ag, homeWon ? 1 : 0, draw ? 1 : 0, !draw && !homeWon ? 1 : 0, draw ? 1 : homeWon ? 3 : 0),
    side(away, ag, hg, !draw && !homeWon ? 1 : 0, draw ? 1 : 0, homeWon ? 1 : 0, draw ? 1 : homeWon ? 0 : 3),
  ];
}

function rankedPool(pool: string, entrants: string[], results: FixtureResult[]): PoolTable {
  const rows = rankStandings(foldResults(entrants, results), {
    cascade: ["points", "diff", "for", "lots"],
    results,
    rngSeed: 1,
  }).rows;
  return { pool, rows, results };
}

function row(id: string, rank: number, points: number, metrics: Record<string, number> = {}): StandingsRow {
  return { entrantId: id, played: 0, won: 0, drawn: 0, lost: 0, points, metrics, rank };
}

describe("resolveQualification — pool-rank picks (spec 05 §3)", () => {
  const tables = {
    pools: [
      { pool: "A", rows: [row("A1", 1, 9), row("A2", 2, 6), row("A3", 3, 3)] },
      { pool: "B", rows: [row("B1", 1, 7), row("B2", 2, 5), row("B3", 3, 1)] },
    ],
  };

  it("resolves {pool, rank} picks in listed order (A1–B2, B1–A2 template)", () => {
    const seeds = resolveQualification(
      { take: [{ pool: "A", rank: 1 }, { pool: "B", rank: 1 }, { pool: "A", rank: 2 }, { pool: "B", rank: 2 }] },
      tables,
    );
    expect(seeds).toEqual(["A1", "B1", "A2", "B2"]);
  });

  it("throws when a pool has no entrant at the requested rank", () => {
    expect(() => resolveQualification({ take: [{ pool: "A", rank: 9 }] }, tables)).toThrow(/ranked 9/);
  });
});

describe("resolveQualification — topN (spec 05 §3)", () => {
  const overall = [row("L1", 1, 20), row("L2", 2, 18), row("L3", 3, 15), row("L4", 4, 12)];

  it("takes the top N of an overall (league) table", () => {
    expect(resolveQualification({ topN: 2 }, { pools: [], overall })).toEqual(["L1", "L2"]);
  });

  it("throws when topN exceeds the field", () => {
    expect(() => resolveQualification({ topN: 9 }, { pools: [], overall })).toThrow(/exceeds/);
  });
});

describe("resolveQualification — best-of-rank across pools (spec 05 §3)", () => {
  // Both third-placed teams take 3 pts off their pool's bottom side, with equal
  // overall GD (−1) but A3 has the flashier goals-for (beat A4 5-0). RAW
  // comparison → A3. Normalised (drop the bottom side, UEFA) → A3 collapses to
  // GD −6 while B3 only falls to −2, so B3 wins.
  const poolA = rankedPool("A", ["A1", "A2", "A3", "A4"], [
    fb("A1", "A2", 1, 0),
    fb("A1", "A3", 3, 0),
    fb("A1", "A4", 1, 0),
    fb("A2", "A3", 3, 0),
    fb("A2", "A4", 1, 0),
    fb("A3", "A4", 5, 0),
  ]);
  const poolB = rankedPool("B", ["B1", "B2", "B3", "B4"], [
    fb("B1", "B2", 1, 0),
    fb("B1", "B3", 1, 0),
    fb("B1", "B4", 1, 0),
    fb("B2", "B3", 1, 0),
    fb("B2", "B4", 1, 0),
    fb("B3", "B4", 1, 0),
  ]);
  const tables = { pools: [poolA, poolB] };

  it("third-placed rows are what we expect", () => {
    expect(poolA.rows.find((r) => r.rank === 3)?.entrantId).toBe("A3");
    expect(poolB.rows.find((r) => r.rank === 3)?.entrantId).toBe("B3");
  });

  it("plain metric comparison picks the flashier third-placed side", () => {
    expect(resolveQualification({ bestOfRank: { rank: 3, count: 1 } }, tables)).toEqual(["A3"]);
  });

  it("UEFA normalisation (drop the bottom side) flips the pick", () => {
    expect(
      resolveQualification({ bestOfRank: { rank: 3, count: 1, normaliseUnequalPools: true } }, tables),
    ).toEqual(["B3"]);
  });
});

describe("qualification invariants (spec 05 §6)", () => {
  const tables = {
    pools: [
      { pool: "A", rows: [row("A1", 1, 9), row("A2", 2, 6)] },
      { pool: "B", rows: [row("B1", 1, 7), row("B2", 2, 5)] },
    ],
    overall: [row("A1", 1, 9), row("B1", 2, 7), row("A2", 3, 6), row("B2", 4, 5)],
  };

  it("output size matches the spec (qualificationSize)", () => {
    const take = { take: [{ pool: "A", rank: 1 }, { pool: "B", rank: 1 }] };
    expect(resolveQualification(take, tables)).toHaveLength(qualificationSize(take));
    expect(qualificationSize({ topN: 3 })).toBe(3);
    expect(qualificationSize({ bestOfRank: { rank: 3, count: 2 } })).toBe(2);
  });

  it("is idempotent — identical inputs yield an identical seed list", () => {
    const spec = { topN: 3 };
    expect(resolveQualification(spec, tables)).toEqual(resolveQualification(spec, tables));
  });
});
