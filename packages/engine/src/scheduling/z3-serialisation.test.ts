// ONE lock in front of the WASM (#401 review finding).
//
// `resetZ3()` is PROCESS-WIDE: it terminates the pthreads the whole process
// shares. Running it while any solve is inside `check()` is the
// `RuntimeError: memory access out of bounds` that reset exists to prevent,
// arriving by a different road (3 of 3 runs died without a reset between
// component solves; the mirror hazard is a reset arriving DURING one).
//
// The queue used to sit on `repairDecomposed` and therefore serialised that
// function against itself and nothing else, while `repairSchedule`,
// `repairAndVerify` and `resetZ3` are all exported from the scheduling barrel
// and took no part in it — and `repairDecomposed` calls `resetZ3()` between
// every component. Two web runners each own a repair loop and a joint run can
// have both in flight, so "a repair for one division tears the context out from
// under another division's live `check()`" was reachable.
//
// These tests assert the SERIALISATION PROPERTY directly rather than trying to
// provoke the abort. A test that needs an out-of-bounds to fire is flaky by
// construction: the abort is non-deterministic, and when it does fire it kills
// the process rather than failing an assertion.
import { afterAll, describe, expect, it } from "vitest";
import type { Assignment, VerifyConfig } from "./calendar.ts";
import { validateAssignments } from "./calendar.ts";
import { repairDecomposed } from "./repair-decompose.ts";
import { repairAndVerify, repairSchedule } from "./repair.ts";
import { resetZ3, withZ3Lock } from "./z3-load.ts";

const SOLVE_TIMEOUT = 120_000;

afterAll(async () => {
  await resetZ3();
});

const MIN = 60_000;
const T0 = Date.parse("2026-09-07T09:00:00Z");

const at = (id: string, court: string, offsetMin: number, entrants: string[]): Assignment => ({
  fixtureId: id,
  court,
  startAt: T0 + offsetMin * MIN,
  endAt: T0 + (offsetMin + 40) * MIN,
  entrants,
  people: entrants.map((e) => `p-${e}`),
});

const config: VerifyConfig & { courts: readonly string[] } = {
  matchMinutes: 40,
  gapMinutes: 5,
  perEntrantMinRest: 45,
  blackouts: [],
  sessionWindows: [],
  tz: "UTC",
  courts: ["C1", "C2"],
};

/** One court clash: two cards on C1 at the same minute, C2 free. One move. */
const clash = (suffix: string): Assignment[] => [
  at(`${suffix}1`, "C1", 0, [`${suffix}e1`, `${suffix}e2`]),
  at(`${suffix}2`, "C1", 0, [`${suffix}e3`, `${suffix}e4`]),
];

describe("withZ3Lock", () => {
  it("does not start a second entrant until the first has settled", async () => {
    const log: string[] = [];
    let signalStarted: () => void = () => {};
    let release: () => void = () => {};
    const started = new Promise<void>((res) => {
      signalStarted = res;
    });

    const first = withZ3Lock(async () => {
      log.push("first:start");
      signalStarted();
      await new Promise<void>((res) => {
        release = res;
      });
      log.push("first:end");
    });
    const second = withZ3Lock(async () => {
      log.push("second:start");
    });

    await started;
    // The whole property: `second`'s work has NOT run, even though its call was
    // made while `first` was still in flight.
    expect(log).toEqual(["first:start"]);
    release();
    await Promise.all([first, second]);
    expect(log).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("releases the lock when an entrant rejects", async () => {
    // A thrown RepairVerificationError must not wedge every later call behind
    // it — the tail is reset through both arms for exactly this.
    await expect(
      withZ3Lock(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(withZ3Lock(async () => "after")).resolves.toBe("after");
  });
});

describe("solver entry points serialise against one another", () => {
  it(
    "runs repairSchedule, resetZ3 and repairAndVerify one at a time, in call order",
    async () => {
      await resetZ3();
      const log: string[] = [];

      // All three launched WITHOUT awaiting, which is what a joint run does:
      // one division's runner is inside a solve while another's starts.
      const a = repairSchedule({
        proposal: clash("a"),
        config,
        budgetMs: 60_000,
        onPhase: (p) => log.push(`a:${p.phase}`),
      }).then((r) => {
        log.push("a:done");
        return r;
      });
      const reset = resetZ3().then(() => {
        log.push("reset:done");
      });
      const b = repairAndVerify({
        proposal: clash("b"),
        config,
        budgetMs: 60_000,
        onPhase: (p) => log.push(`b:${p.phase}`),
      }).then((r) => {
        log.push("b:done");
        return r;
      });

      const [ra, , rb] = await Promise.all([a, reset, b]);
      expect(ra.status).toBe("repaired");
      expect(rb.status).toBe("repaired");
      // Not merely "no interleaving" — the exact order of the three calls. A
      // teardown between `b:precheck` and `b:encoded` is the production hazard,
      // and this pins that it cannot land there.
      expect(log).toEqual([
        "a:precheck",
        "a:z3_ready",
        "a:domains",
        "a:encoded",
        "a:done",
        "reset:done",
        "b:precheck",
        "b:z3_ready",
        "b:domains",
        "b:encoded",
        "b:done",
      ]);
    },
    SOLVE_TIMEOUT,
  );

  it(
    "keeps a concurrent repairAndVerify whole while a decomposed repair resets between components",
    async () => {
      await resetZ3();
      const log: string[] = [];
      // Two components, both dirty: the decomposed call therefore solves twice
      // and calls the process-wide `resetZ3()` after each.
      const decomposedBoard = [
        ...clash("d"),
        at("z1", "C1", 300, ["ze1", "ze2"]),
        at("z2", "C1", 300, ["ze3", "ze4"]),
      ];

      const a = repairDecomposed({
        proposal: decomposedBoard,
        config,
        budgetMs: 90_000,
        onPhase: (p) => log.push(`a:${p.phase}`),
        onComponent: (c) => log.push(`a:component:${c.index}`),
      });
      const b = repairAndVerify({
        proposal: clash("b"),
        config,
        budgetMs: 60_000,
        onPhase: (p) => log.push(`b:${p.phase}`),
      });

      const [ra, rb] = await Promise.all([a, b]);
      expect(ra.status).toBe("repaired");
      expect(rb.status).toBe("repaired");
      expect(validateAssignments(ra.assignments, config)).toEqual([]);

      // `b` is allowed to run between two of `a`'s components — each component
      // takes the lock on its own, and a lock held across a whole decomposed
      // call would stall an HTTP path for the full 240 s budget. What it may
      // NOT do is straddle one: `b`'s four phases must be contiguous, so
      // neither a component's solve nor the `resetZ3()` that follows it can
      // land inside `b`'s.
      //
      // The four phases are all emitted INSIDE the lock, so this ordering is
      // structural rather than a microtask race: a marker pushed from a `.then`
      // on the returned promise would be one hop late and could legitimately
      // follow the next entrant's first phase.
      const bIndexes = log.flatMap((e, i) => (e.startsWith("b:") ? [i] : []));
      expect(bIndexes.length).toBe(4);
      expect(bIndexes[bIndexes.length - 1]! - bIndexes[0]!).toBe(bIndexes.length - 1);
      // …and `a` really did emit phases around it, or the contiguity above is
      // satisfied by an empty field.
      // Two dirty components: four phases and one component report each.
      expect(log.filter((e) => e.startsWith("a:")).length).toBe(10);
    },
    SOLVE_TIMEOUT,
  );
});
