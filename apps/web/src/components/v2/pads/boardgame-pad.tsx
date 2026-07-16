"use client";

// Boardgame result buttons (spec 04 §6): 1–0 / ½–½ / 0–1 plus the method.
// A single terminal boardgame.result event; undo = void it.
import { useState } from "react";
import type { SendEvent, SideInfo } from "@/components/v2/fixture-console";
import { useMsg } from "@/components/i18n/dict-provider";

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
  const msg = useMsg();
  const [method, setMethod] = useState<string>("");

  const payloadMethod = method ? { method } : {};

  return (
    <div className="space-y-3">
      {!started && (
        <p className="text-xs text-slate-400">{msg("pad.bg.startHint")}</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => send("boardgame.result", { winner: home.id, ...payloadMethod })}
          className="btn btn-primary"
        >
          {msg("pad.bg.win", { name: home.name })}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => send("boardgame.result", { winner: null, ...payloadMethod })}
          className="btn btn-ghost"
        >
          {msg("pad.bg.drawBtn")}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => send("boardgame.result", { winner: away.id, ...payloadMethod })}
          className="btn btn-primary"
        >
          {msg("pad.bg.loss", { name: away.name })}
        </button>
        <label className="ml-2 block">
          <span className="sr-only">{msg("pad.bg.method")}</span>
          <select
            value={method}
            onChange={(e) => setMethod(e.target.value)}
            className="select w-40 px-2 py-1.5 text-xs"
          >
            <option value="">{msg("pad.bg.methodOptional")}</option>
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="text-xs text-slate-400">
        {msg("pad.bg.notePre")}
        <span className="font-mono">double_forfeit</span>
        {msg("pad.bg.notePost")}
      </p>
    </div>
  );
}
