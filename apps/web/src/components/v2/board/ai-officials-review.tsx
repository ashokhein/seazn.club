"use client";

// Officials review grid (v4 Task 14, design/v4/03 §3 "Step 3 — Officials").
// Phase B's answer to the schedule diff panel: the same referee-trace headline,
// then a grid of fixture rows × role chips over the dry-run schedule. Chip tones
// carry the console's state palette (02 §1): teal = referee-clean, amber =
// changed vs the draft the organiser was looking at, red = a blocking conflict
// (tooltip = detail), a dashed hollow chip = an unfilled role (reason on hover;
// a `lazy_unfilled` slot offers the solver's candidate with one-tap adopt), and
// a padlock marks a locked assignment the AI must not touch. Below the grid,
// officials wish chips + an instruction box + Re-plan drive a refine turn.
//
// The grid model (buildOfficialsGrid) is pure + React-free so every tone is
// unit-tested against a constructed plan. The component is a renderer over it.
import { useMemo, useState } from "react";
import { timeLabel } from "@/lib/day-label";
import { useMsg } from "@/components/i18n/dict-provider";
import type { MessageKey } from "@/lib/messages";
import type { AiOfficialsPlanResponse } from "@/server/api-v1/schemas";
import { OfficialAvatar } from "@/components/v2/officials-shared";
import { AiTrace, type TraceEvent } from "./ai-trace";
import type { AiConsoleFixture } from "./ai-diff";
import {
  buildOfficialsGrid,
  officialsConflictKey,
  type OfficialsGridRow,
  type OfficialsPlacement,
  type OfficialsRosterEntry,
  type OfficialsSlot,
  type OfficialsSlotTone,
} from "./ai-officials-grid";
import { compileOfficialsWishes, type OfficialsWish, type OfficialsWishKind } from "./officials-wish-compile";

// Re-export the grid shapes so the console imports the officials types from the
// review, the same way it re-exports AiConsoleFixture via ai-console.
export type { OfficialsPlacement, OfficialsRosterEntry } from "./ai-officials-grid";

/** Title-case a bare role key ("referee" → "Referee") for a chip's role tag. */
function roleTitle(role: string): string {
  return role.length === 0 ? role : role[0]!.toUpperCase() + role.slice(1);
}

// ------------------------------------------------------------- trace script
/** Narrate the officials referee run from the verified plan (no server trace
 *  field), mirroring buildScheduleTrace: draft/plan/verify spine, flag lines for
 *  caught conflicts + a repair round, then CLEAN + Ready or a red unresolved
 *  tail when blocking conflicts remain. */
export function buildOfficialsTrace(
  plan: AiOfficialsPlanResponse,
  roleCount: number,
  msg: ReturnType<typeof useMsg>,
): { events: TraceEvent[]; flaggedIds: string[] } {
  const events: TraceEvent[] = [];
  const node = (k: MessageKey) => events.push({ t: "step", text: msg(k) });
  const log = (text: string) => events.push({ t: "log", text });

  const fixtureCount = new Set(plan.assignments.map((a) => a.fixtureId)).size;
  node("board.ai.trace.node.draft");
  log(msg("board.ai.trace.line.draftOfficials", { fixtures: fixtureCount, roles: roleCount }));
  node("board.ai.trace.node.plan");
  log(msg("board.ai.trace.line.planOfficials", { count: plan.assignments.length }));
  node("board.ai.trace.node.referee");
  log(msg("board.ai.trace.line.verifyOfficials"));

  const flaggedIds = Array.from(
    new Set(plan.conflicts.map((c) => c.fixtureId).filter((id): id is string => Boolean(id))),
  );
  const blocking = plan.conflicts.filter((c) => c.severity === "block");
  const repaired = plan.usage.repair_rounds > 0;

  if (repaired || plan.conflicts.length > 0) {
    const shown = plan.conflicts.slice(0, 3);
    if (shown.length > 0) {
      for (const c of shown) {
        events.push({
          t: "flag",
          text: msg("board.ai.trace.line.flag", { what: c.detail || msg(officialsConflictKey(c.kind)) }),
        });
      }
    } else {
      events.push({ t: "flag", text: msg("board.ai.trace.line.flagGeneric") });
    }
    if (repaired) {
      node("board.ai.trace.node.repair");
      log(msg("board.ai.trace.line.repair", { rounds: plan.usage.repair_rounds }));
    }
  }

  if (blocking.length > 0) {
    // Officials has no per-row untick (that's the schedule diff panel) — the
    // blockers stay for manual assignment, so use the officials-specific line.
    events.push({ t: "flag", text: msg("board.ai.trace.line.blockingRemainOfficials", { count: blocking.length }) });
  } else {
    events.push({ t: "clean", text: msg("board.ai.trace.line.clean") });
    node("board.ai.trace.node.ready");
  }

  return { events, flaggedIds };
}

