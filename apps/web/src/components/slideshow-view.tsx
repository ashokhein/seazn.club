"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/client";
import {
  activeMatches,
  findChampionPlayer,
  findRunnerUpPlayer,
  findThirdPlacePlayer,
  playerName,
} from "@/lib/format";
import { Avatar } from "@/components/avatar";
import type { Player, StandingRow, TournamentState } from "@/lib/types";

const SLIDE_MS = 9000;

function imageOf(players: Player[], pid: string | null): string | null {
  return players.find((p) => p.id === pid)?.image_url ?? null;
}

function formatLabel(format: string): string {
  if (format === "knockout") return "Single elimination";
  if (format === "round_robin") return "Round robin";
  if (format === "progress_stepladder") return "Stepladder finals";
  return "Progress + knockout";
}

function slideshowRoundPill(
  t: TournamentState["tournament"],
  rounds: TournamentState["rounds"],
): React.ReactNode {
  if (t.status === "completed") return null;
  const groupRounds = rounds
    .filter((r) => r.stage === "group")
    .sort((a, b) => a.round_number - b.round_number);
  const active = groupRounds.find((r) => r.status === "active");
  if (!active) return null;
  const idx = groupRounds.indexOf(active) + 1;
  const total = t.format !== "knockout" ? t.num_group_rounds : 0;
  if (!total) return <Pill>{active.name}</Pill>;
  return <Pill>Round {idx} of {total}</Pill>;
}

export function SlideshowView({
  id,
  initial,
  orgLogoUrl,
}: {
  id: string;
  initial: TournamentState;
  orgLogoUrl?: string | null;
}) {
  const [state, setState] = useState<TournamentState>(initial);
  const [slide, setSlide] = useState(0);
  const [now, setNow] = useState<Date | null>(null);

  const refresh = useCallback(async () => {
    try {
      setState(await api<TournamentState>(`/api/tournaments/${id}/state`));
    } catch {
      /* keep last good */
    }
  }, [id]);

  useEffect(() => {
    setNow(new Date());
    const clock = setInterval(() => setNow(new Date()), 1000);
    const r = setInterval(refresh, 5000);
    const s = setInterval(() => setSlide((v) => v + 1), SLIDE_MS);
    return () => {
      clearInterval(clock);
      clearInterval(r);
      clearInterval(s);
    };
  }, [refresh]);

  const t = state.tournament;
  const live = useMemo(
    () => activeMatches(state.matches).slice(0, 9),
    [state.matches],
  );
  const championPlayer =
    t.status === "completed" ? findChampionPlayer(state) : null;

  // Build the rotating scene list dynamically.
  const scenes = useMemo(() => {
    const list: ("matches" | "standings")[] = [];
    if (live.length > 0) list.push("matches");
    if (state.standings.length > 0) list.push("standings");
    if (list.length === 0) list.push("matches");
    return list;
  }, [live.length, state.standings.length]);

  const scene = championPlayer ? "champion" : scenes[slide % scenes.length];
  const clock = now
    ? now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "";

  return (
    <main className="relative min-h-screen overflow-hidden bg-[radial-gradient(1200px_700px_at_80%_-10%,#7e22ce_0%,transparent_55%),radial-gradient(900px_600px_at_-5%_10%,#a21caf_0%,transparent_50%),linear-gradient(160deg,#2e1065_0%,#4c1d95_55%,#6b21a8_100%)] px-10 py-8 text-white">
      {/* decorative blobs */}
      <div
        aria-hidden
        className="pointer-events-none absolute -left-24 top-1/3 h-96 w-96 rounded-full bg-fuchsia-500/20 blur-3xl"
        style={{ animation: "float-blob 14s ease-in-out infinite" }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -right-20 bottom-0 h-[28rem] w-[28rem] rounded-full bg-purple-400/20 blur-3xl"
        style={{ animation: "float-blob 18s ease-in-out infinite reverse" }}
      />

      {/* header */}
      <header className="relative mb-10 flex items-end justify-between gap-6">
        <div className="flex items-center gap-5">
          <div className="grid h-20 w-20 place-items-center rounded-3xl bg-white/10 shadow-inner ring-1 ring-white/20 overflow-hidden">
            {orgLogoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={orgLogoUrl} alt="Organisation logo" className="h-full w-full object-contain p-2" />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src="/logo-wide.png" alt="Seazn Club" className="h-full w-full object-contain p-2" />
            )}
          </div>
          <div>
            <h1 className="text-6xl font-black leading-none tracking-tight drop-shadow-sm">
              {t.name}
            </h1>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-lg">
              <Pill>{t.sport}</Pill>
              <Pill className="capitalize">{t.category}</Pill>
              <Pill>{formatLabel(t.format)}</Pill>
              <Pill>{state.players.length} players</Pill>
              {slideshowRoundPill(t, state.rounds)}
              {t.venue && <Pill>📍 {t.venue}</Pill>}
            </div>
          </div>
        </div>

        <div className="flex flex-col items-end gap-3">
          <div className="flex items-center gap-3">
            {t.status !== "completed" && (
              <span className="flex items-center gap-2 rounded-full bg-emerald-400/15 px-4 py-1.5 text-base font-semibold uppercase tracking-wider text-emerald-200 ring-1 ring-emerald-300/30">
                <span
                  className="h-2.5 w-2.5 rounded-full bg-emerald-400"
                  style={{ animation: "live-pulse 1.8s ease-in-out infinite" }}
                />
                Live
              </span>
            )}
            <span className="rounded-full bg-white/15 px-4 py-1.5 text-base font-semibold capitalize tracking-wide ring-1 ring-white/20">
              {t.status}
            </span>
          </div>
          <span className="font-mono text-2xl tabular-nums text-purple-100">
            {clock}
          </span>
        </div>
      </header>

      {/* scene */}
      <div key={`${scene}-${slide}`} className="animate-slide-in">
        {scene === "champion" && championPlayer && (
          <ChampionScene state={state} champion={championPlayer} />
        )}
        {scene === "matches" && (
          <MatchesScene state={state} live={live} />
        )}
        {scene === "standings" && (
          <StandingsScene standings={state.standings} completed={t.status === "completed"} />
        )}
      </div>

      {/* slide progress + dots */}
      {!championPlayer && scenes.length > 1 && (
        <div className="absolute inset-x-10 bottom-6 flex items-center gap-4">
          <div className="flex gap-2">
            {scenes.map((sc, i) => (
              <span
                key={sc}
                className={`h-2.5 rounded-full transition-all ${
                  i === slide % scenes.length
                    ? "w-8 bg-white"
                    : "w-2.5 bg-white/30"
                }`}
              />
            ))}
          </div>
          <div className="relative h-1 flex-1 overflow-hidden rounded-full bg-white/15">
            <div
              key={slide}
              className="absolute inset-y-0 left-0 bg-white/70"
              style={{ animation: `slide-progress ${SLIDE_MS}ms linear both` }}
            />
          </div>
        </div>
      )}
    </main>
  );
}

