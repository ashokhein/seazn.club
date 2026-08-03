// Both-directions proof (#396): once `Assignment.people` is derived from
// `computeParticipants` instead of the named home/away entrants, the person
// rules in `validateAssignments` start firing on TBD bracket slots — and still
// stay quiet on a legal board. Every REJECT case below puts its two fixtures on
// DIFFERENT courts, so a `court` clash can never be mistaken for the proof.
import { describe, expect, it } from "vitest";
import { validateAssignments, type Assignment } from "./calendar.ts";
import { computeParticipants, stripByes } from "./participants.ts";
import { assign, at, BADMINTON, BASE_CONFIG as CONFIG, SHARED, SOLO, STEP } from "./payload-fixtures.ts";

const MIN = 60_000;

// `person_overlap` is what a simultaneous shared-person pair on different
// courts actually produces: the entrant loop only fires on a SHARED entrant id
// (and `rest` only on a NON-overlapping pair of those), so these fixtures — with
// disjoint or empty entrant lists — can only be caught by the person loop.
// `rest` is counted too so the helper stays honest if rest ever binds.
const personConflicts = (c: readonly { reason: string }[]): number =>
  c.filter((x) => x.reason === "person_overlap" || x.reason === "rest").length;

describe("participants make person rules fire on brackets (payload A: badminton)", () => {
  it("ACCEPTS a legal bracket schedule — one court, one match at a time", () => {
    const slots: [string, string, string][] = [
      ["wb-r0-i1", "2026-08-01T10:00:00Z", "Court 1"],
      ["wb-r0-i2", "2026-08-01T11:00:00Z", "Court 1"],
      ["wb-r0-i3", "2026-08-01T12:00:00Z", "Court 1"],
      ["wb-r1-i0", "2026-08-02T10:00:00Z", "Court 1"],
      ["wb-r1-i1", "2026-08-02T11:00:00Z", "Court 1"],
      ["lb-r0-i0", "2026-08-02T12:00:00Z", "Court 1"],
      ["lb-r0-i1", "2026-08-03T10:00:00Z", "Court 1"],
      ["wb-r2-i0", "2026-08-03T11:00:00Z", "Court 1"],
      ["lb-r1-i0", "2026-08-04T10:00:00Z", "Court 1"],
      ["lb-r1-i1", "2026-08-04T11:00:00Z", "Court 1"],
      ["lb-r2-i0", "2026-08-05T10:00:00Z", "Court 1"],
      ["lb-r3-i0", "2026-08-05T11:00:00Z", "Court 1"],
      ["gf", "2026-08-06T10:00:00Z", "Court 1"],
    ];
    expect(validateAssignments(assign(BADMINTON, SOLO, slots), CONFIG)).toEqual([]);
  });

  it("REJECTS two TBD fixtures that share a possible advancer at the same time", () => {
    // lb-r0-i0 can only hold d or e; wb-r1-i0 can hold a, d or e. Both slots
    // are TBD, so today's named-entrant derivation reports NOTHING here.
    const slots: [string, string, string][] = [
      ["wb-r1-i0", "2026-08-02T10:00:00Z", "Court 1"],
      ["lb-r0-i0", "2026-08-02T10:00:00Z", "Court 2"],
    ];
    const conflicts = validateAssignments(assign(BADMINTON, SOLO, slots), CONFIG);
    expect(personConflicts(conflicts)).toBeGreaterThan(0);
    expect(conflicts.every((c) => c.reason === "person_overlap")).toBe(true);
    expect(conflicts.some((c) => c.fixtureId === "lb-r0-i0")).toBe(true);
  });

  it("REJECTS the grand final overlapping any other fixture — gf can hold anybody", () => {
    const slots: [string, string, string][] = [
      ["gf", "2026-08-06T10:00:00Z", "Court 1"],
      ["wb-r0-i2", "2026-08-06T10:00:00Z", "Court 2"],
    ];
    const conflicts = validateAssignments(assign(BADMINTON, SOLO, slots), CONFIG);
    expect(personConflicts(conflicts)).toBeGreaterThan(0);
    expect(conflicts.every((c) => c.reason === "person_overlap")).toBe(true);
  });

  it("does NOT reject two TBD fixtures whose advancer sets are disjoint", () => {
    // lb-r0-i0 ⊆ {d,e}; lb-r0-i1 ⊆ {b,c,f,g}. Simultaneous, different courts.
    const slots: [string, string, string][] = [
      ["lb-r0-i0", "2026-08-02T10:00:00Z", "Court 1"],
      ["lb-r0-i1", "2026-08-02T10:00:00Z", "Court 2"],
    ];
    expect(validateAssignments(assign(BADMINTON, SOLO, slots), CONFIG)).toEqual([]);
  });

  it("named-entrant derivation is what regresses: same board, people from named slots only", () => {
    // Guard that the rejection case above is genuinely new capability.
    const stripped = stripByes(BADMINTON).fixtures;
    const byId = new Map(stripped.map((f) => [f.id, f]));
    const naive: Assignment[] = (
      [
        ["wb-r1-i0", "2026-08-02T10:00:00Z", "Court 1"],
        ["lb-r0-i0", "2026-08-02T10:00:00Z", "Court 2"],
      ] as [string, string, string][]
    ).map(([id, iso, court]) => {
      const f = byId.get(id)!;
      const entrants = [f.home, f.away].filter((e): e is string => e !== null);
      const startAt = at(iso);
      return {
        fixtureId: id,
        court,
        startAt,
        endAt: startAt + 40 * MIN,
        entrants,
        people: entrants.flatMap((e) => SOLO.get(e) ?? []),
      };
    });
    expect(validateAssignments(naive, CONFIG)).toEqual([]); // the bug, pinned
  });
});

// --- payload B: Stepladder Showcase, two divisions, one shared human -------
describe("participants across divisions (payload B: Stepladder Showcase)", () => {
  it("participants(sl-g2-d1) = {fischer, hou, kasparov} via advancer recursion", () => {
    const p = computeParticipants(stripByes(STEP).fixtures, SHARED);
    expect(p["sl-g2-d1"]).toEqual(["p-fischer", "p-hou", "p-kasparov"]);
  });

  it("REJECTS the cross-division Fischer clash on a TBD fixture", () => {
    const slots: [string, string, string][] = [
      ["sl-g2-d1", "2026-07-24T10:00:00Z", "Court 1"],
      ["sl-g2-d2", "2026-07-24T10:00:00Z", "Court 2"],
    ];
    const conflicts = validateAssignments(assign(STEP, SHARED, slots, 30), {
      ...CONFIG,
      matchMinutes: 30,
    });
    expect(personConflicts(conflicts)).toBeGreaterThan(0);
    expect(conflicts.every((c) => c.reason === "person_overlap")).toBe(true);
    expect(conflicts.some((c) => c.detail === "person p-fischer overlap")).toBe(true);
  });

  it("ACCEPTS the same pair once they are far enough apart", () => {
    const slots: [string, string, string][] = [
      ["sl-g2-d1", "2026-07-24T10:00:00Z", "Court 1"],
      ["sl-g2-d2", "2026-07-24T14:00:00Z", "Court 2"],
    ];
    expect(
      validateAssignments(assign(STEP, SHARED, slots, 30), { ...CONFIG, matchMinutes: 30 }),
    ).toEqual([]);
  });
});
