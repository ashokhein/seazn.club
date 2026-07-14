"use client";

// Opening Trainer — play a named opening move by move. The trainer auto-plays
// the book replies; you play your side's moves until the line is complete.
// Repetition builds the opening into muscle memory ("play it fifty times").
import { useCallback, useEffect, useState } from "react";
import { applyMove, isWhitePiece, legalTargets, parseFEN, sqIdx } from "../../engine";
import { OPENINGS } from "../../content/openings";
import { celebrate } from "../../lib/celebrate";
import { sfx } from "../../lib/sfx";
import { STAR_RULES } from "../../lib/stars";
import { useLater } from "../../lib/use-later";
import { useProgress } from "../../lib/progress";
import { voice } from "../../lib/voice";
import { Board, Highlight } from "../Board";
import { GameShell } from "../GameShell";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export function OpeningTrainer({ opening }: { opening: string }) {
  const op = OPENINGS[opening] ?? OPENINGS.italian;
  const progress = useProgress();
  const { later, clearPending } = useLater();

  const learnerPly = useCallback(
    (i: number) => (i % 2 === 0) === (op.learnerSide === "white"),
    [op.learnerSide],
  );

  const promptFor = useCallback(
    (i: number) => {
      if (i >= op.line.length) return `<strong>${op.name}</strong> — line complete!`;
      return learnerPly(i)
        ? `Your move: play <strong>${op.line[i].san}</strong>. Tap the glowing piece, then its square.`
        : `<strong>${op.name}</strong> — watch the reply…`;
    },
    [op, learnerPly],
  );

  const [position, setPosition] = useState<string[]>(() => parseFEN(START).board);
  const [ply, setPly] = useState(0);
  const [selIdx, setSelIdx] = useState(-1);
  const [mistakes, setMistakes] = useState(0);
  const [done, setDone] = useState(false);
  const [highlights, setHighlights] = useState<Partial<Record<number, Highlight>>>({});
  const [pop, setPop] = useState<{ idx: number; n: number } | null>(null);
  const [popN, setPopN] = useState(0);
  const [shake, setShake] = useState(0);
  const [status, setStatus] = useState(() => promptFor(0));

  const learnerMovesTotal = op.line.filter((_, i) => learnerPly(i)).length;

  // "Play again" / "Restart" — each launch is a fresh mount, so this only runs
  // from the button.
  const reset = useCallback(() => {
    clearPending();
    setPosition(parseFEN(START).board);
    setPly(0);
    setSelIdx(-1);
    setMistakes(0);
    setDone(false);
    setHighlights({});
    setStatus(promptFor(0));
  }, [clearPending, promptFor]);

  useEffect(() => () => clearPending(), [clearPending]);

  const finish = useCallback(() => {
    setDone(true);
    setHighlights({});
    const stars = STAR_RULES.openingTrainer(mistakes);
    progress.setGameStars("openingTrainer", stars);
    setStatus(`<strong>${op.name}</strong> — you played the whole line! ${"★".repeat(stars)}`);
    voice.say(`${op.name}. You played the whole line!`);
    celebrate();
  }, [mistakes, op.name, progress]);

  // Drive the sequence off `ply`: finish the line, auto-play opponent replies,
  // or glow the learner's from-square. Completion runs here (not in
  // onLearnerMove) so lines that end on an opponent move also finish.
  useEffect(() => {
    if (done) return;
    if (ply >= op.line.length) {
      finish();
      return;
    }
    if (!learnerPly(ply)) {
      later(() => {
        const mv = op.line[ply];
        setPosition((pos) => applyMove(pos, sqIdx(mv.from), sqIdx(mv.to)));
        setPop({ idx: sqIdx(mv.to), n: popN + 1 });
        setPopN((v) => v + 1);
        sfx.move();
        setPly((p) => p + 1);
      }, 550);
    } else {
      setHighlights({ [sqIdx(op.line[ply].from)]: "hint" });
      setStatus(promptFor(ply));
    }
    // ply drives the sequence; the setters/refs are stable
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ply, done]);

  function onLearnerMove(from: number, to: number) {
    const mv = op.line[ply];
    if (from === sqIdx(mv.from) && to === sqIdx(mv.to)) {
      setPosition(applyMove(position, from, to));
      setPop({ idx: to, n: popN + 1 });
      setPopN((v) => v + 1);
      sfx.move();
      setSelIdx(-1);
      // Completion is handled by the ply-driven effect (covers opponent-ending
      // lines too), so just advance.
      setPly(ply + 1);
    } else {
      setSelIdx(-1);
      setMistakes((x) => x + 1);
      setShake((s) => s + 1);
      sfx.bad();
      setStatus(
        `Not the book move — the ${op.name} plays <strong>${mv.san}</strong> here. Follow the glowing piece.`,
      );
      setHighlights({ [sqIdx(mv.from)]: "hint" });
    }
  }

  function onTap(idx: number) {
    if (done || ply >= op.line.length || !learnerPly(ply)) return;
    const pos = position;
    const p = pos[idx];
    const mine = p !== "" && isWhitePiece(p) === (op.learnerSide === "white");
    if (mine) {
      setSelIdx(idx);
      const hl: Partial<Record<number, Highlight>> = { [idx]: "sel" };
      for (const t of legalTargets(pos, idx)) hl[t] = pos[t] === "" ? "move" : "cap";
      hl[sqIdx(op.line[ply].from)] = "hint";
      setHighlights(hl);
      return;
    }
    if (selIdx >= 0 && legalTargets(pos, selIdx).includes(idx)) {
      onLearnerMove(selIdx, idx);
    } else if (selIdx >= 0) {
      setShake((s) => s + 1);
    }
  }

  const doneLearnerMoves = op.line.slice(0, ply).filter((_, i) => learnerPly(i)).length;

  return (
    <GameShell
      title={`Opening Trainer — ${op.name}`}
      score={`move ${doneLearnerMoves}/${learnerMovesTotal}`}
      status={status}
      extra={<p className="text-center text-xs italic text-slate-500">{op.idea}</p>}
      controls={
        <button type="button" className="btn btn-ghost" onClick={reset}>
          {done ? "Play again" : "Restart"}
        </button>
      }
    >
      <Board
        position={position}
        labels
        highlights={highlights}
        popToken={pop}
        shakeToken={shake}
        onTap={onTap}
      />
    </GameShell>
  );
}
