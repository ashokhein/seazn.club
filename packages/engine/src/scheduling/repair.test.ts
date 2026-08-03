import { afterAll, describe, expect, it } from "vitest";
import {
  isBlockingConflict,
  validateAssignments,
  type Assignment,
  type OrderDependency,
  type VerifyConfig,
} from "./calendar.ts";
import {
  repairSchedule,
  BLOCKING_FAMILIES,
  REPAIR_FAMILIES,
  type RepairFamily,
  type RepairResult,
} from "./repair.ts";
import { resetZ3, z3LoadCount } from "./z3-load.ts";
import {
  assign,
  at,
  badmintonFeedDeps,
  BASE_CONFIG,
  BADMINTON,
  goldenBadminton,
  SHARED,
  SOLO,
  STEP,
  STEP_RULE_FIXTURES,
} from "./payload-fixtures.ts";

// A leaked z3 instance keeps node's worker threads alive and hangs vitest at
// exit. This file never calls `vi.resetModules()`, so the binding above is the
// only loader instance in play and one teardown is enough.
afterAll(async () => {
  await resetZ3();
});

// z3 boots the WASM cold (~160 ms) and an ascending-k walk is a real solve; the
// 5 s vitest default kills a legitimate search and reads as a failure.
const SOLVE_TIMEOUT = 120_000;

const MIN = 60_000;
const DAY = 86_400_000;
const courts = ["C1", "C2"];
const window = { from: at("2026-08-10T08:00:00Z"), to: at("2026-08-17T08:00:00Z") };
const badmintonConfig: VerifyConfig & { courts: readonly string[] } = {
  ...BASE_CONFIG,
  tz: "UTC",
  window,
  courts,
};

/**
 * The clash is injected on the GRAND FINAL, not on a first-round card.
 *
 * Dropping `wb-r0-i2` onto `wb-r0-i1`'s slot leaves TWO distinct one-move
 * repairs — move either card into the hole the other vacated — so "the twelve
 * anchors keep their golden slot" is true of one of them and false of the
 * other, and the test would pass or fail on the solver's tie-break. `gf`
 * carries two direct feed dependencies on fixtures that sit at the END of the
 * day, and no single move of any OTHER fixture can satisfy both, so the
 * identity of the moved card is forced by the constraints rather than chosen.
 */
function clashedGolden(): Assignment[] {
  const golden = goldenBadminton();
  const first = golden[0]!;
  return golden.map((a) =>
    a.fixtureId === "gf" ? { ...a, court: first.court, startAt: first.startAt, endAt: first.endAt } : a,
  );
}

/** Everything but the wall clock, which is measured and cannot repeat. */
const stable = (r: RepairResult): string => JSON.stringify({ ...r, elapsedMs: 0 });

// #401's Task 4 interface names these on `repair.ts`. They are DEFINED in
// `repair-domain.ts` — the domain builder is what decides which family a bound
// belongs to — so the import above is the contract under test, not decoration.
describe("the family vocabulary", () => {
  it("is reachable from repair.ts, and every blocking family is one of them", () => {
    expect(REPAIR_FAMILIES).toContain("court");
    // Relaxable, because `isBlockingConflict` ignores an indirect feed.
    expect(REPAIR_FAMILIES).toContain("order_soft");
    expect(BLOCKING_FAMILIES).not.toContain("order_soft");
    for (const f of BLOCKING_FAMILIES) {
      expect(REPAIR_FAMILIES as readonly RepairFamily[]).toContain(f);
    }
  });
});

