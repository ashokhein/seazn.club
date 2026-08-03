// Core time primitives — W4a spec (#425) §2, §9.
import { describe, expect, it } from "vitest";
import { EngineError } from "./errors.ts";
import {
  DurationSeconds,
  GameTime,
  addDuration,
  compareGameTime,
  formatElapsed,
  gameTimeOf,
  parseElapsed,
  remainingOf,
} from "./time.ts";

const PHASES = ["P1", "P2", "P3", "OT"] as const;

describe("DurationSeconds", () => {
  it("accepts non-negative integers only", () => {
    expect(DurationSeconds.safeParse(0).success).toBe(true);
    expect(DurationSeconds.safeParse(761).success).toBe(true);
    expect(DurationSeconds.safeParse(-1).success).toBe(false);
    expect(DurationSeconds.safeParse(1.5).success).toBe(false);
    expect(DurationSeconds.safeParse("761").success).toBe(false);
  });
});

describe("GameTime", () => {
  it("requires a non-empty period and a duration, and rejects extra keys", () => {
    expect(GameTime.safeParse({ period: "P2", elapsed: 761 }).success).toBe(true);
    expect(GameTime.safeParse({ period: "", elapsed: 761 }).success).toBe(false);
    expect(GameTime.safeParse({ period: "P2", elapsed: -1 }).success).toBe(false);
    expect(GameTime.safeParse({ period: "P2" }).success).toBe(false);
    // strictObject: an unknown key is a different shape, not a GameTime.
    expect(GameTime.safeParse({ period: "P2", elapsed: 1, extra: 1 }).success).toBe(false);
  });
});

describe("compareGameTime", () => {
  it("orders by phase index first", () => {
    expect(compareGameTime({ period: "P1", elapsed: 1199 }, { period: "P2", elapsed: 0 }, PHASES)).toBe(-1);
    expect(compareGameTime({ period: "P2", elapsed: 0 }, { period: "P1", elapsed: 1199 }, PHASES)).toBe(1);
    expect(compareGameTime({ period: "OT", elapsed: 0 }, { period: "P3", elapsed: 9999 }, PHASES)).toBe(1);
  });

  it("orders by elapsed within one phase", () => {
    expect(compareGameTime({ period: "P2", elapsed: 10 }, { period: "P2", elapsed: 11 }, PHASES)).toBe(-1);
    expect(compareGameTime({ period: "P2", elapsed: 11 }, { period: "P2", elapsed: 10 }, PHASES)).toBe(1);
  });

  it("reports equality for the same phase and elapsed", () => {
    // §1.2 — core.suspend / core.resume legitimately share one stamp.
    expect(compareGameTime({ period: "P2", elapsed: 761 }, { period: "P2", elapsed: 761 }, PHASES)).toBe(0);
  });

  it("throws UNKNOWN_PHASE as an EngineError for a period outside phaseOrder", () => {
    const call = () => compareGameTime({ period: "SO", elapsed: 0 }, { period: "P1", elapsed: 0 }, PHASES);
    expect(call).toThrow(EngineError);
    try {
      call();
      expect.unreachable("compareGameTime should have thrown");
    } catch (err) {
      expect(EngineError.is(err, "UNKNOWN_PHASE")).toBe(true);
    }
    // ...on either argument.
    expect(() =>
      compareGameTime({ period: "P1", elapsed: 0 }, { period: "SO", elapsed: 0 }, PHASES),
    ).toThrow(EngineError);
  });
});

describe("addDuration", () => {
  it("adds within the named period", () => {
    expect(addDuration({ period: "P2", elapsed: 761 }, 120)).toEqual({ period: "P2", elapsed: 881 });
    expect(addDuration({ period: "P2", elapsed: 761 }, 0)).toEqual({ period: "P2", elapsed: 761 });
  });

  it("NEVER rolls into the next period (§3.2) — the engine knows no period lengths", () => {
    // 19:10 of a nominal 20-minute period + a 2-minute minor.
    expect(addDuration({ period: "P1", elapsed: 1150 }, 120)).toEqual({
      period: "P1",
      elapsed: 1270, // past 1200; still P1, deliberately.
    });
  });

  it("truncates a fractional duration — seconds are the engine's only unit", () => {
    expect(addDuration({ period: "P1", elapsed: 10 }, 120.7)).toEqual({
      period: "P1",
      elapsed: 130,
    });
  });

  it("THROWS on a negative duration rather than flooring to the period start", () => {
    // Flooring produced `elapsed: 0` — an expiresAt at the period start, swept
    // as expired by the very next stamp. A penalty that silently never runs is
    // strictly worse than a rejected event, and nothing legitimately asks for a
    // negative duration: every caller is a suspension length.
    for (const seconds of [-1, -100, -0.5]) {
      let caught: unknown;
      try {
        addDuration({ period: "P1", elapsed: 10 }, seconds);
        expect.unreachable(`addDuration should have rejected ${seconds}`);
      } catch (err) {
        caught = err;
      }
      expect(EngineError.is(caught, "INVALID_EVENT")).toBe(true);
    }
  });

  it("THROWS on a non-finite duration", () => {
    // Math.trunc(Infinity) is Infinity, which GameTime then rejects — so the
    // "always a valid GameTime" claim was false anyway. Fail where the bad
    // number entered, not two layers later.
    for (const seconds of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => addDuration({ period: "P1", elapsed: 10 }, seconds)).toThrow(EngineError);
    }
    expect(() =>
      addDuration({ period: "P1", elapsed: 10 }, undefined as unknown as number),
    ).toThrow(EngineError);
  });

  it("returns a valid GameTime for every duration it accepts", () => {
    for (const seconds of [0, 1, 120, 7530]) {
      expect(GameTime.safeParse(addDuration({ period: "P1", elapsed: 10 }, seconds)).success).toBe(
        true,
      );
    }
  });
});

