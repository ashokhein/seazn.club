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
});