describe("minimal movement", () => {
  it(
    "moves exactly one fixture to clear one injected clash — twelve anchors untouched",
    async () => {
      const golden = goldenBadminton();
      const clashed = clashedGolden();
      const deps = badmintonFeedDeps();
      const before = validateAssignments(clashed, badmintonConfig, [], deps);
      expect(before.filter(isBlockingConflict).length).toBeGreaterThan(0);

      const r = await repairSchedule({
        proposal: clashed,
        config: badmintonConfig,
        dependencies: deps,
        budgetMs: 60_000,
      });
      expect(r.status).toBe("repaired");
      if (r.status !== "repaired") return;
      expect(r.moved).toHaveLength(1); // MINIMAL — not "few", exactly one
      expect(r.moved[0]).toBe("gf");
      expect(r.k).toBe(1);
      expect(r.relaxed).toEqual([]);
      const byId = new Map(r.assignments.map((a) => [a.fixtureId, a]));
      for (const a of golden.filter((g) => g.fixtureId !== r.moved[0])) {
        expect(byId.get(a.fixtureId)).toMatchObject({ startAt: a.startAt, court: a.court });
      }
      expect(validateAssignments(r.assignments, badmintonConfig, [], deps)).toEqual([]);
    },
    SOLVE_TIMEOUT,
  );

  it(
    "repairs the Stepladder epoch draft to verifier-clean, both finals on Friday",
    async () => {
      // The W2 epoch draft: every fixture at the sentinel, i.e. outside the window.
      const draft = assign(STEP, SHARED, [
        ["sl-g1-d1", "1970-01-01T00:00:00Z", "C1"],
        ["sl-g2-d1", "1970-01-01T00:00:00Z", "C1"],
        ["sl-g2-d2", "1970-01-01T00:00:00Z", "C1"],
        ["sl-g3-d2", "1970-01-01T00:00:00Z", "C1"],
      ]);
      const config: VerifyConfig & { courts: readonly string[] } = {
        ...BASE_CONFIG,
        tz: "Europe/London",
        courts,
        perEntrantMinRest: 45,
        window: { from: at("2026-08-10T08:00:00+01:00"), to: at("2026-08-15T08:00:00+01:00") },
        ruleFixtures: STEP_RULE_FIXTURES.map((f) => ({ ...f })),
        hard: [
          {
            type: "fixture_on_weekday",
            weekday: "FRI",
            selector: { kind: "terminal" },
            scope: { kind: "competition" },
          },
        ],
      };
      const deps: OrderDependency[] = [
        { fixtureId: "sl-g2-d1", dependsOn: "sl-g1-d1", direct: true },
        { fixtureId: "sl-g3-d2", dependsOn: "sl-g2-d2", direct: true },
      ];
      // Pinned at the MEASURED count. The plan called this "the 13-violation
      // draft" from an earlier config; with `perEntrantMinRest: 45` every one
      // of the six pairs is also a rest breach in both directions, so the real
      // number under the config this test asserts against is 36.
      const drafted = validateAssignments(draft, config, [], deps);
      expect(drafted).toHaveLength(36);
      expect(drafted.filter(isBlockingConflict).length).toBeGreaterThan(0);

      const r = await repairSchedule({ proposal: draft, config, dependencies: deps, budgetMs: 60_000 });
      expect(r.status).toBe("repaired");
      if (r.status !== "repaired") return;
      expect(validateAssignments(r.assignments, config, [], deps)).toEqual([]);
      // Both terminals on Friday, and Fischer — who plays in BOTH divisions — is
      // rested between them rather than double-booked.
      const finals = r.assignments.filter((a) => ["sl-g2-d1", "sl-g3-d2"].includes(a.fixtureId));
      expect(finals).toHaveLength(2);
      for (const f of finals) {
        expect(
          new Date(f.startAt).toLocaleDateString("en-GB", {
            weekday: "short",
            timeZone: "Europe/London",
          }),
        ).toBe("Fri");
      }
      const [a, b] = finals;
      expect(a!.people).toContain("p-fischer");
      expect(b!.people).toContain("p-fischer");
      expect(a!.startAt - b!.endAt >= 45 * MIN || b!.startAt - a!.endAt >= 45 * MIN).toBe(true);
    },
    SOLVE_TIMEOUT,
  );

  it(
    "is deterministic: same input, same output, twice",
    async () => {
      const clashed = clashedGolden();
      const deps = badmintonFeedDeps();
      const a = await repairSchedule({
        proposal: clashed,
        config: badmintonConfig,
        dependencies: deps,
        budgetMs: 60_000,
      });
      const b = await repairSchedule({
        proposal: clashed,
        config: badmintonConfig,
        dependencies: deps,
        budgetMs: 60_000,
      });
      expect(a.status).toBe("repaired");
      expect(stable(a)).toBe(stable(b));
    },
    SOLVE_TIMEOUT,
  );
});

