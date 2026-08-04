// #463 — the placer must honour `max_fixtures_per_day`, and it must count on the
// ORG calendar day. `validateAssignments` has always reported this rule
// (`validateInstructionRules`, the `max_fixtures_per_day` branch); the placer
// packed straight through it, so Auto proposed a board the apply gate warned
// about and re-running Auto proposed the same board again.
import { describe, expect, it } from "vitest";
import { slotFixtures, type SchedulableFixture } from "./calendar.ts";
import { SchedulingConstraints, type HardConstraint } from "./constraints.ts";
import { dayKeyInTz } from "./tz.ts";

const TZ = "America/Los_Angeles";

// 2026-07-11 16:00 LOCAL. Deliberately late in the local day: the cards that
// follow land on 2026-07-12 in UTC while still being Saturday 2026-07-11 in Los
// Angeles, so a UTC bucket splits the day 2 + 1 and admits a third card onto a
// day the organiser capped at two. Only the org zone gives the right answer.
const SAT_1600_LOCAL = Date.UTC(2026, 6, 11, 23, 0);

// All three share `e1`, so with zero rest they serialise in id order on one
// court — nothing but the cap can move them apart.
const cards = (n: number): SchedulableFixture[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `f${i + 1}`,
    home: "e1",
    away: `e${i + 10}`,
    divisionId: "d1",
  }));

// `count`, not `max` — constraints.ts:70. Parsed rather than cast so a wrong
// field name fails here rather than binding nothing.
const CAP_2: HardConstraint = {
  type: "max_fixtures_per_day",
  count: 2,
  scope: { kind: "entrant", entrantId: "e1" },
};

const place = (n: number, hard: HardConstraint[], horizonMinutes: number) =>
  slotFixtures({
    fixtures: cards(n),
    config: {
      startAt: SAT_1600_LOCAL,
      matchMinutes: 30,
      gapMinutes: 0,
      perEntrantMinRest: 0,
      courts: ["C1"],
      blackouts: [],
      sessionWindows: [],
      tz: TZ,
      horizonMinutes,
      constraints: SchedulingConstraints.parse({ hard }),
    },
  });

const localDays = (res: ReturnType<typeof place>): string[] =>
  [...res.assignments]
    .sort((a, b) => a.startAt - b.startAt)
    .map((a) => dayKeyInTz(a.startAt, TZ));

describe("the placer honours max_fixtures_per_day on the ORG day (#463)", () => {
  it("pushes the capped card to the next LOCAL day, not the next UTC one", () => {
    const res = place(3, [CAP_2], 60 * 24 * 3);
    expect(res.assignments).toHaveLength(3);
    // Cards two and three sit at 23:30Z and 00:00Z — different UTC days, the
    // same Saturday in Los Angeles.
    expect(localDays(res)).toEqual(["2026-07-11", "2026-07-11", "2026-07-12"]);
    expect(res.conflicts).toEqual([]);
  });

  it("reports no_slot when no later day is reachable inside the horizon", () => {
    // Two hours of horizon: the next local day starts eight hours out, so the
    // third card has nowhere legal to go and takes the existing unplaceable path
    // rather than being packed into a breach.
    const res = place(3, [CAP_2], 120);
    expect(res.assignments).toHaveLength(2);
    expect(res.conflicts.filter((c) => c.reason === "no_slot").map((c) => c.fixtureId)).toEqual(["f3"]);
  });

  it("packs all three on one local day when no cap is in force", () => {
    // Guard the guard: without the rule the placer fills the same day, so the
    // split above is the cap doing the work and not the horizon or the clock.
    const res = place(3, [], 60 * 24 * 3);
    expect(localDays(res)).toEqual(["2026-07-11", "2026-07-11", "2026-07-11"]);
  });

  it("leaves a card the cap does not cover alone", () => {
    // The cap is scoped to `e1`; `e2`'s card is not its business. Without this a
    // day-level rejection that ignored scope would still pass every case above.
    const res = slotFixtures({
      fixtures: [...cards(2), { id: "f9", home: "e2", away: "e3", divisionId: "d1" }],
      config: {
        startAt: SAT_1600_LOCAL,
        matchMinutes: 30,
        gapMinutes: 0,
        perEntrantMinRest: 0,
        courts: ["C1", "C2"],
        blackouts: [],
        sessionWindows: [],
        tz: TZ,
        horizonMinutes: 60 * 24 * 3,
        constraints: SchedulingConstraints.parse({ hard: [CAP_2] }),
      },
    });
    const f9 = res.assignments.find((a) => a.fixtureId === "f9");
    expect(f9).toBeDefined();
    expect(dayKeyInTz(f9!.startAt, TZ)).toBe("2026-07-11");
  });
});
