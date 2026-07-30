"use client";

// The JOINT AI console (#350 §9) — the competition board's own dock.
//
// It is a sibling of `ai-console.tsx`, not a mode of it. The division console is
// a four-step wizard over two phases (schedule, then officials); a joint run is
// ONE phase over several divisions — officials stay per division by design
// decision — so a shared component would have been a wizard with three of its
// four steps switched off. What the two DO share is everything that touches
// money: `quoteFor`, the receipt, and the rung semantics, all imported.
//
// The design is the division console's chrome with one addition, because that is
// the one thing this surface knows and the other cannot: a DIVISION LEDGER. The
// same list of divisions is read three times over — as what the run will cover
// (the picker), as what it costs (the receipt's one line each), and as what it
// placed (the review's rows) — in the same order, so an organiser can follow one
// division straight down the dock. Everything else is the board's existing
// slate/violet vocabulary; the only new colour is the tint each division already
// wears on its cards.
//
// Three things this surface has to say that the per-division one never does, all
// of them consequences of merging divisions that were configured separately:
//   * courts are matched BY NAME and nothing else;
//   * the divisions may be set to different timezones while the board renders in
//     the reader's own (ruling R8);
//   * a person clash is a WARNING at plan time and a REFUSAL at apply time, but
//     only if one of the selected divisions opted into `crossPersonClash: hard`.
import { useCallback, useMemo, useState } from "react";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { useMsg, usePlural } from "@/components/i18n/dict-provider";
import { UpgradeGate } from "@/components/upgrade-gate";
import { PlanBadge } from "@/components/plan-badge";
import { isRung, type Rung } from "@/lib/ai-rung";
import type { Currency } from "@/lib/currency";
import type { MessageKey } from "@/lib/messages";
import { divisionInk, divisionTint } from "@/lib/division-hue";
import type { AiCompetitionPlanResponse } from "@/server/api-v1/schemas";
import { AiOutOfCredits } from "./ai-out-of-credits";
import {
  AiDivisionPicker,
  defaultSelectedDivisionIds,
  jointRunReady,
  type PickerDivision,
} from "./ai-division-picker";
import { AiQuoteCard, quoteFor, type QuoteCardLine } from "./ai-quote-card";
import { aiErrorKey, applyErrorKey } from "./ai-console-state";
import { AI_APPLY_MODEL } from "./ai-apply";
import {
  applyJointPlan,
  undoJointApply,
  type JointApplyDivision,
  type JointApplyOutcome,
} from "./ai-joint-apply";
import { blockingConflictKey, type AiConsoleFixture } from "./ai-diff";

/** One division as the competition board holds it. Everything here is either a
 *  pricing input, a gate the server enforces, or something the reader has to be
 *  told about the merge — nothing decorative. */
export interface JointDivision {
  id: string;
  name: string;
  /** Optimistic-concurrency token at render; the joint apply requires one per
   *  division and refuses the whole write if any is stale. */
  seq: number;
  /** The plan endpoint answers 409 SCHEDULE_LOCKED for a single frozen division
   *  and refuses the WHOLE run, so a frozen division cannot be offered. */
  scheduleLocked: boolean;
  /** This division's OWN configured courts — the pricing input the server uses
   *  (it builds each division's pack from that division's settings), and the
   *  input to the by-name divergence check. */
  courts: string[];
  /** Resolved venue zone. */
  tz: string;
  /** `constraints.crossPersonClash === "hard"`: this division's apply refuses a
   *  person double-booking that the plan only warned about. */
  personClashBlocks: boolean;
  movableFixtures: number;
  activeEntrants: number;
}

/** The picker's view of the divisions, in board order. */
export function pickerDivisions(divisions: JointDivision[]): PickerDivision[] {
  return divisions.map((d) => ({
    id: d.id,
    name: d.name,
    movable: d.movableFixtures,
    locked: d.scheduleLocked,
  }));
}

/**
 * One receipt line per selected division.
 *
 * `label` is ALWAYS the division's name. The card's oversize warning attributes
 * itself per line and falls back to "this division" for an unlabelled one — on a
 * joint run that is advice naming nothing, which is the exact bug the per-line
 * attribution replaced.
 *
 * `courts` is the division's OWN court count, not the union: the server prices
 * each division from its own pack, built from its own settings.
 */
