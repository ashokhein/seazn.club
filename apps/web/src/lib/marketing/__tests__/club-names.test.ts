import { describe, expect, it } from "vitest";
import { clubNames } from "../club-names";

describe("clubNames", () => {
  it("is deterministic per seed", () => {
    expect(clubNames(8, 42)).toEqual(clubNames(8, 42));
  });
  it("differs across seeds", () => {
    expect(clubNames(8, 1)).not.toEqual(clubNames(8, 2));
  });
  it("returns distinct names, clamped 4..16", () => {
    const names = clubNames(16, 7);
    expect(new Set(names).size).toBe(16);
    expect(clubNames(2, 7)).toHaveLength(4);
    expect(clubNames(99, 7)).toHaveLength(16);
  });
});
