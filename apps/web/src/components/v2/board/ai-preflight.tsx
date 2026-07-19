"use client";

// Pre-flight readiness card + last-run recall (v4 Task 12, design/v4/03 §3).
//
// Pre-flight shows the organiser exactly what the AI will see before they run —
// courts, session windows, blackouts, constraints, movable fixtures, officials
// roster + availability, pinned count. Each row reads with the console's
// semantic state palette (02 §1): teal ✓ = ready, amber ⚠ = a gap, neutral • =
// informational. Warn rows carry a deep link to go fix the gap and, on click,
// fire `ai_preflight_gap_fixed`. Per decision 10 the card NEVER blocks the run —
// gaps are links, not gates.
//
// Presentational only: the console owns the network (officials roster + ai-last)
// and passes derived numbers down, so this file has no fetches of its own.
import { useMsg, useLocale, usePlural } from "@/components/i18n/dict-provider";
import type { MessageKey } from "@/lib/messages";
import { track, EVENTS } from "@/lib/analytics";
import type { AiLastResult } from "@/server/api-v1/schemas";

type Tone = "ok" | "warn" | "info";

export interface PreflightInput {
  divisionId: string;
  courts: number;
  windows: number;
  blackouts: number;
  constraintsSet: boolean;
  movable: number;
  pinned: number;
  /** Roster size; null while the officials fetch is still in flight. */
  officials: number | null;
  /** Officials with at least one blackout date (M in "N officials, M with …"). */
  officialsBlackout: number;
  /** Deep links (current schedule page + a tab query). */
  settingsHref: string;
  officialsHref: string;
}

interface Row {
  key: string;
  label: string;
  detail: string;
  tone: Tone;
  href?: string;
  linkLabel?: string;
}

const MAX_MOVABLE = 500;

export function AiPreflight(input: PreflightInput) {
  const msg = useMsg();
  const plural = usePlural();

  const rows: Row[] = [];

  // 1 · Courts (warn when none — the AI can't place a match without one).
  rows.push(
    input.courts > 0
      ? { key: "courts", label: msg("board.ai.preflight.courtsLabel"), tone: "ok", detail: plural("board.ai.preflight.courtsCount", input.courts) }
      : { key: "courts", label: msg("board.ai.preflight.courtsLabel"), tone: "warn", detail: msg("board.ai.preflight.warnCourts"), href: input.settingsHref, linkLabel: msg("board.ai.preflight.linkSettings") },
  );

  // 2 · Session windows (warn when unset — the AI assumes any time is fine).
  rows.push(
    input.windows > 0
      ? { key: "windows", label: msg("board.ai.preflight.windowsLabel"), tone: "ok", detail: plural("board.ai.preflight.windowsCount", input.windows) }
      : { key: "windows", label: msg("board.ai.preflight.windowsLabel"), tone: "warn", detail: msg("board.ai.preflight.warnWindows"), href: input.settingsHref, linkLabel: msg("board.ai.preflight.linkSettings") },
  );

  // 3 · Blackouts (informational).
  rows.push({
    key: "blackouts",
    label: msg("board.ai.preflight.blackoutsLabel"),
    tone: "info",
    detail: plural("board.ai.preflight.blackoutsCount", input.blackouts),
  });

  // 4 · Constraints (informational — custom rules vs defaults).
  rows.push({
    key: "constraints",
    label: msg("board.ai.preflight.constraintsLabel"),
    tone: "info",
    detail: msg(input.constraintsSet ? "board.ai.preflight.constraintsCustom" : "board.ai.preflight.constraintsDefault"),
  });

  // 5 · Movable fixtures (warn past the 500 pack cap — narrow with a scope).
  rows.push(
    input.movable <= MAX_MOVABLE
      ? { key: "movable", label: msg("board.ai.preflight.movableLabel"), tone: "ok", detail: plural("board.ai.preflight.movableCount", input.movable) }
      : { key: "movable", label: msg("board.ai.preflight.movableLabel"), tone: "warn", detail: msg("board.ai.preflight.warnMovable") },
  );

  // 6 · Officials roster + availability (checking → ok/warn).
  if (input.officials === null) {
    rows.push({ key: "officials", label: msg("board.ai.preflight.officialsLabel"), tone: "info", detail: msg("board.ai.preflight.officialsChecking") });
  } else if (input.officials > 0) {
    const count = plural("board.ai.preflight.officialsCount", input.officials);
    const detail =
      input.officialsBlackout > 0
        ? `${count}, ${msg("board.ai.preflight.officialsBlackout", { count: input.officialsBlackout })}`
        : count;
    rows.push({ key: "officials", label: msg("board.ai.preflight.officialsLabel"), tone: "ok", detail });
  } else {
    rows.push({ key: "officials", label: msg("board.ai.preflight.officialsLabel"), tone: "warn", detail: msg("board.ai.preflight.warnOfficials"), href: input.officialsHref, linkLabel: msg("board.ai.preflight.linkOfficials") });
  }

  // 7 · Pinned (informational).
  rows.push({
    key: "pinned",
    label: msg("board.ai.preflight.pinnedLabel"),
    tone: "info",
    detail: plural("board.ai.preflight.pinnedCount", input.pinned),
  });

  return (
    <section
      aria-label={msg("board.ai.preflight.aria")}
      className="rounded-lg border border-slate-200 bg-white"
    >
      <p className="border-b border-slate-100 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        {msg("board.ai.preflight.title")}
      </p>
      <ul className="divide-y divide-slate-100">
        {rows.map((r) => (
          <PreflightRow key={r.key} row={r} divisionId={input.divisionId} />
        ))}
      </ul>
    </section>
  );
}