export function jointQuoteLines(
  divisions: JointDivision[],
  selected: string[],
  rungs: Record<string, number | null>,
): QuoteCardLine[] {
  const chosen = new Set(selected);
  return divisions
    .filter((d) => chosen.has(d.id))
    .map((d) => ({
      key: d.id,
      label: d.name,
      input: {
        movableFixtures: d.movableFixtures,
        entrants: d.activeEntrants,
        courts: d.courts.length,
      },
      chosen: rungs[d.id] ?? null,
    }));
}

/**
 * Court labels that are NOT set up in every selected division.
 *
 * Cross-division court identity is a string match and nothing else — there is no
 * venue-level court entity. So "Court 2" in one division and "Court A" in
 * another are two courts even if they are the same slab of tarmac, and the run
 * will happily put a match on each at the same time. Mirrors the server's own
 * `divergentCourts`, so the pre-run warning and the response agree.
 */
export function divergentCourts(divisions: JointDivision[], selected: string[]): string[] {
  const chosen = divisions.filter((d) => selected.includes(d.id));
  if (chosen.length < 2) return [];
  const sets = chosen.map((d) => new Set(d.courts));
  const all = [...new Set(chosen.flatMap((d) => d.courts))].sort();
  return all.filter((c) => !sets.every((s) => s.has(c)));
}

/** The selected divisions grouped by timezone, or `[]` when they all share one.
 *  Ruling R8: every internal comparison is epoch ms, but the board renders in
 *  the reader's zone while each division is configured in its own. */
export function timezoneSpread(
  divisions: JointDivision[],
  selected: string[],
): { tz: string; divisions: string[] }[] {
  const chosen = divisions.filter((d) => selected.includes(d.id));
  const byZone = new Map<string, string[]>();
  for (const d of chosen) {
    const list = byZone.get(d.tz);
    if (list) list.push(d.name);
    else byZone.set(d.tz, [d.name]);
  }
  if (byZone.size < 2) return [];
  return [...byZone.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tz, names]) => ({ tz, divisions: names }));
}

/**
 * The person clashes the APPLY will refuse, and which divisions' rule refuses
 * them.
 *
 * The joint plan reports a person double-booking as a warning; the joint apply
 * refuses it outright when any selected division sets `crossPersonClash: hard`.
 * Without this the organiser reads a badge, presses Apply, and meets a 409.
 *
 * Counts ONLY person overlaps — a rest or blackout warning is not refused — and
 * only when a selected division actually blocks, so nothing is threatened on a
 * board where every division is content to warn.
 */
export function personClashRisk(
  warnings: { fixtureId: string; reason: string }[],
  divisions: JointDivision[],
  selected: string[],
): { count: number; divisions: string[] } {
  const chosen = new Set(selected);
  const blockers = divisions.filter((d) => chosen.has(d.id) && d.personClashBlocks).map((d) => d.name);
  if (blockers.length === 0) return { count: 0, divisions: [] };
  return {
    count: warnings.filter((w) => w.reason === "person_overlap").length,
    divisions: blockers,
  };
}

/**
 * The per-division rung picks a run request carries — the joint twin of
 * `rungField`.
 *
 * A line left on the recommendation sends NO entry, so the server sizes that
 * division from its own prediction rather than freezing a client-side estimate
 * into the price; an entry for a division that is no longer selected would price
 * work the run does not cover. An all-defaults run omits the field entirely,
 * because `{}` and an absent key are not the same over the wire.
 */
export function rungOverrides(
  rungs: Record<string, number | null>,
  selected: string[],
): { rung_overrides?: Record<string, Rung> } {
  const out: Record<string, Rung> = {};
  for (const id of selected) {
    const r = rungs[id];
    if (r !== null && r !== undefined && isRung(r)) out[id] = r;
  }
  return Object.keys(out).length > 0 ? { rung_overrides: out } : {};
}

/** The three independent reasons a joint run cannot start, in one place so the
 *  CTA and any future caller cannot disagree about them. The selection rule
 *  counts DISTINCT divisions (`jointRunReady`), because the orchestrator
 *  de-duplicates before it counts. */
export function canRunJoint(input: {
  selected: string[];
  instruction: string;
  running: boolean;
}): boolean {
  return (
    jointRunReady(input.selected) && input.instruction.trim().length >= 3 && !input.running
  );
}

