"use client";

// Tennis rally pad (v6/00 §5): one tap per point with the spoken score
// (15/30/40/Ad, tie-break numerals), a serve dot and the set strip; or coarse
// per-set summaries (Tier 0/1) with optional tie-break points. Event type
// names come from the module's fidelityTiers declaration — no hardcoded
// sport strings, so padel reuses this pad when it lands on the nested kernel.
import { useState } from "react";
import type { SendEvent, SideInfo, SportInfo, LiveState } from "@/components/v2/fixture-console";

interface TennisSetView {
  home: number;
  away: number;
  tb?: { home: number; away: number };
  mtb?: boolean;
}
interface TennisPointsView {
  kind: "standard" | "tiebreak" | "matchTiebreak";
  home: number;
  away: number;
  advantage?: "home" | "away" | null;
}
interface TennisStateView {
  phase?: string;
  sets?: TennisSetView[];
  games?: { home: number; away: number };
  points?: TennisPointsView;
  setsWon?: { home: number; away: number };
  serving?: "home" | "away";
  cfg?: { bestOf?: number };
}

const CALLS = ["0", "15", "30", "40"] as const;

// The spoken call for one side of the current game.
function callFor(points: TennisPointsView, side: "home" | "away"): string {
  if (points.kind !== "standard") return String(points[side]);
  if (points.home === 3 && points.away === 3) {
    if (points.advantage === side) return "Ad";
    if (points.advantage) return "–";
    return "40";
  }
  return CALLS[points[side]] ?? "40";
}

function setLine(set: TennisSetView): string {
  if (set.mtb) return `[${set.home}–${set.away}]`;
  if (set.tb) return `${set.home}–${set.away}(${Math.min(set.tb.home, set.tb.away)})`;
  return `${set.home}–${set.away}`;
}

