"use client";

// AI schedule console (v4 Task 11): the docked four-step wizard over the two-
// phase AI architect. Chrome mirrors the unscheduled tray / conflicts panel —
// a right-docked panel on desktop, a bottom sheet on mobile — so it sits inside
// the board's existing vocabulary. The one flourish that marks this surface as
// "AI" is a restrained indigo→violet wash behind a sparkle; everything else is
// the board's slate/purple system. The reducer (ai-console-state) owns the
// state machine and gating; this component renders it and runs Phase A. Tasks
// 12–16 flesh out the schedule / officials / apply step bodies.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import posthog from "posthog-js";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { track, EVENTS } from "@/lib/analytics";
import { useMsg } from "@/components/i18n/dict-provider";
import type { MessageKey } from "@/lib/messages";
import { UpgradeGate } from "@/components/upgrade-gate";
import { PlanBadge } from "@/components/plan-badge";
import type {
  AiPlanRequest,
  AiPlanResponse,
  AiOfficialsPlanRequest,
  AiOfficialsPlanResponse,
  AiLastResult,
  ScheduleConfig,
} from "@/server/api-v1/schemas";
import {
  applyAiPlans,
  AI_APPLY_MODEL,
  mergeConstraintSuggestions,
  suggestionKeysOf,
  type ApplyOutcome,
  type SuggestionKey,
} from "./ai-apply";
import { AiWishChips } from "./ai-wish-chips";
import { AiPreflight, AiLastRun, type PreflightInput } from "./ai-preflight";
import { compileWishes, deriveFreeText, joinNonEmpty, type Wish } from "./wish-compile";
import { compileOfficialsWishes, type OfficialsWish } from "./officials-wish-compile";
import { AiTrace, type TraceEvent } from "./ai-trace";
import { AiDiffPanel } from "./ai-diff-panel";
import { AiOfficialsReview, type OfficialsRosterEntry } from "./ai-officials-review";
import type { AiConsoleFixture } from "./ai-diff";
import {
  aiConsoleReducer,
  aiErrorKey,
  applyErrorKey,
  initialAiConsoleState,
  type AiConsoleState,
  type AiMode,
  type AiStep,
} from "./ai-console-state";

/** The brief step's live inputs, derived by the board from data it already has
 *  (schedule config + fixtures + entrants). Officials come from a fetch-on-open
 *  in the console (kept out of the board's initial payload — gap 15); their
 *  blackout count is the one already-loaded page datum threaded here, since no
 *  client route exposes official availability. */
export interface AiBriefContext {
  /** Configured courts (settings.courts) — court picker + "courts set" row. */
  courts: string[];
  /** Session-window count. */
  windows: number;
  /** Blackout-period count. */
  blackouts: number;
  /** Any non-default constraint knobs set (rest / grouping / v2 constraints). */
  constraintsSet: boolean;
  /** Movable fixtures (status "scheduled") the AI would place. */
  movable: number;
  /** Pinned fixtures (schedule_locked) the AI must not move. */
  pinned: number;
  /** Entrants for the chip pickers, sorted by name. */
  entrants: { id: string; name: string }[];
  /** Officials with at least one blackout date (M in "N officials, M with …"). */
  officialsWithBlackout: number;
}

/**
 * Client kill switch, mirroring the server "ai-scheduling" flag. Fail-open: only
 * an explicit `false` from PostHog hides the entry point — an unconfigured,
 * still-loading, or undefined flag all read as enabled, so a flag outage never
 * pulls a paid feature (schedule-ai.ts evaluates the same flag with fallback:
 * true). There is no existing PostHog client-flag hook in the app, so this is
 * the pattern the board reads it by.
 */
export function useAiSchedulingEnabled(): boolean {
  const [disabled, setDisabled] = useState(false);
  useEffect(() => {
    if (!posthog.__loaded) return;
    const sync = () => setDisabled(posthog.isFeatureEnabled("ai-scheduling") === false);
    sync(); // flags may already be cached from an earlier load
    return posthog.onFeatureFlags(sync); // returns an unsubscribe
  }, []);
  return !disabled;
}

const STEPS: AiStep[] = ["brief", "schedule", "officials", "apply"];

/** The officials policy the console runs Phase B with when the division has no
 *  saved one (none is persisted today — see the `officialsPolicy` prop). Mirrors
 *  the officials panel's auto-assign defaults ({ roles: ["referee"], … }) so the
 *  free solver draft matches what an organiser gets from that panel. */
const DEFAULT_OFFICIALS_POLICY: NonNullable<AiPlanRequest["officials_policy"]> = {
  roles: ["referee"],
  poolLock: false,
  blockStay: true,
  fairness: "tournament",
  teamRefKeepDivision: false,
  restMinMinutes: 0,
  blockGapMinutes: 30,
};

/** A step is "done" (teal) once it has produced its artifact. */
function stepDone(state: AiConsoleState, step: AiStep): boolean {
  switch (step) {
    case "brief":
      return state.schedulePlan !== null;
    case "schedule":
      return state.schedulePlan !== null && (state.step === "officials" || state.step === "apply");
    case "officials":
      return state.officialsPlan !== null;
    case "apply":
      return state.run === "applied";
  }
}

// Re-export so the board imports the ghost/diff fixture shape from one place.
export type { AiConsoleFixture } from "./ai-diff";

