import { describe, expect, it } from "vitest";
import { sqIdx, sqName, parseFEN, isWhitePiece, isBlackPiece } from "../board";

describe("square mapping", () => {
  it("a8 is index 0, h1 is 63", () => {
    expect(sqIdx("a8")).toBe(0);
    expect(sqIdx("h1")).toBe(63);
  });
  it("round-trips every square", () => {
    for (let i = 0; i < 64; i++) expect(sqIdx(sqName(i))).toBe(i);
  });
});

describe("pieces", () => {
  it("classifies colors; empty is neither", () => {
    expect(isWhitePiece("Q")).toBe(true);
    expect(isBlackPiece("q")).toBe(true);
    expect(isWhitePiece("")).toBe(false);
    expect(isBlackPiece("")).toBe(false);
  });
});

describe("parseFEN", () => {
  it("start position: 64 squares, correct corners, white to move", () => {
    const { board, whiteToMove } = parseFEN(
      "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    );
    expect(board).toHaveLength(64);
    expect(board[sqIdx("a8")]).toBe("r");
    expect(board[sqIdx("e1")]).toBe("K");
    expect(board[sqIdx("e4")]).toBe("");
    expect(whiteToMove).toBe(true);
  });
  it("reads side to move; defaults to white", () => {
    expect(parseFEN("8/8/8/8/8/8/8/8 b - - 0 1").whiteToMove).toBe(false);
    expect(parseFEN("8/8/8/8/8/8/8/8").whiteToMove).toBe(true);
  });
});
