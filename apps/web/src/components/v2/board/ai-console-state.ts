// AI schedule console — pure state machine (v4 Task 11, design/v4/00-03).
//
// The console is a four-step wizard over the two-phase AI architect: write a
// brief, review the engine-verified schedule proposal, optionally assign
// officials, then apply. This module is deliberately React-free so the gating
// (you can't reach officials without a schedule plan; apply is reachable
// straight from schedule; an error never discards the proposal you're looking
// at) is unit-testable in isolation. Tasks 12–16 consume these types verbatim.
import type { AiPlanResponse, AiOfficialsPlanResponse } from "@/server/api-v1/schemas";

export type AiStep = "brief" | "schedule" | "officials" | "apply";
export type AiRunState = "idle" | "running" | "flagged" | "proposal" | "applied" | "error";
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
      // Phase A landed: store it, show it, and move to the schedule step.
      return { ...s, schedulePlan: a.plan, run: "proposal", step: "schedule", error: null };

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
