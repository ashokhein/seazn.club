// THE anti-fork test. The encoder and `validateAssignments` must answer the
// same question: for every assignment the lattice can express, the model
// accepts it IFF the verifier reports no conflict. A solver with its own idea
// of the rules produces boards the gate rejects, which is the lock-out this
// whole design exists to prevent.
//
// Every case enumerates EVERY placement the lattice can express, so nothing here
// is a spot check: a single wrong inequality anywhere in the encoder shows up as
// a concrete `{ pick, sat }` mismatch.
//
// WHAT THIS SUITE DOES NOT COVER, deliberately: the `min_rest_minutes` family's
// `feeder_to_dependent` half, which `validateInstructionRules` reports and
// `encodeBuild` does not state. Parity therefore holds only for configs whose
// typed rules are ones the encoder states — which `assertParity` asserts rather
// than assumes, as a WHITELIST, so a later case cannot quietly wander outside
// the envelope and read as covered, and the next unencoded rule type fails here
// the moment somebody writes a case for it.
//
// The other five typed rules ARE encoded (section 9 of `build-encode.ts`) and
// are exercised placement-by-placement in `build-encode-rules.test.ts`.
import { describe, expect, it } from "vitest";
import { buildGrid } from "./build-grid.ts";
import { encodeBuild } from "./build-encode.ts";
import { loadZ3, resetZ3, withZ3Lock } from "./z3-load.ts";
import {
  effectiveHard,
  validateAssignments,
  type Assignment,
  type OrderDependency,
  type SchedulableFixture,
  type SlotConfig,
  type VerifyConfig,
} from "./calendar.ts";
import type { HardConstraint, SchedulingConstraints } from "./constraints.ts";

/** The typed rule types `encodeBuild` states. A WHITELIST on purpose: it was
 *  "no typed rules at all" until Task 3b encoded these five, and keeping it a
 *  whitelist is what makes the NEXT unencoded type fail here rather than pass
 *  unnoticed. */
const ENCODED_RULE_TYPES: ReadonlySet<HardConstraint["type"]> = new Set([
  "max_fixtures_per_day",
  "not_before",
  "not_after",
  "fixture_on_date",
  "fixture_on_weekday",
]);

const MIN = 60_000;
const T0 = Date.UTC(2026, 7, 8, 9, 0);

type Cfg = SlotConfig & { courts: string[] };

const config = (over: Partial<SlotConfig> = {}): Cfg => ({
  startAt: T0,
  matchMinutes: 30,
  gapMinutes: 10,
  courts: ["C1", "C2"],
  perEntrantMinRest: 60,
  window: { from: T0, to: T0 + 6 * 60 * MIN },
  tz: "Europe/London",
  ...over,
});

/** `SchedulingConstraints` defaults five fields, and a zod default is REQUIRED
 *  in the inferred type — so a bare `{ restByGroup: ... }` literal does not
 *  typecheck even though it is what every reader wants to write. */
const constraints = (over: Partial<SchedulingConstraints>): SchedulingConstraints => ({
  noBackToBack: false,
  startWindows: [],
  fieldFairness: "off",
  parallelism: "mixed",
  crossPersonClash: "warn",
  ...over,
});

const fx = (
  id: string,
  home: string,
  away: string,
  people: string[] = [],
  over: Partial<SchedulableFixture> = {},
): SchedulableFixture => ({ id, home, away, people, ...over });

/** Every placement the lattice can express, one fixture per slot, no repeats. */
function* placements(n: number, slotCount: number): Generator<number[]> {
  const pick: number[] = [];
  function* go(i: number): Generator<number[]> {
    if (i === n) {
      yield [...pick];
      return;
    }
    for (let s = 0; s < slotCount; s++) {
      if (pick.includes(s)) continue;
      pick.push(s);
      yield* go(i + 1);
      pick.pop();
    }
  }
  yield* go(0);
}