/**
 * `validateAssignments` loops `for (const a of assignments)` against
 * `board = [...existing, ...assignments]`, so an immovable is NEVER the outer
 * `a` and its direction of the rest rule is never evaluated. Both cases are
 * pinned here because getting either one wrong fails silently in opposite
 * directions: the max against an immovable reports a spurious `infeasible` on
 * a board the verifier passes, and a single direction between two movables
 * returns a "repaired" board the verifier rejects.
 *
 * The asymmetry is manufactured with `restByGroup`, which `effectiveRestMinutes`
 * reads off the FIRST argument: pool-a owes 30, division d2 owes 90.
 */
describe("the pair-rest contract is asymmetric", () => {
  const t = (iso: string): number => at(iso);
  const card = (
    fixtureId: string,
    startIso: string,
    entrant: string,
    poolId: string,
    divisionId: string,
  ): Assignment => ({
    fixtureId,
    court: "C1",
    startAt: t(startIso),
    endAt: t(startIso) + 40 * MIN,
    entrants: [entrant],
    people: ["p-shared"],
    poolId,
    divisionId,
  });

  const asymmetric: VerifyConfig = {
    ...BASE_CONFIG,
    tz: "UTC",
    constraints: {
      restByGroup: { "pool-a": 30, d2: 90 },
      noBackToBack: false,
      startWindows: [],
      fieldFairness: "off",
      parallelism: "mixed",
      crossPersonClash: "warn",
    },
  };

  it(
    "owes an immovable exactly ONE direction — the max would refuse a legal board",
    async () => {
      const immovable = card("fixed", "2026-08-10T09:00:00Z", "e-fixed", "pool-b", "d2");
      const movable = card("m1", "2026-08-10T09:20:00Z", "e-move", "pool-a", "d1");
      // The window admits exactly one legal start: 09:40 + 30 minutes. The
      // one-directional bound is 30 (pool-a); the max would be 90 (d2) and
      // would put every legal start outside the window.
      const config: VerifyConfig & { courts: readonly string[] } = {
        ...asymmetric,
        courts: ["C1"],
        window: { from: t("2026-08-10T09:00:00Z"), to: t("2026-08-10T10:50:00Z") },
      };
      expect(validateAssignments([movable], config, [immovable])).not.toEqual([]);

      const r = await repairSchedule({
        proposal: [movable],
        existing: [immovable],
        config,
        budgetMs: 60_000,
      });
      expect(r.status).toBe("repaired");
      if (r.status !== "repaired") return;
      expect(r.assignments[0]!.startAt).toBe(t("2026-08-10T10:10:00Z"));
      expect(validateAssignments(r.assignments, config, [immovable])).toEqual([]);
    },
    SOLVE_TIMEOUT,
  );

  it(
    "owes two movables the MAX of both directions — the verifier judges both",
    async () => {
      const a = card("m1", "2026-08-10T09:00:00Z", "e-a", "pool-a", "d1");
      const b = card("m2", "2026-08-10T09:00:00Z", "e-b", "pool-b", "d2");
      const config: VerifyConfig & { courts: readonly string[] } = {
        ...asymmetric,
        courts: ["C1"],
        window: { from: t("2026-08-10T09:00:00Z"), to: t("2026-08-10T12:00:00Z") },
      };
      const r = await repairSchedule({ proposal: [a, b], config, budgetMs: 60_000 });
      expect(r.status).toBe("repaired");
      if (r.status !== "repaired") return;
      expect(r.moved).toHaveLength(1);
      expect(validateAssignments(r.assignments, config)).toEqual([]);
      const [x, y] = r.assignments;
      const gap = Math.max(x!.startAt - y!.endAt, y!.startAt - x!.endAt);
      expect(gap).toBeGreaterThanOrEqual(90 * MIN); // not 30 — the other direction binds
    },
    SOLVE_TIMEOUT,
  );
});

describe("when no schedule exists", () => {
  it(
    "names the constraint families rather than failing bare",
    async () => {
      // One court, a one-hour window, two 40-minute fixtures that cannot both fit.
      const tiny = { from: at("2026-08-10T09:00:00Z"), to: at("2026-08-10T10:00:00Z") };
      const proposal = assign(BADMINTON, SOLO, [
        ["wb-r0-i1", "2026-08-10T09:00:00Z", "C1"],
        ["wb-r0-i2", "2026-08-10T09:00:00Z", "C1"],
      ]);
      const r = await repairSchedule({
        proposal,
        budgetMs: 60_000,
        config: { ...BASE_CONFIG, tz: "UTC", window: tiny, courts: ["C1"] },
      });
      expect(r.status).toBe("infeasible");
      if (r.status !== "infeasible") return;
      expect(r.families).toContain("court");
      expect(r.families).toContain("window");
    },
    SOLVE_TIMEOUT,
  );
});

