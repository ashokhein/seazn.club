// The placer must avoid a person double-booking whatever `crossPersonClash`
// says, because the WRITE GATE already refuses one whatever it says.
//
// `assertNoNewBlocking` (apps/web schedule.ts) filters the delta through
// `isBlockingConflict`, which lists `person_overlap` unconditionally — #399
// retired the setting as the switch, and `competition-schedule-apply.test.ts`
// pins that with a clean A/B ("refuses an INTRODUCED person double-booking
// whatever crossPersonClash says").
//
// The gap is narrower than it first looks, and the two cases are worth keeping
// straight:
//
//   draft vs draft      already safe. #463 widened `lastEnd` to namespaced
//                       `person:` keys, so two movable cards sharing a person
//                       serialise through the REST path even at `restF = 0`.
//                       Guarded below so a narrowing of `restKeysOf` is caught.
//   draft vs `existing`  NOT safe. `input.existing` seeds `bookings` and
//                       `dayCounts` and never `lastEnd`, so the rest path is
//                       blind to a person already committed on a sibling
//                       division's fixed board. `personBlocked` was the only
//                       guard, and it was gated on `crossPersonClash === "hard"`.
//
// That second case is exactly what both AI plan paths hit: they load the
// entrant→people map specifically so the block can bite
// (`competition-schedule-ai.ts:442`) and then pin the setting to "warn". Auto
// proposes a board double-booking someone against a fixed card nobody can move,
// Apply 409s, and re-running Auto proposes the same board again — the
// placer/verifier fork, in the one family where the gate is absolute.
import { describe, expect, it } from "vitest";
import {
  slotFixtures,
  validateAssignments,
  type Assignment,
  type SchedulableFixture,
  type SlotConfig,
} from "./calendar.ts";
import { SchedulingConstraints } from "./constraints.ts";

const TZ = "America/Los_Angeles";
const SAT_1000_LOCAL = Date.UTC(2026, 6, 11, 17, 0);
const MIN = 60_000;

const configFor = (clash: "warn" | "hard"): SlotConfig => ({
  startAt: SAT_1000_LOCAL,
  matchMinutes: 30,
  gapMinutes: 0,
  perEntrantMinRest: 0,
  courts: ["C1", "C2"],
  blackouts: [],
  sessionWindows: [],
  tz: TZ,
  horizonMinutes: 60 * 24 * 7,
  constraints: SchedulingConstraints.parse({ crossPersonClash: clash }),
});

// A sibling division's card, already committed: it occupies C1 for the first
// half hour and carries person p1. Deliberately on a DIFFERENT court set entry
// than the one the draft will prefer second, so court occupancy alone can never
// be what moves the draft — only the person can.
const committed = (): Assignment[] => [
  {
    fixtureId: "sib1",
    court: "C1",
    startAt: SAT_1000_LOCAL,
    endAt: SAT_1000_LOCAL + 30 * MIN,
    entrants: ["e7", "e8"],
    people: ["p1"],
    divisionId: "d2",
  },
];

// One movable card sharing p1 with the committed one. Its own entrants are
// disjoint from the sibling's, so no rest or entrant rule can serialise it.
const draft = (): SchedulableFixture[] => [
  { id: "f1", home: "e1", away: "e2", divisionId: "d1", people: ["p1"] },
];

