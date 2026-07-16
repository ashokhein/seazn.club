"use client";

// Board density mode (v3/04 §2): courts × time grid for one day. Empty cells
// are place targets — clickable and focusable, so drag-drop, tap-to-assign
// and keyboard placement all land on the same cells (v3/11 gap 11). Falls
// back to one "Unassigned venue" column when no courts are configured.
import { dayKey } from "@/lib/schedule-board";
import type { FeedLabelPair } from "@/lib/schedule-board";
import { FixtureBlock } from "./fixture-block";
import { timeLabel } from "@/lib/day-label";
import { UNASSIGNED, type BoardConflict, type BoardFixture } from "./types";
import { useMsg } from "@/components/i18n/dict-provider";

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
}) {
  const msg = useMsg();
  const columns: (string | null)[] = courts.length > 0 ? courts : [null];

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
                const cell = fixtures.filter((f) => {
                  const at = new Date(f.scheduled_at as string).getTime();
                  const sameCourt = court === null ? f.court_label === null : f.court_label === court;
                  return sameCourt && at >= t && at < t + slotMinutes * MIN;
                });
                const iso = new Date(t).toISOString();
                return (
                  <td
                    key={court ?? UNASSIGNED}
                    className="h-10 border-b border-l border-slate-100 px-1 py-0.5 align-top"
                    onDragOver={canEdit ? (e) => e.preventDefault() : undefined}
                    onDrop={
                      canEdit
                        ? (e) => {
                            e.preventDefault();
                            const fid = e.dataTransfer.getData("text/fixture");
                            if (fid) onDropCard(fid, iso, court);
                          }
                        : undefined
                    }
                  >
                    {cell.map((f) => (
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
                    {canEdit && cell.length === 0 && (
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
