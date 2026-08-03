// W5 (#400) Task 6 — the confirm gate, as a pure reducer.
//
// THIS FILE IS THE WAVE'S HEADLINE GUARANTEE. "Declining spends no credit" is
// true because `canRun` is false until a preview has been confirmed, and
// because that is decided in the REDUCER rather than in JSX. A gate written as
// a disabled attribute is a gate one refactor away from vanishing with nothing
// red to show for it; a gate written here fails a unit test the moment it
// stops holding.
//
// No DOM, no fetch. Every assertion below is about state transitions only.
import { describe, expect, it } from "vitest";
import type { AiParsePreviewResponse } from "@/server/api-v1/schemas";
import {
  aiConsoleReducer as reduce,
  canRun,
  initialAiConsoleState,
  type AiConsoleState,
} from "../ai-console-state";
import { schedulePlanBody } from "../ai-console";

const PREVIEW: AiParsePreviewResponse = {
  preview_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  failed: false,
  compiled: {
    hard: [
      {
        type: "fixture_on_weekday",
        selector: { kind: "terminal" },
        weekday: "FRI",
        scope: { kind: "competition" },
      },
    ],
    soft: [],
    unparsed: [],
    assumptions: ["Read the end of the window as the following week."],
  },
  window: { start: "2026-08-03", end: "2026-08-09", tz: "Europe/London" },
  expires_at: "2026-08-03T12:00:00.000Z",
};

const INSTRUCTION = "finals on Friday";

const withInstruction: AiConsoleState = reduce(initialAiConsoleState, {
  type: "SET_INSTRUCTION",
  value: INSTRUCTION,
});
const withPreview: AiConsoleState = reduce(withInstruction, {
  type: "PREVIEW_READY",
  preview: PREVIEW,
});
const failedPreview: AiConsoleState = reduce(withInstruction, {
  type: "PREVIEW_READY",
  preview: { ...PREVIEW, failed: true, preview_id: undefined },
});

