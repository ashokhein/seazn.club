// Monotonic time guard in the fold kernel — W4a spec (#425) §3.3, §9.
// Written against a toy in-file sport so the guard is provably sport-agnostic:
// nothing below imports a real module, and the guard still orders these stamps.
import { describe, expect, it } from "vitest";
import { EngineError } from "./errors.ts";
import { foldMatch, type EventEnvelope, type FoldableModule } from "./events.ts";
import type { LineupPair } from "./types.ts";

interface TickState {
  seen: string[];
  applied: number;
}

// Counts what reached apply(). If the guard fires late, `applied` proves it.
const toy: FoldableModule<Record<string, never>, TickState> = {
  init: () => ({ seen: [], applied: 0 }),
  apply(state, event) {
    return { seen: [...state.seen, event.id], applied: state.applied + 1 };
  },
  outcome: () => null,
};

const lineups: LineupPair = {
  home: { entrantId: "H", slots: [{ personId: "p1", slot: "starting", orderNo: 1 }] },
  away: { entrantId: "A", slots: [{ personId: "p2", slot: "starting", orderNo: 1 }] },
};

let seq = 0;
function ev(payload: unknown, type = "toy.tick"): EventEnvelope {
  seq += 1;
  return {
    id: `e${seq}`,
    fixtureId: "f1",
    seq,
    type,
    payload,
    recordedAt: "2026-08-03T10:00:00.000Z",
    recordedBy: null,
  };
}

function at(period: string, elapsed: number) {
  return { at: { period, elapsed } };
}

const fold = (events: readonly EventEnvelope[]) => foldMatch(toy, {}, lineups, events);

describe("fold — monotonic time guard (§3.3)", () => {
  it("rejects a stamp that precedes the newest accepted stamp", () => {
    const events = [ev(at("P1", 800)), ev(at("P1", 500))];
    let caught: unknown;
    try {
      fold(events);
      expect.unreachable("backwards stamp should have been rejected");
    } catch (err) {
      caught = err;
    }
    expect(EngineError.is(caught, "NON_MONOTONIC_TIME")).toBe(true);
    // The data must name the offending seq and BOTH times, or the scorer
    // cannot tell which entry to correct.
    const data = (caught as EngineError).data as {
      eventId: string;
      seq: number;
      at: unknown;
      previous: unknown;
    };
    expect(data.eventId).toBe(events[1]?.id);
    expect(data.seq).toBe(events[1]?.seq);
    expect(data.at).toEqual({ period: "P1", elapsed: 500 });
    expect(data.previous).toEqual({ period: "P1", elapsed: 800 });
  });

  it("fires BEFORE dispatch, so the module never sees the offending event", () => {
    // An external spy, because the state the fold was building is discarded
    // with the throw — only a side channel can prove apply() was not called.
    const dispatched: string[] = [];
    const spy: FoldableModule<Record<string, never>, TickState> = {
      ...toy,
      apply(state, event) {
        dispatched.push(event.id);
        return toy.apply(state, event);
      },
    };
    const events = [ev(at("P1", 800)), ev(at("P1", 500))];
    expect(() => foldMatch(spy, {}, lineups, events)).toThrow(EngineError);
    expect(dispatched).toEqual([events[0]?.id]);
  });

  it("accepts a strictly increasing run and every equal stamp between them", () => {
    // Equal is LEGAL: two penalties at one whistle, a suspend/resume pair.
    const events = [
      ev(at("P1", 0)),
      ev(at("P1", 761)),
      ev(at("P1", 761)),
      ev(at("P1", 761)),
      ev(at("P1", 762)),
    ];
    expect(fold(events).applied).toBe(5);
  });

  it("treats an unseen period as later than every period seen so far", () => {
    // phaseOrder is order of FIRST APPEARANCE, so this is forward motion even
    // though "Q1" sorts after "H2" alphabetically and neither is declared.
    expect(fold([ev(at("H2", 900)), ev(at("Q1", 5)), ev(at("OT", 0))]).applied).toBe(3);
  });

  it("rejects a return to a period already left behind", () => {
    const events = [ev(at("P1", 10)), ev(at("P2", 5)), ev(at("P1", 900))];
    expect(() => fold(events)).toThrow(EngineError);
    try {
      fold(events);
      expect.unreachable("returning to P1 after P2 should have been rejected");
    } catch (err) {
      expect(EngineError.is(err, "NON_MONOTONIC_TIME")).toBe(true);
      // NOT UNKNOWN_PHASE: the guard registers the period before comparing, so
      // that error can never escape the fold.
      expect(EngineError.is(err, "UNKNOWN_PHASE")).toBe(false);
    }
  });

  it("leaves unstamped events unconstrained — they neither advance nor are checked", () => {
    // The unstamped event between two stamps is legal wherever it sits, and it
    // does not move the high-water mark.
    expect(fold([ev(at("P1", 500)), ev({ note: "x" }), ev(at("P1", 900))]).applied).toBe(3);
    // A payload whose `at` is not a GameTime is unstamped, not invalid.
    expect(
      fold([
        ev(at("P1", 900)),
        ev({ at: "14:00" }),
        ev({ at: { period: "P1", elapsed: -1 } }),
        ev({ at: { period: "P1", elapsed: 1, extra: 1 } }),
        ev(at("P1", 901)),
      ]).applied,
    ).toBe(5);
  });

  it("still rejects a backwards stamp across an unstamped interruption", () => {
    expect(() => fold([ev(at("P2", 900)), ev({ note: "x" }), ev(at("P2", 100))])).toThrow(
      EngineError,
    );
  });

  it("ADDITIVE PROOF: a stream with no `at` anywhere folds exactly as before", () => {
    // Deep-equal against the literal pre-change result. If the guard ever
    // touches an unstamped stream — by throwing, by skipping, by reordering —
    // this is what catches it, independently of the golden corpora.
    const events = [
      ev({}, "core.start"),
      ev({ to: "home" }),
      ev({ text: "half time" }, "core.note"),
      ev({ reason: "floodlight failure" }, "core.suspend"),
      ev({}, "core.resume"),
      ev({ to: "away", clockRef: "14:00", minute: 63 }),
      ev({ to: "home" }),
    ];
    const state = fold(events);
    expect(state).toEqual({
      seen: [events[0]?.id, events[1]?.id, events[2]?.id, events[5]?.id, events[6]?.id],
      applied: 5,
    });
    // Guarantee 1 (determinism) is unchanged by the guard's bookkeeping.
    expect(fold(events)).toEqual(state);
  });

  it("keeps voided stamps out of the high-water mark", () => {
    // resolveVoids runs first, so a voided backwards stamp is simply not there
    // — and a voided FORWARD stamp must not keep constraining what follows.
    const early = ev(at("P1", 100));
    const late = ev(at("P1", 900));
    const voidLate: EventEnvelope = { ...ev({}, "core.void"), voids: late.id };
    expect(fold([early, late, voidLate, ev(at("P1", 200))]).applied).toBe(2);
  });
});
