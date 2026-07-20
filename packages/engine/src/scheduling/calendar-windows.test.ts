import { describe, expect, it } from "vitest";
import { validateAssignments, type Assignment } from "./calendar";

const MIN = 60_000;
const base = { perEntrantMinRest: 0, gapMinutes: 0, matchMinutes: 30 };
const at = (startMin: number, extra: Partial<Assignment> = {}): Assignment[] => [
  {
    fixtureId: "x",
    court: "C1",
    startAt: startMin * MIN,
    endAt: (startMin + 30) * MIN,
    entrants: ["A"],
    people: [],
    ...extra,
  },
];

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

const windows = (cs: ReturnType<typeof validateAssignments>) =>
  cs.filter((c) => c.reason === "start_window");

// startWindows are a hard bound in the solver — it refuses to place a fixture
// outside its target's window (calendar.ts, `windowFor`). The verifier never
// looked at them, so the same bound was enforced when Auto-schedule placed a
// match and ignored when someone dragged one, or when the AI referee checked a
// plan the model produced.
describe("validateAssignments — start windows", () => {
  const constraints = cons({
    startWindows: [
      { target: { kind: "entrant" as const, id: "A" }, notBefore: 60 * MIN, notAfter: 180 * MIN },
    ],
  });

  it("flags a fixture starting before its entrant's window opens", () => {
    expect(windows(validateAssignments(at(30), { ...base, constraints }))).not.toHaveLength(0);
  });

  it("flags a fixture starting after its entrant's window closes", () => {
    expect(windows(validateAssignments(at(240), { ...base, constraints }))).not.toHaveLength(0);
  });

  it("accepts a fixture inside the window", () => {
    expect(windows(validateAssignments(at(90), { ...base, constraints }))).toHaveLength(0);
  });

  it("bounds the START, not the finish — a match may run past notAfter", () => {
    // Mirrors the solver, which compares `start > window.notAfter`.
    expect(windows(validateAssignments(at(170), { ...base, constraints }))).toHaveLength(0);
  });

  it("ignores windows aimed at somebody else", () => {
    const other = cons({
      startWindows: [{ target: { kind: "entrant" as const, id: "B" }, notBefore: 60 * MIN }],
    });
    expect(windows(validateAssignments(at(0), { ...base, constraints: other }))).toHaveLength(0);
  });

  it("applies a pool-targeted window to assignments in that pool", () => {
    const pooled = cons({
      startWindows: [{ target: { kind: "pool" as const, id: "p1" }, notBefore: 60 * MIN }],
    });
    expect(
      windows(validateAssignments(at(0, { poolId: "p1" }), { ...base, constraints: pooled })),
    ).not.toHaveLength(0);
    expect(
      windows(validateAssignments(at(0, { poolId: "p2" }), { ...base, constraints: pooled })),
    ).toHaveLength(0);
  });

  it("takes the tightest bound when several windows target the same fixture", () => {
    const stacked = cons({
      startWindows: [
        { target: { kind: "entrant" as const, id: "A" }, notBefore: 60 * MIN },
        { target: { kind: "division" as const, id: "d1" }, notBefore: 120 * MIN },
      ],
    });
    const a = at(90, { divisionId: "d1" });
    expect(windows(validateAssignments(a, { ...base, constraints: stacked }))).not.toHaveLength(0);
  });

  it("says nothing when no windows are configured", () => {
    expect(
      windows(validateAssignments(at(0), { ...base, constraints: cons({}) })),
    ).toHaveLength(0);
  });
});
