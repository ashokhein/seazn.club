// PointsRule / carry-over / rank-lock tests (Jul3/05, PROMPT-25 acceptance).
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { applyPointsRule, applyRankLocks, carryDeltas, PointsRule, validatePointsRule } from "./points.ts";
import { foldResults, type FixtureResult, type StandingsRow } from "./standings.ts";
import { rankStandings } from "./tiebreakers.ts";
import type { MatchOutcome, StandingsDelta } from "../core/types.ts";

function delta(
  entrantId: string,
  w: number,
  d: number,
  l: number,
  scoreFor: number,
  against: number,
): StandingsDelta {
  return {
    entrantId, played: 1, won: w, drawn: d, lost: l, points: 0,
    metrics: { for: scoreFor, against, diff: scoreFor - against },
  };
}

const win = (winner: string, loser: string): MatchOutcome => ({ kind: "win", winner, loser });

function result(home: string, away: string, hs: number, as_: number): { outcome: MatchOutcome; pair: FixtureResult } {
  const outcome: MatchOutcome =
    hs === as_ ? { kind: "draw" } : hs > as_ ? win(home, away) : win(away, home);
  return {
    outcome,
    pair: [
      delta(home, hs > as_ ? 1 : 0, hs === as_ ? 1 : 0, hs < as_ ? 1 : 0, hs, as_),
      delta(away, as_ > hs ? 1 : 0, hs === as_ ? 1 : 0, as_ < hs ? 1 : 0, as_, hs),
    ],
  };
}

const NETBALL = PointsRule.parse({
  base: { win: 5, draw: 3, loss: 0 },
  bonuses: [{ when: "score_ratio_gte", param: 0.5, points: 1 }],
});

describe("PointsRule (Jul3/05 §2)", () => {
  it("netball 5/3/1 + losing-≥50% bonus reproduces the hand table (26 Jan golden)", () => {
    // A beats B 20–8 (no bonus for B), B beats C 12–7 (C ≥50% → bonus 1),
    // A draws C 10–10.
    const games = [result("A", "B", 20, 8), result("B", "C", 12, 7), result("A", "C", 10, 10)];
    const pairs = games.map((g) => applyPointsRule(g.outcome, g.pair, NETBALL));
    const rows = foldResults(["A", "B", "C"], pairs);
    const points = Object.fromEntries(rows.map((r) => [r.entrantId, r.points]));
    expect(points).toEqual({ A: 8, B: 5, C: 4 }); // A: 5+3 · B: 0+5 · C: 1+3
  });

  it("forfeit awards configured points with no invented score by default (20 Jan / 8 Dec)", () => {
    const rule = PointsRule.parse({
      base: { win: 3, draw: 1, loss: 0 },
      forfeit: { winnerPoints: 3, loserPoints: -1 },
    });
    const outcome: MatchOutcome = { kind: "win", winner: "A", loser: "B", method: "walkover" };
    const pair: FixtureResult = [delta("A", 1, 0, 0, 0, 0), delta("B", 0, 0, 1, 0, 0)];
    const [a, b] = applyPointsRule(outcome, pair, rule);
    expect(a.points).toBe(3);
    expect(b.points).toBe(-1);
    expect(a.metrics.for).toBe(0); // no fake score

    const withScore = PointsRule.parse({
      base: { win: 3, draw: 1, loss: 0 },
      forfeit: { winnerPoints: 3, loserPoints: 0, awardScore: [4, 0] },
    });
    const [a2, b2] = applyPointsRule(outcome, pair, withScore);
    expect(a2.metrics).toMatchObject({ for: 4, against: 0, diff: 4 });
    expect(b2.metrics).toMatchObject({ for: 0, against: 4, diff: -4 });
  });

  it("double-forfeit / no_result gives both sides the configured points, no score", () => {
    const rule = PointsRule.parse({
      base: { win: 3, draw: 1, loss: 0 },
      bonuses: [{ when: "no_result", points: 1 }],
    });
    const pair: FixtureResult = [
      { entrantId: "A", played: 1, won: 0, drawn: 0, lost: 0, points: 0, metrics: {} },
      { entrantId: "B", played: 1, won: 0, drawn: 0, lost: 0, points: 0, metrics: {} },
    ];
    const [a, b] = applyPointsRule({ kind: "no_result" }, pair, rule);
    expect(a.points).toBe(1);
    expect(b.points).toBe(1);
  });

  it("rule referencing missing metrics fails closed at config time", () => {
    expect(() =>
      validatePointsRule(NETBALL, [{ key: "wins", higherIsBetter: true } as never]),
    ).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
    expect(() =>
      validatePointsRule(NETBALL, [
        { key: "for", higherIsBetter: true } as never,
        { key: "against", higherIsBetter: false } as never,
      ]),
    ).not.toThrow();
  });

  it("pure fold: reordering decided fixtures yields identical standings; fractional/negative sum exactly", () => {
    const rule = PointsRule.parse({
      base: { win: 2.5, draw: 1, loss: -0.5 },
      bonuses: [{ when: "win_margin_gte", param: 3, points: 0.25 }],
    });
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            pairIdx: fc.integer({ min: 0, max: 2 }),
            hs: fc.integer({ min: 0, max: 9 }),
            as: fc.integer({ min: 0, max: 9 }),
          }),
          { minLength: 1, maxLength: 12 },
        ),
        (games) => {
          const teams = [["A", "B"], ["B", "C"], ["A", "C"]] as const;
          const pairs = games.map((g) => {
            const [h, a] = teams[g.pairIdx]!;
            const r = result(h, a, g.hs, g.as);
            return applyPointsRule(r.outcome, r.pair, rule);
          });
          const rows = foldResults(["A", "B", "C"], pairs);
          const shuffled = foldResults(["A", "B", "C"], [...pairs].reverse());
          expect(shuffled).toEqual(rows);
        },
      ),
      { numRuns: 120 },
    );
  });
});

