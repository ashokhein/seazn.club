// Monotonic time guard in the fold kernel — W4a spec (#425) §3.3, §9.
// Written against a toy in-file sport so the guard is provably sport-agnostic:
// nothing below imports a real module, and the guard still orders these stamps.
import { describe, expect, it } from "vitest";
import { EngineError } from "./errors.ts";
import {
  CoreResume,
  CoreSuspend,
  foldMatch,
  foldMatchWithStoppage,
  type EventEnvelope,
  type FoldableModule,
} from "./events.ts";
import { GameTime } from "./time.ts";
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

  it("rejects a stamp in a phase the module never declared, as INVALID_EVENT", () => {
    // `at.period` is a free `z.string().min(1)`, so this is the commonest thing
    // a client can get wrong, not a module-side invariant: the scorer picked or
    // typed a period this sport does not have. INVALID_EVENT is what the rest
    // of the payload-validation layer answers with, and it is what lets the pad
    // say "retype it" instead of surfacing an internal-error page. UNKNOWN_PHASE
    // stays what `compareGameTime` raises when a CALLER's own list is missing a
    // period — a disagreement between two lists, not a typo.
    let caught: unknown;
    try {
      foldDeclared([ev(at("SO", 0))]);
      expect.unreachable("an undeclared phase must be rejected");
    } catch (err) {
      caught = err;
    }
    // Caught on the FIRST stamp, before any high-water mark exists — otherwise
    // the very first event in a stream could smuggle in an unorderable phase.
    expect(EngineError.is(caught, "INVALID_EVENT")).toBe(true);
    expect(EngineError.is(caught, "UNKNOWN_PHASE")).toBe(false);
    // The declared phases travel with the error, or the pad cannot tell the
    // scorer which periods this sport actually has.
    expect((caught as EngineError).data).toMatchObject({
      period: "SO",
      phaseOrder: ["P1", "P2", "P3", "OT"],
    });
    expect((caught as EngineError).message).toContain("SO");
    // ...and on a later one too.
    let later: unknown;
    try {
      foldDeclared([ev(at("P1", 0)), ev(at("SO", 0))]);
      expect.unreachable("an undeclared phase must be rejected");
    } catch (err) {
      later = err;
    }
    expect(EngineError.is(later, "INVALID_EVENT")).toBe(true);
  });

  it("rejects the bad stamp BEFORE dispatch, so the module never sees it", () => {
    const dispatched: string[] = [];
    const spy: FoldableModule<Record<string, never>, TickState> = {
      ...declaring,
      apply(state, event) {
        dispatched.push(event.id);
        return toy.apply(state, event);
      },
    };
    const events = [ev(at("P1", 0)), ev(at("SO", 0))];
    expect(() => foldMatch(spy, {}, lineups, events)).toThrow(EngineError);
    expect(dispatched).toEqual([events[0]?.id]);
  });

  // A declared order is only exhaustive if the module actually lists every
  // phase a stamp may name — nothing about `playPhases` makes that true by
  // construction. Two degenerate declarations made the guard silently useless
  // rather than loud, and neither was reachable by anything a scorer types, so
  // both are CONFIG_INVALID at fold start: they are facts about the module and
  // its cfg, knowable before the first event, and they stay wrong for every
  // event in the stream.
  describe("a degenerate declared order is refused, not tolerated", () => {
    const withPhases = (phases: readonly string[]): FoldableModule<
      Record<string, never>,
      TickState
    > => ({ ...toy, playPhases: () => phases });

    it("EMPTY: rejected rather than read as 'declares nothing'", () => {
      // Treating `[]` as absent would silently drop the module onto the
      // derive-from-the-stream fallback — the strictly weaker path §3.3 exists
      // to close — for exactly the cfg whose phase list came out empty. Read as
      // declared-and-exhaustive it was worse still: EVERY stamped event was
      // refused. Both readings hide a module bug; refusing it does not.
      let caught: unknown;
      try {
        foldMatch(withPhases([]), {}, lineups, [ev(at("P1", 10))]);
        expect.unreachable("an empty declared phase order must be rejected");
      } catch (err) {
        caught = err;
      }
      expect(EngineError.is(caught, "CONFIG_INVALID")).toBe(true);
    });

    it("EMPTY: refused at fold start, even for a stream with no stamps at all", () => {
      // The declaration is broken whether or not this particular stream happens
      // to exercise it. Failing only once a stamp arrives leaves the sport
      // working right up to the first pad that sends `at`.
      expect(() => foldMatch(withPhases([]), {}, lineups, [ev({ note: "x" })])).toThrow(
        EngineError,
      );
      expect(() => foldMatch(withPhases([]), {}, lineups, [])).toThrow(EngineError);
    });

    it("DUPLICATE: rejected, because indexOf orphans the later entry", () => {
      // `compareGameTime` orders by `indexOf`, so the second "P1" can never be
      // matched: two phases the module says are distinct sort as one, and every
      // comparison against the orphan is quietly wrong in a way no stream shows.
      let caught: unknown;
      try {
        foldMatch(withPhases(["P1", "P2", "P1"]), {}, lineups, [ev(at("P2", 10))]);
        expect.unreachable("a duplicated phase must be rejected");
      } catch (err) {
        caught = err;
      }
      expect(EngineError.is(caught, "CONFIG_INVALID")).toBe(true);
      expect((caught as EngineError).data).toMatchObject({ phaseOrder: ["P1", "P2", "P1"] });
    });

    it("still folds a healthy declaration untouched", () => {
      // Over-rejection guard: the check must not fire on the normal case.
      expect(foldMatch(withPhases(["P1", "P2"]), {}, lineups, [ev(at("P2", 1))]).applied).toBe(1);
    });
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

  // §1.2 — the flagship reason the model is game clock and not wall clock:
  // "how much GAME time did the stoppage consume?" is `resume.at − suspend.at`.
  // Unrepresentable while both payloads were strictObject with no `at`, and
  // unreachable while the guard sat below the two kernel-owned `continue`s.
  describe("core.suspend / core.resume carry a stamp (§1.2)", () => {
    const suspend = (payload: unknown) => ev(payload, "core.suspend");
    const resume = (payload: unknown) => ev(payload, "core.resume");

    it("accepts a stamped suspend/resume pair", () => {
      const events = [
        ev(at("P1", 400)),
        suspend({ reason: "floodlight failure", ...at("P1", 500) }),
        resume(at("P1", 500)),
        ev(at("P1", 600)),
      ];
      // Both kernel-owned events are still swallowed — only the two toy events
      // reach apply — but they no longer fail validation.
      expect(fold(events).applied).toBe(2);
    });

    it("keeps an EQUAL stamp on the pair legal — that is the canonical case", () => {
      // A clock-stop sport consumes zero game time in a stoppage, so equal is
      // not an edge case here, it is the normal reading.
      expect(fold([suspend(at("P2", 761)), resume(at("P2", 761))]).applied).toBe(0);
      // ...and a reason alongside the stamp is still fine.
      expect(
        fold([suspend({ reason: "crowd incident", ...at("P2", 761) }), resume(at("P2", 761))])
          .applied,
      ).toBe(0);
    });

    it("rejects a resume stamped BEFORE its suspend", () => {
      let caught: unknown;
      try {
        fold([suspend(at("P1", 900)), resume(at("P1", 300))]);
        expect.unreachable("a resume before its suspend must be rejected");
      } catch (err) {
        caught = err;
      }
      expect(EngineError.is(caught, "NON_MONOTONIC_TIME")).toBe(true);
    });

    it("advances the high-water mark, so a later sport event cannot precede the stoppage", () => {
      let caught: unknown;
      try {
        fold([suspend(at("P1", 900)), resume(at("P1", 900)), ev(at("P1", 100))]);
        expect.unreachable("a stamp before the stoppage must be rejected");
      } catch (err) {
        caught = err;
      }
      // NOT INVALID_EVENT: the pair validated, and its stamp counted. A bare
      // toThrow(EngineError) here passes for the wrong reason while `at` is
      // still absent from the two core schemas.
      expect(EngineError.is(caught, "NON_MONOTONIC_TIME")).toBe(true);
    });

    it("surfaces the suspend's stamp on the open stoppage", () => {
      // §1.2 names `resume.at − suspend.at` as the answer to "how much GAME
      // time did this stoppage consume?" — the wave's headline claim. The
      // stoppage carried only a reason and an eventId, so the suspend's stamp
      // was reachable only by re-scanning the raw ledger for that id, which is
      // the thing folding exists to spare a consumer. It rides on the fold's
      // OUTPUT now, so the pad renders "suspended at P2 12:41" and computes the
      // delta against the resume it is about to append, without the stream.
      const suspended = foldMatchWithStoppage(toy, {}, lineups, [
        ev(at("P2", 400)),
        suspend({ reason: "floodlight failure", ...at("P2", 761) }),
      ]);
      expect(suspended.stoppage).toEqual({
        reason: "floodlight failure",
        eventId: "e" + String(seq),
        at: { period: "P2", elapsed: 761 },
      });
      // The resume closes it, exactly as before — `at` does not keep it open.
      const resumed = foldMatchWithStoppage(toy, {}, lineups, [
        suspend(at("P2", 761)),
        resume(at("P2", 761)),
      ]);
      expect(resumed.stoppage).toBeNull();
    });

    it("omits `at` entirely on an unstamped stoppage", () => {
      // Additive: absent, not `undefined`. Every stoppage recorded before this
      // wave must produce the same object it produced then, key for key.
      const { stoppage } = foldMatchWithStoppage(toy, {}, lineups, [
        suspend({ reason: "rain" }),
      ]);
      expect(Object.keys(stoppage ?? {}).sort()).toEqual(["eventId", "reason"]);
    });

    it("leaves an UNSTAMPED suspend/resume pair exactly as it was", () => {
      // Additive: `at` is optional with no default, so every stoppage recorded
      // before this wave still folds, and still constrains nothing.
      expect(
        fold([ev(at("P1", 900)), suspend({ reason: "rain" }), resume({}), ev(at("P1", 950))])
          .applied,
      ).toBe(2);
    });
  });

  // §8 — a malformed stamp is fail-OPEN in the kernel: `gameTimeOf` returns
  // null for `{ period: "P1", elapsed: -1 }`, so the guard treats it as an
  // unstamped event rather than rejecting it. That is deliberate (core learns no
  // sport payload shapes), but it means the ONLY thing standing between a
  // corrupt stamp and the ledger is the schema on the payload that declared
  // `at`. So the contract is: reuse `GameTime` verbatim, never a hand-rolled
  // shape. These assertions hold today — they are here to keep holding, because
  // the two core payloads are the pattern the sport payloads copy (§5.x).
  describe("a payload that declares `at` uses the GameTime schema verbatim", () => {
    it("is the same schema object, not a look-alike", () => {
      expect(CoreSuspend.shape.at.unwrap()).toBe(GameTime);
      expect(CoreResume.shape.at.unwrap()).toBe(GameTime);
    });

    it.each([
      ["a negative elapsed", { period: "P1", elapsed: -1 }],
      ["a fractional elapsed", { period: "P1", elapsed: 1.5 }],
      ["an empty period label", { period: "", elapsed: 1 }],
      ["an extra key (GameTime is strict)", { period: "P1", elapsed: 1, half: 2 }],
      ["a string elapsed", { period: "P1", elapsed: "12:41" }],
    ])("refuses %s outright rather than folding it as unstamped", (_, bad) => {
      let caught: unknown;
      try {
        fold([ev({ at: bad }, "core.suspend")]);
        expect.unreachable("a malformed stamp must be refused by the payload schema");
      } catch (err) {
        caught = err;
      }
      // INVALID_EVENT, from validateCoreEvent — NOT silently accepted as an
      // unstamped event, which is what a hand-rolled `z.object` would do.
      expect(EngineError.is(caught, "INVALID_EVENT")).toBe(true);
    });
  });

  it("keeps voided stamps out of the high-water mark", () => {
    // resolveVoids runs first, so a voided backwards stamp is simply not there
    // — and a voided FORWARD stamp must not keep constraining what follows.
    const early = ev(at("P1", 100));
    const late = ev(at("P1", 900));
    const voidLate: EventEnvelope = { ...ev({}, "core.void"), voids: late.id };
    expect(fold([early, late, voidLate, ev(at("P1", 200))]).applied).toBe(2);
  });

  // The guard shares a loop with two older rejections, and on a stream where
  // two of them apply at once exactly one error reaches the scorer. Which one
  // is a contract — "play is suspended" and "the match is over" are both facts
  // about the stream that make the stamp irrelevant, so they win. Nothing
  // pinned this before; moving the guard up the loop would silently swap the
  // message a pad renders.
  describe("precedence against the older rejections", () => {
    // Decides the moment anything reaches apply().
    const deciding: FoldableModule<Record<string, never>, TickState> = {
      ...toy,
      outcome: (state) =>
        state.applied > 0 ? { kind: "win" as const, winner: "H", loser: "A" } : null,
    };

    it("ALREADY_DECIDED beats NON_MONOTONIC_TIME", () => {
      const events = [ev(at("P1", 900)), ev(at("P1", 100))];
      let caught: unknown;
      try {
        foldMatch(deciding, {}, lineups, events);
        expect.unreachable("a post-decision event must be rejected");
      } catch (err) {
        caught = err;
      }
      // Both conditions hold on the second event. The outcome is the older,
      // stronger fact: retyping the stamp would not make the event acceptable.
      expect(EngineError.is(caught, "ALREADY_DECIDED")).toBe(true);
      expect(EngineError.is(caught, "NON_MONOTONIC_TIME")).toBe(false);
    });

    it("WRONG_PHASE (play suspended) beats NON_MONOTONIC_TIME", () => {
      const events = [ev(at("P1", 900)), ev({ reason: "rain" }, "core.suspend"), ev(at("P1", 100))];
      let caught: unknown;
      try {
        fold(events);
        expect.unreachable("a sport event during a stoppage must be rejected");
      } catch (err) {
        caught = err;
      }
      // "resume or abandon first" is actionable; "your stamp went backwards"
      // sends the scorer to fix the wrong thing.
      expect(EngineError.is(caught, "WRONG_PHASE")).toBe(true);
      expect(EngineError.is(caught, "NON_MONOTONIC_TIME")).toBe(false);
    });

    it("INVALID_EVENT (core payload) beats NON_MONOTONIC_TIME", () => {
      // validateCoreEvent is first in the loop, and stays first: a payload that
      // is not a valid core event has no meaningful stamp to compare.
      const events = [
        ev(at("P1", 900)),
        { ...ev({ at: { period: "P1", elapsed: 100 }, bogus: true }, "core.resume") },
      ];
      let caught: unknown;
      try {
        fold(events);
        expect.unreachable("an invalid core payload must be rejected");
      } catch (err) {
        caught = err;
      }
      expect(EngineError.is(caught, "INVALID_EVENT")).toBe(true);
    });
  });

  // §4 says "correcting a stamp uses the existing `voids` machinery. No new
  // mechanism." The ledger is hash-chained append-only, so a correction is
  // void + re-append and the replacement lands LAST carrying an EARLIER `at`.
  // Whether that survives the guard was genuinely open. It does — but only up
  // to a limit, and the limit is what these tests pin.
  describe("correcting a mis-typed stamp (§4)", () => {
    const voidOf = (target: EventEnvelope): EventEnvelope => ({
      ...ev({}, "core.void"),
      voids: target.id,
    });

    it("WORKS: void the mis-typed stamp, then re-append the correction", () => {
      // The high-water mark is computed over POST-VOID order, because
      // resolveVoids runs before the fold — so the mis-typed 900 is simply not
      // there to be beaten, and the 600 replacement is forward of the 500
      // before it. This is the flow the pad's existing undo affordance already
      // produces, and it needs no carve-out.
      const good = ev(at("P1", 500));
      const mistyped = ev(at("P1", 900)); // meant 600
      const correction = ev(at("P1", 600));
      expect(fold([good, mistyped, voidOf(mistyped), correction]).applied).toBe(2);
    });

    it("REJECTS a correction re-appended while the mistake is still live", () => {
      // Ordering obligation, not a bug: void first, then re-append. The other
      // order is a scorer claiming play went backwards, which is the whole
      // point of the guard.
      const good = ev(at("P1", 500));
      const mistyped = ev(at("P1", 900));
      expect(() => fold([good, mistyped, ev(at("P1", 600))])).toThrow(EngineError);
    });

    it("THE LIMIT: a correction cannot be inserted BEHIND later live stamps", () => {
      // Both prior reviews were half right. Correcting the newest stamp works;
      // correcting an older one while later stamps are still live does not, and
      // it should not — the fold applies events in append order, so a stamp
      // that lands after 950 carrying 600 would sweep lazy expiry (§3.1)
      // against an order nothing agrees on. Exempting events near a void would
      // reintroduce exactly the bug the guard exists to prevent.
      const good = ev(at("P1", 500));
      const mistyped = ev(at("P1", 900)); // meant 600
      const later = ev(at("P1", 950));
      let caught: unknown;
      try {
        fold([good, mistyped, later, voidOf(mistyped), ev(at("P1", 600))]);
        expect.unreachable("a correction behind a live later stamp must be rejected");
      } catch (err) {
        caught = err;
      }
      expect(EngineError.is(caught, "NON_MONOTONIC_TIME")).toBe(true);
    });

    it("THE REMEDY: void back to the mistake, then re-append forward", () => {
      // Which is what an undo stack does anyway — the pad's undo is a void of
      // the last event. Void 950 and 900, re-enter 600 then 950.
      const good = ev(at("P1", 500));
      const mistyped = ev(at("P1", 900));
      const later = ev(at("P1", 950));
      expect(
        fold([
          good,
          mistyped,
          later,
          voidOf(later),
          voidOf(mistyped),
          ev(at("P1", 600)),
          ev(at("P1", 950)),
        ]).applied,
      ).toBe(3);
    });
  });
});