/**
 * The relaxation path, which had no test teeth at all before this block.
 *
 * `instruction`, `blackout`, `start_window` and `rest` are DROPPED when the full
 * rule set has no solution, so a domain narrowed — or emptied — by one of them
 * says nothing about where the fixture may end up. Pruning on one is therefore
 * unsound, and the review reproduced exactly what that costs: a fixture whose
 * instruction cannot be satisfied got `span: null`, was skipped by both the
 * movable×movable pruner and the movable×immovable loop, and reached z3 carrying
 * no court, person or rest constraint whatsoever. The solver answered `sat` at
 * k=0 and `repairSchedule` reported `clean` on a board the verifier scores as
 * two blocking court clashes.
 */
describe("a relaxable family that empties a domain", () => {
  const relaxWindow = { from: at("2026-08-10T08:00:00Z"), to: at("2026-08-11T08:00:00Z") };
  const impossibleInstruction: VerifyConfig & { courts: readonly string[] } = {
    ...BASE_CONFIG,
    tz: "UTC",
    window: relaxWindow,
    courts,
    ruleFixtures: [
      { id: "wb-r0-i1", extKey: "wb-r0-i1", winnerTo: "wb-r1-i0" },
      { id: "wb-r0-i2", extKey: "wb-r0-i2", winnerTo: "wb-r1-i1" },
      { id: "wb-r0-i3", extKey: "wb-r0-i3", winnerTo: "wb-r1-i1" },
    ],
    hard: [
      {
        // No bucket carries this date — the window is a single day in August —
        // so `byFamily.instruction` comes back empty for `wb-r0-i1`.
        type: "fixture_on_date",
        date: "2026-09-01",
        selector: { kind: "id", fixtureId: "wb-r0-i1" },
        scope: { kind: "competition" },
      },
    ],
  };
  // i1 and i2 are double-booked on C1; i3 sits clear. The clash is deliberately
  // on the fixture the instruction empties, because that is the pair the old
  // pruner dropped.
  const clashOnTheEmptiedFixture = (): Assignment[] =>
    assign(BADMINTON, SOLO, [
      ["wb-r0-i1", "2026-08-10T09:00:00Z", "C1"],
      ["wb-r0-i2", "2026-08-10T09:00:00Z", "C1"],
      ["wb-r0-i3", "2026-08-10T11:00:00Z", "C1"],
    ]);

  it(
    "still encodes the court constraint the emptied fixture is party to",
    async () => {
      const proposal = clashOnTheEmptiedFixture();
      const before = validateAssignments(proposal, impossibleInstruction);
      expect(before.filter(isBlockingConflict)).toHaveLength(2);

      const r = await repairSchedule({
        proposal,
        config: impossibleInstruction,
        budgetMs: 60_000,
      });
      expect(r.status).toBe("repaired");
      if (r.status !== "repaired") return;
      // The instruction is what could not hold, and the caller is told so.
      expect(r.relaxed).toContain("instruction");
      expect(r.moved.length).toBeGreaterThan(0);
      // The relaxed families are gone; the BLOCKING ones are not negotiable.
      expect(
        validateAssignments(r.assignments, impossibleInstruction).filter(isBlockingConflict),
      ).toEqual([]);
    },
    SOLVE_TIMEOUT,
  );

  it(
    "never reports a board the verifier rejects as clean",
    async () => {
      const r = await repairSchedule({
        proposal: clashOnTheEmptiedFixture(),
        config: impossibleInstruction,
        budgetMs: 60_000,
      });
      expect(r.status).not.toBe("clean");
    },
    SOLVE_TIMEOUT,
  );
});

/**
 * The rule families that had no end-to-end test at all: session windows, court
 * blackouts, a per-day cap and a feeder→dependent rest instruction. Each is
 * encoded by a branch of `repair.ts` nothing exercised, so each could have been
 * asserting the wrong thing — or nothing — without a failing test anywhere.
 */
