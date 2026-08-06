// Edge-path coverage for the tiebreaker engine — PROMPT-14 §4 (100% line gate
// on competition/tiebreakers.ts): malformed-ledger throws, direct-encounter
// branches, display formatting, non-swiss `direct` refinement, the seed
// fallback, and every validateCascade rejection.
import { describe, expect, it } from "vitest";
import { EngineError } from "../core/errors.ts";
import type { StandingsDelta } from "../core/types.ts";
import type { FixtureResult, StandingsRow } from "./standings.ts";
import {
  buchholz,
  buildSwissTable,
  directEncounter,
  pointsToText,
  rankStandings,
  validateCascade,
  type SwissTable,
} from "./tiebreakers.ts";

function row(entrantId: string, points: number, metrics: Record<string, number> = {}): StandingsRow {
  return { entrantId, played: 1, won: 0, drawn: 0, lost: 0, points, metrics };
}

function delta(entrantId: string, points: number, won = 0): StandingsDelta {
  return { entrantId, played: 1, won, drawn: won === 1 ? 0 : 1, lost: 0, points, metrics: {} };
}

describe("Swiss ledger error paths", () => {
  const table: SwissTable = [
    { entrant: "A", score: 2, games: [{ opponent: "ghost", result: "win", scored: 2 }] },
  ];

  it("rejects a tiebreak query for an entrant outside the table", () => {
    expect(() => buchholz(table, "nobody")).toThrow(/not in the Swiss table/);
  });

  it("rejects a card referencing an opponent outside the table", () => {
    expect(() => buchholz(table, "A")).toThrow(/unknown opponent/);
  });

  it("rejects building a ledger from results outside the entrant set", () => {
    const results: FixtureResult[] = [[delta("A", 2, 1), delta("Z", 0)]];
    expect(() => buildSwissTable(["A"], results)).toThrow(/outside the entrant set/);
  });
});

describe("directEncounter branches", () => {
  const table: SwissTable = [
    {
      entrant: "A",
      score: 2,
      games: [
        { opponent: "B", result: "win", scored: 2 },
        { opponent: "C", result: "loss", scored: 0 },
      ],
    },
    {
      entrant: "B",
      score: 0,
      games: [{ opponent: "A", result: "loss", scored: 0 }],
    },
    {
      entrant: "C",
      score: 2,
      games: [{ opponent: "A", result: "win", scored: 2 }],
    },
    { entrant: "D", score: 0, games: [] },
  ];

  it("+1 when a out-scored b head-to-head, −1 mirrored, 0 when never met", () => {
    expect(directEncounter(table, "A", "B")).toBe(1);
    expect(directEncounter(table, "A", "C")).toBe(-1);
    expect(directEncounter(table, "B", "D")).toBe(0);
  });
});

describe("pointsToText", () => {
  it("renders half-points conventionally", () => {
    expect(pointsToText(0)).toBe("0");
    expect(pointsToText(1)).toBe("½");
    expect(pointsToText(2)).toBe("1");
    expect(pointsToText(5)).toBe("2½");
    expect(pointsToText(4)).toBe("2");
  });
});

describe("`direct` refinement outside a Swiss stage", () => {
  it("splits a tie by head-to-head points from the fixture results", () => {
    // Three-way tie: the b–c result contributes nothing to a's direct score.
    const results: FixtureResult[] = [
      [delta("b", 3, 1), delta("a", 0)],
      [delta("b", 3, 1), delta("c", 0)],
    ];
    const ranked = rankStandings([row("a", 3), row("b", 3), row("c", 3)], {
      cascade: ["points", "direct"],
      results,
    });
    expect(ranked.rows[0]?.entrantId).toBe("b");
  });

  it("scores an entrant missing from the Swiss ledger as 0 and stays deterministic", () => {
    const ranked = rankStandings([row("b", 3), row("a", 3)], {
      cascade: ["points", "direct"],
      swiss: [],
    });
    // Nobody separable by direct — the seed→id fallback keeps a total order.
    expect(ranked.rows.map((entry) => entry.entrantId)).toEqual(["a", "b"]);
    expect(ranked.rows.map((entry) => entry.rank)).toEqual([1, 2]);
  });
});

describe("residual-tie seed fallback (no lots in the cascade)", () => {
  it("orders an unresolvable tie by seed", () => {
    const ranked = rankStandings([row("a", 3), row("b", 3)], {
      cascade: ["points"],
      seeds: new Map([
        ["a", 2],
        ["b", 1],
      ]),
    });
    expect(ranked.rows.map((entry) => entry.entrantId)).toEqual(["b", "a"]);
    expect(ranked.lotsGroups).toEqual([]);
  });
});

