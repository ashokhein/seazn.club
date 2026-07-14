import { describe, expect, it } from "vitest";
import { isWhitePiece, legalTargets, applyMove, parseFEN, sqIdx } from "../../engine";
import { OPENINGS, OPENING_IDS } from "../openings";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

describe("openings are engine-legal mainlines", () => {
  it("has the five classic-set openings", () => {
    expect([...OPENING_IDS].sort()).toEqual(
      ["italian", "london", "ruyLopez", "scandinavian", "scotch"].sort(),
    );
  });

  it.each(OPENING_IDS.map((id) => [id, OPENINGS[id]] as const))("%s replays legally", (_id, op) => {
    let board = parseFEN(START).board;
    let whiteToMove = true;
    for (const mv of op.line) {
      const from = sqIdx(mv.from);
      const to = sqIdx(mv.to);
      expect(board[from]).not.toBe("");
      expect(isWhitePiece(board[from])).toBe(whiteToMove);
      expect(legalTargets(board, from), `${op.id} ${mv.san}`).toContain(to);
      board = applyMove(board, from, to);
      whiteToMove = !whiteToMove;
    }
    // the learner actually moves in this line
    expect(op.line.some((_, i) => (i % 2 === 0) === (op.learnerSide === "white"))).toBe(true);
    expect(op.idea.length).toBeGreaterThan(0);
  });
});
