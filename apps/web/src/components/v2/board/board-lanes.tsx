"use client";

// By-division density mode (v3/04 §2): one collapsible swimlane per division
// — the pre-v3 mental model, kept for organisers who want it.
import { useState } from "react";
import { divisionAccent } from "@/lib/division-hue";
import type { FeedLabelPair } from "@/lib/schedule-board";
import { FixtureBlock } from "./fixture-block";
import { timeLabel } from "@/lib/day-label";
import type { BoardConflict, BoardDivision, BoardFixture } from "./types";
import { useMsg } from "@/components/i18n/dict-provider";

export function BoardLanes({
  day,
  divisions,
  fixtures,
  entrantNames,
  feedLabels,
  conflictsByFixture,
  canEdit,
  pickedId,
  onPick,
  onTogglePin,
  highlightId,
}: {
  day: string;
  divisions: BoardDivision[];
  /** This day's scheduled fixtures, any court. */
  fixtures: BoardFixture[];
  entrantNames: Record<string, string>;
  feedLabels: Record<string, FeedLabelPair>;
  conflictsByFixture: Record<string, BoardConflict[]>;
  canEdit: boolean;
  pickedId: string | null;
  onPick: (fixtureId: string) => void;
  onTogglePin: (f: BoardFixture) => void;
  highlightId: string | null;
}) {
  const msg = useMsg();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  return (
    <div className="space-y-3">
      {divisions.map((d) => {
        const lane = fixtures
          .filter((f) => f.division_id === d.id)
          .sort(
            (a, b) =>
              new Date(a.scheduled_at as string).getTime() -
              new Date(b.scheduled_at as string).getTime(),
          );
        const isCollapsed = collapsed[d.id] ?? false;
        return (
          <section
            key={d.id}
            className="rounded-xl border border-slate-200 bg-white"
            style={{ borderLeftWidth: 3, borderLeftColor: divisionAccent(d.id) }}
            aria-label={msg("board.laneAria", { name: d.name })}
          >
            <button
              type="button"
              onClick={() => setCollapsed((c) => ({ ...c, [d.id]: !isCollapsed }))}
              aria-expanded={!isCollapsed}
              className="flex min-h-10 w-full items-center justify-between px-3 py-2 text-left"
            >
              <span className="text-sm font-semibold text-slate-800">{d.name}</span>
              <span className="text-xs text-slate-500">
                {msg("board.laneCount", { n: lane.length, day })} {isCollapsed ? "▸" : "▾"}
              </span>
            </button>
            {!isCollapsed && (
              <div className="grid gap-1 px-3 pb-3 sm:grid-cols-2 lg:grid-cols-4">
                {lane.length === 0 && (
                  <p className="text-xs text-slate-500">{msg("board.laneEmpty")}</p>
                )}
                {lane.map((f) => (
                  <div key={f.id} className={highlightId === f.id ? "animate-pulse" : undefined}>
                    <FixtureBlock
                      fixture={f}
                      divisionName={d.name}
                      showDivision={false}
                      entrantNames={entrantNames}
                      feedLabels={feedLabels}
                      conflicts={conflictsByFixture[f.id] ?? []}
                      canEdit={canEdit}
                      picked={pickedId === f.id}
                      onPick={() => onPick(f.id)}
                      onTogglePin={() => onTogglePin(f)}
                      time={`${timeLabel(f.scheduled_at as string)}${f.court_label ? ` · ${f.court_label}` : ""}`}
                    />
                  </div>
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
