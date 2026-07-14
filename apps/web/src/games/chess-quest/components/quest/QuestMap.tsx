"use client";

// Quest map — Track 1/2 sections, lands, day-numbered stops. Port of
// js/app.js renderMap (78–126). ✓ = done, ♞ = current stop, else the day.
import { LANDS } from "../../content/lands";
import { LESSONS } from "../../content/lessons";
import { useProgress } from "../../lib/progress";
import { dayOf } from "./questData";

export function QuestMap({
  selected,
  onSelect,
}: {
  selected: number;
  onSelect(n: number): void;
}) {
  const progress = useProgress();
  const current = progress.currentWeek(LESSONS.length);

  return (
    <div className="flex flex-col gap-4">
      {LANDS.map((land, idx) => {
        const track = land.track ?? 1;
        const prevTrack = idx > 0 ? (LANDS[idx - 1].track ?? 1) : 0;
        const showTrackHead = track !== prevTrack;
        const won = progress.landDone(land);
        return (
          <div key={land.id} className="flex flex-col gap-2">
            {showTrackHead ? (
              <div className="mt-1 flex items-baseline gap-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-purple-400">
                  Track {track}
                </span>
                <span className="mk-display text-sm font-bold text-purple-900">
                  {track === 1 ? "First Steps" : track === 2 ? "Rising Player" : "Opening Range"}
                </span>
              </div>
            ) : null}

            <div className="rounded-2xl border border-slate-200 bg-white p-3">
              <div className="flex items-center gap-2">
                <span className="text-xl">{land.glyph}</span>
                <div className="flex flex-col leading-tight">
                  <span className="text-xs text-slate-400">
                    Days {dayOf(land.weeks[0])}–{dayOf(land.weeks[1])}
                  </span>
                  <span className="mk-display text-sm font-bold text-purple-950">{land.name}</span>
                </div>
                <span
                  title={won ? "Badge earned!" : "Finish every day here to earn the badge"}
                  className={`ml-auto text-lg ${won ? "" : "opacity-30 grayscale"}`}
                >
                  {land.glyph}
                </span>
              </div>

              <div className="mt-2 flex flex-wrap gap-1.5">
                {Array.from(
                  { length: land.weeks[1] - land.weeks[0] + 1 },
                  (_, k) => land.weeks[0] + k,
                ).map((n) => {
                  const isDone = progress.isWeekDone(n);
                  const isCur = n === current && !isDone;
                  const isSel = n === selected;
                  return (
                    <button
                      key={n}
                      type="button"
                      aria-label={`Day ${dayOf(n)}: ${LESSONS[n - 1].title}`}
                      onClick={() => onSelect(n)}
                      className={`h-9 min-w-9 rounded-lg border px-1 text-sm font-semibold transition ${
                        isDone
                          ? "border-emerald-500 bg-emerald-500 text-white"
                          : isCur
                            ? "border-purple-500 bg-purple-100 text-purple-800"
                            : "border-slate-200 bg-white text-slate-600"
                      } ${isSel ? "ring-2 ring-purple-500 ring-offset-1" : ""}`}
                    >
                      {isDone ? "✓" : isCur ? "♞" : dayOf(n)}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
