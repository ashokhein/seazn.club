// Goldens + rule units for the history module (Jul3/03, PROMPT-23 acceptance).
import { describe, expect, it } from "vitest";
import {
  clearSchedule,
  fold,
  redo,
  removeEntrantsFromPool,
  undo,
} from "./history.ts";
import { HistoryError, type ClearableFixture, type LedgerEvent } from "./types.ts";

const NONE: ReadonlySet<string> = new Set();

function ev(seq: number, type: string, payload: Record<string, unknown>): LedgerEvent {
  return { seq, type, payload };
}

function move(fixture: string, fromAt: string | null, toAt: string, court = "C1") {
  return {
    fixture,
    from: { at: fromAt, court: fromAt === null ? null : court },
    to: { at: toAt, court },
  };
}

// 8-team single RR stage = 28 fixtures; we track 3 that get moved.
function goldenLedger(): LedgerEvent[] {
  const ids = Array.from({ length: 28 }, (_, i) => `f${i + 1}`);
  const events: LedgerEvent[] = [
    ev(1, "fixtures_generated", { stage_id: "s1", fixture_ids: ids }),
    ev(2, "schedule_applied", {
      stageId: "s1",
      moves: ids.map((id, i) => move(id, null, `T${i}`)),
    }),
  ];
  // move 3 fixtures, one event each (board drags)
  events.push(ev(3, "schedule_edited", { fixture: "f1", from: { at: "T0", court: "C1" }, to: { at: "T90", court: "C2" } }));
  events.push(ev(4, "schedule_edited", { fixture: "f2", from: { at: "T1", court: "C1" }, to: { at: "T91", court: "C2" } }));
  events.push(ev(5, "schedule_edited", { fixture: "f3", from: { at: "T2", court: "C1" }, to: { at: "T92", court: "C2" } }));
  return events;
}

function stepAppend(events: LedgerEvent[], step: { event: { type: string; payload: Record<string, unknown> } }): LedgerEvent[] {
  const head = events[events.length - 1]?.seq ?? 0;
  return [...events, ev(head + 1, step.event.type, step.event.payload)];
}

describe("history golden (Jul3/03 §3)", () => {
  it("generate → move ×3 → undo ×3 = original; redo ×3 = moved", () => {
    let events = goldenLedger();
    const moved = fold(events, null);
    let wm: number | null = null;

    // undo ×3
    for (let i = 0; i < 3; i++) {
      const step = undo(events, wm, NONE);
      events = stepAppend(events, step);
      wm = step.newWatermark;
    }
    const original = fold(events, wm);
    expect(original.fixtures.f1).toMatchObject({ at: "T0", court: "C1" });
    expect(original.fixtures.f2).toMatchObject({ at: "T1", court: "C1" });
    expect(original.fixtures.f3).toMatchObject({ at: "T2", court: "C1" });

    // redo ×3
    for (let i = 0; i < 3; i++) {
      const step = redo(events, wm, NONE);
      events = stepAppend(events, step);
      wm = step.newWatermark;
    }
    expect(fold(events, wm)).toEqual(moved);
  });

  it("scoped clear of pool A leaves pool B and locked fixtures intact", () => {
    const fixtures: ClearableFixture[] = [
      { id: "a1", stageId: "s1", poolId: "pA", roundNo: 1, court: "C1", at: "T1", locked: false, decided: false },
      { id: "a2", stageId: "s1", poolId: "pA", roundNo: 1, court: "C1", at: "T2", locked: true, decided: false },
      { id: "b1", stageId: "s1", poolId: "pB", roundNo: 1, court: "C2", at: "T1", locked: false, decided: false },
    ];
    const { event, cleared, skipped } = clearSchedule(fixtures, {
      poolIds: ["pA"],
      excludeLocked: true,
    });
    expect(cleared).toEqual(["a1"]);
    expect(skipped).toEqual({ locked: 1, decided: 0 });
    // the emitted event is fully undoable
    const events = [ev(1, event.type, event.payload)];
    const state = fold(events, null);
    expect(state.fixtures.a1).toMatchObject({ at: null, court: null });
    const step = undo(events, null, NONE);
    const restored = fold(stepAppend(events, step), step.newWatermark);
    expect(restored.fixtures.a1 ?? { at: null }).toMatchObject({ at: null }); // watermark 0 = before the clear
  });
});

describe("history rules", () => {
  it("results-guard blocks undoing a generation with decided fixtures beneath it", () => {
    const events = [ev(1, "fixtures_generated", { stage_id: "s1", fixture_ids: ["f1", "f2"] })];
    expect(() => undo(events, null, new Set(["f2"]))).toThrowError(
      expect.objectContaining({ code: "UNDO_BLOCKED_HAS_RESULTS" }),
    );
    expect(undo(events, null, NONE).event.type).toBe("fixtures_cleared");
  });

  it("undo/redo across non-registry events skips them", () => {
    const events = [
      ev(1, "schedule_edited", { fixture: "f1", from: { at: null, court: null }, to: { at: "T1", court: "C1" } }),
      ev(2, "participants_imported", { import_id: "x" }),
      ev(3, "officials_assigned", { applied: 4 }),
    ];
    const step = undo(events, null, NONE);
    expect(step.event.payload.__undo_of).toBe(1);
    expect(step.newWatermark).toBe(0);
  });

  it("a fresh edit after undo truncates the redo branch (Word-like linear history)", () => {
    let events = [
      ev(1, "schedule_edited", { fixture: "f1", from: { at: null, court: null }, to: { at: "T1", court: "C1" } }),
      ev(2, "schedule_edited", { fixture: "f1", from: { at: "T1", court: "C1" }, to: { at: "T2", court: "C1" } }),
    ];
    const step = undo(events, null, NONE); // undo the T2 move → wm 1
    events = stepAppend(events, step);
    // new edit at head → watermark jumps to head
    events = stepAppend(events, {
      event: {
        type: "schedule_edited",
        payload: { fixture: "f1", from: { at: "T1", court: "C1" }, to: { at: "T5", court: "C2" } },
      },
    });
    const head = events[events.length - 1]!.seq;
    expect(() => redo(events, head, NONE)).toThrowError(
      expect.objectContaining({ code: "NOTHING_TO_REDO" }),
    );
    // and the fold at head is coherent: T2-move applied, inverted, then T5
    expect(fold(events, head).fixtures.f1).toMatchObject({ at: "T5", court: "C2" });
  });

  it("nothing to undo / redo → typed errors", () => {
    expect(() => undo([], null, NONE)).toThrowError(HistoryError);
    expect(() => redo([], null, NONE)).toThrowError(
      expect.objectContaining({ code: "NOTHING_TO_REDO" }),
    );
  });

  it("removeEntrantsFromPool keeps the pool, blocks on decided fixtures", () => {
    const mk = (id: string, poolId: string, decided = false) => ({
      id, stageId: "s1", poolId, roundNo: 1, court: null, at: null, locked: false, decided,
      snapshot: { id, pool_id: poolId },
    });
    const ok = removeEntrantsFromPool([mk("a1", "pA"), mk("b1", "pB")], "pA");
    expect(ok.removed).toEqual(["a1"]);
    expect(ok.event.type).toBe("pool_entrants_cleared");
    expect(() =>
      removeEntrantsFromPool([mk("a1", "pA", true)], "pA"),
    ).toThrowError(expect.objectContaining({ code: "UNDO_BLOCKED_HAS_RESULTS" }));
  });
});
