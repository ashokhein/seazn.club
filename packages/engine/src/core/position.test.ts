// W4a (#425) T6b — the cross-sport match-position axis, core half.
import { describe, expect, it } from "vitest";
import { EngineError } from "./errors.ts";
import {
  MatchPosition,
  PositionSegment,
  clockSegment,
  comparePosition,
  currentUnit,
  formatPosition,
  labelledSegment,
  matchPositionOf,
  periodClockPosition,
  phaseSegment,
  scoreSegment,
  unitNumber,
  unitSegment,
} from "./position.ts";

const pos = (...segments: PositionSegment[]): MatchPosition => ({ segments });

describe("PositionSegment / MatchPosition shape", () => {
  it("accepts a labelled unit and an unlabelled self-describing value", () => {
    expect(PositionSegment.parse({ key: "set", label: "Set", value: "2", ordinal: 2 })).toEqual({
      key: "set",
      label: "Set",
      value: "2",
      ordinal: 2,
    });
    // A phase value names itself ("P2"); a label would render "Period P2".
    expect(PositionSegment.parse({ key: "period", value: "P2", ordinal: 2 })).toEqual({
      key: "period",
      value: "P2",
      ordinal: 2,
    });
  });

  it("refuses an empty key, an empty value and an unknown field", () => {
    expect(PositionSegment.safeParse({ key: "", value: "2" }).success).toBe(false);
    expect(PositionSegment.safeParse({ key: "set", value: "" }).success).toBe(false);
    // Strict: a sport that wants to smuggle a per-sport payload through the
    // axis is exactly the denormalisation this design rejects.
    expect(PositionSegment.safeParse({ key: "set", value: "2", detail: {} }).success).toBe(false);
  });

  it("refuses a position with no segments", () => {
    // "No position" is `null` from `matchPositionOf`, never an empty list —
    // an empty list renders as a blank chip that reads like a bug.
    expect(MatchPosition.safeParse({ segments: [] }).success).toBe(false);
  });

  it("carries no denormalised display line and no denormalised sort key", () => {
    // Both are pure functions of `segments` (`formatPosition`, `comparePosition`).
    // Materialising either recreates the recorded-vs-derived pair this whole
    // axis exists to avoid, and a baked English line fights i18n besides.
    const parsed = MatchPosition.parse({ segments: [{ key: "set", value: "2" }] });
    expect(Object.keys(parsed)).toEqual(["segments"]);
    expect(MatchPosition.safeParse({ segments: [{ key: "set", value: "2" }], line: "Set 2" }).success).toBe(
      false,
    );
  });
});

describe("segment builders", () => {
  it("unitSegment carries the number as both value and ordinal", () => {
    expect(unitSegment("set", "Set", 2)).toEqual({ key: "set", label: "Set", value: "2", ordinal: 2 });
  });

  it("phaseSegment ranks the phase by its index in the declared order", () => {
    const order = ["pre", "H1", "H2", "SHOOTOUT"];
    expect(phaseSegment(order[2] as string, order)).toEqual({
      key: "period",
      value: "H2",
      ordinal: 2,
    });
  });

  it("phaseSegment omits the ordinal for a phase the order does not declare", () => {
    // Ordering against -1 would sort an unknown phase BEFORE the opening
    // whistle. Absent is the honest answer, and `comparePosition` stops there.
    expect(phaseSegment("OT9", ["pre", "H1", "H2"])).toEqual({ key: "period", value: "OT9" });
  });

  it("clockSegment renders mm:ss and ranks by seconds", () => {
    expect(clockSegment(761)).toEqual({ key: "clock", value: "12:41", ordinal: 761 });
    expect(clockSegment(0)).toEqual({ key: "clock", value: "0:00", ordinal: 0 });
  });

  it("scoreSegment carries no ordinal unless one is given", () => {
    expect(scoreSegment("points", "30–15")).toEqual({ key: "points", value: "30–15" });
    expect(scoreSegment("points", "21–19", 40)).toEqual({
      key: "points",
      value: "21–19",
      ordinal: 40,
    });
  });
});