describe("encodeBuild — verifier parity", () => {
  it("accepts a placement iff validateAssignments does (no siblings)", async () => {
    const cfg = config({ window: { from: T0, to: T0 + 150 * MIN } });
    const fixtures = [fx("f1", "E1", "E2"), fx("f2", "E1", "E3")];
    await assertParity({ cfg, fixtures });
  }, 180_000);

  it("accepts a placement iff validateAssignments does, WITH a sibling sharing a person", async () => {
    // Gap 6: the sibling's court time is already out of the lattice, but its
    // PERSON is not. An encoder that only subtracted court time double-books
    // the human and the verifier rejects the board.
    const cfg = config({ window: { from: T0, to: T0 + 150 * MIN } });
    const existing: Assignment[] = [
      {
        fixtureId: "sib",
        court: "C9",
        startAt: T0 + 30 * MIN,
        endAt: T0 + 60 * MIN,
        entrants: ["E9"],
        people: ["ref1"],
      },
    ];
    const fixtures = [fx("f1", "E1", "E2", ["ref1"])];
    await assertParity({ cfg, fixtures, existing });
  }, 180_000);

  it("rests a pair against an IMMOVABLE in one direction only", async () => {
    // `validateAssignments` never iterates an `existing` row as its outer `a`,
    // so a movable/immovable pair is judged exactly once, in that argument
    // order. Taking `max(pairRest(a,e), pairRest(e,a))` here — which is right
    // for two MOVABLE rows — refuses boards the verifier passes and reports a
    // spurious infeasible.
    //
    // The two directions are forced apart by `restByDivision`, which
    // `pairRestMinutesWith` reads off the SECOND argument: as (movable,
    // immovable) the immovable carries no division and the pair owes 60, while
    // as (immovable, movable) the movable's own division raises it to 120.
    const cfg = config({ courts: ["C1"], window: { from: T0, to: T0 + 240 * MIN } });
    const verify: VerifyConfig = { ...cfg, restByDivision: { D1: 120 } };
    const existing: Assignment[] = [
      {
        fixtureId: "sib",
        court: "C9",
        startAt: T0,
        endAt: T0 + 30 * MIN,
        entrants: ["E9"],
        people: ["ref1"],
      },
    ];
    const fixtures = [fx("f1", "E1", "E2", ["ref1"], { divisionId: "D1" })];
    await assertParity({ cfg, verify, fixtures, existing });
  }, 180_000);

  it("holds a dependent off for its feeder's OCCUPANCY PLUS the rest it owes", async () => {
    // `validateAssignments` bounds a feed edge at
    // `source.endAt + effectiveRestMinutes(config, target)` — the advancing
    // player is a participant of the fixture they feed, so "the feeder has
    // finished" is not enough. An encoder that stops at the feeder's end
    // accepts a whole rest period's worth of boards the verifier rejects.
    //
    // The two fixtures deliberately share NO participant, so the rest bound
    // reaches them only through the dependency.
    const cfg = config({ courts: ["C1"], window: { from: T0, to: T0 + 150 * MIN } });
    const fixtures = [fx("f1", "E1", "E2"), fx("f2", "E3", "E4")];
    const dependencies: OrderDependency[] = [{ fixtureId: "f2", dependsOn: "f1", direct: true }];
    await assertParity({ cfg, fixtures, dependencies });
  }, 180_000);

  it("holds a movable dependent off an IMMOVABLE feeder", async () => {
    // `validateAssignments` builds its dependency index over `existing` too, so
    // a feed edge whose feeder is another division's card is judged exactly as
    // one between two movables. The two rows share no participant and no court,
    // so the dependency is the ONLY thing that can refuse a slot here.
    const cfg = config({ courts: ["C1"], window: { from: T0, to: T0 + 240 * MIN } });
    const existing: Assignment[] = [
      {
        fixtureId: "sib",
        court: "C9",
        startAt: T0 + 60 * MIN,
        endAt: T0 + 90 * MIN,
        entrants: ["E9"],
        people: [],
      },
    ];
    const fixtures = [fx("f1", "E1", "E2")];
    const dependencies: OrderDependency[] = [{ fixtureId: "f1", dependsOn: "sib" }];
    await assertParity({ cfg, fixtures, existing, dependencies });
  }, 180_000);

  it("holds a movable FEEDER off an immovable dependent", async () => {
    // The same edge from the other end. An immovable dependent bounds where its
    // movable feeder may sit, and an encoder that only ever constrains the
    // dependent lets a feeder be scheduled after the fixture it feeds.
    const cfg = config({ courts: ["C1"], window: { from: T0, to: T0 + 240 * MIN } });
    const existing: Assignment[] = [
      {
        fixtureId: "sib",
        court: "C9",
        startAt: T0 + 180 * MIN,
        endAt: T0 + 210 * MIN,
        entrants: ["E9"],
        people: [],
      },
    ];
    const fixtures = [fx("f1", "E1", "E2")];
    const dependencies: OrderDependency[] = [{ fixtureId: "sib", dependsOn: "f1" }];
    await assertParity({ cfg, fixtures, existing, dependencies });
  }, 180_000);

  it("does not read an entrant id as the person id that spells the same", async () => {
    // `validateAssignments` matches entrants against entrants and people
    // against people, never across. An encoder that groups its participants
    // without namespacing them rests these two fixtures against each other and
    // refuses boards the verifier passes — the identity-seam defect this repo
    // has hit eight times, and one no fixture with distinct ids can see.
    const cfg = config({ courts: ["C1"], window: { from: T0, to: T0 + 150 * MIN } });
    const fixtures = [fx("f1", "E1", "E2"), fx("f2", "E3", "E4", ["E1"])];
    await assertParity({ cfg, fixtures, minChecked: 100 });
  }, 180_000);

  it("refuses a slot outside the target's start window", async () => {
    const cfg = config({
      courts: ["C1"],
      window: { from: T0, to: T0 + 150 * MIN },
      constraints: constraints({
        startWindows: [{ target: { kind: "entrant", id: "E1" }, notBefore: T0 + 60 * MIN }],
      }),
    });
    const fixtures = [fx("f1", "E1", "E2")];
    await assertParity({ cfg, fixtures, minChecked: 10 });
  }, 180_000);

  it("rests each pair at its OWN amount when one participant's pairs disagree", async () => {
    // Three fixtures on one entrant, two different rest answers: `f3` sits in a
    // pool with a 90-minute `restByGroup` floor, `f1`/`f2` do not. Any encoding
    // that resolves rest ONCE for the participant — the obvious way to compress
    // the pair loop — is either too loose for `f1/f3` and `f2/f3` or too tight
    // for `f1/f2`, and this case is what separates the two.
    const cfg = config({
      courts: ["C1"],
      matchMinutes: 30,
      gapMinutes: 30,
      perEntrantMinRest: 30,
      window: { from: T0, to: T0 + 300 * MIN },
      constraints: constraints({ restByGroup: { P2: 90 } }),
    });
    const fixtures = [
      fx("f1", "E1", "E2", [], { poolId: "P1" }),
      fx("f2", "E1", "E3", [], { poolId: "P1" }),
      fx("f3", "E1", "E4", [], { poolId: "P2" }),
    ];
    await assertParity({ cfg, fixtures, minChecked: 200 });
  }, 300_000);
});

