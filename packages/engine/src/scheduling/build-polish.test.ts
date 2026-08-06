// POLISH, and what `already_optimal` is actually a claim about.
//
// THE BRIEF FOR THIS FILE HAD A FALSE PREMISE, and it is recorded here because
// the correction is the whole content of the file. Task 7 was written as "add
// the `already_optimal` status to `build.ts`", with the two acceptance cases
// below as its failing step. They were run FIRST, against an untouched
// `build.ts`, and both passed: the status shipped with Task 5. Nothing was added
// to `build.ts` for this file.
//
// What the brief would have CHANGED is the predicate, and that is the part worth
// guarding. It proposed:
//
//     input.mode === "polish" && moved === 0  ->  "already_optimal"
//
// and `build.ts` instead keys on `tiersCompleted === TIER_COUNT && !improved`.
// Those are not two spellings of one rule. `already_optimal` is a PROOF — every
// tier ran to a verdict and none could better the board — and the proposed
// predicate proves nothing on either side:
//
//   * it FIRES on a run that never got a verdict. A POLISH run whose budget
//     died before the first check also moved nothing, so it would be reported
//     as optimal on the strength of having done no work at all. Measured
//     below: `rlimit: 1` gives `tiersCompleted: 0`, `budgetExpired: true`.
//   * it goes SILENT for BUILD. A proven-optimal board with no `mode` would
//     drop back to `ok`, which is the existing behaviour it would regress.
//
// Both directions are pinned below, so the predicate cannot be quietly loosened
// into the brief's version later.
import { describe, expect, it } from "vitest";
import { buildSchedule, TIER_COUNT } from "./build.ts";
import { resetZ3 } from "./z3-load.ts";
import type { SchedulableFixture, SlotConfig } from "./calendar.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 7, 8, 9, 0);
const config: SlotConfig & { courts: string[] } = {
  startAt: T0,
  matchMinutes: 30,
  gapMinutes: 0,
  courts: ["C1", "C2"],
  perEntrantMinRest: 0,
  window: { from: T0, to: T0 + 240 * MIN },
  tz: "Europe/London",
};

/** Two cards, two courts, both pinned onto the one 09:00 row. Nothing to
 *  improve: `placed` is at its maximum, the makespan is one match, there is no
 *  idle gap and the courts carry one match each. */
const optimal: SchedulableFixture[] = [
  { id: "a", roundNo: 1, home: "E1", away: "E2", locked: { court: "C1", startAt: T0 } },
  { id: "b", roundNo: 1, home: "E3", away: "E4", locked: { court: "C2", startAt: T0 } },
];

describe("buildSchedule — polish", () => {
  it("returns already_optimal and moves nothing on an optimal board", async () => {
    const out = await buildSchedule({ fixtures: optimal, config, mode: "polish", frozen: ["a", "b"] });
    expect(out.status).toBe("already_optimal");
    expect(out.moved).toBe(0);
    // The half the brief's predicate omits, and the half that carries the
    // claim: all four tiers ran to a verdict. Without it `already_optimal` is
    // an opinion about a board nobody finished looking at.
    expect(out.tiersCompleted).toBe(TIER_COUNT);
    expect(out.budgetExpired).toBe(false);
    await resetZ3();
  }, 120_000);

  it("improves an unpublished card and leaves every frozen one alone", async () => {
    const fixtures: SchedulableFixture[] = [
      { id: "pub", roundNo: 1, home: "E1", away: "E2", locked: { court: "C1", startAt: T0 } },
      { id: "draft", roundNo: 1, home: "E3", away: "E4" },
    ];
    const out = await buildSchedule({ fixtures, config, mode: "polish", frozen: ["pub"] });
    const pub = out.assignments.find((a) => a.fixtureId === "pub")!;
    expect({ court: pub.court, startAt: pub.startAt }).toEqual({ court: "C1", startAt: T0 });
    // The draft joins it rather than trailing behind it.
    expect(out.metrics.makespanMinutes).toBe(30);
    await resetZ3();
  }, 120_000);

  // NOTE ON WHAT THE TWO CASES ABOVE DO **NOT** COVER — this is survivor M10.
  //
  // Neither of them discriminates `frozen` at all, and the reason is worth
  // stating rather than discovering twice. Every id they name is ALSO carrying a
  // `locked` placement, and `publishedSlotOf` prefers `locked`; `encodeBuild`
  // asserts a `locked` placement as a unit clause on its own account. So the pin
  // is identical with and without `frozen`, and deleting the parameter leaves
  // both green. That masking is exactly why the web lane's `frozen: plan.frozen`
  // mutant survived its suite: its cases run `only_unlocked: true`, where the
  // frozen ids are a SUBSET of the pinned ids by construction.
  //
  // `frozen` is NOT dead surface, and was measured not to be before this file
  // was written. It is behaviourally live in exactly one shape — a fixture with
  // NO `locked` anchor, held to the slot greedy itself gave it — and
  // `build.test.ts` covers that shape twice ("holds a frozen card to its slot
  // even when moving it would place one more" and "holds a frozen card whose
  // published slot is OFF the lattice"). Deleting `input.frozen` reds both.
  // Nothing is added here rather than duplicating them one file over.

  it("does not call a starved run optimal, however little it moved", async () => {
    // THE TRIPWIRE against the brief's predicate. Every condition it keys on is
    // satisfied: the mode is POLISH and the run moved nothing. It moved nothing
    // because it never got to look — `rlimit: 1` buys one check's overshoot and
    // no verdict at all.
    //
    // `rlimit`, not a wall clock, so this is a property of the search and
    // reproduces on any machine (D9). Measured on this model: spent 153,
    // `tiersCompleted: 0`.
    const out = await buildSchedule({
      fixtures: optimal,
      config,
      mode: "polish",
      frozen: ["a", "b"],
      rlimit: 1,
    });
    // The trigger the brief's version would have fired on.
    expect(out.moved).toBe(0);
    // ...and the answer, which is that nothing was established.
    expect(out.status).toBe("ok");
    expect(out.budgetExpired).toBe(true);
    // EXACT, not `< TIER_COUNT`. Two mechanisms bound this run — the per-check
    // `rlimit` arming and the accounting gate — and an inequality cannot say
    // which one did the work, nor that no tier ran at all.
    expect(out.tiersCompleted).toBe(0);
    await resetZ3();
  }, 120_000);

  it("proves optimality off the tiers, not off the mode", async () => {
    // The other direction. `already_optimal` is a statement about the SEARCH,
    // so the identical board reaches it with no `mode` and no `frozen` — the
    // BUILD path an organiser hits from the ordinary auto-schedule button.
    // Gating the status on POLISH would take it away from every BUILD run,
    // which is the regression the brief's predicate ships.
    //
    // Asserted as a PAIR in one case rather than as two: the claim is that the
    // two runs agree, and two assertions in two files cannot say that.
    const polished = await buildSchedule({
      fixtures: optimal,
      config,
      mode: "polish",
      frozen: ["a", "b"],
    });
    const built = await buildSchedule({ fixtures: optimal, config });
    expect({ status: built.status, tiers: built.tiersCompleted }).toEqual({
      status: polished.status,
      tiers: polished.tiersCompleted,
    });
    expect(built.status).toBe("already_optimal");
    await resetZ3();
  }, 120_000);
});
