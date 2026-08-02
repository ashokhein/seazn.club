// Both-directions proof (#396): once `Assignment.people` is derived from
// `computeParticipants` instead of the named home/away entrants, the person
// rules in `validateAssignments` start firing on TBD bracket slots — and still
// stay quiet on a legal board. Every REJECT case below puts its two fixtures on
// DIFFERENT courts, so a `court` clash can never be mistaken for the proof.
import { describe, expect, it } from "vitest";
import { validateAssignments, type Assignment } from "./calendar";
import { computeParticipants, stripByes, type ParticipantFixture } from "./participants";

const MIN = 60_000;
const at = (iso: string): number => Date.parse(iso);

const fx = (
  id: string,
  home: string | null,
  away: string | null,
  after: string[],
): ParticipantFixture => ({ id, ext_key: id, home, away, feeds: { after } });

// --- payload A: badminton double elimination, single division -------------
const BADMINTON: ParticipantFixture[] = [
  fx("wb-r0-i1", "e", "d", []),
  fx("wb-r0-i2", "c", "f", []),
  fx("wb-r0-i3", "g", "b", []),
  fx("wb-r1-i0", "a", null, ["wb-r0-i1", "BYE-1"]),
  fx("wb-r1-i1", null, null, ["wb-r0-i2", "wb-r0-i3"]),
  fx("wb-r2-i0", null, null, ["wb-r1-i1", "wb-r1-i0"]),
  fx("lb-r0-i0", null, null, ["wb-r0-i1", "BYE-1"]),
  fx("lb-r0-i1", null, null, ["wb-r0-i2", "wb-r0-i3"]),
  fx("lb-r1-i0", null, null, ["wb-r1-i0", "lb-r0-i0"]),
  fx("lb-r1-i1", null, null, ["lb-r0-i1", "wb-r1-i1"]),
  fx("lb-r2-i0", null, null, ["lb-r1-i1", "lb-r1-i0"]),
  fx("lb-r3-i0", null, null, ["wb-r2-i0", "lb-r2-i0"]),
  fx("gf", null, null, ["wb-r2-i0", "lb-r3-i0"]),
];
const SOLO = new Map<string, string[]>(
  ["a", "b", "c", "d", "e", "f", "g"].map((e) => [e, [`p-${e}`]]),
);

// The exact subset `validateAssignments` picks off `SlotConfig`: rest, gap,
// blackouts, session windows, plus optional matchMinutes/constraints. `startAt`
// and `courts` are slotFixtures-only and are NOT accepted here. Empty
// `blackouts` / `sessionWindows` mean unbounded — the verifier skips the
// session check entirely when `sessionWindows.length === 0`, which is what
// makes the ACCEPT cases clean.
const CONFIG = {
  matchMinutes: 40,
  gapMinutes: 0,
  perEntrantMinRest: 0,
  blackouts: [] as { from: number; to: number }[],
  sessionWindows: [] as { from: number; to: number }[],
};

/** Build engine assignments the way the pack does: `people` from participants. */
function assign(
  fixtures: ParticipantFixture[],
  personsByEntrant: Map<string, string[]>,
  slots: [string, string, string][], // [fixtureId, ISO start, court]
  matchMinutes = 40,
): Assignment[] {
  const stripped = stripByes(fixtures).fixtures;
  const participants = computeParticipants(stripped, personsByEntrant);
  const byId = new Map(stripped.map((f) => [f.id, f]));
  return slots.map(([id, iso, court]) => {
    const f = byId.get(id)!;
    const startAt = at(iso);
    return {
      fixtureId: id,
      court,
      startAt,
      endAt: startAt + matchMinutes * MIN,
      entrants: [f.home, f.away].filter((e): e is string => e !== null),
      people: participants[id] ?? [],
    };
  });
}

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
  const STEP: ParticipantFixture[] = [
    fx("sl-g1-d1", "fischer-1", "kasparov-1", []),
    fx("sl-g2-d1", "hou-1", null, ["sl-g1-d1"]),
    fx("sl-g2-d2", "polgar-2", "fischer-2", []),
    fx("sl-g3-d2", "magnus-2", null, ["sl-g2-d2"]),
  ];
  // The same human holds ONE person id here — what W1's name guard produces
  // for the pack, and what a clean database produces on its own.
  const SHARED = new Map<string, string[]>([
    ["fischer-1", ["p-fischer"]],
    ["kasparov-1", ["p-kasparov"]],
    ["hou-1", ["p-hou"]],
    ["polgar-2", ["p-polgar"]],
    ["fischer-2", ["p-fischer"]],
    ["magnus-2", ["p-magnus"]],
  ]);

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
