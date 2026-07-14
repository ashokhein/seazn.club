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
