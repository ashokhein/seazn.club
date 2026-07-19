// Pure reducer for the AI schedule console (v4 Task 11). No React — the state
// machine is exercised here in isolation so Tasks 12–16 can trust its gating.
import { describe, expect, it } from "vitest";
import type { AiPlanResponse, AiOfficialsPlanResponse } from "@/server/api-v1/schemas";
import {
  aiConsoleReducer,
  aiErrorKey,
  initialAiConsoleState,
  type AiConsoleState,
} from "../ai-console-state";

// Minimal valid plans — the reducer never inspects their internals, only moves
// them between slots, so empty arrays are enough.
const schedulePlan: AiPlanResponse = {
  proposal: [],
  unschedulable: [],
  warnings: [],
  blocking: [],
  diff: { moved: [], placed: [], unscheduled: [], unchanged: [] },
  explanations: [],
  summary: "Placed everything.",
  usage: { input_tokens: 10, output_tokens: 20, repair_rounds: 0 },
  officials_coverage: null,
};

const officialsPlan: AiOfficialsPlanResponse = {
  assignments: [],
  conflicts: [],
  diff: { changed: [], unchanged: [], unfilled: [] },
  lazy_unfilled: [],
  explanations: [],
  summary: "Covered every slot.",
  usage: { input_tokens: 5, output_tokens: 8, repair_rounds: 0 },
};

/** State that already carries a Phase-A proposal (post RUN_DONE). */
function withProposal(): AiConsoleState {
  return aiConsoleReducer(initialAiConsoleState, { type: "RUN_DONE", plan: schedulePlan });
}

