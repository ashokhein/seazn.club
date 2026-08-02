// #350 Task 3 — the JOINT VERIFIER. Pure: hand-built CompetitionPack fixtures,
// no DB, no SDK, no network.
//
// What is under test is one design decision. `validateAssignments` takes ONE
// scalar config — one matchMinutes, one gapMinutes, one blackouts[], one
// sessionWindows[] — and divisions legitimately differ on every one of them.
// Merging them into a "strictest" config would silently apply division A's
// session window to division B's fixtures, so `verifyJoint` instead runs one
// pass PER DIVISION with that division's own config, handing the other
// divisions' proposed slots in as `existing`. Every test below that names two
// divisions with different settings is a guard on that: a merged-config
// implementation gives a visibly different answer to each of them.
//
// NEUTRALISATION IS DELIBERATE. `validateAssignments` reports court, rest,
// blackout, session-window, person and order conflicts from one call, so an
// assertion that only counts conflicts proves nothing about WHICH rule fired.
// Every seed here therefore zeroes the constraints it is not testing — the
// cross-person test puts its two fixtures on DIFFERENT courts with zero rest
// and no blackouts, so the only thing that can produce its conflict is the
// person check.
import { describe, expect, it } from "vitest";
import {
  jointFeedDependencies,
  jointStructuralCheck,
  partitionConflicts,
  toJointEngineAssignments,
  toJointObstacleAssignments,
  verifyConfigFor,
  verifyJoint,
  type CompetitionPack,
  type CompetitionPackDivision,
  type CompetitionPackFixture,
  type CompetitionPackObstacle,
} from "../competition-schedule-ai";
import { isBlocking, planIsAcceptable, type PackConstraints, type PackSettings } from "../schedule-ai";
import type { AiSchedulePlan } from "../schedule-ai-prompt";

// --- Fixed ids -------------------------------------------------------------
const D1 = "d1111111-1111-4111-8111-111111111111"; // "Alpha"
const D2 = "d2222222-2222-4222-8222-222222222222"; // "Beta"
const D_ABSENT = "d9999999-9999-4999-8999-999999999999"; // never in pack.divisions
const FOREIGN = "ffffffff-ffff-4fff-8fff-ffffffffffff"; // never in pack.fixtures.movable
const F1 = "11111111-1111-4111-8111-111111111111";
const F2 = "22222222-2222-4222-8222-222222222222";
const F3 = "33333333-3333-4333-8333-333333333333";
const E1 = "e1111111-1111-4111-8111-111111111111";
const E2 = "e2222222-2222-4222-8222-222222222222";
const E3 = "e3333333-3333-4333-8333-333333333333";
const E4 = "e4444444-4444-4444-8444-444444444444";
const E5 = "e5555555-5555-4555-8555-555555555555";
const E6 = "e6666666-6666-4666-8666-666666666666";
const PERSON = "9a999999-9999-4999-8999-999999999999";

const at = (hhmm: string): string => `2026-08-01T${hhmm}:00+01:00`;

// A fully neutral settings block: nothing here can produce a conflict on its
// own. Each test switches on exactly the one field it is about.
function settings(over: Partial<PackSettings> = {}): PackSettings {
  return {
    matchMinutes: 30,
    gapMinutes: 0,
    perEntrantMinRest: 0,
    courts: ["Court 1"],
    sessionWindows: [],
    blackouts: [],
    constraints: null,
    ...over,
  };
}

function constraints(over: Partial<PackConstraints> = {}): PackConstraints {
  return {
    noBackToBack: false,
    startWindows: [],
    fieldFairness: "off",
    parallelism: "mixed",
    crossPersonClash: "warn",
    ...over,
  };
}

function division(
  id: string,
  name: string,
  over: Partial<Omit<CompetitionPackDivision, "id" | "name">> = {},
): CompetitionPackDivision {
  return {
    id,
    name,
    sport: "generic",
    tz: "Europe/London",
    settings: settings(),
    movableIds: [],
    draftPlaced: 0,
    ...over,
  };
}

function fixture(
  id: string,
  division_id: string,
  over: Partial<CompetitionPackFixture> = {},
): CompetitionPackFixture {
  return {
    id,
    division_id,
    ext_key: null,
    round: 1,
    seq: 0,
    pool: null,
    home: null,
    away: null,
    feeds: { winner_to: null, after: [] },
    current: { at: null, court: null },
    pinned: false,
    ...over,
  };
}

