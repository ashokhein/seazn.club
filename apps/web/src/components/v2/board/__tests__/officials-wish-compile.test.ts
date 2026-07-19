import { describe, expect, it } from "vitest";
import { compileOfficialsWishes, type OfficialsWish } from "../officials-wish-compile";

describe("compileOfficialsWishes", () => {
  it("is empty for no wishes (textarea stays blank)", () => {
    expect(compileOfficialsWishes([])).toBe("");
  });

  it("compiles the senior-finals wish", () => {
    expect(compileOfficialsWishes([{ kind: "senior_finals" }])).toBe(
      "Put senior referees on the finals.",
    );
  });

  it("compiles the spread-evenly wish", () => {
    expect(compileOfficialsWishes([{ kind: "spread_even" }])).toBe(
      "Spread officiating duties evenly across the roster.",
    );
  });

  it("compiles the {official} only {window} wish with the picked name + edge + time", () => {
    const w: OfficialsWish = {
      kind: "only_window",
      officialId: "o1",
      officialName: "Priya Shah",
      edge: "before",
      time: "14:00",
    };
    expect(compileOfficialsWishes([w])).toBe("Only assign Priya Shah to matches before 14:00.");
  });

  it("space-joins multiple wishes into one English instruction", () => {
    const out = compileOfficialsWishes([
      { kind: "senior_finals" },
      { kind: "spread_even" },
    ]);
    expect(out).toBe(
      "Put senior referees on the finals. Spread officiating duties evenly across the roster.",
    );
  });

  it("keeps the compiled text English regardless of UI locale (by construction)", () => {
    // No locale is threaded in — the compiler is deliberately English-only.
    expect(compileOfficialsWishes([{ kind: "senior_finals" }])).toMatch(/^Put senior referees/);
  });
});
