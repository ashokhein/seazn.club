"use client";

// The persistent JR/FINAL marker (design/v4/02 §3) — independent of diff colour.
//
// Lifted here in W5 (#400) from `ai-diff-panel.tsx`, where the review panel had
// copied it byte-for-byte. Two copies of a badge is how a board ends up with a
// purple FINAL on the diff and a slate one on the review card; the fixture's
// stage is the same fact on every surface, so it gets one rendering.
//
// `shrink-0` is load-bearing: the marker always sits next to a truncating
// matchup, and at 375px a long name will otherwise squeeze "FINAL" to nothing.

/** `kind` is the board's own shorthand: `"FN"` for a final, anything else JR. */
export function Marker({ kind }: { kind: string }) {
  const isFinal = kind === "FN";
  return (
    <span
      className={`shrink-0 rounded px-1 text-[9px] font-bold leading-tight ${
        isFinal ? "bg-purple-100 text-purple-700" : "bg-sky-100 text-sky-700"
      }`}
    >
      {isFinal ? "FINAL" : "JR"}
    </span>
  );
}
