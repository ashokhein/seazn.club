// Tiebreaker cascade — spec 05 §4 (PROMPT-08 §3, §5, §6).
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { StandingsDelta } from "../core/types.ts";
import type { TiebreakerKey } from "../sport/module.ts";
import { foldResults, type FixtureResult, type StandingsRow } from "./standings.ts";
import { buildSwissTable, rankStandings, validateCascade } from "./tiebreakers.ts";

// The two football presets under test (spec 04 §1.6): H2H-first vs GD-first.
const FIFA2026: TiebreakerKey[] = ["points", "h2h_points", "h2h_diff", "h2h_for", "diff", "for", "fair_play", "lots"];
const CLASSIC: TiebreakerKey[] = ["points", "diff", "for", "h2h_points", "h2h_diff", "h2h_for", "fair_play", "lots"];

// Football-shaped decided fixture (gf/ga/gd ledger, 3/1/0 points).
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

function rankOrder(entrants: string[], results: FixtureResult[], cascade: TiebreakerKey[], opts: { h2hRecursive?: boolean } = {}): string[] {
  const rows = foldResults(entrants, results);
  return rankStandings(rows, { cascade, results, h2hRecursive: opts.h2hRecursive === true, rngSeed: 1 }).rows.map((r) => r.entrantId);
}

// ---------------------------------------------------------------------------
// Golden #6 — same group, H2H-first vs GD-first give DIFFERENT orders.
// ---------------------------------------------------------------------------

describe("FIFA 2026 H2H-first vs classic GD-first (golden — spec 05 §4, PROMPT-08 §6)", () => {
  // 4-team single RR. T1,T2,T3 finish level on 6 pts (each beats T4 + a 1-1-1
  // cycle among themselves); T4 last. Among {T1,T2,T3}: h2h points are level, so
  // h2h GD decides one way while overall GD (inflated by T2's 5-0 over T4)
  // decides the other.
  const entrants = ["T1", "T2", "T3", "T4"];
  const results: FixtureResult[] = [
    fb("T1", "T2", 2, 0),
    fb("T3", "T1", 1, 0),
    fb("T2", "T3", 1, 0),
    fb("T1", "T4", 1, 0),
    fb("T2", "T4", 5, 0),
    fb("T3", "T4", 2, 0),
  ];

  it("H2H-first (fifa2026) orders by the head-to-head sub-table", () => {
    expect(rankOrder(entrants, results, FIFA2026)).toEqual(["T1", "T3", "T2", "T4"]);
  });

  it("GD-first (classic) orders by overall goal difference", () => {
    expect(rankOrder(entrants, results, CLASSIC)).toEqual(["T2", "T3", "T1", "T4"]);
  });

  it("the two presets genuinely disagree on the same fixtures", () => {
    expect(rankOrder(entrants, results, FIFA2026)).not.toEqual(rankOrder(entrants, results, CLASSIC));
  });
});

// ---------------------------------------------------------------------------
// UEFA recursive vs FIFA fall-through (spec 05 §4.2, PROMPT-08 §3).
// ---------------------------------------------------------------------------

describe("h2hRecursive — UEFA re-application vs FIFA fall-through (spec 05 §4.2)", () => {
  // A,B,C,D level on 6 pts (jobber games equalise). The 4-way h2h splits into
  // {A,B} over {C,D} and leaves each pair level on h2h pts/GD/GF. UEFA re-runs
  // the head-to-head among just the pair (A beat B, C beat D). FIFA falls
  // through to overall GD, which the jobber results tilt the OTHER way (B>A, C>D
  // on overall GD ⇒ B,A,...). The pair order flips between the two.
  const entrants = ["A", "B", "C", "D", "Ja", "Jb", "Jc", "Jd"];
  const results: FixtureResult[] = [
    // Among the tie group (only these count for head-to-head).
    fb("A", "B", 1, 0),
    fb("A", "C", 1, 0),
    fb("D", "A", 1, 0),
    fb("B", "C", 1, 0),
    fb("B", "D", 1, 0),
    fb("C", "D", 1, 0),
    // External equalisers (jobbers, excluded from h2h; tilt overall GD).
    fb("Ja", "A", 3, 0), // A loses 0-3 → overall GD −2
    fb("Jb", "B", 1, 0), // B loses 0-1 → overall GD 0
    fb("C", "Jc", 3, 0), // C wins 3-0 → overall GD +2
    fb("D", "Jd", 1, 0), // D wins 1-0 → overall GD 0
  ];

  it("UEFA (recursive) ranks the pair by their direct game", () => {
    expect(rankOrder(entrants, results, FIFA2026, { h2hRecursive: true }).slice(0, 4)).toEqual(["A", "B", "C", "D"]);
  });

  it("FIFA (fall-through) ranks the still-level pair by overall criteria", () => {
    expect(rankOrder(entrants, results, FIFA2026, { h2hRecursive: false }).slice(0, 4)).toEqual(["B", "A", "C", "D"]);
  });

  it("the flag changes the result on the same fixtures", () => {
    const uefa = rankOrder(entrants, results, FIFA2026, { h2hRecursive: true });
    const fifa = rankOrder(entrants, results, FIFA2026, { h2hRecursive: false });
    expect(uefa).not.toEqual(fifa);
  });
});

