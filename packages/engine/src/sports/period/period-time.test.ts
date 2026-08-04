// Period kernel, game-time model — W4a (#425) §3, §5.1, §7, §8.
//
// What this suite pins, and why each one is here rather than assumed:
//
//  - LAZY SWEEP (§3.1). A suspension expires when the next STAMPED event
//    arrives, never on wall time. An unstamped event sweeps nothing, which is
//    what keeps every stream recorded before this wave folding as it did.
//  - CROSS-PERIOD CARRY. The naive "does not expire across a boundary" reading
//    is not merely incomplete, it is backwards: a minor at 19:10 of a 20-minute
//    period would carry an `expiresAt` of {P1, 1270}, which sorts BEFORE every
//    P2 stamp, so the first stamped P2 event sweeps it and the penalty is
//    UNDER-served. With `cfg.periodSeconds` the remainder carries into P2.
//  - BOUNDARY SWEEP. Without a sweep at `period.advance` and at full time, a
//    penalty whose expiry passed before the whistle survives into the final
//    state and `strengthOf`/`strengthChip` render a side short-handed at FT —
//    every summary and tally over `state.suspensions` then reads wrong.
//  - THE SWEEP NEVER THROWS `UNKNOWN_PHASE`. cfg is read LIVE from
//    `division.config` at fold time, so renaming a period after a match was
//    scored would make a recorded `at.period` unknown; a throwing sweep makes
//    that fixture permanently unviewable rather than merely stale.
//  - RELEASE-ON-GOAL is gated on BOTH the goal and the suspension carrying
//    time. That gate is what keeps the eleven frozen goldens byte-identical:
//    no recorded stream carries `at`, so nothing releases that did not before.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { EngineError } from "../../core/errors.ts";
import { foldMatch, type EventEnvelope } from "../../core/events.ts";
import { compareGameTime, gameTimeOf } from "../../core/time.ts";
import { buildStream, defaultLineupPair, makeEnvelope } from "../../testkit/helpers.ts";
import type { ModuleEvent } from "../../sport/module.ts";
import { icehockey } from "../icehockey/icehockey.ts";
import { hockey } from "../hockey/hockey.ts";
import {
  PeriodAdvance,
  PeriodEv,
  PeriodGoal,
  PeriodSetPiece,
  PeriodShootoutAttempt,
  PeriodSuspensionEnd,
  PeriodSuspensionStart,
  type PeriodCfg,
  type PeriodState,
} from "./kernel.ts";

const iceLineups = defaultLineupPair(icehockey.positions);
const fihLineups = defaultLineupPair(hockey.positions);
const IH = iceLineups.home.entrantId;
const IA = iceLineups.away.entrantId;
const FH = fihLineups.home.entrantId;

const start: ModuleEvent = { type: "core.start", payload: {} };

function envelopes(events: ModuleEvent[]): EventEnvelope[] {
  return events.map((event, i) => makeEnvelope(i, event));
}

const iceCfg = (raw: unknown = {}): PeriodCfg => icehockey.configSchema.parse(raw) as PeriodCfg;
const fihCfg = (raw: unknown = {}): PeriodCfg => hockey.configSchema.parse(raw) as PeriodCfg;

function foldIce(events: ModuleEvent[], cfg: PeriodCfg = iceCfg()): PeriodState {
  return foldMatch(icehockey, cfg, iceLineups, envelopes(events)) as PeriodState;
}
function foldFih(events: ModuleEvent[], cfg: PeriodCfg = fihCfg()): PeriodState {
  return foldMatch(hockey, cfg, fihLineups, envelopes(events)) as PeriodState;
}

const at = (period: string, elapsed: number) => ({ period, elapsed });

// summary.detail is deliberately loose (`Record<string, unknown>`-ish) on the
// module contract, so the strength chip is read through one narrow helper
// rather than a cast at every call site.
const strengthOf = (summary: { detail?: unknown }): string | null =>
  (summary.detail as { strength?: string | null }).strength ?? null;

const iceGoal = (by: string, extra: Record<string, unknown> = {}): ModuleEvent => ({
  type: "icehockey.goal",
  payload: { by, ...extra },
});
const iceCard = (by: string, cls: string, extra: Record<string, unknown> = {}): ModuleEvent => ({
  type: "icehockey.suspension.start",
  payload: { by, class: cls, ...extra },
});
const iceAdvance = (to: string, extra: Record<string, unknown> = {}): ModuleEvent => ({
  type: "icehockey.period.advance",
  payload: { to, ...extra },
});

// ---------------------------------------------------------------- lazy sweep

