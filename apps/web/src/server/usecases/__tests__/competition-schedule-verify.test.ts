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
  toJointEngineAssignments,
  toJointObstacleAssignments,
  verifyConfigFor,
  verifyJoint,
  type CompetitionPack,
  type CompetitionPackDivision,
  type CompetitionPackFixture,
  type CompetitionPackObstacle,
} from "../competition-schedule-ai";
import type { PackConstraints, PackSettings } from "../schedule-ai";
import type { AiSchedulePlan } from "../schedule-ai-prompt";

// --- Fixed ids -------------------------------------------------------------
const D1 = "d1111111-1111-4111-8111-111111111111"; // "Alpha"
const D2 = "d2222222-2222-4222-8222-222222222222"; // "Beta"
const F1 = "11111111-1111-4111-8111-111111111111";
const F2 = "22222222-2222-4222-8222-222222222222";
const F3 = "33333333-3333-4333-8333-333333333333";
const E1 = "e1111111-1111-4111-8111-111111111111";
const E2 = "e2222222-2222-4222-8222-222222222222";
const E3 = "e3333333-3333-4333-8333-333333333333";
const E4 = "e4444444-4444-4444-8444-444444444444";
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
    people: [],
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
    // The three deliberate neutralisations verifyConfig makes, kept verbatim:
    // ISO startWindows would be compared against epoch ms, and fairness /
    // parallelism / cross-person-hardness are placer policy, not legality.
    expect(cfg.constraints?.startWindows).toEqual([]);
    expect(cfg.constraints?.fieldFairness).toBe("off");
    expect(cfg.constraints?.parallelism).toBe("mixed");
    expect(cfg.constraints?.crossPersonClash).toBe("warn");
  });

  it("omits constraints entirely when the division has none", () => {
    expect(verifyConfigFor(division(D1, "Alpha")).constraints).toBeUndefined();
  });
});
