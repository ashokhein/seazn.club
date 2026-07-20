import { describe, expect, it } from "vitest";
import { slotFixtures, validateAssignments, type Assignment } from "./calendar";

const MIN = 60_000;

// Rest is stored in two places — `perEntrantMinRest` (the Settings tab, the
// shape of the day) and `constraints.restMin` (the Constraints tab, a rule
// about entrants) — and three call sites used to resolve it differently:
//
//   slotFixtures        max(both, restByGroup, noBackToBack)   correct
//   board validation    perEntrantMinRest only                 ignored restMin
//   AI referee          constraints.restMin only               ignored the other
//
// So the same timetable was legal or illegal depending on which door it came
// through. The placer and the verifier now share one resolver, which is what
// these pin: everything the solver refuses to place, the verifier must refuse
// to accept.

/** Two matches for entrant A, `gapMinutes` apart, each 30 minutes long. */
function backToBack(gapMinutes: number): Assignment[] {
  return [
    { fixtureId: "x", court: "C1", startAt: 0, endAt: 30 * MIN, entrants: ["A"], people: [] },
    {
      fixtureId: "y",
      court: "C2",
      startAt: (30 + gapMinutes) * MIN,
      endAt: (60 + gapMinutes) * MIN,
      entrants: ["A"],
      people: [],
    },
  ];
}

/** The engine's SchedulingConstraints has required fields with zod defaults;
 *  these tests only care about the rest-bearing ones, so fill the rest. */
function cons(partial: Record<string, unknown>) {
  return {
    noBackToBack: false,
    startWindows: [],
    fieldFairness: "off" as const,
    parallelism: "mixed" as const,
    crossPersonClash: "warn" as const,
    ...partial,
  };
}

const rests = (cs: ReturnType<typeof validateAssignments>) => cs.filter((c) => c.reason === "rest");

describe("validateAssignments — rest resolved the same way the solver resolves it", () => {
  it("honours constraints.restMin when the Settings field is unset", () => {
    // The AI referee's exact configuration. Before the fix this returned no
    // conflicts, so the model could hand back a plan breaking the organiser's
    // stated rest and the referee would wave it through.
    const conflicts = validateAssignments(backToBack(10), {
      perEntrantMinRest: 0,
      gapMinutes: 0,
      matchMinutes: 30,
      constraints: cons({ restMin: 60, noBackToBack: false, startWindows: [] }),
    });
    expect(rests(conflicts)).not.toHaveLength(0);
  });

  it("still honours perEntrantMinRest when the Constraints field is unset", () => {
    // The board's configuration — this always worked, and must keep working.
    const conflicts = validateAssignments(backToBack(10), {
      perEntrantMinRest: 60,
      gapMinutes: 0,
      matchMinutes: 30,
      constraints: cons({ restMin: 0, noBackToBack: false, startWindows: [] }),
    });
    expect(rests(conflicts)).not.toHaveLength(0);
  });

  it("takes the stricter of the two when both are set", () => {
    const conflicts = validateAssignments(backToBack(40), {
      perEntrantMinRest: 20,
      gapMinutes: 0,
      matchMinutes: 30,
      constraints: cons({ restMin: 90, noBackToBack: false, startWindows: [] }),
    });
    expect(rests(conflicts)).not.toHaveLength(0);
  });

  it("enforces noBackToBack as a full match plus gap", () => {
    // 15 minutes between matches clears any explicit rest (there is none) but
    // not "at least one fixture between", which is matchMinutes + gapMinutes.
    const conflicts = validateAssignments(backToBack(15), {
      perEntrantMinRest: 0,
      gapMinutes: 0,
      matchMinutes: 30,
      constraints: cons({ restMin: 0, noBackToBack: true, startWindows: [] }),
    });
    expect(rests(conflicts)).not.toHaveLength(0);
  });

  it("applies a restByGroup override to assignments that name their division", () => {
    const assignments = backToBack(30).map((a) => ({ ...a, divisionId: "d1" }));
    const conflicts = validateAssignments(assignments, {
      perEntrantMinRest: 0,
      gapMinutes: 0,
      matchMinutes: 30,
      constraints: cons({
        restMin: 0,
        noBackToBack: false,
        startWindows: [],
        restByGroup: { d1: 45 },
      }),
    });
    expect(rests(conflicts)).not.toHaveLength(0);
  });

  it("stays quiet when the gap satisfies every rest source", () => {
    const conflicts = validateAssignments(backToBack(90), {
      perEntrantMinRest: 20,
      gapMinutes: 0,
      matchMinutes: 30,
      constraints: cons({ restMin: 60, noBackToBack: true, startWindows: [] }),
    });
    expect(rests(conflicts)).toHaveLength(0);
  });

  it("still works for callers that pass no constraints at all", () => {
    // Every existing call site outside the scheduler does this.
    expect(rests(validateAssignments(backToBack(10), { perEntrantMinRest: 60, gapMinutes: 0 }))).not
      .toHaveLength(0);
    expect(rests(validateAssignments(backToBack(90), { perEntrantMinRest: 60, gapMinutes: 0 })))
      .toHaveLength(0);
  });
});

describe("placer and verifier agree", () => {
  it("accepts what slotFixtures produces under the same constraints", () => {
    // The property that matters: a schedule the solver built must never be
    // reported as broken by the validator it is checked against.
    const constraints = cons({ restMin: 45, noBackToBack: true });
    const result = slotFixtures({
      fixtures: [
        { id: "f1", home: "A", away: "B" },
        { id: "f2", home: "A", away: "C" },
        { id: "f3", home: "B", away: "C" },
      ],
      config: {
        startAt: 0,
        matchMinutes: 30,
        gapMinutes: 0,
        courts: ["C1", "C2"],
        perEntrantMinRest: 20,
        blackouts: [],
        sessionWindows: [],
        constraints,
      },
    });
    expect(result.conflicts.filter((c) => c.reason === "rest")).toHaveLength(0);

    const conflicts = validateAssignments(result.assignments, {
      perEntrantMinRest: 20,
      gapMinutes: 0,
      matchMinutes: 30,
      constraints,
    });
    expect(rests(conflicts)).toHaveLength(0);
  });
});