function pack(
  divisions: CompetitionPackDivision[],
  movable: CompetitionPackFixture[],
  over: Partial<CompetitionPack> = {},
): CompetitionPack {
  const courts = [...new Set(divisions.flatMap((d) => d.settings.courts))].sort();
  const people = over.people ?? [];
  // These are hand-built packs, so they get the participants a NAMED-slot board
  // would have: the persons of the named home/away entrants. That keeps every
  // pre-existing case in this file meaning what it meant before #396 added the
  // field. It deliberately does NOT model the advancer recursion — a hand-built
  // map would prove only that the helper computed it. The recursion is proved
  // against real `buildCompetitionPack` output in
  // competition-schedule-participants-wiring.test.ts.
  const personsByEntrant = new Map<string, string[]>();
  for (const p of people) {
    for (const e of p.entrant_ids) {
      (personsByEntrant.get(e) ?? personsByEntrant.set(e, []).get(e)!).push(p.person_id);
    }
  }
  const participants: Record<string, string[]> = {};
  for (const f of movable) {
    participants[f.id] = [
      ...new Set(
        [f.home, f.away]
          .filter((e): e is string => e !== null)
          .flatMap((e) => personsByEntrant.get(e) ?? []),
      ),
    ];
  }
  return {
    mode: "generate",
    competition: { id: "c1", name: "Summer Open" },
    divisions: divisions.map((d) => ({
      ...d,
      movableIds: movable.filter((f) => f.division_id === d.id).map((f) => f.id),
    })),
    courts,
    divergentCourts: courts.filter((c) => !divisions.every((d) => d.settings.courts.includes(c))),
    entrants: [],
    people,
    participants,
    assumptions: [],
    fixtures: { movable, obstacles: [] },
    draft: [],
    instruction: "Finish by 6pm.",
    prior: null,
    ...over,
  };
}

const assign = (fixture_id: string, scheduled_at: string, court_label: string) => ({
  fixture_id,
  scheduled_at,
  court_label,
});

function plan(
  assignments: ReturnType<typeof assign>[],
  unschedulable: { fixture_id: string; reason: string }[] = [],
): AiSchedulePlan {
  return { assignments, unschedulable, explanations: [], summary: "ok" };
}

// ===========================================================================
// verifyJoint — the whole board, each division's own rules
// ===========================================================================

