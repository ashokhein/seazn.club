// Both-directions proof (#398): every typed rule the instruction compiler can
// emit is enforced by validateAssignments — and stays quiet on a board that
// satisfies it. A verifier that only rejects is untested where it matters most,
// so every describe below carries an ACCEPT case as well as a REJECT case.
//
// Payloads are the two real ones, frozen (payload-fixtures.ts). Every REJECT
// case puts its fixtures on DIFFERENT courts or far enough apart that a `court`
// clash can never be mistaken for the proof.
import { describe, expect, it } from "vitest";
import {
  validateAssignments,
  type Assignment,
  type Conflict,
  type RuleFixture,
  type VerifyConfig,
} from "./calendar.ts";
import type { HardConstraint } from "./constraints.ts";
import { assign, at, BADMINTON, BASE_CONFIG, SHARED, SOLO, STEP } from "./payload-fixtures.ts";

const TZ = "Europe/London";

const rf = (id: string, winnerTo: string | null, divisionId?: string, extKey = id): RuleFixture => ({
  id,
  extKey,
  winnerTo,
  ...(divisionId !== undefined ? { divisionId } : {}),
});

/** Badminton rule fixtures: `gf` is the only terminal — nothing feeds out of it. */
const BAD_RF: RuleFixture[] = BADMINTON.map((f) => rf(f.id, f.id === "gf" ? null : "next"));

const STEP_RF: RuleFixture[] = [
  rf("sl-g1-d1", "sl-g2-d1", "d1"),
  rf("sl-g2-d1", null, "d1"),
  rf("sl-g2-d2", "sl-g3-d2", "d2"),
  rf("sl-g3-d2", null, "d2"),
];

const cfg = (hard: HardConstraint[], extra: Partial<VerifyConfig> = {}): VerifyConfig => ({
  ...BASE_CONFIG,
  tz: TZ,
  hard,
  ruleFixtures: BAD_RF,
  ...extra,
});

const instr = (c: readonly Conflict[]): Conflict[] => c.filter((x) => x.reason === "instruction");
const details = (c: readonly Conflict[]): string[] => instr(c).map((x) => x.detail ?? "");

const CAP2: HardConstraint = { type: "max_fixtures_per_day", count: 2, scope: { kind: "competition" } };

describe("max_fixtures_per_day (payload A: badminton)", () => {
  it("ACCEPTS two fixtures on each of two days", () => {
    const slots: [string, string, string][] = [
      ["wb-r0-i1", "2026-08-03T10:00:00Z", "Court 1"],
      ["wb-r0-i2", "2026-08-03T12:00:00Z", "Court 1"],
      ["wb-r0-i3", "2026-08-04T10:00:00Z", "Court 1"],
      ["wb-r1-i0", "2026-08-04T12:00:00Z", "Court 1"],
    ];
    expect(instr(validateAssignments(assign(BADMINTON, SOLO, slots), cfg([CAP2])))).toEqual([]);
  });

  it("REJECTS three fixtures on one day, naming the day and the cap", () => {
    const slots: [string, string, string][] = [
      ["wb-r0-i1", "2026-08-03T10:00:00Z", "Court 1"],
      ["wb-r0-i2", "2026-08-03T12:00:00Z", "Court 1"],
      ["wb-r0-i3", "2026-08-03T14:00:00Z", "Court 1"],
    ];
    const found = instr(validateAssignments(assign(BADMINTON, SOLO, slots), cfg([CAP2])));
    expect(found).toHaveLength(3);
    expect(details(found).every((d) => d.includes("2026-08-03") && d.includes("2/day"))).toBe(true);
  });

  it("counts the day in the ORG zone, not UTC", () => {
    // 23:30 UTC on the 3rd is 09:30 on the 4th in Sydney: under a 1/day cap the
    // pair is legal in Sydney and illegal in UTC. This is the whole point of the
    // one-timezone decision (design §2.1).
    const slots: [string, string, string][] = [
      ["wb-r0-i1", "2026-08-03T12:00:00Z", "Court 1"],
      ["wb-r0-i2", "2026-08-03T23:30:00Z", "Court 2"],
    ];
    const cap1: HardConstraint = { type: "max_fixtures_per_day", count: 1, scope: { kind: "competition" } };
    const board = assign(BADMINTON, SOLO, slots);
    expect(instr(validateAssignments(board, cfg([cap1], { tz: "Australia/Sydney" })))).toEqual([]);
    expect(instr(validateAssignments(board, cfg([cap1], { tz: "UTC" }))).length).toBeGreaterThan(0);
  });

  it("is SKIPPED rather than bucketed in UTC when no org zone is configured", () => {
    const slots: [string, string, string][] = [
      ["wb-r0-i1", "2026-08-03T10:00:00Z", "Court 1"],
      ["wb-r0-i2", "2026-08-03T12:00:00Z", "Court 1"],
      ["wb-r0-i3", "2026-08-03T14:00:00Z", "Court 1"],
    ];
    const noTz: VerifyConfig = { ...BASE_CONFIG, hard: [CAP2], ruleFixtures: BAD_RF };
    expect(instr(validateAssignments(assign(BADMINTON, SOLO, slots), noTz))).toEqual([]);
  });
});

