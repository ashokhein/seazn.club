"use client";

// Extracted verbatim from `ai-competition-console.tsx` (W5 #400) so the shared
// review panel can wear the same chip the joint console does. Pure move: no
// behaviour change, no restyle. `ai-competition-console.test.tsx` passing
// unchanged is the proof.
import { divisionInk, divisionTint } from "@/lib/division-hue";

/** The division's own tint, the same one its cards wear on the board. This is
 *  the ledger's spine: picker order, receipt order, review order, one colour. */
export function DivisionChip({ id, name }: { id: string; name: string }) {
  return (
    <span
      data-division-chip
      title={name}
      // `min-w-0 truncate` and a ceiling, exactly as the ghost chip on the grid
      // has (board-grid.tsx). Without them a long division name pushes the rest
      // of the row out of a 27rem dock.
      className="min-w-0 max-w-[9rem] shrink truncate rounded px-1.5 py-0.5 text-[10px] font-semibold"
      style={{ backgroundColor: divisionTint(id), color: divisionInk(id) }}
    >
      {name}
    </span>
  );
}