describe("lazy expiry sweeps at the next stamped event (§3.1)", () => {
  it("a stamped event past the expiry releases the suspension", () => {
    const state = foldIce([
      start,
      iceCard(IA, "minor", { at: at("P1", 100) }),
      // 2:00 from 100 ⇒ 220. A goal at 300 is past it.
      iceGoal(IH, { at: at("P1", 300) }),
    ]);
    expect(state.suspensions).toEqual([]);
  });

  it("a stamped event before the expiry leaves it running, with the derived expiry on state", () => {
    // The card is against the side that scores, so release-on-goal cannot fire
    // and the only thing under test is the derived expiry.
    const state = foldIce([
      start,
      iceCard(IH, "minor", { at: at("P1", 100) }),
      iceGoal(IH, { at: at("P1", 150) }),
    ]);
    expect(state.suspensions.length).toBe(1);
    expect(state.suspensions[0]?.startedAt).toEqual(at("P1", 100));
    expect(state.suspensions[0]?.expiresAt).toEqual(at("P1", 220));
  });

  it("an UNSTAMPED event sweeps nothing — the pad and the fold legitimately disagree", () => {
    const state = foldIce([
      start,
      iceCard(IA, "minor", { at: at("P1", 100) }),
      iceGoal(IH), // no `at`: the fold learns no time has passed
    ]);
    expect(state.suspensions.length).toBe(1);
  });

  it("an explicit end at or after the expiry is still accepted, not INVALID_EVENT", () => {
    // Sweep-then-apply would have removed the suspension before the end event
    // looked for it, so a pad that sends both is refused for doing the right
    // thing. The end runs first for exactly this reason.
    const state = foldIce([
      start,
      iceCard(IA, "minor", { at: at("P1", 100) }),
      {
        type: "icehockey.suspension.end",
        payload: { by: IA, class: "minor", at: at("P1", 220) },
      },
    ]);
    expect(state.suspensions).toEqual([]);
  });

  it("records the newest stamp as State.asOf, absent until the first one", () => {
    const unstamped = foldIce([start, iceGoal(IH)]);
    expect(Object.hasOwn(unstamped, "asOf")).toBe(false);
    const stamped = foldIce([start, iceGoal(IH, { at: at("P1", 42) })]);
    expect(stamped.asOf).toEqual(at("P1", 42));
  });
});

// ------------------------------------------------------------- carry-over

describe("a penalty crossing the buzzer carries into the next period", () => {
  const cfg = iceCfg({ periodSeconds: { P1: 1200, P2: 1200, P3: 1200, OT: 300 } });

  // The penalty is against the side that SCORES below, deliberately: a goal
  // releases only the CONCEDING side's minor, so nothing here can be removed by
  // release-on-goal and the sweep is tested in isolation.
  const carried = (tail: ModuleEvent[]): PeriodState =>
    foldIce([start, iceCard(IH, "minor", { at: at("P1", 1150) }), iceAdvance("P2"), ...tail], cfg);

  it("a minor at 19:10 of a 20-minute period expires 70s into P2", () => {
    expect(carried([]).suspensions[0]?.expiresAt).toEqual(at("P2", 70));
  });

  it("is NOT swept by the first stamped P2 event, and is still running 50s in", () => {
    // The naive in-period expiry {P1, 1270} sorts before EVERY P2 stamp, so
    // this is the exact event that would under-serve the penalty.
    const state = carried([iceGoal(IH, { at: at("P2", 50) })]);
    expect(state.suspensions.length).toBe(1);
  });

  it("is swept once P2 passes the carried expiry", () => {
    expect(carried([iceGoal(IH, { at: at("P2", 100) })]).suspensions).toEqual([]);
  });

  it("carries with NO periodSeconds at all — the length comes from cfg.periods", () => {
    // `cfg.periodSeconds` duplicated an authority the cfg already holds:
    // `periods.minutes` is required and fixes every regulation phase, and
    // `overtime.minutes` every OT phase. Deriving the length there removes the
    // whole "competition declared no length, so the penalty is under-served"
    // limitation instead of documenting it.
    const state = foldIce([start, iceCard(IA, "minor", { at: at("P1", 1150) })]);
    expect(state.suspensions[0]?.expiresAt).toEqual(at("P2", 70));
  });

  it("derives the OT length from cfg.overtime, not from periodSeconds", () => {
    // A 5:00 major at 19:10 of P3 owes 250 s of the 5-minute sudden-death OT.
    const state = foldIce([
      start,
      iceAdvance("P2"),
      iceAdvance("P3"),
      iceCard(IA, "major", { at: at("P3", 1150) }),
    ]);
    expect(state.suspensions[0]?.expiresAt).toEqual(at("OT", 250));
  });

  it("a UNIFORM periodSeconds map cannot contradict the cfg scalar it duplicates", () => {
    // The proven bug: {P1:60,P2:60,P3:60} against periods.minutes 20 carried a
    // 2:00 minor three phases downfield. A map that gives every phase in a
    // group the SAME value states nothing `periods.minutes` does not already
    // state, so where it disagrees it is duplicated authority rather than a
    // refinement, and the required scalar wins.
    const cfg = iceCfg({ periodSeconds: { P1: 60, P2: 60, P3: 60 } });
    const state = foldIce([start, iceCard(IA, "minor", { at: at("P1", 10) })], cfg);
    expect(state.suspensions[0]?.expiresAt).toEqual(at("P1", 130));
  });

  it("but an UNEQUAL map is honoured — the one thing the cfg scalar cannot express", () => {
    // `periods.minutes` is a single scalar for all n periods, so a competition
    // whose third period is shorter has nowhere else to say so.
    const cfg = iceCfg({ periodSeconds: { P1: 1200, P2: 1200, P3: 900 } });
    const state = foldIce(
      [start, iceAdvance("P2"), iceAdvance("P3"), iceCard(IA, "minor", { at: at("P3", 850) })],
      cfg,
    );
    expect(state.suspensions[0]?.expiresAt).toEqual(at("OT", 70));
  });
});

