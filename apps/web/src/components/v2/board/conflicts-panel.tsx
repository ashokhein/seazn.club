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
import { useMsg, usePlural } from "@/components/i18n/dict-provider";
import type { MessageKey } from "@/lib/messages";

/**
 * The count badge, plus the state that only exists because the count can lie
 * (#230 item 5).
 *
 * A failed check leaves `conflicts` at whatever the last successful one
 * returned — often nothing at all, which renders identically to a clean board.
 * So the unavailable notice has to survive `count === 0`, which is exactly
 * where the badge itself returns `null`. Ordering the early return AFTER the
 * failure check is the whole fix on this side; putting it back first hides the
 * only signal an organiser ever gets.
 */
export function ConflictsBadge({
  count,
  open,
  onToggle,
  checkFailed,
  checking,
  onRetry,
}: {
  count: number;
  open: boolean;
  onToggle: () => void;
  checkFailed: boolean;
  checking: boolean;
  onRetry: () => void;
}) {
  const plural = usePlural();
  if (count === 0 && !checkFailed) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {count > 0 && (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-label={plural("board.conflicts.badgeAria", count)}
          className="inline-flex min-h-8 items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-800 hover:bg-amber-100"
        >
          {plural("board.conflicts.badge", count)}
        </button>
      )}
      {checkFailed && <CheckUnavailable checking={checking} onRetry={onRetry} />}
    </span>
  );
}

/** "Conflict check unavailable · Check again" — one component so the toolbar
 *  and the panel cannot drift into two different ways of saying it. */
function CheckUnavailable({ checking, onRetry }: { checking: boolean; onRetry: () => void }) {
  const msg = useMsg();
  return (
    <span
      role="status"
      className="inline-flex min-h-8 flex-wrap items-center gap-1.5 rounded-full border border-slate-300 bg-slate-50 px-2.5 py-1 text-xs text-slate-600"
    >
      <span aria-hidden>⚠</span>
      <span>{msg("board.conflicts.checkFailed")}</span>
      <button
        type="button"
        onClick={onRetry}
        disabled={checking}
        className="font-semibold text-purple-700 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
      >
        {msg("board.conflicts.retryCheck")}
      </button>
    </span>
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
  checkFailed,
  checking,
  onRetryCheck,
}: {
  conflicts: BoardConflict[];
  board: BoardFixture[];
  entrantNames: Record<string, string>;
  feedLabels: Record<string, FeedLabelPair>;
  divisionNames: Record<string, string>;
  onJump: (fixtureId: string) => void;
  onClose: () => void;
  /** #230 item 5 — a list nobody could refresh is not the same as a clean one. */
  checkFailed: boolean;
  checking: boolean;
  onRetryCheck: () => void;
}) {
  const msg = useMsg();
  const conflictLabel = (code: string) => {
    const key = `board.conflict.${code}` as MessageKey;
    const label = msg(key);
    return label === key ? (CONFLICT_LABEL[code] ?? code) : label;
  };
  const conflictHelp = (code: string, detail?: string) => {
    const key = `board.conflictHelp.${code}` as MessageKey;
    const help = msg(key);
    return help === key ? (CONFLICT_HELP[code] ?? detail ?? "") : help;
  };
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
      aria-label={msg("board.conflicts.regionAria")}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
      className="fixed inset-x-0 bottom-0 z-40 max-h-[70vh] overflow-y-auto rounded-t-2xl border border-slate-200 bg-white p-4 shadow-xl outline-none sm:inset-x-auto sm:top-24 sm:right-4 sm:bottom-auto sm:w-96 sm:max-h-[70vh] sm:rounded-xl"
    >
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-800">
          {msg("board.conflicts.title", { n: conflicts.length })}
        </h3>
        <button
          type="button"
          onClick={onClose}
          aria-label={msg("board.conflicts.closeAria")}
          className="btn btn-ghost px-2 py-1 text-xs"
        >
          ✕
        </button>
      </div>
      {/* The list dates itself. Without this line an empty panel is an
          assertion ("nothing is wrong") that the app may have no evidence for. */}
      <p className="mb-2 text-[11px] text-slate-500">
        {checkFailed ? (
          <CheckUnavailable checking={checking} onRetry={onRetryCheck} />
        ) : (
          msg("board.conflicts.checkedJustNow")
        )}
      </p>
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
                {f ? cardTitle(f, entrantNames, feedLabels) : msg("board.conflicts.removedFixture")}
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
                  {conflictLabel(c.code)}
                </span>
                {conflictHelp(c.code, c.detail)}
              </p>
              {f && (
                <button
                  type="button"
                  onClick={() => onJump(c.fixture_id)}
                  className="mt-1.5 font-medium text-purple-700 hover:underline"
                >
                  {msg("board.conflicts.jump")}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