function PreflightRow({ row, divisionId }: { row: Row; divisionId: string }) {
  const warn = row.tone === "warn";
  return (
    <li className={`flex items-start gap-2.5 px-3 py-2 ${warn ? "bg-amber-50/60" : ""}`}>
      <StatusDot tone={row.tone} />
      <div className="min-w-0 flex-1">
        <p className={`text-xs font-medium ${warn ? "text-amber-900" : "text-slate-700"}`}>{row.label}</p>
        <p className={`text-[11px] ${warn ? "text-amber-800" : "text-slate-500"}`}>{row.detail}</p>
      </div>
      {row.href && row.linkLabel && (
        <a
          href={row.href}
          onClick={() => track(EVENTS.AI_PREFLIGHT_GAP_FIXED, { division_id: divisionId, gap: row.key })}
          className="shrink-0 whitespace-nowrap rounded-md px-2 py-0.5 text-[11px] font-semibold text-amber-800 underline decoration-amber-300 underline-offset-2 transition hover:bg-amber-100"
        >
          {row.linkLabel} →
        </a>
      )}
    </li>
  );
}

function StatusDot({ tone }: { tone: Tone }) {
  const map: Record<Tone, { cls: string; glyph: string }> = {
    ok: { cls: "bg-teal-100 text-teal-700", glyph: "✓" },
    warn: { cls: "bg-amber-100 text-amber-700", glyph: "⚠" },
    info: { cls: "bg-slate-100 text-slate-400", glyph: "•" },
  };
  const { cls, glyph } = map[tone];
  return (
    <span aria-hidden className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full text-[10px] font-bold leading-none ${cls}`}>
      {glyph}
    </span>
  );
}

// ---------------------------------------------------------- last-run recall
export function AiLastRun({
  last,
  onReuse,
}: {
  last: NonNullable<AiLastResult>;
  onReuse: (instruction: string) => void;
}) {
  const msg = useMsg();
  const locale = useLocale();
  const date = new Date(last.at).toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" });
  return (
    <button
      type="button"
      onClick={() => onReuse(last.instruction)}
      aria-label={msg("board.ai.lastRun.aria", { date })}
      className="group flex w-full items-center gap-2 rounded-lg border border-slate-200 bg-slate-50/70 px-3 py-2 text-left transition hover:border-violet-300 hover:bg-violet-50/50"
    >
      <span aria-hidden className="text-sm text-slate-400 group-hover:text-violet-500">
        ↺
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            {msg("board.ai.lastRun.label")}
          </span>
          <span className="text-[11px] text-slate-400">· {date}</span>
        </span>
        <span className="mt-0.5 block truncate text-xs text-slate-700">{last.instruction}</span>
      </span>
      <span className="shrink-0 text-[11px] font-semibold text-violet-600 group-hover:text-violet-700">
        {msg("board.ai.lastRun.action")}
      </span>
    </button>
  );
}
