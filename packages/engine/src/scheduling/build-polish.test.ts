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
import type { Assignment, SchedulableFixture, SlotConfig } from "./calendar.ts";

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

/**
 * THE measured corner from `build.test.ts`: one court, two slots, and a start
 * window only `b` can use.
 *
 * Greedy walks fixtures in (roundNo, id) order, takes 09:00 for `a` because
 * nothing stops it, and is then left with nowhere legal for `b` — so it hands
 * back a one-card board. The solver looks at both at once and places both:
 * greedy `[a@C1+0]`, z3 `[b@C1+0, a@C1+30]`.
 *
 * Used by every `current` case below because it is the one corner where the
 * caller's board, the greedy seed and the solver's answer can all be made to
 * disagree — which is what it takes to prove WHICH of them a number was read
 * from.
 */
const cornerConfig: SlotConfig & { courts: string[] } = {
  ...config,
  courts: ["C1"],
  sessionWindows: [{ from: T0, to: T0 + 60 * MIN }],
  constraints: {
    noBackToBack: false,
    fieldFairness: "off",
    parallelism: "mixed",
    crossPersonClash: "warn",
    startWindows: [{ target: { kind: "entrant", id: "E3" }, notAfter: T0 }],
  },
};
const cornerFixtures: SchedulableFixture[] = [
  { id: "a", roundNo: 1, home: "E1", away: "E2" },
  { id: "b", roundNo: 1, home: "E3", away: "E4" },
];

const row = (fixtureId: string, court: string, startAt: number): Assignment => ({
  fixtureId,
  court,
  startAt,
  endAt: startAt + 30 * MIN,
  entrants: [],
  people: [],
});

/** The organiser's board: just `a`, wherever they published it. */
const currentWithAAt = (startAt: number): Assignment[] => [row("a", "C1", startAt)];

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

  it("freezes a card to where it was PUBLISHED, not to where greedy re-placed it", async () => {
    // RULING R20, and the shape neither case above can see because both of them
    // `lock` everything: a fixture that is frozen but carries NO `locked`
    // anchor.
    //
    // `publishedSlotOf` used to fall straight through to greedy for such a
    // card. Greedy re-places it — that is what greedy does — so the freeze held
    // it at a slot INVENTED during this very run, and POLISH silently moved a
    // card an entrant had already been told about. The exact opposite of what
    // the mode is for.
    //
    // Measured corner (`build.test.ts`): one court, two slots, and a start
    // window only `b` can use. Greedy walks in (roundNo, id) order, takes 09:00
    // for `a`, and then has nowhere legal for `b`. The organiser's board has `a`
    // at 09:30 — so honouring the PUBLISHED slot also happens to free 09:00 and
    // let both cards fit, which is why `placed` is asserted too.
    const out = await buildSchedule({
      fixtures: cornerFixtures,
      config: cornerConfig,
      mode: "polish",
      frozen: ["a"],
      current: currentWithAAt(T0 + 30 * MIN),
    });
    const a = out.assignments.find((x) => x.fixtureId === "a")!;
    expect({ court: a.court, startAt: a.startAt }).toEqual({ court: "C1", startAt: T0 + 30 * MIN });
    // NOT greedy's slot, stated as its own assertion so the case cannot pass by
    // the two happening to coincide.
    expect(a.startAt).not.toBe(T0);
    expect(out.metrics.placed).toBe(2);
    await resetZ3();
  }, 120_000);

  it("measures `moved` from the caller's board, not from the greedy seed", async () => {
    // Same corner, no freeze: the solver is free to rearrange, and it does —
    // measured, greedy gives `[a@C1+0]` and z3 gives `[b@C1+0, a@C1+30]`.
    //
    // The organiser's board had `a` at 09:30, which is where the solver puts it,
    // so against THEIR board `a` did not move and only `b` is new: 1. Against
    // the greedy seed both look changed: 2. The two baselines disagree by
    // construction here, which is the only way to prove which one is being read.
    const out = await buildSchedule({
      fixtures: cornerFixtures,
      config: cornerConfig,
      current: currentWithAAt(T0 + 30 * MIN),
    });
    expect(out.metrics.placed).toBe(2);
    expect(out.assignments.find((x) => x.fixtureId === "a")?.startAt).toBe(T0 + 30 * MIN);
    expect(out.moved).toBe(1);

    // The control: the identical run with no `current` falls back to the seed
    // and counts both.
    const seedBaseline = await buildSchedule({ fixtures: cornerFixtures, config: cornerConfig });
    expect(seedBaseline.moved).toBe(2);
    await resetZ3();
  }, 120_000);

  it("treats an EMPTY current as no board at all", async () => {
    // `[]` is the natural shape of a first-ever build on a division nobody has
    // scheduled. Read as a baseline it makes every card the run places differ
    // from it, and the strip announces "2 matches moved" about a board that
    // never existed. It has to mean the same as omitting the field.
    //
    // THE BOARD HERE IS THE ALREADY-OPTIMAL ONE, and that choice is the test.
    // On the corner both baselines happen to answer 2 — the empty one because
    // every row is unknown to it, the seed one because the solver rearranges
    // both cards — so the case passed under the mutant and proved nothing.
    // Measured, and rewritten. On a board the solver does not touch the seed
    // baseline answers 0 and an empty-array baseline answers 2, so the two are
    // finally distinguishable.
    const empty = await buildSchedule({ fixtures: optimal, config, current: [] });
    const omitted = await buildSchedule({ fixtures: optimal, config });
    expect(empty.moved).toBe(omitted.moved);
    // Pinned absolutely as well as relatively: equality alone would hold if both
    // arms drifted to the same wrong number.
    expect(empty.moved).toBe(0);
    await resetZ3();
  }, 120_000);

  it("counts a card the run could not place as moved, not as nothing", async () => {
    // ONE slot, two fixtures: whatever happens, one card comes off the board.
    // Greedy takes 09:00 for `a` and the solver can do no better, so the
    // SURVIVOR keeps its slot — and counting only the board's own rows then
    // reports `moved: 0` for a run that lost a match. The most alarming outcome
    // there is, described as the most reassuring one.
    //
    // Unreachable while the baseline was the seed (T0 maximises `placed`, so the
    // answer never drops below it) and reachable the moment it can be the
    // caller's board instead.
    const oneSlot: SlotConfig & { courts: string[] } = {
      ...config,
      courts: ["C1"],
      sessionWindows: [{ from: T0, to: T0 + 30 * MIN }],
    };
    const fixtures: SchedulableFixture[] = [
      { id: "a", roundNo: 1, home: "E1", away: "E2" },
      { id: "b", roundNo: 1, home: "E3", away: "E4" },
    ];
    const out = await buildSchedule({
      fixtures,
      config: oneSlot,
      current: [
        row("a", "C1", T0),
        // Where the organiser had `b` — a slot the session window no longer
        // reaches, which is exactly how a card gets lost in practice.
        row("b", "C1", T0 + 30 * MIN),
      ],
    });
    expect(out.metrics.placed).toBe(1);
    // The survivor really did keep its slot, so the only thing left to count is
    // the card that vanished.
    expect(out.assignments.find((x) => x.fixtureId === "a")?.startAt).toBe(T0);
    expect(out.moved).toBe(1);
    await resetZ3();
  }, 120_000);

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