export function TennisPad({
  sport,
  home,
  away,
  live,
  send,
  busy,
}: {
  sport: SportInfo;
  home: SideInfo;
  away: SideInfo;
  live: LiveState;
  send: SendEvent;
  busy: boolean;
}) {
  const pointType = sport.fidelityTiers.find((t) => t.tier === 3)?.eventTypes[0];
  const summaryType = sport.fidelityTiers.find((t) => t.tier === 0)?.eventTypes[0];
  const state = (live.state ?? {}) as TennisStateView;
  const [mode, setMode] = useState<"rally" | "summary">("rally");
  const [sumHome, setSumHome] = useState("");
  const [sumAway, setSumAway] = useState("");
  const [tbHome, setTbHome] = useState("");
  const [tbAway, setTbAway] = useState("");

  const pre = state.phase === "pre" || live.status === "scheduled";
  const points = state.points ?? { kind: "standard" as const, home: 0, away: 0, advantage: null };
  const games = state.games ?? { home: 0, away: 0 };
  const setsWon = state.setsWon ?? { home: 0, away: 0 };
  const sets = state.sets ?? [];
  const currentNo = sets.length + 1;
  const bestOf = state.cfg?.bestOf;
  const inTb = points.kind === "tiebreak";
  const inMtb = points.kind === "matchTiebreak";
  const isDeuce =
    points.kind === "standard" && points.home === 3 && points.away === 3 && !points.advantage;

  return (
    <div className="space-y-4">
      <div className="flex gap-1 text-xs">
        {pointType && (
          <button
            type="button"
            onClick={() => setMode("rally")}
            className={`rounded-full px-3 py-1 ${mode === "rally" ? "bg-purple-100 text-purple-700" : "text-slate-500 hover:bg-slate-100"}`}
          >
            Point-by-point
          </button>
        )}
        {summaryType && (
          <button
            type="button"
            onClick={() => setMode("summary")}
            className={`rounded-full px-3 py-1 ${mode === "summary" ? "bg-purple-100 text-purple-700" : "text-slate-500 hover:bg-slate-100"}`}
          >
            Set totals
          </button>
        )}
      </div>

      {pre && (
        <p className="text-xs text-amber-600">Start the match to open the first set.</p>
      )}

      {mode === "rally" && pointType ? (
        <div className="space-y-2">
          {!pre && (
            <p className="text-xs font-semibold uppercase tracking-wide text-purple-600">
              {inMtb ? "Match tie-break" : inTb ? `Set ${currentNo} · tie-break` : `Set ${currentNo}`}
              {bestOf && !inMtb ? <span className="text-slate-400"> of {bestOf}</span> : null}
              {isDeuce ? <span className="ml-2 text-amber-600">Deuce</span> : null}
            </p>
          )}
          <div className="grid grid-cols-2 gap-3">
            {(
              [
                { side: home, key: "home" as const },
                { side: away, key: "away" as const },
              ] as const
            ).map(({ side, key }) => (
              <button
                key={side.id}
                type="button"
                disabled={busy || pre}
                onClick={() => send(pointType, { by: side.id })}
                // touch-manipulation kills the double-tap-zoom delay — this
                // button is hammered once per point on a courtside phone.
                className="select-none touch-manipulation rounded-xl border border-purple-200 bg-white p-4 text-center transition hover:border-purple-400 hover:bg-purple-50 active:scale-[0.97] active:bg-purple-100 disabled:opacity-50 sm:p-6"
              >
                <span className="block truncate text-sm font-medium text-slate-700">
                  {state.serving === key && !pre ? (
                    <span aria-label="serving" className="mr-1 text-amber-500">
                      ●
                    </span>
                  ) : null}
                  {side.name}
                </span>
                <span className="mt-1 block font-mono text-5xl tabular-nums text-slate-900">
                  {callFor(points, key)}
                </span>
                <span className="mt-1 block text-xs text-slate-400">
                  games {games[key]} · sets {setsWon[key]}
                </span>
                <span className="mx-auto mt-3 block w-fit rounded-full bg-purple-600 px-4 py-1.5 text-sm font-semibold text-white">
                  + point
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        summaryType && (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              const tb =
                tbHome !== "" && tbAway !== ""
                  ? { tb: { home: Number(tbHome), away: Number(tbAway) } }
                  : {};
              void send(summaryType, { home: Number(sumHome), away: Number(sumAway), ...tb });
              setSumHome("");
              setSumAway("");
              setTbHome("");
              setTbAway("");
            }}
          >
            <div className="flex flex-wrap items-end gap-3">
              <label className="block">
                <span className="label">{home.name} games</span>
                <input
                  required
                  type="number"
                  min={0}
                  value={sumHome}
                  onChange={(e) => setSumHome(e.target.value)}
                  className="input w-24"
                />
              </label>
              <label className="block">
                <span className="label">{away.name} games</span>
                <input
                  required
                  type="number"
                  min={0}
                  value={sumAway}
                  onChange={(e) => setSumAway(e.target.value)}
                  className="input w-24"
                />
              </label>
              <label className="block">
                <span className="label">TB points (opt.)</span>
                <input
                  type="number"
                  min={0}
                  value={tbHome}
                  onChange={(e) => setTbHome(e.target.value)}
                  placeholder={home.name}
                  className="input w-24"
                />
              </label>
              <label className="block">
                <span className="label">&nbsp;</span>
                <input
                  type="number"
                  min={0}
                  value={tbAway}
                  onChange={(e) => setTbAway(e.target.value)}
                  placeholder={away.name}
                  className="input w-24"
                />
              </label>
              <button
                type="submit"
                disabled={busy || pre || sumHome === "" || sumAway === ""}
                className="btn btn-primary"
              >
                Record set
              </button>
            </div>
            <p className="text-xs text-slate-400">
              Enter each completed set&apos;s games (7–6 needs its tie-break points). For a
              deciding match tie-break, enter the tie-break points as the set score.
            </p>
          </form>
        )
      )}

      {sets.length > 0 && (
        <p className="font-mono text-xs text-slate-500">
          Sets: {sets.map((s, i) => (
            <span key={i} className="mr-2">
              {setLine(s)}
            </span>
          ))}
          {!pre && (games.home > 0 || games.away > 0) && (
            <span className="text-slate-400">
              · {games.home}–{games.away}
            </span>
          )}
        </p>
      )}
    </div>
  );
}
