// The pin builder may only pin cards THIS RUN OWNS.
//
// `solveBuild` builds its pin list from `locked` fixtures plus `frozen` ids, and
// resolves a frozen id through `publishedSlotOf` — which falls back to the
// caller's `current` board. That lookup never asked whether the id names a
// fixture in this run at all, while the force loop a hundred lines further down
// already did (`fixtures.findIndex(...) < 0 -> continue`). The two disagreed,
// and the disagreement is not inert: every pin is admitted into the lattice
// UNCONDITIONALLY, court filter included, so a stale id sitting on a court the
// organiser never configured hands the solver a free slot there.
//
// Reviewer ran it: `courts: ["C1"]`, a ghost pin on `C9`, and fixture `b` came
// back placed on C9 with `status: "ok"`, `engine: "z3"`, `tiersCompleted: 4`.
//
// Latent today — the single web caller derives `frozen` from the same list
// `schedulable` comes from, so the two sets cannot diverge there — which is
// exactly why it needs a test: nothing else covers it.
import { describe, expect, it } from "vitest";
import { buildSchedule } from "./build.ts";
import { resetZ3 } from "./z3-load.ts";
import type { Assignment, SchedulableFixture, SlotConfig } from "./calendar.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 7, 8, 9, 0);

/** ONE configured court, so any second court on the answer can only have come
 *  from a pin. `gapMinutes: 0` and no rest keeps the lattice at the match
 *  length and the arithmetic below exact. */
const config: SlotConfig & { courts: string[] } = {
  startAt: T0,
  matchMinutes: 30,
  gapMinutes: 0,
  courts: ["C1"],
  perEntrantMinRest: 0,
  window: { from: T0, to: T0 + 120 * MIN },
  tz: "Europe/London",
};

/** DISJOINT entrants, so nothing but the court stops these two sharing the
 *  09:00 row — which is what makes the phantom court worth taking. On one court
 *  the shortest board is 60 minutes; with a second court free at 09:00 it is 30,
 *  and the makespan tier will take it. */
const fixtures: SchedulableFixture[] = [
  { id: "a", roundNo: 1, home: "E1", away: "E2" },
  { id: "b", roundNo: 1, home: "E3", away: "E4" },
];

/** A row for a fixture this run was never given — the shape a stale board, a
 *  filtered `schedulable` list or another division's card arrives in. */
const ghost: Assignment = {
  fixtureId: "ghost",
  court: "C9",
  startAt: T0,
  endAt: T0 + 30 * MIN,
  entrants: ["E9", "E10"],
  people: [],
};

describe("a frozen id that names no fixture in this run", () => {
  it("does not add its court to the lattice", async () => {
    const out = await buildSchedule({
      fixtures,
      config,
      current: [ghost],
      frozen: ["ghost"],
    });

    // The whole assertion. C9 is not a court the organiser configured, and a
    // card placed there is a card nobody can play.
    expect(out.assignments.map((a) => a.court)).toEqual(["C1", "C1"]);
    expect(out.metrics.placed).toBe(2);
    // And the board is the honest one-court board, not the 30-minute board the
    // phantom slot buys. Pinned so a future court filter that drops C9 from the
    // ANSWER while leaving it in the lattice cannot pass this quietly: T3 would
    // still be optimising an imbalance against a court that does not exist.
    expect(out.metrics.makespanMinutes).toBe(60);
    await resetZ3();
  }, 120_000);

  it("agrees with the same run that was never handed the ghost", async () => {
    // The control. Without it the case above is satisfied by a run that refused
    // to solve at all, and "no card on C9" is true of an empty board too.
    const withGhost = await buildSchedule({
      fixtures,
      config,
      current: [ghost],
      frozen: ["ghost"],
    });
    const without = await buildSchedule({ fixtures, config });
    expect(withGhost.assignments).toEqual(without.assignments);
    expect(withGhost.metrics).toEqual(without.metrics);
    await resetZ3();
  }, 120_000);
});
