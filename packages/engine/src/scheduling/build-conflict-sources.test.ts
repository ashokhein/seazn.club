// What a card that is NOT on the answer is told about itself.
//
// `conflictsFor` has three sources, in descending order of how well established
// they are: greedy's own diagnosis, then the blocking conflict that disqualified
// the row, and only then a bare `no_slot`. The ordering is right; the FILTER on
// the first source was not.
//
// `rawSeed.conflicts` is not "what greedy could not do". It also carries rows
// `slotFixtures` emits about cards it DID place — the `commit` person-overlap
// loop, and the locked-clash rows — and source 1 short-circuits the other two.
// So a card greedy PLACED and something later removed (the legalisation pass
// dropping it for a blocking conflict, or z3 dropping one while adding two) was
// reported with a placed card's conflict, and never got its own disqualifying
// row or a `no_slot`.
//
// The visible damage is that the two sides of ONE collision are described
// differently: the card greedy committed first is told which fixture it
// double-booked with, the second is told only that "the locked slot clashes",
// which names nobody and is fed verbatim to the repair prompt.
import { describe, expect, it } from "vitest";
import { buildSchedule } from "./build.ts";
import { resetZ3 } from "./z3-load.ts";
import { slotFixtures } from "./calendar.ts";
import type { SchedulableFixture, SlotConfig } from "./calendar.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 7, 8, 9, 0);

const config: SlotConfig & { courts: string[] } = {
  startAt: T0,
  matchMinutes: 30,
  gapMinutes: 0,
  courts: ["C1"],
  perEntrantMinRest: 0,
  window: { from: T0, to: T0 + 120 * MIN },
  tz: "Europe/London",
};

/** Both cards pinned onto the SAME slot. `slotFixtures` honours a pin rather
 *  than fixing it, so it commits both and reports the collision against the
 *  second — a conflict row about a card it PLACED, which is exactly the shape
 *  source 1 must not claim. */
const collide: SchedulableFixture[] = [
  { id: "a", roundNo: 1, home: "E1", away: "E2", locked: { court: "C1", startAt: T0 } },
  { id: "b", roundNo: 1, home: "E3", away: "E4", locked: { court: "C1", startAt: T0 } },
];

describe("a card that greedy placed and something later dropped", () => {
  it("gets its own disqualifying conflict, not the row greedy filed while placing it", async () => {
    // The premise. Greedy placed BOTH, and its own conflict list names only `b`
    // — so `b` is a card `rawSeed.assignments` contains, and source 1 has no
    // business answering for it.
    const seed = slotFixtures({ fixtures: collide, config });
    expect(seed.assignments.map((a) => a.fixtureId)).toEqual(["a", "b"]);
    expect(seed.conflicts.map((c) => [c.fixtureId, c.detail])).toEqual([
      ["b", "locked slot clashes on C1"],
    ]);

    const out = await buildSchedule({ fixtures: collide, config });
    // Two pins on one slot is the one thing that can make this model globally
    // unsat, so the board comes back empty and both cards need a reason.
    expect(out.assignments).toEqual([]);

    // ONE collision, described the same way from both sides, each naming the
    // other card. Before the fix `b` read "locked slot clashes on C1" — greedy's
    // row about the placement it had just made.
    expect(out.conflicts.map((c) => [c.fixtureId, c.reason, c.detail])).toEqual([
      ["a", "court", "court C1 double-booked with b"],
      ["b", "court", "court C1 double-booked with a"],
    ]);
    await resetZ3();
  }, 120_000);

  it("still gives greedy's own diagnosis to a card greedy could not place", async () => {
    // The guard on the fix, and the reason source 1 exists at all. Narrowing it
    // to "absent from the seed" must not turn a real greedy diagnosis into a
    // bare `no_slot` — the binding constraint greedy names is the best answer
    // anybody has for a card that was never placed.
    const fixtures: SchedulableFixture[] = [
      { id: "a", roundNo: 1, home: "E1", away: "E2" },
      { id: "b", roundNo: 1, home: "E3", away: "E4" },
      { id: "c", roundNo: 1, home: "E5", away: "E6" },
    ];
    // One court, one match's worth of session: room for exactly one card.
    const tight: SlotConfig & { courts: string[] } = {
      ...config,
      sessionWindows: [{ from: T0, to: T0 + 30 * MIN }],
      window: { from: T0, to: T0 + 30 * MIN },
    };
    const seed = slotFixtures({ fixtures, config: tight });
    expect(seed.assignments.map((a) => a.fixtureId)).toEqual(["a"]);
    const greedySaid = seed.conflicts.filter((c) => c.fixtureId === "b");
    expect(greedySaid).toHaveLength(1);

    const out = await buildSchedule({ fixtures, config: tight });
    const forB = out.conflicts.filter((c) => c.fixtureId === "b");
    expect(forB).toEqual(greedySaid);
    await resetZ3();
  }, 120_000);
});
