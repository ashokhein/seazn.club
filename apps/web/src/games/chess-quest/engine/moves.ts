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
