"use client";

import { useCallback, useEffect, useRef, useState } from "react";

function fmt(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Two-sided match clock (chess style). Tap a side to hand the turn to the
 * other player; when one side reaches zero the other is declared the winner.
 */
export function MatchClock({
  p1,
  p2,
  minutes,
  onWinner,
  onClose,
}: {
  p1: string;
  p2: string;
  minutes: number;
  onWinner: (side: 1 | 2) => void;
  onClose: () => void;
}) {
  const startMs = minutes * 60_000;
  const [t1, setT1] = useState(startMs);
  const [t2, setT2] = useState(startMs);
  const [active, setActive] = useState<1 | 2 | null>(null);
  const [flagged, setFlagged] = useState<1 | 2 | null>(null);
  const last = useRef<number>(0);

  useEffect(() => {
    if (active === null || flagged) return;
    last.current = Date.now();
    const id = setInterval(() => {
      const now = Date.now();
      const delta = now - last.current;
      last.current = now;
      if (active === 1) {
        setT1((v) => {
          const nv = v - delta;
          if (nv <= 0) {
            setFlagged(1);
            setActive(null);
            return 0;
          }
          return nv;
        });
      } else {
        setT2((v) => {
          const nv = v - delta;
          if (nv <= 0) {
            setFlagged(2);
            setActive(null);
            return 0;
          }
          return nv;
        });
      }
    }, 100);
    return () => clearInterval(id);
  }, [active, flagged]);

  const tap = useCallback(
    (side: 1 | 2) => {
      if (flagged) return;
      // tapping your own side hands the turn to the opponent
      setActive(side === 1 ? 2 : 1);
    },
    [flagged],
  );

  const reset = () => {
    setT1(startMs);
    setT2(startMs);
    setActive(null);
    setFlagged(null);
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-purple-950/95 p-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm text-purple-300">
          {minutes} min each · tap your side after your move
        </span>
        <button
          onClick={onClose}
          className="rounded-lg border border-purple-400/40 px-3 py-1.5 text-sm text-purple-200 hover:bg-purple-900"
        >
          Close
        </button>
      </div>

      <div className="grid flex-1 grid-rows-2 gap-3">
        <ClockSide
          name={p1}
          time={t1}
          active={active === 1}
          flagged={flagged === 1}
          onTap={() => tap(1)}
          flip
        />
        <ClockSide
          name={p2}
          time={t2}
          active={active === 2}
          flagged={flagged === 2}
          onTap={() => tap(2)}
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
        <button
          onClick={reset}
          className="rounded-lg border border-purple-400/40 px-4 py-2 text-sm text-purple-200 hover:bg-purple-900"
        >
          ⟲ Reset clock
        </button>
        {active && (
          <button
            onClick={() => setActive(null)}
            className="rounded-lg border border-purple-400/40 px-4 py-2 text-sm text-purple-200 hover:bg-purple-900"
          >
            ⏸ Pause
          </button>
        )}
        <button
          onClick={() => onWinner(1)}
          className="rounded-lg bg-purple-500 px-4 py-2 text-sm font-semibold text-white hover:bg-purple-400"
        >
          {p1} wins
        </button>
        <button
          onClick={() => onWinner(2)}
          className="rounded-lg bg-purple-500 px-4 py-2 text-sm font-semibold text-white hover:bg-purple-400"
        >
          {p2} wins
        </button>
      </div>

      {flagged && (
        <div className="mt-3 rounded-xl border border-amber-400/40 bg-amber-400/10 p-3 text-center text-amber-200">
          ⏱ {flagged === 1 ? p1 : p2} ran out of time.{" "}
          <button
            onClick={() => onWinner(flagged === 1 ? 2 : 1)}
            className="ml-2 rounded-lg bg-purple-500 px-3 py-1.5 text-sm font-semibold text-white hover:bg-purple-400"
          >
            Declare {flagged === 1 ? p2 : p1} the winner
          </button>
        </div>
      )}
    </div>
  );
}

function ClockSide({
  name,
  time,
  active,
  flagged,
  onTap,
  flip,
}: {
  name: string;
  time: number;
  active: boolean;
  flagged: boolean;
  onTap: () => void;
  flip?: boolean;
}) {
  return (
    <button
      onClick={onTap}
      className={`flex flex-col items-center justify-center rounded-2xl border-2 transition ${
        flagged
          ? "border-red-500 bg-red-500/15"
          : active
            ? "border-fuchsia-400 bg-fuchsia-500/20"
            : "border-purple-400/30 bg-purple-900/50"
      } ${flip ? "rotate-180" : ""}`}
    >
      <span className="text-lg font-medium text-purple-200">{name}</span>
      <span
        className={`font-mono text-6xl font-bold tabular-nums ${
          flagged ? "text-red-300" : active ? "text-fuchsia-100" : "text-white"
        }`}
      >
        {fmt(time)}
      </span>
      <span className="mt-1 text-xs text-purple-300">
        {flagged ? "flag fall" : active ? "running — tap to pass" : "tap to start opponent"}
      </span>
    </button>
  );
}