// ---------------------------------------------------------- boundary sweep

describe("the whistle sweeps too (period.advance and full time)", () => {
  it("period.advance releases a suspension whose expiry passed before the buzzer", () => {
    const state = foldIce([start, iceCard(IA, "minor", { at: at("P1", 100) }), iceAdvance("P2")]);
    expect(state.suspensions).toEqual([]);
  });

  it("full time releases it, so the strength chip is right in the final state", () => {
    const events = [
      start,
      iceAdvance("P2"),
      iceAdvance("P3"),
      iceCard(IA, "minor", { at: at("P3", 100) }),
      iceGoal(IH, { at: at("P3", 150) }),
      iceAdvance("FT"),
    ];
    const state = foldIce(events);
    expect(state.outcome).toEqual({ kind: "win", winner: IH, loser: IA, method: "regulation" });
    expect(state.suspensions).toEqual([]);
    expect(strengthOf(icehockey.summary(state))).toBeNull();
  });

  it("a penalty carried into the NEXT period survives the advance", () => {
    const cfg = iceCfg({ periodSeconds: { P1: 1200, P2: 1200, P3: 1200, OT: 300 } });
    const state = foldIce(
      [start, iceCard(IA, "minor", { at: at("P1", 1150) }), iceAdvance("P2")],
      cfg,
    );
    expect(state.suspensions.length).toBe(1);
    expect(strengthOf(icehockey.summary(state))).toBe("5v4");
  });

  it("a suspension with no stamp is untouched by the whistle", () => {
    const state = foldIce([start, iceCard(IA, "minor"), iceAdvance("P2")]);
    expect(state.suspensions.length).toBe(1);
  });

  it("a penalty carried into an overtime that is NEVER PLAYED is swept at full time", () => {
    // The whistle sweep alone is not enough: it drops only expiries indexed at
    // or before the phase being closed, and a 5:00 major at P3 19:10 carries to
    // {OT, 250}. With the game 1–0 the FT advance decides in regulation, OT is
    // never played, and the major runs on into `done` — a 5v4 chip at FULL
    // TIME, in the state every consumer reads.
    const state = foldIce(
      [
        start,
        iceAdvance("P2"),
        iceAdvance("P3"),
        iceGoal(IH, { at: at("P3", 10) }),
        iceCard(IA, "major", { at: at("P3", 1150) }),
        iceAdvance("FT", { at: at("P3", 1200) }),
      ],
      // Declared explicitly so this fails for its OWN reason: with the lengths
      // absent the expiry never leaves P3 and the phase sweep hides the defect.
      iceCfg({ periodSeconds: { P1: 1200, P2: 1200, P3: 1200, OT: 300 } }),
    );
    expect(state.outcome).toEqual({ kind: "win", winner: IH, loser: IA, method: "regulation" });
    expect(state.suspensions).toEqual([]);
    expect(strengthOf(icehockey.summary(state))).toBeNull();
  });

  it("a sudden-death overtime goal ends the match with nobody still serving time", () => {
    // Same defect, reached through `decideWin` rather than the FT advance: the
    // OT goal decides instantly and a running timed minor survived into `done`.
    const state = foldIce([
      start,
      iceAdvance("P2"),
      iceAdvance("P3"),
      iceAdvance("FT"), // 0–0 ⇒ OT
      iceCard(IA, "major", { at: at("OT", 10) }),
      iceGoal(IH, { at: at("OT", 20) }),
    ]);
    expect(state.outcome).toMatchObject({ kind: "win", winner: IH, method: "extra_time" });
    expect(state.suspensions).toEqual([]);
  });

  it("but an UNSTAMPED suspension still stands at full time, exactly as before", () => {
    // The end-of-match sweep drops TIMED suspensions only. A card with no stamp
    // has no expiry to have run out, and every one of the eleven frozen goldens
    // is made of exactly those — sweeping them would not be additive.
    const state = foldIce([
      start,
      iceAdvance("P2"),
      iceAdvance("P3"),
      iceGoal(IH),
      iceCard(IA, "major"),
      iceAdvance("FT"),
    ]);
    expect(state.suspensions.length).toBe(1);
    expect(strengthOf(icehockey.summary(state))).toBe("5v4");
  });
});

// --------------------------------------------------- unknown period is inert

