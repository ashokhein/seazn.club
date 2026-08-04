// #463 — `not_before` / `not_after` are WALL-CLOCK bounds in the org zone, never
// instants (constraints.ts:56-59). The verifier compares `hhmmInTz(start, tz)`
// against them; the placer ignored them entirely, so "nothing before 9am"
// displayed as a rule, warned on every board Auto produced, and bound nothing
// the organiser could act on.
import { describe, expect, it } from "vitest";
import { slotFixtures } from "./calendar.ts";
import { SchedulingConstraints, type HardConstraint } from "./constraints.ts";
import { dayKeyInTz, hhmmInTz } from "./tz.ts";

const TZ = "America/Los_Angeles";
const SAT_0600_LOCAL = Date.UTC(2026, 6, 11, 13, 0);
const SAT_1300_LOCAL = Date.UTC(2026, 6, 11, 20, 0);

const D1 = { kind: "division", divisionId: "d1" } as const;
const notBefore = (time: string): HardConstraint => ({ type: "not_before", time, scope: D1 });
const notAfter = (time: string): HardConstraint => ({ type: "not_after", time, scope: D1 });

const place = (startAt: number, hard: HardConstraint[], horizonMinutes = 60 * 24 * 3) =>
  slotFixtures({
    fixtures: [{ id: "f1", home: "e1", away: "e2", divisionId: "d1" }],
    config: {
      startAt,
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

describe("the placer honours not_before / not_after (#463)", () => {
  it("raises a candidate to the rule's wall-clock time on the same local day", () => {
    const res = place(SAT_0600_LOCAL, [notBefore("09:00")]);
    expect(res.assignments).toHaveLength(1);
    const a = res.assignments[0]!;
    expect(dayKeyInTz(a.startAt, TZ)).toBe("2026-07-11");
    expect(hhmmInTz(a.startAt, TZ)).toBe("09:00");
  });

  it("pushes a candidate past not_after to the next local day", () => {
    const res = place(SAT_1300_LOCAL, [notAfter("12:00")]);
    expect(res.assignments).toHaveLength(1);
    const a = res.assignments[0]!;
    expect(dayKeyInTz(a.startAt, TZ)).toBe("2026-07-12");
    expect(hhmmInTz(a.startAt, TZ) <= "12:00").toBe(true);
  });

  it("resolves both bounds together — next day, then the morning bound", () => {
    // 13:00 local breaches `not_after`, so the card moves to tomorrow; tomorrow
    // starts at 00:00, which breaches `not_before`, so it rises again. Two
    // day-level and time-level jumps inside one repair budget.
    const res = place(SAT_1300_LOCAL, [notBefore("09:00"), notAfter("12:00")]);
    expect(res.assignments).toHaveLength(1);
    const a = res.assignments[0]!;
    expect(dayKeyInTz(a.startAt, TZ)).toBe("2026-07-12");
    expect(hhmmInTz(a.startAt, TZ)).toBe("09:00");
  });

  it("reports no_slot rather than placing inside the bound", () => {
    // One hour of horizon from 06:00 local: 09:00 is out of reach and the card
    // takes the existing unplaceable path instead of being packed into a breach.
    const res = place(SAT_0600_LOCAL, [notBefore("09:00")], 60);
    expect(res.assignments).toEqual([]);
    expect(res.conflicts.map((c) => c.reason)).toEqual(["no_slot"]);
  });

  it("places at the first slot when no bound is in force", () => {
    // Guard the guard: the movement above is the rule and not the clock.
    const res = place(SAT_0600_LOCAL, []);
    expect(res.assignments[0]!.startAt).toBe(SAT_0600_LOCAL);
  });
});
