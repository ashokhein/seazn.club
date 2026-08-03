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
import { useCallback, useMemo, useRef, useState } from "react";
import { useMsg, usePlural } from "@/components/i18n/dict-provider";
import { UpgradeGate } from "@/components/upgrade-gate";
import { PlanBadge } from "@/components/plan-badge";
import type { Currency } from "@/lib/currency";
import type { MessageKey } from "@/lib/messages";
import type { AiCompetitionPlanResponse } from "@/server/api-v1/schemas";
import { DivisionChip } from "./ai-division-chip";
import { AiOutOfCredits } from "./ai-out-of-credits";
import {
  AiDivisionPicker,
  defaultSelectedDivisionIds,
  jointRunReady,
  selectableDivisions,
  type PickerDivision,
} from "./ai-division-picker";
import { AiQuoteCard, quoteFor, type QuoteCardLine } from "./ai-quote-card";
import {
  aiErrorKey,
  applyErrorKey,
  canRun,
  initialAiConsoleState,
  type AiConsoleState,
} from "./ai-console-state";
import { AiInstructionPreview } from "./ai-instruction-preview";
import { AI_APPLY_MODEL } from "./ai-apply";
import { runJointPlan, runJointPreview } from "./ai-joint-run";
import {
  applyJointPlan,
  undoJointApply,
  type JointApplyDivision,
  type JointApplyOutcome,
} from "./ai-joint-apply";
import { blockingConflictKey, type AiConsoleFixture } from "./ai-diff";
import { AiReviewPanel } from "./ai-review-panel";
import { buildReviewRows } from "./ai-review";

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
 * The joint plan reports a person double-booking as a WARNING; the joint apply
 * REFUSES it — but only when the division that OWNS the overlapping fixture
 * sets `crossPersonClash: hard`. The server is explicit that this is "NOT a
 * union over the request" (competition-schedule-apply.ts:511-521), so a count
 * that unions over the selection tells the organiser that Apply will reject
 * clashes it will happily accept, which invites abandoning a good plan.
 *
 * Two filters, therefore, and both are load-bearing: only `person_overlap`
 * warnings (a rest or blackout warning is never refused), and only those whose
 * owning division blocks. Ownership comes from the proposal's `division_id`,
 * which the SERVER resolved.
 */
export function personClashRisk(
  plan: {
    proposal: { fixture_id: string; division_id: string }[];
    warnings: { fixtureId: string; reason: string }[];
  },
  divisions: JointDivision[],
  selected: string[],
): { count: number; divisions: string[] } {
  const chosen = new Set(selected);
  const blocks = new Map(
    divisions.filter((d) => chosen.has(d.id)).map((d) => [d.id, d] as const),
  );
  const ownerOf = new Map(plan.proposal.map((p) => [p.fixture_id, p.division_id]));
  const refused = plan.warnings.filter((w) => {
    if (w.reason !== "person_overlap") return false;
    const owner = ownerOf.get(w.fixtureId);
    return owner !== undefined && blocks.get(owner)?.personClashBlocks === true;
  });
  if (refused.length === 0) return { count: 0, divisions: [] };
  const names = [
    ...new Set(refused.map((w) => blocks.get(ownerOf.get(w.fixtureId) as string)?.name ?? "")),
  ].filter((n) => n !== "");
  return { count: refused.length, divisions: names };
}

/**
 * The selection, narrowed to what can still be run.
 *
 * The initial selection is computed once, at mount. A `router.refresh()` that
 * freezes a division (or empties it) under an open console would otherwise
 * leave that row displayed unchecked and outside "N of M selected" while
 * `jointQuoteLines` went on pricing it and the run went on sending it — an
 * over-quote, followed by a 409 SCHEDULE_LOCKED that refuses the WHOLE run.
 * Deriving during render rather than syncing in an effect means the picker, the
 * receipt and the request cannot disagree even for one frame.
 */
export function usableSelection(selected: string[], picker: PickerDivision[]): string[] {
  const usable = new Set(selectableDivisions(picker).map((d) => d.id));
  return selected.filter((id) => usable.has(id));
}

/**
 * The joint console's compile, and the division set it was taken over.
 *
 * The slice is the division console's own (`AiConsoleState["preview"]`) rather
 * than a second shape, so `canRun` is the ONE definition of "has the organiser
 * agreed to anything". `divisionIds` is the joint console's addition and the
 * one thing the shared gate cannot know: the resolver reads the window from the
 * divisions in scope, so a compile taken over a different set describes a
 * different run — which is exactly what the server answers 409 PREVIEW_STALE to.
 */