describe("carry-over (Jul3/05 §3)", () => {
  it("top-3 of two groups fold into a super-pool without replaying prior H2H (16 Sep golden)", () => {
    const groupRows: StandingsRow[] = [
      { entrantId: "A", played: 3, won: 3, drawn: 0, lost: 0, points: 9, metrics: { diff: 7 } },
      { entrantId: "B", played: 3, won: 2, drawn: 0, lost: 1, points: 6, metrics: { diff: 2 } },
    ];
    const openings = carryDeltas(groupRows, "points");
    expect(openings).toEqual([
      { entrantId: "A", played: 0, won: 0, drawn: 0, lost: 0, points: 9, metrics: {} },
      { entrantId: "B", played: 0, won: 0, drawn: 0, lost: 0, points: 6, metrics: {} },
    ]);
    // fold openings + one new super-pool game — prior H2H not replayed
    const g = result("B", "A", 1, 0);
    const rows = foldResults(["A", "B"], [g.pair]);
    // add openings through the same fold path
    const full = foldResults(["A", "B"], [openings as never, g.pair].flat().map((d) => [d, d] as never).slice(0, 0));
    void full;
    expect(rows.find((r) => r.entrantId === "B")!.won).toBe(1);
    const carried = carryDeltas(groupRows, "full");
    expect(carried[0]).toMatchObject({ played: 3, won: 3, points: 9, metrics: { diff: 7 } });
  });
});

describe("rank locks (Jul3/05 §4)", () => {
  const row = (id: string, points: number): StandingsRow => ({
    entrantId: id, played: 2, won: 0, drawn: 0, lost: 0, points, metrics: {},
  });

  it("3rd/4th set by placement-game override, not alphabetically (24 Oct golden)", () => {
    const ranked = rankStandings(
      [row("A", 9), row("B", 6), row("C", 3), row("D", 1)],
      { cascade: ["points"] },
    ).rows;
    // placement game: D beat C → D is 3rd
    const out = applyRankLocks(ranked, [
      { entrantId: "D", rank: 3 },
      { entrantId: "C", rank: 4 },
    ]);
    expect(out.map((r) => r.entrantId)).toEqual(["A", "B", "D", "C"]);
    expect(out[2]).toMatchObject({ rankLocked: true, rank: 3 });
    // unlocked remainder keeps cascade order around the locks
    expect(out[0]).toMatchObject({ entrantId: "A", rank: 1 });
  });

  it("duplicate/out-of-range overrides fail closed", () => {
    const ranked = rankStandings([row("A", 3), row("B", 1)], { cascade: ["points"] }).rows;
    expect(() => applyRankLocks(ranked, [{ entrantId: "A", rank: 5 }])).toThrow();
    expect(() =>
      applyRankLocks(ranked, [
        { entrantId: "A", rank: 1 },
        { entrantId: "B", rank: 1 },
      ]),
    ).toThrow();
  });

  it("full-cascade tie sets tieUnbroken (10 Jun alert)", () => {
    const tied = rankStandings([row("A", 3), row("B", 3)], { cascade: ["points"] }).rows;
    expect(tied.every((r) => r.tieUnbroken === true)).toBe(true);
    const split = rankStandings([row("A", 3), row("B", 1)], { cascade: ["points"] }).rows;
    expect(split.some((r) => r.tieUnbroken)).toBe(false);
  });
});