function Pill({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`rounded-full bg-white/10 px-3 py-1 font-medium text-purple-100 ring-1 ring-white/15 ${className}`}
    >
      {children}
    </span>
  );
}

function MatchesScene({
  state,
  live,
}: {
  state: TournamentState;
  live: TournamentState["matches"];
}) {
  return (
    <section>
      <SceneTitle>Now playing</SceneTitle>
      {live.length === 0 ? (
        <div className="grid place-items-center rounded-3xl border border-white/15 bg-white/5 py-24 text-center">
          <p className="text-4xl font-semibold text-purple-200">
            Waiting for the next round…
          </p>
          <p className="mt-3 text-xl text-purple-300/80">
            Results will appear here automatically.
          </p>
        </div>
      ) : (
        <div
          className={`grid gap-6 ${
            live.length <= 2
              ? "grid-cols-1 md:grid-cols-2"
              : "grid-cols-1 md:grid-cols-2 xl:grid-cols-3"
          }`}
        >
          {live.map((m) => (
            <div
              key={m.id}
              className="rounded-3xl border border-white/15 bg-white/10 p-6 shadow-xl backdrop-blur-md ring-1 ring-white/5"
            >
              <div className="mb-4 flex items-center justify-between">
                <span className="rounded-full bg-white/15 px-3 py-1 text-sm font-semibold uppercase tracking-wider text-purple-100">
                  {m.label || `Board ${m.board_number}`}
                </span>
              </div>
              <Side
                name={playerName(state.players, m.player1_id)}
                img={imageOf(state.players, m.player1_id)}
              />
              <div className="my-3 flex items-center gap-3">
                <span className="h-px flex-1 bg-white/15" />
                <span className="rounded-full bg-fuchsia-500/30 px-3 py-0.5 text-sm font-bold tracking-widest text-fuchsia-100 ring-1 ring-fuchsia-300/30">
                  VS
                </span>
                <span className="h-px flex-1 bg-white/15" />
              </div>
              <Side
                name={playerName(state.players, m.player2_id)}
                img={imageOf(state.players, m.player2_id)}
              />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Side({ name, img }: { name: string; img: string | null }) {
  const tbd = name === "TBD";
  return (
    <div className="flex items-center gap-4">
      <Avatar name={tbd ? "?" : name} src={img} size={56} />
      <span
        className={`truncate text-4xl font-bold ${
          tbd ? "text-purple-300/60" : "text-white"
        }`}
      >
        {name}
      </span>
    </div>
  );
}

function StandingsScene({ standings, completed }: { standings: StandingRow[]; completed: boolean }) {
  const top3 = completed ? standings.slice(0, 3) : [];
  const tableRows = completed ? standings.slice(3, 12) : standings.slice(0, 12);
  const rest = tableRows;
  return (
    <section>
      <SceneTitle>Standings</SceneTitle>
      {completed && top3.length >= 3 && <Podium top3={top3} />}
      {rest.length > 0 && (
        <div className="mt-8 overflow-hidden rounded-3xl border border-white/15 bg-white/5">
          <table className="w-full text-2xl">
            <thead className="bg-white/10 text-lg uppercase tracking-wider text-purple-200">
              <tr>
                <th className="px-6 py-3 text-left font-semibold">#</th>
                <th className="px-6 py-3 text-left font-semibold">Name</th>
                <th className="px-6 py-3 text-right font-semibold">Pts</th>
                <th className="px-6 py-3 text-right font-semibold">W/D/L</th>
              </tr>
            </thead>
            <tbody>
              {rest.map((s) => (
                <tr
                  key={s.player.id}
                  className="border-t border-white/10 odd:bg-white/[0.03]"
                >
                  <td className="px-6 py-3 font-bold text-purple-300">
                    {s.rank}
                  </td>
                  <td className="px-6 py-3 font-semibold">
                    <span className="flex items-center gap-3">
                      <Avatar
                        name={s.player.name}
                        src={s.player.image_url}
                        size={40}
                      />
                      {s.player.name}
                    </span>
                  </td>
                  <td className="px-6 py-3 text-right font-black text-fuchsia-200">
                    {s.points}
                  </td>
                  <td className="px-6 py-3 text-right text-purple-200">
                    {s.wins}/{s.draws}/{s.losses}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Podium({ top3 }: { top3: StandingRow[] }) {
  // Display order: 2nd, 1st, 3rd
  const order = [top3[1], top3[0], top3[2]];
  const meta = [
    { medal: "🥈", h: "h-40", ring: "ring-slate-200/40", glow: "" },
    {
      medal: "🥇",
      h: "h-56",
      ring: "ring-amber-300/50",
      glow: "shadow-[0_0_60px_-12px_rgba(251,191,36,0.6)]",
    },
    { medal: "🥉", h: "h-32", ring: "ring-orange-300/40", glow: "" },
  ];
  return (
    <div className="grid grid-cols-3 items-end gap-6">
      {order.map((s, i) => (
        <div key={s.player.id} className="flex flex-col items-center">
          <Avatar
            name={s.player.name}
            src={s.player.image_url}
            size={i === 1 ? 96 : 72}
            className={`ring-4 ${meta[i].ring} ${meta[i].glow}`}
          />
          <p
            className={`mt-3 text-center font-bold ${
              i === 1 ? "text-4xl" : "text-3xl"
            }`}
          >
            {s.player.name}
          </p>
          <p className="text-xl text-fuchsia-200">{s.points} pts</p>
          <div
            className={`mt-3 flex w-full ${meta[i].h} items-start justify-center rounded-t-2xl border border-white/15 bg-white/10 pt-4 text-6xl ${meta[i].glow}`}
          >
            {meta[i].medal}
          </div>
        </div>
      ))}
    </div>
  );
}

function ChampionScene({
  state,
  champion,
}: {
  state: TournamentState;
  champion: Player;
}) {
  const runnerUp = findRunnerUpPlayer(state);
  const third = findThirdPlacePlayer(state);
  const alsoRan = [runnerUp, third].filter(Boolean) as Player[];
  const champStanding = state.standings.find((s) => s.player.id === champion.id);

  return (
    <div className="flex flex-col items-center">
      <div className="animate-trophy rounded-[2.5rem] border border-amber-300/30 bg-gradient-to-b from-amber-400/15 to-fuchsia-500/10 px-16 py-12 text-center shadow-[0_0_120px_-30px_rgba(251,191,36,0.7)]">
        <p className="text-2xl font-semibold uppercase tracking-[0.3em] text-amber-200">
          Champion
        </p>
        <div className="mt-6 flex items-center justify-center gap-6">
          <Avatar
            name={champion.name}
            src={champion.image_url}
            size={120}
            className="ring-4 ring-amber-300/60"
          />
          <p className="text-8xl font-black drop-shadow">{champion.name}</p>
        </div>
        <p className="mt-4 text-7xl">🏆</p>
      </div>

      {alsoRan.length > 0 && (
        <div className="mt-10 flex gap-6">
          {alsoRan.map((p, i) => (
            <div
              key={p.id}
              className="flex items-center gap-4 rounded-2xl border border-white/15 bg-white/10 px-8 py-4"
            >
              <span className="text-4xl">{i === 0 ? "🥈" : "🥉"}</span>
              <Avatar name={p.name} src={p.image_url} size={56} />
              <span className="text-3xl font-bold">{p.name}</span>
            </div>
          ))}
        </div>
      )}
      <p className="mt-8 text-xl text-purple-200/70">
        {state.players.length} competitors
        {champStanding ? ` · ${champStanding.played} rounds played` : ""}
      </p>
    </div>
  );
}

function SceneTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-7 flex items-center gap-4 text-4xl font-bold text-purple-100">
      <span className="h-8 w-1.5 rounded-full bg-fuchsia-400" />
      {children}
    </h2>
  );
}
