// The board is where the confirm card's numbers are BORN, and until this file
// it had no tests at all. `tsc` catches a missing prop on <AiConsole>; it never
// catches a wrong value — restoring the original
// `activeEntrants: Object.keys(entrantNames).length` bug left the whole suite
// green, and that bug is a credit charge.
import { describe, expect, it } from "vitest";
import {
  aiEntryPoint,
  aiPricingInputs,
  buildAiBrief,
  jointDivisionsFor,
  type BoardConfig,
  type BoardDivision,
  type BoardFixture,
} from "../schedule-board";

const fx = (o: Partial<BoardFixture> & { id: string }): BoardFixture => ({
  stage_id: "st-1",
  division_id: "d1",
  round_no: 1,
  seq_in_round: 1,
  home_entrant_id: "e1",
  away_entrant_id: "e2",
  scheduled_at: "2026-08-01T10:00:00.000Z",
  venue: null,
  court_label: "Court 1",
  status: "scheduled",
  schedule_source: "manual",
  schedule_locked: false,
  outcome: null,
  ...o,
});

describe("aiPricingInputs", () => {
  it("counts only movable fixtures", () => {
    // The AI places `scheduled` fixtures. A decided or postponed one is not
    // work it will do, so paying to have it planned would be paying for nothing.
    const out = aiPricingInputs(
      [
        fx({ id: "a" }),
        fx({ id: "b" }),
        fx({ id: "c", status: "decided" }),
        fx({ id: "d", status: "postponed" }),
        fx({ id: "e", status: "in_play" }),
      ],
      "d1",
      { d1: 10 },
    );
    expect(out.movableFixtures.map((f) => f.id)).toEqual(["a", "b"]);
  });

  it("carries the court and time each fixture is at, so a repair can be scoped", () => {
    // These two fields are the whole reason this is a fixture LIST rather than
    // a count: `movableForRun` narrows on them to price a scoped repair.
    const out = aiPricingInputs(
      [
        fx({ id: "a", court_label: "Court 9", scheduled_at: "2026-08-01T09:00:00.000Z" }),
        fx({ id: "b", court_label: null, scheduled_at: null }),
      ],
      "d1",
      { d1: 4 },
    );
    expect(out.movableFixtures).toEqual([
      { id: "a", scheduled_at: "2026-08-01T09:00:00.000Z", court_label: "Court 9" },
      { id: "b", scheduled_at: null, court_label: null },
    ]);
  });

  it("normalises a Date to an ISO string", () => {
    // RSC hands these straight through as Dates; `movableForRun` compares them
    // with `new Date(...).getTime()` and the console ships them as JSON.
    const out = aiPricingInputs(
      [fx({ id: "a", scheduled_at: new Date("2026-08-01T09:00:00.000Z") })],
      "d1",
      { d1: 4 },
    );
    expect(out.movableFixtures[0].scheduled_at).toBe("2026-08-01T09:00:00.000Z");
  });

  it("SELECTS this division's active entrant count", () => {
    // The count has to be CHOSEN here, not handed in. An earlier version took
    // the number as a parameter, which put the assertion BELOW the expression
    // that was wrong: restoring the original `Object.keys(entrantNames).length`
    // bug above it stayed green, because the test was being given the answer.
    //
    // The record carries a decoy, so picking the wrong division — or counting
    // the record instead of reading it — yields 99 or 2 rather than 12.
    const counts = { d1: 12, d2: 99 };
    expect(aiPricingInputs([fx({ id: "a" })], "d1", counts).activeEntrants).toBe(12);
    expect(aiPricingInputs([fx({ id: "a" })], "d2", counts).activeEntrants).toBe(99);
  });

  it("prices at zero rather than guessing when the division is unknown", () => {
    // No division selected, and a division absent from the record. A confident
    // wrong number here is a wrong charge.
    expect(aiPricingInputs([fx({ id: "a" })], null, { d1: 12 }).activeEntrants).toBe(0);
    expect(aiPricingInputs([fx({ id: "a" })], "nope", { d1: 12 }).activeEntrants).toBe(0);
    expect(aiPricingInputs([fx({ id: "a" })], "d1", { d1: 0 }).activeEntrants).toBe(0);
  });

  it("reflects a drag immediately — the board's live court, not the server's", () => {
    // `actions.board` applies optimistic overrides before the RSC refresh
    // lands. A fixture dragged INTO the court a repair is scoped to must be in
    // the quote straight away; quoting it against the stale label under-quotes,
    // and under-quoting is the direction that bills people.
    const server = fx({ id: "a", court_label: "Court 1" });
    const dragged = { ...server, court_label: "Court 9" };
    expect(aiPricingInputs([dragged], "d1", { d1: 4 }).movableFixtures[0].court_label).toBe("Court 9");
    expect(aiPricingInputs([server], "d1", { d1: 4 }).movableFixtures[0].court_label).toBe("Court 1");
  });
});

