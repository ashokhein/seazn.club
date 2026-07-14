"use client";

// Numbered progress dots shared by the puzzle games (mate-in-1/2, hunts,
// tactics). Solved dots fill; the current one is ringed.
export function PuzzleDots({
  count,
  current,
  isSolved,
  onPick,
  label = "Puzzle",
}: {
  count: number;
  current: number;
  isSolved(i: number): boolean;
  onPick(i: number): void;
  label?: string;
}) {
  return (
    <div className="flex flex-wrap justify-center gap-1.5">
      {Array.from({ length: count }, (_, i) => {
        const solved = isSolved(i);
        const cur = i === current;
        return (
          <button
            key={i}
            type="button"
            aria-label={`${label} ${i + 1}`}
            onClick={() => onPick(i)}
            className={`h-6 w-6 rounded-full border text-xs font-semibold ${
              solved
                ? "border-emerald-500 bg-emerald-500 text-white"
                : "border-purple-300 bg-white text-purple-700"
            } ${cur ? "ring-2 ring-purple-500 ring-offset-1" : ""}`}
          >
            {i + 1}
          </button>
        );
      })}
    </div>
  );
}
