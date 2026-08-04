// Decomposed repair (#401) — the graph half.
//
// The wave's lock is "no fixture-count gate: solve the full 500-movable range".
// The solver cannot: the bare feasibility probe does not return in 119 s from
// about 80 movable up. What CAN is freezing all but one interaction component
// into `existing`, solving that component, committing it, and moving on — so
// these tests are first of all tests of the partition, because a partition that
// separates two fixtures which can actually collide is a partition that hands
// the solver a board the verifier then rejects.
import { describe, expect, it } from "vitest";
import type { Assignment, OrderDependency, VerifyConfig } from "./calendar.ts";
import { repairComponents } from "./repair-decompose.ts";

const MIN = 60_000;
const T0 = Date.parse("2026-09-07T09:00:00Z");

const at = (
  id: string,
  court: string,
  offsetMin: number,
  entrants: string[],
  durationMin = 40,
): Assignment => ({
  fixtureId: id,
  court,
  startAt: T0 + offsetMin * MIN,
  endAt: T0 + (offsetMin + durationMin) * MIN,
  entrants,
  people: entrants.map((e) => `p-${e}`),
});

const cfg = (over: Partial<VerifyConfig> = {}): VerifyConfig & { courts: readonly string[] } => ({
  matchMinutes: 40,
  gapMinutes: 5,
  perEntrantMinRest: 45,
  blackouts: [],
  sessionWindows: [],
  tz: "UTC",
  courts: ["C1", "C2"],
  ...over,
});

const idsOf = (
  proposal: readonly Assignment[],
  dependencies: readonly OrderDependency[] = [],
  config = cfg(),
): string[][] => repairComponents({ proposal, dependencies, config }).map((c) => [...c.fixtureIds]);

describe("repairComponents", () => {
  it("separates fixtures that share neither a court nor a person nor an hour", () => {
    // Different courts, different entrants, and far enough apart that no rest
    // rule could ever reach across.
    const board = [
      at("f1", "C1", 0, ["e1", "e2"]),
      at("f2", "C2", 600, ["e3", "e4"]),
    ];
    expect(idsOf(board)).toEqual([["f1"], ["f2"]]);
  });

  it("joins two fixtures on one court at one time", () => {
    const board = [at("f1", "C1", 0, ["e1", "e2"]), at("f2", "C1", 0, ["e3", "e4"])];
    expect(idsOf(board)).toEqual([["f1", "f2"]]);
  });

  it("joins two fixtures sharing a person even on different courts", () => {
    const board = [at("f1", "C1", 0, ["e1", "e2"]), at("f2", "C2", 0, ["e2", "e3"])];
    expect(idsOf(board)).toEqual([["f1", "f2"]]);
  });

  it("joins a pair that never overlaps but still owes rest", () => {
    // 40-minute matches 50 minutes apart: no overlap at all, and a 45-minute
    // rest the shared entrant is still owed. A graph built on OCCUPANCY overlap
    // alone would cut this edge, hand the two halves to separate solves, and
    // let one of them place a card the verifier scores as a rest breach.
    const board = [at("f1", "C1", 0, ["e1", "e2"]), at("f2", "C2", 50, ["e2", "e3"])];
    expect(idsOf(board)).toEqual([["f1", "f2"]]);
  });

  it("joins fixtures wired by an order dependency however far apart they sit", () => {
    const board = [at("f1", "C1", 0, ["e1", "e2"]), at("f2", "C2", 900, ["e3", "e4"])];
    expect(idsOf(board, [{ fixtureId: "f2", dependsOn: "f1", direct: true }])).toEqual([
      ["f1", "f2"],
    ]);
  });

  it("is transitive: a chain of overlaps is one component", () => {
    const board = [
      at("f1", "C1", 0, ["e1", "e2"]),
      at("f2", "C1", 0, ["e3", "e4"]),
      at("f3", "C2", 0, ["e4", "e5"]),
      at("f4", "C2", 500, ["e9", "e8"]),
    ];
    expect(idsOf(board)).toEqual([["f1", "f2", "f3"], ["f4"]]);
  });

  it("reads the separation from the config, not from a constant", () => {
    // Ten hours apart. Only a rest rule that long can make this an edge, and it
    // has to come from the config the verifier reads.
    const board = [at("f1", "C1", 0, ["e1", "e2"]), at("f2", "C2", 600, ["e2", "e3"])];
    expect(idsOf(board)).toEqual([["f1"], ["f2"]]);
    expect(idsOf(board, [], cfg({ perEntrantMinRest: 24 * 60 }))).toEqual([["f1", "f2"]]);
  });

  it("orders components and their fixtures by id, whatever order the board came in", () => {
    const board = [
      at("f9", "C1", 300, ["e7", "e8"]),
      at("f2", "C2", 0, ["e3", "e4"]),
      at("f1", "C1", 0, ["e1", "e2"]),
    ];
    const forward = idsOf(board);
    const reversed = idsOf([...board].reverse());
    expect(forward).toEqual([["f1"], ["f2"], ["f9"]]);
    expect(reversed).toEqual(forward);
  });
});
