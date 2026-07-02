// Seeded PRNG + deterministic shuffle — spec 03 §1/§6.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { mulberry32, shuffle } from "./rng.ts";

describe("mulberry32", () => {
  it("same seed → same sequence", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 100; i++) expect(a()).toBe(b());
  });

  it("different seeds → different sequences", () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    expect(Array.from({ length: 8 }, a)).not.toEqual(Array.from({ length: 8 }, b));
  });

  it("emits uniform values in [0, 1)", () => {
    fc.assert(
      fc.property(fc.integer(), (seed) => {
        const rng = mulberry32(seed);
        for (let i = 0; i < 50; i++) {
          const v = rng();
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThan(1);
        }
      }),
    );
  });
});

describe("shuffle (draw-of-lots)", () => {
  it("is deterministic per seed and does not mutate the input", () => {
    const items = ["A", "B", "C", "D", "E", "F"];
    const frozen = Object.freeze([...items]);
    expect(shuffle(7, frozen)).toEqual(shuffle(7, frozen));
    expect(frozen).toEqual(items);
  });

  it("returns a permutation of the input for any seed", () => {
    fc.assert(
      fc.property(fc.integer(), fc.array(fc.string()), (seed, items) => {
        expect([...shuffle(seed, items)].sort()).toEqual([...items].sort());
      }),
    );
  });

  it("handles empty and single-element arrays", () => {
    expect(shuffle(1, [])).toEqual([]);
    expect(shuffle(1, ["only"])).toEqual(["only"]);
  });

  it("different seeds produce different orders (on a big enough draw)", () => {
    const items = Array.from({ length: 16 }, (_, i) => i);
    expect(shuffle(1, items)).not.toEqual(shuffle(2, items));
  });
});
