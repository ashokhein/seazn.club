"use client";

// Phase A placeholder — proves the registry → player-map → lazy-load path.
// Phase C replaces this with the real Chess Quest root component.
export default function ChessQuest() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <div className="text-6xl">♟️</div>
      <h2 className="mk-display text-2xl font-bold text-purple-950">Chess Quest</h2>
      <p className="max-w-sm text-sm text-slate-500">
        The quest is being prepared. Check back soon!
      </p>
    </div>
  );
}
