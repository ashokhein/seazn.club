// Property tests (PROMPT-23 acceptance): apply → undo → redo round-trips,
// the ledger is never mutated (append-only), watermark truncation linearises.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { fold, redo, undo } from "./history.ts";
import type { LedgerEvent } from "./types.ts";

const NONE: ReadonlySet<string> = new Set();

// Random ledgers of interleaved edits over a small fixture pool. Each edit's
// `from` is the fixture's true prior placement — like the real emitters.
const arbitraryLedger = fc
  .array(
    fc.record({
      fixture: fc.constantFrom("f1", "f2", "f3", "f4"),
      at: fc.constantFrom("T1", "T2", "T3", "T4", "T5"),
      court: fc.constantFrom("C1", "C2"),
    }),
    { minLength: 1, maxLength: 20 },
  )
  .map((edits) => {
    const placement = new Map<string, { at: string | null; court: string | null }>();
    const events: LedgerEvent[] = [];
    edits.forEach((e, i) => {
      const from = placement.get(e.fixture) ?? { at: null, court: null };
      const to = { at: e.at, court: e.court };
      events.push({
        seq: i + 1,
        type: "schedule_edited",
        payload: { fixture: e.fixture, from, to },
      });
      placement.set(e.fixture, to);
    });
    return events;
  });

function append(events: LedgerEvent[], step: { event: { type: string; payload: Record<string, unknown> } }): LedgerEvent[] {
  const head = events[events.length - 1]?.seq ?? 0;
  return [...events, { seq: head + 1, type: step.event.type, payload: step.event.payload }];
}

describe("history properties (PROMPT-23)", () => {
  it("apply → undo → redo round-trips to the identical state", () => {
    fc.assert(
      fc.property(arbitraryLedger, fc.integer({ min: 1, max: 5 }), (ledger, steps) => {
        const before = fold(ledger, null);
        let events = ledger;
        let wm: number | null = null;
        let undone = 0;
        for (let i = 0; i < steps; i++) {
          try {
            const step = undo(events, wm, NONE);
            events = append(events, step);
            wm = step.newWatermark;
            undone++;
          } catch {
            break; // ran out of edits
          }
        }
        for (let i = 0; i < undone; i++) {
          const step = redo(events, wm, NONE);
          events = append(events, step);
          wm = step.newWatermark;
        }
        expect(fold(events, wm)).toEqual(before);
      }),
      { numRuns: 200 },
    );
  });

  it("undo never mutates existing ledger rows (append-only)", () => {
    fc.assert(
      fc.property(arbitraryLedger, (ledger) => {
        const frozen = JSON.parse(JSON.stringify(ledger)) as LedgerEvent[];
        try {
          undo(ledger, null, NONE);
          redo(ledger, 0, NONE);
        } catch {
          /* NOTHING_TO_* is fine */
        }
        expect(ledger).toEqual(frozen);
      }),
      { numRuns: 100 },
    );
  });

  it("a fresh edit after undo linearises history: redo impossible, fold coherent", () => {
    fc.assert(
      fc.property(arbitraryLedger, (ledger) => {
        fc.pre(ledger.length >= 2);
        let events = ledger;
        const step = undo(events, null, NONE);
        events = append(events, step);
        // new edit at head, watermark jumps to head
        events = append(events, {
          event: {
            type: "schedule_edited",
            payload: { fixture: "f1", from: { at: null, court: null }, to: { at: "T9", court: "C9" } },
          },
        });
        const head = events[events.length - 1]!.seq;
        expect(() => redo(events, head, NONE)).toThrowError(
          expect.objectContaining({ code: "NOTHING_TO_REDO" }),
        );
        expect(fold(events, head).fixtures.f1).toMatchObject({ at: "T9", court: "C9" });
      }),
      { numRuns: 100 },
    );
  });
});