// ---------------------------------------------------------------------------
// One boundary UP from `aiPricingInputs`.
//
// Every assertion above hands the function a division id, so it proves the
// function reads its argument — never that the board CHOOSES the right one.
// Hardcoding the call site's second argument to `null` (which is what the multi
// -division board evaluates it to today, because `single` is null there) prices
// every run at 0 active entrants, and the whole suite stayed green.
//
// `buildAiBrief` closes that: it takes the board's own `divisions` prop and the
// live fixture list, and derives the division itself — so "hand it the wrong id"
// is not expressible, and "hand it no id" is the mutation these tests red on.
// ---------------------------------------------------------------------------

const CFG: BoardConfig = {
  matchMinutes: 30,
  gapMinutes: 5,
  courts: ["Court 1", "Court 2"],
  perEntrantMinRest: 0,
  blackouts: [],
  sessionWindows: [],
};

const div = (id: string, over: Partial<BoardDivision> = {}): BoardDivision => ({
  id,
  name: `Division ${id}`,
  slug: id,
  status: "draft",
  seq: 3,
  ...over,
});

const briefArgs = (over: Partial<Parameters<typeof buildAiBrief>[0]> = {}) => ({
  cfg: CFG,
  divisions: [div("d1")],
  boardFixtures: [fx({ id: "a" }), fx({ id: "b" })],
  activeEntrantCounts: { d1: 12, d2: 99 },
  entrantNames: { e1: "Bea", e2: "Ada" },
  officialsWithBlackout: 0,
  ...over,
});

describe("buildAiBrief — the board's own choice of what to price", () => {
  it("prices a one-division board on THAT division's active entrants", () => {
    // The decoy (d2: 99) is there so "read the record's only value" and "count
    // the record" both give a different answer than 12. Dropping the division
    // from the call — the `null` mutation — gives 0.
    expect(buildAiBrief(briefArgs()).activeEntrants).toBe(12);
  });

  it("counts only the single division's fixtures, not the whole board's", () => {
    // A competition board's fixture list carries every division. Pricing the
    // division's run on all of them over-quotes; the filter has to happen on
    // the same side as the id, or the two can describe different divisions.
    const brief = buildAiBrief(
      briefArgs({
        boardFixtures: [fx({ id: "a" }), fx({ id: "b", division_id: "d2" }), fx({ id: "c" })],
      }),
    );
    expect(brief.movableFixtures.map((f) => f.id)).toEqual(["a", "c"]);
  });

  it("prices a multi-division board at zero rather than guessing a division", () => {
    // There is no single division to price, and the joint console prices per
    // division itself. A confident wrong number here would be a wrong charge —
    // and this is the case that makes the call site's `null` legitimate, so it
    // has to be asserted separately from the one-division case above.
    const brief = buildAiBrief(briefArgs({ divisions: [div("d1"), div("d2")] }));
    expect(brief.activeEntrants).toBe(0);
  });

  it("carries the pinned count of the division being priced", () => {
    const brief = buildAiBrief(
      briefArgs({
        boardFixtures: [
          fx({ id: "a", schedule_locked: true }),
          fx({ id: "b" }),
          fx({ id: "c", division_id: "d2", schedule_locked: true }),
        ],
      }),
    );
    expect(brief.pinned).toBe(1);
  });
});

