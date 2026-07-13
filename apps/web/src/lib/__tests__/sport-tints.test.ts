// v8: competition banner tints — one hue per sport, house violet fallback.
import { describe, expect, it } from "vitest";
import { sportTint } from "../sport-tints";

describe("sportTint", () => {
  it("returns a hex tint for known sports", () => {
    expect(sportTint("badminton")).toMatch(/^#[0-9a-f]{6}$/i);
    expect(sportTint("football")).not.toBe(sportTint("badminton"));
  });

  it("falls back to the house violet for unknown/null keys", () => {
    expect(sportTint("croquet")).toBe("#7c3aed");
    expect(sportTint(null)).toBe("#7c3aed");
  });
});
