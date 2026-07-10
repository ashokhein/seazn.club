"use client";

// Unscheduled tray (v3/04 §2): docked right on desktop, bottom sheet on
// mobile. Grouped per division with count pills. Drag a block onto the grid,
// or use pick-then-place: tap/Enter a fixture here, tap/Enter a slot on the
// board — the same mechanism serves touch and keyboard (v3/11 gap 11).
import { useState } from "react";
import type { FeedLabelPair } from "@/lib/schedule-board";
import { FixtureBlock } from "./fixture-block";
import type { BoardConflict, BoardDivision, BoardFixture } from "./types";

export function BoardTray({
  unscheduled,
  divisions,
  entrantNames,
  feedLabels,
  conflictsByFixture,
  canEdit,
  pickedId,
  onPick,
  onTogglePin,
}: {
  unscheduled: BoardFixture[];
  divisions: BoardDivision[];
  entrantNames: Record<string, string>;
  feedLabels: Record<string, FeedLabelPair>;
  conflictsByFixture: Record<string, BoardConflict[]>;
  canEdit: boolean;
  pickedId: string | null;
  onPick: (fixtureId: string) => void;
  onTogglePin: (f: BoardFixture) => void;
}) {
  const [openMobile, setOpenMobile] = useState(false);
  if (unscheduled.length === 0) return null;

  const groups = divisions
    .map((d) => ({
      division: d,
      fixtures: unscheduled.filter((f) => f.division_id === d.id),
    }))
    .filter((g) => g.fixtures.length > 0);
  const multi = divisions.length > 1;

  const body = (
    <div className="space-y-3">
      {groups.map(({ division, fixtures }) => (
        <section key={division.id} aria-label={`Unscheduled — ${division.name}`}>
          {multi && (
            <h5 className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold text-slate-600">
              {division.name}
              <span className="rounded-full bg-slate-100 px-1.5 text-[10px] font-medium text-slate-600">
                {fixtures.length}
              </span>
            </h5>
          )}
          <div className="space-y-1">
            {fixtures.map((f) => (
              <FixtureBlock
                key={f.id}
                fixture={f}
                divisionName={division.name}
                showDivision={multi}
                entrantNames={entrantNames}
                feedLabels={feedLabels}
                conflicts={conflictsByFixture[f.id] ?? []}
                canEdit={canEdit}
                picked={pickedId === f.id}
                onPick={() => onPick(f.id)}
                onTogglePin={() => onTogglePin(f)}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );

  const hint = canEdit
    ? "Drag onto the board, or pick a match then pick a slot."
    : "View-only on your plan.";

  return (
    <>
      {/* Desktop: right dock */}
      <aside
        className="hidden w-64 shrink-0 self-start rounded-xl border border-slate-200 bg-slate-50/60 p-3 lg:sticky lg:top-20 lg:block"
        aria-label="Unscheduled fixtures"
      >
        <h4 className="mb-1 text-xs font-semibold text-slate-700">
          Unscheduled ({unscheduled.length})
        </h4>
        <p className="mb-2 text-[11px] text-slate-500">{hint}</p>
        <div className="max-h-[60vh] overflow-y-auto pr-1">{body}</div>
      </aside>

      {/* Mobile: bottom sheet */}
      <div className="lg:hidden">
        <button
          type="button"
          onClick={() => setOpenMobile((o) => !o)}
          aria-expanded={openMobile}
          className="fixed inset-x-3 bottom-3 z-30 flex min-h-11 items-center justify-between rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-800 shadow-lg"
        >
          <span>
            Unscheduled
            <span className="ml-2 rounded-full bg-purple-100 px-2 py-0.5 text-xs font-semibold text-purple-800">
              {unscheduled.length}
            </span>
          </span>
          <span aria-hidden>{openMobile ? "▾" : "▴"}</span>
        </button>
        {openMobile && (
          <div
            role="region"
            aria-label="Unscheduled fixtures"
            className="fixed inset-x-0 bottom-16 z-30 max-h-[50vh] overflow-y-auto rounded-t-2xl border border-slate-200 bg-white p-4 shadow-xl"
          >
            <div className="sheet-handle" aria-hidden />
            <p className="mb-2 text-[11px] text-slate-500">
              {canEdit ? "Tap a match, then tap a slot on the board." : hint}
            </p>
            {body}
          </div>
        )}
      </div>
    </>
  );
}