describe("remainingOf", () => {
  it("returns the soft remainder, floored at zero", () => {
    expect(remainingOf({ period: "P2", elapsed: 761 }, 1200)).toBe(439);
    expect(remainingOf({ period: "P2", elapsed: 1200 }, 1200)).toBe(0);
    // §1.3 — football's 90+3 overruns the nominal length; never negative.
    expect(remainingOf({ period: "H2", elapsed: 2880 }, 2700)).toBe(0);
  });
});

describe("formatElapsed", () => {
  it("renders mm:ss with seconds zero-padded", () => {
    expect(formatElapsed(761)).toBe("12:41");
    expect(formatElapsed(65)).toBe("1:05");
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(9)).toBe("0:09");
  });

  it("leaves minutes unbounded past the hour", () => {
    expect(formatElapsed(7530)).toBe("125:30");
    expect(formatElapsed(3600)).toBe("60:00");
  });

  it("is total for junk input", () => {
    expect(formatElapsed(-5)).toBe("0:00");
    expect(formatElapsed(61.9)).toBe("1:01");
    expect(formatElapsed(Number.NaN)).toBe("0:00");
  });
});

describe("parseElapsed", () => {
  it("accepts mm:ss", () => {
    expect(parseElapsed("12:41")).toBe(761);
    expect(parseElapsed("1:05")).toBe(65);
    expect(parseElapsed("125:30")).toBe(7530);
    expect(parseElapsed("0:00")).toBe(0);
  });

  it("accepts bare seconds", () => {
    expect(parseElapsed("761")).toBe(761);
    expect(parseElapsed("0")).toBe(0);
  });

  it("round-trips with formatElapsed", () => {
    for (const seconds of [0, 9, 65, 761, 3600, 7530]) {
      expect(parseElapsed(formatElapsed(seconds))).toBe(seconds);
    }
  });

  it("returns null — never throws — for anything else", () => {
    expect(parseElapsed("12:61")).toBeNull(); // 61 is not a second
    expect(parseElapsed("")).toBeNull();
    expect(parseElapsed("  ")).toBeNull();
    expect(parseElapsed("mm:ss")).toBeNull();
    expect(parseElapsed("12:")).toBeNull();
    expect(parseElapsed(":41")).toBeNull();
    expect(parseElapsed("1:2:3")).toBeNull();
    expect(parseElapsed("-5")).toBeNull();
    expect(parseElapsed("12.5")).toBeNull();
    expect(parseElapsed("1:5")).toBeNull(); // ambiguous; mm:ss needs two digits
    expect(parseElapsed(undefined as unknown as string)).toBeNull();
  });
});

describe("gameTimeOf", () => {
  it("reads payload.at structurally, knowing no sport payload shape", () => {
    expect(gameTimeOf({ at: { period: "P2", elapsed: 761 } })).toEqual({
      period: "P2",
      elapsed: 761,
    });
    // Other payload keys are none of core's business.
    expect(gameTimeOf({ to: "home", emptyNet: true, at: { period: "P1", elapsed: 0 } })).toEqual({
      period: "P1",
      elapsed: 0,
    });
  });

  it("returns null for anything that is not a GameTime", () => {
    expect(gameTimeOf({})).toBeNull();
    expect(gameTimeOf({ at: "12:41" })).toBeNull();
    expect(gameTimeOf({ at: { period: "", elapsed: 1 } })).toBeNull();
    expect(gameTimeOf({ at: { period: "P1", elapsed: -1 } })).toBeNull();
    expect(gameTimeOf({ at: { period: "P1", elapsed: 1.5 } })).toBeNull();
    expect(gameTimeOf({ at: { period: "P1", elapsed: 1, extra: 1 } })).toBeNull();
    expect(gameTimeOf({ at: null })).toBeNull();
    expect(gameTimeOf({ at: undefined })).toBeNull();
    expect(gameTimeOf(null)).toBeNull();
    expect(gameTimeOf(undefined)).toBeNull();
    expect(gameTimeOf("12:41")).toBeNull();
    expect(gameTimeOf(761)).toBeNull();
    expect(gameTimeOf([{ period: "P1", elapsed: 1 }])).toBeNull();
  });
});