describe("the confirm gate", () => {
  it("cannot run before a preview is confirmed", () => {
    const s = reduce(initialAiConsoleState, { type: "SET_INSTRUCTION", value: INSTRUCTION });
    // The run button is not the first click. Nothing has been compiled, so
    // there is nothing the organiser could have agreed to.
    expect(canRun(s)).toBe(false);
    expect(s.preview.status).toBe("idle");
  });

  it("cannot run on an empty or too-short brief even with a preview in hand", () => {
    // Guards the ordering: the preview slice must not be able to unlock a run
    // the existing length check refuses.
    const s = reduce(withPreview, { type: "SET_INSTRUCTION", value: "hi" });
    expect(canRun(s)).toBe(false);
  });

  it("can run once a preview is ready, and the run carries its id", () => {
    expect(canRun(withPreview)).toBe(true);
    expect(withPreview.preview.status).toBe("ready");
    expect(withPreview.preview.id).toBe(PREVIEW.preview_id);
    expect(withPreview.preview.data).toEqual(PREVIEW);
  });

  it("declining clears the preview and returns to an editable brief without running", () => {
    const s = reduce(withPreview, { type: "PREVIEW_DISMISS" });
    expect(s.preview.status).toBe("idle");
    expect(s.preview.id).toBe(null);
    expect(canRun(s)).toBe(false);
    // No run was ever started — declining is a pure client action, which is
    // the whole reason it costs nothing.
    expect(s.run).toBe("idle");
    // And the brief itself survives: the organiser lands back on their own
    // words, not on an empty textarea.
    expect(s.instruction).toBe(INSTRUCTION);
    expect(s.mode).toBe(withPreview.mode);
    expect(s.rung).toBe(withPreview.rung);
  });

  it("editing the instruction invalidates a preview already given", () => {
    const s = reduce(withPreview, { type: "SET_INSTRUCTION", value: "finals on Saturday" });
    expect(s.preview.status).toBe("idle");
    // You cannot confirm rules for one sentence and run another.
    expect(canRun(s)).toBe(false);
  });

  it("survives a whitespace-only edit rather than making the organiser re-check", () => {
    const s = reduce(withPreview, { type: "SET_INSTRUCTION", value: `  ${INSTRUCTION}  ` });
    expect(s.preview.status).toBe("ready");
    expect(canRun(s)).toBe(true);
  });

  it("refuses to run a preview taken for a different sentence, however it got there", () => {
    // Belt and braces: even if some future action forgets to clear the slice,
    // the gate compares the previewed sentence with the current one itself.
    const forged: AiConsoleState = {
      ...withPreview,
      instruction: "something else entirely",
    };
    expect(canRun(forged)).toBe(false);
  });

  it("a failed compile does not become runnable by itself", () => {
    expect(failedPreview.preview.status).toBe("ready");
    expect(failedPreview.preview.data?.failed).toBe(true);
    expect(failedPreview.preview.id).toBe(null);
    // Silent fallback is refused: presenting a rule as enforced while nothing
    // enforces it is the failure this wave exists to close.
    expect(canRun(failedPreview)).toBe(false);
    expect(failedPreview.preview.asPreference).toBe(false);
  });

  it("taking the preference fallback is an explicit action, and it runs", () => {
    const s = reduce(failedPreview, { type: "PREVIEW_AS_PREFERENCE" });
    expect(canRun(s)).toBe(true);
    // And the run says so — the request carries no preview_id, so the server
    // compiles inline exactly as it did before this wave.
    expect(s.preview.asPreference).toBe(true);
    expect(s.preview.id).toBe(null);
  });

  it("never grants the fallback to a preview nobody asked to fall back on", () => {
    // PREVIEW_AS_PREFERENCE is the only writer of `asPreference`, and it is only
    // ever dispatched from the failed card's own button.
    expect(withPreview.preview.asPreference).toBe(false);
    expect(reduce(withInstruction, { type: "PREVIEW_START" }).preview.asPreference).toBe(false);
    expect(
      reduce(failedPreview, { type: "PREVIEW_ERROR", error: { status: 500, message: "boom" } })
        .preview.asPreference,
    ).toBe(false);
  });

  it("cannot run while the compile is still in flight", () => {
    const s = reduce(withInstruction, { type: "PREVIEW_START" });
    expect(s.preview.status).toBe("loading");
    expect(canRun(s)).toBe(false);
  });

  it("cannot run when the compile request failed", () => {
    const s = reduce(withInstruction, {
      type: "PREVIEW_ERROR",
      error: { status: 429, message: "slow down" },
    });
    expect(s.preview.status).toBe("error");
    expect(canRun(s)).toBe(false);
    expect(s.error?.status).toBe(429);
  });

  it("cannot run while a run is already going", () => {
    const s = reduce(withPreview, { type: "RUN_START" });
    expect(canRun(s)).toBe(false);
  });

  it("spends the preview on the run that used it, so it cannot be posted twice", () => {
    // The server marks the row consumed. A second POST carrying the same id is
    // a 409, so the client must not keep offering it.
    const s = reduce(withPreview, { type: "RUN_START" });
    expect(s.preview.status).toBe("idle");
    expect(s.preview.id).toBe(null);
    expect(canRun(s)).toBe(false);
  });

  it("refuses on a frozen board, before anything is spent", () => {
    expect(canRun(withPreview, { scheduleFrozen: true })).toBe(false);
  });

  it("clears the preview when the console resets", () => {
    const s = reduce(withPreview, { type: "RESET" });
    expect(s.preview).toEqual(initialAiConsoleState.preview);
    expect(canRun(s)).toBe(false);
  });

  it("puts the confirmed compile on the wire, so the run executes the rules that were shown", () => {
    const body = schedulePlanBody(withPreview, { instruction: INSTRUCTION, mode: "generate" });
    expect(body.preview_id).toBe(PREVIEW.preview_id);
  });

  it("sends no preview_id on the preference fallback", () => {
    // There is no stored parse to reuse: the server compiles inline exactly as
    // it did before this wave, and nothing claims the sentence is enforced.
    const s = reduce(failedPreview, { type: "PREVIEW_AS_PREFERENCE" });
    expect(canRun(s)).toBe(true);
    expect(schedulePlanBody(s, { instruction: INSTRUCTION, mode: "generate" })).not.toHaveProperty(
      "preview_id",
    );
  });

  it("starts idle", () => {
    expect(initialAiConsoleState.preview).toEqual({
      status: "idle",
      data: null,
      id: null,
      asPreference: false,
      instruction: null,
    });
    expect(canRun(initialAiConsoleState)).toBe(false);
  });
});
