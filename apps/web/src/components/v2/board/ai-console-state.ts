// AI schedule console — pure state machine (v4 Task 11, design/v4/00-03).
//
// The console is a four-step wizard over the two-phase AI architect: write a
// brief, review the engine-verified schedule proposal, optionally assign
// officials, then apply. This module is deliberately React-free so the gating
// (you can't reach officials without a schedule plan; apply is reachable
// straight from schedule; an error never discards the proposal you're looking
// at) is unit-testable in isolation. Tasks 12–16 consume these types verbatim.
import type { AiPlanResponse, AiOfficialsPlanResponse } from "@/server/api-v1/schemas";
import type { ApplyOutcome } from "./ai-apply";

export type AiStep = "brief" | "schedule" | "officials" | "apply";
export type AiRunState =
  | "idle"
  | "running"
  | "flagged"
  | "proposal"
  | "applied"
  | "seq_conflict"
  | "error";
export type AiMode = "generate" | "refine" | "repair";

/** Optional narrowing for a run — a repair window, a court subset, or pools. */
export interface AiScope {
  from?: string;
  courts?: string[];
  pool_ids?: string[];
}

export interface AiConsoleState {
  step: AiStep;
  run: AiRunState;
  mode: AiMode;
  /** Phase A (schedule) brief. */
  instruction: string;
  /** Phase B (officials) brief — kept separate so switching steps never
   *  clobbers the other phase's text. */
  officialsInstruction: string;
  scope?: AiScope;
  schedulePlan: AiPlanResponse | null; // Phase A result
  officialsPlan: AiOfficialsPlanResponse | null; // Phase B result
  /** Blocking fixtures the organiser unticked in the diff panel — they drop to
   *  the tray (unscheduled) in the accept payload rather than block the whole
   *  apply (02 §6). Task 15's accept reads this; Task 13 only wires it. Cleared
   *  whenever a fresh proposal lands. */
  excludedFixtures: string[];
  error: { status: number; message: string } | null;
}

export type AiConsoleAction =
  | { type: "SET_INSTRUCTION"; value: string; officials?: boolean }
  | { type: "SET_MODE"; mode: AiMode }
  | { type: "SET_SCOPE"; scope: AiScope | undefined }
  | { type: "RUN_START" }
  | { type: "RUN_FLAGGED" }
  | { type: "RUN_DONE"; plan: AiPlanResponse }
  | { type: "RUN_ERROR"; error: { status: number; message: string } }
  | { type: "GOTO_STEP"; step: AiStep }
  | { type: "OFFICIALS_DONE"; plan: AiOfficialsPlanResponse }
  | { type: "TOGGLE_EXCLUDE"; fixtureId: string }
  | { type: "APPLY_START" }
  | { type: "APPLY_SEQ_CONFLICT" }
  | { type: "APPLY_ERROR"; error: { status: number; message: string } }
  | { type: "APPLIED" }
  | { type: "RESET" }
  | { type: "PREFILL_REPAIR"; scope?: AiScope };

export const initialAiConsoleState: AiConsoleState = {
  step: "brief",
  run: "idle",
  mode: "generate",
  instruction: "",
  officialsInstruction: "",
  scope: undefined,
  schedulePlan: null,
  officialsPlan: null,
  excludedFixtures: [],
  error: null,
};

