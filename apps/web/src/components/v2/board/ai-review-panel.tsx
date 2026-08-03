"use client";

// W5 (#400, #388) — the shared "to review" card, rendered by both consoles.
//
// Three things a finished run knows and, until now, mostly did not say: what it
// flagged, what it could not place at all, and what it assumed while placing.
// They arrive in one card because they are one question for the organiser —
// "anything here I should look at before I apply?" — and the header number is
// `rows.length` off the very array below it, so the count cannot disagree with
// the screen (#388).
//
// Structure follows the red blocking card in `ai-diff-panel.tsx`: same
// container, same row rhythm, amber instead of red because none of this stops
// an apply. Each row opens on a one-character gutter that says which kind it is
// (⚠ flagged, ⊘ not placed, ~ assumed), and an assumption sits on a slate wash
// rather than white so an interpretive note never reads with the weight of a
// solver finding.
import { useMemo } from "react";
import { useMsg, usePlural } from "@/components/i18n/dict-provider";
import { blockingConflictCode, blockingConflictKey, type AiConsoleFixture } from "./ai-diff";
import { DivisionChip } from "./ai-division-chip";
import { reviewRowCount, reviewRowFixtureIds, type ReviewRow } from "./ai-review";
import { CONFLICT_LABEL } from "./types";

export function AiReviewPanel({
  rows,
  fixtures,
  divisionFor,
  onPulse,
}: {
  /** Built by `buildReviewRows` — the single source of both the list and the count. */
  rows: ReviewRow[];
  /** The board's current fixtures, for each row's code + matchup. */
  fixtures: AiConsoleFixture[];
  /** Joint console only. Returns null when the division is unknown — never guess. */
  divisionFor?: (fixtureId: string) => { id: string; name: string } | null;
  /** Highlight this card's fixtures on the grid. */
  onPulse?: (fixtureIds: string[]) => void;
}) {
  const msg = useMsg();
  const plural = usePlural();
  const byId = useMemo(() => new Map(fixtures.map((f) => [f.id, f])), [fixtures]);
  // Read once, from the array below. Every number this card shows is this one,
  // so the header and the list cannot disagree (#388).
  const count = reviewRowCount(rows);

  // A card with no rows is not an empty state worth drawing — a clean run has
  // nothing to review, and an empty amber box would say the opposite.
  if (count === 0) return null;

  const label = (id: string): { code: string; matchup: string; marker: string | null } => {
    const f = byId.get(id);
    return {
      code: f?.code ?? "—",
      matchup: f?.matchup ?? id.slice(0, 8),
      marker: f?.isFinal ? "FN" : f?.isJunior ? "JR" : null,
    };
  };

  // Warning rows carry the engine verifier's raw camelCase reason token; route
  // it through the shared conflict taxonomy so the primary text is a localized
  // `board.conflict.*` label and never the engine's English — the same helper
  // and the same fallback the diff panel's blocking rows use.
  const conflictLabel = (reason: string): string => {
    const code = blockingConflictCode(reason);
    const key = blockingConflictKey(reason);
    const localized = msg(key);
    return localized === key ? (CONFLICT_LABEL[code] ?? code) : localized;
  };

  const headline = (
    <>
      <span aria-hidden className="shrink-0">⚠</span>
      <span className="min-w-0">{plural("board.ai.review.count", count)}</span>
    </>
  );

  return (
    <section
      aria-label={msg("board.ai.review.title")}
      data-review-count={count}
      className="rounded-lg border border-amber-200 bg-amber-50/60 p-3"
    >
      {onPulse ? (
        <button
          type="button"
          data-review-pulse="1"
          onClick={() => onPulse(reviewRowFixtureIds(rows))}
          className="flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 rounded text-left text-[11px] font-semibold uppercase tracking-wide text-amber-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
        >
          <span className="flex min-w-0 items-center gap-1.5">{headline}</span>
          <span className="shrink-0 text-[10px] font-medium normal-case tracking-normal text-amber-700 underline decoration-dotted underline-offset-2">
            {msg("board.ai.review.pulse")}
          </span>
        </button>
      ) : (
        <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-amber-800">
          {headline}
        </p>
      )}
      <p className="mt-0.5 text-[11px] text-amber-800/80">{msg("board.ai.review.hint")}</p>

      <ul className="mt-2 space-y-1.5">
        {rows.map((row, i) => {
          if (row.kind === "assumption") {
            return (
              <li
                key={`a-${i}`}
                data-review-row="assumption"
                className="flex items-start gap-2 rounded-md border border-slate-200 bg-slate-50/70 px-2 py-1.5"
              >
                <span aria-hidden className="mt-px shrink-0 font-mono text-[11px] text-slate-400">
                  ~
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                    {msg("board.ai.review.assumption")}
                  </p>
                  <p className="text-[11px] leading-snug text-slate-600">{row.text}</p>
                </div>
              </li>
            );
          }

          const l = label(row.fixtureId);
          const division = divisionFor?.(row.fixtureId) ?? null;
          return (
            <li
              key={`${row.kind}-${row.fixtureId}-${i}`}
              data-review-row={row.kind}
              className="flex items-start gap-2 rounded-md border border-amber-200 bg-white px-2 py-1.5"
            >
              <span aria-hidden className="mt-px shrink-0 text-[10px] text-amber-500">
                {row.kind === "warning" ? "⚠" : "⊘"}
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1 text-xs">
                  <span className="shrink-0 font-mono font-semibold text-slate-700">{l.code}</span>
                  {l.marker && <Marker kind={l.marker} />}
                  {division && <DivisionChip id={division.id} name={division.name} />}
                  <span className="min-w-0 flex-1 truncate text-slate-600">{l.matchup}</span>
                  {row.kind === "unschedulable" && (
                    <span className="shrink-0 rounded bg-amber-100 px-1 font-mono text-[9px] font-bold text-amber-800">
                      {row.rule}
                    </span>
                  )}
                </p>
                {row.kind === "warning" ? (
                  <>
                    <p className="text-[11px] font-medium text-amber-700">
                      {conflictLabel(row.reason)}
                    </p>
                    {row.detail && <p className="mt-0.5 text-[10px] text-slate-500">{row.detail}</p>}
                  </>
                ) : (
                  <>
                    <p className="text-[11px] font-medium text-amber-700">{row.reason}</p>
                    {/* Say where the fixture went. Left to infer it, an organiser
                        reads "couldn't place" as "lost". */}
                    <p className="mt-0.5 text-[10px] text-slate-500">
                      {msg("board.ai.review.unschedulable")}
                    </p>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The persistent JR/Final marker, as the diff panel draws it. Duplicated here
 *  rather than imported because `ai-diff-panel.tsx` keeps it private; W5 Task 5
 *  is the place to lift it into one module if it earns a third caller. */
function Marker({ kind }: { kind: string }) {
  const isFinal = kind === "FN";
  return (
    <span
      className={`shrink-0 rounded px-1 text-[9px] font-bold leading-tight ${
        isFinal ? "bg-purple-100 text-purple-700" : "bg-sky-100 text-sky-700"
      }`}
    >
      {isFinal ? "FINAL" : "JR"}
    </span>
  );
}
