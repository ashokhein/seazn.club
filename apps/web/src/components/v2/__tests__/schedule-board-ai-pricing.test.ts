// The board is where the confirm card's numbers are BORN, and until this file
// it had no tests at all. `tsc` catches a missing prop on <AiConsole>; it never
// catches a wrong value — restoring the original
// `activeEntrants: Object.keys(entrantNames).length` bug left the whole suite
// green, and that bug is a credit charge.
import { describe, expect, it } from "vitest";
import { aiPricingInputs, type BoardFixture } from "../schedule-board";

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
      10,
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
      4,
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
      4,
    );
    expect(out.movableFixtures[0].scheduled_at).toBe("2026-08-01T09:00:00.000Z");
  });

  it("prices on the division's ACTIVE entrant count, passed in", () => {
    // The number comes from the page's status-filtered count. It is emphatically
    // NOT derivable from the board's `entrantNames` map, which is
    // competition-wide and unfiltered.
    expect(aiPricingInputs([fx({ id: "a" })], 12).activeEntrants).toBe(12);
    expect(aiPricingInputs([fx({ id: "a" })], 0).activeEntrants).toBe(0);
  });

  it("prices at zero rather than guessing when no count is available", () => {
    expect(aiPricingInputs([fx({ id: "a" })], undefined).activeEntrants).toBe(0);
  });

  it("reflects a drag immediately — the board's live court, not the server's", () => {
    // `actions.board` applies optimistic overrides before the RSC refresh
    // lands. A fixture dragged INTO the court a repair is scoped to must be in
    // the quote straight away; quoting it against the stale label under-quotes,
    // and under-quoting is the direction that bills people.
    const server = fx({ id: "a", court_label: "Court 1" });
    const dragged = { ...server, court_label: "Court 9" };
    expect(aiPricingInputs([dragged], 4).movableFixtures[0].court_label).toBe("Court 9");
    expect(aiPricingInputs([server], 4).movableFixtures[0].court_label).toBe("Court 1");
  });
});