describe("verifyJoint — cross-division occupancy (#350)", () => {
  it("a cross-division court clash is reported for BOTH fixtures", () => {
    // Both divisions own "Court 1", both fixtures sit on it at the same instant.
    // Nothing else can fire: no shared entrants, no people, no blackouts, no
    // windows, zero rest and zero gap.
    const p = pack(
      [division(D1, "Alpha"), division(D2, "Beta")],
      [
        fixture(F1, D1, { home: E1, away: E2 }),
        fixture(F2, D2, { home: E3, away: E4 }),
      ],
    );
    const out = verifyJoint(
      plan([assign(F1, at("09:00"), "Court 1"), assign(F2, at("09:00"), "Court 1")]),
      p,
    );
    expect(out.map((c) => c.reason)).toEqual(["court", "court"]);
    expect(new Set(out.map((c) => c.fixtureId))).toEqual(new Set([F1, F2]));
  });

  it("divisions on different courts at the same time are clean", () => {
    const p = pack(
      [
        division(D1, "Alpha", { settings: settings({ courts: ["Court 1", "Court 2"] }) }),
        division(D2, "Beta", { settings: settings({ courts: ["Court 1", "Court 2"] }) }),
      ],
      [
        fixture(F1, D1, { home: E1, away: E2 }),
        fixture(F2, D2, { home: E3, away: E4 }),
      ],
    );
    expect(
      verifyJoint(
        plan([assign(F1, at("09:00"), "Court 1"), assign(F2, at("09:00"), "Court 2")]),
        p,
      ),
    ).toEqual([]);
  });

  it("an obstacle holds its court against every division's fixtures", () => {
    // The complementary direction to "cross-division slots are visible": the
    // OBSTACLES half of `existing`. Obstacles are the selected divisions' own
    // immovable fixtures plus every out-of-run division's placements — real,
    // already-scheduled things nobody in this run can move. Drop them and the
    // verifier reports a clean board while the model has double-booked a court
    // against a fixture that is actually happening.
    //
    // One obstacle per arm of toJointObstacleAssignments: an in-run one
    // (division_id set) against Alpha, a foreign one (division_id null) against
    // Beta. The two fixtures sit on DIFFERENT courts, so a cross-division clash
    // cannot produce either conflict.
    const obstacles: CompetitionPackObstacle[] = [
      { court: "Court 1", from: at("09:00"), to: at("09:30"), label: "Alpha R1", division_id: D1 },
      { court: "Court 2", from: at("09:00"), to: at("09:30"), label: "Other division", division_id: null },
    ];
    const movable = [
      fixture(F1, D1, { home: E1, away: E2 }),
      fixture(F2, D2, { home: E3, away: E4 }),
    ];
    const p = pack(
      [
        division(D1, "Alpha", { settings: settings({ courts: ["Court 1"] }) }),
        division(D2, "Beta", { settings: settings({ courts: ["Court 2"] }) }),
      ],
      movable,
      { fixtures: { movable, obstacles } },
    );
    const out = verifyJoint(
      plan([assign(F1, at("09:00"), "Court 1"), assign(F2, at("09:00"), "Court 2")]),
      p,
    );
    expect(out.map((c) => c.reason)).toEqual(["court", "court"]);
    expect(new Set(out.map((c) => c.fixtureId))).toEqual(new Set([F1, F2]));
  });

  it("each division's own matchMinutes decides its fixture's end", () => {
    // Alpha sorts first, so an implementation that reads ONE matchMinutes off
    // the pack reads 30 — under which Beta's 09:00 and 10:00 fixtures do not
    // touch and the board is clean. Beta's own 90 makes them overlap. The
    // clash being REPORTED is what proves the duration is resolved per fixture.
    const p = pack(
      [
        division(D1, "Alpha", { settings: settings({ matchMinutes: 30, courts: ["Court 1"] }) }),
        division(D2, "Beta", { settings: settings({ matchMinutes: 90, courts: ["Court 2"] }) }),
      ],
      [
        fixture(F1, D1, { home: E1, away: E2 }),
        fixture(F2, D2, { home: E3, away: E4 }),
        fixture(F3, D2, { seq: 1, home: E3, away: E4 }),
      ],
    );
    const out = verifyJoint(
      plan([
        assign(F1, at("09:00"), "Court 1"),
        assign(F2, at("09:00"), "Court 2"),
        assign(F3, at("10:00"), "Court 2"),
      ]),
      p,
    );
    expect(out.filter((c) => c.reason === "court").map((c) => c.fixtureId).sort()).toEqual(
      [F2, F3].sort(),
    );
    expect(out.some((c) => c.fixtureId === F1)).toBe(false);
  });

  it("a division's session window is not applied to another division's fixtures", () => {
    // Merge the two windows any way you like and this test fails: their union
    // clears BOTH fixtures, their intersection is empty and rejects both.
    const p = pack(
      [
        division(D1, "Alpha", {
          settings: settings({
            courts: ["Court 1"],
            sessionWindows: [{ from: at("09:00"), to: at("12:00") }],
          }),
        }),
        division(D2, "Beta", {
          settings: settings({
            courts: ["Court 2"],
            sessionWindows: [{ from: at("14:00"), to: at("18:00") }],
          }),
        }),
      ],
      [
        fixture(F1, D1, { home: E1, away: E2 }),
        fixture(F2, D2, { home: E3, away: E4 }),
      ],
    );
    const out = verifyJoint(
      plan([assign(F1, at("15:00"), "Court 1"), assign(F2, at("15:00"), "Court 2")]),
      p,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.fixtureId).toBe(F1);
    expect(out[0]!.reason).toBe("blackout");
    expect(out[0]!.detail).toContain("session windows");
  });

  it("a division's blackout does not blackout another division", () => {
    // Alpha's blackout is court-less — the widest kind there is — so if configs
    // were merged it would swallow Beta's fixture too.
    const p = pack(
      [
        division(D1, "Alpha", {
          settings: settings({
            courts: ["Court 1"],
            blackouts: [{ from: at("10:00"), to: at("11:00") }],
          }),
        }),
        division(D2, "Beta", { settings: settings({ courts: ["Court 2"] }) }),
      ],
      [
        fixture(F1, D1, { home: E1, away: E2 }),
        fixture(F2, D2, { home: E3, away: E4 }),
      ],
    );
    const out = verifyJoint(
      plan([assign(F1, at("10:00"), "Court 1"), assign(F2, at("10:00"), "Court 2")]),
      p,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.fixtureId).toBe(F1);
    expect(out[0]!.reason).toBe("blackout");
  });

  it("duplicate conflicts across per-division passes are reported once", () => {
    // A feed-order violation inside Alpha is genuinely produced TWICE: the
    // dependency loop in validateAssignments resolves its ids against the whole
    // board, not just the pass's own assignments, so Beta's pass re-reports
    // Alpha's violation verbatim. One conflict, not two.
    const p = pack(
      [
        division(D1, "Alpha", { settings: settings({ courts: ["Court 1", "Court 2"] }) }),
        division(D2, "Beta", { settings: settings({ courts: ["Court 3"] }) }),
      ],
      [
        fixture(F1, D1, { home: E1, away: E2 }),
        fixture(F2, D1, { seq: 1, home: E3, away: E4, feeds: { winner_to: null, after: [F1] } }),
        fixture(F3, D2, { home: E3, away: E4 }),
      ],
    );
    const out = verifyJoint(
      plan([
        assign(F1, at("10:00"), "Court 1"),
        assign(F2, at("09:00"), "Court 2"),
        assign(F3, at("09:00"), "Court 3"),
      ]),
      p,
    );
    expect(out.filter((c) => c.reason === "order")).toHaveLength(1);
    expect(out.find((c) => c.reason === "order")?.fixtureId).toBe(F2);
  });

  // --- The three cases ruling R9 hands to this task ------------------------

  it("a person shared across two divisions' entrants is caught as an overlap", () => {
    // The one that only the JOINT board can see. Each division's own pack keeps
    // a person only when they appear in >= 2 of THAT division's entrants, so
    // someone in one entrant of Alpha and one of Beta is in neither source map.
    // buildCompetitionPack rebuilds `people` over the run's whole entrant set;
    // this is the check that consumes it.
    //
    // Different courts, zero gap, zero rest, no blackouts and no windows — so a
    // court clash cannot produce the same pass and the assertion is the person
    // check or nothing.
    const p = pack(
      [
        division(D1, "Alpha", { settings: settings({ courts: ["Court 1"] }) }),
        division(D2, "Beta", { settings: settings({ courts: ["Court 2"] }) }),
      ],
      [
        fixture(F1, D1, { home: E1, away: E2 }),
        fixture(F2, D2, { home: E3, away: E4 }),
      ],
      { people: [{ person_id: PERSON, entrant_ids: [E1, E3] }] },
    );
    const out = verifyJoint(
      plan([assign(F1, at("09:00"), "Court 1"), assign(F2, at("09:00"), "Court 2")]),
      p,
    );
    expect(out.map((c) => c.reason)).toEqual(["person_overlap", "person_overlap"]);
    expect(new Set(out.map((c) => c.fixtureId))).toEqual(new Set([F1, F2]));
    expect(out.every((c) => c.detail?.includes(PERSON))).toBe(true);
  });

  it("a division's parallelism:'block' never reaches the verifier, so the draft's asymmetry cannot become a verification asymmetry", () => {
    // parallelism:"block" is a PLACER rule (slotFixtures), and the joint draft
    // feeds it asymmetrically: a division refuses to overlap the divisions
    // drafted BEFORE it and never the ones drafted after. If the verifier
    // honoured it, that asymmetry would become a verdict — Alpha's plan
    // rejected for overlapping Beta while Beta's identical overlap passed.
    // verifyConfigFor pins parallelism to "mixed" for every division exactly so
    // that cannot happen. Both halves are asserted: the config, and the verdict.
    const alpha = division(D1, "Alpha", {
      settings: settings({ courts: ["Court 1"], constraints: constraints({ parallelism: "block" }) }),
    });
    const beta = division(D2, "Beta", {
      settings: settings({ courts: ["Court 2"], constraints: constraints() }),
    });
    expect(verifyConfigFor(alpha).constraints?.parallelism).toBe("mixed");

    const p = pack(
      [alpha, beta],
      [
        fixture(F1, D1, { home: E1, away: E2 }),
        fixture(F2, D2, { home: E3, away: E4 }),
      ],
    );
    expect(
      verifyJoint(
        plan([assign(F1, at("09:00"), "Court 1"), assign(F2, at("09:00"), "Court 2")]),
        p,
      ),
    ).toEqual([]);
  });

  it("verifyJoint may legitimately reject a draft it was handed", () => {
    // Cross-division gap is charged at the DRAFTING division's gapMinutes: Beta
    // drafts with gapMinutes 0 and butts its fixture straight onto the end of
    // Alpha's, which is legal to Beta. Alpha's own gapMinutes is 30, and
    // verifyJoint runs Alpha's pass with Alpha's config over the shared court —
    // so the draft it was handed is rejected. That is correct, not a bug; the
    // test exists so a later change cannot quietly make the verifier agree.
    //
    // Exactly one conflict, on ALPHA's fixture, is the whole point: a shared or
    // strictest-wins gap would report Beta's too.
    const p = pack(
      [
        division(D1, "Alpha", { settings: settings({ gapMinutes: 30, courts: ["Court 1"] }) }),
        division(D2, "Beta", { settings: settings({ gapMinutes: 0, courts: ["Court 1"] }) }),
      ],
      [
        fixture(F1, D1, { home: E1, away: E2 }),
        fixture(F2, D2, { home: E3, away: E4 }),
      ],
    );
    const out = verifyJoint(
      plan([assign(F1, at("09:00"), "Court 1"), assign(F2, at("09:30"), "Court 1")]),
      p,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.fixtureId).toBe(F1);
    expect(out[0]!.reason).toBe("court");
  });

  it("reports conflicts in domain order — division, then round, then seq — never by fixture UUID", () => {
    // The determinism contract (schedule-ai.ts:1-12) forbids ordering on a UUID.
    // The seed is chosen so the two orders DISAGREE: sorted as strings the ids
    // come out F1 < F2 < F3, but F1 belongs to Beta and F3 is Alpha's round 2.
    // Domain order groups the report by division and then by playing order,
    // which is also how the model reads it back on a repair round.
    const p = pack(
      [
        division(D1, "Alpha", { settings: settings({ courts: ["Court 1"] }) }),
        division(D2, "Beta", { settings: settings({ courts: ["Court 1"] }) }),
      ],
      [
        // Six distinct entrants: a shared one would add rest/overlap conflicts
        // and the assertion would stop being purely about ordering.
        fixture(F3, D1, { round: 2, seq: 0, home: E1, away: E2 }),
        fixture(F2, D1, { round: 1, seq: 0, home: E3, away: E4 }),
        fixture(F1, D2, { round: 1, seq: 0, home: E5, away: E6 }),
      ],
    );
    const out = verifyJoint(
      plan([
        assign(F1, at("09:00"), "Court 1"),
        assign(F2, at("09:00"), "Court 1"),
        assign(F3, at("09:00"), "Court 1"),
      ]),
      p,
    );
    expect(out.map((c) => c.reason)).toEqual(["court", "court", "court"]);
    expect(out.map((c) => c.fixtureId)).toEqual([F2, F3, F1]);
    // Guard against the assertion being satisfied by accident: string order is
    // genuinely different.
    expect([F2, F3, F1].slice().sort()).not.toEqual([F2, F3, F1]);
  });
});