// ------------------------------------------------------------- component
export function AiOfficialsReview({
  plan,
  placements,
  fixtures,
  roster,
  roles,
  hasPrior,
  busy,
  traceNonce,
  error,
  instruction,
  onInstruction,
  wishes,
  onWishes,
  onReplan,
  onAdopt,
  onBack,
  onContinue,
  onPulse,
}: {
  plan: AiOfficialsPlanResponse | null;
  placements: OfficialsPlacement[];
  fixtures: AiConsoleFixture[];
  roster: OfficialsRosterEntry[];
  roles: string[];
  /** The current plan was produced with a prior proposal — `diff.changed`
   *  then means "changed vs prior", so amber chips are meaningful; a first
   *  draft has no prior, so every referee-clean chip reads teal. */
  hasPrior: boolean;
  busy: boolean;
  traceNonce: number;
  error: { status: number; message: string } | null;
  instruction: string;
  onInstruction: (v: string) => void;
  wishes: OfficialsWish[];
  onWishes: (next: OfficialsWish[]) => void;
  onReplan: () => void;
  onAdopt: (fixtureId: string, roleKey: string, candidateId: string) => void;
  onBack: () => void;
  onContinue: () => void;
  onPulse: (ids: string[]) => void;
}) {
  const msg = useMsg();
  const model = useMemo(
    () => (plan ? buildOfficialsGrid({ plan, placements, fixtures, roster, roles, hasPrior }) : null),
    [plan, placements, fixtures, roster, roles, hasPrior],
  );
  const trace = useMemo(
    () => (plan ? buildOfficialsTrace(plan, roles.length, msg) : null),
    [plan, roles.length, msg],
  );
  // A draft with no tokens is the free solver pass — show a localized note, not
  // the server's fixed English summary.
  const isFreeDraft = plan !== null && plan.usage.input_tokens === 0 && plan.usage.output_tokens === 0;

  return (
    <div className="space-y-3">
      {/* Still working on the first (auto) draft — nothing to trace yet. */}
      {plan === null && busy && (
        <div className="flex items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-8 text-xs text-slate-500">
          <Spinner />
          {msg("board.ai.officials.running")}
        </div>
      )}

      {/* The referee trace — the headline, shared with Phase A. */}
      {plan && trace && (
        <AiTrace
          key={traceNonce}
          phase="officials"
          events={trace.events}
          running={busy}
          onFlag={() => onPulse(trace.flaggedIds)}
        />
      )}

      {/* Summary + usage + role coverage. */}
      {plan && model && (
        <div className="space-y-3">
          <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              {msg("board.ai.summaryLabel")}
            </p>
            <p className="mt-1 text-sm leading-relaxed text-slate-700">
              {isFreeDraft ? msg("board.ai.officials.draftNote") : plan.summary}
            </p>
            <div className="mt-2 flex flex-wrap gap-1">
              {(
                [
                  { k: "board.ai.usage.in", v: plan.usage.input_tokens.toLocaleString() },
                  { k: "board.ai.usage.out", v: plan.usage.output_tokens.toLocaleString() },
                  { k: "board.ai.usage.repairs", v: String(plan.usage.repair_rounds) },
                  { k: "board.ai.usage.blocking", v: String(model.blocking) },
                ] as { k: MessageKey; v: string }[]
              ).map((u) => (
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

          <CoverageLine filled={model.filled} total={model.total} />
        </div>
      )}

      {/* The grid — one row per fixture, one chip per required role. */}
      {model && (
        <div className="rounded-lg border border-slate-200 bg-white p-2">
          {model.rows.length === 0 ? (
            <p className="px-1 py-4 text-center text-[11px] text-slate-400">
              {msg("board.ai.officials.emptyGrid")}
            </p>
          ) : (
            <ul className="space-y-2" aria-label={msg("board.ai.officials.gridAria")}>
              {model.rows.map((row) => (
                <li key={row.fixtureId} className="rounded-md border border-slate-100 bg-slate-50/50 p-2">
                  <div className="flex items-center gap-1 text-xs">
                    <span className="font-mono font-semibold text-slate-700">{row.code}</span>
                    {row.marker && <Marker kind={row.marker} />}
                    <span className="min-w-0 flex-1 truncate text-slate-600">{row.matchup}</span>
                    <span className="shrink-0 whitespace-nowrap font-mono text-[10px] text-slate-400">
                      {row.courtLabel ? `${row.courtLabel} · ${timeLabel(row.scheduledAt)}` : timeLabel(row.scheduledAt)}
                    </span>
                  </div>
                  <ul className="mt-1.5 flex flex-wrap gap-1.5">
                    {row.slots.map((slot, i) => (
                      <RoleChip
                        key={`${slot.role}-${i}`}
                        slot={slot}
                        row={row}
                        busy={busy}
                        onAdopt={onAdopt}
                        msg={msg}
                      />
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* An auto-draft that failed leaves no plan — surface it, offer a retry. */}
      {error && (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          <span className="font-semibold">{msg("board.ai.errorLabel")}</span> {error.message}
        </p>
      )}

      {/* Refine turn — officials wish chips + instruction + Re-plan. */}
      <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-3">
        <OfficialsWishChips wishes={wishes} onChange={onWishes} roster={roster} />
        <div>
          <label htmlFor="ai-officials-instruction" className="label">
            {msg("board.ai.officials.instructionLabel")}
          </label>
          <textarea
            id="ai-officials-instruction"
            className="input min-h-20 resize-y"
            value={instruction}
            disabled={busy}
            onChange={(e) => onInstruction(e.target.value)}
            placeholder={msg("board.ai.officials.instructionPlaceholder")}
          />
          <p className="mt-1 text-[11px] text-slate-500">{msg("board.ai.officials.instructionHint")}</p>
        </div>
        <button
          type="button"
          onClick={onReplan}
          disabled={busy || plan === null}
          className="ai-run inline-flex w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-br from-violet-600 to-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? (
            <>
              <Spinner />
              {msg("board.ai.officials.running")}
            </>
          ) : (
            <>
              <span aria-hidden>✦</span>
              {msg("board.ai.officials.replan")}
            </>
          )}
        </button>
      </div>

      {/* Step navigation. */}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button
          type="button"
          onClick={onContinue}
          disabled={plan === null}
          className="btn btn-primary px-3 py-1.5 text-xs disabled:opacity-50"
        >
          {msg("board.ai.officials.toApply")}
        </button>
        <button type="button" onClick={onBack} className="btn btn-ghost ml-auto px-3 py-1.5 text-xs">
          {msg("board.ai.back")}
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------- role chip
const CHIP_TONE: Record<OfficialsSlotTone, string> = {
  clean: "border-teal-200 bg-teal-50 text-teal-800",
  changed: "border-amber-300 bg-amber-50 text-amber-900",
  blocking: "border-red-300 bg-red-50 text-red-800",
  locked: "border-slate-300 bg-slate-100 text-slate-700",
  unfilled: "border-dashed border-slate-300 bg-white text-slate-500",
};

function RoleChip({
  slot,
  row,
  busy,
  onAdopt,
  msg,
}: {
  slot: OfficialsSlot;
  row: OfficialsGridRow;
  busy: boolean;
  onAdopt: (fixtureId: string, roleKey: string, candidateId: string) => void;
  msg: ReturnType<typeof useMsg>;
}) {
  const roleTag = roleTitle(slot.role);

  if (slot.tone === "unfilled") {
    // A hollow chip: the solver's candidate (adopt) when the referee flagged it
    // fillable, else a bare "unfilled" with the model's reason on hover.
    const title = slot.reason || msg("board.ai.officials.noEligible");
    return (
      <li>
        <span
          title={title}
          className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] ${CHIP_TONE.unfilled}`}
        >
          <span className="font-medium uppercase tracking-wide text-[9px] text-slate-400">{roleTag}</span>
          {slot.lazyCandidateId && slot.lazyCandidateName ? (
            <>
              <span className="text-slate-500">{msg("board.ai.officials.solverSuggests", { name: slot.lazyCandidateName })}</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => onAdopt(row.fixtureId, slot.role, slot.lazyCandidateId!)}
                aria-label={msg("board.ai.officials.adoptAria", {
                  name: slot.lazyCandidateName,
                  role: roleTag,
                  matchup: row.matchup,
                })}
                className="rounded-full bg-violet-600 px-1.5 py-0.5 text-[10px] font-semibold text-white transition hover:bg-violet-500 disabled:opacity-50"
              >
                {msg("board.ai.officials.adopt", { name: slot.lazyCandidateName })}
              </button>
            </>
          ) : (
            <span className="text-slate-400">{msg("board.ai.officials.unfilledLabel")}</span>
          )}
        </span>
      </li>
    );
  }

  // A filled chip: avatar + name + role, plus a padlock / conflict marker.
  const conflictTitle =
    slot.tone === "blocking"
      ? [msg(officialsConflictKey(slot.conflictKind ?? "unknown")), slot.conflictDetail].filter(Boolean).join(" — ")
      : slot.tone === "locked"
        ? msg("board.ai.officials.lockedTitle")
        : undefined;
  return (
    <li>
      <span
        title={conflictTitle}
        aria-label={msg("board.ai.officials.chipAria", { role: roleTag, name: slot.officialName ?? "" })}
        className={`inline-flex items-center gap-1.5 rounded-full border py-0.5 pl-0.5 pr-2 text-[11px] font-medium ${CHIP_TONE[slot.tone]}`}
      >
        <OfficialAvatar name={slot.officialName ?? "?"} size="sm" />
        <span className="min-w-0 max-w-[9rem] truncate">{slot.officialName}</span>
        <span className="uppercase tracking-wide text-[9px] opacity-60">{roleTag}</span>
        {slot.tone === "blocking" && <span aria-hidden>⚑</span>}
        {slot.locked && (
          <span aria-hidden title={msg("board.ai.officials.lockedTitle")}>
            🔒
          </span>
        )}
      </span>
    </li>
  );
}

function CoverageLine({ filled, total }: { filled: number; total: number }) {
  const msg = useMsg();
  const unfilled = total - filled;
  const pct = total > 0 ? Math.round((filled / total) * 100) : 0;
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="flex items-baseline justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          {msg("board.ai.officials.coverageLabel")}
        </p>
        <p className="font-mono text-[11px] text-slate-600">
          <span className="font-semibold text-teal-700">{filled}</span>
          <span className="text-slate-400">/{total}</span>
        </p>
      </div>
      <div
        className="mt-1.5 h-2 overflow-hidden rounded-full bg-slate-100"
        role="progressbar"
        aria-valuenow={filled}
        aria-valuemax={total}
        aria-label={msg("board.ai.officials.coverageLabel")}
      >
        <div className="h-full rounded-full bg-teal-500 transition-[width] duration-500" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-1 text-[11px]">
        {unfilled > 0 ? (
          <span className="text-amber-700">{msg("board.ai.coverage.unfilled", { n: unfilled })}</span>
        ) : (
          <span className="text-teal-700">{msg("board.ai.coverage.full")}</span>
        )}
      </p>
    </div>
  );
}

/** The persistent JR/Final marker (§3) — independent of chip colour. */
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

function Spinner() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="h-4 w-4 animate-spin">
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.3" strokeWidth="2" />
      <path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

// ------------------------------------------------- officials wish chips
const OFFICIALS_WISH_KINDS: OfficialsWishKind[] = ["senior_finals", "spread_even", "only_window"];

const OFFICIALS_WISH_LABEL: Record<OfficialsWishKind, MessageKey> = {
  senior_finals: "board.ai.officials.wish.kind.seniorFinals",
  spread_even: "board.ai.officials.wish.kind.spreadEven",
  only_window: "board.ai.officials.wish.kind.onlyWindow",
};

/** Localized pill caption for a confirmed officials wish (English compiled text
 *  stays in officials-wish-compile — the pill is UI). */
function officialsPill(msg: ReturnType<typeof useMsg>, w: OfficialsWish): string {
  switch (w.kind) {
    case "senior_finals":
      return msg("board.ai.officials.wish.pill.seniorFinals");
    case "spread_even":
      return msg("board.ai.officials.wish.pill.spreadEven");
    case "only_window":
      return msg("board.ai.officials.wish.pill.onlyWindow", {
        name: w.officialName,
        edge: msg(`board.ai.wish.edge.${w.edge}`),
        time: w.time,
      });
  }
}

function OfficialsWishChips({
  wishes,
  onChange,
  roster,
}: {
  wishes: OfficialsWish[];
  onChange: (next: OfficialsWish[]) => void;
  roster: OfficialsRosterEntry[];
}) {
  const msg = useMsg();
  const [active, setActive] = useState<OfficialsWishKind | null>(null);
  const hasRoster = roster.length > 0;

  const add = (w: OfficialsWish) => {
    onChange([...wishes, w]);
    setActive(null);
  };
  const remove = (i: number) => onChange(wishes.filter((_, idx) => idx !== i));

  return (
    <div className="space-y-2">
      <span className="label mb-0">{msg("board.ai.wish.legend")}</span>

      {wishes.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {wishes.map((w, i) => {
            const label = officialsPill(msg, w);
            return (
              <li key={`${w.kind}-${i}`}>
                <span className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 py-1 pl-2.5 pr-1 text-xs font-medium text-amber-900">
                  {label}
                  <button
                    type="button"
                    onClick={() => remove(i)}
                    aria-label={msg("board.ai.wish.remove", { label })}
                    className="grid h-4 w-4 place-items-center rounded-full text-amber-700 transition hover:bg-amber-200 hover:text-amber-900"
                  >
                    ✕
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex flex-wrap gap-1.5">
        {OFFICIALS_WISH_KINDS.map((k) => {
          // only_window needs a roster to pick an official.
          const enabled = k !== "only_window" || hasRoster;
          const isActive = active === k;
          // A one-tap wish (no picker) adds immediately; only_window opens a picker.
          const onClick = () => {
            if (k === "senior_finals") return add({ kind: "senior_finals" });
            if (k === "spread_even") return add({ kind: "spread_even" });
            setActive(isActive ? null : k);
          };
          return (
            <button
              key={k}
              type="button"
              disabled={!enabled}
              title={enabled ? undefined : msg("board.ai.officials.wish.noOfficials")}
              aria-expanded={k === "only_window" ? isActive : undefined}
              onClick={onClick}
              className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${
                isActive
                  ? "border-violet-300 bg-violet-50 text-violet-700"
                  : "border-slate-200 bg-white text-slate-600 hover:border-violet-300 hover:text-violet-700"
              }`}
            >
              <span aria-hidden className="text-violet-400">
                +
              </span>
              {msg(OFFICIALS_WISH_LABEL[k])}
            </button>
          );
        })}
      </div>

      {active === "only_window" && (
        <OnlyWindowPicker roster={roster} onAdd={add} onCancel={() => setActive(null)} />
      )}

      <p className="text-[11px] text-slate-500">{msg("board.ai.wish.hint")}</p>
    </div>
  );
}

function OnlyWindowPicker({
  roster,
  onAdd,
  onCancel,
}: {
  roster: OfficialsRosterEntry[];
  onAdd: (w: OfficialsWish) => void;
  onCancel: () => void;
}) {
  const msg = useMsg();
  const [officialId, setOfficialId] = useState("");
  const [edge, setEdge] = useState<"before" | "after">("before");
  const [time, setTime] = useState("");
  const ready = officialId !== "" && time !== "";
  const nameOf = (id: string) => roster.find((o) => o.id === id)?.name ?? "";

  return (
    <div className="space-y-2.5 rounded-lg border border-violet-100 bg-violet-50/40 p-2.5">
      <label className="block">
        <span className="mb-0.5 block text-[11px] font-medium text-slate-500">{msg("board.ai.officials.wish.official")}</span>
        <select className="input" value={officialId} onChange={(e) => setOfficialId(e.target.value)}>
          <option value="">{msg("board.ai.wish.choose")}</option>
          {roster.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="mb-0.5 block text-[11px] font-medium text-slate-500">{msg("board.ai.wish.edgeLabel")}</span>
        <div role="group" className="flex rounded-lg border border-slate-200 bg-white p-0.5">
          {(["before", "after"] as const).map((e) => (
            <button
              key={e}
              type="button"
              aria-pressed={edge === e}
              onClick={() => setEdge(e)}
              className={`flex-1 rounded-md px-2 py-1 text-xs font-medium transition ${
                edge === e ? "bg-violet-600 text-white" : "text-slate-500 hover:text-violet-700"
              }`}
            >
              {msg(`board.ai.wish.edge.${e}`)}
            </button>
          ))}
        </div>
      </label>
      <label className="block">
        <span className="mb-0.5 block text-[11px] font-medium text-slate-500">{msg("board.ai.wish.time")}</span>
        <input type="time" className="input" value={time} onChange={(e) => setTime(e.target.value)} />
      </label>
      <div className="flex items-center gap-2 pt-0.5">
        <button
          type="button"
          disabled={!ready}
          onClick={() => onAdd({ kind: "only_window", officialId, officialName: nameOf(officialId), edge, time })}
          className="btn btn-primary px-3 py-1 text-xs disabled:opacity-50"
        >
          {msg("board.ai.wish.add")}
        </button>
        <button type="button" onClick={onCancel} className="btn btn-ghost px-3 py-1 text-xs">
          {msg("board.ai.wish.cancel")}
        </button>
      </div>
    </div>
  );
}