/**
 * The apply payload: each division's own placements under its own seq token.
 *
 * Grouped from the proposal's `division_id`, which the SERVER resolved — the
 * model is told not to emit one — so this cannot be an echo of a hallucinated
 * division. A division the board no longer knows about is dropped rather than
 * sent with a guessed seq.
 */
export function jointApplyDivisions(
  plan: Pick<AiCompetitionPlanResponse, "proposal">,
  divisions: JointDivision[],
): JointApplyDivision[] {
  const seqOf = new Map(divisions.map((d) => [d.id, d.seq]));
  const byDivision = new Map<string, JointApplyDivision["assignments"]>();
  for (const p of plan.proposal) {
    if (!p.court_label) continue; // the wire requires a court label
    const list = byDivision.get(p.division_id);
    const row = { fixture_id: p.fixture_id, scheduled_at: p.scheduled_at, court_label: p.court_label };
    if (list) list.push(row);
    else byDivision.set(p.division_id, [row]);
  }
  return [...byDivision.entries()]
    .filter(([id]) => seqOf.has(id))
    .map(([id, assignments]) => ({ divisionId: id, expectedSeq: seqOf.get(id) as number, assignments }));
}

// ---------------------------------------------------------------------------
// Review step
// ---------------------------------------------------------------------------

/** A caution row — the console's one warning shape, so three different things
 *  worth knowing do not arrive in three different costumes. */
function Caution({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div
      role="status"
      className="flex items-start gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] leading-snug text-amber-900"
    >
      <span aria-hidden>⚠</span>
      <div className="min-w-0">
        {title && <p className="font-semibold">{title}</p>}
        <div>{children}</div>
      </div>
    </div>
  );
}

/** The division's own tint, the same one its cards wear on the board. This is
 *  the ledger's spine: picker order, receipt order, review order, one colour. */
function DivisionChip({ id, name }: { id: string; name: string }) {
  return (
    <span
      className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold"
      style={{ backgroundColor: divisionTint(id), color: divisionInk(id) }}
    >
      {name}
    </span>
  );
}

