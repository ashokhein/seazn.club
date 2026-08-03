// #399 W4 gap 7 — a dependent fixture may not start at its feeder's final
// whistle.
//
// The advancing player IS a participant of the fixture they feed (#396), so the
// occupancy that matters is the feeder's end plus the rest that player is owed.
// Frozen against payload A (badminton double elimination): `wb-r0-i1` feeds
// `wb-r1-i0` by a direct winner feed, which is the edge a real bracket walks.
import { describe, expect, it } from "vitest";
import { validateAssignments, type Conflict, type OrderDependency, type VerifyConfig } from "./calendar";
import { assign, at, BADMINTON, BASE_CONFIG, SOLO } from "./payload-fixtures";

const MIN = 60_000;
const FEEDER = "wb-r0-i1";
const DEPENDENT = "wb-r1-i0";
const FEEDER_START = "2026-08-10T09:00:00.000Z";
const FEEDER_END_MS = at(FEEDER_START) + BASE_CONFIG.matchMinutes * MIN;

const deps: OrderDependency[] = [{ fixtureId: DEPENDENT, dependsOn: FEEDER, direct: true }];

const iso = (ms: number): string => new Date(ms).toISOString();

/** Both fixtures on their own courts, so nothing but the feed edge is in play. */
const board = (dependentStartMs: number) =>
  assign(BADMINTON, SOLO, [
    [FEEDER, FEEDER_START, "C1"],
    [DEPENDENT, iso(dependentStartMs), "C2"],
  ]);

const orderConflicts = (dependentStartMs: number, restMinutes: number): Conflict[] =>
  validateAssignments(
    board(dependentStartMs),
    { ...BASE_CONFIG, perEntrantMinRest: restMinutes } as VerifyConfig,
    [],
    deps,
  ).filter((c) => c.reason === "order");

describe("feeder rest (#399)", () => {
  it("refuses a dependent that starts the instant its feeder ends", () => {
    const conflicts = orderConflicts(FEEDER_END_MS, 45);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.fixtureId).toBe(DEPENDENT);
    expect(conflicts[0]!.direct).toBe(true);
    expect(conflicts[0]!.rule).toBe("H6");
    expect(conflicts[0]!.detail).toContain("needs 45");
  });

  it("accepts the same pair once the rest is honoured", () => {
    expect(orderConflicts(FEEDER_END_MS + 45 * MIN, 45)).toEqual([]);
  });

  it("accepts a gap of exactly the rest, not one minute more", () => {
    expect(orderConflicts(FEEDER_END_MS + 45 * MIN, 45)).toEqual([]);
    expect(orderConflicts(FEEDER_END_MS + 44 * MIN, 45)).toHaveLength(1);
  });

  it("leaves a back-to-back board clean when no rest is configured", () => {
    // The pre-#399 shape, preserved exactly: rest 0 means the feeder's whistle
    // is the earliest legal start, and that board still verifies.
    expect(orderConflicts(FEEDER_END_MS, 0)).toEqual([]);
  });

  it("still reports a genuine ordering violation as exactly one conflict", () => {
    const conflicts = orderConflicts(FEEDER_END_MS - 10 * MIN, 45);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.detail).toBe(`starts before feeder ${FEEDER} ends`);
  });

  it("keys the rest breach apart from the ordering violation", () => {
    // The two are different failures and MUST carry different details, or the
    // delta gate lets a rest breach hide behind a pre-existing ordering one.
    const late = orderConflicts(FEEDER_END_MS - 10 * MIN, 45)[0]!;
    const short = orderConflicts(FEEDER_END_MS, 45)[0]!;
    expect(late.detail).not.toBe(short.detail);
  });

  it("takes the rest from the constraints tab too, not only the settings one", () => {
    const conflicts = validateAssignments(
      board(FEEDER_END_MS + 20 * MIN),
      { ...BASE_CONFIG, perEntrantMinRest: 0, constraints: { restMin: 30 } } as VerifyConfig,
      [],
      deps,
    ).filter((c) => c.reason === "order");
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.detail).toContain("needs 30");
  });
});