export interface JointPreview {
  slice: AiConsoleState["preview"];
  divisionIds: string[];
}

/** No compile in hand. One literal, so every path that drops a preview drops
 *  all of it and no stale id survives to be posted. */
export const IDLE_JOINT_PREVIEW: JointPreview = {
  slice: { status: "idle", data: null, id: null, asPreference: false, instruction: null },
  divisionIds: [],
};

/** Same divisions, whatever order the picker put them in — a reorder is the
 *  same run, and sending the organiser back to re-check it would be noise. */
function sameDivisions(a: string[], b: string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((id) => right.has(id));
}

/**
 * Is the compile on screen still about the run on offer?
 *
 * Derived during render rather than cleared in an effect, for the reason
 * `usableSelection` gives one screenful up: a `router.refresh()` can narrow the
 * selection under an open console with nobody having clicked anything, and a
 * card that survives one frame longer than the run it describes is a confirm
 * button for rules that are no longer the rules.
 */
export function previewCurrent(
  preview: JointPreview,
  run: { instruction: string; selected: string[] },
): boolean {
  return (
    preview.slice.status === "ready" &&
    preview.slice.instruction === run.instruction.trim() &&
    sameDivisions(preview.divisionIds, run.selected)
  );
}

/** The reasons a joint COMPILE cannot start. Everything the run needs except
 *  the run's own gate — this is the click that produces what that gate wants. */
export function canCompileJoint(input: {
  selected: string[];
  instruction: string;
  running: boolean;
  checking: boolean;
}): boolean {
  return (
    jointRunReady(input.selected) &&
    input.instruction.trim().length >= 3 &&
    !input.running &&
    !input.checking
  );
}

/**
 * The independent reasons a joint run cannot start, in one place so the CTA and
 * any future caller cannot disagree about them.
 *
 * The selection rule counts DISTINCT divisions (`jointRunReady`), because the
 * orchestrator de-duplicates before it counts. Everything else defers to
 * `canRun`, the division console's own predicate (W5 #400): a joint run spends
 * exactly as a single one does, so it refuses to spend for exactly the same
 * reason — nobody has yet been shown what the sentence compiled to.
 */