// ===========================================================================
// The unresolvable-assignment invariant (fail loudly, never default)
// ===========================================================================

describe("verifyJoint refuses what it cannot attribute (#350)", () => {
  const p = pack(
    [
      division(D1, "Alpha", { settings: settings({ courts: ["Court 1"] }) }),
      division(D2, "Beta", { settings: settings({ courts: ["Court 2"] }) }),
    ],
    [fixture(F1, D1, { home: E1, away: E2 }), fixture(F2, D2, { home: E3, away: E4 })],
  );

  // Why a throw and not a default: an assignment with no resolvable division
  // matches NO division's `mine` filter, so it is verified by nobody — while
  // still being injected into every other pass's `existing` as a phantom
  // zero-duration court booking. Silently wrong, and wrong in the direction that
  // looks clean.
  it("throws on an assignment naming a fixture outside the pack", () => {
    expect(() =>
      verifyJoint(
        plan([
          assign(F1, at("09:00"), "Court 1"),
          assign(FOREIGN, at("09:00"), "Court 2"),
        ]),
        p,
      ),
    ).toThrow(/outside the pack/);
  });

  it("throws on a fixture whose division is not in the run", () => {
    const orphaned = pack(
      [
        division(D1, "Alpha", { settings: settings({ courts: ["Court 1"] }) }),
        division(D2, "Beta", { settings: settings({ courts: ["Court 2"] }) }),
      ],
      [fixture(F1, D1, { home: E1, away: E2 }), fixture(F2, D_ABSENT, { home: E3, away: E4 })],
    );
    expect(() =>
      verifyJoint(
        plan([assign(F1, at("09:00"), "Court 1"), assign(F2, at("09:00"), "Court 2")]),
        orphaned,
      ),
    ).toThrow(/not in this run/);
  });

  it("carries a greppable code so a caller with client-supplied ids can translate it", () => {
    const err = (() => {
      try {
        verifyJoint(plan([assign(FOREIGN, at("09:00"), "Court 1")]), p);
      } catch (e) {
        return e as { code?: string };
      }
      return null;
    })();
    expect(err?.code).toBe("AI_PLAN_INVALID_ASSIGNMENT");
  });
});