export function AiConsole({
  divisionId,
  expectedSeq,
  aiAllowed,
  brief,
  fixtures,
  officialsPolicy,
  onClose,
  onApplied,
  onRefetch,
  onProposalChange,
  onPulse,
}: {
  divisionId: string;
  /** The division seq the board rendered at — the optimistic-concurrency token
   *  the AI apply carries (409 SEQ_CONFLICT on a stale board → re-run as refine). */
  expectedSeq: number;
  /** Client-side entitlement read (server prop) — false renders the paywall
   *  inside the dock with no network call. */
  aiAllowed: boolean;
  /** Live brief inputs derived by the board (pre-flight card + chip pickers). */
  brief: AiBriefContext;
  /** This division's current fixtures (before any proposal) — powers the diff
   *  panel's from→to provenance and the grid ghosts. */
  fixtures: AiConsoleFixture[];
  /** A saved officials AssignPolicy, if the division has one — sent with the run
   *  for a dry coverage preview (§2). No persisted policy source exists today
   *  (the officials/auto flow composes it ad-hoc from unsaved UI state), so the
   *  board leaves this undefined and the field is omitted; the seam is ready for
   *  when a policy is persisted. */
  officialsPolicy?: NonNullable<AiPlanRequest["officials_policy"]>;
  onClose: () => void;
  /** Called after a successful apply (and after an Undo) so the board refetches
   *  and the ghosts resolve to the applied — or reverted — state. */
  onApplied?: () => void;
  /** Called after a SEQ_CONFLICT so the board refetches the fresh schedule + seq
   *  behind the "re-run as refine" affordance. */
  onRefetch?: () => void;
  /** Notifies the board of the current proposal (or null) so it can paint the
   *  grid ghosts; fired on each RUN_DONE and cleared on unmount. */
  onProposalChange?: (plan: AiPlanResponse | null) => void;
  /** Fired when the trace flags a repair — the board pulses these fixture ids
   *  red on the grid for ~1.5s (design §0.3). */
  onPulse?: (fixtureIds: string[]) => void;
}) {
  const msg = useMsg();
  const pathname = usePathname();
  const [state, dispatch] = useReducer(aiConsoleReducer, initialAiConsoleState);
  // Chip wishes live at the console level so they survive step navigation; the
  // instruction is always compileWishes(wishes) + preserved free text.
  const [wishes, setWishes] = useState<Wish[]>([]);
  // Phase B (officials) wishes — a separate list so switching steps never mixes
  // the two phases' chips.
  const [officialsWishes, setOfficialsWishes] = useState<OfficialsWish[]>([]);
  // Fetched once on open (design/v4/03): officials roster size (pre-flight) and
  // the last AI-sourced apply (recall strip). Neither bloats the board payload.
  // Full roster (id + display name) — the pre-flight count, the officials-grid
  // name resolution, and the "{official} only …" wish picker all read it. Kept
  // out of the board's initial payload; fetched once on open (gap 15).
  const [roster, setRoster] = useState<OfficialsRosterEntry[] | null>(null);
  const [lastRun, setLastRun] = useState<AiLastResult>(null);
  // The division's current full scheduling config (incl. constraints, which the
  // board's slimmer settings prop drops) — the apply step needs it to overlay the
  // ticked rule suggestions and PUT the whole config back (§7). Fetched once here
  // rather than widening the board payload.
  const [settings, setSettings] = useState<{ config: ScheduleConfig; tz: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    apiV1<{ id: string; display_name: string; role_keys: string[] }[]>("/api/v1/officials")
      .then((r) => !cancelled && setRoster(r.map((o) => ({ id: o.id, name: o.display_name }))))
      .catch(() => !cancelled && setRoster([]));
    apiV1<AiLastResult>(`/api/v1/divisions/${divisionId}/schedule/ai-last`)
      .then((r) => !cancelled && setLastRun(r))
      .catch(() => {});
    apiV1<{ config: ScheduleConfig; tz: string }>(`/api/v1/divisions/${divisionId}/schedule-settings`)
      .then((r) => !cancelled && setSettings({ config: r.config, tz: r.tz }))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [divisionId]);
  const rosterCount = roster?.length ?? null;

  // Apply step (Task 15): the in-flight flag drives the button spinner without
  // touching the run state (so `busy`'s plan-run gating stays independent); the
  // outcome carries the before-ai checkpoint id that powers Undo.
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<ApplyOutcome | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [undone, setUndone] = useState(false);

  // Chips ↔ instruction: re-derive the compiled prefix, keep the free text.
  const applyWishes = useCallback(
    (next: Wish[]) => {
      const free = deriveFreeText(state.instruction, compileWishes(wishes));
      setWishes(next);
      dispatch({ type: "SET_INSTRUCTION", value: joinNonEmpty(compileWishes(next), free) });
    },
    [state.instruction, wishes],
  );
  // Reuse a last run or tap a preset: the whole textarea becomes that text and
  // the chips reset (so nothing re-prepends over it).
  const fillInstruction = useCallback((value: string) => {
    setWishes([]);
    dispatch({ type: "SET_INSTRUCTION", value });
  }, []);

  // Officials chips ↔ officials instruction — same derive-prefix pattern, on the
  // separate officialsInstruction field.
  const applyOfficialsWishes = useCallback(
    (next: OfficialsWish[]) => {
      const free = deriveFreeText(state.officialsInstruction, compileOfficialsWishes(officialsWishes));
      setOfficialsWishes(next);
      dispatch({
        type: "SET_INSTRUCTION",
        officials: true,
        value: joinNonEmpty(compileOfficialsWishes(next), free),
      });
    },
    [state.officialsInstruction, officialsWishes],
  );

  const preflight: PreflightInput = {
    divisionId,
    courts: brief.courts.length,
    windows: brief.windows,
    blackouts: brief.blackouts,
    constraintsSet: brief.constraintsSet,
    movable: brief.movable,
    pinned: brief.pinned,
    officials: rosterCount,
    officialsBlackout: brief.officialsWithBlackout,
    settingsHref: `${pathname}?tab=settings`,
    officialsHref: `${pathname}?tab=officials`,
  };
  // Instruction that produced the on-screen proposal — lets a refine turn send
  // the right `prior.instruction` when it round-trips the previous assignments.
  const priorInstruction = useRef("");
  // Phase B equivalents: the instruction behind the current officials proposal,
  // and whether that proposal was produced with a prior (so the grid knows when
  // `diff.changed` means "changed vs prior" — a first draft has none).
  const priorOfficialsInstruction = useRef("");
  const officialsHadPrior = useRef(false);
  const officialsAutoStarted = useRef(false);
  // Cancel any in-flight run on close/unmount (the board conditionally renders
  // the dock, so unmount cleanup covers close too) — its rejection is ignored.
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);
  const busy = state.run === "running" || state.run === "flagged";

  // Board callbacks held by ref so the unmount cleanup + proposal mirror can fire
  // the latest without listing them as deps. Synced in an effect (never during
  // render) so a changed callback can't cause a stale update.
  const onProposalRef = useRef(onProposalChange);
  const onPulseRef = useRef(onPulse);
  useEffect(() => {
    onProposalRef.current = onProposalChange;
    onPulseRef.current = onPulse;
  });
  // Mirror the current proposal to the board (grid ghosts); clear it on unmount
  // so closing the console wipes the overlay.
  useEffect(() => {
    onProposalRef.current?.(state.schedulePlan);
  }, [state.schedulePlan]);
  useEffect(() => () => onProposalRef.current?.(null), []);
  // A fresh animation per run — increments so AiTrace remounts and replays.
  const [traceNonce, setTraceNonce] = useState(0);
  const [officialsTraceNonce, setOfficialsTraceNonce] = useState(0);

  const run = useCallback(async (opts?: { mode?: AiMode }) => {
    const instruction = state.instruction.trim();
    if (instruction.length < 3 || busy) return;
    // The seq-conflict recovery re-runs Phase A as a refine over the current
    // proposal regardless of the mode toggle's async state — an explicit override
    // wins over state.mode for both the request mode and the prior round-trip.
    const mode = opts?.mode ?? state.mode;
    abortRef.current?.abort(); // cancel a prior in-flight run
    const ac = new AbortController();
    abortRef.current = ac;
    setTraceNonce((n) => n + 1); // fresh trace animation for this run
    dispatch({ type: "RUN_START" });
    const body: AiPlanRequest = {
      instruction,
      mode,
      ...(state.scope ? { scope: state.scope } : {}),
      // A dry officials-coverage preview rides along only when the division has a
      // saved policy (none is persisted today, so this is omitted — see the prop).
      ...(officialsPolicy ? { officials_policy: officialsPolicy } : {}),
      ...(mode === "refine" && state.schedulePlan && priorInstruction.current
        ? {
            prior: {
              instruction: priorInstruction.current,
              assignments: state.schedulePlan.proposal.map((p) => ({
                fixture_id: p.fixture_id,
                scheduled_at: p.scheduled_at,
                court_label: p.court_label,
              })),
            },
          }
        : {}),
    };
    try {
      const plan = await apiV1<AiPlanResponse>(
        `/api/v1/divisions/${divisionId}/schedule/ai-plan`,
        { method: "POST", json: body, signal: ac.signal },
      );
      priorInstruction.current = instruction;
      // A new schedule invalidates the officials draft (reducer clears the plan);
      // reset the auto-run latch so the officials step re-solves over the new
      // times on next entry rather than showing stale assignments.
      officialsAutoStarted.current = false;
      dispatch({ type: "RUN_DONE", plan });
    } catch (err) {
      // A cancelled run is not an error — the console is closing or superseded.
      if (ac.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) return;
      // Map the status (+ code) to a localized line; never render raw server text.
      const status = err instanceof ApiV1Error ? err.status : 0;
      const code = err instanceof ApiV1Error ? err.code : undefined;
      dispatch({ type: "RUN_ERROR", error: { status, message: msg(aiErrorKey(status, code)) } });
    }
  }, [busy, divisionId, msg, officialsPolicy, state.instruction, state.mode, state.scope, state.schedulePlan]);

  // Phase B run. Empty instruction + no prior = the zero-token solver draft (the
  // auto-run on first entry); a non-empty instruction plans with the LLM; a
  // `prior` refines / round-trips the previous (or a locally patched) proposal.
  // It sends the Phase A proposal's dry-run times as `schedule` so officials are
  // assigned over the *proposed* board — ai-plan's own empty-instruction path is
  // the zero-token solver (usecase runOfficialsAiPlan), and unlike the free
  // /officials/auto route it accepts those times and covers newly placed fixtures.
  const runOfficials = useCallback(
    async (opts: { instruction: string; priorAssignments?: AiOfficialsPlanResponse["assignments"] }) => {
      if (busy || !state.schedulePlan) return;
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      setOfficialsTraceNonce((n) => n + 1);
      officialsHadPrior.current = Boolean(opts.priorAssignments);
      dispatch({ type: "RUN_START" });
      const schedule = state.schedulePlan.proposal.map((p) => ({
        fixture_id: p.fixture_id,
        scheduled_at: p.scheduled_at,
        court_label: p.court_label,
      }));
      const officialsBody: AiOfficialsPlanRequest = {
        instruction: opts.instruction,
        ...(schedule.length > 0 ? { schedule } : {}),
        policy: officialsPolicy ?? DEFAULT_OFFICIALS_POLICY,
        ...(opts.priorAssignments
          ? { prior: { instruction: priorOfficialsInstruction.current, assignments: opts.priorAssignments } }
          : {}),
      };
      try {
        const plan = await apiV1<AiOfficialsPlanResponse>(
          `/api/v1/divisions/${divisionId}/officials/ai-plan`,
          { method: "POST", json: officialsBody, signal: ac.signal },
        );
        priorOfficialsInstruction.current = opts.instruction;
        dispatch({ type: "OFFICIALS_DONE", plan });
      } catch (err) {
        if (ac.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) return;
        const status = err instanceof ApiV1Error ? err.status : 0;
        const code = err instanceof ApiV1Error ? err.code : undefined;
        dispatch({ type: "RUN_ERROR", error: { status, message: msg(aiErrorKey(status, code)) } });
      }
    },
    [busy, divisionId, msg, officialsPolicy, state.schedulePlan],
  );

  // Auto-run the free solver draft the first time the organiser reaches the
  // officials step so it is never blank (design/v4/03 §3). Fires once per open;
  // refines are manual. On error the plan stays null and the ref stays set, so
  // it never retries in a loop — the inline error offers Re-plan.
  useEffect(() => {
    if (
      state.step === "officials" &&
      state.officialsPlan === null &&
      state.schedulePlan !== null &&
      !officialsAutoStarted.current &&
      !busy
    ) {
      officialsAutoStarted.current = true;
      void runOfficials({ instruction: "" });
    }
  }, [state.step, state.officialsPlan, state.schedulePlan, busy, runOfficials]);

  // ---------------------------------------------------- apply orchestration (T15)
  // Chain the existing apply rails: a before-ai checkpoint, the schedule apply(s)
  // (stage-grouped, source "ai" + audit), the officials apply, then the ticked
  // rule PUT — all in ai-apply's pure `applyAiPlans`. Excluded (unticked) blockers
  // drop out of BOTH payloads there. This handler builds the payloads from the
  // console state and maps the outcome onto the reducer + board refetch.
  const doApply = useCallback(
    async (includeOfficials: boolean, tickedSuggestions: SuggestionKey[]) => {
      const plan = state.schedulePlan;
      if (!plan || applying) return;
      dispatch({ type: "APPLY_START" });
      setApplying(true);
      setUndone(false);
      const stageOf = new Map(fixtures.map((f) => [f.id, f.stage_id]));
      const scheduleAudit = {
        instruction: (priorInstruction.current || state.instruction).slice(0, 500),
        summary: plan.summary.slice(0, 600),
        model: AI_APPLY_MODEL,
        repair_rounds: plan.usage.repair_rounds,
      };
      const officials =
        includeOfficials && state.officialsPlan
          ? {
              assignments: state.officialsPlan.assignments.map((a) => ({
                fixture_id: a.fixtureId,
                official_id: a.officialId,
                role_key: a.roleKey,
                locked: a.locked ?? false,
              })),
              audit: {
                instruction: priorOfficialsInstruction.current.slice(0, 500),
                summary: state.officialsPlan.summary.slice(0, 600),
                model: AI_APPLY_MODEL,
                repair_rounds: state.officialsPlan.usage.repair_rounds,
              },
            }
          : null;
      const suggestions =
        tickedSuggestions.length > 0 && settings && plan.constraint_suggestions
          ? {
              config: mergeConstraintSuggestions(settings.config, plan.constraint_suggestions, tickedSuggestions),
              tz: settings.tz,
            }
          : null;
      let result: ApplyOutcome;
      try {
        result = await applyAiPlans({
          divisionId,
          expectedSeq,
          scheduleAssignments: plan.proposal.map((p) => ({
            fixture_id: p.fixture_id,
            scheduled_at: p.scheduled_at,
            court_label: p.court_label,
            stage_id: stageOf.get(p.fixture_id) ?? "",
          })),
          scheduleAudit,
          officials,
          excludedFixtureIds: state.excludedFixtures,
          suggestions,
        });
      } catch {
        result = { schedule: "error", officials: "skipped", checkpointId: null };
      }
      setApplying(false);
      setApplyResult(result);
      if (result.schedule === "applied") {
        dispatch({ type: "APPLIED" });
        onApplied?.(); // board refetch → ghosts resolve to the applied state
      } else if (result.schedule === "seq_conflict") {
        dispatch({ type: "APPLY_SEQ_CONFLICT" });
        onRefetch?.(); // pull the fresh board behind the re-run affordance
      } else {
        // Map the real failure (checkpoint 402 save-point cap, schedule 422/409,
        // …) through aiErrorKey instead of the flat generic; the outcome now
        // carries the status+code applyErrorKey needs.
        dispatch({
          type: "APPLY_ERROR",
          error: { status: result.errorStatus ?? 0, message: msg(applyErrorKey(result)) },
        });
      }
    },
    [
      applying,
      divisionId,
      expectedSeq,
      fixtures,
      msg,
      onApplied,
      onRefetch,
      settings,
      state.excludedFixtures,
      state.instruction,
      state.officialsPlan,
      state.schedulePlan,
    ],
  );

  // Discard: abandon the verified proposal from the apply step (the run's abandon
  // signal) and close the dock — the board clears the ghosts on unmount.
  const discard = useCallback(() => {
    track(EVENTS.AI_PLAN_DISCARDED, { division_id: divisionId });
    onClose();
  }, [divisionId, onClose]);

  // Undo: one tap restores the before-ai checkpoint the apply created, then
  // refetches so the board shows the reverted schedule.
  const undo = useCallback(async () => {
    const checkpointId = applyResult?.checkpointId;
    if (!checkpointId || undoing) return;
    setUndoing(true);
    try {
      await apiV1(`/api/v1/divisions/${divisionId}/restore`, {
        method: "POST",
        json: { checkpoint_id: checkpointId, confirm: true },
      });
      setUndone(true);
      onApplied?.();
    } catch (err) {
      const status = err instanceof ApiV1Error ? err.status : 0;
      const code = err instanceof ApiV1Error ? err.code : undefined;
      dispatch({ type: "APPLY_ERROR", error: { status, message: msg(aiErrorKey(status, code)) } });
    } finally {
      setUndoing(false);
    }
  }, [applyResult, divisionId, msg, onApplied, undoing]);

  // Re-run as refine: fold the organiser's proposal into a fresh Phase A pass over
  // the just-refetched board (prior = the current proposal). The mode override
  // wins over the toggle's async state so this is a single tap.
  const reRunAsRefine = useCallback(() => {
    setApplyResult(null);
    dispatch({ type: "SET_MODE", mode: "refine" });
    void run({ mode: "refine" });
  }, [run]);

  const body = aiAllowed ? (
    <div className="space-y-4">
      <Stepper state={state} onGoto={(step) => dispatch({ type: "GOTO_STEP", step })} msg={msg} />
      {state.step === "brief" && (
        <BriefStep
          state={state}
          dispatch={dispatch}
          run={run}
          busy={busy}
          msg={msg}
          brief={brief}
          preflight={preflight}
          wishes={wishes}
          onWishes={applyWishes}
          onFill={fillInstruction}
          lastRun={lastRun}
        />
      )}
      {state.step === "schedule" && (
        <ScheduleStep
          state={state}
          dispatch={dispatch}
          msg={msg}
          fixtures={fixtures}
          courts={brief.courts.length}
          busy={busy}
          traceNonce={traceNonce}
          onPulse={(ids) => onPulseRef.current?.(ids)}
        />
      )}
      {state.step === "officials" && (
        <OfficialsStep
          state={state}
          dispatch={dispatch}
          fixtures={fixtures}
          roster={roster ?? []}
          policyRoles={(officialsPolicy ?? DEFAULT_OFFICIALS_POLICY).roles}
          hadPrior={officialsHadPrior.current}
          busy={busy}
          traceNonce={officialsTraceNonce}
          wishes={officialsWishes}
          onWishes={applyOfficialsWishes}
          onReplan={() =>
            runOfficials({
              instruction: state.officialsInstruction.trim(),
              priorAssignments: state.officialsPlan?.assignments,
            })
          }
          onAdopt={(fixtureId, roleKey, candidateId) => {
            const cur = state.officialsPlan?.assignments ?? [];
            const patched = [
              ...cur.filter((a) => !(a.fixtureId === fixtureId && a.roleKey === roleKey)),
              { fixtureId, officialId: candidateId, roleKey, locked: false },
            ];
            void runOfficials({ instruction: priorOfficialsInstruction.current, priorAssignments: patched });
          }}
          onPulse={(ids) => onPulseRef.current?.(ids)}
        />
      )}
      {state.step === "apply" && (
        <ApplyStep
          state={state}
          plan={state.schedulePlan}
          fixtures={fixtures}
          settingsReady={settings !== null}
          applying={applying}
          applyResult={applyResult}
          undoing={undoing}
          undone={undone}
          onApply={doApply}
          onDiscard={discard}
          onUndo={undo}
          onReRunRefine={reRunAsRefine}
          msg={msg}
        />
      )}
    </div>
  ) : (
    <UpgradeGate feature="scheduling.ai" />
  );

  return (
    <aside
      role="region"
      aria-label={msg("board.ai.title")}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
      className="ai-console fixed inset-x-0 bottom-0 z-40 max-h-[82vh] overflow-y-auto rounded-t-2xl border border-slate-200 bg-white shadow-2xl outline-none sm:inset-x-auto sm:top-20 sm:right-4 sm:bottom-auto sm:max-h-[80vh] sm:w-[27rem] sm:rounded-2xl"
    >
      {/* Header — the AI wash + sparkle live here and nowhere else. */}
      <div className="relative overflow-hidden rounded-t-2xl border-b border-slate-200 bg-gradient-to-br from-violet-600 to-indigo-600 px-4 py-3 text-white">
        <div className="sheet-handle bg-white/40 sm:hidden" aria-hidden />
        <div className="flex items-center gap-2">
          <span aria-hidden className="text-lg leading-none">✦</span>
          <h2 className="text-sm font-semibold tracking-tight">{msg("board.ai.title")}</h2>
          <PlanBadge feature="scheduling.ai" />
          <button
            type="button"
            onClick={onClose}
            aria-label={msg("board.ai.close")}
            className="ml-auto grid h-7 w-7 place-items-center rounded-full text-white/80 transition hover:bg-white/20 hover:text-white"
          >
            ✕
          </button>
        </div>
        <p className="mt-1 text-xs text-white/85">{msg("board.ai.subtitle")}</p>
      </div>

      <div className="p-4">{body}</div>
    </aside>
  );
}

