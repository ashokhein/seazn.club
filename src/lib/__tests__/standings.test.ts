import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { computeStandings, type ScoringConfig } from "../standings";
import type { Match, Player, Round } from "../types";

// ---- Helpers -----------------------------------------------------------------

const CHESS: ScoringConfig = {
  points_win: 1,
  points_draw: 0,
  points_loss: 0,
  use_progress_score: true,
};

const LEAGUE: ScoringConfig = {
  points_win: 3,
  points_draw: 1,
  points_loss: 0,
  use_progress_score: false,
};

function mkPlayer(id: string, seed = 1): Player {
  return { id, tournament_id: "t", name: id, seed, checked_in: true, image_url: null, image_storage_path: null };
}

function mkRound(n: number): Round {
  return {
    id: `r${n}`,
    tournament_id: "t",
    round_number: n,
    stage: "group",
    name: `Round ${n}`,
    status: "completed",
  };
}

function mkMatch(
  round: number,
  p1: string,
  p2: string | null,
  winner: string | null,
  opts: { s1?: number; s2?: number; draw?: boolean } = {},
): Match {
  return {
    id: `m${round}-${p1}-${p2 ?? "bye"}`,
    tournament_id: "t",
    round_id: `r${round}`,
    board_number: 1,
    player1_id: p1,
    player2_id: p2,
    winner_id: winner,
    loser_id: winner && p2 ? (winner === p1 ? p2 : p1) : null,
    player1_score: opts.s1 ?? null,
    player2_score: opts.s2 ?? null,
    is_draw: opts.draw ?? false,
    next_match_id: null,
    next_slot: null,
    is_bye: p2 === null,
    status: "completed",
    label: null,
  };
}

// ---- Unit tests (ported from engine-check.ts) --------------------------------

describe("computeStandings — progress score", () => {
  it("W,W,L → progress 3, points 2", () => {
    const players = ["A", "B"].map((n, i) => mkPlayer(n, i + 1));
    const rounds = [1, 2, 3].map(mkRound);
    const matches = [
      mkMatch(1, "A", "B", "A"),
      mkMatch(2, "A", "B", "A"),
      mkMatch(3, "A", "B", "B"),
    ];
    const s = computeStandings(players, rounds, matches, CHESS);
    const a = s.find((r) => r.player.id === "A")!;
    expect(a.progressScore).toBe(3);
    expect(a.points).toBe(2);
  });

  it("W,L,W → progress 2 (streak resets at loss)", () => {
    const players = ["A", "B"].map((n, i) => mkPlayer(n, i + 1));
    const rounds = [1, 2, 3].map(mkRound);
    const matches = [
      mkMatch(1, "A", "B", "A"),
      mkMatch(2, "A", "B", "B"),
      mkMatch(3, "A", "B", "A"),
    ];
    const s = computeStandings(players, rounds, matches, CHESS);
    const a = s.find((r) => r.player.id === "A")!;
    expect(a.progressScore).toBe(2);
  });

  it("loser after one match has 0 points and 0 progress", () => {
    const players = ["A", "B"].map((n, i) => mkPlayer(n, i + 1));
    const s = computeStandings(players, [mkRound(1)], [mkMatch(1, "A", "B", "A")], CHESS);
    const b = s.find((r) => r.player.id === "B")!;
    expect(b.points).toBe(0);
    expect(b.progressScore).toBe(0);
  });
});

describe("computeStandings — bye / rest", () => {
  it("bye gives 0 points and 0 wins", () => {
    const players = ["A", "B", "C"].map((n, i) => mkPlayer(n, i + 1));
    const rounds = [mkRound(1)];
    const matches = [mkMatch(1, "A", "B", "A"), mkMatch(1, "C", null, "C")];
    const s = computeStandings(players, rounds, matches, CHESS);
    const c = s.find((r) => r.player.id === "C")!;
    expect(c.points).toBe(0);
    expect(c.wins).toBe(0);
    expect(c.progressScore).toBe(0);
  });
});

describe("computeStandings — score + draw (league)", () => {
  it("A: 1 win (3pts) + 1 draw (1pt) = 4pts, scoreDiff +1", () => {
    const players = ["A", "B", "C"].map((n, i) => mkPlayer(n, i + 1));
    const rounds = [mkRound(1), mkRound(2)];
    const matches = [
      mkMatch(1, "A", "B", "A", { s1: 2, s2: 1 }),
      mkMatch(2, "A", "C", null, { s1: 0, s2: 0, draw: true }),
    ];
    const s = computeStandings(players, rounds, matches, LEAGUE);
    const a = s.find((r) => r.player.id === "A")!;
    expect(a.points).toBe(4);
    expect(a.scoreDiff).toBe(1);
    expect(a.wins).toBe(1);
    expect(a.draws).toBe(1);
    expect(a.losses).toBe(0);
  });
});