describe("aiConsoleReducer", () => {
  it("starts idle on the brief step in generate mode", () => {
    expect(initialAiConsoleState.step).toBe("brief");
    expect(initialAiConsoleState.run).toBe("idle");
    expect(initialAiConsoleState.mode).toBe("generate");
    expect(initialAiConsoleState.schedulePlan).toBeNull();
    expect(initialAiConsoleState.officialsPlan).toBeNull();
  });

  it("SET_INSTRUCTION sets the schedule instruction by default", () => {
    const s = aiConsoleReducer(initialAiConsoleState, {
      type: "SET_INSTRUCTION",
      value: "Finish the top seeds by 6pm",
    });
    expect(s.instruction).toBe("Finish the top seeds by 6pm");
    expect(s.officialsInstruction).toBe("");
  });

  it("SET_INSTRUCTION targets the officials field when flagged", () => {
    const s = aiConsoleReducer(initialAiConsoleState, {
      type: "SET_INSTRUCTION",
      value: "Keep Priya off court 1",
      officials: true,
    });
    expect(s.officialsInstruction).toBe("Keep Priya off court 1");
    expect(s.instruction).toBe("");
  });

  it("SET_MODE and SET_SCOPE update their fields", () => {
    const m = aiConsoleReducer(initialAiConsoleState, { type: "SET_MODE", mode: "refine" });
    expect(m.mode).toBe("refine");
    const sc = aiConsoleReducer(m, { type: "SET_SCOPE", scope: { courts: ["Court 1"] } });
    expect(sc.scope).toEqual({ courts: ["Court 1"] });
  });

  it("RUN_START enters running and clears a prior error but keeps the proposal", () => {
    const errored = aiConsoleReducer(withProposal(), {
      type: "RUN_ERROR",
      error: { status: 500, message: "boom" },
    });
    const running = aiConsoleReducer(errored, { type: "RUN_START" });
    expect(running.run).toBe("running");
    expect(running.error).toBeNull();
    expect(running.schedulePlan).toBe(schedulePlan);
  });

  it("RUN_FLAGGED marks the run flagged without losing the proposal", () => {
    const flagged = aiConsoleReducer(withProposal(), { type: "RUN_FLAGGED" });
    expect(flagged.run).toBe("flagged");
    expect(flagged.schedulePlan).toBe(schedulePlan);
  });

  it("RUN_DONE stores the plan, shows the proposal, and advances to the schedule step", () => {
    const s = withProposal();
    expect(s.schedulePlan).toBe(schedulePlan);
    expect(s.run).toBe("proposal");
    expect(s.step).toBe("schedule");
    expect(s.error).toBeNull();
  });

  it("RUN_ERROR preserves the prior proposal (does not clear schedulePlan)", () => {
    const s = aiConsoleReducer(withProposal(), {
      type: "RUN_ERROR",
      error: { status: 429, message: "Too many runs" },
    });
    expect(s.run).toBe("error");
    expect(s.error).toEqual({ status: 429, message: "Too many runs" });
    expect(s.schedulePlan).toBe(schedulePlan); // proposal survives the error
  });

  it("GOTO_STEP cannot reach officials without a schedule plan", () => {
    const s = aiConsoleReducer(initialAiConsoleState, { type: "GOTO_STEP", step: "officials" });
    expect(s.step).toBe("brief"); // gated no-op
  });

  it("GOTO_STEP cannot reach schedule/apply without a plan either", () => {
    expect(aiConsoleReducer(initialAiConsoleState, { type: "GOTO_STEP", step: "schedule" }).step).toBe("brief");
    expect(aiConsoleReducer(initialAiConsoleState, { type: "GOTO_STEP", step: "apply" }).step).toBe("brief");
  });

  it("GOTO_STEP reaches officials once a plan exists", () => {
    const s = aiConsoleReducer(withProposal(), { type: "GOTO_STEP", step: "officials" });
    expect(s.step).toBe("officials");
  });

  it("GOTO_STEP apply is reachable from schedule, skipping officials", () => {
    const atSchedule = withProposal(); // step === "schedule"
    const s = aiConsoleReducer(atSchedule, { type: "GOTO_STEP", step: "apply" });
    expect(s.step).toBe("apply");
    expect(s.officialsPlan).toBeNull(); // officials genuinely skipped
  });

  it("GOTO_STEP brief is always allowed, even with no plan", () => {
    const moved = aiConsoleReducer(withProposal(), { type: "GOTO_STEP", step: "apply" });
    const back = aiConsoleReducer(moved, { type: "GOTO_STEP", step: "brief" });
    expect(back.step).toBe("brief");
  });

  it("OFFICIALS_DONE stores the officials plan and shows it on the officials step", () => {
    const s = aiConsoleReducer(withProposal(), { type: "OFFICIALS_DONE", plan: officialsPlan });
    expect(s.officialsPlan).toBe(officialsPlan);
    expect(s.step).toBe("officials");
    expect(s.run).toBe("proposal");
  });

  it("APPLIED lands on the apply step in the applied run state", () => {
    const s = aiConsoleReducer(withProposal(), { type: "APPLIED" });
    expect(s.run).toBe("applied");
    expect(s.step).toBe("apply");
  });

  it("TOGGLE_EXCLUDE adds then removes a blocking fixture from the drop-to-tray set", () => {
    const on = aiConsoleReducer(withProposal(), { type: "TOGGLE_EXCLUDE", fixtureId: "f1" });
    expect(on.excludedFixtures).toEqual(["f1"]);
    const off = aiConsoleReducer(on, { type: "TOGGLE_EXCLUDE", fixtureId: "f1" });
    expect(off.excludedFixtures).toEqual([]);
  });

  it("a fresh RUN_DONE clears any prior untick choices", () => {
    const excluded = aiConsoleReducer(withProposal(), { type: "TOGGLE_EXCLUDE", fixtureId: "f1" });
    expect(excluded.excludedFixtures).toEqual(["f1"]);
    const rerun = aiConsoleReducer(excluded, { type: "RUN_DONE", plan: schedulePlan });
    expect(rerun.excludedFixtures).toEqual([]);
  });

  it("a fresh RUN_DONE drops a stale officials draft (assigned over the old times)", () => {
    const withOfficials = aiConsoleReducer(withProposal(), { type: "OFFICIALS_DONE", plan: officialsPlan });
    expect(withOfficials.officialsPlan).toBe(officialsPlan);
    const rerun = aiConsoleReducer(withOfficials, { type: "RUN_DONE", plan: schedulePlan });
    expect(rerun.officialsPlan).toBeNull();
  });

  it("APPLY_SEQ_CONFLICT keeps the proposal on screen and flags the stale board", () => {
    const s = aiConsoleReducer(withProposal(), { type: "APPLY_SEQ_CONFLICT" });
    expect(s.run).toBe("seq_conflict");
    expect(s.schedulePlan).toBe(schedulePlan);
  });

  it("APPLY_ERROR surfaces the error without discarding the proposal", () => {
    const s = aiConsoleReducer(withProposal(), {
      type: "APPLY_ERROR",
      error: { status: 422, message: "nope" },
    });
    expect(s.run).toBe("error");
    expect(s.error).toEqual({ status: 422, message: "nope" });
    expect(s.schedulePlan).toBe(schedulePlan);
  });

  it("PREFILL_REPAIR sets repair mode, the scope, and returns to the brief step", () => {
    const scope = { from: "2026-08-01T09:00:00+01:00", courts: ["Court 2"] };
    const s = aiConsoleReducer(withProposal(), { type: "PREFILL_REPAIR", scope });
    expect(s.mode).toBe("repair");
    expect(s.scope).toEqual(scope);
    expect(s.step).toBe("brief");
    expect(s.run).toBe("idle");
  });

  it("RESET clears both plans and returns to the initial state", () => {
    const busy = aiConsoleReducer(
      aiConsoleReducer(withProposal(), { type: "OFFICIALS_DONE", plan: officialsPlan }),
      { type: "SET_INSTRUCTION", value: "leftover" },
    );
    const s = aiConsoleReducer(busy, { type: "RESET" });
    expect(s.schedulePlan).toBeNull();
    expect(s.officialsPlan).toBeNull();
    expect(s).toEqual(initialAiConsoleState);
  });
});

describe("aiErrorKey (status → localized copy key)", () => {
  it("maps each dedicated status to its own key", () => {
    expect(aiErrorKey(402)).toBe("board.ai.error.upgrade");
    expect(aiErrorKey(429)).toBe("board.ai.error.rateLimited");
    expect(aiErrorKey(409)).toBe("board.ai.error.conflict");
    expect(aiErrorKey(400)).toBe("board.ai.error.invalid");
  });

  it("splits 422 on the server code: TOO_LARGE vs everything else", () => {
    expect(aiErrorKey(422, "AI_PLAN_TOO_LARGE")).toBe("board.ai.error.tooLarge");
    expect(aiErrorKey(422, "AI_PLAN_FAILED")).toBe("board.ai.error.invalid");
    expect(aiErrorKey(422)).toBe("board.ai.error.invalid");
  });

  it("falls back to the generic key for anything unmapped", () => {
    expect(aiErrorKey(500)).toBe("board.ai.errorGeneric");
    expect(aiErrorKey(0)).toBe("board.ai.errorGeneric");
    expect(aiErrorKey(503)).toBe("board.ai.errorGeneric");
  });
});
