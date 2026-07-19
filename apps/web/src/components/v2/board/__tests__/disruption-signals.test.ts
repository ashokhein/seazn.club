// Client-derived repair signals (v4 Task 16, Step 1). computeDisruptions is pure
// over the board's own fixtures + config, so every reason and the repair scope
// are exercised here without React or a DB.
import { describe, expect, it } from "vitest";
import {
  computeDisruptions,
  type DisruptionFixtureInput,
  type DisruptionSettingsInput,
} from "../use-disruption-signals";

/** A placed, movable fixture on a configured court, inside the window — the
 *  undisturbed baseline each test perturbs one axis of. */
function fx(over: Partial<DisruptionFixtureInput> & { id: string }): DisruptionFixtureInput {
  return {
    scheduled_at: "2026-08-01T10:00:00.000Z",
    court_label: "Court 1",
    status: "scheduled",
    ...over,
  };
}

function settings(over: Partial<DisruptionSettingsInput> = {}): DisruptionSettingsInput {
  return {
    courts: ["Court 1", "Court 2"],
    blackouts: [],
    sessionWindows: [],
    matchMinutes: 30,
    ...over,
  };
}

describe("computeDisruptions", () => {
  it("a clean board reports nothing", () => {
    const s = settings({ sessionWindows: [{ from: "2026-08-01T09:00:00.000Z", to: "2026-08-01T17:00:00.000Z" }] });
    const out = computeDisruptions([fx({ id: "a" }), fx({ id: "b", court_label: "Court 2" })], s);
    expect(out).toEqual({ fixtureIds: [], reasons: [], scope: {} });
  });

  it("flags a fixture whose slot sits inside a blackout", () => {
    const s = settings({
      blackouts: [{ from: "2026-08-01T09:30:00.000Z", to: "2026-08-01T10:30:00.000Z" }],
    });
    const out = computeDisruptions([fx({ id: "a" })], s);
    expect(out.fixtureIds).toEqual(["a"]);
    expect(out.reasons).toEqual(["blackout"]);
    expect(out.scope).toEqual({ from: "2026-08-01T10:00:00.000Z" });
  });

  it("flags a match that runs INTO a blackout even when it starts before it", () => {
    // 09:45 + 30min = 10:15, overlapping a 10:00–11:00 blackout.
    const s = settings({
      blackouts: [{ from: "2026-08-01T10:00:00.000Z", to: "2026-08-01T11:00:00.000Z" }],
    });
    const out = computeDisruptions([fx({ id: "a", scheduled_at: "2026-08-01T09:45:00.000Z" })], s);
    expect(out.reasons).toEqual(["blackout"]);
  });

  it("a court-scoped blackout only disrupts fixtures on that court", () => {
    const s = settings({
      blackouts: [{ court: "Court 2", from: "2026-08-01T09:30:00.000Z", to: "2026-08-01T10:30:00.000Z" }],
    });
    const out = computeDisruptions(
      [fx({ id: "on1", court_label: "Court 1" }), fx({ id: "on2", court_label: "Court 2" })],
      s,
    );
    expect(out.fixtureIds).toEqual(["on2"]);
    expect(out.reasons).toEqual(["blackout"]);
  });

  it("flags a fixture on a court that was removed from settings, with that court in scope", () => {
    const s = settings({ courts: ["Court 1"] }); // Court 2 removed
    const out = computeDisruptions([fx({ id: "a", court_label: "Court 2" })], s);
    expect(out.fixtureIds).toEqual(["a"]);
    expect(out.reasons).toEqual(["court_gone"]);
    expect(out.scope.courts).toEqual(["Court 2"]);
    expect(out.scope.from).toBe("2026-08-01T10:00:00.000Z");
  });

  it("flags a fixture scheduled outside every session window", () => {
    const s = settings({
      courts: ["Court 1"],
      sessionWindows: [{ from: "2026-08-01T09:00:00.000Z", to: "2026-08-01T17:00:00.000Z" }],
    });
    const out = computeDisruptions([fx({ id: "a", scheduled_at: "2026-08-01T20:00:00.000Z" })], s);
    expect(out.fixtureIds).toEqual(["a"]);
    expect(out.reasons).toEqual(["outside_window"]);
  });

  it("does NOT flag out-of-hours fixtures when no session windows are defined", () => {
    // Empty sessionWindows = no window constraint, so 20:00 is not a disruption.
    const out = computeDisruptions(
      [fx({ id: "a", court_label: "Court 1", scheduled_at: "2026-08-01T20:00:00.000Z" })],
      settings({ courts: ["Court 1"], sessionWindows: [] }),
    );
    expect(out).toEqual({ fixtureIds: [], reasons: [], scope: {} });
  });

  it("flags a postponed match that is still holding a slot", () => {
    const out = computeDisruptions([fx({ id: "a", status: "postponed" })], settings({ courts: ["Court 1"] }));
    expect(out.fixtureIds).toEqual(["a"]);
    expect(out.reasons).toEqual(["postponed"]);
    expect(out.scope.from).toBe("2026-08-01T10:00:00.000Z");
  });

  it("does not flag a postponed fixture with no slot (it's in the tray)", () => {
    const out = computeDisruptions([fx({ id: "a", status: "postponed", scheduled_at: null })], settings());
    expect(out.fixtureIds).toEqual([]);
  });

  it.each(["in_play", "decided", "finalized", "abandoned", "forfeited", "cancelled"])(
    "never flags a %s fixture, even one sitting in a blackout",
    (status) => {
      const s = settings({
        blackouts: [{ from: "2026-08-01T09:30:00.000Z", to: "2026-08-01T10:30:00.000Z" }],
      });
      const out = computeDisruptions([fx({ id: "a", status })], s);
      expect(out).toEqual({ fixtureIds: [], reasons: [], scope: {} });
    },
  );

  it("does not flag an unscheduled fixture even if its court is gone", () => {
    const out = computeDisruptions(
      [fx({ id: "a", court_label: "Ghost Court", scheduled_at: null })],
      settings({ courts: ["Court 1"] }),
    );
    expect(out.fixtureIds).toEqual([]);
  });

  it("counts a fixture once but keeps every reason it triggers", () => {
    // On a removed court AND outside the window: one id, two reasons.
    const s = settings({
      courts: ["Court 1"],
      sessionWindows: [{ from: "2026-08-01T09:00:00.000Z", to: "2026-08-01T17:00:00.000Z" }],
    });
    const out = computeDisruptions(
      [fx({ id: "a", court_label: "Court 9", scheduled_at: "2026-08-01T20:00:00.000Z" })],
      s,
    );
    expect(out.fixtureIds).toEqual(["a"]);
    expect(out.reasons).toEqual(["court_gone", "outside_window"]);
    expect(out.scope).toEqual({ courts: ["Court 9"], from: "2026-08-01T20:00:00.000Z" });
  });

  it("aggregates scope: removed courts sorted, `from` is the earliest disruption", () => {
    const s = settings({ courts: ["Court 1"] });
    const out = computeDisruptions(
      [
        fx({ id: "late", court_label: "Court 5", scheduled_at: "2026-08-01T12:00:00.000Z" }),
        fx({ id: "early", court_label: "Court 3", scheduled_at: "2026-08-01T09:00:00.000Z" }),
      ],
      s,
    );
    expect(out.fixtureIds).toEqual(["late", "early"]); // board order preserved
    expect(out.scope.courts).toEqual(["Court 3", "Court 5"]); // sorted
    expect(out.scope.from).toBe("2026-08-01T09:00:00.000Z"); // earliest
  });

  it("returns reasons in a stable canonical order regardless of board order", () => {
    const s = settings({
      courts: ["Court 1"],
      blackouts: [{ from: "2026-08-01T11:55:00.000Z", to: "2026-08-01T12:30:00.000Z" }],
      sessionWindows: [{ from: "2026-08-01T09:00:00.000Z", to: "2026-08-01T17:00:00.000Z" }],
    });
    const out = computeDisruptions(
      [
        fx({ id: "postponed", status: "postponed", scheduled_at: "2026-08-01T14:00:00.000Z" }),
        fx({ id: "outside", scheduled_at: "2026-08-01T20:00:00.000Z" }),
        fx({ id: "gone", court_label: "Court 9", scheduled_at: "2026-08-01T10:00:00.000Z" }),
        fx({ id: "blackout", scheduled_at: "2026-08-01T12:10:00.000Z" }),
      ],
      s,
    );
    expect(out.reasons).toEqual(["blackout", "court_gone", "outside_window", "postponed"]);
    expect(out.fixtureIds).toHaveLength(4);
  });

  it("accepts Date-typed scheduled_at (straight from an RSC), not just ISO strings", () => {
    const s = settings({
      blackouts: [{ from: "2026-08-01T09:30:00.000Z", to: "2026-08-01T10:30:00.000Z" }],
    });
    const out = computeDisruptions([fx({ id: "a", scheduled_at: new Date("2026-08-01T10:00:00.000Z") })], s);
    expect(out.reasons).toEqual(["blackout"]);
    expect(out.scope.from).toBe("2026-08-01T10:00:00.000Z");
  });
});