// #429 scope item 5 — `metricOf` returned 0 for an ABSENT metric key, so a row
// that never recorded the metric (folded before it existed, or an entrant with
// no fixtures in the table being ranked) was ranked as if it had genuinely
// scored zero. Absence is now no-data and sorts last, the same rule `seed`
// already uses for an entrant with no seed; a RECORDED zero is untouched.
describe("an absent metric is no data, not a zero (#429)", () => {
  it("ranks a row that recorded no GD BELOW a row that recorded a negative GD", () => {
    const ranked = rankStandings([row("nodata", 0), row("winless", 0, { gd: -5 })], {
      cascade: ["points", "diff"],
    });
    expect(ranked.rows.map((entry) => entry.entrantId)).toEqual(["winless", "nodata"]);
  });

  it("keeps a RECORDED zero ranked above a negative, and level with another zero", () => {
    const ranked = rankStandings(
      [row("neg", 0, { gd: -5 }), row("zero", 0, { gd: 0 }), row("alsozero", 0, { gd: 0 })],
      { cascade: ["points", "diff"], seeds: new Map([["alsozero", 1], ["zero", 2]]) },
    );
    expect(ranked.rows.map((entry) => entry.entrantId)).toEqual(["alsozero", "zero", "neg"]);
    // The two recorded zeros were level on `diff` — only seed separated them.
    expect(ranked.rows[0]?.tieBreak?.key).toBe("seed");
  });

  it("leaves two no-data rows level on the key and falls through to the cascade", () => {
    const ranked = rankStandings([row("b", 0), row("a", 0)], { cascade: ["points", "diff"] });
    expect(ranked.rows.map((entry) => entry.entrantId)).toEqual(["a", "b"]);
    expect(ranked.rows.every((entry) => entry.tieUnbroken === true)).toBe(true);
  });

  it("applies the same rule to `for` and `fair_play`", () => {
    const gf = rankStandings([row("nodata", 0), row("few", 0, { gf: 1 })], {
      cascade: ["points", "for"],
    });
    expect(gf.rows.map((entry) => entry.entrantId)).toEqual(["few", "nodata"]);
    const fp = rankStandings([row("nodata", 0), row("dirty", 0, { fair_play: -9 })], {
      cascade: ["points", "fair_play"],
    });
    expect(fp.rows.map((entry) => entry.entrantId)).toEqual(["dirty", "nodata"]);
  });
});

// The non-regression pin for the two federation cascades named in the #429
// ruling. Complete data on every row, so no key is ever absent — these orders
// must not move, and they differ from each other, which is what makes the pair
// worth asserting.
describe("federation cascades on complete data are unaffected", () => {
  // A and B level on 4 points. A has the better GD (+5 vs +1); B won the
  // head-to-head. FIH consults GD first, IIHF consults head-to-head first.
  const rows = [
    row("A", 4, { gd: 5, gf: 6 }),
    row("B", 4, { gd: 1, gf: 3 }),
  ];
  const results: FixtureResult[] = [[delta("B", 3, 1), delta("A", 0)]];

  it("FIH (points → GD → GF → head-to-head) ranks A first on GD", () => {
    const ranked = rankStandings(rows, {
      cascade: ["points", "diff", "for", "h2h_points"],
      results,
    });
    expect(ranked.rows.map((entry) => entry.entrantId)).toEqual(["A", "B"]);
    expect(ranked.rows[0]?.tieBreak?.key).toBe("diff");
  });

  it("IIHF (points → head-to-head → GD → GF) ranks B first on head-to-head", () => {
    const ranked = rankStandings(rows, {
      cascade: ["points", "h2h_points", "diff", "for"],
      results,
    });
    expect(ranked.rows.map((entry) => entry.entrantId)).toEqual(["B", "A"]);
    expect(ranked.rows[0]?.tieBreak?.key).toBe("h2h_points");
  });
});

describe("validateCascade rejections (spec 05 §4.1)", () => {
  const cases: [string, Parameters<typeof validateCascade>[0]][] = [
    ["goal/run difference", ["diff"]],
    ["goals/runs-for", ["for"]],
    ["fair_play", ["fair_play"]],
    ["NRR ledger", ["nrr"]],
    ["sets won/lost", ["set_ratio"]],
    ["games won/lost", ["game_ratio"]],
    ["boards won/lost", ["board_ratio"]],
    ["points won/lost", ["point_ratio"]],
  ];

  it.each(cases)("rejects %s keys the sport does not maintain", (_label, cascade) => {
    let thrown: unknown;
    try {
      validateCascade(cascade, { metrics: [] });
    } catch (err) {
      thrown = err;
    }
    expect(EngineError.is(thrown, "CONFIG_INVALID")).toBe(true);
  });

  it("accepts ratio keys when the sport maintains their ledgers", () => {
    const metric = (key: string) => ({ key, label: key, direction: "desc" as const });
    expect(() =>
      validateCascade(["nrr"], {
        metrics: ["runs_for", "balls_faced_eff", "runs_against", "balls_bowled_eff"].map(metric),
      }),
    ).not.toThrow();
    expect(() =>
      validateCascade(["set_ratio"], { metrics: ["sets_won", "sets_lost"].map(metric) }),
    ).not.toThrow();
    expect(() =>
      validateCascade(["game_ratio"], { metrics: ["games_won", "games_lost"].map(metric) }),
    ).not.toThrow();
    expect(() =>
      validateCascade(["board_ratio"], { metrics: ["boards_won", "boards_lost"].map(metric) }),
    ).not.toThrow();
    expect(() =>
      validateCascade(["point_ratio"], { metrics: ["points_won", "points_lost"].map(metric) }),
    ).not.toThrow();
  });
});