describe("fixture_on_weekday with a terminal selector", () => {
  const FRI: HardConstraint = {
    type: "fixture_on_weekday",
    selector: { kind: "terminal" },
    weekday: "FRI",
    scope: { kind: "competition" },
  };

  it("ACCEPTS the grand final on a Friday", () => {
    // 2026-08-07 is a Friday.
    const slots: [string, string, string][] = [["gf", "2026-08-07T10:00:00Z", "Court 1"]];
    expect(instr(validateAssignments(assign(BADMINTON, SOLO, slots), cfg([FRI])))).toEqual([]);
  });

  it("REJECTS the grand final on a Thursday", () => {
    const slots: [string, string, string][] = [["gf", "2026-08-06T10:00:00Z", "Court 1"]];
    const found = instr(validateAssignments(assign(BADMINTON, SOLO, slots), cfg([FRI])));
    expect(found).toHaveLength(1);
    expect(found[0]!.fixtureId).toBe("gf");
    expect(found[0]!.detail).toContain("requires FRI");
  });

  it("resolves terminal by winner_to === null, never by round number", () => {
    // wb-r2-i0 sits in a HIGHER round than lb-r3-i0 and is NOT terminal. On a
    // Thursday it must attract no violation at all: only `gf` is selected.
    const slots: [string, string, string][] = [["wb-r2-i0", "2026-08-06T10:00:00Z", "Court 1"]];
    expect(instr(validateAssignments(assign(BADMINTON, SOLO, slots), cfg([FRI])))).toEqual([]);
  });

  it("an unqualified terminal target covers EVERY division's terminal fixture", () => {
    const board = [
      ...assign(STEP, SHARED, [["sl-g2-d1", "2026-08-06T10:00:00Z", "Court 1"]], 30).map((a) => ({
        ...a,
        divisionId: "d1",
      })),
      ...assign(STEP, SHARED, [["sl-g3-d2", "2026-08-06T14:00:00Z", "Court 2"]], 30).map((a) => ({
        ...a,
        divisionId: "d2",
      })),
    ];
    const found = instr(
      validateAssignments(board, {
        ...BASE_CONFIG,
        matchMinutes: 30,
        tz: TZ,
        hard: [FRI],
        ruleFixtures: STEP_RF,
      }),
    );
    expect(found.map((c) => c.fixtureId).sort()).toEqual(["sl-g2-d1", "sl-g3-d2"]);
  });

  it("a division-scoped terminal target covers only that division", () => {
    const scoped: HardConstraint = { ...FRI, scope: { kind: "division", divisionId: "d2" } };
    const board = [
      ...assign(STEP, SHARED, [["sl-g2-d1", "2026-08-06T10:00:00Z", "Court 1"]], 30).map((a) => ({
        ...a,
        divisionId: "d1",
      })),
      ...assign(STEP, SHARED, [["sl-g3-d2", "2026-08-06T14:00:00Z", "Court 2"]], 30).map((a) => ({
        ...a,
        divisionId: "d2",
      })),
    ];
    const found = instr(
      validateAssignments(board, {
        ...BASE_CONFIG,
        matchMinutes: 30,
        tz: TZ,
        hard: [scoped],
        ruleFixtures: STEP_RF,
      }),
    );
    expect(found.map((c) => c.fixtureId)).toEqual(["sl-g3-d2"]);
  });
});

