import { describe, expect, it } from "vitest";
import {
  parseFEN,
  sqIdx,
  sqName,
  isWhitePiece,
  isAttacked,
  inCheck,
  legalTargets,
  applyMove,
  isMate,
  hasMateIn1,
  isMateIn2After,
  isForkAfter,
  isPinAfter,
  isSkewerAfter,
  isDiscoveredAfter,
} from "../../engine";
import { MATE1, HUNTS, TACTICS, MATE2, TACTICS2 } from "../puzzles";

const mv = (sol: string) => ({ from: sqIdx(sol.slice(0, 2)), to: sqIdx(sol.slice(2, 4)) });

describe("MATE1: every solution is a legal mate-in-1", () => {
  it.each(MATE1.map((p) => [p.name, p] as const))("%s", (_name, pz) => {
    const { board } = parseFEN(pz.fen);
    const { from, to } = mv(pz.solution);
    expect(inCheck(board, false)).toBe(false); // black not already in check
    expect(legalTargets(board, from)).toContain(to);
    expect(isMate(applyMove(board, from, to), false)).toBe(true);
  });
});

describe("HUNTS: exactly one hanging black piece, matching the answer", () => {
  it.each(HUNTS.map((h) => [h.answer, h] as const))("hunt %s", (_a, h) => {
    const { board } = parseFEN(h.fen);
    const hanging: string[] = [];
    for (let i = 0; i < 64; i++) {
      const p = board[i];
      if (p === "" || isWhitePiece(p) || p === "k") continue;
      const attacked = isAttacked(board, i, true);
      const probe = board.slice();
      probe[i] = "P"; // stand-in white piece: can black recapture here?
      const defended = isAttacked(probe, i, false);
      if (attacked && !defended) hanging.push(sqName(i));
    }
    expect(hanging).toEqual([h.answer]);
    expect(inCheck(board, false)).toBe(false);
    expect(inCheck(board, true)).toBe(false);
  });
});

const DETECTOR = {
  fork: isForkAfter,
  pin: isPinAfter,
  skewer: isSkewerAfter,
  disco: (b: string[], to: number) => isDiscoveredAfter(b, to, true),
} as const;

describe("TACTICS: every solution performs its named trick", () => {
  for (const pack of ["fork", "pin", "skewer", "disco"] as const) {
    it.each(TACTICS[pack].map((tc, i) => [`${pack} ${i + 1}`, tc] as const))(
      "%s",
      (_label, tc) => {
        const { board } = parseFEN(tc.fen);
        const { from, to } = mv(tc.solution);
        expect(inCheck(board, false)).toBe(false);
        expect(inCheck(board, true)).toBe(false);
        expect(legalTargets(board, from)).toContain(to);
        expect(DETECTOR[pack](applyMove(board, from, to), to)).toBe(true);
      },
    );
  }
});

describe("MATE2: forced in exactly two, never one", () => {
  it("has 12 puzzles", () => {
    expect(MATE2).toHaveLength(12);
  });
  it.each(MATE2.map((p) => [p.name, p] as const))("%s", (_name, pz) => {
    const { board } = parseFEN(pz.fen);
    const { from, to } = mv(pz.solution);
    expect(inCheck(board, false)).toBe(false);
    expect(inCheck(board, true)).toBe(false);
    expect(hasMateIn1(board, true)).toBe(false); // no hidden mate-in-1 (caught 2 bad puzzles before)
    expect(legalTargets(board, from)).toContain(to);
    expect(isMateIn2After(board, from, to)).toBe(true);
  });
});

const DETECTOR2 = {
  fork2: isForkAfter,
  pin2: isPinAfter,
  skewer2: isSkewerAfter,
  disco2: (b: string[], to: number) => isDiscoveredAfter(b, to, true),
} as const;

describe("TACTICS2: tier-2 packs", () => {
  it("has all four packs of 3", () => {
    for (const pack of ["fork2", "pin2", "skewer2", "disco2"] as const) {
      expect(TACTICS2[pack]).toHaveLength(3);
    }
  });
  for (const pack of ["fork2", "pin2", "skewer2", "disco2"] as const) {
    it.each(TACTICS2[pack].map((tc, i) => [`${pack} ${i + 1}`, tc] as const))(
      "%s",
      (_label, tc) => {
        const { board } = parseFEN(tc.fen);
        const { from, to } = mv(tc.solution);
        expect(inCheck(board, false)).toBe(false);
        expect(inCheck(board, true)).toBe(false);
        expect(legalTargets(board, from)).toContain(to);
        expect(DETECTOR2[pack](applyMove(board, from, to), to)).toBe(true);
      },
    );
  }
});
