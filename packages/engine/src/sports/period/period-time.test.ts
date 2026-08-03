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
import { EngineError } from "../../core/errors.ts";
import { foldMatch, type EventEnvelope } from "../../core/events.ts";
import { defaultLineupPair, makeEnvelope } from "../../testkit/helpers.ts";
import type { ModuleEvent } from "../../sport/module.ts";
import { icehockey } from "../icehockey/icehockey.ts";
import { hockey } from "../hockey/hockey.ts";
import {
  PeriodEv,
  PeriodGoal,
  PeriodSetPiece,
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

  it("without periodSeconds the carry cannot be computed — the expiry stays in-period", () => {
    // The documented limitation. Recorded as a dossier row rather than guessed:
    // the engine has no period length to subtract.
    const state = foldIce([start, iceCard(IA, "minor", { at: at("P1", 1150) })]);
    expect(state.suspensions[0]?.expiresAt).toEqual(at("P1", 1270));
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

  it("does not release an FIH card — there is no powerplay-goal release in hockey", () => {
    const state = foldFih([
      start,
      { type: "hockey.suspension.start", payload: { by: fihLineups.away.entrantId, class: "yellow", at: at("Q1", 100) } },
      { type: "hockey.goal", payload: { by: FH, at: at("Q1", 200) } },
    ]);
    expect(state.suspensions.length).toBe(1);
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
  it("accepts a card before the opening whistle, and derives no expiry there", () => {
    const state = foldIce([start, iceCard(IA, "minor", { at: at("pre", 30) })]);
    expect(state.suspensions.length).toBe(1);
    expect(state.suspensions[0]?.startedAt).toEqual(at("pre", 30));
    expect(state.suspensions[0]?.expiresAt).toBeUndefined();
  });

  it("accepts a card during the shootout", () => {
    const state = foldIce([
      start,
      iceAdvance("P2"),
      iceAdvance("P3"),
      iceAdvance("FT"), // 0–0 ⇒ OT
      iceAdvance("FT"), // still level ⇒ SHOOTOUT
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

// -------------------------------------------------------- union widening

describe("PeriodEv disambiguation — a widened branch must not swallow a sibling", () => {
  // PeriodGoal is branch ONE and now carries `at`, which makes it the branch
  // most able to swallow the others. z.union takes the FIRST branch that
  // parses, so a payload landing on the wrong branch loses its own keys —
  // asserting the parse round-trips is what detects that.
  const shapes: [string, unknown][] = [
    ["stamped goal", { by: IH, person: `${IH}-p1`, at: at("P1", 10) }],
    ["stamped advance", { to: "P2", at: at("P1", 1200) }],
    ["stamped suspension start", { by: IA, class: "minor", at: at("P1", 100) }],
    ["stamped suspension end", { by: IA, class: "minor", at: at("P1", 220) }],
    ["stamped shootout attempt", { by: IH, scored: true }],
    ["stamped set piece", { by: IH, kind: "ps", outcome: "scored", at: at("P1", 300) }],
  ];

  it.each(shapes)("%s parses to its own branch with every key intact", (_, payload) => {
    expect(PeriodEv.parse(payload)).toEqual(payload);
  });

  it("each stamped payload validates against its own schema", () => {
    expect(PeriodGoal.safeParse({ by: IH, at: at("P1", 10) }).success).toBe(true);
    expect(PeriodSuspensionStart.safeParse({ by: IA, class: "minor", at: at("P1", 10) }).success).toBe(true);
    expect(PeriodSuspensionEnd.safeParse({ by: IA, at: at("P1", 10) }).success).toBe(true);
    expect(PeriodSetPiece.safeParse({ by: IH, kind: "ps", at: at("P1", 10) }).success).toBe(true);
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
