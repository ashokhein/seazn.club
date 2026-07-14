import { describe, expect, it } from "vitest";
import { randSquares } from "../rand";

describe("randSquares", () => {
  it("returns n distinct squares avoiding exclusions", () => {
    for (let run = 0; run < 20; run++) {
      const out = randSquares(6, [10, 20, 30]);
      expect(out).toHaveLength(6);
      expect(new Set(out).size).toBe(6);
      for (const i of out) {
        expect([10, 20, 30]).not.toContain(i);
        expect(i).toBeGreaterThanOrEqual(0);
        expect(i).toBeLessThan(64);
      }
    }
  });
  it("honors the allowed filter", () => {
    const even = (i: number) => i % 2 === 0;
    for (let run = 0; run < 20; run++) {
      for (const i of randSquares(5, [], even)) expect(i % 2).toBe(0);
    }
  });
  it("caps at the pool size", () => {
    const only3 = (i: number) => i < 3;
    expect(randSquares(10, [], only3)).toHaveLength(3);
  });
});
