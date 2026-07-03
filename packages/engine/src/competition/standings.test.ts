// Standings fold — spec 02 §7 / spec 05 §6 (order-independence property).
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { StandingsDelta } from "../core/types.ts";
import {
  flattenResults,
  foldResults,
  foldStandings,
  resultsAmong,
  type FixtureResult,
} from "./standings.ts";

// A football-shaped decided fixture: 3/1/0 points, gf/ga/gd ledger.
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
  const hp = draw ? 1 : homeWon ? 3 : 0;
  const ap = draw ? 1 : homeWon ? 0 : 3;
  return [
    side(home, hg, ag, homeWon ? 1 : 0, draw ? 1 : 0, !draw && !homeWon ? 1 : 0, hp),
    side(away, ag, hg, !draw && !homeWon ? 1 : 0, draw ? 1 : 0, homeWon ? 1 : 0, ap),
  ];
}

const ENTRANTS = ["A", "B", "C", "D"];
const RESULTS: FixtureResult[] = [
  fb("A", "B", 2, 1),
  fb("A", "C", 0, 0),
  fb("A", "D", 3, 0),
  fb("B", "C", 1, 2),
  fb("B", "D", 1, 1),
  fb("C", "D", 4, 0),
];

describe("foldStandings", () => {
  it("sums played/points and the sport ledger per entrant", () => {
    const rows = foldResults(ENTRANTS, RESULTS);
    const a = rows.find((r) => r.entrantId === "A");
    // A: W vs B, D vs C, W vs D → 2W 1D, 7 pts; GF 5 GA 1 GD +4.
    expect(a).toMatchObject({
      played: 3,
      won: 2,
      drawn: 1,
      lost: 0,
      points: 7,
      metrics: { gf: 5, ga: 1, gd: 4 },
    });
  });

  it("returns rows in entrant order regardless of fixture order", () => {
    const rows = foldResults(ENTRANTS, RESULTS);
    expect(rows.map((r) => r.entrantId)).toEqual(ENTRANTS);
  });

  it("is order-independent — shuffling fixtures yields byte-identical rows (spec 05 §6)", () => {
    fc.assert(
      fc.property(fc.shuffledSubarray(RESULTS, { minLength: RESULTS.length }), (shuffled) => {
        expect(foldResults(ENTRANTS, shuffled)).toEqual(foldResults(ENTRANTS, RESULTS));
      }),
    );
  });

  it("rejects a delta for an entrant outside the pool (keeps the fold deterministic)", () => {
    expect(() => foldStandings(["A"], flattenResults([fb("A", "Z", 1, 0)]))).toThrow(/not in the pool/);
  });

  it("resultsAmong keeps only fixtures contested within the group", () => {
    const among = resultsAmong(new Set(["A", "B"]), RESULTS);
    expect(among).toHaveLength(1);
    expect(among[0]?.[0].entrantId).toBe("A");
    expect(among[0]?.[1].entrantId).toBe("B");
  });
});
