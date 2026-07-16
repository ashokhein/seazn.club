"use client";

// Agenda density mode (v3/04 §2): chronological list grouped by kick-off
// time — the mobile default and the ≥8-division fallback. Placement targets
// per time group keep tap-to-assign working without the grid.
import type { FeedLabelPair } from "@/lib/schedule-board";
import { FixtureBlock } from "./fixture-block";
import { timeLabel } from "@/lib/day-label";
import type { BoardConflict, BoardFixture } from "./types";
import { useMsg } from "@/components/i18n/dict-provider";

export function BoardAgenda({
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
  onTogglePin,
  highlightId,
}: {
  /** This day's scheduled fixtures, any court. */
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
  onTogglePin: (f: BoardFixture) => void;
  highlightId: string | null;
}) {
  const msg = useMsg();
  const sorted = [...fixtures].sort(
    (a, b) =>
      new Date(a.scheduled_at as string).getTime() - new Date(b.scheduled_at as string).getTime(),
  );
  const groups = new Map<string, BoardFixture[]>();
  for (const f of sorted) {
    const key = timeLabel(f.scheduled_at as string);
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(f);
  }

  if (sorted.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-slate-200 px-4 py-8 text-center text-sm text-slate-500">
        {msg("board.agendaEmpty")}
      </p>
    );
  }

  return (
    <ol className="space-y-3">
      {[...groups.entries()].map(([time, group]) => (
        <li key={time}>
          <div className="mb-1 flex items-baseline gap-2">
            <h4 className="text-sm font-semibold tabular-nums text-slate-800">{time}</h4>
            {canEdit && pickedId && (
              <button
                type="button"
                onClick={() => onPlace(new Date(group[0]!.scheduled_at as string).toISOString(), null)}
                className="text-[11px] font-medium text-purple-700 hover:underline"
              >
                {msg("board.placePicked")}
              </button>
            )}
          </div>
          <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
            {group.map((f) => (
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
                  time={f.court_label ?? undefined}
                />
              </div>
            ))}
          </div>
        </li>
      ))}
    </ol>
  );
}
