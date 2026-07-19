// In-play pinning rotation (PROMPT-64 / v13): live slide interleaves every
// other step; plain cycle otherwise.
import { describe, expect, it } from "vitest";
import { BRACKET_SLIDE_KINDS, bracketSlideLaysOut, rotationLength, slideAt, stepFor } from "../slideshow-rotation";

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

describe("bracketSlideLaysOut (G-audit)", () => {
  const se = [
    { id: "a", round_no: 1, seq_in_round: 1 }, { id: "b", round_no: 1, seq_in_round: 2 },
    { id: "c", round_no: 2, seq_in_round: 1 },
  ];
  // 4-team DE persisted numbering: WB 1–2, LB 5–6, GF 9.
  const de = [
    { id: "w1", round_no: 1, seq_in_round: 1 }, { id: "w2", round_no: 1, seq_in_round: 2 },
    { id: "wf", round_no: 2, seq_in_round: 1 }, { id: "l1", round_no: 5, seq_in_round: 1 },
    { id: "lf", round_no: 6, seq_in_round: 1 }, { id: "gf", round_no: 9, seq_in_round: 1 },
  ];
  it("knockout needs the two-sided layout; DE needs the two-lane layout", () => {
    expect(bracketSlideLaysOut("knockout", se)).toBe(true);
    expect(bracketSlideLaysOut("knockout", de)).toBe(false);
    expect(bracketSlideLaysOut("double_elim", de)).toBe(true);
    expect(bracketSlideLaysOut("double_elim", se)).toBe(false);
  });
  it("stepladder always lays out; the kind set covers all three", () => {
    expect(bracketSlideLaysOut("stepladder", [{ id: "r", round_no: 1, seq_in_round: 1 }])).toBe(true);
    expect([...BRACKET_SLIDE_KINDS].sort()).toEqual(["double_elim", "knockout", "stepladder"]);
  });
});
