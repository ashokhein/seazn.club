import { describe, expect, it } from "vitest";
import { parseFEN, sqIdx, sqName } from "../board";
import { legalTargets, applyMove, inCheck, allLegalMoves } from "../moves";

const names = (idxs: number[]) => idxs.map(sqName).sort();
const b = (fen: string) => parseFEN(fen).board;

describe("knight moves", () => {
  it("b1 knight in the corner region -> a3,c3,d2", () => {
    expect(names(legalTargets(b("8/8/8/8/8/8/8/1N6 w - - 0 1"), sqIdx("b1")))).toEqual([
      "a3",
      "c3",
      "d2",
    ]);
  });
  it("e5 knight has 8 moves", () => {
    expect(legalTargets(b("8/8/8/4N3/8/8/8/8 w - - 0 1"), sqIdx("e5"))).toHaveLength(8);
  });
});

describe("pawn moves", () => {
  it("e2 pawn -> e3,e4 (double from start)", () => {
    expect(names(legalTargets(b("8/8/8/8/8/8/4P3/8 w - - 0 1"), sqIdx("e2")))).toEqual([
      "e3",
      "e4",
    ]);
  });
  it("captures diagonally, both colors", () => {
    const board = b("8/8/8/3p4/4P3/8/8/8 w - - 0 1");
    expect(names(legalTargets(board, sqIdx("e4")))).toContain("d5");
    expect(names(legalTargets(board, sqIdx("d5")))).toContain("e4");
  });
  it("promotion auto-queens", () => {
    const after = applyMove(b("8/4P3/8/8/8/8/8/8 w - - 0 1"), sqIdx("e7"), sqIdx("e8"));
    expect(after[sqIdx("e8")]).toBe("Q");
  });
  it("a-file pawn does not wrap to h-file", () => {
    expect(names(legalTargets(b("8/8/8/8/8/7p/P7/8 w - - 0 1"), sqIdx("a2")))).not.toContain(
      "h3",
    );
  });
});

describe("sliders", () => {
  it("rook stops before own pawn", () => {
    const t = names(legalTargets(b("8/8/8/3R4/8/3P4/8/8 w - - 0 1"), sqIdx("d5")));
    expect(t).not.toContain("d3");
    expect(t).toContain("d4");
  });
});

describe("check and legality", () => {
  it("pinned rook stays on the e-file but may capture the pinner", () => {
    const t = names(legalTargets(b("4r3/8/8/8/4R3/8/8/4K3 w - - 0 1"), sqIdx("e4")));
    expect(t.every((s) => s[0] === "e")).toBe(true);
    expect(t).toContain("e8");
  });
  it("king in check must leave the file", () => {
    const board = b("4r3/8/8/8/8/8/8/4K3 w - - 0 1");
    expect(inCheck(board, true)).toBe(true);
    expect(names(legalTargets(board, sqIdx("e1"))).every((s) => s[0] !== "e")).toBe(true);
  });
  it("allLegalMoves only yields the side's pieces", () => {
    for (const m of allLegalMoves(b("4r3/8/8/8/8/8/8/4K3 w - - 0 1"), true)) {
      expect(sqName(m.from)).toBe("e1");
    }
  });
});