describe("computeStandings — ranking", () => {
  it("rankings are 1-indexed and contiguous", () => {
    const players = ["A", "B", "C", "D"].map((n, i) => mkPlayer(n, i + 1));
    const rounds = [mkRound(1), mkRound(2)];
    const matches = [
      mkMatch(1, "A", "B", "A"),
      mkMatch(1, "C", "D", "C"),
      mkMatch(2, "A", "C", "A"),
      mkMatch(2, "B", "D", "D"),
    ];
    const s = computeStandings(players, rounds, matches, CHESS);
    const ranks = s.map((r) => r.rank).sort((a, b) => a - b);
    expect(ranks).toEqual([1, 2, 3, 4]);
  });

  it("higher points ranks above lower points", () => {
    const players = ["A", "B"].map((n, i) => mkPlayer(n, i + 1));
    const rounds = [mkRound(1)];
    const matches = [mkMatch(1, "A", "B", "A")];
    const s = computeStandings(players, rounds, matches, CHESS);
    expect(s[0].player.id).toBe("A");
    expect(s[1].player.id).toBe("B");
  });

  it("unchecked-in players are excluded from standings", () => {
    const players = [
      mkPlayer("A", 1),
      { ...mkPlayer("B", 2), checked_in: false },
    ];
    const s = computeStandings(players, [mkRound(1)], [mkMatch(1, "A", "B", "A")], CHESS);
    expect(s.find((r) => r.player.id === "B")).toBeUndefined();
  });
});

describe("computeStandings — Buchholz", () => {
  it("Buchholz = sum of opponents' points", () => {
    // 3 players: A beats B in round 1; C has bye.
    // After round 1: A=1pt, B=0pts, C=0pts.
    // B faced A (1pt) → B.buchholz = 1
    // A faced B (0pts) → A.buchholz = 0
    const players = ["A", "B", "C"].map((n, i) => mkPlayer(n, i + 1));
    const rounds = [mkRound(1)];
    const matches = [
      mkMatch(1, "A", "B", "A"),
      mkMatch(1, "C", null, "C"), // bye
    ];
    const s = computeStandings(players, rounds, matches, CHESS);
    const a = s.find((r) => r.player.id === "A")!;
    const b = s.find((r) => r.player.id === "B")!;
    expect(a.buchholz).toBe(0); // opponent B has 0 pts
    expect(b.buchholz).toBe(1); // opponent A has 1 pt
  });

  it("Buchholz correctly sums multi-opponent point totals", () => {
    // 4 players, 2 rounds.
    // After all rounds: A=1pt, B=2pts, C=1pt, D=0pts
    // A's opponents across both rounds: B(2pts) + C(1pt) → A.buchholz = 3
    // C's opponents: A(1pt) + D(0pts) → C.buchholz = 1
    // A and C are tied on points; A ranks above C because A.buchholz > C.buchholz
    const players = ["A", "B", "C", "D"].map((n, i) => mkPlayer(n, i + 1));
    const rounds = [mkRound(1), mkRound(2)];
    const matches = [
      mkMatch(1, "A", "B", "B"), // B beats A  → B=1pt, A=0pts so far
      mkMatch(1, "C", "D", "C"), // C beats D  → C=1pt
      mkMatch(2, "B", "D", "B"), // B beats D  → B=2pts
      mkMatch(2, "A", "C", "A"), // A beats C  → A=1pt, C=1pt
    ];
    const s = computeStandings(players, rounds, matches, CHESS);
    const a = s.find((r) => r.player.id === "A")!;
    const c = s.find((r) => r.player.id === "C")!;
    expect(a.points).toBe(1);
    expect(c.points).toBe(1); // tied on points
    expect(a.buchholz).toBe(3); // faced B(2pts) + C(1pt)
    expect(c.buchholz).toBe(1); // faced D(0pts) + A(1pt)
    expect(a.rank).toBeLessThan(c.rank); // Buchholz breaks the tie
  });
});

// ---- Property tests ----------------------------------------------------------

describe("computeStandings properties", () => {
  const playerIds = (n: number) =>
    Array.from({ length: n }, (_, i) => `p${i}`);

  it("P4: rank array is always a permutation of 1..n", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 8 }), (n) => {
        const players = playerIds(n).map((id, i) => mkPlayer(id, i + 1));
        const s = computeStandings(players, [], [], CHESS);
        const ranks = s.map((r) => r.rank).sort((a, b) => a - b);
        expect(ranks).toEqual(Array.from({ length: n }, (_, i) => i + 1));
      }),
    );
  });

  it("P5: total wins + draws + losses = total matches played", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 6 }), (n) => {
        const ids = playerIds(n);
        const players = ids.map((id, i) => mkPlayer(id, i + 1));
        // one round of sequential matches
        const round = mkRound(1);
        const matches: Match[] = [];
        for (let i = 0; i < ids.length - 1; i += 2) {
          matches.push(mkMatch(1, ids[i], ids[i + 1], ids[i]));
        }
        const s = computeStandings(players, [round], matches, CHESS);
        for (const row of s) {
          expect(row.wins + row.draws + row.losses).toBe(row.played);
        }
      }),
    );
  });

  it("P6: points are non-negative for any config", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 6 }),
        fc.integer({ min: 0, max: 10 }),
        fc.integer({ min: 0, max: 10 }),
        fc.integer({ min: 0, max: 10 }),
        (n, pw, pd, pl) => {
          const cfg: ScoringConfig = {
            points_win: pw,
            points_draw: pd,
            points_loss: pl,
            use_progress_score: false,
          };
          const ids = playerIds(n);
          const players = ids.map((id, i) => mkPlayer(id, i + 1));
          const round = mkRound(1);
          const matches: Match[] = [];
          for (let i = 0; i < ids.length - 1; i += 2) {
            matches.push(mkMatch(1, ids[i], ids[i + 1], ids[i]));
          }
          const s = computeStandings(players, [round], matches, cfg);
          for (const row of s) {
            expect(row.points).toBeGreaterThanOrEqual(0);
          }
        },
      ),
    );
  });
});