// ===========================================================================
// jointStructuralCheck — the court check is PER DIVISION
// ===========================================================================

describe("jointStructuralCheck (#350)", () => {
  const p = pack(
    [
      division(D1, "Alpha", { settings: settings({ courts: ["Court 1"] }) }),
      division(D2, "Beta", { settings: settings({ courts: ["Court 3"] }) }),
    ],
    [fixture(F1, D1, { home: E1, away: E2 }), fixture(F2, D2, { home: E3, away: E4 })],
  );
  const movableIds = new Set([F1, F2]);

  it("rejects a fixture placed on a court its own division does not have", () => {
    // "Court 3" IS in the union (pack.courts), so a check against the union
    // passes it. Alpha does not have it.
    expect(p.courts).toContain("Court 3");
    const err = jointStructuralCheck(
      plan([assign(F1, at("09:00"), "Court 3"), assign(F2, at("09:00"), "Court 3")]),
      movableIds,
      p,
    );
    expect(err).toContain(F1);
    expect(err).toContain("Court 3");
  });

  it("accepts a fixture on a court its own division has", () => {
    expect(
      jointStructuralCheck(
        plan([assign(F1, at("09:00"), "Court 1"), assign(F2, at("09:00"), "Court 3")]),
        movableIds,
        p,
      ),
    ).toBeNull();
  });

  it("still enforces the single-division accounting rules across the union", () => {
    // Every movable fixture of every division exactly once — a missing one is
    // an error even though its own division's slice of the plan is complete.
    expect(jointStructuralCheck(plan([assign(F1, at("09:00"), "Court 1")]), movableIds, p)).toContain(
      F2,
    );
  });

  // The remaining return paths. These are verbatim copies of logic tested in
  // schedule-ai.ts's own suite, and a COPY DOES NOT INHERIT COVERAGE: deleting
  // any one of these branches here left the whole joint suite green.

  it("rejects an assignment naming a fixture that is not movable", () => {
    expect(
      jointStructuralCheck(
        plan([
          assign(F1, at("09:00"), "Court 1"),
          assign(F2, at("09:00"), "Court 3"),
          assign(FOREIGN, at("09:00"), "Court 1"),
        ]),
        movableIds,
        p,
      ),
    ).toContain(`non-movable fixture ${FOREIGN}`);
  });

  it("rejects the same fixture assigned twice", () => {
    expect(
      jointStructuralCheck(
        plan([assign(F1, at("09:00"), "Court 1"), assign(F1, at("10:00"), "Court 1")]),
        movableIds,
        p,
      ),
    ).toContain("appears more than once");
  });

  it("rejects a movable fixture whose division is not in the run", () => {
    // Not reachable from a model — the pack builder tags every fixture from a
    // selected division. Reachable from a CALLER that hands verifyJoint a pack
    // it assembled itself, which is what the apply path will do.
    const orphaned = pack(
      [
        division(D1, "Alpha", { settings: settings({ courts: ["Court 1"] }) }),
        division(D2, "Beta", { settings: settings({ courts: ["Court 3"] }) }),
      ],
      [fixture(F1, D_ABSENT, { home: E1, away: E2 })],
    );
    expect(
      jointStructuralCheck(plan([assign(F1, at("09:00"), "Court 1")]), new Set([F1]), orphaned),
    ).toContain("no division");
  });

  it("rejects an unschedulable entry naming a fixture that is not movable", () => {
    expect(
      jointStructuralCheck(
        plan(
          [assign(F1, at("09:00"), "Court 1"), assign(F2, at("09:00"), "Court 3")],
          [{ fixture_id: FOREIGN, reason: "H2" }],
        ),
        movableIds,
        p,
      ),
    ).toContain(`non-movable fixture ${FOREIGN}`);
  });

  it("rejects a fixture that is both assigned and marked unschedulable", () => {
    expect(
      jointStructuralCheck(
        plan(
          [assign(F1, at("09:00"), "Court 1"), assign(F2, at("09:00"), "Court 3")],
          [{ fixture_id: F1, reason: "H2" }],
        ),
        movableIds,
        p,
      ),
    ).toContain("appears more than once");
  });

  // Pinned = schedule-locked. Two reachable branches; the third (`must stay at
  // its current slot`) is unreachable by construction and marked so in the
  // implementation — a pinned id absent from both lists is caught by "is missing
  // from the plan", and a pinned id in `unschedulable` by the branch below.
  const pinnedPack = () => {
    const movable = [
      fixture(F1, D1, {
        home: E1,
        away: E2,
        pinned: true,
        current: { at: at("09:00"), court: "Court 1" },
      }),
      fixture(F2, D2, { home: E3, away: E4 }),
    ];
    return pack(
      [
        division(D1, "Alpha", { settings: settings({ courts: ["Court 1", "Court 2"] }) }),
        division(D2, "Beta", { settings: settings({ courts: ["Court 3"] }) }),
      ],
      movable,
    );
  };

  it("rejects a pinned fixture nudged off its current slot", () => {
    const pp = pinnedPack();
    // Moved in time…
    expect(
      jointStructuralCheck(
        plan([assign(F1, at("10:00"), "Court 1"), assign(F2, at("09:00"), "Court 3")]),
        movableIds,
        pp,
      ),
    ).toContain("must not move");
    // …and moved across courts, which the time check alone would wave through.
    expect(
      jointStructuralCheck(
        plan([assign(F1, at("09:00"), "Court 2"), assign(F2, at("09:00"), "Court 3")]),
        movableIds,
        pp,
      ),
    ).toContain("must not move");
    // Left exactly where it is → clean.
    expect(
      jointStructuralCheck(
        plan([assign(F1, at("09:00"), "Court 1"), assign(F2, at("09:00"), "Court 3")]),
        movableIds,
        pp,
      ),
    ).toBeNull();
  });

  it("rejects a pinned fixture marked unschedulable", () => {
    // Dropping a schedule-locked fixture silently loses a slot the organiser
    // deliberately froze, so it must fail before verification rather than show
    // up as an absence in the diff.
    expect(
      jointStructuralCheck(
        plan([assign(F2, at("09:00"), "Court 3")], [{ fixture_id: F1, reason: "H2" }]),
        movableIds,
        pinnedPack(),
      ),
    ).toContain("cannot be marked unschedulable");
  });
});

