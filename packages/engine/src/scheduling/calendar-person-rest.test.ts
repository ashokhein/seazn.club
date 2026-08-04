import { describe, expect, it } from "vitest";
import { slotFixtures } from "./calendar.ts";

const T0 = Date.UTC(2026, 6, 4, 9, 0);

describe("placer rests on shared PEOPLE, not only shared entrants (#463)", () => {
  it("separates two fixtures that share a person but no entrant", () => {
    const res = slotFixtures({
      fixtures: [
        { id: "a", home: "e1", away: "e2", people: ["p-shared"], divisionId: "d1" },
        { id: "b", home: "e3", away: "e4", people: ["p-shared"], divisionId: "d1" },
      ],
      config: {
        startAt: T0,
        matchMinutes: 30,
        gapMinutes: 0,
        perEntrantMinRest: 60, // one hour of rest is owed to a shared participant
        courts: ["C1", "C2"], // two courts, so nothing forces them apart
        blackouts: [],
        sessionWindows: [],
      },
    });

    expect(res.assignments).toHaveLength(2);
    const [a, b] = [...res.assignments].sort((x, y) => x.startAt - y.startAt);
    // Without the fix both are placed at T0 on different courts: they share no
    // entrant, so `lastEnd` never saw the overlap.
    expect(b!.startAt - a!.endAt).toBeGreaterThanOrEqual(60 * 60_000);
  });

  it("still packs fixtures that share nothing", () => {
    const res = slotFixtures({
      fixtures: [
        { id: "a", home: "e1", away: "e2", people: ["p1"], divisionId: "d1" },
        { id: "b", home: "e3", away: "e4", people: ["p2"], divisionId: "d1" },
      ],
      config: {
        startAt: T0,
        matchMinutes: 30,
        gapMinutes: 0,
        perEntrantMinRest: 60,
        courts: ["C1", "C2"],
        blackouts: [],
        sessionWindows: [],
      },
    });
    expect(res.assignments.every((a) => a.startAt === T0)).toBe(true);
  });

  it("does not fuse a person id with an identically-spelled entrant id", () => {
    // Rest is owed to a PARTICIPANT, but an entrant and a person are different
    // participants even when their ids collide as strings. One rest map keyed on
    // the bare id would rest `b` behind `a` for a shared entrant that is really
    // an unrelated person.
    const res = slotFixtures({
      fixtures: [
        { id: "a", home: "x1", away: "e2", divisionId: "d1" },
        { id: "b", home: "e3", away: "e4", people: ["x1"], divisionId: "d1" },
      ],
      config: {
        startAt: T0,
        matchMinutes: 30,
        gapMinutes: 0,
        perEntrantMinRest: 60,
        courts: ["C1", "C2"],
        blackouts: [],
        sessionWindows: [],
      },
    });
    expect(res.assignments.every((a) => a.startAt === T0)).toBe(true);
  });
});
