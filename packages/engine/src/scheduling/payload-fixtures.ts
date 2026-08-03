// The two real payloads this programme is frozen against (#395):
//   A — badminton double elimination, single division, 13 fixtures, 7 entrants.
//   B — Stepladder Showcase, two divisions, one human (Fischer) in both.
//
// Lives outside a `.test.ts` so vitest does not collect it, and so #396's
// participants tests and #398's instruction tests assert against BYTE-IDENTICAL
// inputs — a payload that drifted between waves proves nothing about either.
import type { Assignment } from "./calendar.ts";
import { computeParticipants, stripByes, type ParticipantFixture } from "./participants.ts";

const MIN = 60_000;
export const at = (iso: string): number => Date.parse(iso);

const fx = (
  id: string,
  home: string | null,
  away: string | null,
  after: string[],
): ParticipantFixture => ({ id, ext_key: id, home, away, feeds: { after } });

// --- payload A: badminton double elimination, single division -------------
export const BADMINTON: ParticipantFixture[] = [
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
export const SOLO = new Map<string, string[]>(
  ["a", "b", "c", "d", "e", "f", "g"].map((e) => [e, [`p-${e}`]]),
);

// The exact subset `validateAssignments` picks off `SlotConfig`: rest, gap,
// blackouts, session windows, plus optional matchMinutes/constraints. `startAt`
// and `courts` are slotFixtures-only and are NOT accepted here. Empty
// `blackouts` / `sessionWindows` mean unbounded — the verifier skips the
// session check entirely when `sessionWindows.length === 0`, which is what
// makes the ACCEPT cases clean.
export const BASE_CONFIG = {
  matchMinutes: 40,
  gapMinutes: 0,
  perEntrantMinRest: 0,
  blackouts: [] as { from: number; to: number }[],
  sessionWindows: [] as { from: number; to: number }[],
};

/** Build engine assignments the way the pack does: `people` from participants. */
export function assign(
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

// --- payload B: Stepladder Showcase, two divisions, one shared human -------
export const STEP: ParticipantFixture[] = [
  fx("sl-g1-d1", "fischer-1", "kasparov-1", []),
  fx("sl-g2-d1", "hou-1", null, ["sl-g1-d1"]),
  fx("sl-g2-d2", "polgar-2", "fischer-2", []),
  fx("sl-g3-d2", "magnus-2", null, ["sl-g2-d2"]),
];
// The same human holds ONE person id here — what W1's name guard produces
// for the pack, and what a clean database produces on its own.
export const SHARED = new Map<string, string[]>([
  ["fischer-1", ["p-fischer"]],
  ["kasparov-1", ["p-kasparov"]],
  ["hou-1", ["p-hou"]],
  ["polgar-2", ["p-polgar"]],
  ["fischer-2", ["p-fischer"]],
  ["magnus-2", ["p-magnus"]],
]);
