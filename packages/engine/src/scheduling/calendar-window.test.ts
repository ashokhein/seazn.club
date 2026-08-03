// Both-directions proof for the pack window (#397, design §7.2). The payload is
// the frozen badminton double-elimination board — the same 13 fixtures
// participants-rules.test.ts uses — so the two waves cannot drift apart.
//
// Every REJECT case puts its fixtures on DIFFERENT courts and leaves rest at
// zero, so a `window` conflict can never be a mis-labelled court or rest clash.
import { describe, expect, it } from "vitest";
import { validateAssignments, type Assignment } from "./calendar.ts";

const MIN = 60_000;
const at = (iso: string): number => Date.parse(iso);

// 13 fixtures, ids only — the window rule does not care who is playing.
const IDS = [
  "wb-r0-i1",
  "wb-r0-i2",
  "wb-r0-i3",
  "wb-r1-i0",
  "wb-r1-i1",
  "wb-r2-i0",
  "lb-r0-i0",
  "lb-r0-i1",
  "lb-r1-i0",
  "lb-r1-i1",
  "lb-r2-i0",
  "lb-r3-i0",
  "gf",
];

const BASE = {
  matchMinutes: 40,
  gapMinutes: 0,
  perEntrantMinRest: 0,
  blackouts: [] as { from: number; to: number }[],
  sessionWindows: [] as { from: number; to: number }[],
};

/** One fixture per hour from `startIso`, each on its own court so nothing but
 *  the window can fire. */
function board(startIso: string, ids: readonly string[] = IDS): Assignment[] {
  const t0 = at(startIso);
  return ids.map((id, i) => ({
    fixtureId: id,
    court: `Court ${i + 1}`,
    startAt: t0 + i * 60 * MIN,
    endAt: t0 + i * 60 * MIN + 40 * MIN,
    entrants: [],
    people: [],
  }));
}

const WINDOW = {
  from: at("2026-08-01T00:00:00Z"),
  to: at("2026-08-07T23:59:59Z"),
};

describe("pack window (payload A: badminton, 13 fixtures)", () => {
  it("ACCEPTS a board that sits inside the window", () => {
    const conflicts = validateAssignments(board("2026-08-03T10:00:00Z"), {
      ...BASE,
      window: WINDOW,
    });
    expect(conflicts).toEqual([]);
  });

  it("ACCEPTS the board when no window is configured at all", () => {
    // Absent window means unbounded — the pre-W2 behaviour, unchanged, which is
    // why every existing caller keeps working.
    expect(validateAssignments(board("1970-01-01T00:00:00Z"), BASE)).toEqual([]);
  });

  it("REJECTS an epoch draft — every one of the 13 fixtures is out of window", () => {
    // The exact case #397 exists to kill: with no configured startAt the draft
    // was built at the epoch, and 1970 verified clean.
    const conflicts = validateAssignments(board("1970-01-01T00:00:00Z"), {
      ...BASE,
      window: WINDOW,
    });
    expect(conflicts.filter((c) => c.reason === "window")).toHaveLength(13);
    expect(new Set(conflicts.map((c) => c.fixtureId))).toEqual(new Set(IDS));
    expect(conflicts.every((c) => c.reason === "window")).toBe(true);
  });

  it("REJECTS a fixture that starts inside the window but ends after it", () => {
    // The bound is the OCCUPANCY, not the start — a match may not run past the
    // last day of the competition.
    const late: Assignment[] = [
      {
        fixtureId: "gf",
        court: "Court 1",
        startAt: at("2026-08-07T23:40:00Z"),
        endAt: at("2026-08-08T00:20:00Z"),
        entrants: [],
        people: [],
      },
    ];
    const conflicts = validateAssignments(late, { ...BASE, window: WINDOW });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.reason).toBe("window");
    expect(conflicts[0]!.fixtureId).toBe("gf");
  });

  it("REJECTS a single fixture before the window and leaves the rest alone", () => {
    const b = board("2026-08-03T10:00:00Z");
    b[4]!.startAt = at("2026-07-30T10:00:00Z");
    b[4]!.endAt = at("2026-07-30T10:40:00Z");
    const conflicts = validateAssignments(b, { ...BASE, window: WINDOW });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ fixtureId: "wb-r1-i1", reason: "window" });
  });

  it("does not report obstacles — only the assignments under review", () => {
    // `existing` is other divisions' board and outside-the-run bookings. It is
    // court occupancy, not something this run is being asked to fix.
    const conflicts = validateAssignments(
      board("2026-08-03T10:00:00Z", ["gf"]),
      { ...BASE, window: WINDOW },
      board("1970-01-01T00:00:00Z"),
    );
    expect(conflicts.filter((c) => c.reason === "window")).toEqual([]);
  });
});
