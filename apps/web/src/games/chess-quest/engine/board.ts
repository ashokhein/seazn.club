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
