"use client";

// Mate in 2 — two phases. Port of js/games.js mateInTwo (540–706): phase 1
// accepts any move that forces mate in two (or an immediate mate), plays
// black's toughest defense, then phase 2 asks for the finishing mate-in-1.
import { useCallback, useEffect, useState } from "react";
import {
  allLegalMoves,
  applyMove,
  bestDefense,
  hasMateIn1,
  inCheck,
  isMate,
  isMateIn2After,
  isWhitePiece,
  legalTargets,
  parseFEN,
  sqIdx,
  sqName,
} from "../../engine";
import { MATE2 } from "../../content/puzzles";
import { sfx } from "../../lib/sfx";
import { STAR_RULES } from "../../lib/stars";
import { useLater } from "../../lib/use-later";
import { useProgress } from "../../lib/progress";
import { Board, Highlight } from "../Board";
import { GameShell } from "../GameShell";
import { PuzzleDots } from "./PuzzleDots";
import { Chip, runMateMiss } from "./mate-miss-coach";

function firstUnsolved(isSolved2: (i: number) => boolean) {
  for (let i = 0; i < MATE2.length; i++) if (!isSolved2(i)) return i;
  return 0;
}

export function MateInTwo() {
  const progress = useProgress();
  const { later, clearPending } = useLater();
  const [cur, setCur] = useState(() => firstUnsolved(progress.isSolved2));
  const [position, setPosition] = useState<string[]>(() => parseFEN(MATE2[cur].fen).board);
  const [selIdx, setSelIdx] = useState(-1);
  const [tries, setTries] = useState(0);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<1 | 2>(1);
  const [midBoard, setMidBoard] = useState<string[] | null>(null);
  const [highlights, setHighlights] = useState<Partial<Record<number, Highlight>>>({});
  const [pop, setPop] = useState<{ idx: number; n: number } | null>(null);
  const [popN, setPopN] = useState(0);
  const [shake, setShake] = useState(0);
  const [chips, setChips] = useState<Chip[]>([]);
  const [coachTap, setCoachTap] = useState<((idx: number) => void) | null>(null);
  const [status, setStatus] = useState(
    () =>
      `<strong>${MATE2[cur].name}</strong> — white forces checkmate in <strong>two</strong> moves. Find move one!`,
  );

  const load = useCallback(
    (i: number) => {
      clearPending();
      setCur(i);
      setPosition(parseFEN(MATE2[i].fen).board);
      setHighlights({});
      setSelIdx(-1);
      setTries(0);
      setBusy(false);
      setPhase(1);
      setMidBoard(null);
      setChips([]);
      setCoachTap(null);
      setStatus(
        `<strong>${MATE2[i].name}</strong> — white forces checkmate in <strong>two</strong> moves. Find move one!`,
      );
    },
    [clearPending],
  );

  useEffect(() => () => clearPending(), [clearPending]);

  function popAt(idx: number) {
    setPop({ idx, n: popN + 1 });
    setPopN((v) => v + 1);
  }

  function solved(i: number, msg: string) {
    progress.setSolved2(i);
    const n = progress.solved2Count();
    progress.setGameStars("mateInTwo", STAR_RULES.packStars(n));
    setStatus(msg);
    sfx.fanfare();
    setBusy(true);
    later(() => {
      if (n < MATE2.length) load(firstUnsolved(progress.isSolved2));
      else
        setStatus(
          "<strong>Pack complete!</strong> Twelve forced mates — real chess player thinking. ★★★",
        );
    }, 1600);
  }

  // Black plays its toughest defense, then hands the mate-in-1 back.
  function blackReplies(afterWhite: string[]) {
    setBusy(true);
    later(() => {
      const d = bestDefense(afterWhite);
      if (!d) {
        solved(cur, "<strong>Checkmate!</strong> 🎉");
        return;
      }
      const afterBlack = applyMove(afterWhite, d.from, d.to);
      setPosition(afterBlack);
      popAt(d.to);
      sfx.move();
      setMidBoard(afterBlack);
      setPhase(2);
      setBusy(false);
      setStatus(
        `Locked in! Black tries <strong>${sqName(d.from)}–${sqName(d.to)}</strong>… now finish it. <strong>Mate in one!</strong>`,
      );
    }, 750);
  }

  function onTap(idx: number) {
    if (coachTap) {
      coachTap(idx);
      return;
    }
    if (busy) return;
    const pos = position;
    const p = pos[idx];
    if (p !== "" && isWhitePiece(p)) {
      setSelIdx(idx);
      const hl: Partial<Record<number, Highlight>> = { [idx]: "sel" };
      for (const t of legalTargets(pos, idx)) hl[t] = pos[t] === "" ? "move" : "cap";
      setHighlights(hl);
      return;
    }
    if (selIdx < 0 || !legalTargets(pos, selIdx).includes(idx)) {
      if (selIdx >= 0) setShake((s) => s + 1);
      return;
    }

    const next = applyMove(pos, selIdx, idx);
    const from = selIdx;
    setSelIdx(-1);

    if (phase === 1) {
      if (isMate(next, false)) {
        setPosition(next);
        setHighlights({});
        popAt(idx);
        solved(cur, "<strong>Checkmate — even faster than asked!</strong> 🎉");
      } else if (isMateIn2After(pos, from, idx)) {
        setPosition(next);
        setHighlights({});
        popAt(idx);
        sfx.good();
        setStatus("That's the squeeze — black has no good answer…");
        blackReplies(next);
      } else {
        const t = tries + 1;
        setTries(t);
        setPosition(next);
        setHighlights({});
        setBusy(true);
        sfx.bad();
        const replies = allLegalMoves(next, false);
        let saveMove: { from: number; to: number } | null = null;
        for (const r of replies) {
          if (!hasMateIn1(applyMove(next, r.from, r.to), true)) {
            saveMove = r;
            break;
          }
        }
        const nudge = t >= 2 ? " (The Hint button is your friend!)" : "";
        const escapeTxt = saveMove
          ? `black plays <strong>${sqName(saveMove.from)}–${sqName(saveMove.to)}</strong> and there is no mate`
          : "black slips away";
        later(() => {
          setPosition(parseFEN(MATE2[cur].fen).board);
          setShake((s) => s + 1);
          setBusy(false);
          setStatus(
            (inCheck(next, false)
              ? `It's check — but ${escapeTxt}. Find the move that leaves <strong>no way out</strong>.`
              : `Black gets a free turn: ${escapeTxt}. Move one must be a check or an unstoppable threat!`) +
              nudge,
          );
        }, 900);
      }
    } else {
      // phase 2: must be mate in one
      if (isMate(next, false)) {
        setPosition(next);
        setHighlights({});
        popAt(idx);
        solved(cur, "<strong>Checkmate!</strong> 🎉 A forced mate in two — beautifully done.");
      } else {
        const t = tries + 1;
        setTries(t);
        setPosition(next);
        setHighlights({});
        setBusy(true);
        runMateMiss({
          next,
          resetBoard: midBoard ?? parseFEN(MATE2[cur].fen).board,
          extraNudge: t >= 2 ? " (The Hint button is your friend!)" : "",
          setStatus,
          setChips,
          setCoachTap: (fn) => setCoachTap(() => fn),
          setPosition,
          setHighlights,
          bumpShake: () => setShake((s) => s + 1),
          later,
          unlock: () => setBusy(false),
          bad: sfx.bad,
          good: sfx.good,
        });
      }
    }
  }

  function hint() {
    if (phase === 1) {
      setHighlights({ [sqIdx(MATE2[cur].solution.slice(0, 2))]: "hint" });
      setStatus(`<strong>${MATE2[cur].name}</strong> — ${MATE2[cur].hint}`);
    } else if (midBoard) {
      for (const m of allLegalMoves(midBoard, true)) {
        if (isMate(applyMove(midBoard, m.from, m.to), false)) {
          setHighlights({ [m.from]: "hint" });
          break;
        }
      }
    }
  }

  return (
    <GameShell
      title="Mate in 2"
      score={`🧩 ${progress.solved2Count()} / ${MATE2.length} solved`}
      status={status}
      chips={chips}
      extra={
        <PuzzleDots
          count={MATE2.length}
          current={cur}
          isSolved={progress.isSolved2}
          onPick={load}
        />
      }
      controls={
        <>
          <button type="button" className="btn btn-ghost" onClick={hint}>
            Hint
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              progress.resetPuzzles2();
              load(0);
            }}
          >
            Start pack over
          </button>
        </>
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
