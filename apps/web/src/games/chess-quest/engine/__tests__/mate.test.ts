import { describe, expect, it } from "vitest";
import { parseFEN, sqIdx } from "../board";
import { applyMove, legalTargets } from "../moves";
import { isMate, isStalemate, hasMateIn1, isMateIn2After, bestDefense } from "../mate";

const b = (fen: string) => parseFEN(fen).board;

describe("mate and stalemate", () => {
  it("back-rank mate detected", () => {
    const board = applyMove(b("6k1/5ppp/8/8/8/8/8/4R1K1 w - - 0 1"), sqIdx("e1"), sqIdx("e8"));
    expect(isMate(board, false)).toBe(true);
  });
  it("corner stalemate detected, and is not mate", () => {
    const board = b("k7/2Q5/1K6/8/8/8/8/8 b - - 0 1");
    expect(isStalemate(board, false)).toBe(true);
    expect(isMate(board, false)).toBe(false);
  });
});

describe("mate-in-2 verifier (ladder pattern)", () => {
  // Kh7 vs Ra6+Rb5: Rb7+ forces Kg8/Kh8, then Ra8#.
  const fen = "8/7k/R7/1R6/8/8/8/6K1 w - - 0 1";
  it("no mate-in-1 here", () => {
    expect(hasMateIn1(b(fen), true)).toBe(false);
  });
  it("Rb7+ is mate in 2; Rb6 is not", () => {
    expect(isMateIn2After(b(fen), sqIdx("b5"), sqIdx("b7"))).toBe(true);
    expect(isMateIn2After(b(fen), sqIdx("b5"), sqIdx("b6"))).toBe(false);
  });
  it("bestDefense returns a legal black king reply", () => {
    const afterCheck = applyMove(b(fen), sqIdx("b5"), sqIdx("b7"));
    const d = bestDefense(afterCheck);
    expect(d).not.toBeNull();
    expect(afterCheck[d!.from]).toBe("k");
    expect(legalTargets(afterCheck, d!.from)).toContain(d!.to);
  });
});

describe("mate-in-2 guardrails", () => {
  it("an immediate mate is not mate-in-2", () => {
    const board = b("6k1/5ppp/8/8/8/8/8/4R1K1 w - - 0 1");
    expect(hasMateIn1(board, true)).toBe(true);
    expect(isMateIn2After(board, sqIdx("e1"), sqIdx("e8"))).toBe(false);
  });
  it("bare kings force nothing", () => {
    const board = b("k7/8/8/8/8/8/8/K7 w - - 0 1");
    expect(hasMateIn1(board, true)).toBe(false);
    expect(isMateIn2After(board, sqIdx("a1"), sqIdx("a2"))).toBe(false);
  });
});
