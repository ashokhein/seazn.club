"use client";

// The referee trace (v4 Task 13, design/v4/02 §0) — the surface's signature.
// The binding decision of the two-phase architect is "the LLM plans, the engine
// referees", and building the prototype found that the single most convincing
// thing on screen is watching a draft get *caught and corrected*. So the verify
// / repair loop is promoted from a spinner to a first-class, always-shown trace:
// a stepper (Draft · Plan · Referee · [Repair] · Ready) whose nodes light in
// sequence and whose Referee node flips red on a flag before the whole spine
// settles teal, above a dark mono console streaming the machine events. Shared:
// Task 14 mounts it again with phase="officials".
//
// The component is a pure renderer of a linear TraceEvent[] script the console
// composes from the engine's verified plan (there is no server trace field). It
// owns only the reveal animation and the state-palette tones; it derives node
// identity by position, never by label, so the console keeps ownership of the
// localized copy. prefers-reduced-motion dumps the whole trace instantly.
import { useEffect, useRef, useState } from "react";
import { useMsg } from "@/components/i18n/dict-provider";
import type { MessageKey } from "@/lib/messages";

export type TraceEventKind = "step" | "log" | "flag" | "clean";
/** One line of the machine trace. `step` events form the stepper spine (their
 *  text is the node label); the rest stream into the console below it. */
export interface TraceEvent {
  t: TraceEventKind;
  text: string;
}

const REVEAL_MS = 380;

