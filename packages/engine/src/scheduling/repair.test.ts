import { afterAll, describe, expect, it } from "vitest";
import {
  isBlockingConflict,
  validateAssignments,
  type Assignment,
  type OrderDependency,
  type VerifyConfig,
} from "./calendar.ts";
import { repairSchedule, type RepairResult } from "./repair.ts";
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
});
