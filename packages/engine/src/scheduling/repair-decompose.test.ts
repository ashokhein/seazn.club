// Decomposed repair (#401) — the graph half.
//
// The wave's lock is "no fixture-count gate: solve the full 500-movable range".
// The solver cannot: the bare feasibility probe does not return in 119 s from
// about 80 movable up. What CAN is freezing all but one interaction component
// into `existing`, solving that component, committing it, and moving on — so
// these tests are first of all tests of the partition, because a partition that
// separates two fixtures which can actually collide is a partition that hands
// the solver a board the verifier then rejects.
import { afterAll, describe, expect, it } from "vitest";
import type { Assignment, OrderDependency, VerifyConfig } from "./calendar.ts";
import { validateAssignments } from "./calendar.ts";
import {
  repairComponents,
  repairDecomposed,
  type RepairComponentReport,
} from "./repair-decompose.ts";
import { disjointConflictBound } from "./repair-minimality.ts";
import { singleComponentBoard } from "./repair-synthetic-board.ts";
import { RepairVerificationError } from "./repair.ts";
import { resetZ3, z3LoadCount } from "./z3-load.ts";

const SOLVE_TIMEOUT = 120_000;

afterAll(async () => {
  await resetZ3();
});

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

// A board of independent two-card court clashes, each one 10 hours from the
// next: several DIRTY components, each repairable by moving exactly one card,
// and a free court to move it to. Small on purpose — what these tests measure is
// the driver's behaviour, and every one of them pays a WASM boot per component.
const clashBoard = (
  groups: number,
): { proposal: Assignment[]; config: VerifyConfig & { courts: readonly string[] } } => {
  const proposal: Assignment[] = [];
  for (let g = 0; g < groups; g++) {
    const off = g * 600;
    proposal.push(at(`g${g}a`, "C1", off, [`e${g}0`, `e${g}1`]));
    proposal.push(at(`g${g}b`, "C1", off, [`e${g}2`, `e${g}3`]));
  }
  return {
    proposal,
    config: cfg({
      window: { from: T0 - 60 * MIN, to: T0 + (groups * 600 + 120) * MIN },
    }),
  };
};

