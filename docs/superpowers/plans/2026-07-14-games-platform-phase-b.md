# Seazn Games — Phase B (Chess Quest Engine + Content) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pure TypeScript chess engine + fully transcribed, machine-verified curriculum/puzzle content for Chess Quest — zero UI, fully green under vitest.

**Architecture:** `apps/web/src/games/chess-quest/engine/` — five focused pure modules (board, moves, mate, tactics, paths) with a barrel index; `content/` — typed data transcribed from the original `~/GitHub/chess-quest` app plus a verification suite that machine-checks every puzzle and the curriculum shape (the original caught 2 bad puzzles this way; keep that rigor).

**Tech Stack:** TypeScript (strict), Vitest (node env, `@` → `src` alias). No React, no DOM, no DB in this phase.

**Spec:** `docs/superpowers/specs/2026-07-14-seazn-games-chess-quest-design.md` (Phase B). Phase A landed on branch `games-platform` (PR #92).

## Global Constraints

- Branch: `games-platform` (continue on it while PR #92 is open).
- Everything in this phase lives under `apps/web/src/games/chess-quest/{engine,content}/`.
- Engine is pure: no imports outside these folders, no `window`, no side effects.
- Board model (locked, matches original so content transcribes 1:1): `Board = string[]` of 64; index 0 = a8 … 63 = h1 (FEN reading order); pieces `"PNBRQK"` white / `"pnbrqk"` black / `""` empty; **no castling, no en passant; promotion always auto-queens** (curriculum never needs more).
- Content is **transcribed, not re-authored** from `~/GitHub/chess-quest/js/puzzles.js` and `js/curriculum.js` — FEN strings, solutions, names, hints, lesson copy (both Story and Classic registers) copied verbatim; only the container syntax becomes typed TS. Original repo stays untouched.
- Tests co-located per repo pattern: `engine/__tests__/*.test.ts`, `content/__tests__/*.test.ts` (like `src/server/usecases/__tests__/`).
- Test commands run from `apps/web`; use `rtk proxy npx vitest run <path>` (plain `npx vitest` output gets truncated by the rtk hook).
- Conventional commits, `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer.

---

### Task 1: Board module — squares, pieces, FEN

**Files:**
- Create: `apps/web/src/games/chess-quest/engine/board.ts`
- Test: `apps/web/src/games/chess-quest/engine/__tests__/board.test.ts`

**Interfaces:**
- Produces (all later tasks consume): `type Piece = string`, `type Board = Piece[]`, `type Move = { from: number; to: number }`, `const FILES = "abcdefgh"`, `sqIdx(name: string): number`, `sqName(idx: number): string`, `fileOf(idx: number): number`, `rankRow(idx: number): number`, `isWhitePiece(p: Piece): boolean`, `isBlackPiece(p: Piece): boolean`, `parseFEN(fen: string): { board: Board; whiteToMove: boolean }`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/games/chess-quest/engine/__tests__/board.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `apps/web`): `rtk proxy npx vitest run src/games/chess-quest/engine/__tests__/board.test.ts`
Expected: FAIL — cannot resolve `../board`.

- [ ] **Step 3: Implement**

```ts
// apps/web/src/games/chess-quest/engine/board.ts
// Chess Quest engine — board representation.
// Board: array of 64. Index 0 = a8 … 63 = h1 (FEN reading order).
// Pieces: "PNBRQK" white, "pnbrqk" black, "" empty.
// Scope: no castling or en passant — the mini-games and puzzle set never
// need them. Pawn promotion is always to a queen (kid-simple).

export type Piece = string;
export type Board = Piece[];
export type Move = { from: number; to: number };

export const FILES = "abcdefgh";

export function sqIdx(name: string): number {
  const file = FILES.indexOf(name[0]);
  const rank = parseInt(name[1], 10);
  return (8 - rank) * 8 + file;
}

export function sqName(idx: number): string {
  return FILES[idx % 8] + (8 - Math.floor(idx / 8));
}

export function fileOf(idx: number): number {
  return idx % 8;
}

// 0 = rank 8, 7 = rank 1
export function rankRow(idx: number): number {
  return Math.floor(idx / 8);
}

export function isWhitePiece(p: Piece): boolean {
  return p !== "" && p === p.toUpperCase();
}

export function isBlackPiece(p: Piece): boolean {
  return p !== "" && p === p.toLowerCase();
}

export function parseFEN(fen: string): { board: Board; whiteToMove: boolean } {
  const parts = fen.trim().split(/\s+/);
  const board: Board = [];
  for (const ch of parts[0]) {
    if (ch === "/") continue;
    if (/\d/.test(ch)) {
      for (let i = 0; i < Number(ch); i++) board.push("");
    } else {
      board.push(ch);
    }
  }
  return { board, whiteToMove: (parts[1] ?? "w") === "w" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `rtk proxy npx vitest run src/games/chess-quest/engine/__tests__/board.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/games/chess-quest/engine/
git commit -m "feat(chess-quest): engine board module — squares, pieces, FEN

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Moves module — attacks, legality, apply

**Files:**
- Create: `apps/web/src/games/chess-quest/engine/moves.ts`
- Test: `apps/web/src/games/chess-quest/engine/__tests__/moves.test.ts`

**Interfaces:**
- Consumes: everything from `./board` (Task 1).
- Produces: `attackSquares(board, idx): number[]`, `isAttacked(board, sq, byWhite): boolean`, `findKing(board, white): number`, `inCheck(board, white): boolean`, `pieceTargets(board, idx): number[]`, `applyMove(board, from, to): Board`, `legalTargets(board, idx): number[]`, `allLegalMoves(board, white): Move[]`. Tasks 3–5 and all content verification consume these.

- [ ] **Step 1: Write the failing test** (ports the original suite's intent: knight edge/center, pawn push/capture/promotion/no-wrap, slider blocking, pins, king-in-check legality)

```ts
// apps/web/src/games/chess-quest/engine/__tests__/moves.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk proxy npx vitest run src/games/chess-quest/engine/__tests__/moves.test.ts`
Expected: FAIL — cannot resolve `../moves`.

- [ ] **Step 3: Implement**

```ts
// apps/web/src/games/chess-quest/engine/moves.ts
// Attack generation, move legality, and board updates. Pure functions;
// boards are never mutated (applyMove returns a copy).
import { Board, Move, Piece, fileOf, isWhitePiece, rankRow } from "./board";

const KNIGHT_OFFS = [
  [1, 2],
  [2, 1],
  [2, -1],
  [1, -2],
  [-1, -2],
  [-2, -1],
  [-2, 1],
  [-1, 2],
] as const;
const KING_OFFS = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
] as const;
export const ROOK_DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;
export const BISHOP_DIRS = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
] as const;

type Dir = readonly [number, number];

function onBoard(f: number, r: number): boolean {
  return f >= 0 && f < 8 && r >= 0 && r < 8;
}

// Square reached from idx by (df files, dr rows), or -1 off-board.
export function step(idx: number, df: number, dr: number): number {
  const f = fileOf(idx) + df;
  const r = rankRow(idx) + dr;
  return onBoard(f, r) ? r * 8 + f : -1;
}

export function sliderDirs(type: string): readonly Dir[] {
  if (type === "R") return ROOK_DIRS;
  if (type === "B") return BISHOP_DIRS;
  return [...ROOK_DIRS, ...BISHOP_DIRS];
}

// Squares the piece on idx attacks (check detection). Pawns attack
// diagonally only; sliders stop at the first piece they meet.
export function attackSquares(board: Board, idx: number): number[] {
  const p = board[idx];
  const white = isWhitePiece(p);
  const type = p.toUpperCase();
  const out: number[] = [];

  if (type === "P") {
    const dr = white ? -1 : 1; // white pawns move toward rank 8 (row 0)
    for (const df of [-1, 1]) {
      const t = step(idx, df, dr);
      if (t >= 0) out.push(t);
    }
    return out;
  }
  if (type === "N" || type === "K") {
    for (const [df, dr] of type === "N" ? KNIGHT_OFFS : KING_OFFS) {
      const t = step(idx, df, dr);
      if (t >= 0) out.push(t);
    }
    return out;
  }
  for (const [df, dr] of sliderDirs(type)) {
    let t = step(idx, df, dr);
    while (t >= 0) {
      out.push(t);
      if (board[t] !== "") break;
      t = step(t, df, dr);
    }
  }
  return out;
}

export function isAttacked(board: Board, sq: number, byWhite: boolean): boolean {
  for (let i = 0; i < 64; i++) {
    const p = board[i];
    if (p === "" || isWhitePiece(p) !== byWhite) continue;
    if (attackSquares(board, i).includes(sq)) return true;
  }
  return false;
}

export function findKing(board: Board, white: boolean): number {
  return board.indexOf(white ? "K" : "k");
}

export function inCheck(board: Board, white: boolean): boolean {
  const k = findKing(board, white);
  return k >= 0 && isAttacked(board, k, !white);
}

// Pseudo-legal destinations: respects blockers and capture rules,
// ignores king safety (legalTargets filters that).
export function pieceTargets(board: Board, idx: number): number[] {
  const p = board[idx];
  if (p === "") return [];
  const white = isWhitePiece(p);
  const type = p.toUpperCase();

  if (type === "P") {
    const out: number[] = [];
    const dr = white ? -1 : 1;
    const one = step(idx, 0, dr);
    if (one >= 0 && board[one] === "") {
      out.push(one);
      const startRow = white ? 6 : 1;
      const two = step(idx, 0, 2 * dr);
      if (rankRow(idx) === startRow && two >= 0 && board[two] === "") out.push(two);
    }
    for (const df of [-1, 1]) {
      const t = step(idx, df, dr);
      if (t >= 0 && board[t] !== "" && isWhitePiece(board[t]) !== white) out.push(t);
    }
    return out;
  }

  return attackSquares(board, idx).filter(
    (t) => board[t] === "" || isWhitePiece(board[t]) !== white,
  );
}

export function applyMove(board: Board, from: number, to: number): Board {
  const next = board.slice();
  let p: Piece = next[from];
  if (p.toUpperCase() === "P") {
    const lastRow = isWhitePiece(p) ? 0 : 7;
    if (rankRow(to) === lastRow) p = isWhitePiece(p) ? "Q" : "q";
  }
  next[to] = p;
  next[from] = "";
  return next;
}

export function legalTargets(board: Board, idx: number): number[] {
  const white = isWhitePiece(board[idx]);
  return pieceTargets(board, idx).filter((t) => !inCheck(applyMove(board, idx, t), white));
}

export function allLegalMoves(board: Board, white: boolean): Move[] {
  const out: Move[] = [];
  for (let i = 0; i < 64; i++) {
    const p = board[i];
    if (p === "" || isWhitePiece(p) !== white) continue;
    for (const t of legalTargets(board, i)) out.push({ from: i, to: t });
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `rtk proxy npx vitest run src/games/chess-quest/engine/__tests__/moves.test.ts`
Expected: PASS (9 tests). Also rerun board.test.ts — still green.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/games/chess-quest/engine/
git commit -m "feat(chess-quest): engine moves module — attacks, legality, apply

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Mate module — mate, stalemate, mate-in-1/2, best defense

**Files:**
- Create: `apps/web/src/games/chess-quest/engine/mate.ts`
- Test: `apps/web/src/games/chess-quest/engine/__tests__/mate.test.ts`

**Interfaces:**
- Consumes: `./board`, `./moves`.
- Produces: `isMate(board, white): boolean`, `isStalemate(board, white): boolean`, `hasMateIn1(board, white): boolean`, `isMateIn2After(board, from, to): boolean`, `bestDefense(board): Move | null`. Content verification (Task 6) and the Phase C MateInTwo game consume these.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/games/chess-quest/engine/__tests__/mate.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk proxy npx vitest run src/games/chess-quest/engine/__tests__/mate.test.ts`
Expected: FAIL — cannot resolve `../mate`.

- [ ] **Step 3: Implement**

```ts
// apps/web/src/games/chess-quest/engine/mate.ts
// Game-ending detection and the mate-in-2 verifier used to machine-check
// the puzzle packs (and to judge moves in the Mate in 2 game).
import { Board, Move, isWhitePiece } from "./board";
import { allLegalMoves, applyMove, inCheck } from "./moves";

export function isMate(board: Board, white: boolean): boolean {
  return inCheck(board, white) && allLegalMoves(board, white).length === 0;
}

export function isStalemate(board: Board, white: boolean): boolean {
  return !inCheck(board, white) && allLegalMoves(board, white).length === 0;
}

export function hasMateIn1(board: Board, white: boolean): boolean {
  for (const m of allLegalMoves(board, white)) {
    if (isMate(applyMove(board, m.from, m.to), !white)) return true;
  }
  return false;
}

// Forced mate in exactly two: after this move the enemy is NOT yet mated,
// still has replies, and every one of them leaves us a mate-in-1.
export function isMateIn2After(board: Board, from: number, to: number): boolean {
  const white = isWhitePiece(board[from]);
  const b1 = applyMove(board, from, to);
  if (inCheck(b1, white)) return false;
  if (isMate(b1, !white)) return false;
  const replies = allLegalMoves(b1, !white);
  if (replies.length === 0) return false; // stalemate
  for (const r of replies) {
    if (!hasMateIn1(applyMove(b1, r.from, r.to), white)) return false;
  }
  return true;
}

// Black's toughest reply: the one leaving white the fewest mating moves.
export function bestDefense(board: Board): Move | null {
  let best: Move | null = null;
  let fewest = Infinity;
  for (const r of allLegalMoves(board, false)) {
    const after = applyMove(board, r.from, r.to);
    let mates = 0;
    for (const m of allLegalMoves(after, true)) {
      if (isMate(applyMove(after, m.from, m.to), false)) mates++;
    }
    if (mates < fewest) {
      fewest = mates;
      best = r;
    }
  }
  return best;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `rtk proxy npx vitest run src/games/chess-quest/engine/__tests__/mate.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/games/chess-quest/engine/
git commit -m "feat(chess-quest): engine mate module — mate/stalemate, mate-in-2 verifier

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Tactics module — values, fork/pin/skewer/discovered, coach helpers

**Files:**
- Create: `apps/web/src/games/chess-quest/engine/tactics.ts`
- Test: `apps/web/src/games/chess-quest/engine/__tests__/tactics.test.ts`

**Interfaces:**
- Consumes: `./board`, `./moves` (incl. exported `step`, `sliderDirs`).
- Produces: `pieceValue(p): number`, `isForkAfter(board, to): boolean`, `isPinAfter(board, to): boolean`, `isSkewerAfter(board, to): boolean`, `isDiscoveredAfter(board, to, white): boolean`, `attackersOf(board, sq, byWhite): number[]`, `defendersOf(board, sq): number[]`. Content verification and Phase C TacticTrainer/HangingHunt/coach consume these.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/games/chess-quest/engine/__tests__/tactics.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk proxy npx vitest run src/games/chess-quest/engine/__tests__/tactics.test.ts`
Expected: FAIL — cannot resolve `../tactics`.

If a detector fixture turns out chess-wrong when the module exists (e.g. the fork FEN doesn't actually fork), fix the FEN, not the detector — the detector definitions below are the contract. Verify fixtures by hand against the definitions in the comments.

- [ ] **Step 3: Implement**

```ts
// apps/web/src/games/chess-quest/engine/tactics.ts
// Tactic detectors (Trick Shots / Tactic Trainer judging) and the coach's
// attacker/defender helpers.
import { Board, Piece, isWhitePiece } from "./board";
import { attackSquares, findKing, inCheck, isAttacked, sliderDirs, step } from "./moves";

const VALUE: Record<string, number> = { P: 1, N: 3, B: 3, R: 5, Q: 9, K: 100 };

export function pieceValue(p: Piece): number {
  return VALUE[p.toUpperCase()] ?? 0;
}

// Fork: the piece that just landed on `to` attacks 2+ enemy non-pawn pieces
// (king counts) and stands on a square no enemy piece attacks.
export function isForkAfter(board: Board, to: number): boolean {
  const p = board[to];
  if (p === "") return false;
  const white = isWhitePiece(p);
  const targets = attackSquares(board, to).filter(
    (t) => board[t] !== "" && isWhitePiece(board[t]) !== white && board[t].toUpperCase() !== "P",
  );
  return targets.length >= 2 && !isAttacked(board, to, !white);
}

// Walk each ray of the slider on `sq`; report the first two enemy pieces
// stacked on one ray as {front, back}.
function rayPairs(board: Board, sq: number): { front: number; back: number }[] {
  const p = board[sq];
  const type = p.toUpperCase();
  if (type !== "B" && type !== "R" && type !== "Q") return [];
  const white = isWhitePiece(p);
  const pairs: { front: number; back: number }[] = [];
  for (const [df, dr] of sliderDirs(type)) {
    let t = step(sq, df, dr);
    let front = -1;
    while (t >= 0) {
      if (board[t] !== "") {
        if (isWhitePiece(board[t]) === white) break;
        if (front < 0) {
          front = t;
        } else {
          pairs.push({ front, back: t });
          break;
        }
      }
      t = step(t, df, dr);
    }
  }
  return pairs;
}

// Pin: enemy piece in front is stuck because something bigger (or the king)
// hides behind it. Skewer: the big one is in front and must run.
export function isPinAfter(board: Board, to: number): boolean {
  return rayPairs(board, to).some(
    ({ front, back }) =>
      board[back].toUpperCase() === "K" || pieceValue(board[back]) > pieceValue(board[front]),
  );
}

export function isSkewerAfter(board: Board, to: number): boolean {
  return rayPairs(board, to).some(
    ({ front, back }) =>
      board[front].toUpperCase() === "K" || pieceValue(board[front]) > pieceValue(board[back]),
  );
}

// Discovered attack: after the move, the enemy king is in check from a piece
// OTHER than the one that just moved.
export function isDiscoveredAfter(board: Board, to: number, white: boolean): boolean {
  const k = findKing(board, !white);
  if (k < 0 || !inCheck(board, !white)) return false;
  for (let i = 0; i < 64; i++) {
    const p = board[i];
    if (i !== to && p !== "" && isWhitePiece(p) === white && attackSquares(board, i).includes(k))
      return true;
  }
  return false;
}

// Which pieces of `byWhite` attack this square? (the coach uses these)
export function attackersOf(board: Board, sq: number, byWhite: boolean): number[] {
  const out: number[] = [];
  for (let i = 0; i < 64; i++) {
    const p = board[i];
    if (p !== "" && isWhitePiece(p) === byWhite && attackSquares(board, i).includes(sq)) out.push(i);
  }
  return out;
}

// Which friends could recapture on this piece's square? (its bodyguards)
export function defendersOf(board: Board, sq: number): number[] {
  const p = board[sq];
  if (p === "") return [];
  const white = isWhitePiece(p);
  const probe = board.slice();
  probe[sq] = white ? "p" : "P"; // stand-in enemy piece
  return attackersOf(probe, sq, white);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `rtk proxy npx vitest run src/games/chess-quest/engine/__tests__/tactics.test.ts`
Expected: PASS (8 tests). If a detector test fails, hand-check the FEN fixture against the detector definition first (see Step 2 note) before touching the module.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/games/chess-quest/engine/
git commit -m "feat(chess-quest): engine tactics module — detectors + coach helpers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Paths module + engine barrel

**Files:**
- Create: `apps/web/src/games/chess-quest/engine/paths.ts`
- Create: `apps/web/src/games/chess-quest/engine/index.ts`
- Test: `apps/web/src/games/chess-quest/engine/__tests__/paths.test.ts`

**Interfaces:**
- Consumes: `./board`, `./moves`.
- Produces: `pathDistances(board, from): number[]` (BFS move counts, -1 unreachable — Rook Maze generator); `engine/index.ts` re-exports every public symbol from board, moves, mate, tactics, paths. Content tests and Phase C import from `../engine` (the barrel) only.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/games/chess-quest/engine/__tests__/paths.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk proxy npx vitest run src/games/chess-quest/engine/__tests__/paths.test.ts`
Expected: FAIL — cannot resolve `../paths`.

- [ ] **Step 3: Implement paths + barrel**

```ts
// apps/web/src/games/chess-quest/engine/paths.ts
// Fewest moves for the piece on `from` to reach each square (walls and
// captures respected). -1 = unreachable. Used by the Rook Maze generator.
import { Board } from "./board";
import { pieceTargets } from "./moves";

export function pathDistances(board: Board, from: number): number[] {
  const piece = board[from];
  const dist = new Array<number>(64).fill(-1);
  dist[from] = 0;
  const queue: number[] = [from];
  while (queue.length) {
    const s = queue.shift()!;
    if (board[s] !== "" && s !== from) continue; // stop expanding past a capture
    const b2 = board.slice();
    b2[from] = "";
    b2[s] = piece;
    for (const t of pieceTargets(b2, s)) {
      if (dist[t] === -1) {
        dist[t] = dist[s] + 1;
        queue.push(t);
      }
    }
  }
  return dist;
}
```

```ts
// apps/web/src/games/chess-quest/engine/index.ts
// Public engine surface. Everything outside engine/ imports from here.
export * from "./board";
export * from "./moves";
export * from "./mate";
export * from "./tactics";
export * from "./paths";
```

- [ ] **Step 4: Run the whole engine suite**

Run: `rtk proxy npx vitest run src/games/chess-quest/engine`
Expected: PASS — 5 files (board, moves, mate, tactics, paths), ~30 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/games/chess-quest/engine/
git commit -m "feat(chess-quest): engine paths module + public barrel

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Puzzle content — transcription + machine verification

**Files:**
- Create: `apps/web/src/games/chess-quest/content/puzzles.ts`
- Test: `apps/web/src/games/chess-quest/content/__tests__/puzzles.test.ts`

**Interfaces:**
- Consumes: engine barrel.
- Produces (Phase C games consume): `type MatePuzzle = { fen: string; solution: string; name: string; hint: string }`, `type HuntPuzzle = { fen: string; answer: string }`, `type TacticPuzzle = { fen: string; solution: string }`, `MATE1: MatePuzzle[]`, `HUNTS: HuntPuzzle[]`, `TACTICS: Record<"fork" | "pin" | "skewer" | "disco", TacticPuzzle[]>`, `MATE2: MatePuzzle[]`, `TACTICS2: Record<"fork2" | "pin2" | "skewer2" | "disco2", TacticPuzzle[]>`.

**Source of truth:** `~/GitHub/chess-quest/js/puzzles.js` — read it in full and transcribe **every entry verbatim** (fen, solution, name, hint, answer strings unchanged). Rename `PUZZLES` → `MATE1`; all other collection names keep their original names. Example of the target shape (first MATE1 entry, copied from source):

```ts
export const MATE1: MatePuzzle[] = [
  {
    fen: "6k1/5ppp/8/8/8/8/8/4R1K1 w - - 0 1",
    solution: "e1e8",
    name: "Sneak down the hallway",
    hint: "The back row is wide open — slide all the way!",
  },
  // … every remaining entry from js/puzzles.js, verbatim …
];
```

The verification suite below is the acceptance gate: if transcription drops or mangles an entry, a test fails naming the puzzle. Do not edit puzzle data to make tests pass — a failure means a transcription error (the source set is already machine-verified in the original repo).

- [ ] **Step 1: Write the verification suite first** (fails until puzzles.ts exists; ports the original acceptance checks 1:1)

```ts
// apps/web/src/games/chess-quest/content/__tests__/puzzles.test.ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `rtk proxy npx vitest run src/games/chess-quest/content/__tests__/puzzles.test.ts`
Expected: FAIL — cannot resolve `../puzzles`.

- [ ] **Step 3: Transcribe puzzles.ts**

Read `~/GitHub/chess-quest/js/puzzles.js` in full. Create `content/puzzles.ts` with the type declarations from the Interfaces block and all five collections transcribed verbatim (every fen/solution/name/hint/answer string byte-identical; ~63 FENs total). Keep the original file's section comments.

- [ ] **Step 4: Run to verify it passes**

Run: `rtk proxy npx vitest run src/games/chess-quest/content/__tests__/puzzles.test.ts`
Expected: PASS — every named puzzle green. A single red test = transcription typo in that entry; re-check against the source line.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/games/chess-quest/content/
git commit -m "feat(chess-quest): puzzle packs transcribed + machine-verified

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Curriculum content — lands + lessons + shape verification

**Files:**
- Create: `apps/web/src/games/chess-quest/content/lands.ts`
- Create: `apps/web/src/games/chess-quest/content/lessons.ts`
- Test: `apps/web/src/games/chess-quest/content/__tests__/curriculum.test.ts`

**Interfaces:**
- Consumes: engine barrel (FEN validation in tests); `./puzzles` (pack references).
- Produces (Phase C/D consume):

```ts
// lands.ts
export type Land = {
  id: number;
  glyph: string;
  name: string;
  weeks: [number, number]; // inclusive lesson range
  goal: string;
  check: string; // Story register
  checkClassic: string; // Classic register
  track?: 2; // present on Track 2 lands only (original data shape)
};
export const LANDS: Land[]; // 9 lands: 5 Track 1 + 4 Track 2

// lessons.ts
export type GameId =
  | "squareRace"
  | "coinHop"
  | "pawnWars"
  | "mateInOne"
  | "mateInTwo"
  | "hangingHunt"
  | "tacticTrainer"
  | "rookMaze";
export type LessonCopy = { learn: string; play: string; spark: string };
export type Lesson = {
  n: number; // 1..48
  title?: string; // verify against source — add/require fields to match js/curriculum.js exactly
  learn: string;
  play: string;
  spark: string; // Story register
  classic: LessonCopy; // Classic register
  game: GameId | null; // null = play on a real board
  gameOpts?: Record<string, unknown>;
  diagram?: { fen: string; caption?: string };
};
export const LESSONS: Lesson[]; // 48, ordered
```

**Source of truth:** `~/GitHub/chess-quest/js/curriculum.js` (`LANDS` and `WEEKS` exports). Transcribe verbatim — every copy string in both registers, every `gameOpts`, every diagram FEN. `WEEKS` renames to `LESSONS`; field names otherwise unchanged. If a source lesson has fields beyond the type above, add them to the type rather than dropping data.

- [ ] **Step 1: Write the shape verification suite** (ports original curriculum checks 1:1)

```ts
// apps/web/src/games/chess-quest/content/__tests__/curriculum.test.ts
import { describe, expect, it } from "vitest";
import { parseFEN } from "../../engine";
import { LANDS } from "../lands";
import { LESSONS } from "../lessons";
import { TACTICS, TACTICS2 } from "../puzzles";

const GAME_IDS = [
  "squareRace",
  "coinHop",
  "pawnWars",
  "mateInOne",
  "mateInTwo",
  "hangingHunt",
  "tacticTrainer",
  "rookMaze",
];

describe("curriculum shape", () => {
  it("48 lessons, numbered 1..48 in order", () => {
    expect(LESSONS).toHaveLength(48);
    LESSONS.forEach((l, i) => expect(l.n).toBe(i + 1));
  });
  it("9 lands tiling lessons 1..48 exactly once", () => {
    expect(LANDS).toHaveLength(9);
    const seen = new Array(49).fill(0);
    for (const land of LANDS) {
      for (let i = land.weeks[0]; i <= land.weeks[1]; i++) seen[i]++;
    }
    expect(seen.slice(1).every((c) => c === 1)).toBe(true);
  });
  it("track 2 lands cover lessons 25..48 only", () => {
    for (const land of LANDS.filter((l) => l.track === 2)) {
      expect(land.weeks[0]).toBeGreaterThanOrEqual(25);
    }
  });
  it("every land has both check registers", () => {
    for (const land of LANDS) {
      expect(land.check.length).toBeGreaterThan(0);
      expect(land.checkClassic.length).toBeGreaterThan(0);
    }
  });
  it("every lesson has story + classic copy", () => {
    for (const l of LESSONS) {
      expect(l.learn.length).toBeGreaterThan(0);
      expect(l.play.length).toBeGreaterThan(0);
      expect(l.spark.length).toBeGreaterThan(0);
      expect(l.classic.learn.length).toBeGreaterThan(0);
      expect(l.classic.play.length).toBeGreaterThan(0);
      expect(l.classic.spark.length).toBeGreaterThan(0);
    }
  });
  it("every game id is real", () => {
    for (const l of LESSONS) {
      if (l.game !== null) expect(GAME_IDS).toContain(l.game);
    }
  });
  it("all diagram FENs parse to 64 squares", () => {
    for (const l of LESSONS) {
      if (!l.diagram) continue;
      expect(parseFEN(l.diagram.fen).board, `lesson ${l.n}`).toHaveLength(64);
    }
  });
  it("tactic-trainer lessons point at existing packs", () => {
    for (const l of LESSONS.filter((x) => x.game === "tacticTrainer")) {
      const pack = (l.gameOpts as { pack?: string } | undefined)?.pack ?? "";
      const exists =
        pack in TACTICS || pack in TACTICS2;
      expect(exists, `lesson ${l.n} pack "${pack}"`).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `rtk proxy npx vitest run src/games/chess-quest/content/__tests__/curriculum.test.ts`
Expected: FAIL — cannot resolve `../lands` / `../lessons`.

- [ ] **Step 3: Transcribe lands.ts and lessons.ts**

Read `~/GitHub/chess-quest/js/curriculum.js` in full (it is ~47K — read in chunks). Transcribe `LANDS` → `content/lands.ts` and `WEEKS` → `content/lessons.ts` (renamed `LESSONS`), types as declared in Interfaces. All strings verbatim, both copy registers, all `gameOpts` and `diagram` blocks. Keep the original section comments per land.

- [ ] **Step 4: Run to verify it passes**

Run: `rtk proxy npx vitest run src/games/chess-quest/content`
Expected: PASS — puzzles + curriculum suites both green.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/games/chess-quest/content/
git commit -m "feat(chess-quest): curriculum transcribed (9 lands, 48 lessons) + shape checks

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Full verification

**Files:** none new.

- [ ] **Step 1: Whole chess-quest tree**

Run: `rtk proxy npx vitest run src/games/chess-quest`
Expected: PASS — 7 test files (5 engine + 2 content), zero failures.

- [ ] **Step 2: Full workspace suites + lint + build**

```bash
cd apps/web
rtk proxy npx vitest run 2>&1 | tail -5      # all green (skipped DB suites are normal)
rtk proxy npx eslint src/games 2>&1 | tail -5 # zero problems in games tree
rtk proxy npm run build 2>&1 | tail -5        # compiles clean
```

Expected: no regressions; games tree lints clean (repo has one pre-existing error in `verify-email.tsx` on main — ignore, out of scope).

- [ ] **Step 3: Push**

```bash
git push
```

(Continues PR #92; or if it has merged by then, open a Phase B PR from the branch per the finishing-a-development-branch skill.)

---

### Out of scope (later phases)

- Board/game React components, GameShell, coach UI — Phase C.
- QuestMap, profiles, localStorage store, progress, certificate — Phase D.
- Sfx/voice hooks, status flip to `live`, SEO polish — Phase C/E.
