import { describe, expect, it } from "vitest";
import { parseIntCell } from "../parse-int-cell";

// W1 Task 6 fix 1: the int cell editor must never PATCH a NaN / float / negative
// into plan_entitlements.int_value. Blank = unlimited (null); everything else has
// to parse as a non-negative integer. Pure + node-env (no jsdom).
describe("parseIntCell", () => {
  it("treats blank as unlimited (null)", () => {
    expect(parseIntCell("")).toEqual({ ok: true, value: null });
    expect(parseIntCell("   ")).toEqual({ ok: true, value: null });
  });

  it("accepts a non-negative integer", () => {
    expect(parseIntCell("12")).toEqual({ ok: true, value: 12 });
    expect(parseIntCell("0")).toEqual({ ok: true, value: 0 });
    expect(parseIntCell(" 7 ")).toEqual({ ok: true, value: 7 });
  });

  it("rejects a float", () => {
    expect(parseIntCell("5.5")).toEqual({ ok: false });
  });

  it("rejects a non-numeric string", () => {
    expect(parseIntCell("abc")).toEqual({ ok: false });
    // regression: naive Number() would return NaN here and slip through
    expect(parseIntCell("12x")).toEqual({ ok: false });
  });

  it("rejects a negative number", () => {
    expect(parseIntCell("-1")).toEqual({ ok: false });
  });
});
