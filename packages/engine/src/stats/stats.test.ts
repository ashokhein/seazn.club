// Player-stats fold tests (Jul3/07, PROMPT-27 acceptance).
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { aggregatePlayerStats, sumPlayerStats } from "./stats.ts";
import { football } from "../sports/football/football.ts";
import type { EventEnvelope } from "../core/events.ts";

const MODEL = football.playerStats!;

function env(seq: number, type: string, payload: Record<string, unknown>, voids?: string): EventEnvelope {
  return {
    id: `e${seq}`, seq, type, payload,
    recordedAt: "2026-07-20T09:00:00Z",
    ...(voids !== undefined ? { voids } : {}),
  } as EventEnvelope;
}

const goal = (seq: number, scorer?: string, assist?: string, ownGoal = false) =>
  env(seq, "football.goal", {
    by: "H",
    ...(scorer !== undefined ? { scorer } : {}),
    ...(assist !== undefined ? { assist } : {}),
    ...(ownGoal ? { ownGoal: true } : {}),
  });

describe("aggregatePlayerStats (Jul3/07)", () => {
  it("golden: football ledger → goals/assists table with points = goals + assists (16 Apr)", () => {
    const rows = aggregatePlayerStats(
      [
        goal(1, "p7", "p10"),
        goal(2, "p7"),
        goal(3, "p10", "p7"),
        env(4, "football.card", { by: "H", person: "p7", color: "yellow" }),
        env(5, "core.award", { person: "p7", key: "motm" }),
      ],
      MODEL,
    );
    expect(rows).toEqual([
      { personId: "p10", stats: { goals: 1, assists: 1, points: 2 } },
      { personId: "p7", stats: { goals: 2, assists: 1, yellow_cards: 1, motm_awards: 1, points: 3 } },
    ]);
  });

  it("a core.void on a goal drops the goal AND its assist (§8)", () => {
    const rows = aggregatePlayerStats(
      [goal(1, "p7", "p10"), env(2, "core.void", {}, "e1")],
      MODEL,
    );
    expect(rows).toEqual([]);
  });

  it("own goals never credit the striker; assist-less goals count only present fields", () => {
    const rows = aggregatePlayerStats([goal(1, "p9", undefined, true), goal(2, "p9")], MODEL);
    expect(rows).toEqual([{ personId: "p9", stats: { goals: 1, points: 1 } }]);
  });

  it("stats are a pure order-independent fold: refold(events) == snapshot", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            scorer: fc.constantFrom("p1", "p2", "p3"),
            assist: fc.option(fc.constantFrom("p1", "p2", "p3"), { nil: undefined }),
          }),
          { minLength: 1, maxLength: 20 },
        ),
        (goals) => {
          const fixtures = [
            goals.slice(0, Math.ceil(goals.length / 2)),
            goals.slice(Math.ceil(goals.length / 2)),
          ].map((gs, fi) =>
            aggregatePlayerStats(gs.map((g, i) => goal(fi * 100 + i + 1, g.scorer, g.assist)), MODEL),
          );
          const total = sumPlayerStats(fixtures, MODEL);
          const reversed = sumPlayerStats([...fixtures].reverse(), MODEL);
          expect(reversed).toEqual(total);
          // per-division isolation: summing only fixture 0 differs from total
          // unless fixture 1 is empty — tables never bleed
          const only0 = sumPlayerStats([fixtures[0]!], MODEL);
          const f1HasGoals = fixtures[1]!.length > 0;
          if (f1HasGoals) expect(only0).not.toEqual(total);
        },
      ),
      { numRuns: 120 },
    );
  });

  it("MOTM award aggregates into the leaderboard; unknown award keys ignored", () => {
    const rows = aggregatePlayerStats(
      [
        env(1, "core.award", { person: "p7", key: "motm" }),
        env(2, "core.award", { person: "p7", key: "not_declared" }),
      ],
      MODEL,
    );
    expect(rows).toEqual([{ personId: "p7", stats: { motm_awards: 1, points: 0 } }]);
  });
});
