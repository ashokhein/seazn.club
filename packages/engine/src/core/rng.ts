// Seeded PRNG — spec 03 §1/§6. No Math.random() anywhere in the engine
// (boundary gate enforced); randomness for draw-of-lots enters as a seed so
// fixture generation is deterministic and regeneration idempotent (spec 03 §4).

export type Rng = () => number; // uniform in [0, 1)

// mulberry32 — tiny, fast, good-enough 32-bit generator for draws/shuffles.
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Deterministic Fisher-Yates for draw-of-lots: same seed + same items → same
// order. Returns a new array; never mutates the input.
export function shuffle<T>(seed: number, items: readonly T[]): T[] {
  const rng = mulberry32(seed);
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}