export function aiConsoleReducer(s: AiConsoleState, a: AiConsoleAction): AiConsoleState {
  switch (a.type) {
    case "SET_INSTRUCTION":
      return a.officials
        ? { ...s, officialsInstruction: a.value }
        : { ...s, instruction: a.value };

    case "SET_MODE":
      return { ...s, mode: a.mode };

    case "SET_SCOPE":
      return { ...s, scope: a.scope };

    case "RUN_START":
      // A fresh run clears the last error but keeps the current proposal on
      // screen until the new one lands (refine/repair read as an in-place update).
      return { ...s, run: "running", error: null };

    case "RUN_FLAGGED":
      // The engine flagged the model's draft and a repair round is underway.
      return { ...s, run: "flagged" };

    case "RUN_DONE":
      // Phase A landed: store it, show it, and move to the schedule step. A new
      // proposal has its own (possibly empty) set of blockers, so any prior
      // untick choices are dropped. It also invalidates the officials draft —
      // those assignments were assigned over the OLD times, so clear them; the
      // officials step re-runs its solver over the new schedule on next entry
      // (T14-reviewer staleness fix; the console resets officialsAutoStarted to
      // match). RESET stays the only action that clears schedulePlan.
      return {
        ...s,
        schedulePlan: a.plan,
        officialsPlan: null,
        run: "proposal",
        step: "schedule",
        excludedFixtures: [],
        error: null,
      };

    case "RUN_ERROR":
      // Keep whatever proposal the organiser was already looking at — an error
      // must never blank the board they were about to apply (brief §Step 1).
      return { ...s, run: "error", error: a.error };

    case "GOTO_STEP": {
      // Brief is always reachable (go back and re-brief). Every downstream step
      // needs a schedule plan to exist — including apply, which is reachable
      // from schedule with officials skipped.
      if (a.step === "brief") return { ...s, step: "brief" };
      if (!s.schedulePlan) return s; // gated no-op
      return { ...s, step: a.step };
    }

    case "OFFICIALS_DONE":
      return { ...s, officialsPlan: a.plan, run: "proposal", step: "officials", error: null };

    case "TOGGLE_EXCLUDE":
      // Per-row untick on a blocking fixture: toggle its membership in the
      // drop-to-tray set (02 §6). Accept (Task 15) enables once every blocker is
      // excluded.
      return s.excludedFixtures.includes(a.fixtureId)
        ? { ...s, excludedFixtures: s.excludedFixtures.filter((id) => id !== a.fixtureId) }
        : { ...s, excludedFixtures: [...s.excludedFixtures, a.fixtureId] };

    case "APPLY_START":
      // Clear any error from a prior apply attempt; the in-flight spinner is a
      // local console flag, so the run state is untouched until it resolves.
      return { ...s, error: null };

    case "APPLY_SEQ_CONFLICT":
      // The board moved under us (another organiser edited it). Keep the proposal
      // on screen; the apply step offers "re-run as refine" over the fresh board.
      return { ...s, run: "seq_conflict" };

    case "APPLY_ERROR":
      return { ...s, run: "error", error: a.error };

    case "APPLIED":
      return { ...s, run: "applied", step: "apply" };

    case "PREFILL_REPAIR":
      // Opened from a conflict/repair affordance: pre-arm repair mode + scope and
      // drop the organiser on the brief step to add a sentence. Plans are left
      // intact (RESET is the only action that clears them).
      return { ...s, mode: "repair", scope: a.scope, step: "brief", run: "idle", error: null };

    case "RESET":
      return initialAiConsoleState;

    default: {
      // Exhaustiveness guard — a new action must be handled above.
      const _never: never = a;
      return _never;
    }
  }
}

/** ui-catalog copy keys for a failed run. */
export type AiErrorKey =
  | "board.ai.error.upgrade"
  | "board.ai.error.unavailable"
  | "board.ai.error.rateLimited"
  | "board.ai.error.conflict"
  | "board.ai.error.tooLarge"
  | "board.ai.error.invalid"
  | "board.ai.errorGeneric";

/**
 * Map an HTTP status (+ the server error code where it sharpens the message) to
 * a localized copy key. Pure — unit-tested without React. The console resolves
 * the returned key through the ui catalog so a raw, untranslated server string
 * never reaches the UI. 422 splits on the code: AI_PLAN_TOO_LARGE asks the user
 * to narrow the scope; anything else is a plain "couldn't use that instruction".
 */
export function aiErrorKey(status: number, code?: string): AiErrorKey {
  switch (status) {
    case 402:
      return "board.ai.error.upgrade";
    case 503:
      // AI isn't configured on this server (no key / disabled) — a distinct line
      // from the run failures so the organiser isn't told to just try again.
      return "board.ai.error.unavailable";
    case 429:
      return "board.ai.error.rateLimited";
    case 409:
      return "board.ai.error.conflict";
    case 400:
      return "board.ai.error.invalid";
    case 422:
      return code === "AI_PLAN_TOO_LARGE" ? "board.ai.error.tooLarge" : "board.ai.error.invalid";
    default:
      return "board.ai.errorGeneric";
  }
}

/**
 * Map a failed apply outcome to a localized copy key. Reuses aiErrorKey over the
 * outcome's errorStatus/errorCode (a checkpoint 402 save-point cap, a schedule
 * 422 frozen/too-large, …) so an actionable server failure reaches the organiser
 * instead of the flat "couldn't apply, try again". When aiErrorKey can't sharpen
 * the status (its catch-all run-generic), fall back to the apply-specific generic
 * so the copy still reads as an apply failure. Pure — unit-tested without React.
 */
export function applyErrorKey(
  outcome: ApplyOutcome,
): AiErrorKey | "board.ai.apply.error" | "board.ai.apply.checkpointQuota" {
  // A 402 at the checkpoint step is the save-point quota (schedule.checkpoints.max),
  // not the AI grade — AI is already granted on this tier, so route it to the
  // save-point line ("delete a save point or upgrade") instead of the generic
  // "upgrade to use AI" the plain 402 → error.upgrade mapping would give.
  if (outcome.errorStatus === 402 && outcome.errorCode === "schedule.checkpoints.max") {
    return "board.ai.apply.checkpointQuota";
  }
  const key = aiErrorKey(outcome.errorStatus ?? 0, outcome.errorCode);
  return key === "board.ai.errorGeneric" ? "board.ai.apply.error" : key;
}