describe("an unrecognised period never throws out of the sweep", () => {
  it("a stored expiry in a period this cfg no longer has simply does not expire", () => {
    // cfg is read LIVE from division.config at fold time, so renaming a period
    // (3 periods → 2 halves) after a match was scored makes a recorded label
    // unknown. UNKNOWN_PHASE here would make the fixture unviewable forever.
    const base = foldIce([start, iceCard(IH, "minor", { at: at("P1", 100) })]);
    const stale: PeriodState = {
      ...base,
      suspensions: base.suspensions.map((s) => ({ ...s, expiresAt: at("Q9", 1) })),
    };
    const ev = makeEnvelope(9, iceGoal(IH, { at: at("P1", 900) }));
    const next = icehockey.apply(stale as never, ev as never) as PeriodState;
    expect(next.suspensions.length).toBe(1);
  });

  it("but an INCOMING stamp naming a period this sport does not have is INVALID_EVENT", () => {
    // §7 obligation, module half: the kernel's own path agrees with the fold
    // guard rather than trusting it to have run.
    const base = foldIce([start]);
    const ev = makeEnvelope(9, iceGoal(IH, { at: at("Q1", 10) }));
    let caught: unknown;
    try {
      icehockey.apply(base as never, ev as never);
      expect.unreachable("an undeclared period must be refused");
    } catch (err) {
      caught = err;
    }
    expect(EngineError.is(caught, "INVALID_EVENT")).toBe(true);
    // Named phases, not a bare rejection: today a stamp in "Q1" is refused only
    // because `at` is an unknown key on a strict payload, which tells a scorer
    // nothing. The module owes the same message the fold guard gives.
    expect((caught as EngineError).data).toMatchObject({ period: "Q1" });
    expect(String((caught as EngineError).message)).toContain("P1");
  });
});

// -------------------------------------------------------- release on goal

describe("release-on-goal — the IIHF powerplay rule (§3.4)", () => {
  const cardThenGoal = (
    cardExtra: Record<string, unknown>,
    goalBy: string,
    goalExtra: Record<string, unknown>,
    cls = "minor",
  ): PeriodState =>
    foldIce([start, iceCard(IA, cls, cardExtra), iceGoal(goalBy, goalExtra)]);

  it("a stamped goal releases the conceding side's earliest running minor", () => {
    const state = cardThenGoal({ at: at("P1", 100) }, IH, { at: at("P1", 200) });
    expect(state.suspensions).toEqual([]);
  });

  it("does nothing when the GOAL carries no stamp", () => {
    const state = cardThenGoal({ at: at("P1", 100) }, IH, {});
    expect(state.suspensions.length).toBe(1);
  });

  it("does nothing when the SUSPENSION carries no stamp", () => {
    const state = cardThenGoal({}, IH, { at: at("P1", 200) });
    expect(state.suspensions.length).toBe(1);
  });

  it("does not release the SCORING side's own penalty", () => {
    const state = foldIce([
      start,
      iceCard(IA, "minor", { at: at("P1", 100) }),
      iceGoal(IA, { at: at("P1", 200) }),
    ]);
    expect(state.suspensions.length).toBe(1);
  });

  it("an own goal releases the side that CONCEDED, not the side that struck it", () => {
    // The DisciplineCard.entrantSide trap, one layer down: `by` and `credited`
    // are both a Side and they disagree exactly here.
    const state = foldIce([
      start,
      iceCard(IH, "minor", { at: at("P1", 100) }),
      iceGoal(IH, { kind: "og", at: at("P1", 200) }),
    ]);
    expect(state.suspensions).toEqual([]);
  });

  it("releases only the earliest of two running minors", () => {
    const state = foldIce([
      start,
      iceCard(IA, "minor", { at: at("P1", 100) }),
      iceCard(IA, "minor", { at: at("P1", 150) }),
      iceGoal(IH, { at: at("P1", 200) }),
    ]);
    expect(state.suspensions.length).toBe(1);
    expect(state.suspensions[0]?.startedAt).toEqual(at("P1", 150));
  });

  it("does not release a major", () => {
    const state = cardThenGoal({ at: at("P1", 100) }, IH, { at: at("P1", 200) }, "major");
    expect(state.suspensions.length).toBe(1);
  });

  it("releases the minor with the LEAST TIME REMAINING, not the first one pushed", () => {
    // IIHF Rule 20.4 terminates the penalty closest to expiry. Push order is
    // start order, and start order is not remaining order the moment an umpire
    // awards a duration other than the class nominal: a 5:00 minor at 100
    // expires at 400, a 2:00 minor at 200 expires at 320.
    const state = foldIce([
      start,
      iceCard(IA, "minor", { minutes: 5, at: at("P1", 100) }),
      iceCard(IA, "minor", { at: at("P1", 200) }),
      iceGoal(IH, { at: at("P1", 250) }),
    ]);
    expect(state.suspensions.length).toBe(1);
    expect(state.suspensions[0]?.expiresAt).toEqual(at("P1", 400));
  });

  it("ties on remaining time fall back to push order", () => {
    const state = foldIce([
      start,
      iceCard(IA, "minor", { minutes: 4, at: at("P1", 100) }),
      iceCard(IA, "minor", { minutes: 2, at: at("P1", 220) }),
      iceGoal(IH, { at: at("P1", 250) }),
    ]);
    // Both expire at 340; the earlier-pushed one goes.
    expect(state.suspensions.length).toBe(1);
    expect(state.suspensions[0]?.startedAt).toEqual(at("P1", 220));
  });

  it("a double minor is not eligible, so a goal releases the plain minor beside it", () => {
    // The DEFERRED half of Rule 20.4, pinned so the dossier row is not a claim:
    // splitting a double minor needs its own state, so the class opts out of
    // release entirely and the goal reaches past it to the ordinary minor.
    const state = foldIce([
      start,
      iceCard(IA, "double_minor", { at: at("P1", 100) }),
      iceCard(IA, "minor", { at: at("P1", 150) }),
      iceGoal(IH, { at: at("P1", 200) }),
    ]);
    expect(state.suspensions.length).toBe(1);
    expect(state.suspensions[0]?.classKey).toBe("double_minor");
  });

  it("does not release a suspension stamped at the very same instant as the goal", () => {
    // §3.3 declares equal `at` normal — two things at one whistle. Without the
    // carve-out the fold is order-dependent inside that group: card-then-goal
    // released it, goal-then-card did not, for the same two facts.
    const goalFirst = foldIce([
      start,
      iceGoal(IH, { at: at("P1", 220) }),
      iceCard(IA, "minor", { at: at("P1", 220) }),
    ]);
    const cardFirst = foldIce([
      start,
      iceCard(IA, "minor", { at: at("P1", 220) }),
      iceGoal(IH, { at: at("P1", 220) }),
    ]);
    expect(cardFirst.suspensions.length).toBe(1);
    expect(goalFirst.suspensions.length).toBe(cardFirst.suspensions.length);
  });

  it("does not release an FIH card — there is no powerplay-goal release in hockey", () => {
    const state = foldFih([
      start,
      { type: "hockey.suspension.start", payload: { by: fihLineups.away.entrantId, class: "yellow", at: at("Q1", 100) } },
      { type: "hockey.goal", payload: { by: FH, at: at("Q1", 200) } },
    ]);
    expect(state.suspensions.length).toBe(1);
  });
});