// The parity harness above forces a FULL placement, so three things it cannot
// speak for get their own tests: `placed[]` (Task 4's T0 maximises the count of
// them, and "unplaced" has to be a legal state for that to mean anything), the
// pinned/locked slot (the verifier knows nothing about `locked`, so a parity
// case would fail by construction), and the model → board round trip.
describe("encodeBuild — the contract Task 4 reads", () => {
  it("leaves a fixture UNPLACED rather than going infeasible, and proves the ceiling", async () => {
    // One slot, three fixtures. A model that insisted on exactly-one-slot-per-
    // fixture would answer `unsat` here and Task 4 could never tell "the board
    // is impossible" from "two of these do not fit".
    const cfg = config({ courts: ["C1"], window: { from: T0, to: T0 + 30 * MIN } });
    const fixtures = [fx("f1", "E1", "E2"), fx("f2", "E3", "E4"), fx("f3", "E5", "E6")];
    const grid = buildGrid({ config: cfg });
    expect(grid.slots.length).toBe(1);

    const { Z3 } = await loadZ3();
    await withZ3Lock(async () => {
      const solver = new Z3.Solver();
      const model = encodeBuild({
        Z3,
        solver,
        fixtures,
        grid,
        config: { ...cfg, matchMinutes: cfg.matchMinutes, courts: cfg.courts },
      });
      expect(await solver.check()).toBe("sat");
      expect(model.slotOf(solver.model()).filter((s) => s !== null)).toHaveLength(1);
      // ...and the ceiling is a PROOF, not a guess: two is out of reach.
      solver.add(Z3.AtLeast(model.placed as [(typeof model.placed)[0], ...typeof model.placed], 2));
      expect(await solver.check()).toBe("unsat");
    });
    await resetZ3();
  }, 120_000);

  it("refuses two fixtures in ONE slot", async () => {
    // The parity harness cannot see this: it enumerates placements with no
    // repeats, so a slot never holds two cards there. It is also the constraint
    // every sliding window in the encoder silently assumes — an occupancy
    // literal cannot count to two, so drop this and the court and rest windows
    // both stop binding a same-slot pair.
    const cfg = config({ courts: ["C1"], window: { from: T0, to: T0 + 150 * MIN } });
    const fixtures = [fx("f1", "E1", "E2"), fx("f2", "E3", "E4")];
    const grid = buildGrid({ config: cfg });

    const { Z3 } = await loadZ3();
    await withZ3Lock(async () => {
      const solver = new Z3.Solver();
      const model = encodeBuild({
        Z3,
        solver,
        fixtures,
        grid,
        config: { ...cfg, matchMinutes: cfg.matchMinutes, courts: cfg.courts },
      });
      solver.add(model.place[0]![0]!);
      solver.add(model.place[1]![0]!);
      expect(await solver.check()).toBe("unsat");
    });
    await resetZ3();
  }, 120_000);

  it("makes the locked slot the ONLY one the encoding admits", async () => {
    // The anchor as a PROOF rather than as a board that happens to match.
    //
    // The case below asserts the returned board, and a board-level assertion
    // cannot tell "the encoding forbids every other slot" from "z3 picked this
    // one anyway" — a free variable still gets some value, and it may well be
    // the right one. That is how the hole stayed open: the web lane dropped
    // `solver.add(place[i][s])` from `build-encode.ts` §4 and its own
    // `only_unlocked: true` spec stayed GREEN, having only ever looked at the
    // board.
    //
    // Asked the only way that settles it: assert the NEGATION and require
    // `unsat`. Without the anchor clause the fixture is free to sit elsewhere,
    // the negation is satisfiable, and this reds — whatever model z3 would have
    // returned. `AtLeast(placed, 2)` forces both cards on so the answer cannot
    // come back `sat` via the empty board, which every clause in the encoder
    // admits (see the header of `build.ts`).
    const cfg = config({ courts: ["C1", "C2"], window: { from: T0, to: T0 + 150 * MIN } });
    const locked = { court: "C2", startAt: T0 + 45 * MIN };
    const fixtures = [fx("f1", "E1", "E2", [], { locked }), fx("f2", "E3", "E4")];
    const grid = buildGrid({ config: cfg, pinned: [locked] });
    const s = grid.slots.findIndex(
      (sl) => sl.court === locked.court && sl.startAt === locked.startAt,
    );
    // The lattice really does offer somewhere else to go, or "no other slot is
    // satisfiable" would be true for reasons that have nothing to do with §4.
    expect(s).toBeGreaterThanOrEqual(0);
    expect(grid.slots.length).toBeGreaterThan(1);

    const { Z3 } = await loadZ3();
    await withZ3Lock(async () => {
      const solver = new Z3.Solver();
      const model = encodeBuild({
        Z3,
        solver,
        fixtures,
        grid,
        config: { ...cfg, matchMinutes: cfg.matchMinutes, courts: cfg.courts },
      });
      // Both cards on the board, so nothing below is answered by placing none.
      solver.add(Z3.AtLeast(model.placed as [(typeof model.placed)[0], ...typeof model.placed], 2));
      expect(await solver.check()).toBe("sat");
      // THE ANCHOR: f1 anywhere but its locked slot is unsatisfiable.
      solver.add(Z3.Not(model.place[0]![s]!));
      expect(await solver.check()).toBe("unsat");
    });
    await resetZ3();
  }, 120_000);

  it("pins a locked fixture to its own slot, even off-grid", async () => {
    const cfg = config({ courts: ["C1", "C2"], window: { from: T0, to: T0 + 150 * MIN } });
    // 45 minutes past the hour is not on a 10-minute lattice; `buildGrid`
    // admits a pinned placement unconditionally so that k=0 stays expressible.
    const locked = { court: "C2", startAt: T0 + 45 * MIN };
    const fixtures = [fx("f1", "E1", "E2", [], { locked }), fx("f2", "E3", "E4")];
    const grid = buildGrid({ config: cfg, pinned: [locked] });

    const { Z3 } = await loadZ3();
    await withZ3Lock(async () => {
      const solver = new Z3.Solver();
      const model = encodeBuild({
        Z3,
        solver,
        fixtures,
        grid,
        config: { ...cfg, matchMinutes: cfg.matchMinutes, courts: cfg.courts },
      });
      expect(await solver.check()).toBe("sat");
      const picked = model.slotOf(solver.model());
      const board = model.assignmentsFrom(picked);
      expect(board[0]).toMatchObject({ fixtureId: "f1", court: "C2", startAt: locked.startAt });
      // And the board a solved model hands back is one the verifier passes —
      // the round trip Task 4 measures its metrics over.
      expect(validateAssignments(board, { ...cfg }, [])).toEqual([]);
      expect(board).toHaveLength(2);
    });
    await resetZ3();
  }, 120_000);
});