describe("repairDecomposed", () => {
  it(
    "repairs every dirty component and returns a board the real verifier accepts",
    async () => {
      const { proposal, config } = clashBoard(3);
      expect(validateAssignments(proposal, config)).not.toHaveLength(0);

      const r = await repairDecomposed({ proposal, config, budgetMs: 60_000 });

      expect(r.status).toBe("repaired");
      expect(r.mode).toBe("components");
      expect(r.components.map((c) => c.outcome)).toEqual(["repaired", "repaired", "repaired"]);
      expect(r.components.map((c) => c.size)).toEqual([2, 2, 2]);
      // Every component solved against the WHOLE rest of the board, not a
      // fragment of it: the caller's immovables plus the four cards in the other
      // two components.
      expect(r.components.map((c) => c.frozen)).toEqual([4, 4, 4]);
      expect(r.k).toBe(3);
      expect(r.moved).toHaveLength(3);
      expect(validateAssignments(r.assignments, config)).toEqual([]);
      expect(r.residual).toEqual([]);
      // The board comes back in the order it went in, whatever order the
      // components solved in.
      expect(r.assignments.map((a) => a.fixtureId)).toEqual(proposal.map((a) => a.fixtureId));
    },
    SOLVE_TIMEOUT,
  );

  it(
    "proves minimality with a certificate rather than claiming it from the search",
    async () => {
      const { proposal, config } = clashBoard(3);
      const r = await repairDecomposed({ proposal, config, budgetMs: 60_000 });

      // Three clashes with no fixture in common: each needs a move of its own,
      // so three moves is the floor and the three found meet it.
      expect(r.minimality.lowerBound).toBe(3);
      expect(r.minimality.k).toBe(3);
      expect(r.minimality.verdict).toBe("proved");
      expect(r.minimality.caveats).toEqual([]);
      expect(r.minimality.witnesses).toHaveLength(3);
      for (const w of r.minimality.witnesses) expect(w.fixtureIds).toHaveLength(2);
      // Disjoint, which is the whole argument.
      const named = r.minimality.witnesses.flatMap((w) => [...w.fixtureIds]);
      expect(new Set(named).size).toBe(named.length);
    },
    SOLVE_TIMEOUT,
  );

  it(
    "tears the WASM heap down between component solves",
    async () => {
      // MEASURED, not defensive. Without a reset between components many medium
      // solves share one monotonically-growing WASM heap and nothing frees the
      // per-component Solver: three runs of three died with `RuntimeError:
      // memory access out of bounds` from the pthread worker; three of three
      // survived with the reset.
      //
      // Asserted through `z3LoadCount()` rather than by trying to provoke the
      // crash — a test that depends on an OOM firing is flaky by construction.
      // The count is zeroed by `resetZ3` and raised by the next `loadZ3`, so a
      // run that left the context up between components reads 1 here.
      const { proposal, config } = clashBoard(3);
      const counts: number[] = [];
      const solved: RepairComponentReport[] = [];
      const r = await repairDecomposed({
        proposal,
        config,
        budgetMs: 60_000,
        onComponent: (report) => {
          counts.push(z3LoadCount());
          solved.push(report);
        },
      });

      expect(r.status).toBe("repaired");
      expect(counts).toEqual([0, 0, 0]);
      expect(z3LoadCount()).toBe(0);
      // Not vacuous: the WASM really was loaded and really did solve, three
      // separate times.
      expect(solved.map((c) => c.checks > 0)).toEqual([true, true, true]);
    },
    SOLVE_TIMEOUT,
  );

  it(
    "is a function of its input: the same board twice gives byte-identical output",
    async () => {
      const { proposal, config } = clashBoard(2);
      const strip = (r: Awaited<ReturnType<typeof repairDecomposed>>): unknown => ({
        status: r.status,
        assignments: r.assignments,
        moved: r.moved,
        k: r.k,
        relaxed: r.relaxed,
        minimality: r.minimality,
        components: r.components.map(({ elapsedMs: _drop, ...rest }) => rest),
      });
      const first = await repairDecomposed({ proposal, config, budgetMs: 60_000 });
      const second = await repairDecomposed({ proposal, config, budgetMs: 60_000 });
      expect(strip(second)).toEqual(strip(first));
    },
    SOLVE_TIMEOUT,
  );

  it("answers a clean board without ever loading the WASM", async () => {
    const { proposal, config } = clashBoard(1);
    // Un-clash it.
    proposal[1]!.court = "C2";
    await resetZ3();
    const r = await repairDecomposed({ proposal, config, budgetMs: 60_000 });
    expect(r.status).toBe("clean");
    expect(r.k).toBe(0);
    expect(r.minimality.verdict).toBe("proved");
    expect(z3LoadCount()).toBe(0);
  });
});

