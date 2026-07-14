import { describe, expect, it } from "vitest";
import { parseFEN, sqIdx, sqName } from "../../engine";
import { classifyMateMiss } from "../mate-miss";

const b = (fen: string) => parseFEN(fen).board;

describe("classifyMateMiss (why a 'find the mate' move wasn't mate)", () => {
  it("no-check: the move doesn't even attack the black king", () => {
    // rook on b1 (not the a-file), black king a8 → not in check
    const res = classifyMateMiss(b("k7/8/8/8/8/8/8/1R4K1 w - - 0 1"));
    expect(res.kind).toBe("no-check");
  });

  it("escape: check but the king has a flight square", () => {
    // Rook a1 checks Ka8 down the a-file; king can step to b7/b8 → escape
    const checked = classifyMateMiss(b("k7/8/8/8/8/8/8/R6K w - - 0 1"));
    expect(checked.kind).toBe("escape");
    if (checked.kind === "escape") {
      expect(checked.escapes.map(sqName)).toContain("b7");
    }
  });

  it("capture-block: check, king stuck, but a black piece can interpose", () => {
    // Rook e8 checks Kg8 along the 8th; king boxed by its own f7/g7/h7 pawns
    // (f8/h8 covered by the rook), but the d7 knight can block on f8 → not mate.
    const res = classifyMateMiss(b("4R1k1/3n1ppp/8/8/8/8/8/6K1 w - - 0 1"));
    expect(res.kind).toBe("capture-block");
  });
});