// ------------------------------------- an explicit release the fold pre-empted

describe("an explicit release the fold already swept is a no-op, not a rejection", () => {
  const end = (extra: Record<string, unknown>): ModuleEvent => ({
    type: "icehockey.suspension.end",
    payload: { by: IA, class: "minor", ...extra },
  });

  it("accepts a release stamped AFTER an earlier event already swept the suspension", () => {
    // The whole premise of lazy expiry is that the pad and the fold disagree
    // between an expiry and the next event. Refusing the scorer's own record of
    // the release punishes them for the fold's laziness.
    const state = foldIce([
      start,
      iceCard(IA, "minor", { at: at("P1", 100) }), // expires 220
      iceGoal(IA, { at: at("P1", 300) }), // the SCORING side is IA, so this only sweeps
      end({ at: at("P1", 320) }),
    ]);
    expect(state.suspensions).toEqual([]);
  });

  it("still REFUSES a release naming a suspension that was never awarded", () => {
    let caught: unknown;
    try {
      foldIce([start, iceGoal(IH, { at: at("P1", 100) }), end({ at: at("P1", 200) })]);
      expect.unreachable("a release with nothing behind it must be refused");
    } catch (err) {
      caught = err;
    }
    expect(EngineError.is(caught, "INVALID_EVENT")).toBe(true);
  });

  it("still REFUSES a release stamped BEFORE the derived expiry", () => {
    // The suspension went early, on a powerplay goal at 150, and it had until
    // 220 to run. A release at 160 is a contradictory record, not a fold the
    // scorer got ahead of, so it keeps its rejection.
    let caught: unknown;
    try {
      foldIce([
        start,
        iceCard(IA, "minor", { at: at("P1", 100) }), // expires 220
        iceGoal(IH, { at: at("P1", 150) }), // releases it under Rule 20.4
        end({ at: at("P1", 160) }),
      ]);
      expect.unreachable("a release before the derived expiry must be refused");
    } catch (err) {
      caught = err;
    }
    expect(EngineError.is(caught, "INVALID_EVENT")).toBe(true);
  });

  it("still REFUSES an UNSTAMPED release once the suspension is gone", () => {
    let caught: unknown;
    try {
      foldIce([
        start,
        iceCard(IA, "minor", { at: at("P1", 100) }),
        iceGoal(IA, { at: at("P1", 300) }),
        end({}),
      ]);
      expect.unreachable("an unstamped release cannot be reconciled against a time");
    } catch (err) {
      caught = err;
    }
    expect(EngineError.is(caught, "INVALID_EVENT")).toBe(true);
  });

  it("the card log keeps the times the sheet prints, so the reconciliation is checkable", () => {
    const state = foldIce([start, iceCard(IA, "minor", { at: at("P1", 100) })]);
    expect(state.cardLog[0]?.startedAt).toEqual(at("P1", 100));
    expect(state.cardLog[0]?.expiresAt).toEqual(at("P1", 220));
  });
});

// ------------------------------------------------- awarded minutes win