describe("labelledSegment — a named value whose display and rank differ", () => {
  it("keeps the display value and the rank independent", () => {
    // Cricket's over prints "12.3" and ranks by 75 legal balls. `unitSegment`
    // ties the two together deliberately; this is the escape for the case where
    // the notation is not the number.
    expect(labelledSegment("over", "Over", "12.3", 75)).toEqual({
      key: "over",
      label: "Over",
      value: "12.3",
      ordinal: 75,
    });
    expect(labelledSegment("over", "Over", "12.3")).toEqual({
      key: "over",
      label: "Over",
      value: "12.3",
    });
  });

  it("is what unitSegment is built from, so the two cannot spell a unit differently", () => {
    expect(unitSegment("set", "Set", 2)).toEqual(labelledSegment("set", "Set", "2", 2));
  });
});

describe("periodClockPosition — the shared derivation for period sports", () => {
  const order = ["pre", "H1", "H2", "SHOOTOUT"];

  it("takes the LATEST phase the state evidences, by the declared order", () => {
    // Evidence arrives in no particular order and from several fields, so the
    // rule is a max over the declared order rather than "trust this one field".
    // Monotone by construction: the answer cannot travel backwards.
    expect(
      periodClockPosition({ phaseOrder: order, evidence: ["H1", undefined, "H2", "pre"] }),
    ).toEqual({ segments: [{ key: "period", value: "H2", ordinal: 2 }] });
  });

  it("ignores evidence the declared order does not contain", () => {
    // "done" / "final" / "abandoned" are terminal markers, not places on the
    // pitch, and `playPhases` excludes them for exactly that reason.
    expect(periodClockPosition({ phaseOrder: order, evidence: ["done", "H1"] })).toEqual({
      segments: [{ key: "period", value: "H1", ordinal: 1 }],
    });
  });

  it("falls back to the first declared phase when nothing is evidenced", () => {
    // A fixture abandoned before the opening whistle happened in "pre".
    expect(periodClockPosition({ phaseOrder: order, evidence: ["abandoned"] })).toEqual({
      segments: [{ key: "period", value: "pre", ordinal: 0 }],
    });
  });

  it("adds the clock ONLY when the stamp names the phase it resolved to", () => {
    expect(
      periodClockPosition({ phaseOrder: order, evidence: ["H2"], asOf: { period: "H2", elapsed: 761 } }),
    ).toEqual({
      segments: [
        { key: "period", value: "H2", ordinal: 2 },
        { key: "clock", value: "12:41", ordinal: 761 },
      ],
    });
  });

  it("drops a stamp left behind in an earlier phase", () => {
    // A period advances on an UNSTAMPED whistle and `asOf` still names the one
    // before it. 44:59 next to "H2" asserts something false about where play
    // is; both fields are strings, so a producer that reached for the wrong one
    // compiles and looks right.
    expect(
      periodClockPosition({ phaseOrder: order, evidence: ["H2"], asOf: { period: "H1", elapsed: 2699 } }),
    ).toEqual({ segments: [{ key: "period", value: "H2", ordinal: 2 }] });
  });
});

describe("currentUnit — the one rule for 'which set/game/innings are we in'", () => {
  it("is one past the completed count while the match is live", () => {
    expect(currentUnit(0, true)).toBe(1);
    expect(currentUnit(2, true)).toBe(3);
  });

  it("names the LAST unit actually played once the match is decided", () => {
    // The defect this exists to prevent: a best-of-three won 2–0 reads
    // "Set 3" under a naive completed+1, naming a set nobody played.
    expect(currentUnit(2, false)).toBe(2);
  });

  it("still names unit 1 for a match decided before anything was completed", () => {
    // A walkover or an abandonment at 0–0 happened IN the first set, not in
    // set zero.
    expect(currentUnit(0, false)).toBe(1);
  });
});

describe("unitNumber — completed AND started, because 'live' alone is not enough", () => {
  it("is one past the completed count while a match runs between units", () => {
    // Set 1 closed, set 2 not yet opened (these kernels open a set lazily, on
    // its first rally) — the match is in set 2.
    expect(unitNumber({ started: 1, completed: 1, live: true })).toBe(2);
  });

  it("tracks the unit in progress once it has started", () => {
    expect(unitNumber({ started: 3, completed: 2, live: true })).toBe(3);
  });

  it("names the last unit played on a match decided at a unit boundary", () => {
    expect(unitNumber({ started: 2, completed: 2, live: false })).toBe(2);
  });

  it("KEEPS the unit in progress when a match is abandoned mid-unit", () => {
    // The case a `live`-only rule gets wrong, and the reason `started` exists.
    // A carrom match abandoned during game 3 has two games COMPLETE, so
    // `currentUnit` alone reports "Game 2" — a position that travels BACKWARDS
    // at the final event, which is exactly what W6 sorts a timeline by. Caught
    // by the monotonicity property in `position.conformance.test.ts`, not by
    // any hand-written case.
    expect(unitNumber({ started: 3, completed: 2, live: false })).toBe(3);
    expect(currentUnit(2, false)).toBe(2); // the rule that was not enough
  });

  it("is unit 1 before anything has started", () => {
    expect(unitNumber({ started: 0, completed: 0, live: true })).toBe(1);
    expect(unitNumber({ started: 0, completed: 0, live: false })).toBe(1);
  });
});