describe("the rule families, end to end", () => {
  const dayKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

  it(
    "keeps BOTH the pack window and the session windows",
    async () => {
      // The session runs two hours past the pack window's close. The verifier
      // enforces the pack window as a BLOCKING `window` conflict whether or not
      // sessions exist, so a solver that let the session replace it hands back a
      // start the verifier rejects — which is what it used to do.
      const config: VerifyConfig & { courts: readonly string[] } = {
        ...BASE_CONFIG,
        tz: "UTC",
        courts: ["C1"],
        window: { from: at("2026-08-10T08:00:00Z"), to: at("2026-08-10T12:00:00Z") },
        sessionWindows: [{ from: at("2026-08-10T09:00:00Z"), to: at("2026-08-10T14:00:00Z") }],
      };
      const proposal = assign(BADMINTON, SOLO, [["wb-r0-i1", "2026-08-10T12:00:00Z", "C1"]]);
      expect(validateAssignments(proposal, config).filter(isBlockingConflict)).toHaveLength(1);

      const r = await repairSchedule({ proposal, config, budgetMs: 60_000 });
      expect(r.status).toBe("repaired");
      if (r.status !== "repaired") return;
      expect(r.relaxed).toEqual([]);
      expect(r.moved).toEqual(["wb-r0-i1"]);
      // Inside the session AND inside the pack window — the intersection, not
      // whichever of the two the encoder happened to keep.
      const start = r.assignments[0]!.startAt;
      expect(start).toBeGreaterThanOrEqual(at("2026-08-10T09:00:00Z"));
      expect(start).toBeLessThanOrEqual(at("2026-08-10T11:20:00Z"));
      expect(validateAssignments(r.assignments, config)).toEqual([]);
    },
    SOLVE_TIMEOUT,
  );

  it(
    "treats a court blackout as court-scoped, not board-wide",
    async () => {
      // C1 is closed for the whole window; C2 is free. A blackout read as
      // board-wide leaves nowhere to go and reports infeasible.
      const window = { from: at("2026-08-10T08:00:00Z"), to: at("2026-08-10T18:00:00Z") };
      const config: VerifyConfig & { courts: readonly string[] } = {
        ...BASE_CONFIG,
        tz: "UTC",
        window,
        courts,
        blackouts: [{ court: "C1", from: window.from, to: window.to }],
      };
      const proposal = assign(BADMINTON, SOLO, [["wb-r0-i1", "2026-08-10T09:00:00Z", "C1"]]);
      expect(validateAssignments(proposal, config)).not.toEqual([]);

      const r = await repairSchedule({ proposal, config, budgetMs: 60_000 });
      expect(r.status).toBe("repaired");
      if (r.status !== "repaired") return;
      // C2 is the only usable court, and reaching it is one move. The START is
      // deliberately NOT pinned: moving the court and moving the hour are both
      // one move, so which the solver picks is a tie-break, not a rule.
      expect(r.moved).toEqual(["wb-r0-i1"]);
      expect(r.assignments[0]!.court).toBe("C2");
      expect(validateAssignments(r.assignments, config)).toEqual([]);
    },
    SOLVE_TIMEOUT,
  );

  it(
    "spreads a day that breaks max_fixtures_per_day",
    async () => {
      const config: VerifyConfig & { courts: readonly string[] } = {
        ...BASE_CONFIG,
        tz: "UTC",
        courts,
        window: { from: at("2026-08-10T00:00:00Z"), to: at("2026-08-13T00:00:00Z") },
        ruleFixtures: [
          { id: "wb-r0-i1", extKey: "wb-r0-i1", winnerTo: "wb-r1-i0" },
          { id: "wb-r0-i2", extKey: "wb-r0-i2", winnerTo: "wb-r1-i1" },
          { id: "wb-r0-i3", extKey: "wb-r0-i3", winnerTo: "wb-r1-i1" },
        ],
        hard: [{ type: "max_fixtures_per_day", count: 1, scope: { kind: "competition" } }],
      };
      // Three fixtures, three days, a 1/day cap: two of the three must move.
      const proposal = assign(BADMINTON, SOLO, [
        ["wb-r0-i1", "2026-08-10T09:00:00Z", "C1"],
        ["wb-r0-i2", "2026-08-10T11:00:00Z", "C1"],
        ["wb-r0-i3", "2026-08-10T13:00:00Z", "C1"],
      ]);
      expect(validateAssignments(proposal, config)).toHaveLength(3);

      const r = await repairSchedule({ proposal, config, budgetMs: 60_000 });
      expect(r.status).toBe("repaired");
      if (r.status !== "repaired") return;
      expect(r.relaxed).toEqual([]);
      expect(r.moved).toHaveLength(2);
      expect(new Set(r.assignments.map((a) => dayKey(a.startAt))).size).toBe(3);
      expect(validateAssignments(r.assignments, config)).toEqual([]);
    },
    SOLVE_TIMEOUT,
  );

  it(
    "honours a feeder→dependent min_rest_minutes instruction",
    async () => {
      const config: VerifyConfig & { courts: readonly string[] } = {
        ...BASE_CONFIG,
        tz: "UTC",
        courts,
        window: { from: at("2026-08-10T08:00:00Z"), to: at("2026-08-10T20:00:00Z") },
        ruleFixtures: STEP_RULE_FIXTURES.map((f) => ({ ...f })),
        hard: [
          {
            type: "min_rest_minutes",
            minutes: 90,
            rest_scope: "feeder_to_dependent",
            scope: { kind: "competition" },
          },
        ],
      };
      // The dependent starts 20 minutes after its feeder ends; the instruction
      // asks for 90. `gapMinutes` and the `order` check are both satisfied, so
      // this rule is the only thing that binds.
      const proposal = assign(STEP, SHARED, [
        ["sl-g1-d1", "2026-08-10T09:00:00Z", "C1"],
        ["sl-g2-d1", "2026-08-10T10:00:00Z", "C2"],
      ]);
      const deps: OrderDependency[] = [
        { fixtureId: "sl-g2-d1", dependsOn: "sl-g1-d1", direct: true },
      ];
      expect(validateAssignments(proposal, config, [], deps)).toHaveLength(1);

      const r = await repairSchedule({ proposal, config, dependencies: deps, budgetMs: 60_000 });
      expect(r.status).toBe("repaired");
      if (r.status !== "repaired") return;
      expect(r.relaxed).toEqual([]);
      const byId = new Map(r.assignments.map((a) => [a.fixtureId, a]));
      const feeder = byId.get("sl-g1-d1")!;
      const dependent = byId.get("sl-g2-d1")!;
      expect(dependent.startAt - feeder.endAt).toBeGreaterThanOrEqual(90 * MIN);
      expect(validateAssignments(r.assignments, config, [], deps)).toEqual([]);
    },
    SOLVE_TIMEOUT,
  );

  it(
    "stays finite with no pack window and no session windows",
    async () => {
      // The ONLY configuration in which the unconditional ±30-day bound on every
      // start is load-bearing: with neither window family present `repairUniverse`
      // falls back to the board's own extent and nothing else bounds the integer.
      const config: VerifyConfig & { courts: readonly string[] } = {
        ...BASE_CONFIG,
        tz: "UTC",
        courts: ["C1"],
      };
      const proposal = assign(BADMINTON, SOLO, [
        ["wb-r0-i1", "2026-08-10T09:00:00Z", "C1"],
        ["wb-r0-i2", "2026-08-10T09:00:00Z", "C1"],
      ]);
      expect(validateAssignments(proposal, config).filter(isBlockingConflict)).toHaveLength(2);

      const r = await repairSchedule({ proposal, config, budgetMs: 60_000 });
      expect(r.status).toBe("repaired");
      if (r.status !== "repaired") return;
      expect(r.moved).toHaveLength(1);
      expect(validateAssignments(r.assignments, config)).toEqual([]);
      // Not the year 90210: the board's extent widened by a week, then by the
      // guard's thirty days.
      const lo = at("2026-08-10T09:00:00Z") - 37 * DAY;
      const hi = at("2026-08-10T09:40:00Z") + 37 * DAY;
      for (const a of r.assignments) {
        expect(a.startAt).toBeGreaterThanOrEqual(lo);
        expect(a.startAt).toBeLessThanOrEqual(hi);
      }
    },
    SOLVE_TIMEOUT,
  );
});

