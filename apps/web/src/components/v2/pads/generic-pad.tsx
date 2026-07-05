"use client";

// Result buttons for the generic module (spec 04 §8): tap a winner (win_loss)
// or enter both scores (score mode). One terminal generic.result event.
import { useState } from "react";
import type { SendEvent, SideInfo, SportInfo } from "@/components/v2/fixture-console";

export function GenericPad({
  sport,
  home,
  away,
  send,
  busy,
}: {
  sport: SportInfo;
  home: SideInfo;
  away: SideInfo;
  send: SendEvent;
  busy: boolean;
}) {
  const cfg = sport.config as { resultMode?: string; allowDraws?: boolean };
  const [p1, setP1] = useState("");
  const [p2, setP2] = useState("");

  if (cfg.resultMode === "score") {
    return (
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void send("generic.result", { p1Score: Number(p1), p2Score: Number(p2) });
        }}
      >
        <label className="block">
          <span className="label">{home.name}</span>
          <input
            required
            type="number"
            min={0}
            value={p1}
            onChange={(e) => setP1(e.target.value)}
            className="input w-24"
          />
        </label>
        <label className="block">
          <span className="label">{away.name}</span>
          <input
            required
            type="number"
            min={0}
            value={p2}
            onChange={(e) => setP2(e.target.value)}
            className="input w-24"
          />
        </label>
        <button type="submit" disabled={busy || p1 === "" || p2 === ""} className="btn btn-primary">
          Record result
        </button>
        {!cfg.allowDraws && p1 !== "" && p1 === p2 && (
          <span className="text-xs text-amber-600">Draws are not allowed in this division.</span>
        )}
      </form>
    );
  }

  return (
    <div className="flex flex-wrap gap-2">
      <button
        type="button"
        disabled={busy}
        onClick={() => send("generic.result", { winnerId: home.id })}
        className="btn btn-primary"
      >
        {home.name} won
      </button>
      {cfg.allowDraws && (
        <button
          type="button"
          disabled={busy}
          onClick={() => send("generic.result", { isDraw: true })}
          className="btn btn-ghost"
        >
          Draw
        </button>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() => send("generic.result", { winnerId: away.id })}
        className="btn btn-primary"
      >
        {away.name} won
      </button>
    </div>
  );
}