/** SSR-safe prefers-reduced-motion read that stays live if the user flips it. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return reduced;
}

export function AiTrace({
  phase,
  events,
  running,
  onFlag,
}: {
  phase: "schedule" | "officials";
  events: TraceEvent[];
  /** The network run is still in flight — hold the live cursor past the reveal. */
  running: boolean;
  /** Fired once as each flag event is revealed, so the console can pulse the
   *  caught fixtures on the grid (design §0.3). Skipped under reduced motion. */
  onFlag?: () => void;
}) {
  const msg = useMsg();
  const reduced = usePrefersReducedMotion();
  const [revealed, setRevealed] = useState(0);
  const firedFlags = useRef(0);
  const logRef = useRef<HTMLOListElement>(null);

  const total = events.length;
  // Reduced motion lands on the final state directly (derived, no setState in an
  // effect); otherwise the reveal cursor drives what is shown.
  const shown = reduced ? total : Math.min(revealed, total);

  // Reveal the script one event at a time; a single interval advances the cursor
  // and clears itself at the end — it restarts when `events` grows (running →
  // settled). Reduced motion skips it entirely.
  useEffect(() => {
    if (reduced || revealed >= total) return;
    const id = setInterval(() => {
      setRevealed((r) => (r >= total ? r : r + 1));
    }, REVEAL_MS);
    return () => clearInterval(id);
  }, [total, reduced, revealed]);

  // Fire onFlag as each flag event crosses the reveal boundary (once each).
  // Reduced motion never advances `revealed`, so the grid pulse is skipped too.
  useEffect(() => {
    for (let i = firedFlags.current; i < revealed && i < total; i++) {
      if (events[i]?.t === "flag") onFlag?.();
    }
    if (revealed > firedFlags.current) firedFlags.current = revealed;
  }, [revealed, total, events, onFlag]);

  // Keep the newest console line in view as the trace streams.
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [shown]);

  const animating = shown < total;
  const isLive = animating || running;

  // Derive the stepper spine + per-node tone from the revealed prefix. Node
  // identity is positional: a flag reddens whichever node was active when it
  // fired (the Referee, by the console's construction) until a clean settles all.
  const nodes: { label: string; idx: number }[] = [];
  events.forEach((e, idx) => {
    if (e.t === "step") nodes.push({ label: e.text, idx });
  });
  let verified = false;
  let activeIdx = -1;
  const flaggedNodeIdxs = new Set<number>();
  let lastStepIdx = -1;
  for (let i = 0; i < shown; i++) {
    const e = events[i]!;
    if (e.t === "step") {
      lastStepIdx = i;
      activeIdx = i;
    } else if (e.t === "flag") {
      if (lastStepIdx >= 0) flaggedNodeIdxs.add(lastStepIdx);
    } else if (e.t === "clean") {
      verified = true;
      flaggedNodeIdxs.clear();
    }
  }

  type NodeTone = "pending" | "active" | "done" | "flagged" | "verified";
  const nodeTone = (nodeIdx: number): NodeTone => {
    const lit = nodeIdx < shown;
    if (!lit) return "pending";
    if (verified) return "verified";
    if (flaggedNodeIdxs.has(nodeIdx)) return "flagged";
    if (nodeIdx === activeIdx) return "active";
    return "done";
  };

  const dotClass: Record<NodeTone, string> = {
    pending: "bg-white text-slate-300 ring-slate-200",
    active: "bg-violet-600 text-white ring-violet-600",
    done: "bg-violet-500 text-white ring-violet-500",
    flagged: "bg-red-500 text-white ring-red-500",
    verified: "bg-teal-500 text-white ring-teal-500",
  };
  const labelClass: Record<NodeTone, string> = {
    pending: "text-slate-300",
    active: "text-violet-700",
    done: "text-violet-600",
    flagged: "text-red-600",
    verified: "text-teal-600",
  };
  const connectorLit = (afterIdx: number) => afterIdx < shown;

  const lineTone: Record<Exclude<TraceEventKind, "step">, string> = {
    log: "text-slate-300",
    flag: "text-red-300",
    clean: "text-teal-300",
  };
  const consoleLines = events
    .map((e, i) => ({ e, i }))
    .filter(({ e, i }) => e.t !== "step" && i < shown);

  return (
    <section
      aria-label={msg(`board.ai.trace.aria.${phase}` as MessageKey)}
      className="overflow-hidden rounded-lg border border-slate-200 bg-white"
    >
      {/* Stepper spine — full pipeline shown, nodes light in sequence. */}
      <ol className="flex items-start gap-0 px-3 pt-3 pb-2" aria-label={msg("board.ai.trace.stepperAria")}>
        {nodes.map((n, i) => {
          const tone = nodeTone(n.idx);
          const glyph = tone === "verified" ? "✓" : tone === "flagged" ? "!" : i + 1;
          return (
            <li key={n.idx} className="flex min-w-0 flex-1 items-center last:flex-none">
              <div className="flex min-w-0 flex-col items-center gap-1 text-center">
                <span
                  aria-hidden
                  className={`grid h-6 w-6 place-items-center rounded-full text-[11px] font-semibold ring-1 transition-colors duration-300 ${dotClass[tone]} ${
                    tone === "active" && isLive ? "animate-pulse" : ""
                  }`}
                >
                  {glyph}
                </span>
                <span className={`max-w-16 truncate text-[10px] font-medium leading-none ${labelClass[tone]}`}>
                  {n.label}
                </span>
              </div>
              {i < nodes.length - 1 && (
                <span
                  aria-hidden
                  className={`mx-1 mt-3 h-px flex-1 self-start transition-colors duration-300 ${
                    verified ? "bg-teal-300" : connectorLit(nodes[i + 1]!.idx) ? "bg-violet-300" : "bg-slate-200"
                  }`}
                />
              )}
            </li>
          );
        })}
      </ol>

      {/* Verification console — the machine's own voice, mono on floodlit night. */}
      <ol
        ref={logRef}
        role="log"
        aria-live="polite"
        aria-label={msg("board.ai.trace.consoleAria")}
        className="max-h-40 overflow-y-auto border-t border-slate-800 bg-slate-950 px-3 py-2 font-mono text-[11px] leading-relaxed"
      >
        {consoleLines.length === 0 && (
          <li className="text-slate-400">{msg("board.ai.trace.consoleWaiting")}</li>
        )}
        {consoleLines.map(({ e, i }) => (
          <li
            key={i}
            className={`whitespace-pre-wrap break-words ${lineTone[e.t as Exclude<TraceEventKind, "step">]}`}
          >
            {e.t === "flag" && <span aria-hidden className="mr-1 text-red-400">⚑</span>}
            {e.t === "clean" && <span aria-hidden className="mr-1 text-teal-400">✓</span>}
            {e.text}
            {isLive && i === consoleLines[consoleLines.length - 1]?.i && (
              <span aria-hidden className="ml-0.5 inline-block w-1.5 animate-pulse text-slate-400">▌</span>
            )}
          </li>
        ))}
      </ol>

      {/* State tag */}
      <div className="flex items-center gap-2 border-t border-slate-200 bg-slate-50/70 px-3 py-1.5">
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
            isLive
              ? "bg-violet-100 text-violet-700"
              : verified
                ? "bg-teal-100 text-teal-700"
                : "bg-red-100 text-red-700"
          }`}
        >
          <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${isLive ? "animate-pulse bg-violet-500" : verified ? "bg-teal-500" : "bg-red-500"}`} />
          {isLive
            ? msg("board.ai.trace.state.running")
            : verified
              ? msg("board.ai.trace.state.verified")
              : msg("board.ai.trace.state.flagged")}
        </span>
      </div>
    </section>
  );
}
