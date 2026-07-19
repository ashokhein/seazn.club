"use client";

// Board density mode (v3/04 §2): courts × time grid for one day. Empty cells
// are place targets — clickable and focusable, so drag-drop, tap-to-assign
// and keyboard placement all land on the same cells (v3/11 gap 11). Falls
// back to one "Unassigned venue" column when no courts are configured.
import { dayKey } from "@/lib/schedule-board";
import type { FeedLabelPair } from "@/lib/schedule-board";
import { FixtureBlock } from "./fixture-block";
import { timeLabel } from "@/lib/day-label";
import { UNASSIGNED, type BoardConflict, type BoardFixture, type GhostBlock } from "./types";
import { useMsg } from "@/components/i18n/dict-provider";
import type { MessageKey } from "@/lib/messages";

const MIN = 60_000;

export function BoardGrid({
  day,
  slots,
  slotMinutes,
  courts,
  fixtures,
  divisionNames,
  entrantNames,
  feedLabels,
  conflictsByFixture,
  canEdit,
  multi,
  pickedId,
  onPick,
  onPlace,
  onDropCard,
  onTogglePin,
  venueCap,
  highlightId,
  ghosts,
}: {
  day: string;
  slots: number[];
  slotMinutes: number;
  /** Configured court labels; empty → single unassigned column. */
  courts: string[];
  /** Fixtures scheduled on this day (court may be null → unassigned column). */
  fixtures: BoardFixture[];
  divisionNames: Record<string, string>;
  entrantNames: Record<string, string>;
  feedLabels: Record<string, FeedLabelPair>;
  conflictsByFixture: Record<string, BoardConflict[]>;
  canEdit: boolean;
  multi: boolean;
  pickedId: string | null;
  onPick: (fixtureId: string) => void;
  onPlace: (atIso: string, court: string | null) => void;
  onDropCard: (fixtureId: string, atIso: string, court: string | null) => void;
  onTogglePin: (f: BoardFixture) => void;
  venueCap: string;
  highlightId: string | null;
  /** When set, an AI proposal is on screen: the grid swaps its live fixtures for
   *  the proposed layout as read-only ghost blocks (design §3). */
  ghosts?: GhostBlock[] | null;
}) {
  const msg = useMsg();
  const columns: (string | null)[] = courts.length > 0 ? courts : [null];
  const showGhosts = ghosts != null;

  return (
    <div className="scroll-x scroll-x-fade rounded-lg border border-slate-200 bg-white">
      <table className="w-full border-collapse text-xs" aria-label={msg("board.grid.aria", { day })}>
        <thead>
          <tr>
            <th className="w-16 border-b border-slate-200 bg-slate-50 px-2 py-2 text-left font-medium text-slate-500">
              {msg("board.grid.time")}
            </th>
            {columns.map((c) => (
              <th
                key={c ?? UNASSIGNED}
                className="min-w-36 border-b border-l border-slate-200 bg-slate-50 px-2 py-2 text-left font-medium text-slate-600"
              >
                {c ?? msg("board.grid.unassignedCol", { venue: venueCap.toLowerCase() })}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {slots.map((t) => (
            <tr key={t}>
              <td className="border-b border-slate-100 px-2 py-1 align-top text-slate-500">
                {timeLabel(t)}
              </td>
              {columns.map((court) => {
                const inSlot = (at: number) => at >= t && at < t + slotMinutes * MIN;
                const sameCol = (c: string | null) => (court === null ? c === null : c === court);
                const cell = fixtures.filter(
                  (f) => sameCol(f.court_label) && inSlot(new Date(f.scheduled_at as string).getTime()),
                );
                const cellGhosts = showGhosts
                  ? ghosts!.filter((g) => sameCol(g.court) && inSlot(g.at))
                  : [];
                const iso = new Date(t).toISOString();
                return (
                  <td
                    key={court ?? UNASSIGNED}
                    className="h-10 border-b border-l border-slate-100 px-1 py-0.5 align-top"
                    onDragOver={canEdit && !showGhosts ? (e) => e.preventDefault() : undefined}
                    onDrop={
                      canEdit && !showGhosts
                        ? (e) => {
                            e.preventDefault();
                            const fid = e.dataTransfer.getData("text/fixture");
                            if (fid) onDropCard(fid, iso, court);
                          }
                        : undefined
                    }
                  >
                    {/* AI proposal on screen: read-only ghost preview (§3). */}
                    {showGhosts
                      ? cellGhosts.map((g) => <GhostBlockView key={g.id} ghost={g} msg={msg} />)
                      : cell.map((f) => (
                          <div key={f.id} className={highlightId === f.id ? "animate-pulse" : undefined}>
                            <FixtureBlock
                              fixture={f}
                              divisionName={divisionNames[f.division_id] ?? ""}
                              showDivision={multi}
                              entrantNames={entrantNames}
                              feedLabels={feedLabels}
                              conflicts={conflictsByFixture[f.id] ?? []}
                              canEdit={canEdit}
                              picked={pickedId === f.id}
                              onPick={() => onPick(f.id)}
                              onTogglePin={() => onTogglePin(f)}
                            />
                          </div>
                        ))}
                    {!showGhosts && canEdit && cell.length === 0 && (
                      <button
                        type="button"
                        onClick={() => onPlace(iso, court)}
                        aria-label={
                          court
                            ? msg("board.grid.placeAriaCourt", { time: timeLabel(t), court })
                            : msg("board.grid.placeAriaUnassigned", { time: timeLabel(t) })
                        }
                        className={`h-full min-h-8 w-full rounded text-[10px] transition ${
                          pickedId
                            ? "border border-dashed border-purple-300 text-purple-600 hover:border-purple-500 hover:bg-purple-50 focus-visible:border-purple-500 focus-visible:bg-purple-50"
                            : "text-transparent focus-visible:border focus-visible:border-dashed focus-visible:border-purple-300 focus-visible:text-purple-600"
                        }`}
                        tabIndex={pickedId ? 0 : -1}
                        disabled={!pickedId}
                      >
                        {pickedId ? msg("board.grid.placeHere") : ""}
                      </button>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Fixtures scheduled on `day` (time set; court may be null). */
export function fixturesOn(fixtures: BoardFixture[], day: string): BoardFixture[] {
  return fixtures.filter(
    (f) => f.scheduled_at !== null && dayKey(f.scheduled_at as string) === day,
  );
}

// The state-palette styling for each ghost tone (design §1). Translucent + dashed
// throughout so a proposal never reads as committed placement.
const GHOST_TONE: Record<GhostBlock["tone"], string> = {
  moved: "border-amber-400 bg-amber-50/70 text-amber-900",
  placed: "border-teal-400 bg-teal-50/70 text-teal-900",
  blocking: "border-red-400 bg-red-50/80 text-red-900",
  unchanged: "border-slate-300 bg-slate-50/60 text-slate-500 opacity-70",
};

/** One proposal ghost: dashed + translucent, tone-coloured, ≥40px, code + JR/Final
 *  marker + matchup + time only. Provenance stays in the diff list (§3). */
function GhostBlockView({ ghost, msg }: { ghost: GhostBlock; msg: (k: MessageKey, v?: Record<string, string | number>) => string }) {
  const marker = ghost.isFinal ? "FINAL" : ghost.isJunior ? "JR" : null;
  return (
    <div
      data-ghost-id={ghost.id}
      aria-label={msg("board.ai.ghost.aria", { code: ghost.code, matchup: ghost.matchup, time: timeLabel(ghost.at) })}
      className={`mb-0.5 min-h-10 rounded border border-dashed px-1.5 py-1 text-[11px] leading-tight ${GHOST_TONE[ghost.tone]} ${
        ghost.pulse ? "animate-pulse ring-2 ring-red-400" : ""
      }`}
    >
      <div className="flex items-center gap-1">
        <span className="font-mono text-[10px] font-semibold">{ghost.code}</span>
        {marker && (
          <span
            className={`shrink-0 rounded px-1 text-[8px] font-bold leading-tight ${
              ghost.isFinal ? "bg-purple-200/70 text-purple-800" : "bg-sky-200/70 text-sky-800"
            }`}
          >
            {marker}
          </span>
        )}
        <span className="ml-auto shrink-0 tabular-nums text-[9px] opacity-80">{timeLabel(ghost.at)}</span>
      </div>
      <p className="mt-0.5 truncate font-medium">{ghost.matchup}</p>
    </div>
  );
}
