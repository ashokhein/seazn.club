import { describe, expect, it } from "vitest";
import { parseFEN, sqIdx, sqName } from "../board";
import { applyMove } from "../moves";
import {
  pieceValue,
  isForkAfter,
  isPinAfter,
  isSkewerAfter,
  isDiscoveredAfter,
  attackersOf,
  defendersOf,
} from "../tactics";

const b = (fen: string) => parseFEN(fen).board;
const names = (idxs: number[]) => idxs.map(sqName).sort();

describe("piece values", () => {
  it("standard values, case-insensitive, empty is 0", () => {
    expect(pieceValue("Q")).toBe(9);
    expect(pieceValue("n")).toBe(3);
    expect(pieceValue("")).toBe(0);
  });
});

describe("detectors", () => {
  it("royal knight fork detected (knight on c7 hits king a8 and rook e8)", () => {
    const board = applyMove(b("k3r3/8/2N5/8/8/8/8/6K1 w - - 0 1"), sqIdx("c6"), sqIdx("c7"));
    expect(isForkAfter(board, sqIdx("c7"))).toBe(true);
  });
  it("pin detected: rook pins knight to the king behind it", () => {
    // From e1 up the e-file: knight e5 in front, king e8 hides behind → pin.
    const board = b("4k3/8/8/4n3/8/8/8/4R1K1 w - - 0 1");
    expect(isPinAfter(board, sqIdx("e1"))).toBe(true);
  });
  it("skewer detected: king in front must run, queen behind falls", () => {
    // From e1 up the e-file: king e6 in front, queen e8 behind → skewer.
    const board = b("4q3/8/4k3/8/8/8/8/4R1K1 b - - 0 1");
    expect(isSkewerAfter(board, sqIdx("e1"))).toBe(true);
  });
  it("discovered check: the mover is not the checker", () => {
    // Bishop moves off the e-file, Re1 behind gives the check
    const start = b("4k3/8/8/8/4B3/8/8/4R1K1 w - - 0 1");
    const after = applyMove(start, sqIdx("e4"), sqIdx("c6"));
    expect(isDiscoveredAfter(after, sqIdx("c6"), true)).toBe(true);
  });
});

describe("coach helpers (attackers and bodyguards)", () => {
  // black bishop e7 attacked by Re1; knight a6 guarded by pawn b7
  const board = b("6k1/1p2bppp/n7/8/8/8/8/4R1K1 w - - 0 1");
  it("attackersOf finds the rook", () => {
    expect(names(attackersOf(board, sqIdx("e7"), true))).toEqual(["e1"]);
  });
  it("bishop e7 has no bodyguards", () => {
    expect(defendersOf(board, sqIdx("e7"))).toHaveLength(0);
  });
  it("knight a6 guarded by the b7 pawn", () => {
    expect(names(defendersOf(board, sqIdx("a6")))).toEqual(["b7"]);
  });
});