describe("fixture_on_date", () => {
  const ON: HardConstraint = {
    type: "fixture_on_date",
    selector: { kind: "ext_key", extKey: "gf" },
    date: "2026-08-07",
    scope: { kind: "competition" },
  };

  it("ACCEPTS the named date", () => {
    const slots: [string, string, string][] = [["gf", "2026-08-07T10:00:00Z", "Court 1"]];
    expect(instr(validateAssignments(assign(BADMINTON, SOLO, slots), cfg([ON])))).toEqual([]);
  });

  it("REJECTS a different date", () => {
    const slots: [string, string, string][] = [["gf", "2026-08-08T10:00:00Z", "Court 1"]];
    const found = instr(validateAssignments(assign(BADMINTON, SOLO, slots), cfg([ON])));
    expect(found).toHaveLength(1);
    expect(found[0]!.detail).toContain("2026-08-07");
  });

  it("says nothing about a fixture the selector does not name", () => {
    const slots: [string, string, string][] = [["wb-r0-i1", "2026-08-08T10:00:00Z", "Court 1"]];
    expect(instr(validateAssignments(assign(BADMINTON, SOLO, slots), cfg([ON])))).toEqual([]);
  });
});

describe("not_before / not_after in the org zone", () => {
  const NB: HardConstraint = { type: "not_before", time: "09:00", scope: { kind: "competition" } };
  const NA: HardConstraint = { type: "not_after", time: "20:00", scope: { kind: "competition" } };

  it("ACCEPTS a 10:00 London start", () => {
    const slots: [string, string, string][] = [["gf", "2026-08-07T09:00:00Z", "Court 1"]];
    expect(instr(validateAssignments(assign(BADMINTON, SOLO, slots), cfg([NB, NA])))).toEqual([]);
  });

  it("REJECTS a 07:00 London start", () => {
    // 06:00Z is 07:00 London in August — the bound is wall clock, not UTC.
    const slots: [string, string, string][] = [["gf", "2026-08-07T06:00:00Z", "Court 1"]];
    const found = instr(validateAssignments(assign(BADMINTON, SOLO, slots), cfg([NB, NA])));
    expect(found).toHaveLength(1);
    expect(found[0]!.detail).toContain("not_before 09:00");
  });

  it("REJECTS a 21:00 London start", () => {
    const slots: [string, string, string][] = [["gf", "2026-08-07T20:00:00Z", "Court 1"]];
    const found = instr(validateAssignments(assign(BADMINTON, SOLO, slots), cfg([NB, NA])));
    expect(found).toHaveLength(1);
    expect(found[0]!.detail).toContain("not_after 20:00");
  });

  it("an entrant-scoped bound binds only that entrant's fixtures", () => {
    const scoped: HardConstraint = { type: "not_before", time: "12:00", scope: { kind: "entrant", entrantId: "e" } };
    const slots: [string, string, string][] = [
      ["wb-r0-i1", "2026-08-07T09:00:00Z", "Court 1"], // e vs d — bound
      ["wb-r0-i2", "2026-08-07T09:00:00Z", "Court 2"], // c vs f — not bound
    ];
    const found = instr(validateAssignments(assign(BADMINTON, SOLO, slots), cfg([scoped])));
    expect(found.map((c) => c.fixtureId)).toEqual(["wb-r0-i1"]);
  });
});

