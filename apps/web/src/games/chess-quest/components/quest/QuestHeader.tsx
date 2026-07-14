"use client";

// Quest header HUD — title, player + progress buttons, star total, days
// progress bar, land badges. Port of js/app.js renderHeader (45–75).
import { LANDS } from "../../content/lands";
import { LESSONS } from "../../content/lessons";
import { useCopy } from "../../lib/copy";
import { useProgress } from "../../lib/progress";

export function QuestHeader({
  onOpenProfiles,
  onOpenProgress,
}: {
  onOpenProfiles(): void;
  onOpenProgress(): void;
}) {
  const progress = useProgress();
  const { t, isStory } = useCopy();
  const name = progress.getName();
  const done = progress.weeksDone();
  const pct = (done / LESSONS.length) * 100;

  return (
    <header className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="mk-display text-2xl font-bold text-purple-950">
          {name ? `${name}'s ` : ""}Chess Quest <span aria-hidden>♞</span>
        </h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onOpenProfiles}
            className="rounded-full border border-purple-300 bg-white px-3 py-1 text-sm font-medium text-purple-800 hover:bg-purple-50"
          >
            👥 {name || "Players"}{" "}
            <span className="ml-1 rounded-full bg-purple-100 px-1.5 py-0.5 text-xs text-purple-700">
              {isStory() ? "Story" : "Classic"}
            </span>
          </button>
          <button
            type="button"
            onClick={onOpenProgress}
            className="rounded-full border border-purple-300 bg-white px-3 py-1 text-sm font-medium text-purple-800 hover:bg-purple-50"
          >
            📊 Progress
          </button>
        </div>
      </div>

      <p className="max-w-2xl text-sm text-slate-600">
        {t(
          "One small lesson every other day — Day 1, Day 3, Day 5… — from first square to first tournament, with real games to play right here.",
          "One focused lesson every other day — Day 1, Day 3, Day 5… — from the empty board to confident club play, with drills to play right here.",
        )}
      </p>

      <div className="flex flex-wrap items-center gap-4">
        <span className="text-sm font-semibold text-amber-600">⭐ {progress.totalStars()}</span>
        <div className="min-w-48 flex-1">
          <div className="flex justify-between text-xs text-slate-500">
            <span>Quest progress</span>
            <span>
              {done} / {LESSONS.length} days
            </span>
          </div>
          <div className="mt-1 h-2 overflow-hidden rounded-full bg-purple-100">
            <div className="h-full rounded-full bg-purple-500" style={{ width: `${pct}%` }} />
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {LANDS.map((land) => {
          const won = progress.landDone(land);
          return (
            <span
              key={land.id}
              title={`${land.name}${won ? " — complete!" : ""}`}
              className={`flex h-8 w-8 items-center justify-center rounded-full border text-lg ${
                won
                  ? "border-emerald-500 bg-emerald-50"
                  : "border-slate-200 bg-slate-50 opacity-50"
              }`}
            >
              {land.glyph}
            </span>
          );
        })}
      </div>
    </header>
  );
}
