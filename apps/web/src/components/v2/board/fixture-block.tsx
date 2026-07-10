"use client";

// One fixture block (v3/04 §2): 3px division hue bar + short-code chip, red
// corner tick when a violation touches it, pin/lock affordance, and a single
// pick/place mechanism that serves mouse, touch and keyboard alike.
import { divisionAccent, divisionInk, divisionShortCode, divisionTint } from "@/lib/division-hue";
import type { FeedLabelPair } from "@/lib/schedule-board";
import { CONFLICT_LABEL, cardTitle, type BoardConflict, type BoardFixture } from "./types";

export function FixtureBlock({
  fixture,
  divisionName,
  showDivision,
  entrantNames,
  feedLabels,
  conflicts,
  canEdit,
  picked,
  onPick,
  onTogglePin,
  time,
}: {
  fixture: BoardFixture;
  divisionName: string;
  /** Chip renders only on multi-division boards. */
  showDivision: boolean;
  entrantNames: Record<string, string>;
  feedLabels: Record<string, FeedLabelPair>;
  conflicts: BoardConflict[];
  canEdit: boolean;
  /** This block is the current pick (tap-to-assign source). */
  picked: boolean;
  onPick: () => void;
  onTogglePin: () => void;
  /** Optional time caption (agenda/tray contexts). */
  time?: string;
}) {
  const movable = canEdit && fixture.status === "scheduled";
  const blocking = conflicts.some((c) => c.blocking);
  const title = cardTitle(fixture, entrantNames, feedLabels);
  return (
    <div
      data-fixture-id={fixture.id}
      draggable={movable}
      onDragStart={(e) => e.dataTransfer.setData("text/fixture", fixture.id)}
      className={`group relative mb-0.5 rounded border px-1.5 py-1 text-[11px] leading-tight ${
        blocking
          ? "border-red-300 bg-red-50"
          : conflicts.length > 0
            ? "border-amber-300 bg-amber-50"
            : "border-slate-200 bg-white"
      } ${picked ? "ring-2 ring-purple-500" : ""} ${movable ? "cursor-grab" : "opacity-80"}`}
      style={{ borderLeftWidth: 3, borderLeftColor: divisionAccent(fixture.division_id) }}
    >
      {conflicts.length > 0 && (
        <span
          aria-hidden
          className={`absolute -top-px -right-px h-0 w-0 rounded-tr border-t-8 border-l-8 border-l-transparent ${
            blocking ? "border-t-red-500" : "border-t-amber-500"
          }`}
        />
      )}
      <div className="flex items-center gap-1">
        {/* A decided fixture is done — no scheduling handle. It comes back the
            moment the result is undone (status returns to 'scheduled'). */}
        {movable ? (
          <button
            type="button"
            onClick={onPick}
            aria-pressed={picked}
            aria-label={`${title} — round ${fixture.round_no}. ${
              picked ? "Picked — choose a slot, or press Escape to cancel" : "Pick to move"
            }`}
            className="min-w-0 flex-1 truncate text-left font-medium text-slate-700 hover:text-purple-700"
          >
            {title}
          </button>
        ) : (
          <span className="min-w-0 flex-1 truncate text-left font-medium text-slate-600">
            {title}
          </span>
        )}
        {canEdit && fixture.status === "scheduled" && (
          <button
            type="button"
            onClick={onTogglePin}
            aria-label={fixture.schedule_locked ? "Unlock (allow re-flow)" : "Pin/lock this slot"}
            title={fixture.schedule_locked ? "Locked — survives re-flow" : "Pin this slot"}
            className={fixture.schedule_locked ? "" : "opacity-30 group-hover:opacity-100"}
          >
            {fixture.schedule_locked ? "🔒" : "📌"}
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1 text-[10px] text-slate-500">
        {showDivision && (
          <span
            title={divisionName}
            data-division-chip={divisionShortCode(divisionName)}
            className="rounded px-1 font-semibold"
            style={{
              backgroundColor: divisionTint(fixture.division_id),
              color: divisionInk(fixture.division_id),
            }}
          >
            {divisionShortCode(divisionName)}
          </span>
        )}
        {time && <span>{time}</span>}
        <span>R{fixture.round_no}</span>
        {fixture.status !== "scheduled" && <span className="text-sky-600">{fixture.status}</span>}
        {conflicts.map((c, i) => (
          <span
            key={i}
            title={c.detail}
            className={`rounded px-1 ${c.blocking ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"}`}
          >
            {CONFLICT_LABEL[c.code] ?? c.code}
          </span>
        ))}
      </div>
    </div>
  );
}