describe("min_rest_minutes RAISES a stored rest and never lowers it", () => {
  const R40: HardConstraint = {
    type: "min_rest_minutes",
    minutes: 40,
    rest_scope: "both",
    scope: { kind: "competition" },
  };
  // wb-r0-i1 (e vs d) and lb-r0-i0 both carry person p-d / p-e: lb-r0-i0 is fed
  // by wb-r0-i1, so participants puts both players in it (#396).
  const tight: [string, string, string][] = [
    ["wb-r0-i1", "2026-08-03T10:00:00Z", "Court 1"],
    ["lb-r0-i0", "2026-08-03T10:50:00Z", "Court 2"], // ends 10:40, starts 10:50 = 10 min
  ];
  const wide: [string, string, string][] = [
    ["wb-r0-i1", "2026-08-03T10:00:00Z", "Court 1"],
    ["lb-r0-i0", "2026-08-03T11:30:00Z", "Court 2"], // 50 min gap
  ];
  const rests = (c: readonly Conflict[]): number => c.filter((x) => x.reason === "rest").length;

  it("REJECTS a 10-minute gap when the instruction says 40 and the setting says 0", () => {
    const found = validateAssignments(assign(BADMINTON, SOLO, tight), cfg([R40], { perEntrantMinRest: 0 }));
    expect(rests(found)).toBeGreaterThan(0);
  });

  it("ACCEPTS a 50-minute gap at an instructed 40 with a stored 0", () => {
    expect(rests(validateAssignments(assign(BADMINTON, SOLO, wide), cfg([R40], { perEntrantMinRest: 0 })))).toBe(0);
  });

  it("does NOT lower a stored 90 to the instruction's 40", () => {
    expect(
      rests(validateAssignments(assign(BADMINTON, SOLO, wide), cfg([R40], { perEntrantMinRest: 90 }))),
    ).toBeGreaterThan(0);
  });

  it("a feeder_to_dependent rest never raises the per-person bound", () => {
    const feederOnly: HardConstraint = {
      type: "min_rest_minutes",
      minutes: 120,
      rest_scope: "feeder_to_dependent",
      scope: { kind: "competition" },
    };
    expect(
      rests(validateAssignments(assign(BADMINTON, SOLO, wide), cfg([feederOnly], { perEntrantMinRest: 0 }))),
    ).toBe(0);
  });
});

