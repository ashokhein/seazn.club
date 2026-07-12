"use client";

// Set-based rally pad (spec 04 §3): one tap per rally (Tier 3), or coarse
// per-set summaries (Tier 0/1). Event type names come from the module's own
// fidelityTiers declaration — no hardcoded sport strings.
import { useState } from "react";
import type { SendEvent, SideInfo, SportInfo, LiveState } from "@/components/v2/fixture-console";

interface SetView {
  home: number;
  away: number;
  closed: boolean;
}
interface SetBasedStateView {
  phase?: string;
  sets?: SetView[];
  setsWon?: { home: number; away: number };
  cfg?: { bestOf?: number };
}

export function SetbasedPad({
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
  // Tier declarations: tier 3 carries the rally type, tier 0 the summary type.
  const rallyType = sport.fidelityTiers.find((t) => t.tier === 3)?.eventTypes[0];
  const summaryType = sport.fidelityTiers.find((t) => t.tier === 0)?.eventTypes[0];
  const state = (live.state ?? {}) as SetBasedStateView;
  const [mode, setMode] = useState<"rally" | "summary">("rally");
  const [sumHome, setSumHome] = useState("");
  const [sumAway, setSumAway] = useState("");

  const openSet = state.sets?.find((s) => !s.closed);
  const pre = state.phase === "pre" || live.status === "scheduled";

  // Badminton/table-tennis call their sets "games" (engine unitLabel).
  const unit = sport.key === "volleyball" ? "Set" : "Game";
  // Current set number: the open set, or the next one about to start.
  const closedCount = state.sets?.filter((s) => s.closed).length ?? 0;
  const currentNo = closedCount + 1;
  const bestOf = state.cfg?.bestOf;

  return (
    <div className="space-y-4">
      <div className="flex gap-1 text-xs">
        {rallyType && (
          <button
            type="button"
            onClick={() => setMode("rally")}
            className={`rounded-full px-3 py-1 ${mode === "rally" ? "bg-purple-100 text-purple-700" : "text-slate-500 hover:bg-slate-100"}`}
          >
            Rally-by-rally
          </button>
        )}
        {summaryType && (
          <button
            type="button"
            onClick={() => setMode("summary")}
            className={`rounded-full px-3 py-1 ${mode === "summary" ? "bg-purple-100 text-purple-700" : "text-slate-500 hover:bg-slate-100"}`}
          >
            {unit} totals
          </button>
        )}
      </div>

      {pre && (
        <p className="text-xs text-amber-600">
          Start the match to open the first set.
        </p>
      )}

      {mode === "rally" && rallyType ? (
        <div className="space-y-2">
          {!pre && (
            <p className="text-xs font-semibold uppercase tracking-wide text-purple-600">
              {unit} {currentNo}
              {bestOf ? <span className="text-slate-400"> of {bestOf}</span> : null}
            </p>
          )}
          <div className="grid grid-cols-2 gap-3">
            {[
              { side: home, score: openSet?.home ?? 0, sets: state.setsWon?.home ?? 0 },
              { side: away, score: openSet?.away ?? 0, sets: state.setsWon?.away ?? 0 },
            ].map(({ side, score, sets }) => (
              <button
                key={side.id}
                type="button"
                disabled={busy || pre}
                onClick={() => send(rallyType, { wonBy: side.id })}
                // touch-manipulation kills the double-tap-zoom delay — this
                // button is hammered once per rally on a courtside phone.
                className="select-none touch-manipulation rounded-xl border border-purple-200 bg-white p-4 text-center transition hover:border-purple-400 hover:bg-purple-50 active:scale-[0.97] active:bg-purple-100 disabled:opacity-50 sm:p-6"
              >
                <span className="block truncate text-sm font-medium text-slate-700">
                  {side.name}
                </span>
                <span className="mt-1 block font-mono text-5xl tabular-nums text-slate-900">
                  {score}
                </span>
                <span className="mt-1 block text-xs text-slate-400">
                  {unit.toLowerCase()}s won {sets}
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
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void send(summaryType, { home: Number(sumHome), away: Number(sumAway) });
              setSumHome("");
              setSumAway("");
            }}
          >
            <label className="block">
              <span className="label">{home.name} points</span>
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
              <span className="label">{away.name} points</span>
              <input
                required
                type="number"
                min={0}
                value={sumAway}
                onChange={(e) => setSumAway(e.target.value)}
                className="input w-24"
              />
            </label>
            <button
              type="submit"
              disabled={busy || pre || sumHome === "" || sumAway === ""}
              className="btn btn-primary"
            >
              Record {unit.toLowerCase()}
            </button>
            <span className="text-xs text-slate-400">
              Enter each completed {unit.toLowerCase()}&apos;s final points.
            </span>
          </form>
        )
      )}

      {(state.sets?.length ?? 0) > 0 && (
        <p className="font-mono text-xs text-slate-500">
          {unit}s:{" "}
          {state.sets!.map((s, i) => (
            <span key={i} className="mr-2">
              {s.home}–{s.away}
              {s.closed ? "" : "*"}
            </span>
          ))}
        </p>
      )}
    </div>
  );
}