// ===========================================================================
// Engine-assignment mapping
// ===========================================================================

describe("joint engine assignments (#350)", () => {
  it("obstacle ids are unique across the union", () => {
    const obstacles: CompetitionPackObstacle[] = [
      { court: "Court 1", from: at("08:00"), to: at("08:30"), label: "Alpha R1", division_id: D1 },
      { court: "Court 1", from: at("08:30"), to: at("09:00"), label: "Alpha R2", division_id: D1 },
      { court: "Court 2", from: at("08:00"), to: at("08:30"), label: "Beta R1", division_id: D2 },
      { court: "Court 2", from: at("08:30"), to: at("09:00"), label: "Beta R2", division_id: D2 },
      { court: "Court 3", from: at("08:00"), to: at("08:30"), label: "Other division", division_id: null },
      { court: "Court 3", from: at("08:30"), to: at("09:00"), label: "Other division", division_id: null },
    ];
    const p = pack([division(D1, "Alpha"), division(D2, "Beta")], [], {
      fixtures: { movable: [], obstacles },
    });
    const out = toJointObstacleAssignments(p);
    expect(out).toHaveLength(obstacles.length);
    expect(new Set(out.map((a) => a.fixtureId)).size).toBe(obstacles.length);
  });

  it("stamps every assignment with its own division and duration", () => {
    const p = pack(
      [
        division(D1, "Alpha", { settings: settings({ matchMinutes: 30, courts: ["Court 1"] }) }),
        division(D2, "Beta", { settings: settings({ matchMinutes: 90, courts: ["Court 2"] }) }),
      ],
      [fixture(F1, D1, { home: E1, away: E2 }), fixture(F2, D2, { home: E3, away: E4 })],
    );
    const out = toJointEngineAssignments(
      plan([assign(F1, at("09:00"), "Court 1"), assign(F2, at("09:00"), "Court 2")]),
      p,
    );
    const byId = new Map(out.map((a) => [a.fixtureId, a]));
    expect(byId.get(F1)!.divisionId).toBe(D1);
    expect(byId.get(F2)!.divisionId).toBe(D2);
    expect(byId.get(F1)!.endAt - byId.get(F1)!.startAt).toBe(30 * 60_000);
    expect(byId.get(F2)!.endAt - byId.get(F2)!.startAt).toBe(90 * 60_000);
  });

  it("mirrors feed dependencies across every division's movable fixtures", () => {
    const p = pack(
      [division(D1, "Alpha"), division(D2, "Beta")],
      [
        fixture(F1, D1),
        fixture(F2, D1, { seq: 1, feeds: { winner_to: null, after: [F1] } }),
        fixture(F3, D2, { feeds: { winner_to: null, after: [F2] } }),
      ],
    );
    expect(jointFeedDependencies(p)).toEqual([
      { fixtureId: F2, dependsOn: F1, direct: true },
      { fixtureId: F3, dependsOn: F2, direct: true },
    ]);
  });
});

