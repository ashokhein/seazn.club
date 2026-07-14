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
