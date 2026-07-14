"use client";

// Mate in 1 — solve the pack, any legal mating move accepted. Port of
// js/games.js mateInOne (431–538); completion copy uses MATE1.length (the
// original hardcoded "12" but the pack has 18).
import { useCallback, useEffect, useState } from "react";
import { applyMove, isMate, isWhitePiece, legalTargets, parseFEN, sqIdx } from "../../engine";
import { MATE1 } from "../../content/puzzles";
import { celebrate } from "../../lib/celebrate";
import { sfx } from "../../lib/sfx";
import { STAR_RULES } from "../../lib/stars";
import { useLater } from "../../lib/use-later";
import { voice } from "../../lib/voice";
import { useProgress } from "../../lib/progress";
import { Board, Highlight } from "../Board";
import { GameShell } from "../GameShell";
import { PuzzleDots } from "./PuzzleDots";
import { Chip, runMateMiss } from "./mate-miss-coach";

function firstUnsolved(isSolved: (i: number) => boolean) {
  for (let i = 0; i < MATE1.length; i++) if (!isSolved(i)) return i;
  return 0;
}

export function MateInOne() {
  const progress = useProgress();
  const { later, clearPending } = useLater();
  const [cur, setCur] = useState(() => firstUnsolved(progress.isSolved));
  const [position, setPosition] = useState<string[]>(() => parseFEN(MATE1[cur].fen).board);
  const [selIdx, setSelIdx] = useState(-1);
  const [tries, setTries] = useState(0);
  const [busy, setBusy] = useState(false);
  const [highlights, setHighlights] = useState<Partial<Record<number, Highlight>>>({});
  const [pop, setPop] = useState<{ idx: number; n: number } | null>(null);
  const [popN, setPopN] = useState(0);
  const [shake, setShake] = useState(0);
  const [chips, setChips] = useState<Chip[]>([]);
  const [coachTap, setCoachTap] = useState<((idx: number) => void) | null>(null);
  const [status, setStatus] = useState(
    () => `<strong>${MATE1[cur].name}</strong> — white moves and checkmates in one!`,
  );

  const load = useCallback(
    (i: number) => {
      clearPending();
      setCur(i);
      setPosition(parseFEN(MATE1[i].fen).board);
      setHighlights({});
      setSelIdx(-1);
      setTries(0);
      setBusy(false);
      setChips([]);
      setCoachTap(null);
      setStatus(`<strong>${MATE1[i].name}</strong> — white moves and checkmates in one!`);
    },
    [clearPending],
  );

  useEffect(() => () => clearPending(), [clearPending]);

  function solved(i: number) {
    progress.setSolved(i);
    const n = progress.solvedCount();
    progress.setGameStars("mateInOne", STAR_RULES.packStars(n));
    setStatus("<strong>Checkmate!</strong> 🎉 The king has nowhere to run.");
    voice.say("Checkmate! The king has nowhere to run!");
    celebrate();
    setBusy(true);
    later(() => {
      if (n < MATE1.length) load(firstUnsolved(progress.isSolved));
      else
        setStatus(
          `<strong>Pack complete!</strong> All ${MATE1.length} checkmates found. ★★★`,
        );
    }, 1400);
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
    if (selIdx >= 0 && legalTargets(pos, selIdx).includes(idx)) {
      const next = applyMove(pos, selIdx, idx);
      setSelIdx(-1);
      if (isMate(next, false)) {
        setPosition(next);
        setHighlights({});
        setPop({ idx, n: popN + 1 });
        setPopN((v) => v + 1);
        solved(cur);
      } else {
        const t = tries + 1;
        setTries(t);
        setPosition(next);
        setHighlights({});
        setBusy(true);
        runMateMiss({
          next,
          resetBoard: parseFEN(MATE1[cur].fen).board,
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
    } else if (selIdx >= 0) {
      setShake((s) => s + 1);
    }
  }

  function hint() {
    const from = sqIdx(MATE1[cur].solution.slice(0, 2));
    setHighlights({ [from]: "hint" });
    setStatus(`<strong>${MATE1[cur].name}</strong> — ${MATE1[cur].hint}`);
  }

  return (
    <GameShell
      title="Mate in 1"
      score={`🧩 ${progress.solvedCount()} / ${MATE1.length} solved`}
      status={status}
      chips={chips}
      extra={
        <PuzzleDots
          count={MATE1.length}
          current={cur}
          isSolved={progress.isSolved}
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
              progress.resetPuzzles();
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
