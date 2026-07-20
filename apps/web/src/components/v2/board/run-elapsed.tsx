"use client";
// A quiet elapsed-time line for a running AI architect call.
//
// Architect runs are long by nature — measured 2026-07-20 on sonnet-5 at
// effort:medium, a 25-fixture pack took 84s and a 30-fixture pack 213s. Without
// a ticking number a three-minute wait is indistinguishable from a hang, and
// organisers retry a run that was going to succeed (burning quota and tokens).
//
// It counts UP, not down. A countdown against ROUND_TIMEOUT_MS would grow more
// alarming the longer a perfectly healthy run took, and most runs finish with
// most of the budget unspent — the deadline is our implementation detail, not
// something the organiser can act on.
import { useEffect, useState } from "react";
import { useMsg } from "@/components/i18n/dict-provider";

/** Whole seconds since this component mounted.
 *
 *  There is deliberately no `active` argument: the caller mounts the timer when
 *  a run starts and unmounts it when the run ends, so React's own lifecycle
 *  does the resetting. Threading `active` through instead forces a choice
 *  between resetting during render (impure — reads the clock) and resetting in
 *  an effect (renders a stale clock for one frame); mounting sidesteps both. */
export function useElapsedSeconds(): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    // Wall-clock delta rather than a tick count: intervals are throttled in a
    // background tab, so counting ticks would under-report a long wait.
    const startedAt = Date.now();
    const id = setInterval(() => setSeconds(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  return seconds;
}

/** m:ss — no hours: a run that reaches 60 minutes has long since hit the
 *  round timeout and surfaced as AI_PLAN_TIMEOUT. */
export function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Mount this only while a run is in flight — see useElapsedSeconds. */
export function RunElapsed(): React.ReactElement {
  const msg = useMsg();
  const seconds = useElapsedSeconds();
  return (
    // aria-live is off deliberately: the run button already announces
    // "Planning…", and a per-second live region would talk over everything
    // else on the page. role="timer" still exposes it on demand.
    <p
      role="timer"
      aria-live="off"
      className="mt-2 text-center text-xs tabular-nums text-slate-500 dark:text-slate-400"
    >
      {msg("board.ai.elapsed", { elapsed: formatElapsed(seconds) })}
    </p>
  );
}
