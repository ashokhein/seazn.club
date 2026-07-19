"use client";

// AI schedule console (v4 Task 11): the docked four-step wizard over the two-
// phase AI architect. Chrome mirrors the unscheduled tray / conflicts panel —
// a right-docked panel on desktop, a bottom sheet on mobile — so it sits inside
// the board's existing vocabulary. The one flourish that marks this surface as
// "AI" is a restrained indigo→violet wash behind a sparkle; everything else is
// the board's slate/purple system. The reducer (ai-console-state) owns the
// state machine and gating; this component renders it and runs Phase A. Tasks
// 12–16 flesh out the schedule / officials / apply step bodies.
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import posthog from "posthog-js";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { useMsg, usePlural } from "@/components/i18n/dict-provider";
import { UpgradeGate } from "@/components/upgrade-gate";
import { PlanBadge } from "@/components/plan-badge";
import type { AiPlanRequest, AiPlanResponse } from "@/server/api-v1/schemas";
import {
  aiConsoleReducer,
  aiErrorKey,
  initialAiConsoleState,
  type AiConsoleState,
  type AiMode,
  type AiStep,
} from "./ai-console-state";

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

export function AiConsole({
  divisionId,
  aiAllowed,
  onClose,
  onApplied,
}: {
  divisionId: string;
  /** Client-side entitlement read (server prop) — false renders the paywall
   *  inside the dock with no network call. */
  aiAllowed: boolean;
  onClose: () => void;
  /** Called after a successful apply so the board can refresh. Wired in a later
   *  task; accepted here so the seam is stable. */
  onApplied?: () => void;
}) {
  const msg = useMsg();
  const [state, dispatch] = useReducer(aiConsoleReducer, initialAiConsoleState);
  // Instruction that produced the on-screen proposal — lets a refine turn send
  // the right `prior.instruction` when it round-trips the previous assignments.
  const priorInstruction = useRef("");
  // Cancel any in-flight run on close/unmount (the board conditionally renders
  // the dock, so unmount cleanup covers close too) — its rejection is ignored.
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);
  const plural = usePlural();
  const busy = state.run === "running" || state.run === "flagged";

  const run = useCallback(async () => {
    const instruction = state.instruction.trim();
    if (instruction.length < 3 || busy) return;
    abortRef.current?.abort(); // cancel a prior in-flight run
    const ac = new AbortController();
    abortRef.current = ac;
    dispatch({ type: "RUN_START" });
    const body: AiPlanRequest = {
      instruction,
      mode: state.mode,
      ...(state.scope ? { scope: state.scope } : {}),
      ...(state.mode === "refine" && state.schedulePlan && priorInstruction.current
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
      dispatch({ type: "RUN_DONE", plan });
    } catch (err) {
      // A cancelled run is not an error — the console is closing or superseded.
      if (ac.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) return;
      // Map the status (+ code) to a localized line; never render raw server text.
      const status = err instanceof ApiV1Error ? err.status : 0;
      const code = err instanceof ApiV1Error ? err.code : undefined;
      dispatch({ type: "RUN_ERROR", error: { status, message: msg(aiErrorKey(status, code)) } });
    }
  }, [busy, divisionId, msg, state.instruction, state.mode, state.scope, state.schedulePlan]);

  const body = aiAllowed ? (
    <div className="space-y-4">
      <Stepper state={state} onGoto={(step) => dispatch({ type: "GOTO_STEP", step })} msg={msg} />
      {state.step === "brief" && (
        <BriefStep state={state} dispatch={dispatch} run={run} busy={busy} msg={msg} />
      )}
      {state.step === "schedule" && (
        <ScheduleStep state={state} dispatch={dispatch} msg={msg} plural={plural} />
      )}
      {state.step === "officials" && <OfficialsStep dispatch={dispatch} msg={msg} />}
      {state.step === "apply" && (
        <ApplyStep state={state} dispatch={dispatch} onApplied={onApplied} msg={msg} />
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
}: {
  state: AiConsoleState;
  dispatch: (a: Parameters<typeof aiConsoleReducer>[1]) => void;
  run: () => void;
  busy: boolean;
  msg: ReturnType<typeof useMsg>;
}) {
  const tooShort = state.instruction.trim().length < 3;
  const runLabel = msg(`board.ai.run.${state.mode}` as Parameters<typeof msg>[0]);
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
              {msg(`board.ai.mode.${m}` as Parameters<typeof msg>[0])}
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
function ScheduleStep({
  state,
  dispatch,
  msg,
  plural,
}: {
  state: AiConsoleState;
  dispatch: (a: Parameters<typeof aiConsoleReducer>[1]) => void;
  msg: ReturnType<typeof useMsg>;
  plural: ReturnType<typeof usePlural>;
}) {
  const plan = state.schedulePlan;
  if (!plan) return <Empty msg={msg} k="board.ai.schedule.empty" />;
  const d = plan.diff;
  const stats: { label: string; n: number; tone: string }[] = [
    { label: msg("board.ai.diff.placed"), n: d.placed.length, tone: "text-teal-700 bg-teal-50" },
    { label: msg("board.ai.diff.moved"), n: d.moved.length, tone: "text-violet-700 bg-violet-50" },
    { label: msg("board.ai.diff.unscheduled"), n: d.unscheduled.length, tone: "text-slate-600 bg-slate-100" },
  ];
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-3">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          {msg("board.ai.summaryLabel")}
        </p>
        <p className="mt-0.5 text-sm text-slate-700">{plan.summary}</p>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {stats.map((s) => (
          <span key={s.label} className={`rounded-full px-2.5 py-1 text-xs font-medium ${s.tone}`}>
            {s.n} {s.label}
          </span>
        ))}
        {plan.blocking.length > 0 && (
          <span className="rounded-full bg-red-50 px-2.5 py-1 text-xs font-medium text-red-700">
            {msg("board.ai.blocking", { n: plan.blocking.length })}
          </span>
        )}
        {plan.warnings.length > 0 && (
          <span className="rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800">
            {plural("board.ai.warnings", plan.warnings.length)}
          </span>
        )}
      </div>

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
// Shell placeholder — the officials proposal UI is a later task (12–16). It is
// only reachable once a schedule plan exists (reducer-gated).
function OfficialsStep({
  dispatch,
  msg,
}: {
  dispatch: (a: Parameters<typeof aiConsoleReducer>[1]) => void;
  msg: ReturnType<typeof useMsg>;
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-700">{msg("board.ai.officials.lead")}</p>
      <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50/60 px-3 py-6 text-center text-xs text-slate-500">
        {msg("board.ai.officials.hint")}
      </div>
      <BackToSchedule dispatch={dispatch} msg={msg} />
    </div>
  );
}

// -------------------------------------------------------------- apply step
// Shell placeholder — review-and-apply is a later task. The confirm control is
// intentionally disabled here.
function ApplyStep({
  state,
  dispatch,
  onApplied,
  msg,
}: {
  state: AiConsoleState;
  dispatch: (a: Parameters<typeof aiConsoleReducer>[1]) => void;
  onApplied?: () => void;
  msg: ReturnType<typeof useMsg>;
}) {
  if (state.run === "applied") {
    return (
      <div className="space-y-3">
        <p className="rounded-md border border-teal-200 bg-teal-50 px-3 py-2 text-sm text-teal-800">
          {msg("board.ai.applied")}
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-700">{msg("board.ai.apply.lead")}</p>
      <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50/60 px-3 py-6 text-center text-xs text-slate-500">
        {msg("board.ai.apply.hint")}
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled
          onClick={() => {
            dispatch({ type: "APPLIED" });
            onApplied?.();
          }}
          className="btn btn-primary px-3 py-1.5 text-xs disabled:opacity-50"
        >
          {msg("board.ai.apply.cta")}
        </button>
        <BackToSchedule dispatch={dispatch} msg={msg} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ shared
function BackToSchedule({
  dispatch,
  msg,
}: {
  dispatch: (a: Parameters<typeof aiConsoleReducer>[1]) => void;
  msg: ReturnType<typeof useMsg>;
}) {
  return (
    <button
      type="button"
      onClick={() => dispatch({ type: "GOTO_STEP", step: "schedule" })}
      className="btn btn-ghost px-3 py-1.5 text-xs"
    >
      {msg("board.ai.back")}
    </button>
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
