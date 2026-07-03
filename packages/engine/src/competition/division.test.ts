// End-to-end simulated division — spec 05 acceptance (PROMPT-08 §Acceptance):
// a generic-sport group → knockout division walked start-to-finish with STUB
// generators (real generation is PROMPT-09). Exercises fold → cascade →
// qualification → bracket → final ranks against the actual generic SportModule.
import { describe, expect, it } from "vitest";
import { foldMatch } from "../core/events.ts";
import type { EventEnvelope } from "../core/events.ts";
import type { LineupPair, StageCtx } from "../core/types.ts";
import { generic, type GenericCfg } from "../sports/generic/generic.ts";
import { makeEnvelope } from "../testkit/helpers.ts";
import type { FixtureResult } from "./standings.ts";
import { resolveQualification } from "./qualification.ts";
import {
  completeBracketStage,
  completeTableStage,
  isBracketStageComplete,
  isTableStageComplete,
  openStage,
  type BracketFixture,
  type BracketStage,
  type DivisionEvent,
  type TableFixture,
  type TableStage,
} from "./stage.ts";

const CFG: GenericCfg = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

const CTX: StageCtx = { kind: "group" };

function lineup(entrantId: string): LineupPair["home"] {
  return { entrantId, slots: [{ personId: `${entrantId}-1`, slot: "starting", orderNo: 1 }] };
}

// Play one fixture through the real generic module and return its [home, away]
// standings deltas + who won (the sport module is the source of truth).
function play(home: string, away: string, hg: number, ag: number): { result: FixtureResult; winner: string | null } {
  const lineups: LineupPair = { home: lineup(home), away: lineup(away) };
  const events: EventEnvelope[] = [
    makeEnvelope(0, { type: "core.start", payload: {} }),
    makeEnvelope(1, { type: "generic.result", payload: { p1Score: hg, p2Score: ag } }),
  ];
  const state = foldMatch(generic, CFG, lineups, events);
  const outcome = generic.outcome(state);
  if (outcome === null) throw new Error("fixture did not decide");
  const result = generic.standingsDelta(outcome, CFG, CTX, state);
  const winner = outcome.kind === "win" ? outcome.winner : null;
  return { result, winner };
}

// Stub round-robin: every pair once, higher-seed (earlier in `order`) wins 1-0.
function roundRobin(pool: string, order: string[]): TableFixture[] {
  const fixtures: TableFixture[] = [];
  let n = 0;
  for (let i = 0; i < order.length; i++) {
    for (let j = i + 1; j < order.length; j++) {
      const home = order[i] as string;
      const away = order[j] as string;
      fixtures.push({ id: `${pool}-${n++}`, poolId: pool, status: "decided", result: play(home, away, 1, 0).result });
    }
  }
  return fixtures;
}

// Standard fold seeding order (spec 05 §2.3): 1 meets 2 only in the final.
function seedOrder(size: number): number[] {
  let seeds = [1, 2];
  while (seeds.length < size) {
    const sum = seeds.length * 2 + 1;
    const next: number[] = [];
    for (const seed of seeds) {
      next.push(seed, sum - seed);
    }
    seeds = next;
  }
  return seeds;
}

// Stub single-elimination bracket over a seed list (seed 1 first); lower seed
// number wins each tie. Returns the fixtures (with winner/loser + isFinal).
function bracket(seedList: string[]): BracketFixture[] {
  const rankOf = new Map(seedList.map((id, i) => [id, i]));
  let survivors = seedOrder(seedList.length).map((seed) => seedList[seed - 1] as string);
  const fixtures: BracketFixture[] = [];
  let round = 0;
  while (survivors.length > 1) {
    const isFinal = survivors.length === 2;
    const winners: string[] = [];
    for (let i = 0; i < survivors.length; i += 2) {
      const home = survivors[i] as string;
      const away = survivors[i + 1] as string;
      const homeIsHigher = (rankOf.get(home) ?? 0) < (rankOf.get(away) ?? 0);
      const { winner } = play(home, away, homeIsHigher ? 1 : 0, homeIsHigher ? 0 : 1);
      const won = winner as string;
      const lost = won === home ? away : home;
      fixtures.push({ id: `ko-r${round}-${i / 2}`, round, ...(isFinal ? { isFinal: true } : {}), status: "decided", home, away, winner: won, loser: lost });
      winners.push(won);
    }
    survivors = winners;
    round++;
  }
  return fixtures;
}

// Walk a whole division and return the champion + the division-event ledger.
function runDivision(): { champion: string; events: DivisionEvent[]; finalRanks: string[] } {
  const events: DivisionEvent[] = [];

  // --- Group stage: two pools of three, top two of each advance. ---
  const groupStage: TableStage = {
    id: "groups",
    kind: "group",
    entrants: ["a1", "a2", "a3", "b1", "b2", "b3"],
    cascade: ["points", "diff", "for", "lots"],
    rngSeed: 42,
  };
  events.push(...openStage(groupStage.id));
  const groupFixtures = [...roundRobin("A", ["a1", "a2", "a3"]), ...roundRobin("B", ["b1", "b2", "b3"])];
  expect(isTableStageComplete(groupStage, groupFixtures)).toBe(true);

  const completedGroups = completeTableStage(groupStage, groupFixtures);
  events.push(...completedGroups.events);

  // --- Qualification: A1,B1,A2,B2 seed the bracket (cross-pool template). ---
  const seeds = resolveQualification(
    { from: "groups", take: [{ pool: "A", rank: 1 }, { pool: "B", rank: 1 }, { pool: "A", rank: 2 }, { pool: "B", rank: 2 }] },
    completedGroups.tables,
  );

  // --- Knockout stage: seeded SE bracket to the final. ---
  const koStage: BracketStage = { id: "ko", kind: "knockout", seeds: new Map(seeds.map((id, i) => [id, i + 1])) };
  events.push(...openStage(koStage.id));
  const koFixtures = bracket(seeds);
  expect(isBracketStageComplete(koStage, koFixtures)).toBe(true);

  const completedKo = completeBracketStage(koStage, koFixtures);
  events.push(...completedKo.events);

  return { champion: completedKo.finalRanks[0] as string, events, finalRanks: completedKo.finalRanks };
}

describe("full division: group → knockout, generic sport (spec 05 acceptance)", () => {
  it("crowns the top seed and produces a complete final ranking", () => {
    const { champion, finalRanks } = runDivision();
    // a1 tops pool A, b1 tops pool B; seeds a1,b1,a2,b2 → a1 wins the bracket.
    expect(champion).toBe("a1");
    expect(finalRanks).toEqual(["a1", "b1", "a2", "b2"]);
  });

  it("logs the structural division events for both stages (spec 05 §5)", () => {
    const { events } = runDivision();
    expect(events.filter((e) => e.type === "stage_opened").map((e) => e.stageId)).toEqual(["groups", "ko"]);
    const completed = events.filter((e) => e.type === "stage_completed");
    expect(completed).toHaveLength(2);
    expect(completed[1]).toMatchObject({ stageId: "ko", finalRanks: ["a1", "b1", "a2", "b2"] });
  });

  it("is idempotent — re-running the division reproduces it exactly (spec 05 §3)", () => {
    const first = runDivision();
    const second = runDivision();
    expect(second.finalRanks).toEqual(first.finalRanks);
    expect(second.events).toEqual(first.events);
  });
});
