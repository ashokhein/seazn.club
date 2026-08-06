// The stopping rule is a property of the SEARCH, not of the machine.
//
// `calendar.test.ts` asserts the greedy placer is deterministic, and an anytime
// solver budgeted on the wall clock would break that invariant the moment CI ran
// on a faster box: same competition, same settings, a different board, and no
// way for an organiser to tell why. So the budget is z3's `rlimit` — a
// deterministic resource counter — and every tier walk terminates on a VERDICT
// (unsat, or the metric's own floor) rather than on elapsed time. The wall clock
// survives only as an outer cap that should never fire.
//
// The second test is the one that would actually catch a regression: two runs
// under wall caps four times apart. Under a wall-clock stopping rule they would
// end at different bounds and hand back different boards; here they must be
// byte-identical, and `budgetExpired: false` on both is what proves the cap
// never fired and the comparison is not two truncated runs agreeing by luck.
import { describe, expect, it } from "vitest";
import { buildSchedule } from "./build.ts";
import { resetZ3 } from "./z3-load.ts";
import type { SchedulableFixture, SlotConfig } from "./calendar.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 7, 8, 9, 0);

/** Two courts, a real rest rule and a round-robin's worth of shared entrants,
 *  so all four tiers have something to chew on rather than hitting their floor
 *  on the first look. */
const config: SlotConfig & { courts: string[] } = {
  startAt: T0,
  matchMinutes: 30,
  gapMinutes: 10,
  courts: ["C1", "C2"],
  perEntrantMinRest: 30,
  window: { from: T0, to: T0 + 240 * MIN },
  tz: "Europe/London",
};

/** Small enough that the tiers fall short, large enough that the fallback's
 *  reserve survives the main phase — the measured band. */
const LNS_LEVER_RLIMIT = 400;

const fixtures: SchedulableFixture[] = [
  { id: "a", home: "E1", away: "E2", roundNo: 1 },
  { id: "b", home: "E3", away: "E4", roundNo: 1 },
  { id: "c", home: "E1", away: "E3", roundNo: 2 },
  { id: "d", home: "E2", away: "E4", roundNo: 2 },
];

describe("buildSchedule determinism", () => {
  it("returns the same board twice", async () => {
    const a = await buildSchedule({ fixtures, config });
    const b = await buildSchedule({ fixtures, config });
    expect(a.assignments).toEqual(b.assignments);
    expect(a.metrics).toEqual(b.metrics);
    // Not vacuous: a run that stopped before T0 would also match itself.
    expect(a.tiersCompleted).toBe(4);
    expect(a.budgetExpired).toBe(false);
    await resetZ3();
  }, 180_000);

  it("returns the same board under two different wall-clock caps", async () => {
    const a = await buildSchedule({ fixtures, config, wallMs: 30_000 });
    const b = await buildSchedule({ fixtures, config, wallMs: 120_000 });
    expect(a.assignments).toEqual(b.assignments);
    expect(a.metrics).toEqual(b.metrics);
    expect(a.tiersCompleted).toBe(b.tiersCompleted);
    expect(a.tiersCompleted).toBe(4);
    expect(a.budgetExpired).toBe(false);
    expect(b.budgetExpired).toBe(false);
    await resetZ3();
  }, 240_000);

  // --- the window fallback ---------------------------------------------------
  //
  // LNS is the one part of this solver that reads the wall clock at all: it
  // stops opening windows when the caller's outer backstop has fired. That is
  // the same cap the tier loop already honours, but it decides something the
  // tier loop's does not — WHICH windows ran — so it gets its own pair of runs
  // under caps four times apart. The budget below is what puts the run on that
  // path: the tiers fall short of a verdict while the fallback's reserve is
  // still intact (see `build-lns-wiring.test.ts` for the measured band).
  it("returns the same board under two wall caps on the window path", async () => {
    const a = await buildSchedule({ fixtures, config, rlimit: LNS_LEVER_RLIMIT, wallMs: 30_000 });
    const b = await buildSchedule({ fixtures, config, rlimit: LNS_LEVER_RLIMIT, wallMs: 120_000 });
    expect(a.assignments).toEqual(b.assignments);
    expect(a.metrics).toEqual(b.metrics);
    expect(a.engine).toBe(b.engine);
    // THE ASSERTION THAT MAKES THIS A WINDOW TEST AT ALL.
    //
    // `tiersCompleted < 4` and `budgetExpired === true` are both produced by the
    // TIER phase on its own, so the two below witness nothing about the
    // fallback: at `rlimit: 400` the run ends in milliseconds and the 30 s and
    // 120 s arms open an identical plan whether or not any window exists.
    // MEASURED: deleting the whole LNS block from `build.ts` left this case
    // green.
    //
    // `lnsWindowRlimits` is the pass's own record — one entry per window, in the
    // order they were opened, carrying the share each was allotted. Non-empty
    // says a window ACTUALLY RAN; equal across two caps four times apart says
    // the plan and its budget split are derived from the run budget rather than
    // from elapsed time, which is the property this file exists to hold.
    expect(a.lnsWindowRlimits.length).toBeGreaterThan(0);
    expect(a.lnsWindowRlimits).toEqual(b.lnsWindowRlimits);
    // Not vacuous: this has to be the fallback path, not a run that proved its
    // tiers and never opened a window at all.
    expect(a.tiersCompleted).toBeLessThan(4);
    expect(a.budgetExpired).toBe(true);
    await resetZ3();
  }, 240_000);
});