// ---------------------------------------------------------------------------
// W4a (#425) T9 — the strict-on-write / tolerant-on-replay seam (§3.3).
//
// WHY THIS EXISTS. `foldMatch` is the ONLY state-derivation function, and it is
// the write gate too: `append-event.ts` validates a candidate by folding the
// WHOLE stream including it, through the same fold, against a cfg it rebuilds
// live from `division.config` on every call. Two consequences compose:
//
//  1. every check in the fold ran identically on write and on read, so
//     "refuse this on the write path only" was not expressible; and
//  2. every READ replays from `init`, so a refusal computed from cfg fires on
//     events already in the ledger the moment an organiser edits the config —
//     with no event to void and no scorer action that recovers the fixture.
//
// The phase guard above is exactly that shape: it reads `playPhases(cfg)`, and
// lowering `bestOf`, cutting an overtime period or renaming a phase makes every
// already-recorded fixture in the division throw on every read. Its own comment
// reasons entirely about write time ("a typo or a stale pad") — true of a NEW
// event, false of HISTORY.
//
// `strictFromSeq` is the seam. It says which events are not yet in the ledger:
// those get full validation, everything before them is replayed. One fold, one
// traversal, no module signature change forced on the eleven sports.
// ---------------------------------------------------------------------------
describe("strict on write, tolerant on replay (§3.3 seam)", () => {
  interface PhaseCfg {
    phases: readonly string[];
  }

  // A module whose phase order comes OUT OF CFG — which is what makes the
  // hazard reachable. `declaring` above hard-codes its list, so no config edit
  // can shrink it; every real module derives the list from cfg (football from
  // `extraTime.enabled` / `shootout`, the period kernel from `periods.count`,
  // nested from `bestOf`).
  const cfgDriven: FoldableModule<PhaseCfg, TickState> = {
    ...toy,
    playPhases: (cfg) => [...cfg.phases],
  };

  const WIDE: PhaseCfg = { phases: ["P1", "P2", "P3", "OT"] };
  // The same division after an organiser cut overtime and the third period.
  const NARROWED: PhaseCfg = { phases: ["P1", "P2"] };

  it("a cfg that no longer has a recorded period leaves the fixture READABLE", () => {
    // Recorded under the wide cfg — every stamp legal at the time.
    const stream = [ev(at("P1", 10)), ev(at("P2", 20)), ev(at("P3", 30)), ev(at("OT", 5))];
    expect(foldMatch(cfgDriven, WIDE, lineups, stream).applied).toBe(4);

    // Same stream, narrowed cfg, read path (no options). Two of those periods
    // no longer exist. It must still fold: there is no event to void here, so a
    // throw is a permanently unviewable fixture.
    expect(foldMatch(cfgDriven, NARROWED, lineups, stream).applied).toBe(4);
  });

  it("registers the vanished period rather than dropping the event", () => {
    // Tolerating is not ignoring. The unknown phase joins the order the way the
    // undeclared-module fallback already does, so the events still reach the
    // module and still fold — `applied` counts dispatches, and a guard that
    // silently skipped them would read 0 here.
    const stream = [ev(at("P3", 30)), ev(at("P3", 31))];
    expect(foldMatch(cfgDriven, NARROWED, lineups, stream).applied).toBe(2);
  });

  it("STILL REFUSES the candidate by name, while tolerating its history", () => {
    // The seam in one fold: the same phase guard, two verdicts. This is the
    // case that fails whichever half you drop — tolerate everything and a pad
    // typo becomes permanent; refuse everything and the fixture bricks.
    const history = [ev(at("P1", 10)), ev(at("P3", 30))]; // P3 no longer in cfg
    const candidate = ev(at("QQ", 0)); // a typo the scorer just made
    let caught: unknown;
    try {
      foldMatch(cfgDriven, NARROWED, lineups, [...history, candidate], {
        strictFromSeq: candidate.seq,
      });
      expect.unreachable("the candidate's typo must still be refused");
    } catch (err) {
      caught = err;
    }
    expect(EngineError.is(caught, "INVALID_EVENT")).toBe(true);
    // THE ASSERTION THAT MAKES THIS TEST NON-VACUOUS. Before the seam the fold
    // threw on the HISTORY (P3) and never reached the candidate, so a bare
    // `code` check was already green. The eventId is what says WHICH event was
    // refused, and it must be the new one.
    const data = (caught as EngineError).data as { eventId: string; period: string };
    expect(data.eventId).toBe(candidate.id);
    expect(data.period).toBe("QQ");
    // And it must still name the phases, or the pad cannot tell the scorer what
    // to retype. The list carries the recorded-but-unlisted P3 as well as the
    // two the cfg declares — refusing to name a period the fold has just
    // accepted out of history would be lying to the scorer.
    expect((caught as EngineError).message).toContain("QQ");
    expect((caught as EngineError).message).toContain("P1, P2, P3");
  });

  it("keeps the typo message and code for a NEW event under an unedited cfg", () => {
    // The regression guard on the earlier fix: raising INVALID_EVENT (not the
    // internal UNKNOWN_PHASE) and naming the valid phases is what turned a
    // typo from a 500-and-a-page into something a scorer can retype.
    const candidate = ev(at("SO", 0));
    let caught: unknown;
    try {
      foldMatch(cfgDriven, WIDE, lineups, [ev(at("P1", 0)), candidate], {
        strictFromSeq: candidate.seq,
      });
      expect.unreachable("an undeclared phase on a NEW event must be rejected");
    } catch (err) {
      caught = err;
    }
    expect(EngineError.is(caught, "INVALID_EVENT")).toBe(true);
    expect(EngineError.is(caught, "UNKNOWN_PHASE")).toBe(false);
    expect((caught as EngineError).data).toMatchObject({
      period: "SO",
      phaseOrder: ["P1", "P2", "P3", "OT"],
    });
    expect((caught as EngineError).message).toContain(
      'is stamped in period "SO", which this sport does not have — expected one of P1, P2, P3, OT',
    );
  });

  it("tolerates an order a cfg edit turned BACKWARDS, and still refuses a new one", () => {
    // The monotonic guard orders against `playPhases(cfg)` too, so it is the
    // same hazard by another door: P2-then-P3 is forward under the wide cfg and
    // unorderable once P3 is gone. Appending the vanished phase at the end of
    // the order is not enough on its own — the NEXT recorded stamp then sorts
    // before it — so replay must not raise here either.
    const stream = [ev(at("P1", 10)), ev(at("P3", 30)), ev(at("P2", 20))];
    expect(foldMatch(cfgDriven, NARROWED, lineups, stream).applied).toBe(3);

    // A genuinely backwards NEW stamp is still refused, under the same cfg.
    const candidate = ev(at("P1", 1));
    let caught: unknown;
    try {
      foldMatch(cfgDriven, NARROWED, lineups, [ev(at("P2", 900)), candidate], {
        strictFromSeq: candidate.seq,
      });
      expect.unreachable("a backwards stamp on a NEW event must be rejected");
    } catch (err) {
      caught = err;
    }
    expect(EngineError.is(caught, "NON_MONOTONIC_TIME")).toBe(true);
    expect((caught as EngineError).data).toMatchObject({ eventId: candidate.id });
  });

  it("does not let a tolerated backwards stamp drag the high-water mark back", () => {
    // Replay accepts the out-of-order history, but the mark it leaves for the
    // candidate is the furthest-forward stamp, not the last one seen. Otherwise
    // tolerating history would quietly weaken the guard for the new event.
    const candidate = ev(at("P2", 100));
    let caught: unknown;
    try {
      foldMatch(cfgDriven, NARROWED, lineups, [ev(at("P2", 900)), ev(at("P1", 5)), candidate], {
        strictFromSeq: candidate.seq,
      });
      expect.unreachable("the candidate is behind the furthest-forward stamp");
    } catch (err) {
      caught = err;
    }
    expect(EngineError.is(caught, "NON_MONOTONIC_TIME")).toBe(true);
    expect((caught as EngineError).data).toMatchObject({
      eventId: candidate.id,
      previous: { period: "P2", elapsed: 900 },
    });
  });

  it("tells the MODULE which events are new, so its own cfg checks can follow", () => {
    // The core guard is one instance of the shape; period/kernel, football and
    // nested each re-validate the stamp inside `apply()` because `apply` is
    // called directly by the testkit. They need the same signal or the seam
    // stops at the kernel boundary.
    const seen: { id: string; strict: boolean | undefined }[] = [];
    const spy: FoldableModule<PhaseCfg, TickState> = {
      ...cfgDriven,
      apply(state, event, ctx) {
        seen.push({ id: event.id, strict: ctx?.strict });
        return toy.apply(state, event);
      },
    };
    const a = ev(at("P1", 1));
    const b = ev(at("P1", 2));
    const c = ev(at("P1", 3));
    foldMatch(spy, WIDE, lineups, [a, b, c], { strictFromSeq: c.seq });
    expect(seen).toEqual([
      { id: a.id, strict: false },
      { id: b.id, strict: false },
      { id: c.id, strict: true },
    ]);

    // A read path passes no options at all, and then NOTHING is strict — that
    // is the fail-safe direction: a caller that forgets cannot brick a fixture,
    // it can only under-validate a write it was never making.
    seen.length = 0;
    foldMatch(spy, WIDE, lineups, [a, b, c]);
    expect(seen.map((s) => s.strict)).toEqual([false, false, false]);
  });

  it("carries the seam through foldMatchWithStoppage as well", () => {
    // The two entry points must not diverge: the stoppage variant is what the
    // read side calls for "is play suspended right now?".
    const stream = [ev(at("P3", 30))];
    expect(foldMatchWithStoppage(cfgDriven, NARROWED, lineups, stream).state.applied).toBe(1);
    const candidate = ev(at("QQ", 0));
    expect(() =>
      foldMatchWithStoppage(cfgDriven, NARROWED, lineups, [candidate], {
        strictFromSeq: candidate.seq,
      }),
    ).toThrow(EngineError);
  });
});
