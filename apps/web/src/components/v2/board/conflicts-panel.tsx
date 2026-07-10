"use client";

// Conflicts surfaced, not buried (v3/04 §2): a badge count in the board
// header opens this side panel — every violation listed in plain English
// with a jump-to-fixture link. Blocks carry a red corner tick separately.
import { useEffect, useRef } from "react";
import type { FeedLabelPair } from "@/lib/schedule-board";
import {
  CONFLICT_HELP,
  CONFLICT_LABEL,
  cardTitle,
  type BoardConflict,
  type BoardFixture,
} from "./types";

export function ConflictsBadge({
  count,
  open,
  onToggle,
}: {
  count: number;
  open: boolean;
  onToggle: () => void;
}) {
  if (count === 0) return null;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={`${count} schedule conflict${count === 1 ? "" : "s"} — open the list`}
      className="inline-flex min-h-8 items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-800 hover:bg-amber-100"
    >
      ⚠ {count} conflict{count === 1 ? "" : "s"}
    </button>
  );
}

export function ConflictsPanel({
  conflicts,
  board,
  entrantNames,
  feedLabels,
  divisionNames,
  onJump,
  onClose,
}: {
  conflicts: BoardConflict[];
  board: BoardFixture[];
  entrantNames: Record<string, string>;
  feedLabels: Record<string, FeedLabelPair>;
  divisionNames: Record<string, string>;
  onJump: (fixtureId: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const byId = new Map(board.map((f) => [f.id, f]));
  return (
    <aside
      ref={ref as React.RefObject<HTMLElement>}
      tabIndex={-1}
      role="region"
      aria-label="Schedule conflicts"
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
      className="fixed inset-x-0 bottom-0 z-40 max-h-[70vh] overflow-y-auto rounded-t-2xl border border-slate-200 bg-white p-4 shadow-xl outline-none sm:inset-x-auto sm:top-24 sm:right-4 sm:bottom-auto sm:w-96 sm:max-h-[70vh] sm:rounded-xl"
    >
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-800">
          Conflicts ({conflicts.length})
        </h3>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close conflicts panel"
          className="btn btn-ghost px-2 py-1 text-xs"
        >
          ✕
        </button>
      </div>
      <ul className="space-y-2">
        {conflicts.map((c, i) => {
          const f = byId.get(c.fixture_id);
          return (
            <li
              key={`${c.fixture_id}-${c.code}-${i}`}
              className={`rounded-lg border p-2.5 text-xs ${
                c.blocking ? "border-red-200 bg-red-50/60" : "border-amber-200 bg-amber-50/60"
              }`}
            >
              <p className="font-medium text-slate-800">
                {f ? cardTitle(f, entrantNames, feedLabels) : "Removed fixture"}
                {f && divisionNames[f.division_id] ? (
                  <span className="ml-1 font-normal text-slate-500">
                    · {divisionNames[f.division_id]}
                  </span>
                ) : null}
              </p>
              <p className="mt-0.5 text-slate-600">
                <span
                  className={`mr-1 rounded px-1 font-semibold ${
                    c.blocking ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-800"
                  }`}
                >
                  {CONFLICT_LABEL[c.code] ?? c.code}
                </span>
                {CONFLICT_HELP[c.code] ?? c.detail ?? ""}
              </p>
              {f && (
                <button
                  type="button"
                  onClick={() => onJump(c.fixture_id)}
                  className="mt-1.5 font-medium text-purple-700 hover:underline"
                >
                  Jump to fixture →
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