describe("the per-component gate", () => {
  it("declines a component larger than the limit, and says so in telemetry", async () => {
    const { proposal, config } = clashBoard(2);
    await resetZ3();
    const r = await repairDecomposed({ proposal, config, budgetMs: 60_000, componentLimit: 1 });

    expect(r.status).toBe("unrepaired");
    expect(r.moved).toEqual([]);
    expect(r.components.map((c) => c.outcome)).toEqual(["skipped", "skipped"]);
    expect(r.components.map((c) => c.skipReason)).toEqual([
      "over_component_limit",
      "over_component_limit",
    ]);
    // Which fixtures were left for LLM repair is part of the answer, not a
    // detail the caller has to reconstruct.
    expect(r.unresolvedFixtureIds).toEqual(["g0a", "g0b", "g1a", "g1b"]);
    expect(r.residual.length).toBeGreaterThan(0);
    expect(r.minimality.verdict).toBe("upper_bound");
    expect(r.minimality.caveats).toContain("components_unresolved");
    // A declined component costs nothing at all — no boot, no encode.
    expect(z3LoadCount()).toBe(0);
  });

  it(
    "keeps what it repaired when a later component is declined",
    async () => {
      // Three cards on one court at one time: one component of three, over a
      // limit of two, while the two-card group beside it is under it. The
      // ANYTIME property in miniature — the budget's exhaustion has the same
      // shape.
      const { proposal, config } = clashBoard(1);
      proposal.push(at("g1a", "C1", 600, ["e10", "e11"]));
      proposal.push(at("g1b", "C1", 600, ["e12", "e13"]));
      proposal.push(at("g1c", "C1", 600, ["e14", "e15"]));

      const r = await repairDecomposed({ proposal, config, budgetMs: 60_000, componentLimit: 2 });

      expect(r.status).toBe("partial");
      expect(r.components.map((c) => c.outcome)).toEqual(["repaired", "skipped"]);
      expect(r.k).toBe(1);
      // The part it did repair really is repaired: every remaining conflict
      // belongs to the component it declined.
      expect(r.residual.length).toBeGreaterThan(0);
      for (const c of r.residual) expect(["g1a", "g1b", "g1c"]).toContain(c.fixtureId);
      expect(r.unresolvedFixtureIds).toEqual(["g1a", "g1b", "g1c"]);
      expect(r.minimality.verdict).toBe("upper_bound");
    },
    SOLVE_TIMEOUT,
  );

  it("stops solving once the whole call's budget is gone", async () => {
    const { proposal, config } = clashBoard(3);
    await resetZ3();
    const r = await repairDecomposed({ proposal, config, budgetMs: 1 });

    expect(r.status).toBe("unrepaired");
    expect(r.moved).toEqual([]);
    expect(r.components.some((c) => c.skipReason === "budget_exhausted")).toBe(true);
    expect(r.minimality.caveats).toContain("components_unresolved");
    // The board is handed back exactly as it arrived, not half-rewritten.
    expect(r.assignments).toEqual(proposal);
  });
});

describe("the pathological single-component board", () => {
  it("declines a whole board that is one component, in milliseconds", async () => {
    const board = singleComponentBoard({ n: 120 });
    expect(repairComponents(board)).toHaveLength(1);
    await resetZ3();
    const t0 = performance.now();
    const r = await repairDecomposed({
      proposal: board.proposal,
      config: board.config,
      dependencies: board.dependencies,
      budgetMs: 60_000,
    });
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(r.status).toBe("unrepaired");
    expect(r.components).toHaveLength(1);
    expect(r.components[0]?.skipReason).toBe("over_component_limit");
    expect(z3LoadCount()).toBe(0);
  });

  it(
    "degrades to exactly today's behaviour when the gate is lifted: one solve, budget, no repair",
    async () => {
      // With the gate raised out of the way this board is the single solve
      // decomposition replaces — and the requirement is that it is no WORSE. One
      // component means one solve; one solve at this size means the feasibility
      // probe, which does not return; so the budget is what has to bring control
      // back, and it has to bring it back on time.
      const board = singleComponentBoard({ n: 120 });
      const budgetMs = 2_500;
      const t0 = performance.now();
      const r = await repairDecomposed({
        proposal: board.proposal,
        config: board.config,
        dependencies: board.dependencies,
        budgetMs,
        componentLimit: 500,
      });
      const wall = performance.now() - t0;

      expect(r.components).toHaveLength(1);
      expect(r.components[0]?.outcome).toBe("timeout");
      expect(r.components[0]?.checks).toBeGreaterThanOrEqual(1);
      expect(r.status).toBe("unrepaired");
      expect(r.moved).toEqual([]);
      expect(r.assignments).toEqual(board.proposal);
      // The bound is the point: "it came back" is also true of four minutes.
      // Slack covers the un-sampled prologue and the certificate pass.
      expect(wall).toBeLessThan(budgetMs + 6_000);
    },
    SOLVE_TIMEOUT,
  );
});

