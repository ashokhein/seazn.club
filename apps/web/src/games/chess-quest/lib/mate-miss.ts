// Diagnose WHY a "find the checkmate" move failed, so the coach can nudge the
// player toward the right idea (port of js/games.js mateMissCoach, 386–429).
// Pure classification; the game component renders the matching coach flow.
import { Board, allLegalMoves, inCheck } from "../engine";

export type MateMiss =
  | { kind: "no-check" } // the move doesn't even give check
  | { kind: "escape"; escapes: number[] } // check, but the king can step away
  | { kind: "capture-block" }; // check, king stuck, but the checker can be met

export function classifyMateMiss(next: Board): MateMiss {
  if (!inCheck(next, false)) return { kind: "no-check" };
  const escapes = allLegalMoves(next, false)
    .filter((m) => next[m.from] === "k")
    .map((m) => m.to);
  if (escapes.length) return { kind: "escape", escapes };
  return { kind: "capture-block" };
}