describe("cross-division rest is the MAX of both divisions (payload B: Stepladder)", () => {
  // Fischer plays in BOTH divisions. d1 rests 20, d2 rests 120. A 60-minute gap
  // is legal under d1's own config and illegal under d2's — before this change
  // the d1 pass silently accepted it and the pair was checked twice at two
  // different values instead of once at the maximum (design §7.2).
  const withDiv = (a: Assignment[], id: string, division: string): Assignment[] =>
    a.map((x) => (x.fixtureId === id ? { ...x, divisionId: division } : x));

  const board = (slots: [string, string, string][]): Assignment[] => {
    let a = assign(STEP, SHARED, slots, 30);
    a = withDiv(a, "sl-g2-d1", "d1");
    a = withDiv(a, "sl-g2-d2", "d2");
    return a;
  };

  const d1Pass = (a: Assignment[]) =>
    validateAssignments(
      a.filter((x) => x.divisionId === "d1"),
      {
        ...BASE_CONFIG,
        tz: TZ,
        matchMinutes: 30,
        perEntrantMinRest: 20,
        ruleFixtures: STEP_RF,
        restByDivision: { d1: 20, d2: 120 },
      },
      a.filter((x) => x.divisionId !== "d1"),
    );

  it("REJECTS the pair when the OTHER division's rest is the binding one", () => {
    const found = d1Pass(
      board([
        ["sl-g2-d1", "2026-07-24T10:00:00Z", "Court 1"],
        ["sl-g2-d2", "2026-07-24T11:30:00Z", "Court 2"], // ends 10:30, starts 11:30 = 60 min
      ]),
    );
    expect(found.some((c) => c.reason === "rest")).toBe(true);
  });

  it("ACCEPTS the same pair once the gap clears the MAX", () => {
    const found = d1Pass(
      board([
        ["sl-g2-d1", "2026-07-24T10:00:00Z", "Court 1"],
        ["sl-g2-d2", "2026-07-24T14:00:00Z", "Court 2"], // 3h30
      ]),
    );
    expect(found.some((c) => c.reason === "rest")).toBe(false);
  });

  it("without restByDivision the d1 pass misses it — the bug, pinned", () => {
    const a = board([
      ["sl-g2-d1", "2026-07-24T10:00:00Z", "Court 1"],
      ["sl-g2-d2", "2026-07-24T11:30:00Z", "Court 2"],
    ]);
    const found = validateAssignments(
      a.filter((x) => x.divisionId === "d1"),
      { ...BASE_CONFIG, tz: TZ, matchMinutes: 30, perEntrantMinRest: 20, ruleFixtures: STEP_RF },
      a.filter((x) => x.divisionId !== "d1"),
    );
    expect(found.some((c) => c.reason === "rest")).toBe(false);
  });
});

