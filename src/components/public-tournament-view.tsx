"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client";
import { Avatar } from "@/components/avatar";
import {
  findChampionPlayer,
  playerName,
  sortedGroupRounds,
  sortedKoRounds,
} from "@/lib/format";
import type { Match, Player, StandingRow, TournamentState } from "@/lib/types";

const STATUS_STYLE: Record<string, string> = {
  setup: "bg-slate-100 text-slate-600",
  group: "bg-sky-100 text-sky-700",
  knockout: "bg-amber-100 text-amber-700",
  final: "bg-amber-100 text-amber-700",
  completed: "bg-emerald-100 text-emerald-700",
};

function imageOf(players: Player[], pid: string | null): string | null {
  return players.find((p) => p.id === pid)?.image_url ?? null;
}

export function PublicTournamentView({ state: initial }: { state: TournamentState }) {
  const [state, setState] = useState(initial);
  const { tournament: t, players, rounds, matches, standings } = state;

  const refresh = useCallback(async () => {
    try {
      const fresh = await api<TournamentState>(
        `/api/tournaments/${t.id}/state`,
      );
      setState(fresh);
    } catch { /* keep last */ }
  }, [t.id]);

  // Poll every 10s (realtime upgrade not available on public page without login)
  useEffect(() => {
    const timer = setInterval(refresh, 10_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const champion = t.status === "completed" ? findChampionPlayer(state) : null;
  const groupRounds = sortedGroupRounds(rounds);
  const koRounds = sortedKoRounds(rounds);

  return (
    <div className="space-y-6">
      {/* Status banner */}
      <div className="flex items-center gap-3">
        <span className={`badge ${STATUS_STYLE[t.status] ?? STATUS_STYLE.setup}`}>
          {t.status === "setup" ? "Not started" : t.status}
        </span>
        {t.status !== "setup" && t.status !== "completed" && (
          <span className="flex items-center gap-1.5 text-xs text-emerald-600">
            <span className="inline-block h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(74,222,128,0.8)]" />
            Live
          </span>
        )}
        {champion && (
          <span className="text-sm font-semibold text-amber-700">
            🏆 {playerName(players, champion.id)}
          </span>
        )}
      </div>

      {/* Standings */}
      {standings.length > 0 && (
        <section className="card overflow-hidden p-0">
          <div className="border-b border-purple-50 px-4 py-3">
            <h2 className="font-semibold text-slate-800">Standings</h2>
          </div>
          <table className="table w-full">
            <thead>
              <tr>
                <th>#</th>
                <th>Player</th>
                <th className="text-center">P</th>
                <th className="text-center">W</th>
                <th className="text-center">D</th>
                <th className="text-center">L</th>
                <th className="text-center">Pts</th>
              </tr>
            </thead>
            <tbody>
              {standings.map((s, i) => (
                <tr key={s.player.id}>
                  <td className="font-mono text-xs text-slate-400">{i + 1}</td>
                  <td>
                    <div className="flex items-center gap-2">
                      <Avatar name={s.player.name} src={s.player.image_url} size={22} />
                      <span className="font-medium text-slate-800">{s.player.name}</span>
                    </div>
                  </td>
                  <td className="text-center text-slate-500">{s.played}</td>
                  <td className="text-center text-slate-500">{s.wins}</td>
                  <td className="text-center text-slate-500">{s.draws}</td>
                  <td className="text-center text-slate-500">{s.losses}</td>
                  <td className="text-center font-bold text-purple-700">{s.points}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {/* Group rounds */}
      {groupRounds.map((r) => {
        const rMatches = matches.filter((m) => m.round_id === r.id);
        return (
          <section key={r.id} className="card p-4">
            <h3 className="mb-3 font-semibold text-slate-700">{r.name}</h3>
            <div className="space-y-2">
              {rMatches.map((m) => (
                <MatchRow key={m.id} m={m} players={players} />
              ))}
            </div>
          </section>
        );
      })}

      {/* Knockout bracket */}
      {koRounds.length > 0 && (
        <section className="card p-4">
          <h3 className="mb-4 font-semibold text-slate-700">Bracket</h3>
          <div className="flex gap-6 overflow-x-auto pb-2">
            {koRounds.map((r) => {
              const rMatches = matches
                .filter((m) => m.round_id === r.id)
                .sort((a, b) => a.board_number - b.board_number);
              return (
                <div key={r.id} className="min-w-[160px] shrink-0">
                  <p className="mb-2 text-center text-xs font-semibold uppercase tracking-wide text-purple-400">
                    {r.name}
                  </p>
                  <div className="space-y-3">
                    {rMatches.map((m) => (
                      <MatchRow key={m.id} m={m} players={players} compact />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

function MatchRow({
  m,
  players,
  compact = false,
}: {
  m: Match;
  players: Player[];
  compact?: boolean;
}) {
  const p1 = playerName(players, m.player1_id);
  const p2 = playerName(players, m.player2_id);
  const isBye = m.is_bye;
  const done = m.status === "completed";

  if (compact) {
    return (
      <div
        className={`rounded-lg border p-2.5 text-xs ${done ? "border-purple-100 bg-purple-50" : "border-slate-100 bg-white"}`}
      >
        <MatchSide name={p1} img={imageOf(players, m.player1_id)} won={m.winner_id === m.player1_id} score={m.player1_score} />
        <div className="my-1 border-t border-dashed border-slate-100" />
        {isBye ? (
          <span className="text-slate-400">BYE</span>
        ) : (
          <MatchSide name={p2} img={imageOf(players, m.player2_id)} won={m.winner_id === m.player2_id} score={m.player2_score} />
        )}
      </div>
    );
  }

  return (
    <div
      className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm ${done ? "border-purple-100 bg-purple-50" : "border-slate-100 bg-white"}`}
    >
      <span className={`min-w-0 flex-1 truncate ${m.winner_id === m.player1_id ? "font-semibold text-purple-800" : "text-slate-600"}`}>{p1}</span>
      <span className="shrink-0 font-mono text-xs text-slate-400">
        {done
          ? m.player1_score !== null
            ? `${m.player1_score ?? 0}–${m.player2_score ?? 0}`
            : m.is_draw
              ? "Draw"
              : m.winner_id === m.player1_id
                ? "W–L"
                : "L–W"
          : isBye
            ? "BYE"
            : "vs"}
      </span>
      <span className={`min-w-0 flex-1 truncate text-right ${m.winner_id === m.player2_id ? "font-semibold text-purple-800" : "text-slate-600"}`}>{isBye ? "" : p2}</span>
    </div>
  );
}

function MatchSide({
  name,
  img,
  won,
  score,
}: {
  name: string;
  img: string | null;
  won: boolean;
  score: number | null;
}) {
  return (
    <div className={`flex items-center gap-1.5 ${won ? "font-semibold text-purple-800" : "text-slate-600"}`}>
      <Avatar name={name} src={img} size={16} />
      <span className="flex-1 truncate">{name}</span>
      {score !== null && <span className="font-mono">{score}</span>}
    </div>
  );
}