describe("the awarded duration beats the class nominal", () => {
  it("an FIH yellow given 10 minutes runs to 10, not the class's 5", () => {
    const state = foldFih([
      start,
      {
        type: "hockey.suspension.start",
        payload: { by: fihLineups.away.entrantId, class: "yellow", minutes: 10, at: at("Q1", 100) },
      },
      { type: "hockey.goal", payload: { by: FH, at: at("Q1", 500) } },
    ]);
    // The class nominal (5) would have expired at 400 and swept at 500.
    expect(state.suspensions.length).toBe(1);
    expect(state.suspensions[0]?.expiresAt).toEqual(at("Q1", 700));
  });
});

// ------------------------------------------------ stamps outside play

describe("a stamp in a phase where play is not running (§7)", () => {
  it("a card before the opening whistle is SERVED from the first play phase", () => {
    // "pre" has no play clock, so the arithmetic cannot start there — but
    // deriving no expiry at all left the card running for the whole match and
    // the side reading short at full time. A pre-game card is served from the
    // opening whistle, which is `{firstPlayPhase, 0}`.
    const state = foldIce([start, iceCard(IA, "minor", { at: at("pre", 30) })]);
    expect(state.suspensions.length).toBe(1);
    expect(state.suspensions[0]?.startedAt).toEqual(at("pre", 30));
    expect(state.suspensions[0]?.expiresAt).toEqual(at("P1", 120));
  });

  it("and it is swept once play passes it, so nobody reads short at the end", () => {
    const state = foldFih([
      start,
      {
        type: "hockey.suspension.start",
        payload: { by: fihLineups.away.entrantId, class: "yellow", at: at("pre", 30) },
      },
      { type: "hockey.goal", payload: { by: FH, at: at("Q1", 400) } },
    ]);
    expect(state.suspensions).toEqual([]);
    expect(strengthOf(hockey.summary(state))).toBeNull();
  });

  it("a TEAM-SHORT card in the shoot-out serves no time — there is no play clock", () => {
    // FIH has no release-on-goal and the shoot-out has no match clock at all
    // (the carry deliberately refuses to spill into it), so a team-short class
    // stamped here otherwise ran to the end of the fixture and left the final
    // state reading 11v10 / 5v4.
    const state = foldIce([
      start,
      iceAdvance("P2"),
      iceAdvance("P3"),
      iceAdvance("FT"), // 0–0 ⇒ OT
      iceAdvance("FT"), // still level ⇒ SHOOTOUT
      iceCard(IA, "minor", { at: at("SHOOTOUT", 10) }),
    ]);
    expect(state.phase).toBe("SHOOTOUT");
    expect(state.suspensions[0]?.expiresAt).toEqual(at("SHOOTOUT", 10));
  });

  it("a card that does NOT make the team short keeps its open end in the shoot-out", () => {
    // A misconduct parks the player; the team stays full, so there is no wrong
    // strength chip to prevent and nothing to zero out.
    const state = foldIce([
      start,
      iceAdvance("P2"),
      iceAdvance("P3"),
      iceAdvance("FT"),
      iceAdvance("FT"),
      iceCard(IA, "misconduct", { at: at("SHOOTOUT", 10) }),
    ]);
    expect(state.phase).toBe("SHOOTOUT");
    expect(state.suspensions.length).toBe(1);
    expect(state.suspensions[0]?.expiresAt).toBeUndefined();
  });
});

// ------------------------------------------------------------- additivity

describe("an entirely unstamped stream folds exactly as before", () => {
  it("carries no asOf and no derived times anywhere in the state", () => {
    const state = foldIce([
      start,
      iceCard(IA, "minor"),
      iceGoal(IH, { person: `${IH}-p1`, clockRef: "12:41" }),
      iceAdvance("P2"),
      iceGoal(IA),
    ]);
    const json = JSON.stringify(state);
    expect(json).not.toContain("asOf");
    expect(json).not.toContain("startedAt");
    expect(json).not.toContain("expiresAt");
    expect(json).not.toContain('"at"');
    expect(state.suspensions.length).toBe(1); // nothing swept without stamps
  });

  it("a stamped goal logs its stamp beside the legacy clockRef", () => {
    const state = foldIce([start, iceGoal(IH, { at: at("P1", 761), clockRef: "12:41" })]);
    expect(state.goalLog?.[0]?.at).toEqual(at("P1", 761));
    expect(state.goalLog?.[0]?.clockRef).toBe("12:41");
  });
});

// ------------------------------------------------------ generated coverage

