"use client";

// Repair nudge banner (v4 Task 16). A passive re-entry loop: the board derives
// disruptions client-side (use-disruption-signals) and, when any exist, surfaces
// this amber banner above the grid. Its CTA deep-links into the AI console pre-
// armed in repair mode + the disrupted scope. The board owns visibility (hidden
// for free orgs, while the console is open, and when nothing is disrupted) and
// fires the once-per-load "shown" event; this component owns the click.
//
// Tone follows the board's existing warning styling (border-amber-200 /
// bg-amber-50, the ⚠ glyph) — the same language as the console's stale-board
// alert. The one nod to where the CTA goes is the ✦ sparkle on the button.
import { track, EVENTS } from "@/lib/analytics";
import { useMsg, usePlural } from "@/components/i18n/dict-provider";

export function AiRepairBanner({
  count,
  divisionId,
  onFix,
}: {
  /** Disrupted fixture count — drives the plural headline. */
  count: number;
  /** For the click event's funnel dimension. */
  divisionId: string;
  /** Open the console in repair mode with the disrupted scope (board-owned). */
  onFix: () => void;
}) {
  const msg = useMsg();
  const plural = usePlural();

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5">
      <span
        aria-hidden
        className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-amber-100 text-sm text-amber-700"
      >
        ⚠
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-amber-900">
          {plural("board.ai.repair.title", count)}
        </p>
        <p className="text-xs text-amber-700">{msg("board.ai.repair.body")}</p>
      </div>
      <button
        type="button"
        onClick={() => {
          track(EVENTS.AI_REPAIR_NUDGE_CLICKED, { division_id: divisionId, count });
          onFix();
        }}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-amber-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-amber-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500"
      >
        <span aria-hidden>✦</span>
        {msg("board.ai.repair.cta")}
      </button>
    </div>
  );
}