// ------------------------------------------------------------------ stepper
function Stepper({
  state,
  onGoto,
  msg,
}: {
  state: AiConsoleState;
  onGoto: (step: AiStep) => void;
  msg: ReturnType<typeof useMsg>;
}) {
  const labels: Record<AiStep, string> = {
    brief: msg("board.ai.step.brief"),
    schedule: msg("board.ai.step.schedule"),
    officials: msg("board.ai.step.officials"),
    apply: msg("board.ai.step.apply"),
  };
  // Downstream steps are only reachable once a proposal exists (reducer-gated);
  // reflect that in the affordance so a disabled dot never lies.
  const reachable = (step: AiStep) => step === "brief" || state.schedulePlan !== null;
  return (
    <ol className="flex items-center" aria-label={msg("board.ai.stepperAria")}>
      {STEPS.map((step, i) => {
        const current = state.step === step;
        const done = !current && stepDone(state, step);
        const canGo = reachable(step) && !current;
        return (
          <li key={step} className="flex flex-1 items-center last:flex-none">
            <button
              type="button"
              onClick={() => canGo && onGoto(step)}
              disabled={!canGo}
              aria-current={current ? "step" : undefined}
              className="group flex flex-col items-center gap-1 text-center disabled:cursor-default"
              title={labels[step]}
            >
              <span
                className={`grid h-7 w-7 place-items-center rounded-full text-xs font-semibold ring-1 transition ${
                  current
                    ? "bg-violet-600 text-white ring-violet-600"
                    : done
                      ? "bg-teal-500 text-white ring-teal-500"
                      : canGo
                        ? "bg-white text-slate-500 ring-slate-300 group-hover:ring-violet-400"
                        : "bg-slate-50 text-slate-300 ring-slate-200"
                }`}
              >
                {done ? "✓" : i + 1}
              </span>
              <span
                className={`text-[11px] font-medium ${
                  current ? "text-violet-700" : done ? "text-teal-600" : "text-slate-400"
                }`}
              >
                {labels[step]}
              </span>
            </button>
            {i < STEPS.length - 1 && (
              <span
                aria-hidden
                className={`mx-1 h-px flex-1 self-start mt-3.5 ${done ? "bg-teal-300" : "bg-slate-200"}`}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

// -------------------------------------------------------------- brief step
const MODES: AiMode[] = ["generate", "refine", "repair"];

function BriefStep({
  state,
  dispatch,
  run,
  busy,
  msg,
  brief,
  preflight,
  wishes,
  onWishes,
  onFill,
  lastRun,
}: {
  state: AiConsoleState;
  dispatch: (a: Parameters<typeof aiConsoleReducer>[1]) => void;
  run: () => void;
  busy: boolean;
  msg: ReturnType<typeof useMsg>;
  brief: AiBriefContext;
  preflight: PreflightInput;
  wishes: Wish[];
  onWishes: (next: Wish[]) => void;
  onFill: (value: string) => void;
  lastRun: AiLastResult;
}) {
  const tooShort = state.instruction.trim().length < 3;
  const runLabel = msg(`board.ai.run.${state.mode}` as MessageKey);
  const presetNums = [1, 2, 3] as const;
  return (
    <div className="space-y-3">
      {/* Run type */}
      <div role="group" aria-label={msg("board.ai.modeAria")} className="flex rounded-lg border border-slate-200 bg-slate-50 p-0.5">
        {MODES.map((m) => {
          // Refine adjusts an existing proposal, so it needs one first.
          const disabled = m === "refine" && state.schedulePlan === null;
          const active = state.mode === m;
          return (
            <button
              key={m}
              type="button"
              disabled={disabled || busy}
              aria-pressed={active}
              onClick={() => dispatch({ type: "SET_MODE", mode: m })}
              title={disabled ? msg("board.ai.mode.refineTitle") : undefined}
              className={`flex-1 rounded-md px-2.5 py-1 text-xs font-medium transition disabled:opacity-40 ${
                active ? "bg-white text-violet-700 shadow-sm" : "text-slate-500 hover:text-violet-700"
              }`}
            >
              {msg(`board.ai.mode.${m}` as MessageKey)}
            </button>
          );
        })}
      </div>

      {state.scope && (
        <p className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-2.5 py-1 text-[11px] font-medium text-violet-700">
          <span aria-hidden>◎</span>
          {msg("board.ai.scoped")}
        </p>
      )}

      {/* Last AI run — one tap refills the textarea (design/v4/03 §4). */}
      {lastRun && <AiLastRun last={lastRun} onReuse={onFill} />}

      {/* Wish chips compile into the instruction below. */}
      <AiWishChips wishes={wishes} onChange={onWishes} entrants={brief.entrants} courts={brief.courts} />

      <div>
        <label htmlFor="ai-instruction" className="label">
          {msg("board.ai.instructionLabel")}
        </label>
        <textarea
          id="ai-instruction"
          className="input min-h-24 resize-y"
          value={state.instruction}
          disabled={busy}
          onChange={(e) => dispatch({ type: "SET_INSTRUCTION", value: e.target.value })}
          placeholder={msg("board.ai.instructionPlaceholder")}
        />
        <p className="mt-1 text-[11px] text-slate-500">{msg("board.ai.instructionHint")}</p>
      </div>

      {/* One-tap example presets for the active mode (02 §4). */}
      <div className="space-y-1">
        <span className="label mb-0">{msg("board.ai.preset.label")}</span>
        <div className="space-y-1">
          {presetNums.map((n) => {
            const text = msg(`board.ai.preset.${state.mode}.${n}` as MessageKey);
            return (
              <button
                key={n}
                type="button"
                disabled={busy}
                onClick={() => onFill(text)}
                className="block w-full rounded-md border border-slate-200 bg-slate-50/60 px-2.5 py-1 text-left text-[11px] leading-snug text-slate-600 transition hover:border-violet-300 hover:bg-white hover:text-violet-700 disabled:opacity-50"
              >
                {text}
              </button>
            );
          })}
        </div>
      </div>

      {/* Pre-flight readiness — informational, never blocks the run. */}
      <AiPreflight {...preflight} />

      {state.run === "error" && state.error && (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          <span className="font-semibold">{msg("board.ai.errorLabel")}</span> {state.error.message}
        </p>
      )}

      <button
        type="button"
        onClick={run}
        disabled={tooShort || busy}
        className="ai-run inline-flex w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-br from-violet-600 to-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? (
          <>
            <Spinner />
            {state.run === "flagged" ? msg("board.ai.flagged") : msg("board.ai.running")}
          </>
        ) : (
          <>
            <span aria-hidden>✦</span>
            {runLabel}
          </>
        )}
      </button>
    </div>
  );
}

// ----------------------------------------------------------- schedule step
/**
 * Compose the referee trace from the verified plan (design §0). There is no
 * server trace field, so the console narrates what the engine did from the
 * result: a draft/plan/verify spine, then — when a repair ran or conflicts
 * surfaced — flag lines (the caught conflicts, pulsed on the grid) and a repair
 * round, and finally either the mandated CLEAN line + Ready, or, when blocking
 * conflicts remain, a red "unresolved" tail (no clean, spine stays flagged).
 */
function buildScheduleTrace(
  plan: AiPlanResponse,
  courts: number,
  msg: ReturnType<typeof useMsg>,
): { events: TraceEvent[]; flaggedIds: string[] } {
  const events: TraceEvent[] = [];
  const node = (k: MessageKey) => events.push({ t: "step", text: msg(k) });
  const log = (text: string) => events.push({ t: "log", text });

  node("board.ai.trace.node.draft");
  log(msg("board.ai.trace.line.draft", { fixtures: plan.proposal.length, courts }));
  node("board.ai.trace.node.plan");
  log(msg("board.ai.trace.line.plan", { count: plan.proposal.length }));
  node("board.ai.trace.node.referee");
  log(msg("board.ai.trace.line.verify"));

  const conflicts = [...plan.blocking, ...plan.warnings];
  const flaggedIds = Array.from(new Set(conflicts.map((c) => c.fixtureId)));
  const repaired = plan.usage.repair_rounds > 0;

  if (repaired || conflicts.length > 0) {
    const shown = conflicts.slice(0, 3);
    if (shown.length > 0) {
      for (const c of shown) {
        events.push({ t: "flag", text: msg("board.ai.trace.line.flag", { what: c.detail || c.reason }) });
      }
    } else {
      events.push({ t: "flag", text: msg("board.ai.trace.line.flagGeneric") });
    }
    if (repaired) {
      node("board.ai.trace.node.repair");
      log(msg("board.ai.trace.line.repair", { rounds: plan.usage.repair_rounds }));
    }
  }

  if (plan.blocking.length > 0) {
    // Not clean — the engine could not fully verify; spine ends flagged.
    events.push({ t: "flag", text: msg("board.ai.trace.line.blockingRemain", { count: plan.blocking.length }) });
  } else {
    events.push({ t: "clean", text: msg("board.ai.trace.line.clean") });
    node("board.ai.trace.node.ready");
  }

  return { events, flaggedIds };
}

function ScheduleStep({
  state,
  dispatch,
  msg,
  fixtures,
  courts,
  busy,
  traceNonce,
  onPulse,
}: {
  state: AiConsoleState;
  dispatch: (a: Parameters<typeof aiConsoleReducer>[1]) => void;
  msg: ReturnType<typeof useMsg>;
  fixtures: AiConsoleFixture[];
  courts: number;
  busy: boolean;
  traceNonce: number;
  onPulse: (ids: string[]) => void;
}) {
  const plan = state.schedulePlan;
  const { events, flaggedIds } = useMemo(
    () => (plan ? buildScheduleTrace(plan, courts, msg) : { events: [], flaggedIds: [] }),
    [plan, courts, msg],
  );
  if (!plan) return <Empty msg={msg} k="board.ai.schedule.empty" />;

  return (
    <div className="space-y-3">
      {/* The referee trace — the headline (§0). */}
      <AiTrace
        key={traceNonce}
        phase="schedule"
        events={events}
        running={busy}
        onFlag={() => onPulse(flaggedIds)}
      />

      {/* Summary + usage + coverage + the "why it did that" diff (§3/§5/§6). */}
      <AiDiffPanel
        plan={plan}
        fixtures={fixtures}
        excluded={state.excludedFixtures}
        onToggleExclude={(fixtureId) => dispatch({ type: "TOGGLE_EXCLUDE", fixtureId })}
      />

      <p className="text-[11px] text-slate-500">{msg("board.ai.schedule.reviewNote")}</p>

      <div className="flex flex-wrap gap-2 pt-1">
        <button
          type="button"
          onClick={() => dispatch({ type: "GOTO_STEP", step: "officials" })}
          className="btn btn-primary px-3 py-1.5 text-xs"
        >
          {msg("board.ai.next.officials")}
        </button>
        <button
          type="button"
          onClick={() => dispatch({ type: "GOTO_STEP", step: "apply" })}
          className="btn btn-ghost px-3 py-1.5 text-xs"
        >
          {msg("board.ai.next.apply")}
        </button>
        <button
          type="button"
          onClick={() => {
            dispatch({ type: "SET_MODE", mode: "refine" });
            dispatch({ type: "GOTO_STEP", step: "brief" });
          }}
          className="btn btn-ghost ml-auto px-3 py-1.5 text-xs"
        >
          {msg("board.ai.next.refine")}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------- officials step
// Phase B — the officials review grid (design/v4/03 §3). Reachable only once a
// schedule plan exists (reducer-gated); the auto-run in the parent fills it with
// the free solver draft on first entry. The proposal's dry-run placements power
// the grid's times so it reads consistently with the schedule step.
function OfficialsStep({
  state,
  dispatch,
  fixtures,
  roster,
  policyRoles,
  hadPrior,
  busy,
  traceNonce,
  wishes,
  onWishes,
  onReplan,
  onAdopt,
  onPulse,
}: {
  state: AiConsoleState;
  dispatch: (a: Parameters<typeof aiConsoleReducer>[1]) => void;
  fixtures: AiConsoleFixture[];
  roster: OfficialsRosterEntry[];
  policyRoles: string[];
  hadPrior: boolean;
  busy: boolean;
  traceNonce: number;
  wishes: OfficialsWish[];
  onWishes: (next: OfficialsWish[]) => void;
  onReplan: () => void;
  onAdopt: (fixtureId: string, roleKey: string, candidateId: string) => void;
  onPulse: (ids: string[]) => void;
}) {
  const placements = (state.schedulePlan?.proposal ?? []).map((p) => ({
    fixture_id: p.fixture_id,
    scheduled_at: p.scheduled_at,
    court_label: p.court_label,
  }));
  return (
    <AiOfficialsReview
      plan={state.officialsPlan}
      placements={placements}
      fixtures={fixtures}
      roster={roster}
      roles={policyRoles}
      hasPrior={hadPrior}
      busy={busy}
      traceNonce={traceNonce}
      error={state.run === "error" ? state.error : null}
      instruction={state.officialsInstruction}
      onInstruction={(v) => dispatch({ type: "SET_INSTRUCTION", officials: true, value: v })}
      wishes={wishes}
      onWishes={onWishes}
      onReplan={onReplan}
      onAdopt={onAdopt}
      onBack={() => dispatch({ type: "GOTO_STEP", step: "schedule" })}
      onContinue={() => dispatch({ type: "GOTO_STEP", step: "apply" })}
      onPulse={onPulse}
    />
  );
}

// -------------------------------------------------------------- apply step
// The chained accept (Task 15): a "what applies" recap, the checked-by-default
// rule-suggestions checklist, then the three commit paths — apply schedule +
// officials, apply schedule only, or discard. The orchestration + outcome live
// in the parent (doApply / applyAiPlans); this step renders the pre-apply, the
// stale-board recovery (re-run as refine), the error, and the applied states.
function ApplyStep({
  state,
  plan,
  fixtures,
  settingsReady,
  applying,
  applyResult,
  undoing,
  undone,
  onApply,
  onDiscard,
  onUndo,
  onReRunRefine,
  msg,
}: {
  state: AiConsoleState;
  plan: AiPlanResponse | null;
  fixtures: AiConsoleFixture[];
  settingsReady: boolean;
  applying: boolean;
  applyResult: ApplyOutcome | null;
  undoing: boolean;
  undone: boolean;
  onApply: (includeOfficials: boolean, ticked: SuggestionKey[]) => void;
  onDiscard: () => void;
  onUndo: () => void;
  onReRunRefine: () => void;
  msg: ReturnType<typeof useMsg>;
}) {
  const excluded = useMemo(() => new Set(state.excludedFixtures), [state.excludedFixtures]);
  const suggestKeys = useMemo(() => suggestionKeysOf(plan?.constraint_suggestions), [plan]);
  const [ticked, setTicked] = useState<Set<SuggestionKey>>(() => new Set(suggestKeys));

  if (!plan) return <Empty msg={msg} k="board.ai.schedule.empty" />;

  // Applied — the success toast + checkpoint banner, or the reverted state.
  if (state.run === "applied") {
    if (undone) {
      return (
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
          <p className="flex items-center gap-1.5 text-sm font-medium text-slate-700">
            <span aria-hidden>⟲</span>
            {msg("board.ai.apply.reverted")}
          </p>
        </div>
      );
    }
    return <AppliedState outcome={applyResult} onUndo={onUndo} undoing={undoing} msg={msg} />;
  }

  const scheduleCount = plan.proposal.filter((p) => !excluded.has(p.fixture_id)).length;
  const officialsCount = state.officialsPlan
    ? state.officialsPlan.assignments.filter((a) => !excluded.has(a.fixtureId)).length
    : 0;
  const stale = state.run === "seq_conflict";

  // Stale board — the only path forward is a refine over the refetched schedule.
  if (stale) {
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
            onClick={onReRunRefine}
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

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-700">{msg("board.ai.apply.lead")}</p>

      {/* What will apply — the recap before the commit. */}
      <div className="space-y-1 rounded-lg border border-slate-200 bg-slate-50/70 p-3">
        <p className="flex items-center gap-1.5 text-xs text-slate-700">
          <span aria-hidden className="h-2 w-2 rounded-full bg-teal-500" />
          {msg("board.ai.apply.willSchedule", { n: scheduleCount })}
        </p>
        <p className="flex items-center gap-1.5 text-xs text-slate-700">
          <span aria-hidden className={`h-2 w-2 rounded-full ${officialsCount > 0 ? "bg-teal-500" : "bg-slate-300"}`} />
          {officialsCount > 0
            ? msg("board.ai.apply.willOfficials", { n: officialsCount })
            : msg("board.ai.apply.noOfficials")}
        </p>
        <p className="pt-0.5 text-[11px] text-slate-500">{msg("board.ai.apply.hint")}</p>
      </div>

      {/* Rule changes the architect inferred — checked by default, each optional. */}
      {suggestKeys.length > 0 && settingsReady && (
        <SuggestChecklist
          plan={plan}
          keys={suggestKeys}
          ticked={ticked}
          onToggle={(k) =>
            setTicked((prev) => {
              const next = new Set(prev);
              if (next.has(k)) next.delete(k);
              else next.add(k);
              return next;
            })
          }
          msg={msg}
        />
      )}

      {state.run === "error" && state.error && (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          <span className="font-semibold">{msg("board.ai.errorLabel")}</span> {state.error.message}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button
          type="button"
          disabled={applying || scheduleCount === 0}
          onClick={() => onApply(true, [...ticked])}
          className="ai-run inline-flex items-center justify-center gap-2 rounded-lg bg-gradient-to-br from-violet-600 to-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {applying ? (
            <>
              <Spinner />
              {msg("board.ai.apply.applying")}
            </>
          ) : (
            <>
              <span aria-hidden>✦</span>
              {msg("board.ai.apply.both")}
            </>
          )}
        </button>
        <button
          type="button"
          disabled={applying || scheduleCount === 0}
          onClick={() => onApply(false, [...ticked])}
          className="btn btn-ghost px-3 py-1.5 text-xs disabled:opacity-50"
        >
          {msg("board.ai.apply.scheduleOnly")}
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

// The applied success state: a teal confirmation with the officials outcome, then
// the save-point banner whose Undo restores the before-ai checkpoint in one tap.
function AppliedState({
  outcome,
  onUndo,
  undoing,
  msg,
}: {
  outcome: ApplyOutcome | null;
  onUndo: () => void;
  undoing: boolean;
  msg: ReturnType<typeof useMsg>;
}) {
  const officialsNote: MessageKey =
    outcome?.officials === "applied"
      ? "board.ai.apply.officialsApplied"
      : outcome?.officials === "error"
        ? "board.ai.apply.officialsError"
        : "board.ai.apply.officialsSkipped";
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-teal-200 bg-teal-50 px-3 py-2.5">
        <p className="flex items-center gap-1.5 text-sm font-semibold text-teal-800">
          <span aria-hidden>✓</span>
          {msg("board.ai.applied")}
        </p>
        <p className="mt-0.5 text-xs text-teal-700">{msg(officialsNote)}</p>
      </div>
      {outcome?.checkpointId && (
        <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50/70 px-3 py-2">
          <span aria-hidden className="text-slate-400">⟲</span>
          <p className="min-w-0 flex-1 text-[11px] text-slate-600">{msg("board.ai.apply.savepoint")}</p>
          <button
            type="button"
            disabled={undoing}
            onClick={onUndo}
            className="btn btn-ghost shrink-0 px-3 py-1.5 text-xs font-semibold text-violet-700 disabled:opacity-50"
          >
            {undoing ? msg("board.ai.apply.undoing") : msg("board.ai.apply.undo")}
          </button>
        </div>
      )}
    </div>
  );
}

// The rule-suggestions checklist (§7). One row per constraint field the architect
// inferred, checked by default; the ticked set overlays the current config on the
// schedule-settings PUT. Enum/count values ride in a mono chip.
function SuggestChecklist({
  plan,
  keys,
  ticked,
  onToggle,
  msg,
}: {
  plan: AiPlanResponse;
  keys: SuggestionKey[];
  ticked: Set<SuggestionKey>;
  onToggle: (k: SuggestionKey) => void;
  msg: ReturnType<typeof useMsg>;
}) {
  const cs = plan.constraint_suggestions;
  if (!cs) return null;
  const valueOf = (k: SuggestionKey): string | null => {
    switch (k) {
      case "restMin":
        return msg("board.ai.suggest.mins", { n: cs.restMin ?? 0 });
      case "restByGroup":
        return String(Object.keys(cs.restByGroup ?? {}).length);
      case "startWindows":
        return String((cs.startWindows ?? []).length);
      case "fieldFairness":
        return cs.fieldFairness ?? null;
      case "parallelism":
        return cs.parallelism ?? null;
      case "crossPersonClash":
        return cs.crossPersonClash ?? null;
      case "noBackToBack":
        return null;
    }
  };
  return (
    <div className="rounded-lg border border-violet-200 bg-violet-50/50 p-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-violet-700">
        {msg("board.ai.suggest.title")}
      </p>
      <p className="mt-0.5 text-[11px] text-violet-700/80">{msg("board.ai.suggest.hint")}</p>
      <ul className="mt-2 space-y-1.5">
        {keys.map((k) => {
          const value = valueOf(k);
          const on = ticked.has(k);
          const rowLabel = msg(`board.ai.suggest.${k}` as MessageKey);
          return (
            <li key={k} className="flex items-center gap-2 rounded-md border border-violet-100 bg-white px-2 py-1.5">
              <label className="inline-flex cursor-pointer items-center">
                <input
                  type="checkbox"
                  className="peer sr-only"
                  checked={on}
                  onChange={() => onToggle(k)}
                  aria-label={rowLabel}
                />
                <span
                  aria-hidden
                  className="grid h-4 w-4 place-items-center rounded border border-violet-300 text-[10px] text-white transition peer-checked:border-violet-500 peer-checked:bg-violet-500 peer-focus-visible:ring-2 peer-focus-visible:ring-violet-300"
                >
                  ✓
                </span>
              </label>
              <span className="min-w-0 flex-1 text-xs text-slate-700">{rowLabel}</span>
              {value !== null && (
                <span className="shrink-0 rounded bg-violet-100 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-violet-700">
                  {value}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Empty({ msg, k }: { msg: ReturnType<typeof useMsg>; k: Parameters<ReturnType<typeof useMsg>>[0] }) {
  return (
    <p className="rounded-lg border border-dashed border-slate-200 bg-slate-50/60 px-3 py-6 text-center text-xs text-slate-500">
      {msg(k)}
    </p>
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