describe("the max_fixtures_per_day guard", () => {
  // Three cards on one calendar day under a 2/day cap, split across two
  // components: `A` alone in the morning, `B`+`C` back to back in the evening.
  // `A` and `B` are NOT in `ruleFixtures`.
  //
  // That is the whole bug. `assertDayCap` filters `existing` by
  // `fixtureById.has()` — an outside booking is not a fixture and counting one
  // would invent a cap breach out of a blackout — so the moment an unindexed
  // PROPOSAL card is frozen it becomes invisible to the cap. Solving `B`+`C`
  // with `A` frozen counts one card on the day; solving `A` with `B`+`C` frozen
  // counts one; the whole-board verifier counts three and rejects the board the
  // solver called repaired. Fourth instance of this wave's dominant bug class:
  // an encoder unit that is not the verifier's unit.
  const cappedBoard = (
    knownIds: readonly string[],
  ): { proposal: Assignment[]; config: VerifyConfig & { courts: readonly string[] } } => ({
    proposal: [
      at("a", "C1", 0, ["e1", "e2"]),
      at("b", "C1", 540, ["e3", "e4"]),
      at("c", "C1", 590, ["e5", "e6"]),
    ],
    config: cfg({
      window: { from: T0 - 60 * MIN, to: T0 + (2 * 1440 + 600) * MIN },
      hard: [{ type: "max_fixtures_per_day", count: 2, scope: { kind: "competition" } }],
      ruleFixtures: knownIds.map((id) => ({ id, extKey: null, winnerTo: null })),
    }),
  });

  it("splits the board when every movable fixture is one the cap can see", () => {
    const { proposal, config } = cappedBoard(["a", "b", "c"]);
    expect(repairComponents({ proposal, config })).toHaveLength(2);
  });

  it(
    "refuses to decompose when a movable fixture is invisible to the cap",
    async () => {
      const { proposal, config } = cappedBoard(["c"]);
      // Two components by the graph — and solving them apart is exactly what
      // must not happen here.
      expect(repairComponents({ proposal, config })).toHaveLength(2);
      await resetZ3();

      const r = await repairDecomposed({ proposal, config, budgetMs: 60_000 });

      expect(r.mode).toBe("whole_board");
      expect(r.modeReason).toBe("day_cap_unindexed_fixtures");
      expect(r.components).toHaveLength(1);
      expect(r.components[0]?.fixtureIds).toEqual(["a", "b", "c"]);
      // Nothing is frozen in whole-board mode, so the cap counts what the
      // verifier counts and the answer survives it.
      expect(r.components[0]?.frozen).toBe(0);
      expect(r.status).toBe("repaired");
      expect(r.k).toBe(1);
      expect(validateAssignments(r.assignments, config)).toEqual([]);
      // A per-day cap row names one card out of a whole day, and its detail
      // carries the day's TOTAL — so no two-card sub-board reproduces it and it
      // proves no lower bound. Reported as the upper bound it is.
      expect(r.minimality.lowerBound).toBe(0);
      expect(r.minimality.verdict).toBe("upper_bound");
    },
    SOLVE_TIMEOUT,
  );

  it(
    "still splits a capped board whose fixtures the cap can all see",
    async () => {
      const { proposal, config } = cappedBoard(["a", "b", "c"]);
      await resetZ3();
      const r = await repairDecomposed({ proposal, config, budgetMs: 60_000 });

      expect(r.mode).toBe("components");
      expect(validateAssignments(r.assignments, config)).toEqual([]);
      // Sequential commits make a cap ORDER-DEPENDENT — solving one component
      // first can fill a day the next then cannot use. Sound, but no longer
      // provably minimal, and the certificate says so rather than overclaiming.
      expect(r.minimality.caveats).toContain("day_cap_order_dependent");
      expect(r.minimality.verdict).toBe("upper_bound");
    },
    SOLVE_TIMEOUT,
  );

  it("never throws a verification error on either shape", async () => {
    // Guard against the failure mode this whole block exists for: a board the
    // solver calls repaired and the verifier rejects arrives as a
    // RepairVerificationError, and it must not.
    await resetZ3();
    for (const known of [["c"], ["a", "b", "c"]]) {
      const { proposal, config } = cappedBoard(known);
      await expect(
        repairDecomposed({ proposal, config, budgetMs: 60_000 }),
      ).resolves.not.toBeInstanceOf(RepairVerificationError);
    }
  }, SOLVE_TIMEOUT);
});

