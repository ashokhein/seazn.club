"use client";

// Boardgame result buttons (spec 04 §6): 1–0 / ½–½ / 0–1 plus the method.
// A single terminal boardgame.result event; undo = void it.
import { useState } from "react";
import type { SendEvent, SideInfo } from "@/components/v2/fixture-console";

const METHODS = [
  "checkmate",
  "resign",
  "time",
  "agreement",
  "stalemate",
  "insufficient",
  "adjudication",
] as const;

export function BoardgamePad({
  home,
  away,
  send,
  busy,
  started,
}: {
  home: SideInfo;
  away: SideInfo;
  send: SendEvent;
  busy: boolean;
  started: boolean;
}) {
  const [method, setMethod] = useState<string>("");

  const payloadMethod = method ? { method } : {};

  return (
    <div className="space-y-3">
      {!started && (
        <p className="text-xs text-slate-400">
          Start the match first, or record the result directly — the board result
          decides it either way.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => send("boardgame.result", { winner: home.id, ...payloadMethod })}
          className="btn btn-primary"
        >
          1–0 {home.name}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => send("boardgame.result", { winner: null, ...payloadMethod })}
          className="btn btn-ghost"
        >
          ½–½ Draw
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => send("boardgame.result", { winner: away.id, ...payloadMethod })}
          className="btn btn-primary"
        >
          0–1 {away.name}
        </button>
        <label className="ml-2 block">
          <span className="sr-only">Method</span>
          <select
            value={method}
            onChange={(e) => setMethod(e.target.value)}
            className="select w-40 px-2 py-1.5 text-xs"
          >
            <option value="">method (optional)</option>
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="text-xs text-slate-400">
        Home holds White when colours are enabled. Double defaults are recorded
        via the method <span className="font-mono">double_forfeit</span> with no winner.
      </p>
    </div>
  );
}