export function JointReviewStep({
  plan,
  divisions,
  selected,
  excluded,
  fixtures,
  applying,
  outcome,
  undoing,
  undone,
  onToggleExclude,
  onApply,
  onDiscard,
  onUndo,
  onBack,
  onReRun,
  msg,
}: {
  plan: AiCompetitionPlanResponse;
  divisions: JointDivision[];
  selected: string[];
  /** Fixtures the organiser set aside — they keep their CURRENT slot. */
  excluded: string[];
  /** The board's current fixtures, for the blocked rows' code + matchup. */
  fixtures: AiConsoleFixture[];
  applying: boolean;
  outcome: JointApplyOutcome | null;
  undoing: boolean;
  undone: "no" | "full" | "partial";
  onToggleExclude: (fixtureId: string) => void;
  onApply: () => void;
  onDiscard: () => void;
  onUndo: () => void;
  onBack: () => void;
  onReRun: () => void;
  msg: ReturnType<typeof useMsg>;
}) {
  const plural = usePlural();
  const nameOf = new Map(divisions.map((d) => [d.id, d.name]));
  const meta = new Map(fixtures.map((f) => [f.id, f]));
  const divisionOf = new Map(plan.proposal.map((p) => [p.fixture_id, p.division_id]));
  const setAside = new Set(excluded);

  // Applied — the confirmation, then the restore point that makes it reversible.
  if (outcome?.status === "applied") {
    if (undone !== "no") {
      return (
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
          <p className="flex items-center gap-1.5 text-sm font-medium text-slate-700">
            <span aria-hidden>⟲</span>
            {msg("board.ai.apply.reverted")}
          </p>
          {undone === "partial" && (
            <p className="mt-1 text-[11px] text-amber-800">{msg("board.ai.joint.undonePartial")}</p>
          )}
        </div>
      );
    }
    return (
      <div className="space-y-3">
        <div className="rounded-lg border border-teal-200 bg-teal-50 px-3 py-2.5">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-teal-800">
            <span aria-hidden>✓</span>
            {plural("board.ai.joint.applied", outcome.checkpoints.length)}
          </p>
        </div>
        <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50/70 px-3 py-2">
          <span aria-hidden className="text-slate-400">⟲</span>
          <p className="min-w-0 flex-1 text-[11px] text-slate-600">{msg("board.ai.joint.savepoint")}</p>
          <button
            type="button"
            disabled={undoing}
            onClick={onUndo}
            className="btn btn-ghost shrink-0 px-3 py-1.5 text-xs font-semibold text-violet-700 disabled:opacity-50"
          >
            {undoing ? msg("board.ai.apply.undoing") : msg("board.ai.apply.undo")}
          </button>
        </div>
      </div>
    );
  }

  // A stale board is the only refusal a fresh run can fix — a real court clash
  // is not, and offering the same button for it sends the organiser round a
  // loop that cannot end (and charges for each lap).
  if (outcome?.status === "seq_conflict") {
    return (
      <div className="space-y-3">
        <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-800">
          <p className="flex items-center gap-1.5 font-semibold">
            <span aria-hidden>⚠</span>
            {msg("board.ai.apply.staleTitle")}
          </p>
          <p className="mt-0.5 text-amber-700">{msg("board.ai.apply.stale")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onReRun}
            className="ai-run inline-flex items-center justify-center gap-2 rounded-lg bg-gradient-to-br from-violet-600 to-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:brightness-110"
          >
            <span aria-hidden>✦</span>
            {msg("board.ai.apply.reRunRefine")}
          </button>
          <button type="button" onClick={onDiscard} className="btn btn-ghost px-3 py-1.5 text-xs text-slate-500">
            {msg("board.ai.apply.discard")}
          </button>
        </div>
      </div>
    );
  }

  const placedPerDivision = selected
    .map((id) => ({
      id,
      name: nameOf.get(id) ?? id,
      placed: plan.proposal.filter((p) => p.division_id === id && !setAside.has(p.fixture_id)).length,
    }))
    .filter((d) => nameOf.has(d.id));
  const clash = personClashRisk(plan.warnings, divisions, selected);

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-700">{msg("board.ai.joint.reviewLead")}</p>
      <p className="rounded-lg border border-slate-200 bg-slate-50/70 px-3 py-2 text-xs leading-relaxed text-slate-600">
        {plan.summary}
      </p>

      {/* The ledger: one row per division, in the order it was picked and
          priced. This is what "the run covered all of them" looks like. */}
      <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
        {placedPerDivision.map((d) => (
          <li key={d.id} className="flex items-center gap-2 px-3 py-2">
            <DivisionChip id={d.id} name={d.name} />
            <span className="ml-auto shrink-0 text-[11px] tabular-nums text-slate-500">
              {plural("board.ai.joint.divisionPlaced", d.placed)}
            </span>
          </li>
        ))}
      </ul>

      {plan.skipped_divisions.length > 0 && (
        <Caution>
          {msg("board.ai.joint.skipped", {
            divisions: plan.skipped_divisions.map((d) => d.name).join(", "),
          })}
        </Caution>
      )}

      {plan.divergent_courts.length > 0 && (
        <Caution title={msg("board.ai.joint.courtsDivergentTitle")}>
          {msg("board.ai.joint.courtsDivergent", { courts: plan.divergent_courts.join(", ") })}
        </Caution>
      )}

      {clash.count > 0 && (
        <Caution>
          {plural("board.ai.joint.personClash", clash.count, {
            divisions: clash.divisions.join(", "),
          })}
        </Caution>
      )}

      {plan.warnings.length > 0 && (
        <p className="text-[11px] text-slate-500">
          {plural("board.ai.joint.warnings", plan.warnings.length)}
        </p>
      )}

      {plan.blocking.length > 0 && (
        <div className="rounded-lg border border-red-200 bg-red-50/60 p-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-red-700">
            {msg("board.ai.joint.blockingTitle")}
          </p>
          <p className="mt-0.5 text-[11px] text-red-700/80">{msg("board.ai.joint.blockingHint")}</p>
          <ul className="mt-2 space-y-1.5">
            {plan.blocking.map((c) => {
              const f = meta.get(c.fixtureId);
              const divisionId = divisionOf.get(c.fixtureId);
              return (
                <li
                  key={`${c.fixtureId}-${c.reason}`}
                  className="rounded-md border border-red-100 bg-white px-2 py-1.5"
                >
                  <div className="flex items-center gap-2">
                    {divisionId && (
                      <DivisionChip id={divisionId} name={nameOf.get(divisionId) ?? divisionId} />
                    )}
                    <span className="min-w-0 flex-1 truncate text-xs text-slate-700">
                      {f?.matchup ?? c.fixtureId.slice(0, 8)}
                    </span>
                    <label className="inline-flex shrink-0 cursor-pointer items-center gap-1 text-[11px] text-slate-600">
                      <input
                        type="checkbox"
                        data-set-aside={c.fixtureId}
                        checked={setAside.has(c.fixtureId)}
                        onChange={() => onToggleExclude(c.fixtureId)}
                        className="h-3.5 w-3.5 rounded border-slate-300 text-violet-600"
                      />
                      {msg("board.ai.joint.setAside")}
                    </label>
                  </div>
                  <p className="mt-0.5 text-[11px] text-red-700">
                    {msg(blockingConflictKey(c.reason))}
                    {c.detail ? ` — ${c.detail}` : ""}
                  </p>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {outcome?.status === "conflict" && (
        <div role="alert" className="space-y-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-700">
          <p className="font-semibold">
            {plural("board.ai.joint.conflict", outcome.conflicts.length)}
          </p>
          {/* A set-aside fixture stays where it is, so it is still holding that
              court — an obstacle that did not exist when the plan was made. The
              refusal is correct; saying nothing makes it look like a mystery. */}
          {excluded.length > 0 && <p>{msg("board.ai.joint.conflictAside")}</p>}
        </div>
      )}

      {outcome?.status === "error" && (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          <span className="font-semibold">{msg("board.ai.errorLabel")}</span>{" "}
          {msg(applyErrorKey(outcome) as MessageKey)}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button
          type="button"
          data-ai-joint-apply
          disabled={applying || placedPerDivision.every((d) => d.placed === 0)}
          onClick={onApply}
          className="ai-run inline-flex items-center justify-center gap-2 rounded-lg bg-gradient-to-br from-violet-600 to-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {applying ? (
            <>
              <Spinner />
              {msg("board.ai.joint.applying")}
            </>
          ) : (
            <>
              <span aria-hidden>✦</span>
              {msg("board.ai.joint.apply")}
            </>
          )}
        </button>
        <button
          type="button"
          disabled={applying}
          onClick={onBack}
          className="btn btn-ghost px-3 py-1.5 text-xs disabled:opacity-50"
        >
          {msg("board.ai.joint.back")}
        </button>
        <button
          type="button"
          disabled={applying}
          onClick={onDiscard}
          className="btn btn-ghost ml-auto px-3 py-1.5 text-xs text-slate-500 disabled:opacity-50"
        >
          {msg("board.ai.apply.discard")}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The console
// ---------------------------------------------------------------------------

/** The ghost overlay's source — the two fields the board's ghost derivation
 *  reads, so a joint plan and a division plan can both feed it. */
export interface JointProposalMirror {
  proposal: { fixture_id: string; scheduled_at: string; court_label: string; division_id?: string }[];
  blocking: { fixtureId: string }[];
}

export function AiCompetitionConsole({
  competitionId,
  divisions,
  aiAllowed,
  currency,
  fixtures,
  onClose,
  onApplied,
  onProposalChange,
}: {
  competitionId: string;
  /** Every division on the board, in board order. */
  divisions: JointDivision[];
  /** Client-side `scheduling.ai` read — false renders the paywall in the dock
   *  with no network call. The server re-checks it, plus
   *  `scheduling.multi_division`, on all three joint endpoints. */
  aiAllowed: boolean;
  currency: Currency;
  /** The board's live fixtures across every division — the blocked rows' labels. */
  fixtures: AiConsoleFixture[];
  onClose: () => void;
  onApplied?: () => void;
  /** Mirrors the current proposal to the board so it can paint grid ghosts. */
  onProposalChange?: (plan: JointProposalMirror | null) => void;
}) {
  const msg = useMsg();
  const plural = usePlural();
  const picker = useMemo(() => pickerDivisions(divisions), [divisions]);
  const [selected, setSelected] = useState<string[]>(() => defaultSelectedDivisionIds(picker));
  const [instruction, setInstruction] = useState("");
  const [rungs, setRungs] = useState<Record<string, number | null>>({});
  const [plan, setPlan] = useState<AiCompetitionPlanResponse | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<{ message: string; key: string } | null>(null);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [applying, setApplying] = useState(false);
  const [outcome, setOutcome] = useState<JointApplyOutcome | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [undone, setUndone] = useState<"no" | "full" | "partial">("no");
  // The reader's own zone — the one the board's clock labels are rendered in.
  // Read lazily (the dock only ever mounts on a click, so there is no SSR pass
  // to disagree with) rather than threaded from the server.
  const [viewerZone] = useState(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return "UTC";
    }
  });

  const lines = jointQuoteLines(divisions, selected, rungs);
  // ONE quote. The CTA and the receipt read the same object, because pricing the
  // same run twice is exactly how a button and the card above it disagree.
  const quote = quoteFor(lines);
  const divergent = divergentCourts(divisions, selected);
  const zones = timezoneSpread(divisions, selected);
  const canRun = canRunJoint({ selected, instruction, running });

  const run = useCallback(
    async (prior?: AiCompetitionPlanResponse | null) => {
      const text = instruction.trim();
      if (text.length < 3) return;
      setRunning(true);
      setError(null);
      try {
        const res = await apiV1<AiCompetitionPlanResponse>(
          `/api/v1/competitions/${competitionId}/schedule/ai-plan`,
          {
            method: "POST",
            json: {
              division_ids: selected,
              instruction: text,
              mode: prior ? "refine" : "generate",
              ...rungOverrides(rungs, selected),
              ...(prior
                ? {
                    prior: {
                      instruction: text,
                      assignments: prior.proposal.map((p) => ({
                        fixture_id: p.fixture_id,
                        scheduled_at: p.scheduled_at,
                        court_label: p.court_label,
                        division_id: p.division_id,
                      })),
                    },
                  }
                : {}),
            },
          },
        );
        setPlan(res);
        setExcluded([]);
        setOutcome(null);
        setUndone("no");
        onProposalChange?.(res);
      } catch (err) {
        const status = err instanceof ApiV1Error ? err.status : 0;
        const code =
          err instanceof ApiV1Error
            ? typeof err.extra.feature_key === "string"
              ? err.extra.feature_key
              : err.code
            : undefined;
        const key = aiErrorKey(status, code);
        setError({ message: msg(key), key });
      }
      setRunning(false);
    },
    [competitionId, instruction, msg, onProposalChange, rungs, selected],
  );

  const doApply = useCallback(async () => {
    if (!plan || applying) return;
    setApplying(true);
    setUndone("no");
    const result = await applyJointPlan({
      competitionId,
      divisions: jointApplyDivisions(plan, divisions),
      audit: {
        instruction: instruction.trim().slice(0, 500),
        summary: plan.summary.slice(0, 600),
        model: AI_APPLY_MODEL,
        repair_rounds: plan.usage.repair_rounds,
      },
      excludedFixtureIds: excluded,
    });
    setApplying(false);
    setOutcome(result);
    if (result.status === "applied") onApplied?.();
  }, [applying, competitionId, divisions, excluded, instruction, onApplied, plan]);

  const undo = useCallback(async () => {
    if (!outcome || undoing) return;
    setUndoing(true);
    const ok = await undoJointApply(outcome.checkpoints);
    setUndone(ok ? "full" : "partial");
    setUndoing(false);
    onApplied?.();
  }, [onApplied, outcome, undoing]);

  const close = useCallback(() => {
    onProposalChange?.(null);
    onClose();
  }, [onClose, onProposalChange]);

  const brief = (
    <div className="space-y-3">
      <AiDivisionPicker
        divisions={picker}
        selected={selected}
        onChange={setSelected}
        msg={msg}
        busy={running}
      />

      {divergent.length > 0 && (
        <Caution title={msg("board.ai.joint.courtsDivergentTitle")}>
          {msg("board.ai.joint.courtsDivergent", { courts: divergent.join(", ") })}
        </Caution>
      )}

      {zones.length > 0 && (
        <Caution title={msg("board.ai.joint.tzMixedTitle")}>
          <p>{msg("board.ai.joint.tzMixed", { zone: viewerZone })}</p>
          <ul className="mt-0.5">
            {zones.map((z) => (
              <li key={z.tz}>
                {msg("board.ai.joint.tzDivisions", { tz: z.tz, divisions: z.divisions.join(", ") })}
              </li>
            ))}
          </ul>
        </Caution>
      )}

      <div>
        <label htmlFor="ai-joint-instruction" className="label">
          {msg("board.ai.joint.instructionLabel")}
        </label>
        <textarea
          id="ai-joint-instruction"
          className="input min-h-24 resize-y"
          value={instruction}
          disabled={running}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder={msg("board.ai.joint.instructionPlaceholder")}
        />
        <p className="mt-1 text-[11px] text-slate-500">{msg("board.ai.joint.instructionHint")}</p>
      </div>

      <AiQuoteCard
        lines={lines}
        onChange={(key, rung) => setRungs((cur) => ({ ...cur, [key]: rung }))}
        msg={msg}
        busy={running}
      />

      {error &&
        (error.key === "board.ai.error.outOfCredits" ? (
          <AiOutOfCredits currency={currency} />
        ) : (
          <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            <span className="font-semibold">{msg("board.ai.errorLabel")}</span> {error.message}
          </p>
        ))}

      <button
        type="button"
        data-ai-joint-run
        data-ai-joint-cta-credits={quote.credits}
        onClick={() => void run()}
        disabled={!canRun}
        className="ai-run inline-flex w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-br from-violet-600 to-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {running ? (
          <>
            <Spinner />
            {msg("board.ai.joint.running")}
          </>
        ) : (
          <>
            <span aria-hidden>✦</span>
            {msg("board.ai.quote.cta", {
              action: msg("board.ai.joint.run"),
              credits: plural("board.ai.quote.credits", quote.credits),
            })}
          </>
        )}
      </button>
    </div>
  );

  const body = !aiAllowed ? (
    <UpgradeGate feature="scheduling.ai" />
  ) : plan ? (
    <JointReviewStep
      plan={plan}
      divisions={divisions}
      selected={selected}
      excluded={excluded}
      fixtures={fixtures}
      applying={applying}
      outcome={outcome}
      undoing={undoing}
      undone={undone}
      onToggleExclude={(id) =>
        setExcluded((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))
      }
      onApply={() => void doApply()}
      onDiscard={close}
      onUndo={() => void undo()}
      onBack={() => {
        setPlan(null);
        setOutcome(null);
        onProposalChange?.(null);
      }}
      onReRun={() => void run(plan)}
      msg={msg}
    />
  ) : (
    brief
  );

  return (
    <aside
      role="region"
      aria-label={msg("board.ai.joint.aria")}
      onKeyDown={(e) => {
        if (e.key === "Escape") close();
      }}
      className="ai-console fixed inset-x-0 bottom-0 z-40 max-h-[82vh] overflow-y-auto rounded-t-2xl border border-slate-200 bg-white shadow-2xl outline-none sm:inset-x-auto sm:top-20 sm:right-4 sm:bottom-auto sm:max-h-[80vh] sm:w-[27rem] sm:rounded-2xl"
    >
      <div className="relative overflow-hidden rounded-t-2xl border-b border-slate-200 bg-gradient-to-br from-violet-600 to-indigo-600 px-4 py-3 text-white">
        <div className="sheet-handle bg-white/40 sm:hidden" aria-hidden />
        <div className="flex items-center gap-2">
          <span aria-hidden className="text-lg leading-none">✦</span>
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight">
            {/* The same name the division console wears: it is the same
                action, and the subtitle below is what says it covers several
                divisions. A surface-specific title would truncate at 375px and
                teach two words for one feature. */}
            {msg("board.ai.title")}
          </h2>
          <span className="shrink-0 rounded-full bg-white/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
            {msg("board.ai.beta")}
          </span>
          <PlanBadge feature="scheduling.multi_division" />
          <button
            type="button"
            onClick={close}
            aria-label={msg("board.ai.close")}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-white/80 transition hover:bg-white/20 hover:text-white"
          >
            ✕
          </button>
        </div>
        <p className="mt-1 text-xs text-white/85">{msg("board.ai.joint.subtitle")}</p>
      </div>

      <div className="p-4">{body}</div>
      <p className="sticky bottom-0 border-t border-slate-100 bg-white/95 px-4 py-2 text-[11px] text-slate-500 backdrop-blur-sm">
        {msg("board.ai.disclaimer")}
      </p>
    </aside>
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
