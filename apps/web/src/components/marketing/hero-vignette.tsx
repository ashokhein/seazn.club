"use client";

import { useEffect, useState } from "react";

/** Object-relay hero animation (design/v3/12 §4.2). No humans — ball is the
 *  protagonist. Plays three times on load, then rests (manual replay stays).
 *  Fixed-height container so CLS stays 0; under prefers-reduced-motion the
 *  CSS shows the end state (ball on scorebug). */
const AUTO_PLAYS = 3;

export function HeroVignette() {
  const [run, setRun] = useState(0);

  useEffect(() => {
    if (run >= AUTO_PLAYS - 1) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = setTimeout(() => setRun((n) => n + 1), 3300);
    return () => clearTimeout(t);
  }, [run]);

  return (
    <div className="relative h-64 w-full max-w-md sm:h-72">
      <div key={run} data-testid="vignette-run" className="mk-vignette absolute inset-0">
        <svg
          viewBox="0 0 420 280"
          className="h-full w-full"
          role="img"
          aria-label="A cricket bat strikes a ball that lands as a live score"
        >
          {/* pitch line */}
          <line
            x1="24"
            y1="236"
            x2="396"
            y2="236"
            stroke="var(--mk-lime)"
            strokeWidth="3"
            strokeLinecap="round"
            opacity="0.55"
          />
          {/* bat: grip at the bottom pivot, blade up — contact lands mid-blade */}
          <g className="mk-bat">
            <rect x="297" y="100" width="26" height="96" rx="12" fill="#d9b98a" stroke="#1e1b2e" strokeWidth="3" />
            <rect x="304" y="192" width="12" height="40" rx="6" fill="#8a6a3f" stroke="#1e1b2e" strokeWidth="3" />
          </g>
          {/* impact star — pops at the blade's sweet spot */}
          <g className="mk-star">
            <path
              d="M282 152 l10 -22 6 20 20 -8 -14 18 22 6 -24 6 10 20 -20 -12 -6 22 -8 -22z"
              fill="var(--mk-orange)"
              stroke="#1e1b2e"
              strokeWidth="3"
              strokeLinejoin="round"
            />
          </g>
          {/* the ball: toss → hang → struck left → lands on scorebug */}
          <g className="mk-ball">
            <circle r="13" fill="#f43f5e" stroke="#1e1b2e" strokeWidth="3" />
            <path d="M -9 -6 q 9 6 18 0" fill="none" stroke="#1e1b2e" strokeWidth="2" />
          </g>
        </svg>
        {/* scorebug chip: the product end-state */}
        <div
          data-testid="scorebug"
          className="absolute bottom-2 left-2 flex items-center gap-2 rounded-lg border border-[#3b2a6e] bg-[#1a0f3e] px-3 py-2"
        >
          <span className="mk-live-dot h-2.5 w-2.5 rounded-full bg-[var(--mk-live)]" />
          <span className="mk-display text-xs font-semibold tracking-widest text-[var(--mk-lime)]">
            LIVE
          </span>
          <span className="mk-display whitespace-nowrap text-sm font-bold tabular-nums text-[var(--mk-cream)]">
            Falcons 21 · Comets 18
          </span>
        </div>
      </div>
      <button
        type="button"
        aria-label="Replay animation"
        onClick={() => setRun((n) => n + 1)}
        className="absolute right-1 top-1 rounded-md border border-[#3b2a6e] px-2 py-1 text-[10px] text-[#8d7fc0] hover:text-[var(--mk-cream)]"
      >
        ↺ replay
      </button>
    </div>
  );
}