/**
 * A dependency with BOTH ends immovable used to be skipped by the encoder while
 * `validateAssignments` went on reporting it — its `byId` covers `existing` too
 * — so the solver handed back a board carrying an order conflict it had never
 * seen. Encoded now: both sides are constants and the assertion collapses to
 * true or false.
 *
 * Which literal it collapses under is the other half. `isBlockingConflict`
 * covers `order` only when `direct === true`, so an INDIRECT dependency asserted
 * under the never-relaxed `order` family reported the whole board `infeasible`
 * over something the verifier merely warns about.
 */
describe("an order dependency the solver cannot move", () => {
  const config: VerifyConfig & { courts: readonly string[] } = {
    ...BASE_CONFIG,
    tz: "UTC",
    courts,
    window: { from: at("2026-08-10T08:00:00Z"), to: at("2026-08-10T20:00:00Z") },
  };
  // Two immovables on C2 whose feed order is already violated — the dependent
  // starts inside its source. Neither is in `proposal`, so no move can fix it.
  const obstacle = (fixtureId: string, iso: string): Assignment => ({
    fixtureId,
    court: "C2",
    startAt: at(iso),
    endAt: at(iso) + 40 * MIN,
    entrants: [`e-${fixtureId}`],
    people: [`p-${fixtureId}`],
  });
  const existing = [obstacle("ob-a", "2026-08-10T09:00:00Z"), obstacle("ob-b", "2026-08-10T09:20:00Z")];
  const clashing = (): Assignment[] =>
    assign(BADMINTON, SOLO, [
      ["wb-r0-i1", "2026-08-10T15:00:00Z", "C1"],
      ["wb-r0-i2", "2026-08-10T15:00:00Z", "C1"],
    ]);

  it(
    "relaxes an INDIRECT one and repairs the rest of the board",
    async () => {
      const deps: OrderDependency[] = [{ fixtureId: "ob-b", dependsOn: "ob-a", direct: false }];
      const proposal = clashing();
      const before = validateAssignments(proposal, config, existing, deps);
      expect(before.some((c) => c.reason === "order")).toBe(true);
      expect(before.filter(isBlockingConflict)).toHaveLength(2); // the court clash only

      const r = await repairSchedule({ proposal, config, existing, dependencies: deps, budgetMs: 60_000 });
      expect(r.status).toBe("repaired");
      if (r.status !== "repaired") return;
      expect(r.relaxed).toContain("order_soft");
      expect(r.moved).toHaveLength(1);
      expect(
        validateAssignments(r.assignments, config, existing, deps).filter(isBlockingConflict),
      ).toEqual([]);
    },
    SOLVE_TIMEOUT,
  );

  it(
    "reports a DIRECT one as infeasible rather than handing back a board it broke",
    async () => {
      const deps: OrderDependency[] = [{ fixtureId: "ob-b", dependsOn: "ob-a", direct: true }];
      const r = await repairSchedule({
        proposal: clashing(),
        config,
        existing,
        dependencies: deps,
        budgetMs: 60_000,
      });
      expect(r.status).toBe("infeasible");
      if (r.status !== "infeasible") return;
      expect(r.families).toContain("order");
    },
    SOLVE_TIMEOUT,
  );
});