export function canRunJoint(input: {
  selected: string[];
  instruction: string;
  running: boolean;
  preview: JointPreview;
}): boolean {
  if (!jointRunReady(input.selected)) return false;
  if (!previewCurrent(input.preview, input)) return false;
  return canRun({
    ...initialAiConsoleState,
    instruction: input.instruction,
    run: input.running ? "running" : "idle",
    preview: input.preview.slice,
  });
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

/**
 * A note about the run's SCOPE, in the division ledger's own register.
 *
 * Quieter than `Caution` on purpose. These say which divisions the run covered
 * and which court labels only some of them know — division-level facts, not
 * per-fixture findings — and they sit next to the review card, whose header
 * carries a count of the rows underneath it. Amber next to amber made that
 * number look like it should have covered these too (Task 5 review). The
 * ruling was to demote, not to count: a court-name mismatch and a flagged
 * placement are different units, and one number cannot mean both.
 */
function ScopeNote({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div
      data-scope-note="1"
      className="flex items-start gap-1.5 rounded-md border border-slate-200 bg-slate-50/70 px-2.5 py-1.5 text-[11px] leading-snug text-slate-600"
    >
      <span aria-hidden className="mt-px shrink-0 text-slate-400">
        ⓘ
      </span>
      <div className="min-w-0">
        {title && <p className="font-semibold text-slate-700">{title}</p>}
        <div>{children}</div>
      </div>
    </div>
  );
}

/** A failed RUN (not a failed apply). Rendered in both steps, because the run
 *  can be started from either — and an out-of-credits failure gets the top-up
 *  block rather than a red line, since AI is metered on every tier. */
function RunError({
  error,
  currency,
  msg,
}: {
  error: { message: string; key: string } | null;
  currency: Currency;
  msg: ReturnType<typeof useMsg>;
}) {
  if (!error) return null;
  if (error.key === "board.ai.error.outOfCredits") return <AiOutOfCredits currency={currency} />;
  return (
    <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
      <span className="font-semibold">{msg("board.ai.errorLabel")}</span> {error.message}
    </p>
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
  undoFailed,
  running,
  error,
  currency,
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
  /** Division ids a partial undo could not revert — they are still carrying the
   *  AI board, and their anchors are still valid, so they are both what the
   *  copy must name and what the retry sends. */
  undoFailed: string[];
  /** A plan run started from HERE (the stale-board re-run) is in flight. The
   *  button's `disabled` is the affordance; `runJointPlan`'s in-flight ref is
   *  the actual protection against spending twice. */
  running: boolean;
  /** A failed run. The review step renders whenever a plan exists, so without
   *  this a 402/403/500 on the re-run changed nothing at all on screen and the
   *  old proposal went on looking successful. */
  error: { message: string; key: string } | null;
  currency: Currency;
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
  // Which division owns a fixture. The BOARD first, then the proposal.
  //
  // The proposal alone is not enough and never was: it carries `division_id`
  // for everything it placed, and the server dedupes `unschedulable` against
  // exactly that list — so a proposal-derived map answers null for every row on
  // the review card that the run could not place, which on this console is the
  // only surface where the chip is the sole thing naming the division. The
  // board holds every fixture, placed or not, so it answers those. The
  // proposal stays as the fallback for a fixture the board no longer holds.
  const divisionOf = new Map<string, string>(plan.proposal.map((p) => [p.fixture_id, p.division_id]));
  for (const f of fixtures) if (f.division_id) divisionOf.set(f.id, f.division_id);
  /** Never guessed: a fixture whose division is unknown gets no chip at all. */
  const divisionFor = (fixtureId: string): { id: string; name: string } | null => {
    const id = divisionOf.get(fixtureId);
    return id ? { id, name: nameOf.get(id) ?? id } : null;
  };
  const setAside = new Set(excluded);

  // Applied — the confirmation, then the restore point that makes it reversible.
  if (outcome?.status === "applied") {
    // A PARTIAL undo is not a revert, and must not wear the revert headline: a
    // reader who scans the ✓ line would take away the opposite of what
    // happened, while the divisions named below are still on the AI board. The
    // anchors stay valid, so the first remedy offered is another attempt at
    // exactly those divisions, not a trip to each division's own page.
    if (undone === "partial") {
      return (
        <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-amber-900">
            <span aria-hidden>⚠</span>
            {msg("board.ai.joint.undonePartialTitle")}
          </p>
          <p className="text-[11px] text-amber-900">
            {msg("board.ai.joint.undonePartial", {
              divisions: undoFailed.map((id) => nameOf.get(id) ?? id).join(", "),
            })}
          </p>
          <button
            type="button"
            disabled={undoing}
            onClick={onUndo}
            className="btn btn-ghost px-3 py-1.5 text-xs font-semibold text-violet-700 disabled:opacity-50"
          >
            {undoing ? msg("board.ai.apply.undoing") : msg("board.ai.joint.undoRetry")}
          </button>
        </div>
      );
    }
    if (undone === "full") {
      return (
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
          <p className="flex items-center gap-1.5 text-sm font-medium text-slate-700">
            <span aria-hidden>⟲</span>
            {msg("board.ai.apply.reverted")}
          </p>
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
          {/* This button SPENDS. A joint run takes tens of seconds, so without
              an in-flight state a second click is the obvious move — and the
              plan endpoint has no idempotency key, so it is a second charge.
              The `disabled` here is the affordance; the guard that actually
              stops the double-spend is `runJointPlan`'s in-flight ref, which is
              set synchronously and so also covers the click that beats this
              re-render. */}
          <button
            type="button"
            data-ai-joint-rerun
            disabled={running}
            onClick={onReRun}
            className="ai-run inline-flex items-center justify-center gap-2 rounded-lg bg-gradient-to-br from-violet-600 to-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {running ? (
              <>
                <Spinner />
                {msg("board.ai.joint.running")}
              </>
            ) : (
              <>
                <span aria-hidden>✦</span>
                {msg("board.ai.apply.reRunRefine")}
              </>
            )}
          </button>
          <button
            type="button"
            disabled={running}
            onClick={onDiscard}
            className="btn btn-ghost px-3 py-1.5 text-xs text-slate-500 disabled:opacity-50"
          >
            {msg("board.ai.apply.discard")}
          </button>
        </div>
        <RunError error={error} currency={currency} msg={msg} />
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
  const clash = personClashRisk(plan, divisions, selected);
  // One array for the review card and its count — the same builder the division
  // console uses, so the two consoles cannot say different things about the
  // same run.
  const reviewRows = buildReviewRows(plan);

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

      {/* DIVISION-LEVEL notes, deliberately not amber and deliberately not
          counted (#388 follow-up, Task 5 review ruling). Both are facts about
          the run's SCOPE — which divisions it covered, and which court labels
          only some of them know — while the counted card below holds
          per-fixture findings. An uncounted amber note beside a counted one
          reads as the count having missed something; folding them into
          `reviewRowCount` would be worse still, making one number mean two
          different units. So they sit with the ledger they are about, in the
          ledger's own register. */}
      {(plan.skipped_divisions.length > 0 || plan.divergent_courts.length > 0) && (
        <div data-scope-notes="1" className="space-y-1">
          {plan.skipped_divisions.length > 0 && (
            <ScopeNote>
              {msg("board.ai.joint.skipped", {
                divisions: plan.skipped_divisions.map((d) => d.name).join(", "),
              })}
            </ScopeNote>
          )}
          {plan.divergent_courts.length > 0 && (
            <ScopeNote title={msg("board.ai.joint.courtsDivergentTitle")}>
              {msg("board.ai.joint.courtsDivergent", { courts: plan.divergent_courts.join(", ") })}
            </ScopeNote>
          )}
        </div>
      )}

      {clash.count > 0 && (
        <Caution>
          {plural("board.ai.joint.personClash", clash.count, {
            divisions: clash.divisions.join(", "),
          })}
        </Caution>
      )}

      {/* Everything the run flagged, could not place, or assumed — the SAME
          card the division console draws, from the same builder, with the same
          count (#388). It replaced a hand-rolled warnings list whose header
          read `plan.warnings.length`, so the number spoke for one of the three
          kinds of row underneath it. */}
      <AiReviewPanel rows={reviewRows} fixtures={fixtures} divisionFor={divisionFor} />

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
                    <span className="min-w-0 flex-1 truncate text-xs text-slate-700">
                      {f?.matchup ?? c.fixtureId.slice(0, 8)}
                    </span>
                    {/* The only control in the list, so it keeps the row it
                        acts on — the division and the reason go underneath. */}
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
                  <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-red-700">
                    {divisionId && (
                      <DivisionChip id={divisionId} name={nameOf.get(divisionId) ?? divisionId} />
                    )}
                    <span className="min-w-0 truncate">
                      {msg(blockingConflictKey(c.reason))}
                      {c.detail ? ` — ${c.detail}` : ""}
                    </span>
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

      {/* A re-run started from here can fail, and this step renders whenever a
          plan exists — so without this the old proposal simply sat there
          looking successful while a 402 went unmentioned. */}
      <RunError error={error} currency={currency} msg={msg} />

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
  onRefetch,
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
  /** Pull the board WITHOUT claiming a write landed. `divisions[].seq` is a
   *  render-time token and `doApply` re-derives `expected_seq` from it, so a
   *  stale-board refusal that does not refetch leaves the recovery button
   *  re-sending the same stale seq — a 409 loop the organiser pays for every
   *  lap, since the re-run spends. Same wire as the division console's. */
  onRefetch?: () => void;
  /** Mirrors the current proposal to the board so it can paint grid ghosts. */
  onProposalChange?: (plan: JointProposalMirror | null) => void;
}) {
  const msg = useMsg();
  const plural = usePlural();
  const picker = useMemo(() => pickerDivisions(divisions), [divisions]);
  // The organiser's picks, and then the picks NARROWED to what can still be
  // run. Derived during render rather than synced in an effect, so the picker,
  // the receipt and the request cannot disagree even for one frame when a
  // refresh freezes a division under an open console.
  const [picked, setPicked] = useState<string[]>(() => defaultSelectedDivisionIds(picker));
  const selected = useMemo(() => usableSelection(picked, picker), [picked, picker]);
  const [instruction, setInstruction] = useState("");
  // W5 (#400) — the compiled instruction the organiser has been shown but not
  // yet paid for. Held here rather than in the reducer the division console
  // uses because this console has no reducer; the GATE is shared even so
  // (`canRunJoint` defers to `canRun`), which is the part that must not fork.
  const [preview, setPreview] = useState<JointPreview>(IDLE_JOINT_PREVIEW);
  const [checking, setChecking] = useState(false);
  const [rungs, setRungs] = useState<Record<string, number | null>>({});
  const [plan, setPlan] = useState<AiCompetitionPlanResponse | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<{ message: string; key: string } | null>(null);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [applying, setApplying] = useState(false);
  const [outcome, setOutcome] = useState<JointApplyOutcome | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [undone, setUndone] = useState<"no" | "full" | "partial">("no");
  const [undoFailed, setUndoFailed] = useState<string[]>([]);
  // THE double-spend guard. A ref, not state: state is read through a closure a
  // second click can beat, and this has to hold for exactly that click. See
  // runJointPlan.
  const inFlight = useRef(false);
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
  // The gate, and the click that feeds it. Both derived during render, so a
  // refresh that narrows the selection cannot leave a confirm button up for
  // rules compiled over divisions that are no longer in the run.
  const confirmed = canRunJoint({ selected, instruction, running, preview });
  const canCompile = canCompileJoint({ selected, instruction, running, checking });
  // The card is withheld once the organiser has taken the preference fallback:
  // they have already answered its question, and leaving it up asks again.
  const previewData =
    !running && !preview.slice.asPreference && previewCurrent(preview, { instruction, selected })
      ? preview.slice.data
      : null;

  // Stage 1 only: compiles the sentence over the SELECTED divisions, spends no
  // credit and calls no architect, so the organiser can read the rules before
  // paying to run against them. Declining the result is a pure client action —
  // `setPreview(IDLE_JOINT_PREVIEW)` and no request at all — and that is the
  // entire gate.
  const compile = useCallback(async () => {
    const result = await runJointPreview(
      { competitionId, selected, instruction, rungs },
      {
        inFlight,
        onStart: () => {
          setChecking(true);
          setError(null);
          // Records the sentence and the divisions being compiled AT the moment
          // the request goes out, so the answer can only ever be attached to
          // the run it was asked about.
          setPreview({
            slice: {
              status: "loading",
              data: null,
              id: null,
              asPreference: false,
              instruction: instruction.trim(),
            },
            divisionIds: selected,
          });
        },
      },
    );
    if (result.status === "refused") return; // something else is already in the air
    setChecking(false);
    if (result.status === "compiled") {
      // `id` comes off the response and nowhere else: a failed compile carries
      // no preview_id, which is what keeps the run gated until the organiser
      // explicitly takes the preference fallback.
      setPreview((cur) => ({
        ...cur,
        slice: { ...cur.slice, status: "ready", data: result.preview, id: result.preview.preview_id ?? null },
      }));
      return;
    }
    setPreview(IDLE_JOINT_PREVIEW);
    const key = aiErrorKey(result.httpStatus, result.code);
    setError({ message: msg(key), key });
  }, [competitionId, instruction, msg, rungs, selected]);

  const run = useCallback(
    async (prior?: AiCompetitionPlanResponse | null) => {
      // The gate, enforced where the request is made rather than only on the
      // button that makes it. The card decides which buttons to draw from
      // `preview.failed` while the gate reads `preview_id`, which is optional
      // on the wire — two different fields answering one question, so a
      // schema-valid `{ failed: false, preview_id: undefined }` reached a
      // confirm the gate refuses and this callback charged for it. That the
      // server always pairs the two is a server invariant propping up a client
      // guarantee, which is the shape of bug this wave exists to remove.
      //
      // Scoped to a fresh run, exactly as the division console scopes it: the
      // stale-board recovery re-runs over a proposal that was already previewed
      // and paid for, and has no brief in front of it to confirm.
      if (!prior && !canRunJoint({ selected, instruction, running, preview })) return;
      // Body-building, the POST and the in-flight guard all live in
      // runJointPlan: this endpoint spends credits with no idempotency key, and
      // what is SENT needs a test boundary as much as what is displayed.
      //
      // `previewId` is read from the closure here, BEFORE `onStart` drops the
      // slice: the server marks a confirmed preview consumed, so holding it
      // would leave the console offering a token that can no longer be
      // redeemed. Null when the organiser took the preference fallback — the
      // one path where nothing was confirmed.
      const result = await runJointPlan(
        { competitionId, selected, instruction, rungs, prior, previewId: preview.slice.id },
        {
          inFlight,
          // Fires only after the guard passes, so a refused second click cannot
          // clear the error or restart the spinner of the run still going.
          onStart: () => {
            setRunning(true);
            setError(null);
            // The run SPENDS the preview: a second POST carrying the same id is
            // a 409, so the console must stop offering it.
            setPreview(IDLE_JOINT_PREVIEW);
          },
        },
      );
      if (result.status === "refused") return; // the first run still owns the UI
      setRunning(false);
      if (result.status === "planned") {
        setPlan(result.plan);
        setExcluded([]);
        setOutcome(null);
        setUndone("no");
        setUndoFailed([]);
        onProposalChange?.(result.plan);
        return;
      }
      const key = aiErrorKey(result.httpStatus, result.code);
      setError({ message: msg(key), key });
    },
    [competitionId, instruction, msg, onProposalChange, preview, running, rungs, selected],
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
    // The recovery branch below this offers a re-run that SPENDS, and the apply
    // after it re-derives `expected_seq` from the `divisions` prop. Pull the
    // fresh board now, or that lap is charged for a plan that can only 409
    // again. Only for `seq_conflict`: a real court clash is not something a
    // refresh fixes, and an applied board goes through `onApplied`.
    if (result.status === "seq_conflict") onRefetch?.();
  }, [applying, competitionId, divisions, excluded, instruction, onApplied, onRefetch, plan]);

  const undo = useCallback(async () => {
    if (!outcome || undoing) return;
    setUndoing(true);
    // A retry sends ONLY the anchors that failed — the divisions that already
    // reverted would otherwise be restored a second time for no reason. The
    // anchors stay valid after a refusal, which is what makes the retry
    // possible at all.
    const pending =
      undoFailed.length > 0
        ? outcome.checkpoints.filter((c) => undoFailed.includes(c.divisionId))
        : outcome.checkpoints;
    const { ok, failed } = await undoJointApply(pending);
    setUndone(ok ? "full" : "partial");
    setUndoFailed(failed);
    setUndoing(false);
    onApplied?.();
  }, [onApplied, outcome, undoFailed, undoing]);

  const close = useCallback(() => {
    onProposalChange?.(null);
    onClose();
  }, [onClose, onProposalChange]);

  const brief = (
    <div className="space-y-3">
      <AiDivisionPicker
        divisions={picker}
        selected={selected}
        onChange={setPicked}
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

      <RunError error={error} currency={currency} msg={msg} />

      {/* W5 (#400) — the confirm gate, the joint twin of the division console's.
          The first click COMPILES the sentence over the selected divisions
          (stage 1, no credit, no architect call) and this card is the receipt
          for it; only its own confirm starts a chargeable run. Declining sets
          the slice back to idle and fires no request, which is what makes
          "declining spends no credit" a fact rather than a claim.

          `AiInstructionPreview` is the division console's card, unchanged: it
          takes a compiled instruction and knows nothing about scope, and the
          two surfaces must not teach two readings of one sentence. */}
      {previewData && (
        <AiInstructionPreview
          preview={previewData}
          credits={quote.credits}
          // The one thing this console can resolve that the division one
          // cannot: a rule narrowed to ONE division of several is the joint
          // reading that matters most, and "part of the competition only" would
          // be an honest gap where a name is right there on the picker.
          names={(scope) =>
            scope.kind === "division" || scope.kind === "pool"
              ? (divisions.find((d) => d.id === scope.divisionId)?.name ?? null)
              : null
          }
          onConfirm={() => void run()}
          onDismiss={() => setPreview(IDLE_JOINT_PREVIEW)}
          onAsPreference={() =>
            setPreview((cur) => ({ ...cur, slice: { ...cur.slice, asPreference: true } }))
          }
        />
      )}

      {!previewData && (
        <button
          type="button"
          data-ai-joint-run
          data-ai-joint-cta-credits={quote.credits}
          data-ai-joint-stage={confirmed ? "run" : "check"}
          onClick={confirmed ? () => void run() : () => void compile()}
          // `confirmed` is false for the whole of a run in flight (`canRun`
          // refuses one), so the running case is the compile case's `!canCompile`.
          disabled={!confirmed && !canCompile}
          className="ai-run inline-flex w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-br from-violet-600 to-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {running || checking ? (
            <>
              <Spinner />
              {checking ? msg("board.ai.preview.checking") : msg("board.ai.joint.running")}
            </>
          ) : (
            <>
              <span aria-hidden>✦</span>
              {confirmed
                ? msg("board.ai.quote.cta", {
                    action: msg("board.ai.joint.run"),
                    credits: plural("board.ai.quote.credits", quote.credits),
                  })
                : msg("board.ai.preview.check")}
            </>
          )}
        </button>
      )}
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
      undoFailed={undoFailed}
      running={running}
      error={error}
      currency={currency}
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