describe("disjointConflictBound", () => {
  // The certificate on its own, without a solver in the way. What it must never
  // do is over-count: a bound larger than the true minimum turns an honest
  // "upper_bound" into a false "proved", which is the only way this file can
  // lie.
  it("counts one move per clash when the clashes share no fixture", () => {
    const { proposal, config } = clashBoard(2);
    const bound = disjointConflictBound({
      proposal,
      config,
      conflicts: validateAssignments(proposal, config),
    });
    expect(bound.lowerBound).toBe(2);
    expect(bound.witnesses.map((w) => [...w.fixtureIds])).toEqual([
      ["g0a", "g0b"],
      ["g1a", "g1b"],
    ]);
    expect(bound.unattributed).toBe(0);
  });

  it("never counts one card twice, even when it is in several conflicts", () => {
    // Three cards on one court at one time. Six conflict rows, three pairs, and
    // every pair shares a fixture with both others — so the disjoint set holds
    // exactly one. Two moves are actually needed here, which is the point: this
    // is a LOWER bound, and a weak lower bound is honest where an inflated one
    // would certify a repair that moved one card too many.
    const proposal = [
      at("a", "C1", 0, ["e1", "e2"]),
      at("b", "C1", 0, ["e3", "e4"]),
      at("c", "C1", 0, ["e5", "e6"]),
    ];
    const config = cfg();
    expect(validateAssignments(proposal, config).length).toBeGreaterThan(1);
    expect(disjointConflictBound({ proposal, config, conflicts: validateAssignments(proposal, config) }).lowerBound).toBe(1);
  });

  it("still counts a clash whose counterparty cannot be moved", () => {
    const movable = [at("a", "C1", 0, ["e1", "e2"])];
    const immovable = [at("z", "C1", 0, ["e3", "e4"])];
    const config = cfg();
    const bound = disjointConflictBound({
      proposal: movable,
      existing: immovable,
      config,
      conflicts: validateAssignments(movable, config, immovable),
    });
    // One move, and it has to be `a` — the witness names only what can move.
    expect(bound.lowerBound).toBe(1);
    expect(bound.witnesses[0]?.fixtureIds).toEqual(["a"]);
  });

  it("proves nothing from a per-day cap, and says how many rows it could not use", () => {
    // A cap row names one card and its detail carries the whole DAY's total, so
    // no one- or two-card sub-board reproduces it. Left out of the bound rather
    // than guessed at: three cards on a day are not three independent moves.
    const proposal = [
      at("a", "C1", 0, ["e1", "e2"]),
      at("b", "C1", 540, ["e3", "e4"]),
      at("c", "C1", 590, ["e5", "e6"]),
    ];
    const config = cfg({
      hard: [{ type: "max_fixtures_per_day", count: 2, scope: { kind: "competition" } }],
      ruleFixtures: ["a", "b", "c"].map((id) => ({ id, extKey: null, winnerTo: null })),
    });
    const conflicts = validateAssignments(proposal, config);
    expect(conflicts).toHaveLength(3);
    const bound = disjointConflictBound({ proposal, config, conflicts });
    expect(bound.lowerBound).toBe(0);
    expect(bound.unattributed).toBe(3);
  });
});

describe("two repairs at once", () => {
  it(
    "serialises, because tearing the WASM down under a live solve is the abort it exists to prevent",
    async () => {
      // The reset between components is process-wide. A second decomposed
      // repair overlapping the first would call it while the first is inside
      // `check()`, terminating the pthreads underneath it — and the division
      // runner and the competition runner each have their own repair loop, so a
      // joint run really can have both in flight.
      const first = clashBoard(2);
      const second = clashBoard(2);
      const order: string[] = [];
      const [a, b] = await Promise.all([
        repairDecomposed({
          proposal: first.proposal,
          config: first.config,
          budgetMs: 60_000,
          onComponent: () => order.push("a"),
        }),
        repairDecomposed({
          proposal: second.proposal,
          config: second.config,
          budgetMs: 60_000,
          onComponent: () => order.push("b"),
        }),
      ]);

      expect(a.status).toBe("repaired");
      expect(b.status).toBe("repaired");
      expect(order).toHaveLength(4);
      // Grouped, not interleaved: one call's components all run before the
      // other's start.
      expect(order.join("")).toBe(order[0] === "a" ? "aabb" : "bbaa");
    },
    SOLVE_TIMEOUT,
  );
});
