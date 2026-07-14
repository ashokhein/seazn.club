import { describe, expect, it } from "vitest";
import { parseFEN, sqIdx } from "../board";
import { pathDistances } from "../paths";

const b = (fen: string) => parseFEN(fen).board;

describe("pathDistances (rook maze)", () => {
  it("detours around a wall: blocked a8 takes 3 moves", () => {
    // rook a1; own wall pawns a2,b2,c2
    const d = pathDistances(b("8/8/8/8/8/8/PPP5/R7 w - - 0 1"), sqIdx("a1"));
    expect(d[sqIdx("a8")]).toBe(3);
    expect(d[sqIdx("a2")]).toBe(-1); // own wall square unreachable
    expect(d[sqIdx("h1")]).toBe(1); // open rank
  });
  it("capture square is reachable but not passable", () => {
    // rook a1, enemy queen a4; a8 hides behind her
    const d = pathDistances(b("8/8/8/8/q7/8/8/R7 w - - 0 1"), sqIdx("a1"));
    expect(d[sqIdx("a4")]).toBe(1);
    expect(d[sqIdx("a8")]).not.toBe(1);
  });
});