describe("aiEntryPoint — which console a board offers", () => {
  const args = (over: Partial<Parameters<typeof aiEntryPoint>[0]> = {}) => ({
    canManage: true,
    aiFlagOn: true,
    divisions: [div("d1")],
    competitionId: null as string | null,
    ...over,
  });

  it("offers the per-division console on a one-division board", () => {
    expect(aiEntryPoint(args())).toBe("division");
  });

  it("offers the joint console on a multi-division board that knows its competition", () => {
    // THE REGRESSION for the `single !== null` gate: this returned null for
    // every multi-division board, which is what kept the joint console
    // unreachable.
    expect(
      aiEntryPoint(args({ divisions: [div("d1"), div("d2")], competitionId: "c1" })),
    ).toBe("competition");
  });

  it("offers nothing on a multi-division board that is not the competition board", () => {
    // The competition schedule page is the only caller that passes a
    // competition id, and that page is itself behind `scheduling.multi_division`
    // (it renders an UpgradeGate instead of the board without it). No id means
    // the joint endpoints have nothing to post to.
    expect(aiEntryPoint(args({ divisions: [div("d1"), div("d2")] }))).toBeNull();
  });

  it("offers nothing without the manage role, the flag, or a division", () => {
    expect(aiEntryPoint(args({ canManage: false }))).toBeNull();
    expect(aiEntryPoint(args({ aiFlagOn: false }))).toBeNull();
    expect(aiEntryPoint(args({ divisions: [] }))).toBeNull();
    // …and the kill switch closes the joint door too, not just the division one.
    expect(
      aiEntryPoint(args({ aiFlagOn: false, divisions: [div("d1"), div("d2")], competitionId: "c1" })),
    ).toBeNull();
  });
});

describe("jointDivisionsFor — the joint console's own pricing inputs", () => {
  const settings = {
    d1: { courts: ["Court 1", "Court 2"], tz: "Europe/London", crossPersonClash: "hard" as const },
    d2: { courts: ["Court 1"], tz: "America/New_York", crossPersonClash: "warn" as const },
  };

  it("counts each division's OWN movable fixtures and its OWN active entrants", () => {
    // Both counts are priced per division and summed into one charge, so a
    // derivation that read the whole board for one of them would multiply the
    // quote by the number of divisions. The two divisions differ on BOTH counts,
    // so neither can pass by borrowing the other's.
    const joint = jointDivisionsFor(
      [div("d1"), div("d2")],
      [
        fx({ id: "a" }),
        fx({ id: "b" }),
        fx({ id: "c", status: "decided" }),
        fx({ id: "d", division_id: "d2" }),
      ],
      { d1: 12, d2: 99 },
      settings,
    );
    expect(joint.map((d) => [d.id, d.movableFixtures, d.activeEntrants])).toEqual([
      ["d1", 2, 12],
      ["d2", 1, 99],
    ]);
  });

  it("carries each division's own courts, timezone and person-clash rule", () => {
    // All three are things the joint console cannot infer: courts are matched by
    // name across divisions, the board renders in one zone while the divisions
    // are configured in their own, and `crossPersonClash: hard` is what turns a
    // plan-time warning into an apply-time refusal.
    const joint = jointDivisionsFor([div("d1"), div("d2")], [], {}, settings);
    expect(joint.map((d) => [d.courts, d.tz, d.personClashBlocks])).toEqual([
      [["Court 1", "Court 2"], "Europe/London", true],
      [["Court 1"], "America/New_York", false],
    ]);
  });

  it("carries the division's freeze and seq, which the run and the apply are refused without", () => {
    const joint = jointDivisionsFor(
      [div("d1", { seq: 4 }), div("d2", { seq: 11, schedule_locked: true })],
      [],
      {},
      settings,
    );
    expect(joint.map((d) => [d.seq, d.scheduleLocked])).toEqual([
      [4, false],
      [11, true],
    ]);
  });

  it("gives a division with no settings row no courts rather than another's", () => {
    // A missing row must not silently inherit — a borrowed court list would put
    // a price on capacity this division does not have, and would make the
    // by-name divergence check agree where it should warn.
    const [only] = jointDivisionsFor([div("d9")], [], {}, settings);
    expect(only.courts).toEqual([]);
    expect(only.personClashBlocks).toBe(false);
  });
});
