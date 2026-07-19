"use client";

// Result of a verified Phase-A run (v4 Task 13, design/v4/02 §3/§5/§6): the
// summary the model owns ("it named the cost, not just the win"), a mono usage
// row, the optional officials-coverage preview, then the "why it did that" diff
// — moved / placed / unscheduled grouped with from→to provenance (which lives
// here, never on the grid block). Blocking rows keep a per-row untick: unticking
// a blocker drops it to the tray in the accept payload so the rest can apply.
import { useMemo } from "react";
import { timeLabel } from "@/lib/day-label";
import { useMsg, usePlural } from "@/components/i18n/dict-provider";
import type { MessageKey } from "@/lib/messages";
import type { AiPlanResponse } from "@/server/api-v1/schemas";
import { computeAiDiff, type AiConsoleFixture, type AiDiffSlot } from "./ai-diff";

export function AiDiffPanel({
  plan,
  fixtures,
  excluded,
  onToggleExclude,
}: {
  plan: AiPlanResponse;
  /** The board's current fixtures (before the proposal) — powers the provenance. */
  fixtures: AiConsoleFixture[];
  /** Blocking fixtures the organiser has unticked (drop to tray on accept). */
  excluded: string[];
  onToggleExclude: (fixtureId: string) => void;
}) {
  const msg = useMsg();
  const plural = usePlural();
  const byId = useMemo(() => new Map(fixtures.map((f) => [f.id, f])), [fixtures]);
  const diff = useMemo(() => computeAiDiff(plan, fixtures), [plan, fixtures]);
  const notes = useMemo(
    () => new Map(plan.explanations.map((e) => [e.fixture_id, e.note])),
    [plan.explanations],
  );
  const cov = plan.officials_coverage;

  const slot = (s: AiDiffSlot | { scheduled_at: string; court_label: string | null }): string => {
    const time = timeLabel(s.scheduled_at);
    return s.court_label ? `${s.court_label} · ${time}` : time;
  };
  const label = (id: string): { code: string; matchup: string; marker: string | null } => {
    const f = byId.get(id);
    return {
      code: f?.code ?? "—",
      matchup: f?.matchup ?? id.slice(0, 8),
      marker: f?.isFinal ? "FN" : f?.isJunior ? "JR" : null,
    };
  };

  const usage: { k: MessageKey; v: string }[] = [
    { k: "board.ai.usage.in", v: plan.usage.input_tokens.toLocaleString() },
    { k: "board.ai.usage.out", v: plan.usage.output_tokens.toLocaleString() },
    { k: "board.ai.usage.repairs", v: String(plan.usage.repair_rounds) },
    { k: "board.ai.usage.blocking", v: String(plan.blocking.length) },
  ];

  return (
    <div className="space-y-3">
      {/* Summary — the model owning the trade-off; never clamped (§5). */}
      <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-3">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          {msg("board.ai.summaryLabel")}
        </p>
        <p className="mt-1 text-sm leading-relaxed text-slate-700">{plan.summary}</p>
        <div className="mt-2 flex flex-wrap gap-1">
          {usage.map((u) => (
            <span
              key={u.k}
              className="inline-flex items-center gap-1 rounded bg-white px-1.5 py-0.5 font-mono text-[10px] text-slate-500 ring-1 ring-inset ring-slate-200"
            >
              <span className="text-slate-400">{msg(u.k)}</span>
              <span className="font-semibold text-slate-700">{u.v}</span>
            </span>
          ))}
        </div>
      </div>

      {/* Officials coverage preview — only when a policy was sent (§2). */}
      {cov && <CoverageStrip fillable={cov.fillable} total={cov.total} unfilled={cov.unfilled.length} />}

      {/* Blocking — Accept is gated on these; untick to drop each to the tray. */}
      {plan.blocking.length > 0 && (
        <div className="rounded-lg border border-red-200 bg-red-50/60 p-3">
          <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-red-700">
            <span aria-hidden>⚑</span>
            {msg("board.ai.blocking", { n: plan.blocking.length })}
          </p>
          <p className="mt-0.5 text-[11px] text-red-700/80">{msg("board.ai.diff.blockingHint")}</p>
          <ul className="mt-2 space-y-1.5">
            {plan.blocking.map((c, i) => {
              const l = label(c.fixtureId);
              const isExcluded = excluded.includes(c.fixtureId);
              return (
                <li
                  key={`${c.fixtureId}-${i}`}
                  className="flex items-start gap-2 rounded-md border border-red-200 bg-white px-2 py-1.5"
                >
                  <label className="mt-0.5 inline-flex cursor-pointer items-center">
                    <input
                      type="checkbox"
                      className="peer sr-only"
                      checked={!isExcluded}
                      onChange={() => onToggleExclude(c.fixtureId)}
                      aria-label={msg("board.ai.diff.keepAria", { code: l.code })}
                    />
                    <span
                      aria-hidden
                      className="grid h-4 w-4 place-items-center rounded border border-red-300 text-[10px] text-white transition peer-checked:border-red-500 peer-checked:bg-red-500 peer-focus-visible:ring-2 peer-focus-visible:ring-red-300"
                    >
                      ✓
                    </span>
                  </label>
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1 text-xs">
                      <span className="font-mono font-semibold text-slate-700">{l.code}</span>
                      {l.marker && <Marker kind={l.marker} />}
                      <span className="min-w-0 truncate text-slate-600">{l.matchup}</span>
                    </p>
                    <p className="text-[11px] text-red-600">{c.detail || c.reason}</p>
                    {isExcluded && (
                      <p className="text-[10px] font-medium text-slate-500">
                        {msg("board.ai.diff.toTray")}
                      </p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Why it did that — the change list, colour-coded, provenance in words. */}
      <div className="rounded-lg border border-slate-200 bg-white p-3">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          {msg("board.ai.diff.title")}
        </p>

        <DiffGroup
          tone="moved"
          count={diff.moved.length}
          title={plural("board.ai.diff.movedGroup", diff.moved.length)}
        >
          {diff.moved.map((m) => {
            const l = label(m.fixture_id);
            return (
              <DiffRow key={m.fixture_id} code={l.code} matchup={l.matchup} marker={l.marker} note={notes.get(m.fixture_id)}>
                <span className="text-slate-400 line-through">{slot(m.from)}</span>
                <span aria-hidden className="text-amber-600">→</span>
                <span className="font-medium text-amber-700">{slot(m.to)}</span>
              </DiffRow>
            );
          })}
        </DiffGroup>

        <DiffGroup
          tone="placed"
          count={diff.placed.length}
          title={plural("board.ai.diff.placedGroup", diff.placed.length)}
        >
          {diff.placed.map((p) => {
            const l = label(p.fixture_id);
            return (
              <DiffRow key={p.fixture_id} code={l.code} matchup={l.matchup} marker={l.marker} note={notes.get(p.fixture_id)}>
                <span className="font-medium text-teal-700">{slot(p.to)}</span>
              </DiffRow>
            );
          })}
        </DiffGroup>

        <DiffGroup
          tone="unscheduled"
          count={diff.unscheduled.length}
          title={plural("board.ai.diff.unscheduledGroup", diff.unscheduled.length)}
        >
          {diff.unscheduled.map((u) => {
            const l = label(u.fixture_id);
            return (
              <DiffRow key={u.fixture_id} code={l.code} matchup={l.matchup} marker={l.marker} note={notes.get(u.fixture_id)}>
                <span className="text-slate-400 line-through">{slot(u.from)}</span>
                <span className="font-medium text-slate-500">{msg("board.ai.diff.toTray")}</span>
              </DiffRow>
            );
          })}
        </DiffGroup>

        {diff.unchanged.length > 0 && (
          <p className="mt-2 border-t border-slate-100 pt-2 text-[11px] text-slate-400">
            {plural("board.ai.diff.unchangedGroup", diff.unchanged.length)}
          </p>
        )}

        {diff.moved.length === 0 &&
          diff.placed.length === 0 &&
          diff.unscheduled.length === 0 &&
          diff.unchanged.length === 0 && (
            <p className="mt-1 text-[11px] text-slate-400">{msg("board.ai.diff.none")}</p>
          )}
      </div>
    </div>
  );
}

function CoverageStrip({ fillable, total, unfilled }: { fillable: number; total: number; unfilled: number }) {
  const msg = useMsg();
  const pct = total > 0 ? Math.round((fillable / total) * 100) : 0;
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="flex items-baseline justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          {msg("board.ai.coverage.label")}
        </p>
        <p className="font-mono text-[11px] text-slate-600">
          <span className="font-semibold text-teal-700">{fillable}</span>
          <span className="text-slate-400">/{total}</span>
        </p>
      </div>
      <div
        className="mt-1.5 h-2 overflow-hidden rounded-full bg-slate-100"
        role="progressbar"
        aria-valuenow={fillable}
        aria-valuemax={total}
        aria-label={msg("board.ai.coverage.label")}
      >
        <div className="h-full rounded-full bg-teal-500 transition-[width] duration-500" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-1 text-[11px] text-slate-500">
        {unfilled > 0 ? (
          <span className="text-amber-700">{msg("board.ai.coverage.unfilled", { n: unfilled })}</span>
        ) : (
          <span className="text-teal-700">{msg("board.ai.coverage.full")}</span>
        )}
      </p>
    </div>
  );
}

const GROUP_DOT: Record<"moved" | "placed" | "unscheduled", string> = {
  moved: "bg-amber-500",
  placed: "bg-teal-500",
  unscheduled: "bg-slate-400",
};

function DiffGroup({
  tone,
  count,
  title,
  children,
}: {
  tone: "moved" | "placed" | "unscheduled";
  count: number;
  title: string;
  children: React.ReactNode;
}) {
  if (count === 0) return null;
  return (
    <div className="mt-2 first:mt-1">
      <p className="flex items-center gap-1.5 text-[11px] font-medium text-slate-600">
        <span aria-hidden className={`h-2 w-2 rounded-full ${GROUP_DOT[tone]}`} />
        {title}
      </p>
      <ul className="mt-1 space-y-1">{children}</ul>
    </div>
  );
}

function DiffRow({
  code,
  matchup,
  marker,
  note,
  children,
}: {
  code: string;
  matchup: string;
  marker: string | null;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <li className="rounded-md bg-slate-50/70 px-2 py-1">
      <div className="flex items-center gap-1 text-xs">
        <span className="font-mono font-semibold text-slate-700">{code}</span>
        {marker && <Marker kind={marker} />}
        <span className="min-w-0 flex-1 truncate text-slate-600">{matchup}</span>
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 pl-0.5 text-[11px]">{children}</div>
      {note && <p className="mt-0.5 text-[11px] italic text-slate-400">{note}</p>}
    </li>
  );
}

/** The persistent JR/Final marker (§3) — independent of diff colour. */
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
