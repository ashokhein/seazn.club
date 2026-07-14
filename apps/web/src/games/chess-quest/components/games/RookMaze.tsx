"use client";

// Rook Maze — slide around your own pawns to catch the hiding prey in as few
// moves as the shortest path allows. Port of js/games.js rookMaze (708–808):
// generator with a distance floor, par display, blocked-lane coaching.
import { useCallback, useEffect, useState } from "react";
import { applyMove, pathDistances, pieceTargets } from "../../engine";
import { emptyBoard, randSquares } from "../../lib/rand";
import { sfx } from "../../lib/sfx";
import { STAR_RULES } from "../../lib/stars";
import { useLater } from "../../lib/use-later";
import { useProgress } from "../../lib/progress";
import { Board, GLYPH, Highlight } from "../Board";
import { GameShell } from "../GameShell";

const NAMES: Record<string, string> = { R: "rook", B: "bishop", Q: "queen" };
const PREY: Record<string, string> = { q: "queen", r: "rook", b: "bishop", n: "knight" };

type MazeState = {
  position: string[];
  at: number;
  target: number;
  par: number;
};

function generate(piece: string): MazeState {
  for (let tries = 0; tries < 60; tries++) {
    const arr = emptyBoard();
    const at = 48 + Math.floor(Math.random() * 16); // start on ranks 1–2
    arr[at] = piece;
    for (const w of randSquares(9, [at], null)) arr[w] = "P";
    const dist = pathDistances(arr, at);
    const cand: number[] = [];
    for (let i = 0; i < 64; i++) if (i !== at && arr[i] === "" && dist[i] >= 3) cand.push(i);
    if (!cand.length) continue;
    const target = cand[Math.floor(Math.random() * cand.length)];
    const preyKeys = piece === "B" ? ["q", "r", "n"] : ["q", "b", "n"];
    arr[target] = preyKeys[Math.floor(Math.random() * preyKeys.length)];
    const d2 = pathDistances(arr, at);
    if (d2[target] < 2) continue; // prey blocked its own lane — regenerate
    return { position: arr, at, target, par: d2[target] };
  }
  // Fallback (extremely unlikely): open board, rook a1, prey h8.
  const arr = emptyBoard();
  arr[56] = piece;
  arr[7] = "q";
  return { position: arr, at: 56, target: 7, par: pathDistances(arr, 56)[7] };
}

export function RookMaze({ pieces = ["R"] }: { pieces?: string[] }) {
  const progress = useProgress();
  const { clearPending } = useLater();
  const [piece, setPiece] = useState(pieces[0]);
  const [maze, setMaze] = useState<MazeState>(() => generate(pieces[0]));
  const [at, setAt] = useState(maze.at);
  const [moves, setMoves] = useState(0);
  const [sel, setSel] = useState(false);
  const [done, setDone] = useState(false);
  const [highlights, setHighlights] = useState<Partial<Record<number, Highlight>>>({});
  const [pop, setPop] = useState<{ idx: number; n: number } | null>(null);
  const [popN, setPopN] = useState(0);
  const [shake, setShake] = useState(0);

  const promptFor = (m: MazeState) =>
    `The cheeky <strong>${PREY[m.position[m.target]]}</strong> hides behind the walls! Your own pawns block the road — go <strong>around</strong> and catch her. Can you do it in ${m.par} moves?`;

  const [status, setStatus] = useState(() => promptFor(maze));

  const gen = useCallback((p: string) => {
    const m = generate(p);
    setMaze(m);
    setAt(m.at);
    setMoves(0);
    setSel(false);
    setDone(false);
    setHighlights({});
    setStatus(promptFor(m));
  }, []);

  useEffect(() => () => clearPending(), [clearPending]);

  function finish(totalMoves: number) {
    setDone(true);
    const stars = STAR_RULES.rookMaze(totalMoves, maze.par);
    progress.setGameStars("rookMaze", stars);
    setStatus(
      `<strong>Caught!</strong> 🏁 ${totalMoves} moves${
        totalMoves <= maze.par ? " — the perfect path! " : ` (best possible was ${maze.par}). `
      }${"★".repeat(stars)}`,
    );
    sfx.fanfare();
  }

  function onTap(idx: number) {
    if (done) return;
    const pos = maze.position;
    if (idx === at) {
      setSel(true);
      const hl: Partial<Record<number, Highlight>> = { [idx]: "sel" };
      for (const t of pieceTargets(pos, idx)) hl[t] = pos[t] === "" ? "move" : "cap";
      setHighlights(hl);
      return;
    }
    if (sel && pieceTargets(pos, at).includes(idx)) {
      const caught = idx === maze.target;
      const next = applyMove(pos, at, idx);
      setMaze({ ...maze, position: next });
      setAt(idx);
      const nMoves = moves + 1;
      setMoves(nMoves);
      setSel(false);
      setHighlights({});
      setPop({ idx, n: popN + 1 });
      setPopN((v) => v + 1);
      if (caught) finish(nMoves);
      else sfx.move();
    } else if (sel) {
      setShake((s) => s + 1);
      sfx.bad();
      setStatus("The road is blocked there! Sliders can’t jump — find the <strong>open lane</strong>.");
    }
  }

  return (
    <GameShell
      title="Rook Maze"
      score={`👣 ${moves} moves · 🎯 best possible: ${maze.par}`}
      status={status}
      extra={
        pieces.length > 1 ? (
          <div className="flex flex-wrap justify-center gap-2">
            {pieces.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => {
                  setPiece(p);
                  gen(p);
                }}
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
        <button type="button" className="btn btn-ghost" onClick={() => gen(piece)}>
          New maze
        </button>
      }
    >
      <Board
        position={maze.position}
        labels
        highlights={highlights}
        popToken={pop}
        shakeToken={shake}
        onTap={onTap}
      />
    </GameShell>
  );
}