describe("scoping", () => {
  it("a division-scoped cap ignores another division's fixtures", () => {
    const cap1: HardConstraint = {
      type: "max_fixtures_per_day",
      count: 1,
      scope: { kind: "division", divisionId: "d2" },
    };
    const board = assign(
      STEP,
      SHARED,
      [
        ["sl-g1-d1", "2026-07-24T10:00:00Z", "Court 1"],
        ["sl-g2-d1", "2026-07-24T14:00:00Z", "Court 1"],
      ],
      30,
    ).map((x) => ({ ...x, divisionId: "d1" }));
    expect(
      instr(
        validateAssignments(board, {
          ...BASE_CONFIG,
          tz: TZ,
          matchMinutes: 30,
          hard: [cap1],
          ruleFixtures: STEP_RF,
        }),
      ),
    ).toEqual([]);
  });

  it("a person-scoped cap binds the TBD slots that person can still advance into", () => {
    // p-fischer is not NAMED in sl-g2-d1 — he can only advance into it. A
    // person-scoped rule reaches it because `people` is participants (#396).
    const cap1: HardConstraint = {
      type: "max_fixtures_per_day",
      count: 1,
      scope: { kind: "person", personKey: "p-fischer" },
    };
    const board = [
      ...assign(STEP, SHARED, [["sl-g2-d1", "2026-07-24T10:00:00Z", "Court 1"]], 30).map((a) => ({
        ...a,
        divisionId: "d1",
      })),
      ...assign(STEP, SHARED, [["sl-g2-d2", "2026-07-24T16:00:00Z", "Court 2"]], 30).map((a) => ({
        ...a,
        divisionId: "d2",
      })),
    ];
    const found = instr(
      validateAssignments(board, {
        ...BASE_CONFIG,
        tz: TZ,
        matchMinutes: 30,
        hard: [cap1],
        ruleFixtures: STEP_RF,
      }),
    );
    // Pinned by id, not just counted: a 2 that came from the wrong division
    // would pass a bare length check and prove nothing about scoping.
    expect(found.map((c) => c.fixtureId).sort()).toEqual(["sl-g2-d1", "sl-g2-d2"]);
  });

  it("counts fixtures ALREADY on the day, not just the ones this run placed", () => {
    // The cap is broken by the day's total. Counted over `assignments` alone, a
    // run that adds two to a day already holding two passes a 2/day cap that the
    // day plainly breaks.
    const placed = assign(BADMINTON, SOLO, [
      ["wb-r0-i1", "2026-08-03T10:00:00Z", "Court 1"],
      ["wb-r0-i2", "2026-08-03T12:00:00Z", "Court 2"],
    ]);
    const alreadyThere = assign(BADMINTON, SOLO, [["wb-r0-i3", "2026-08-03T16:00:00Z", "Court 3"]]);
    const found = instr(validateAssignments(placed, cfg([CAP2]), alreadyThere));
    // Reported on the two cards this run can move, never on the third — a
    // conflict on a fixture nobody can drag is noise the repair round cannot use.
    expect(found.map((c) => c.fixtureId).sort()).toEqual(["wb-r0-i1", "wb-r0-i2"]);
    expect(details(found)[0]).toContain("3 fixtures");
  });

  it("does NOT count an obstacle as a fixture", () => {
    // Outside bookings and blackouts arrive in the same `existing` array as
    // immovable fixtures. A closed court is not a fixture, and counting one
    // would invent a cap breach out of a court being unavailable.
    const placed = assign(BADMINTON, SOLO, [
      ["wb-r0-i1", "2026-08-03T10:00:00Z", "Court 1"],
      ["wb-r0-i2", "2026-08-03T12:00:00Z", "Court 2"],
    ]);
    const obstacle: Assignment = {
      fixtureId: "obstacle:x:0",
      court: "Court 4",
      startAt: at("2026-08-03T18:00:00Z"),
      endAt: at("2026-08-03T19:00:00Z"),
      entrants: [],
      people: [],
    };
    expect(instr(validateAssignments(placed, cfg([CAP2]), [obstacle]))).toEqual([]);
  });

  it("enforces a rule stored durably on the division, not only a compiled one", () => {
    // `constraints.hard` is the API's home for a rule (ScheduleConfig), `hard`
    // is the compiled instruction's. A rule that binds on one entry point and
    // not the other shows as enforced on Monday and silently is not on Tuesday.
    const board = assign(BADMINTON, SOLO, [
      ["wb-r0-i1", "2026-08-03T10:00:00Z", "Court 1"],
      ["wb-r0-i2", "2026-08-03T12:00:00Z", "Court 2"],
      ["wb-r0-i3", "2026-08-03T14:00:00Z", "Court 3"],
    ]);
    const stored = validateAssignments(board, {
      ...BASE_CONFIG,
      tz: TZ,
      ruleFixtures: BAD_RF,
      constraints: {
        noBackToBack: false,
        startWindows: [],
        fieldFairness: "off" as const,
        parallelism: "mixed" as const,
        crossPersonClash: "warn" as const,
        hard: [CAP2],
      },
    });
    expect(instr(stored)).toHaveLength(3);
    // And identical to the compiled route, so neither home is the special case.
    expect(instr(validateAssignments(board, cfg([CAP2])))).toEqual(instr(stored));
  });

  describe("feeder_to_dependent rest (payload B: stepladder)", () => {
    // "40 minutes before the round it feeds" is a rest between a fixture and the
    // one its winner advances into — NOT between a player's own matches. Nothing
    // else in the verifier covers it: `gapMinutes` is a court turnaround, and
    // `order` only asks that the feeder has finished.
    const feedRest = (rest_scope: "feeder_to_dependent" | "per_person" | "both"): HardConstraint => ({
      type: "min_rest_minutes",
      minutes: 40,
      rest_scope,
      scope: { kind: "competition" },
    });
    // g1 ends 10:30. Courts differ so a `court` clash can never be the proof.
    const board = (dependentIso: string): Assignment[] =>
      assign(
        STEP,
        SHARED,
        [
          ["sl-g1-d1", "2026-07-24T10:00:00Z", "Court 1"],
          ["sl-g2-d1", dependentIso, "Court 2"],
        ],
        30,
      ).map((a) => ({ ...a, divisionId: "d1" }));
    const verify = (b: Assignment[], h: HardConstraint): Conflict[] =>
      instr(validateAssignments(b, { ...BASE_CONFIG, tz: TZ, matchMinutes: 30, hard: [h], ruleFixtures: STEP_RF }));

    it("REJECTS a dependent that starts 20 minutes after its feeder ends", () => {
      const found = verify(board("2026-07-24T10:50:00Z"), feedRest("feeder_to_dependent"));
      expect(found.map((c) => c.fixtureId)).toEqual(["sl-g2-d1"]);
      expect(found[0]?.detail).toBe("starts 20 min after its feeder, instruction requires 40");
    });

    it("ACCEPTS a 45-minute gap", () => {
      expect(verify(board("2026-07-24T11:15:00Z"), feedRest("feeder_to_dependent"))).toEqual([]);
    });

    it("'both' enforces the feed gap as well as the per-person bound", () => {
      expect(verify(board("2026-07-24T10:50:00Z"), feedRest("both")).map((c) => c.fixtureId)).toEqual([
        "sl-g2-d1",
      ]);
    });

    it("'per_person' does NOT produce a feed row — that half is the rest bound", () => {
      expect(verify(board("2026-07-24T10:50:00Z"), feedRest("per_person"))).toEqual([]);
    });

    it("stays quiet when the dependent is placed BEFORE its feeder — that is `order`", () => {
      // Reported once, as an ordering violation, by the dependency pass. A rest
      // row stacked on top teaches the repair round nothing.
      const early = board("2026-07-24T08:00:00Z");
      expect(verify(early, feedRest("feeder_to_dependent"))).toEqual([]);
      const withDeps = validateAssignments(
        early,
        { ...BASE_CONFIG, tz: TZ, matchMinutes: 30, hard: [feedRest("both")], ruleFixtures: STEP_RF },
        [],
        [{ fixtureId: "sl-g2-d1", dependsOn: "sl-g1-d1", direct: true }],
      );
      expect(withDeps.filter((c) => c.reason === "order")).toHaveLength(1);
    });

    it("does not cross divisions on a reused ext_key", () => {
      // Two divisions can both wire an "sl-g2-d1"-shaped key; a feed edge is only
      // an edge within one division's bracket.
      const crossed: RuleFixture[] = [
        { id: "sl-g1-d1", extKey: "SF1", winnerTo: "F", divisionId: "d1" },
        { id: "sl-g2-d2", extKey: "F", winnerTo: null, divisionId: "d2" },
      ];
      const b = [
        ...assign(STEP, SHARED, [["sl-g1-d1", "2026-07-24T10:00:00Z", "Court 1"]], 30).map((a) => ({
          ...a,
          divisionId: "d1",
        })),
        ...assign(STEP, SHARED, [["sl-g2-d2", "2026-07-24T10:50:00Z", "Court 2"]], 30).map((a) => ({
          ...a,
          divisionId: "d2",
        })),
      ];
      expect(
        instr(
          validateAssignments(b, {
            ...BASE_CONFIG,
            tz: TZ,
            matchMinutes: 30,
            hard: [feedRest("feeder_to_dependent")],
            ruleFixtures: crossed,
          }),
        ),
      ).toEqual([]);
    });
  });

  it("no rules at all leaves the report byte-identical to a pre-W3 run", () => {
    const slots: [string, string, string][] = [
      ["wb-r0-i1", "2026-08-03T10:00:00Z", "Court 1"],
      ["wb-r0-i2", "2026-08-03T12:00:00Z", "Court 1"],
      ["wb-r0-i3", "2026-08-03T14:00:00Z", "Court 1"],
    ];
    const board = assign(BADMINTON, SOLO, slots);
    expect(validateAssignments(board, cfg([]))).toEqual(validateAssignments(board, BASE_CONFIG));
  });
});
