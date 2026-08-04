// The two real payloads this programme is frozen against (#395):
//   A — badminton double elimination, single division, 13 fixtures, 7 entrants.
//   B — Stepladder Showcase, two divisions, one human (Fischer) in both.
//
// Lives outside a `.test.ts` so vitest does not collect it, and so #396's
// participants tests and #398's instruction tests assert against BYTE-IDENTICAL
// inputs — a payload that drifted between waves proves nothing about either.
import type { Assignment, OrderDependency } from "./calendar.ts";
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

// --- payload A, frozen clean placement (#401) ------------------------------
// The repair solver needs a board that is VERIFIER-CLEAN to inject a single
// clash into, and there was none in the repo. Appended rather than woven in:
// the two payloads above are byte-frozen across #395's waves, and a golden that
// drifted would prove nothing about the minimality it is supposed to witness.
//
// Shape: the 13 fixtures in feed order, 40 minutes apart, one court, one day.
// Deliberately the most rigid arrangement that verifies — every fixture is
// pinned between its feeders and its dependents, so "moved exactly one" is a
// statement about the solver and not about slack in the schedule.
// `validateAssignments(goldenBadminton(), cfg, [], badmintonFeedDeps())` is [].
export const GOLDEN_BADMINTON_SLOTS: [string, string, string][] = [
  ["wb-r0-i1", "2026-08-10T09:00:00Z", "C1"],
  ["wb-r0-i2", "2026-08-10T09:40:00Z", "C1"],
  ["wb-r0-i3", "2026-08-10T10:20:00Z", "C1"],
  ["lb-r0-i0", "2026-08-10T11:00:00Z", "C1"],
  ["lb-r0-i1", "2026-08-10T11:40:00Z", "C1"],
  ["wb-r1-i0", "2026-08-10T12:20:00Z", "C1"],
  ["wb-r1-i1", "2026-08-10T13:00:00Z", "C1"],
  ["lb-r1-i0", "2026-08-10T13:40:00Z", "C1"],
  ["lb-r1-i1", "2026-08-10T14:20:00Z", "C1"],
  ["wb-r2-i0", "2026-08-10T15:00:00Z", "C1"],
  ["lb-r2-i0", "2026-08-10T15:40:00Z", "C1"],
  ["lb-r3-i0", "2026-08-10T16:20:00Z", "C1"],
  ["gf", "2026-08-10T17:00:00Z", "C1"],
];

export function goldenBadminton(): Assignment[] {
  return assign(BADMINTON, SOLO, GOLDEN_BADMINTON_SLOTS);
}

/** Payload A's feed edges as `OrderDependency[]`, byes already stripped — the
 *  same list `packFeedDependencies` builds for the real board. Every edge is a
 *  winner feed, so every edge is `direct` and therefore blocking. */
export function badmintonFeedDeps(): OrderDependency[] {
  return stripByes(BADMINTON).fixtures.flatMap((f) =>
    f.feeds.after.map((dependsOn) => ({ fixtureId: f.id, dependsOn, direct: true })),
  );
}

/** Payload B's rule metadata: `winnerTo` by ext_key, and the division each
 *  fixture belongs to. `terminal` is `winnerTo === null`, so this is what makes
 *  "both finals on Friday" addressable at all. */
export const STEP_RULE_FIXTURES = [
  { id: "sl-g1-d1", extKey: "sl-g1-d1", divisionId: "d1", winnerTo: "sl-g2-d1" },
  { id: "sl-g2-d1", extKey: "sl-g2-d1", divisionId: "d1", winnerTo: null },
  { id: "sl-g2-d2", extKey: "sl-g2-d2", divisionId: "d2", winnerTo: "sl-g3-d2" },
  { id: "sl-g3-d2", extKey: "sl-g3-d2", divisionId: "d2", winnerTo: null },
] as const;