async function assertParity(input: {
  cfg: Cfg;
  verify?: VerifyConfig;
  fixtures: readonly SchedulableFixture[];
  existing?: readonly Assignment[];
  dependencies?: readonly OrderDependency[];
  minChecked?: number;
}): Promise<void> {
  const { cfg, fixtures } = input;
  const existing = input.existing ?? [];
  const dependencies = input.dependencies ?? [];
  const verify: VerifyConfig = input.verify ?? { ...cfg };
  // The envelope this suite can speak for — see the header note. Read through
  // `effectiveHard` so BOTH homes are checked: a rule this suite could not speak
  // for, parked in `constraints.hard`, would otherwise slip past.
  expect(effectiveHard(verify).map((h) => h.type).filter((t) => !ENCODED_RULE_TYPES.has(t))).toEqual([]);

  const grid = buildGrid({ config: cfg, existing });
  expect(grid.overCap).toBe(false);
  expect(grid.slots.length).toBeGreaterThan(fixtures.length);

  const { Z3 } = await loadZ3();
  let checked = 0;
  let sats = 0;
  await withZ3Lock(async () => {
    for (const pick of placements(fixtures.length, grid.slots.length)) {
      const solver = new Z3.Solver();
      const model = encodeBuild({
        Z3,
        solver,
        fixtures,
        grid,
        config: { ...verify, matchMinutes: cfg.matchMinutes, courts: cfg.courts },
        existing,
        dependencies,
      });
      // Force exactly this placement and ask whether the model tolerates it.
      pick.forEach((s, i) => solver.add(model.place[i]![s]!));
      const sat = (await solver.check()) === "sat";
      const assignments = model.assignmentsFrom(pick);
      const clean = validateAssignments(assignments, verify, existing, dependencies).length === 0;
      expect({ pick, sat }).toEqual({ pick, sat: clean });
      checked++;
      if (sat) sats++;
    }
  });
  expect(checked).toBeGreaterThan(input.minChecked ?? 20);
  // Both answers have to be REACHABLE, or a model that refused everything (or
  // accepted everything) would satisfy the assertion above vacuously.
  expect(sats).toBeGreaterThan(0);
  expect(sats).toBeLessThan(checked);
  await resetZ3();
}