// ===========================================================================
// verifyConfigFor — the per-division mirror of verifyConfig
// ===========================================================================

describe("verifyConfigFor (#350)", () => {
  it("reads the division's own settings and keeps verifyConfig's deliberate drops", () => {
    const d = division(D1, "Alpha", {
      settings: settings({
        matchMinutes: 45,
        gapMinutes: 10,
        perEntrantMinRest: 20,
        blackouts: [{ court: "Court 1", from: at("10:00"), to: at("11:00") }],
        sessionWindows: [{ from: at("09:00"), to: at("18:00") }],
        constraints: constraints({
          restMin: 25,
          noBackToBack: true,
          startWindows: [{ target: { kind: "division", id: D1 }, notBefore: at("09:00") }],
          fieldFairness: "balance",
          parallelism: "block",
          crossPersonClash: "hard",
        }),
      }),
    });
    const cfg = verifyConfigFor(d);
    expect(cfg.matchMinutes).toBe(45);
    expect(cfg.gapMinutes).toBe(10);
    expect(cfg.perEntrantMinRest).toBe(20);
    // Epoch ms, not the pack's ISO strings — the engine compares numbers.
    expect(cfg.blackouts).toEqual([
      { court: "Court 1", from: Date.parse(at("10:00")), to: Date.parse(at("11:00")) },
    ]);
    expect(cfg.sessionWindows).toEqual([
      { from: Date.parse(at("09:00")), to: Date.parse(at("18:00")) },
    ]);
    expect(cfg.constraints?.restMin).toBe(25);
    expect(cfg.constraints?.noBackToBack).toBe(true);
    // startWindows are CONVERTED, not dropped (#350 fix round 1). The
    // single-division mirror drops them on the grounds that the pack carries ISO
    // strings and the engine wants epoch ms — but that is exactly the conversion
    // the blackouts and sessionWindows above already do, and the drop made
    // `start_window` a conflict class the whole joint product was blind to while
    // the per-stage apply reported it. Bounds arrive as epoch ms like the rest.
    expect(cfg.constraints?.startWindows).toEqual([
      { target: { kind: "division", id: D1 }, notBefore: Date.parse(at("09:00")) },
    ]);
    // The neutralisations that DO stay: fairness and parallelism are placer
    // policy rather than legality (and parallelism is load-bearing here — the
    // joint draft feeds block-mode exclusivity asymmetrically), while
    // cross-person hardness is re-applied at APPLY time by
    // `applyCompetitionSchedule`, mirroring the single-division split where the
    // plan path warns and the apply path refuses.
    expect(cfg.constraints?.fieldFairness).toBe("off");
    expect(cfg.constraints?.parallelism).toBe("mixed");
    expect(cfg.constraints?.crossPersonClash).toBe("warn");
  });

  it("drops a start-window target kind the engine does not know", () => {
    // `PackStartWindow.target.kind` is a bare `string` (the pack is a wire
    // shape). A cast would put a value the engine can never match into the
    // config and hide that a settings row has drifted from the enum; dropping it
    // keeps the config honest. The known kinds beside it must survive.
    const d = division(D1, "Alpha", {
      settings: settings({
        constraints: constraints({
          startWindows: [
            { target: { kind: "galaxy", id: "x" }, notBefore: at("09:00") },
            { target: { kind: "entrant", id: "e1" }, notAfter: at("12:00") },
          ],
        }),
      }),
    });
    expect(verifyConfigFor(d).constraints?.startWindows).toEqual([
      { target: { kind: "entrant", id: "e1" }, notAfter: Date.parse(at("12:00")) },
    ]);
  });

  it("omits constraints entirely when the division has none", () => {
    expect(verifyConfigFor(division(D1, "Alpha")).constraints).toBeUndefined();
  });

  it("a start-window violation is a WARNING that counts toward ladder escalation", () => {
    // Two things at once, because they are one decision.
    //
    // (1) `start_window` is NOT blocking. `isBlocking` covers court and direct
    //     order only, and converting startWindows must not have changed that —
    //     no new 409s at apply, no repair rounds, no blocking-driven ladder cost.
    // (2) It IS counted by `planIsAcceptable`, whose ratio is
    //     warnings / movable. So the conversion made a joint plan that used to
    //     look acceptable able to escalate a rung. Deliberate — the pack SHOWS
    //     the model its start windows, so ignoring them is a real quality miss,
    //     and every other soft class already counts — and it cannot change what
    //     an org is charged. It CAN bring `stopped_on_budget` forward, so it is
    //     pinned here rather than left to be discovered in production.
    const d = division(D1, "Alpha", {
      settings: settings({
        constraints: constraints({
          startWindows: [{ target: { kind: "division", id: D1 }, notBefore: at("14:00") }],
        }),
      }),
    });
    const p = pack([d], [fixture(F1, D1, { home: E1, away: E2 })]);
    const conflicts = verifyJoint(plan([assign(F1, at("09:00"), "Court 1")]), p);
    expect(conflicts.map((c) => c.reason)).toEqual(["start_window"]);
    // (1) reported, never blocking.
    expect(conflicts.some(isBlocking)).toBe(false);
    // (2) and still in the escalation numerator.
    expect(planIsAcceptable({ blocking: [], warnings: conflicts }, 1)).toBe(true);
    // (3) and the PIPELINE's own partition is what puts it there. (1) and (2)
    //     hand `planIsAcceptable` a list, so they prove the ratio counts what it
    //     is GIVEN — never what BUILDS it. Without this, a filter added at the
    //     partition site drops the class from the numerator AND from the R13
    //     "warnings in full" response, with every joint suite still green.
    expect(partitionConflicts(conflicts)).toEqual({ blocking: [], warnings: conflicts });
    process.env.SCHEDULING_AI_ESCALATE_WARN_RATIO = "0";
    try {
      expect(planIsAcceptable({ blocking: [], warnings: conflicts }, 1)).toBe(false);
      // Control: with the window satisfied there is no warning at all, so the
      // `false` above is this conflict rather than the threshold on its own.
      const clean = verifyJoint(plan([assign(F1, at("14:00"), "Court 1")]), p);
      expect(clean).toEqual([]);
      expect(planIsAcceptable({ blocking: [], warnings: clean }, 1)).toBe(true);
    } finally {
      delete process.env.SCHEDULING_AI_ESCALATE_WARN_RATIO;
    }
  });
});
