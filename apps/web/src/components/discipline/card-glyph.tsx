// SPEC-1 signature element: the referee's card. A small rounded-rect swatch
// tilted ~8° (as if held up), yellow #FBBF24 or brand red #ef4444. Purely
// decorative — the row/chip/banner text carries the meaning — so it's
// aria-hidden and never animated (prefers-reduced-motion is a non-issue: it's
// always static). No hooks, so it renders fine in server and client trees.

export type CardTone = "yellow" | "red";

const FILL: Record<CardTone, string> = {
  yellow: "#FBBF24",
  red: "#ef4444",
};

/** A card colour key ("yellow" | "second_yellow" | "red" | "game_misconduct" |
 *  "match" …) → the two-tone glyph. Anything with "yellow" reads yellow; every
 *  dismissal grade reads red. */
export function toneForColor(colorKey: string): CardTone {
  return colorKey.includes("yellow") && colorKey !== "second_yellow" ? "yellow" : "red";
}

/** Suspension source → glyph tone: accumulation bans are the yellow ledger,
 *  dismissals/manual/report are the red one. */
export function toneForSource(source: string): CardTone {
  return source === "auto_accumulation" ? "yellow" : "red";
}

export function CardGlyph({
  tone,
  className = "",
}: {
  tone: CardTone;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      data-tone={tone}
      className={`inline-block h-4 w-3 shrink-0 rotate-[8deg] rounded-[2px] shadow-sm ${className}`}
      style={{ backgroundColor: FILL[tone] }}
    />
  );
}
