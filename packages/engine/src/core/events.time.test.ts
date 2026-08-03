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

// The same toy, but declaring its phase order the way a real sport module does
// (`playPhases`, period/kernel.ts:366). This is the module the guard should
// believe over anything it could infer from the stream.
const declaring: FoldableModule<Record<string, never>, TickState> = {
  ...toy,
  playPhases: () => ["P1", "P2", "P3", "OT"],
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
const foldDeclared = (events: readonly EventEnvelope[]) =>
  foldMatch(declaring, {}, lineups, events);

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

  it("takes phase order from the module's declared playPhases, not order of appearance", () => {
    // THE fail-open this replaces, and the commonest manual-entry mistake there
    // is: a scorer keys the second-half event first. Deriving the order from
    // first appearance made "P2 100 then P1 50" FORWARD motion — P1 was unseen,
    // so it was appended as the later phase — which is exactly the backwards
    // stamp the guard exists to reject. The module knows P1 precedes P2; the
    // stream cannot.
    const events = [ev(at("P2", 100)), ev(at("P1", 50))];
    let caught: unknown;
    try {
      foldDeclared(events);
      expect.unreachable("a stamp in an earlier declared phase must be rejected");
    } catch (err) {
      caught = err;
    }
    expect(EngineError.is(caught, "NON_MONOTONIC_TIME")).toBe(true);
    expect((caught as EngineError).data).toMatchObject({ eventId: events[1]?.id });
  });

  it("still accepts genuine forward motion under the declared order", () => {
    // Honest label: this passes with or without the declared-order change,
    // because derivation is strictly the more permissive of the two. It is here
    // as an over-rejection guard on the new code path, not as proof of it.
    expect(foldDeclared([ev(at("P2", 900)), ev(at("P3", 5)), ev(at("OT", 0))]).applied).toBe(3);
  });

  it("rejects a stamp in a phase the module never declared (UNKNOWN_PHASE)", () => {
    // A declared order is exhaustive by construction. A period outside it means
    // the module accepted an event in a phase it does not list — an internal
    // invariant, not something the scorer typed, so it is UNKNOWN_PHASE rather
    // than a silent arbitrary sort that would make lazy expiry wrong.
    let caught: unknown;
    try {
      foldDeclared([ev(at("SO", 0))]);
      expect.unreachable("an undeclared phase must be rejected");
    } catch (err) {
      caught = err;
    }
    // Caught on the FIRST stamp, before any high-water mark exists — otherwise
    // the very first event in a stream could smuggle in an unorderable phase.
    expect(EngineError.is(caught, "UNKNOWN_PHASE")).toBe(true);
    // ...and on a later one too.
    expect(() => foldDeclared([ev(at("P1", 0)), ev(at("SO", 0))])).toThrow(EngineError);
  });

  it("FALLBACK ONLY: derives order of first appearance when the module declares none", () => {
    // Kept deliberately, and it is weaker than the declared path: with no
    // playPhases there is nothing to consult, so an unseen period is treated as
    // later than every period seen so far. Modules that care declare.
    expect(fold([ev(at("H2", 900)), ev(at("Q1", 5)), ev(at("OT", 0))]).applied).toBe(3);
    // The derived path never raises UNKNOWN_PHASE: a period is registered
    // before it is compared, so the error cannot escape the fold.
    expect(fold([ev(at("SO", 0)), ev(at("SO", 1))]).applied).toBe(2);
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
