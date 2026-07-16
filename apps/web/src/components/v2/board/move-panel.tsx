"use client";

// Precise move for the picked fixture: pick court + exact time, hit Move.
// The keyboard-accessible alternative to dragging since PROMPT-17; in v3 it
// rides the same pick state as tap-to-assign (v3/11 gap 11).
import { useState } from "react";
import { toLocalInput, type FeedLabelPair } from "@/lib/schedule-board";
import { cardTitle, type BoardFixture } from "./types";
import { useMsg } from "@/components/i18n/dict-provider";

export function MovePanel({
  fixture,
  courts,
  venueCap = "Court",
  entrantNames,
  feedLabels,
  onMove,
  onClose,
}: {
  fixture: BoardFixture;
  courts: string[];
  venueCap?: string;
  entrantNames: Record<string, string>;
  feedLabels: Record<string, FeedLabelPair>;
  onMove: (atIso: string | null, court: string | null) => void;
  onClose: () => void;
}) {
  const msg = useMsg();
  const [when, setWhen] = useState(
    fixture.scheduled_at ? toLocalInput(fixture.scheduled_at) : "",
  );
  const [court, setCourt] = useState(fixture.court_label ?? courts[0] ?? "");
  return (
    <div
      role="dialog"
      aria-label={msg("board.moveAria", { title: cardTitle(fixture, entrantNames, feedLabels) })}
      className="flex flex-wrap items-end gap-2 rounded-lg border border-purple-200 bg-purple-50 p-3"
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <p className="w-full text-xs font-medium text-purple-800">
        {msg("board.moveLabel", { title: cardTitle(fixture, entrantNames, feedLabels) })}
        <span className="ml-2 font-normal text-purple-700">
          {msg("board.moveHint")}
        </span>
      </p>
      <label className="block">
        <span className="label">{msg("board.when")}</span>
        <input
          type="datetime-local"
          value={when}
          onChange={(e) => setWhen(e.target.value)}
          className="input px-2 py-1 text-xs"
        />
      </label>
      <label className="block">
        <span className="label">{venueCap}</span>
        <select value={court} onChange={(e) => setCourt(e.target.value)} className="input px-2 py-1 text-xs">
          {courts.length === 0 && <option value="">{msg("board.unassigned")}</option>}
          {courts.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </label>
      <button
        type="button"
        onClick={() => onMove(when ? new Date(when).toISOString() : null, court || null)}
        className="btn btn-primary px-3 py-1.5 text-xs"
      >
        {msg("board.move")}
      </button>
      <button type="button" onClick={onClose} className="btn btn-ghost px-3 py-1.5 text-xs">
        {msg("board.cancel")}
      </button>
    </div>
  );
}
