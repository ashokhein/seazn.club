// Tie-explanation trace — doc 09 §2 (PROMPT-12): rankStandings records which
// cascade rule separated each tie so the public dashboard can render "ahead on
// head-to-head" popovers straight off the standings snapshot.
import { describe, expect, it } from "vitest";
import type { StandingsDelta } from "../core/types.ts";
import type { TiebreakerKey } from "../sport/module.ts";
import { foldResults, type FixtureResult } from "./standings.ts";
import { rankStandings } from "./tiebreakers.ts";

const FIFA2026: TiebreakerKey[] = ["points", "h2h_points", "h2h_diff", "h2h_for", "diff", "for", "fair_play", "lots"];
const CLASSIC: TiebreakerKey[] = ["points", "diff", "for", "h2h_points", "h2h_diff", "h2h_for", "fair_play", "lots"];

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

// T1,T2,T3 level on 6 pts; T4 swept. CLASSIC splits the trio on overall GD;
// FIFA2026 splits it inside the h2h mini-table (h2h_diff — h2h points level).
const entrants = ["T1", "T2", "T3", "T4"];
const results: FixtureResult[] = [
  fb("T1", "T2", 2, 0),
  fb("T3", "T1", 1, 0),
  fb("T2", "T3", 1, 0),
  fb("T1", "T4", 1, 0),
  fb("T2", "T4", 5, 0),
  fb("T3", "T4", 2, 0),
];

function rank(cascade: TiebreakerKey[]) {
  const rows = foldResults(entrants, results);
  return rankStandings(rows, { cascade, results, rngSeed: 1 }).rows;
}

describe("tie-break trace (doc 09 §2, PROMPT-12)", () => {
  it("rows separated by the primary key carry no trace", () => {
    const rows = rank(CLASSIC);
    const t4 = rows.find((r) => r.entrantId === "T4");
    expect(t4?.tieBreak).toBeUndefined();
  });

  it("a points tie split by overall GD records diff; a finer split overwrites", () => {
    const rows = rank(CLASSIC);
    // GD splits {T2} from {T1,T3} (T2 +4 vs +2/+2) — T2 keeps the diff trace
    // against the full trio.
    const t2 = rows.find((r) => r.entrantId === "T2");
    expect(t2?.tieBreak?.key).toBe("diff");
    expect(t2?.tieBreak?.with.sort()).toEqual(["T1", "T3"]);
    // T1/T3 stay level on GD and GF; the h2h block separates them — the finest
    // rule wins the trace.
    for (const id of ["T1", "T3"]) {
      const row = rows.find((r) => r.entrantId === id);
      expect(row?.tieBreak?.key).toBe("h2h_points");
      expect(row?.tieBreak?.with).toEqual([id === "T1" ? "T3" : "T1"]);
    }
  });

  it("an h2h-block split records the h2h key that separated the mini-table", () => {
    const rows = rank(FIFA2026);
    for (const id of ["T1", "T2", "T3"]) {
      const row = rows.find((r) => r.entrantId === id);
      // h2h points are level (1 win each in the cycle); h2h GD splits it.
      expect(row?.tieBreak?.key).toBe("h2h_diff");
    }
  });

  it("a residual tie resolved by lots is traced as lots", () => {
    // Two entrants with identical everything: one drawn game between them.
    const pair = ["X", "Y"];
    const drawn: FixtureResult[] = [fb("X", "Y", 1, 1)];
    const rows = foldResults(pair, drawn);
    const ranked = rankStandings(rows, { cascade: ["points", "diff", "lots"], results: drawn, rngSeed: 7 }).rows;
    for (const row of ranked) {
      expect(row.tieBreak?.key).toBe("lots");
      expect(row.rankLocked).toBe(true);
    }
  });

  it("a residual tie without lots falls back to seed and is traced as seed", () => {
    const pair = ["X", "Y"];
    const drawn: FixtureResult[] = [fb("X", "Y", 1, 1)];
    const rows = foldResults(pair, drawn);
    const ranked = rankStandings(rows, {
      cascade: ["points", "diff"],
      results: drawn,
      seeds: new Map([["X", 2], ["Y", 1]]),
    }).rows;
    expect(ranked.map((r) => r.entrantId)).toEqual(["Y", "X"]);
    for (const row of ranked) expect(row.tieBreak?.key).toBe("seed");
  });
});
