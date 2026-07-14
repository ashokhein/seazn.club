"use client";

// Square Race — 60 seconds, tap the called-out square. Port of js/games.js
// squareRace (lines 136–195): scoring flash, 5-streak celebration hook point,
// best-score record, star thresholds from STAR_RULES.
import { useEffect, useRef, useState } from "react";
import { sqName } from "../../engine";
import { emptyBoard } from "../../lib/rand";
import { sfx } from "../../lib/sfx";
import { STAR_RULES } from "../../lib/stars";
import { useLater } from "../../lib/use-later";
import { useProgress } from "../../lib/progress";
import { Board, Highlight } from "../Board";
import { GameShell } from "../GameShell";

const EMPTY = emptyBoard();

export function SquareRace() {
  const progress = useProgress();
  const { later, clearPending } = useLater();
  const [running, setRunning] = useState(false);
  const [score, setScore] = useState(0);
  const [time, setTime] = useState(60);
  const [target, setTarget] = useState(-1);
  const [status, setStatus] = useState(
    "Tap the square I call out. The little letters and numbers help!",
  );
  const [highlights, setHighlights] = useState<Partial<Record<number, Highlight>>>({});
  const [shake, setShake] = useState(0);
  const scoreRef = useRef(0);

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      setTime((t) => t - 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [running]);

  useEffect(() => {
    if (running && time <= 0) {
      setRunning(false);
      setHighlights({});
      const s = scoreRef.current;
      const stars = STAR_RULES.squareRace(s);
      const record = progress.setBest("squareRace", s);
      if (stars) progress.setGameStars("squareRace", stars);
      setStatus(
        `Time! You found <strong>${s}</strong> squares ${"★".repeat(stars)}${
          record ? " — new record!" : ""
        }<br><small>Best so far: ${progress.getBest("squareRace")}</small>`,
      );
    }
    // progress is intentionally omitted: reading it here must not rearm the effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [time, running]);

  function newTarget() {
    const t = Math.floor(Math.random() * 64);
    setTarget(t);
    setStatus(`Find <strong class="text-lg">${sqName(t)}</strong> !`);
  }

  function start() {
    scoreRef.current = 0;
    setScore(0);
    setTime(60);
    setRunning(true);
    newTarget();
  }

  function onTap(idx: number) {
    if (!running) return;
    if (idx === target) {
      scoreRef.current += 1;
      setScore(scoreRef.current);
      sfx.good();
      setHighlights({ [idx]: "hint" });
      later(() => setHighlights({}), 250);
      newTarget();
    } else {
      setShake((s) => s + 1);
      sfx.bad();
    }
  }

  return (
    <GameShell
      title="Square Race"
      score={
        <span>
          ⭐ {score} &nbsp; <span className="tabular-nums">⏱ {time}s</span>
        </span>
      }
      status={status}
      controls={
        !running ? (
          <button type="button" className="btn btn-primary" onClick={() => { clearPending(); start(); }}>
            {score > 0 || time <= 0 ? "Play again" : "Start! (60 seconds)"}
          </button>
        ) : null
      }
    >
      <Board position={EMPTY} labels highlights={highlights} shakeToken={shake} onTap={onTap} />
    </GameShell>
  );
}