// ---------------------------------------------------------------------------
// Intransitive three-way tie — partition refinement, not pairwise (spec 05 §4.2).
// ---------------------------------------------------------------------------

describe("intransitive H2H cycle (spec 05 §4.2 — pairwise is wrong)", () => {
  // A beat B, B beat C, C beat A (all 1-0); each also beats D. Pairwise H2H is a
  // rock-paper-scissors cycle. Partition refinement must treat {A,B,C} as ONE
  // still-tied class (it never invents a transitive order), leaving the drawing
  // of lots to decide — not a bogus A>B>C.
  const entrants = ["A", "B", "C", "D"];
  const results: FixtureResult[] = [
    fb("A", "B", 1, 0),
    fb("B", "C", 1, 0),
    fb("C", "A", 1, 0),
    fb("A", "D", 1, 0),
    fb("B", "D", 1, 0),
    fb("C", "D", 1, 0),
  ];

  it("keeps the cycle as one class and sends it to lots (rank_lock territory)", () => {
    const rows = foldResults(entrants, results);
    const result = rankStandings(rows, { cascade: FIFA2026, results, rngSeed: 7 });
    expect(result.lotsGroups).toEqual([["A", "B", "C"]]);
    expect(result.rows.map((r) => r.entrantId).slice(3)).toEqual(["D"]); // D is unambiguously last
  });

  it("is deterministic for a fixed rngSeed (reproducible draw of lots)", () => {
    const rows = foldResults(entrants, results);
    const once = rankStandings(rows, { cascade: FIFA2026, results, rngSeed: 7 }).rows.map((r) => r.entrantId);
    const twice = rankStandings(rows, { cascade: FIFA2026, results, rngSeed: 7 }).rows.map((r) => r.entrantId);
    expect(once).toEqual(twice);
    expect(once.slice(0, 3).sort()).toEqual(["A", "B", "C"]); // the three are some permutation
    expect(once.every((_, i) => rows[i] !== undefined)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Exact-arithmetic ratio comparators (spec 05 §4.3 — no floats).
// ---------------------------------------------------------------------------

function ratioRow(id: string, metrics: Record<string, number>, points = 0): StandingsRow {
  return { entrantId: id, played: 1, won: 0, drawn: 0, lost: 0, points, metrics };
}

describe("ratio comparators cross-multiply integer ledgers (spec 05 §4.3)", () => {
  it("net run rate compares (rf·bb − ra·bf) exactly", () => {
    // A: 200/(40 overs=240 balls) for, 180/240 against → NRR = (200−180)/240 > 0.
    // B: 201/240 for, 200/240 against → NRR = +1/240, smaller than A's +20/240.
    const rows = [
      ratioRow("B", { runs_for: 201, balls_faced_eff: 240, runs_against: 200, balls_bowled_eff: 240 }),
      ratioRow("A", { runs_for: 200, balls_faced_eff: 240, runs_against: 180, balls_bowled_eff: 240 }),
    ];
    expect(rankStandings(rows, { cascade: ["points", "nrr"] }).rows.map((r) => r.entrantId)).toEqual(["A", "B"]);
  });

  it("set ratio treats a clean sweep (0 lost) as the top ratio", () => {
    const rows = [
      ratioRow("X", { sets_won: 6, sets_lost: 2 }), // 3.0
      ratioRow("Y", { sets_won: 4, sets_lost: 0 }), // ∞
    ];
    expect(rankStandings(rows, { cascade: ["points", "set_ratio"] }).rows.map((r) => r.entrantId)).toEqual(["Y", "X"]);
  });

  it("point ratio orders 22/20 above 21/20 without floats", () => {
    const rows = [
      ratioRow("P", { points_won: 21, points_lost: 20 }),
      ratioRow("Q", { points_won: 22, points_lost: 20 }),
    ];
    expect(rankStandings(rows, { cascade: ["points", "point_ratio"] }).rows.map((r) => r.entrantId)).toEqual(["Q", "P"]);
  });
});

// ---------------------------------------------------------------------------
// Swiss cascade-time metrics via the assembled ledger (spec 05 §4.1).
// ---------------------------------------------------------------------------

describe("buchholz / direct comparators from the Swiss ledger", () => {
  // Boardgame half-points (win 2, draw 1). Two players tie on score; Buchholz
  // (Σ opponents' scores) breaks it.
  function bg(home: string, away: string, winner: "home" | "away" | "draw"): FixtureResult {
    const mk = (id: string, w: number, d: number, l: number, pts: number): StandingsDelta => ({
      entrantId: id,
      played: 1,
      won: w,
      drawn: d,
      lost: l,
      points: pts,
      metrics: { wins: w },
    });
    if (winner === "draw") return [mk(home, 0, 1, 0, 1), mk(away, 0, 1, 0, 1)];
    if (winner === "home") return [mk(home, 1, 0, 0, 2), mk(away, 0, 0, 1, 0)];
    return [mk(home, 0, 0, 1, 0), mk(away, 1, 0, 0, 2)];
  }

  it("orders equal-score players by Buchholz, then direct encounter", () => {
    // A, B, X all score 2 (one win each); Y scores 0. Buchholz: A's opponent is
    // X (score 2) and X's opponents are A+Y (2+0) → both 2; B's opponent is only
    // Y (0) → 0. So {A,X} share Buchholz 2 over B; the A–X direct game (A won)
    // separates them. Final: A, X, B, Y.
    const entrants = ["A", "B", "X", "Y"];
    const results: FixtureResult[] = [
      bg("A", "X", "home"), // A 2, X 0
      bg("X", "Y", "home"), // X 2, Y 0
      bg("B", "Y", "home"), // B 2, Y 0
    ];
    const rows = foldResults(entrants, results);
    const swiss = buildSwissTable(entrants, results);
    const order = rankStandings(rows, { cascade: ["points", "buchholz", "direct", "wins", "lots"], results, swiss, rngSeed: 1 }).rows.map((r) => r.entrantId);
    expect(order).toEqual(["A", "X", "B", "Y"]);
  });
});

// ---------------------------------------------------------------------------
// Cascade validation (spec 05 §4.1).
// ---------------------------------------------------------------------------

describe("validateCascade rejects unsupported keys (spec 05 §4.1)", () => {
  const footballMetrics = [
    { key: "gf", label: "GF", direction: "desc" as const },
    { key: "ga", label: "GA", direction: "asc" as const },
    { key: "gd", label: "GD", direction: "desc" as const },
    { key: "fair_play", label: "FP", direction: "desc" as const },
  ];

  it("accepts a cascade whose metrics the sport maintains", () => {
    expect(() => validateCascade(FIFA2026, { metrics: footballMetrics })).not.toThrow();
  });

  it("rejects nrr when the NRR ledger is absent", () => {
    expect(() => validateCascade(["points", "nrr"], { metrics: footballMetrics })).toThrow(/NRR/);
  });

  it("rejects set_ratio without sets won/lost", () => {
    expect(() => validateCascade(["points", "set_ratio"], { metrics: footballMetrics })).toThrow(/sets won\/lost/);
  });

  it("rejects buchholz unless a Swiss ledger is assembled", () => {
    expect(() => validateCascade(["points", "buchholz"], { metrics: [] })).toThrow(/Swiss ledger/);
    expect(() => validateCascade(["points", "buchholz"], { metrics: [], swiss: true })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Property suite (spec 05 §6).
// ---------------------------------------------------------------------------

describe("cascade properties (spec 05 §6)", () => {
  const entrants = ["A", "B", "C", "D"];
  const allPairs: [string, string][] = [
    ["A", "B"], ["A", "C"], ["A", "D"], ["B", "C"], ["B", "D"], ["C", "D"],
  ];
  // A random single round-robin: each pair plays once with random goals.
  const rrArb = fc.tuple(...allPairs.map(() => fc.tuple(fc.nat(4), fc.nat(4)))).map((scores) =>
    allPairs.map(([h, a], i) => {
      const [hg, ag] = scores[i] as [number, number];
      return fb(h, a, hg, ag);
    }),
  );

  it("ranking is a total order — distinct ranks 1..n, permutation-independent", () => {
    fc.assert(
      fc.property(rrArb, fc.shuffledSubarray(entrants, { minLength: 4 }), (results, shuffledEntrants) => {
        const a = rankStandings(foldResults(entrants, results), { cascade: FIFA2026, results, rngSeed: 3 });
        const b = rankStandings(foldResults(shuffledEntrants, results), { cascade: FIFA2026, results, rngSeed: 3 });
        const ranks = a.rows.map((r) => r.rank);
        expect([...ranks].sort((x, y) => (x ?? 0) - (y ?? 0))).toEqual([1, 2, 3, 4]);
        // Order is independent of the input row permutation.
        expect(a.rows.map((r) => r.entrantId)).toEqual(b.rows.map((r) => r.entrantId));
      }),
    );
  });

  it("irrelevant-fixture stability — a game outside the tie-group never reorders it (spec 05 §6)", () => {
    // C and D tie for the last two places; A and B are clear of them. Perturbing
    // the A-B fixture (both outside the C/D tie-group) must not reorder C vs D
    // under head-to-head. A,B always beat C,D so the tie-group is stable.
    const base = (ab: FixtureResult): FixtureResult[] => [
      ab,
      fb("A", "C", 5, 0),
      fb("A", "D", 5, 0),
      fb("B", "C", 5, 0),
      fb("B", "D", 5, 0),
      fb("C", "D", 2, 1), // C beats D head-to-head
    ];
    const tieOrder = (results: FixtureResult[]): string[] =>
      rankStandings(foldResults(entrants, results), { cascade: FIFA2026, results, rngSeed: 1 })
        .rows.map((r) => r.entrantId)
        .filter((id) => id === "C" || id === "D");

    fc.assert(
      fc.property(fc.nat(6), fc.nat(6), (hg, ag) => {
        expect(tieOrder(base(fb("A", "B", hg, ag)))).toEqual(["C", "D"]);
      }),
    );
  });
});
