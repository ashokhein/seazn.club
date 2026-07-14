"use client";

// Coin Hop — collect all 6 coins in as few moves as you can. Port of
// js/games.js coinHop (lines 197–286): piece picker chips, bishop coins stay
// on its color, pawn never promotes here, slider/stepper star pars.
import { useCallback, useEffect, useState } from "react";
import { applyMove, fileOf, pieceTargets, rankRow } from "../../engine";
import { emptyBoard, randSquares } from "../../lib/rand";
import { sfx } from "../../lib/sfx";
import { STAR_RULES } from "../../lib/stars";
import { useProgress } from "../../lib/progress";
import { Board, GLYPH, Highlight } from "../Board";
import { GameShell } from "../GameShell";

const NAMES: Record<string, string> = {
  R: "Rook",
  B: "Bishop",
  N: "Knight",
  Q: "Queen",
  K: "King",
  P: "Pawn",
};

export function CoinHop({ pieces = ["N"] }: { pieces?: string[] }) {
  const progress = useProgress();
  const [piece, setPiece] = useState(pieces[0]);
  const [position, setPosition] = useState<string[]>(emptyBoard());
  const [pieceAt, setPieceAt] = useState(-1);
  const [coins, setCoins] = useState<Set<number>>(new Set());
  const [moves, setMoves] = useState(0);
  const [sel, setSel] = useState(false);
  const [done, setDone] = useState(false);
  const [status, setStatus] = useState("");
  const [highlights, setHighlights] = useState<Partial<Record<number, Highlight>>>({});
  const [pop, setPop] = useState<{ idx: number; n: number } | null>(null);
  const [shake, setShake] = useState(0);

  const setup = useCallback(
    (p: string) => {
      setDone(false);
      setSel(false);
      setMoves(0);
      setHighlights({});
      const arr = emptyBoard();
      const at = 27 + Math.floor(Math.random() * 10); // around the middle
      arr[at] = p;
      const sameColor = (i: number) =>
        (fileOf(i) + rankRow(i)) % 2 === (fileOf(at) + rankRow(at)) % 2;
      const coinIdxs = randSquares(6, [at], p === "B" ? sameColor : null);
      setPosition(arr);
      setPieceAt(at);
      setCoins(new Set(coinIdxs));
      setStatus(
        `Tap the ${NAMES[p].toLowerCase()}, then tap where it should go. Collect all 6 coins!`,
      );
    },
    [],
  );

  useEffect(() => setup(piece), [piece, setup]);

  function finish(totalMoves: number) {
    setDone(true);
    const stars = STAR_RULES.coinHop(totalMoves, piece);
    progress.setGameStars("coinHop", stars);
    setStatus(`All coins collected in <strong>${totalMoves}</strong> moves! ${"★".repeat(stars)}`);
    sfx.fanfare();
  }

  function onTap(idx: number) {
    if (done) return;
    if (idx === pieceAt) {
      setSel(true);
      const hl: Partial<Record<number, Highlight>> = { [idx]: "sel" };
      for (const t of pieceTargets(position, idx)) hl[t] = "move";
      setHighlights(hl);
      return;
    }
    if (sel && pieceTargets(position, pieceAt).includes(idx)) {
      let next = applyMove(position, pieceAt, idx);
      // keep a pawn a pawn even across the last rank in this game
      if (piece === "P") {
        next = next.slice();
        next[idx] = "P";
      }
      const nMoves = moves + 1;
      setPosition(next);
      setPieceAt(idx);
      setMoves(nMoves);
      setSel(false);
      setHighlights({});
      setPop({ idx, n: nMoves });
      if (coins.has(idx)) {
        const left = new Set(coins);
        left.delete(idx);
        setCoins(left);
        sfx.coin();
        if (left.size === 0) finish(nMoves);
      } else {
        sfx.move();
      }
    } else if (sel) {
      setShake((s) => s + 1);
    }
  }

  return (
    <GameShell
      title="Coin Hop"
      score={
        <span>
          🪙 {coins.size} left &nbsp; 👣 {moves} moves
        </span>
      }
      status={status}
      extra={
        pieces.length > 1 ? (
          <div className="flex flex-wrap gap-2">
            {pieces.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPiece(p)}
                className={`rounded-full border px-3 py-1 text-sm font-medium ${
                  p === piece
                    ? "border-purple-600 bg-purple-600 text-white"
                    : "border-purple-300 bg-white text-purple-800 hover:bg-purple-50"
                }`}
              >
                {GLYPH[p]} {NAMES[p]}
              </button>
            ))}
          </div>
        ) : null
      }
      controls={
        <button type="button" className="btn btn-ghost" onClick={() => setup(piece)}>
          New coins
        </button>
      }
    >
      <Board
        position={position}
        labels
        coins={coins}
        highlights={highlights}
        popToken={pop}
        shakeToken={shake}
        onTap={onTap}
      />
    </GameShell>
  );
}