describe("the budget", () => {
  it(
    "returns timeout rather than running forever",
    async () => {
      const r = await repairSchedule({
        proposal: clashedGolden(),
        dependencies: badmintonFeedDeps(),
        budgetMs: 1, // one millisecond: nothing can finish
        config: badmintonConfig,
      });
      expect(r.status).toBe("timeout");
    },
    SOLVE_TIMEOUT,
  );

  it(
    "never loads the WASM for a proposal that is already clean",
    async () => {
      await resetZ3();
      expect(z3LoadCount()).toBe(0);
      const r = await repairSchedule({
        proposal: goldenBadminton(),
        dependencies: badmintonFeedDeps(),
        config: badmintonConfig,
      });
      expect(r.status).toBe("clean");
      expect(z3LoadCount()).toBe(0);
    },
    SOLVE_TIMEOUT,
  );

  it(
    "covers the WASM boot and the encode, not just check()",
    async () => {
      // The budget used to be tested only inside `check()`, so `loadZ3` and the
      // whole O(n²) encode ran outside it: at 500 movable the first test happened
      // after every constraint had been built, and a 15 s call could burn far
      // more before reporting `timeout`.
      await resetZ3();
      expect(z3LoadCount()).toBe(0);
      const r = await repairSchedule({
        proposal: clashedGolden(), // DIRTY — step 1 does not answer this one
        dependencies: badmintonFeedDeps(),
        budgetMs: 0,
        config: badmintonConfig,
      });
      expect(r.status).toBe("timeout");
      if (r.status !== "timeout") return;
      expect(r.checks).toBe(0);
      expect(z3LoadCount()).toBe(0);
    },
    SOLVE_TIMEOUT,
  );
});