describe("formatPosition", () => {
  it("names a labelled value and lets a self-describing value stand alone", () => {
    expect(
      formatPosition(
        pos(unitSegment("set", "Set", 2), unitSegment("game", "Game", 4), scoreSegment("points", "30–15")),
      ),
    ).toBe("Set 2 · Game 4 · 30–15");
    expect(formatPosition(pos(phaseSegment("P2", ["pre", "P1", "P2"]), clockSegment(761)))).toBe(
      "P2 · 12:41",
    );
  });
});

describe("comparePosition", () => {
  const order = ["pre", "P1", "P2", "P3"];

  it("orders on the first segment whose ordinals differ", () => {
    const a = pos(phaseSegment("P1", order), clockSegment(880));
    const b = pos(phaseSegment("P2", order), clockSegment(12));
    expect(comparePosition(a, b)).toBe(-1);
    expect(comparePosition(b, a)).toBe(1);
  });

  it("falls through an equal segment to the next", () => {
    const a = pos(phaseSegment("P2", order), clockSegment(12));
    const b = pos(phaseSegment("P2", order), clockSegment(761));
    expect(comparePosition(a, b)).toBe(-1);
    expect(comparePosition(a, a)).toBe(0);
  });

  it("stops at a segment either side cannot rank, rather than guessing", () => {
    // Tennis's point score is deliberately unranked (a deuce loop is not
    // derivable from the state), so two positions inside one game are
    // indistinguishable — which is true, and better than an invented order.
    const a = pos(unitSegment("game", "Game", 4), scoreSegment("points", "30–15"));
    const b = pos(unitSegment("game", "Game", 4), scoreSegment("points", "15–40"));
    expect(comparePosition(a, b)).toBe(0);
  });

  it("compares only the common prefix when one side is less resolved", () => {
    // A period sport before its first stamped event has a phase and no clock.
    const a = pos(phaseSegment("P2", order));
    const b = pos(phaseSegment("P2", order), clockSegment(761));
    expect(comparePosition(a, b)).toBe(0);
    expect(comparePosition(b, a)).toBe(0);
  });

  it("throws rather than silently ordering two different shapes", () => {
    // `compareGameTime` set this precedent: an input it cannot rank throws
    // instead of sorting arbitrarily, because an arbitrary sort is a wrong
    // answer nothing detects.
    const a = pos(unitSegment("set", "Set", 2));
    const b = pos(unitSegment("innings", "Innings", 2));
    let caught: unknown;
    try {
      comparePosition(a, b);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EngineError);
    const engineError = caught as EngineError;
    expect(engineError.code).toBe("INVALID_EVENT");
    // The code alone pins nothing — three other places throw INVALID_EVENT.
    // What has to be true is that the message names BOTH keys and the index.
    expect(engineError.message).toContain("set");
    expect(engineError.message).toContain("innings");
    expect(engineError.data).toEqual({ index: 0, a: "set", b: "innings" });
  });
});

describe("matchPositionOf — the ONE place the seq fallback is decided", () => {
  it("projects when the module declares a position", () => {
    const mod = { position: (s: { n: number }) => pos(unitSegment("set", "Set", s.n)) };
    expect(matchPositionOf(mod, { n: 3 })).toEqual(pos(unitSegment("set", "Set", 3)));
  });

  it("returns null — never a placeholder — when the module declares none", () => {
    // Callers read `null` as "order and label this event by `seq`". A module
    // inventing "Move 1" to fill the table is the denormalisation this axis
    // exists to prevent, so the fallback lives here and nowhere else.
    expect(matchPositionOf({}, { n: 3 })).toBeNull();
  });
});