describe("the generator stamps what it emits, so the property runs exercise §9.6", () => {
  // WITHOUT this the whole W4a path had ZERO generated coverage: `at` and the
  // derived expiries were unreachable from `arbitraryEvent`, so conformance's
  // coarse-equals-fine, the chaos and undo-sweep sweeps and every stream a
  // future EXTEND_GOLDEN appends all stayed on the pre-wave path — and "the
  // eleven goldens are byte-identical" was guaranteed by the generator's blind
  // spot rather than by the change being additive.
  const cases: [string, typeof icehockey | typeof hockey, unknown][] = [
    ["icehockey", icehockey, {}],
    ["hockey", hockey, {}],
  ];

  it.each(cases)("%s emits `at` on the stamped payloads", (_, mod, raw) => {
    const cfg = mod.configSchema.parse(raw);
    const lineups = defaultLineupPair(mod.positions);
    // Scanned rather than pinned to one seed: a stream can end on the second
    // event (a generated forfeit), and a single unlucky seed would make this
    // assert nothing about the generator.
    const events = Array.from({ length: 12 }, (_, i) =>
      buildStream(mod as never, cfg as never, lineups, i + 1, 60),
    ).flat();
    const stamped = events.filter((e) => gameTimeOf(e.payload) !== null);
    expect(events.length).toBeGreaterThan(20);
    expect(stamped.length).toBeGreaterThan(10);
    // Every module event carries one; only the unstamped core events do not.
    for (const event of events) {
      if (event.type.startsWith("core.")) continue;
      expect(gameTimeOf(event.payload), `${event.type} must carry a stamp`).not.toBeNull();
    }
  });

  it.each(cases)("%s emits them MONOTONICALLY, or the guard reds for the wrong reason", (_, mod, raw) => {
    const cfg = mod.configSchema.parse(raw);
    const lineups = defaultLineupPair(mod.positions);
    for (let seed = 1; seed <= 12; seed++) {
      const events = buildStream(mod as never, cfg as never, lineups, seed, 60);
      const order = mod.playPhases?.(cfg as never) ?? [];
      let high: ReturnType<typeof gameTimeOf> = null;
      for (const event of events) {
        const stamp = gameTimeOf(event.payload);
        if (stamp === null) continue;
        if (high !== null) {
          expect(
            compareGameTime(stamp, high, order),
            `seed ${seed}: ${event.type} travels backwards`,
          ).toBeGreaterThanOrEqual(0);
        }
        high = stamp;
      }
    }
  });

  it("and those streams actually reach a derived expiry, not just a stamped payload", () => {
    // A stream that stamps but never expires anything would leave the sweep,
    // the carry and release-on-goal exactly as uncovered as before.
    const cfg = icehockey.configSchema.parse({});
    const lineups = defaultLineupPair(icehockey.positions);
    let sawExpiry = false;
    for (let seed = 1; seed <= 40 && !sawExpiry; seed++) {
      const events = buildStream(icehockey as never, cfg as never, lineups, seed, 60);
      const state = foldMatch(icehockey, cfg, lineups, events) as PeriodState;
      sawExpiry = state.cardLog.some((entry) => entry.expiresAt !== undefined);
    }
    expect(sawExpiry).toBe(true);
  });
});

// -------------------------------------------------------- union widening

