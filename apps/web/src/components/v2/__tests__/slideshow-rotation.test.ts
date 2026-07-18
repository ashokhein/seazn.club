// In-play pinning rotation (PROMPT-64 / v13): live slide interleaves every
// other step; plain cycle otherwise.
import { describe, expect, it } from "vitest";
import { rotationLength, slideAt, stepFor } from "../slideshow-rotation";

const plain = [{}, {}, {}];
const withLive = [{}, { pinned: true }, {}, {}]; // live slide at index 1

describe("slideshow rotation", () => {
  it("no pinned slide: plain cycle", () => {
    expect([0, 1, 2, 3].map((s) => slideAt(s, plain))).toEqual([0, 1, 2, 0]);
    expect(rotationLength(plain)).toBe(3);
  });

  it("pinned slide interleaves: live, other, live, other…", () => {
    const seq = Array.from({ length: 8 }, (_, s) => slideAt(s, withLive));
    expect(seq).toEqual([1, 0, 1, 2, 1, 3, 1, 0]);
    expect(rotationLength(withLive)).toBe(6);
  });

  it("stepFor round-trips through slideAt (dot navigation)", () => {
    for (let i = 0; i < withLive.length; i++) {
      expect(slideAt(stepFor(i, withLive), withLive)).toBe(i);
    }
    for (let i = 0; i < plain.length; i++) {
      expect(slideAt(stepFor(i, plain), plain)).toBe(i);
    }
  });

  it("degenerate decks are safe", () => {
    expect(slideAt(5, [])).toBe(0);
    expect(slideAt(5, [{ pinned: true }])).toBe(0);
    expect(rotationLength([{ pinned: true }])).toBe(1);
  });
});