describe("the placer never introduces a person double-booking", () => {
  it.each(["warn", "hard"] as const)(
    "avoids a person already committed on a sibling division's board (crossPersonClash=%s)",
    (clash) => {
      const config = configFor(clash);
      const existing = committed();
      const { assignments, conflicts } = slotFixtures({
        fixtures: draft(),
        config,
        existing,
      });

      // Placed, not refused. C2 is free from the first instant and the horizon
      // is a week, so an unplaced card here would mean the placer
      // over-constrained — and without this line "place nothing" would satisfy
      // every assertion below.
      expect(assignments).toHaveLength(1);
      expect(conflicts.filter((c) => c.reason === "no_slot")).toEqual([]);

      // The placer's own report AND the verifier's, because the fork is exactly
      // a disagreement between the two. Feeding the placer's output back through
      // `validateAssignments` — with the same `existing` the placer saw — is
      // what makes this a parity assertion rather than a restatement of the
      // placer's opinion of itself.
      expect(conflicts.filter((c) => c.reason === "person_overlap")).toEqual([]);
      expect(
        validateAssignments(assignments, config, existing).filter(
          (c) => c.reason === "person_overlap",
        ),
      ).toEqual([]);

      // Named: it moved in TIME, past the committed card, rather than taking the
      // free court alongside it. C2 was available at the first instant, so this
      // is the assertion that would fail if the placer merely dodged the COURT.
      expect(assignments[0]!.startAt).toBeGreaterThanOrEqual(SAT_1000_LOCAL + 30 * MIN);
    },
  );

  it("still packs cards in parallel when they share nobody", () => {
    // The guard that makes the cases above meaningful. Serialising EVERY card
    // would satisfy "no person overlap" trivially and would be a real
    // regression — boards would run days longer for no reason. Same shape, same
    // config, only the shared person removed.
    const config = configFor("warn");
    const existing: Assignment[] = [{ ...committed()[0]!, people: ["p9"] }];
    const { assignments } = slotFixtures({ fixtures: draft(), config, existing });

    expect(assignments).toHaveLength(1);
    expect(assignments[0]!.startAt).toBe(SAT_1000_LOCAL);
    expect(assignments[0]!.court).toBe("C2");
  });

  it("serialises two MOVABLE cards sharing a person, through the rest path (#463)", () => {
    // Already true before this change — `lastEnd` carries `person:` keys — and
    // asserted here so a narrowing of `restKeysOf` cannot quietly re-open the
    // draft-vs-draft half of the same hole.
    const config = configFor("warn");
    const both: SchedulableFixture[] = [
      { id: "f1", home: "e1", away: "e2", divisionId: "d1", people: ["p1"] },
      { id: "f2", home: "e3", away: "e4", divisionId: "d1", people: ["p1"] },
    ];
    const { assignments, conflicts } = slotFixtures({ fixtures: both, config });

    expect(assignments).toHaveLength(2);
    expect(conflicts.filter((c) => c.reason === "person_overlap")).toEqual([]);
    expect(Math.abs(assignments[0]!.startAt - assignments[1]!.startAt)).toBeGreaterThanOrEqual(
      30 * MIN,
    );
  });

  it("names the person when one is why the card could not be placed at all", () => {
    // The cost of avoidance: where a `warn` board used to place the card and
    // report `person_overlap` — which names the human — an unavoidable clash now
    // ends as an unplaced card, and a bare "no court/time within horizon" would
    // lose the one fact the organiser needs to act on.
    //
    // Still `no_slot` and not `person_overlap`: nothing was placed, so no
    // overlap exists on the board, and `person_overlap` is BLOCKING — reporting
    // one for a card the placer declined to place would refuse the organiser's
    // apply over a fixture that is not even on the board.
    // p1 is committed for ten hours while the horizon is one, so EVERY candidate
    // start inside the horizon collides with them. Sized this way on purpose: a
    // sibling that merely ends early is escapable, and the placer escapes it by
    // starting afterwards — which is the behaviour the cases above assert.
    const config: SlotConfig = { ...configFor("warn"), courts: ["C1"], horizonMinutes: 60 };
    const existing: Assignment[] = [
      {
        fixtureId: "sib",
        court: "C9",
        startAt: SAT_1000_LOCAL,
        endAt: SAT_1000_LOCAL + 600 * MIN,
        entrants: ["e7", "e8"],
        people: ["p1"],
        divisionId: "d2",
      },
    ];
    const { assignments, conflicts } = slotFixtures({ fixtures: draft(), config, existing });

    expect(assignments).toEqual([]);
    const unplaceable = conflicts.filter((c) => c.reason === "no_slot");
    expect(unplaceable).toHaveLength(1);
    expect(unplaceable[0]!.detail).toContain("p1");
    expect(unplaceable[0]!.detail).toContain("sib");
    expect(conflicts.some((c) => c.reason === "person_overlap")).toBe(false);
  });

  it("reports — and does not silently drop — an overlap the organiser PINNED", () => {
    // Avoidance is a placement rule, so it can only bind cards the placer is
    // free to move. A locked pair is honoured as pinned and the overlap comes
    // back as a warning, which is the behaviour the write gate's DELTA basis
    // depends on: a board that already carries an overlap must stay applyable.
    const config = configFor("warn");
    const pinned: SchedulableFixture[] = [
      {
        id: "f1",
        home: "e1",
        away: "e2",
        divisionId: "d1",
        people: ["p1"],
        locked: { court: "C1", startAt: SAT_1000_LOCAL },
      },
      {
        id: "f2",
        home: "e3",
        away: "e4",
        divisionId: "d1",
        people: ["p1"],
        locked: { court: "C2", startAt: SAT_1000_LOCAL },
      },
    ];
    const { assignments, conflicts } = slotFixtures({ fixtures: pinned, config });

    expect(assignments).toHaveLength(2);
    expect(conflicts.filter((c) => c.reason === "person_overlap")).not.toEqual([]);
  });
});
