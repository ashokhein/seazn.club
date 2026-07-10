"use client";

// Carrom pad (engine/sports/carrom.md, board-level fidelity): a match is
// best-of games, a game is a points race, and a BOARD banks the winner's
// points in one carrom.board.summary event — so the pad records boards:
// who won it, how many coins the loser had left, who covered the queen.
// Toss picks first break before the start; umpire adjustments tuck away
// under a details fold. Strike-by-strike stays reserved (Pro, later).
import { useState } from "react";
import type { LiveState, SendEvent, SideInfo } from "@/components/v2/fixture-console";

// The carrom fold state (engine CarromState) as the pad reads it — same
// live.state pattern as the set-based (badminton) scoreboard.
interface CarromGameView {
  score?: { home?: number; away?: number };
  winner?: "home" | "away" | "draw" | null;
  boards?: unknown[];
}
interface CarromStateView {
  phase?: string;
  games?: CarromGameView[];
  gamesWon?: { home?: number; away?: number };
  cfg?: { bestOf?: number; gameTo?: number };
}

export function CarromPad({
  home,
  away,
  live,
  send,
  busy,
  started,
}: {
  home: SideInfo;
  away: SideInfo;
  live: LiveState;
  send: SendEvent;
  busy: boolean;
  started: boolean;
}) {
  const state = (live.state ?? {}) as CarromStateView;
  const games = state.games ?? [];
  const openIndex = games.findIndex((g) => (g.winner ?? null) === null);
  const currentNo = openIndex === -1 ? games.length + 1 : openIndex + 1;
  const bestOf = state.cfg?.bestOf;
  const gameTo = state.cfg?.gameTo;
  const [winnerId, setWinnerId] = useState<string | null>(null);
  const [coinsLeft, setCoinsLeft] = useState(0);
  const [queenTo, setQueenTo] = useState<string>(""); // "" = nobody credited
  const [adjustEntrant, setAdjustEntrant] = useState(home.id);
  const [adjustDelta, setAdjustDelta] = useState("");
  const [adjustReason, setAdjustReason] = useState("");

  async function recordBoard() {
    if (!winnerId) return;
    const ok = await send("carrom.board.summary", {
      winner: winnerId,
      opponentCoinsLeft: coinsLeft,
      queenTo: queenTo || null,
    });
    if (ok) {
      setWinnerId(null);
      setCoinsLeft(0);
      setQueenTo("");
    }
  }

  return (
    <div className="space-y-4">
      {/* Per-game scoreboard (badminton-style): one column per game, live
          points in the open game, games-won tally at the end. */}
      {games.length > 0 && (
        <div className="scroll-x scroll-x-fade">
          <table className="text-sm" aria-label="Carrom games">
            <thead>
              <tr className="text-left text-xs tracking-wide text-slate-500 uppercase">
                <th className="py-1 pr-4 font-medium">
                  Game {currentNo}
                  {bestOf ? ` of ${bestOf}` : ""}
                  {gameTo ? ` · first to ${gameTo}` : ""}
                </th>
                {games.map((_, i) => (
                  <th key={i} className="px-2 py-1 text-center font-medium">
                    G{i + 1}
                  </th>
                ))}
                <th className="px-2 py-1 text-center font-medium">Games</th>
              </tr>
            </thead>
            <tbody>
              {(["home", "away"] as const).map((side) => (
                <tr key={side} className="border-t border-slate-100">
                  <td className="max-w-40 truncate py-1 pr-4 font-medium text-slate-800">
                    {side === "home" ? home.name : away.name}
                  </td>
                  {games.map((g, i) => {
                    const pts = g.score?.[side] ?? 0;
                    const isOpen = i === openIndex;
                    const won = g.winner === side;
                    return (
                      <td
                        key={i}
                        className={`px-2 py-1 text-center tabular-nums ${
                          won
                            ? "font-semibold text-slate-900"
                            : isOpen
                              ? "font-semibold text-purple-700"
                              : "text-slate-500"
                        }`}
                      >
                        {pts}
                        {isOpen ? "•" : ""}
                      </td>
                    );
                  })}
                  <td className="px-2 py-1 text-center font-semibold text-slate-900 tabular-nums">
                    {state.gamesWon?.[side] ?? 0}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!started && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-slate-600">
            Toss — who breaks first?
          </span>
          {[home, away].map((side) => (
            <button
              key={side.id}
              type="button"
              disabled={busy}
              aria-label={`${side.name} breaks first`}
              onClick={() => send("carrom.toss", { firstBreak: side.id })}
              className="btn btn-ghost px-3 py-1.5 text-xs"
            >
              {side.name}
            </button>
          ))}
          <span className="text-xs text-slate-500">
            Optional — without a toss, {home.name} breaks.
          </span>
        </div>
      )}

      {/* One board = one event. */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-slate-600">Board won by</span>
          {[home, away].map((side) => (
            <button
              key={side.id}
              type="button"
              disabled={busy}
              aria-pressed={winnerId === side.id}
              aria-label={`Board won by ${side.name}`}
              onClick={() => setWinnerId(winnerId === side.id ? null : side.id)}
              className={`btn px-4 ${
                winnerId === side.id ? "btn-primary" : "btn-ghost"
              }`}
            >
              {side.name}
            </button>
          ))}
        </div>

        {winnerId && (
          <div className="flex flex-wrap items-end gap-3">
            <label className="block">
              <span className="label">Opponent&apos;s coins left (0–9)</span>
              <input
                type="number"
                min={0}
                max={9}
                inputMode="numeric"
                value={coinsLeft}
                onChange={(e) =>
                  setCoinsLeft(Math.max(0, Math.min(9, Number(e.target.value) || 0)))
                }
                className="input w-24"
              />
            </label>
            <label className="block">
              <span className="label">Queen covered by</span>
              <select
                value={queenTo}
                onChange={(e) => setQueenTo(e.target.value)}
                className="select w-44"
              >
                <option value="">No one (not credited)</option>
                <option value={home.id}>{home.name}</option>
                <option value={away.id}>{away.name}</option>
              </select>
            </label>
            <button
              type="button"
              disabled={busy}
              onClick={() => void recordBoard()}
              className="btn btn-primary"
            >
              Record board
            </button>
          </div>
        )}
        <p className="text-xs text-slate-500">
          The winner banks a point per opponent coin left, plus the queen bonus while
          under the cap. Games and the match decide themselves from the boards.
        </p>
      </div>

      {/* Umpire adjustment (Laws 51/55) — rare, kept out of the way. */}
      <details className="text-sm">
        <summary className="cursor-pointer text-xs font-medium text-slate-600">
          Umpire adjustment
        </summary>
        <div className="mt-2 flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="label">Player</span>
            <select
              value={adjustEntrant}
              onChange={(e) => setAdjustEntrant(e.target.value)}
              className="select w-40"
            >
              <option value={home.id}>{home.name}</option>
              <option value={away.id}>{away.name}</option>
            </select>
          </label>
          <label className="block">
            <span className="label">Points (±)</span>
            <input
              type="number"
              value={adjustDelta}
              onChange={(e) => setAdjustDelta(e.target.value)}
              className="input w-24"
            />
          </label>
          <label className="block">
            <span className="label">Reason</span>
            <input
              value={adjustReason}
              onChange={(e) => setAdjustReason(e.target.value)}
              placeholder="e.g. Law 55 penalty"
              className="input w-52"
            />
          </label>
          <button
            type="button"
            disabled={busy || !adjustReason.trim() || !Number(adjustDelta)}
            onClick={() =>
              void send("carrom.game.adjust", {
                entrantId: adjustEntrant,
                delta: Number(adjustDelta),
                reason: adjustReason.trim(),
              }).then((ok) => {
                if (ok) {
                  setAdjustDelta("");
                  setAdjustReason("");
                }
              })
            }
            className="btn btn-ghost"
          >
            Apply
          </button>
        </div>
      </details>
    </div>
  );
}
