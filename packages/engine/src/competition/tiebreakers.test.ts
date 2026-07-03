// Swiss tiebreak goldens — spec 05 §4 / chess.md §4, PROMPT-07 §5.
//
// Golden cross-table: a 6-player single round-robin (5 rounds, everyone meets
// everyone once) with a strict hierarchy A > B > C > D > E > F. A round-robin
// makes every tiebreak hand-verifiable: each player's opponents are ALL other
// players, so Buchholz = (Σ all scores) − own score, and Sonneborn-Berger is the
// sum of beaten opponents' scores. All values are exact integers (half-points;
// SB in quarter-points) — no floats anywhere (PROMPT-07 acceptance).
import { describe, expect, it } from "vitest";
import {
  buchholz,
  buchholzCut1,
  colorHistory,
  directEncounter,
  sonnebornBerger,
  swissTiebreaks,
  wins,
  type Color,
  type SwissGame,
  type SwissRow,
  type SwissTable,
} from "./tiebreakers.ts";

// win = 2 half-points, loss = 0. Colours cycle W,B,… per player's card.
function card(entrant: string, results: Array<[opp: string, won: boolean]>): SwissRow {
  const games: SwissGame[] = results.map(([opp, won], i) => ({
    opponent: opp,
    result: won ? "win" : "loss",
    scored: won ? 2 : 0,
    color: (i % 2 === 0 ? "W" : "B") as Color,
  }));
  return { entrant, score: games.reduce((s, g) => s + g.scored, 0), games };
}

// A beats everyone; B beats all but A; … F loses all.
const table: SwissTable = [
  card("A", [["B", true], ["C", true], ["D", true], ["E", true], ["F", true]]),
  card("B", [["A", false], ["C", true], ["D", true], ["E", true], ["F", true]]),
  card("C", [["A", false], ["B", false], ["D", true], ["E", true], ["F", true]]),
  card("D", [["A", false], ["B", false], ["C", false], ["E", true], ["F", true]]),
  card("E", [["A", false], ["B", false], ["C", false], ["D", false], ["F", true]]),
  card("F", [["A", false], ["B", false], ["C", false], ["D", false], ["E", false]]),
];

describe("Swiss cross-table golden (6-player round-robin)", () => {
  it("reproduces the published score column (half-points)", () => {
    const scores = Object.fromEntries(table.map((r) => [r.entrant, r.score]));
    expect(scores).toEqual({ A: 10, B: 8, C: 6, D: 4, E: 2, F: 0 });
  });

  it("Buchholz = Σ all − own (each plays the whole field)", () => {
    // Total = 30 half-points; Buchholz(X) = 30 − score(X).
    expect(buchholz(table, "A")).toBe(20);
    expect(buchholz(table, "B")).toBe(22);
    expect(buchholz(table, "C")).toBe(24);
    expect(buchholz(table, "D")).toBe(26);
    expect(buchholz(table, "E")).toBe(28);
    expect(buchholz(table, "F")).toBe(30);
  });

  it("Buchholz Cut-1 drops each player's lowest opponent", () => {
    // Everyone's weakest opponent is F (0) — except F, whose weakest is E (2).
    expect(buchholzCut1(table, "A")).toBe(20);
    expect(buchholzCut1(table, "B")).toBe(22);
    expect(buchholzCut1(table, "C")).toBe(24);
    expect(buchholzCut1(table, "D")).toBe(26);
    expect(buchholzCut1(table, "E")).toBe(28);
    expect(buchholzCut1(table, "F")).toBe(28); // 30 − 2
  });

  it("Sonneborn-Berger = Σ beaten opponents' scores (quarter-points)", () => {
    // SB_q = Σ scored·oppScore. A beat {8,6,4,2,0}: 2·20 = 40; F beat none: 0.
    expect(sonnebornBerger(table, "A")).toBe(40);
    expect(sonnebornBerger(table, "B")).toBe(24);
    expect(sonnebornBerger(table, "C")).toBe(12);
    expect(sonnebornBerger(table, "D")).toBe(4);
    expect(sonnebornBerger(table, "E")).toBe(0);
    expect(sonnebornBerger(table, "F")).toBe(0);
  });

  it("counts wins and reads colour history off the card", () => {
    expect(wins(table, "A")).toBe(5);
    expect(wins(table, "E")).toBe(1);
    expect(wins(table, "F")).toBe(0);
    expect(colorHistory(table[0] as SwissRow)).toBe("WBWBW");
  });

  it("resolves direct encounters head-to-head", () => {
    expect(directEncounter(table, "A", "F")).toBe(1);
    expect(directEncounter(table, "F", "A")).toBe(-1);
    expect(directEncounter(table, "C", "D")).toBe(1);
  });

  it("bundles every tiebreak as exact integers (no floats in the ledger)", () => {
    for (const row of table) {
      const tb = swissTiebreaks(table, row.entrant);
      for (const value of [tb.score, tb.buchholz, tb.buchholzCut1, tb.sonnebornBerger, tb.wins]) {
        expect(Number.isInteger(value)).toBe(true);
      }
    }
    expect(swissTiebreaks(table, "C")).toMatchObject({
      score: 6,
      buchholzCut1: 24,
      buchholz: 24,
      sonnebornBerger: 12,
      wins: 3,
      colorHistory: "WBWBW",
    });
  });
});

describe("FIDE virtual opponent for unplayed games (Handbook C.07)", () => {
  // X: R1 beat Y, R2 bye (unplayed, full point), R3 beat Z. 3 rounds.
  // Virtual opponent for the R2 bye = scoreBefore (2) + (rounds 3 − index 1) = 4.
  const withBye: SwissTable = [
    {
      entrant: "X",
      score: 6,
      games: [
        { opponent: "Y", result: "win", scored: 2, color: "W" },
        { opponent: null, result: "win", scored: 2, unplayed: true }, // bye
        { opponent: "Z", result: "win", scored: 2, color: "W" },
      ],
    },
    { entrant: "Y", score: 3, games: [] },
    { entrant: "Z", score: 1, games: [] },
  ];

  it("uses the virtual-opponent score for the bye round", () => {
    // Buchholz = score(Y) 3 + virtual 4 + score(Z) 1 = 8.
    expect(buchholz(withBye, "X")).toBe(8);
    // Cut-1 drops the lowest opponent (Z = 1) → 3 + 4 = 7.
    expect(buchholzCut1(withBye, "X")).toBe(7);
    // SB counts the win vs the virtual opponent too: 2·(3 + 4 + 1) = 16.
    expect(sonnebornBerger(withBye, "X")).toBe(16);
  });
});
