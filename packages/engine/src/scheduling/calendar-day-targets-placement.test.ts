// #463 — `fixture_on_date` / `fixture_on_weekday` name a CARD, not a scope:
// constraints.ts:73-84 gives both a required `selector`, a `WeekdayCode` string
// (never a number), and a YYYY-MM-DD `date`. The verifier resolves that selector
// through `ruleFixtures` and reports a card on the wrong day; the placer put
// every card on the first day it could and never moved one for a target date.
//
// This is the family that needs a DAY-level jump: the target can be a fortnight
// out, and a repair loop stepping one 30-minute slot at a time exhausts its 64
// tries inside the first afternoon.
import { describe, expect, it } from "vitest";
import { slotFixtures, type RuleFixture, type SchedulableFixture } from "./calendar.ts";
import { SchedulingConstraints, type HardConstraint } from "./constraints.ts";
import { dayKeyInTz, weekdayOfYmd } from "./tz.ts";

const TZ = "America/Los_Angeles";
// Saturday 2026-07-11, 10:00 local. The first Wednesday after it is 2026-07-15.
const SAT_1000_LOCAL = Date.UTC(2026, 6, 11, 17, 0);

// Distinct entrants: the two cards are independent, so a card that does NOT
// move is evidence about the rule and not about rest spacing.
const FIXTURES: SchedulableFixture[] = [
  { id: "f1", home: "e1", away: "e2", divisionId: "d1" },
  { id: "f2", home: "e3", away: "e4", divisionId: "d1" },
];

const D1 = { kind: "division", divisionId: "d1" } as const;
const BY_ID = { kind: "id", fixtureId: "f1" } as const;

const place = (hard: HardConstraint[], ruleFixtures?: readonly RuleFixture[]) =>
  slotFixtures({
    fixtures: FIXTURES,
    config: {
      startAt: SAT_1000_LOCAL,
      matchMinutes: 30,
      gapMinutes: 0,
      perEntrantMinRest: 0,
      courts: ["C1"],
      blackouts: [],
      sessionWindows: [],
      tz: TZ,
      horizonMinutes: 60 * 24 * 14,
      constraints: SchedulingConstraints.parse({ hard }),
      ...(ruleFixtures !== undefined ? { ruleFixtures } : {}),
    },
  });

const dayOf = (res: ReturnType<typeof place>, id: string): string | undefined => {
  const a = res.assignments.find((x) => x.fixtureId === id);
  return a === undefined ? undefined : dayKeyInTz(a.startAt, TZ);
};

describe("the placer honours fixture_on_date / fixture_on_weekday (#463)", () => {
  it("moves the named card to the required calendar date, days away", () => {
    const res = place([{ type: "fixture_on_date", selector: BY_ID, date: "2026-07-15", scope: D1 }]);
    expect(res.conflicts).toEqual([]);
    expect(dayOf(res, "f1")).toBe("2026-07-15");
    // The selector names one card. A rule that moved the whole division would
    // pass the line above and fail this one.
    expect(dayOf(res, "f2")).toBe("2026-07-11");
  });

  it("moves the named card to the next matching weekday", () => {
    const res = place([{ type: "fixture_on_weekday", selector: BY_ID, weekday: "WED", scope: D1 }]);
    const day = dayOf(res, "f1")!;
    expect(weekdayOfYmd(day)).toBe("WED");
    // The NEXT Wednesday, not some later one — the jump is one week at most.
    expect(day).toBe("2026-07-15");
    expect(dayOf(res, "f2")).toBe("2026-07-11");
  });

  it("resolves a terminal selector through ruleFixtures, as the verifier does", () => {
    // `terminal` is `winnerTo === null` and needs metadata a SchedulableFixture
    // does not carry. Given `ruleFixtures` the placer resolves it with the same
    // `resolveSelector` the verifier calls, so both name the same card — here
    // f2, the one nothing feeds on to.
    const ruleFixtures: RuleFixture[] = [
      { id: "f1", extKey: "f1", divisionId: "d1", winnerTo: "f2" },
      { id: "f2", extKey: "f2", divisionId: "d1", winnerTo: null },
    ];
    const res = place(
      [{ type: "fixture_on_date", selector: { kind: "terminal" }, date: "2026-07-15", scope: D1 }],
      ruleFixtures,
    );
    expect(dayOf(res, "f2")).toBe("2026-07-15");
    expect(dayOf(res, "f1")).toBe("2026-07-11");
  });

  it("reports no_slot for a date already behind the first slot", () => {
    // This pass only ever moves a card LATER, so a target date in the past is
    // unreachable. Refusing it is the honest answer; placing it on the wrong day
    // and letting the gate warn is the fork.
    const res = place([{ type: "fixture_on_date", selector: BY_ID, date: "2026-07-05", scope: D1 }]);
    expect(res.assignments.map((a) => a.fixtureId)).toEqual(["f2"]);
    expect(res.conflicts.filter((c) => c.reason === "no_slot").map((c) => c.fixtureId)).toEqual(["f1"]);
  });

  it("leaves an unresolvable selector alone rather than guessing", () => {
    // No `ruleFixtures`, so `terminal` cannot be resolved: a SchedulableFixture
    // carries no `winnerTo`, and assuming every card is terminal would bind a
    // final's rule to the entire draw.
    const res = place([
      { type: "fixture_on_date", selector: { kind: "terminal" }, date: "2026-07-15", scope: D1 },
    ]);
    expect(dayOf(res, "f1")).toBe("2026-07-11");
    expect(dayOf(res, "f2")).toBe("2026-07-11");
  });

  it("places on the first day when no day target is in force", () => {
    expect(dayOf(place([]), "f1")).toBe("2026-07-11");
  });
});