describe("PeriodEv disambiguation — a widened branch must not swallow a sibling", () => {
  // PeriodGoal is branch ONE and now carries `at`, which makes it the branch
  // most able to swallow the others. z.union takes the FIRST branch that
  // parses, so a payload landing on the wrong branch loses its own keys —
  // asserting the parse round-trips is what detects that.
  // A ROUND-TRIP PROVES NOTHING HERE. Every branch is a `z.strictObject`, so a
  // branch matches only as a superset and zod returns the input UNCHANGED —
  // `toEqual(payload)` therefore passes on ANY winning branch, and passed even
  // with `PeriodGoal` moved to the end of the union. The winning branch has to
  // be named, and the only honest way to name it is to replay `z.union`'s own
  // first-match rule against the branches in declaration order.
  // Names are looked up BY SCHEMA IDENTITY and the order comes from the real
  // `PeriodEv.options`. A hand-ordered local copy here would compute the winner
  // against a stale order, so reordering the actual union would red nothing —
  // the same defect this file exists to catch, one level up. Football shipped
  // that copy and a counterfactual proved it: with the hand-ordered list, the
  // reorder mutant survived the whole suite.
  const BRANCH_NAMES = new Map<z.ZodType, string>([
    [PeriodGoal, "PeriodGoal"],
    [PeriodAdvance, "PeriodAdvance"],
    [PeriodSuspensionStart, "PeriodSuspensionStart"],
    [PeriodSuspensionEnd, "PeriodSuspensionEnd"],
    [PeriodShootoutAttempt, "PeriodShootoutAttempt"],
    [PeriodSetPiece, "PeriodSetPiece"],
  ]);
  const BRANCHES: [string, z.ZodType][] = PeriodEv.options.map((schema) => {
    const name = BRANCH_NAMES.get(schema as z.ZodType);
    // A branch added to the union without being named here would otherwise
    // silently become "unknown" and pass every assertion below.
    if (name === undefined) throw new Error("PeriodEv gained a branch with no name in BRANCH_NAMES");
    return [name, schema as z.ZodType];
  });

  // Deliberately NOT `expect(BRANCHES).toEqual(PeriodEv.options)` — BRANCHES is
  // derived FROM `PeriodEv.options`, so that assertion is tautological and can
  // never red. The direction that can actually break is the map going stale:
  // a branch dropped from the union leaves a name behind, and every shape below
  // keeps passing against a schema the sport no longer has.
  it("has no stale entry in BRANCH_NAMES", () => {
    const live = new Set<unknown>(PeriodEv.options);
    const orphaned = [...BRANCH_NAMES.entries()]
      .filter(([schema]) => !live.has(schema))
      .map(([, name]) => name);
    expect(orphaned).toEqual([]);
  });

  const winningBranch = (payload: unknown): string | null =>
    BRANCHES.find(([, schema]) => schema.safeParse(payload).success)?.[0] ?? null;

  // `apply` dispatches on the ENVELOPE type, never on the branch, so two
  // payload shapes sharing a branch is not a defect — it is why the union only
  // has to stay a SUPERSET of every legal payload. What this pins is that the
  // winner does not MOVE: a widened branch reaching a shape it did not reach
  // before is the union-swallow hazard §8 names, and nothing else detects it.
  const shapes: [string, unknown, string][] = [
    ["stamped goal", { by: IH, person: `${IH}-p1`, at: at("P1", 10) }, "PeriodGoal"],
    ["stamped advance", { to: "P2", at: at("P1", 1200) }, "PeriodAdvance"],
    [
      "stamped suspension start",
      { by: IA, class: "minor", reason: "tripping", at: at("P1", 100) },
      "PeriodSuspensionStart",
    ],
    // Every field of PeriodSuspensionEnd is also a field of the START branch,
    // which is declared first, so an end payload wins there. Recorded rather
    // than wished away: the fold reads the envelope type.
    ["stamped suspension end", { by: IA, class: "minor", at: at("P1", 220) }, "PeriodSuspensionStart"],
    ["stamped shootout attempt", { by: IH, scored: true, at: at("SHOOTOUT", 10) }, "PeriodShootoutAttempt"],
    [
      "stamped set piece",
      { by: IH, kind: "ps", outcome: "scored", at: at("P1", 300) },
      "PeriodSetPiece",
    ],
    // The direction the union NOTE cares about: a set piece must never DISPLACE
    // a goal, and a minimal one is a structural subset of one, so the goal
    // branch takes it. Adding `at` to PeriodGoal must not change that either.
    ["minimal set piece", { by: IH, kind: "ps", at: at("P1", 300) }, "PeriodGoal"],
  ];

  it.each(shapes)("%s wins on the branch it is supposed to win on", (_, payload, branch) => {
    expect(winningBranch(payload)).toBe(branch);
    // …and the union still round-trips it, so no key is dropped on the way.
    expect(PeriodEv.parse(payload)).toEqual(payload);
  });

  it("each stamped payload validates against its own schema", () => {
    expect(PeriodGoal.safeParse({ by: IH, at: at("P1", 10) }).success).toBe(true);
    expect(PeriodSuspensionStart.safeParse({ by: IA, class: "minor", at: at("P1", 10) }).success).toBe(true);
    expect(PeriodSuspensionEnd.safeParse({ by: IA, at: at("P1", 10) }).success).toBe(true);
    expect(PeriodSetPiece.safeParse({ by: IH, kind: "ps", at: at("P1", 10) }).success).toBe(true);
    expect(PeriodAdvance.safeParse({ to: "P2", at: at("P1", 10) }).success).toBe(true);
    expect(
      PeriodShootoutAttempt.safeParse({ by: IH, scored: true, at: at("SHOOTOUT", 10) }).success,
    ).toBe(true);
  });

  it("a shoot-out attempt carries `at`, so asOf does not freeze across the shoot-out", () => {
    // Cards are stampable in "SHOOTOUT" already; leaving the attempt — the only
    // event that phase is made of — unstampable froze `State.asOf` at the last
    // stamped card for the whole decider.
    const state = foldIce([
      start,
      iceAdvance("P2"),
      iceAdvance("P3"),
      iceAdvance("FT"), // 0–0 ⇒ OT
      iceAdvance("FT"), // still level ⇒ SHOOTOUT
      { type: "icehockey.shootout.attempt", payload: { by: IH, scored: true, at: at("SHOOTOUT", 30) } },
    ]);
    expect(state.asOf).toEqual(at("SHOOTOUT", 30));
  });

  it("uses the GameTime schema VERBATIM, so a malformed stamp is refused", () => {
    // Fail-open is the kernel's rule for `gameTimeOf`, so the payload schema is
    // the ONLY thing between a corrupt stamp and the ledger: negative,
    // fractional, empty-label and widened stamps all have to bounce here.
    expect(PeriodGoal.safeParse({ by: IH, at: { period: "P1", elapsed: -1 } }).success).toBe(false);
    expect(PeriodGoal.safeParse({ by: IH, at: { period: "P1", elapsed: 1.5 } }).success).toBe(false);
    expect(PeriodGoal.safeParse({ by: IH, at: { period: "", elapsed: 1 } }).success).toBe(false);
    expect(
      PeriodGoal.safeParse({ by: IH, at: { period: "P1", elapsed: 1, basis: "remaining" } }).success,
    ).toBe(false);
  });
});
