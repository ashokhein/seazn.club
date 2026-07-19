// Pure wish → instruction compiler (v4 Task 12). The chip pickers build a
// Wish[]; this turns it into the English sentence(s) that seed the AI
// instruction textarea. English-only by contract (it feeds the LLM, never the
// UI — the pill labels are localized separately), so these assertions are on
// fixed English strings and must not be translated.
import { describe, expect, it } from "vitest";
import { compileWishes, deriveFreeText, joinNonEmpty, type Wish } from "../wish-compile";

describe("compileWishes", () => {
  it("returns an empty string for no wishes", () => {
    expect(compileWishes([])).toBe("");
  });

  it("compiles finish_by into a deadline sentence", () => {
    expect(compileWishes([{ kind: "finish_by", time: "18:00" }])).toBe("Finish by 18:00.");
  });

  it("compiles final_last into a court sentence", () => {
    expect(compileWishes([{ kind: "final_last", court: "Court 1" }])).toBe(
      "Put the final last on Court 1.",
    );
  });

  it("compiles start_window with the before edge", () => {
    expect(
      compileWishes([
        { kind: "start_window", target: "e1", targetName: "Under-12s", edge: "before", time: "14:00" },
      ]),
    ).toBe("Schedule Under-12s before 14:00.");
  });

  it("compiles start_window with the after edge", () => {
    expect(
      compileWishes([
        { kind: "start_window", target: "e2", targetName: "Seniors", edge: "after", time: "10:00" },
      ]),
    ).toBe("Schedule Seniors after 10:00.");
  });

  it("compiles keep_apart into a separation sentence", () => {
    expect(
      compileWishes([{ kind: "keep_apart", aName: "Team A", bName: "Team B" }]),
    ).toBe("Keep Team A and Team B apart.");
  });

  it("compiles pin_entrant into a keep-slots sentence", () => {
    expect(compileWishes([{ kind: "pin_entrant", name: "Riverside" }])).toBe(
      "Keep Riverside's existing slots.",
    );
  });

  it("joins multiple wishes with a single space, in order", () => {
    const wishes: Wish[] = [
      { kind: "finish_by", time: "18:00" },
      { kind: "final_last", court: "Court 1" },
    ];
    expect(compileWishes(wishes)).toBe("Finish by 18:00. Put the final last on Court 1.");
  });

  it("compiles every kind together, space-joined in array order", () => {
    const wishes: Wish[] = [
      { kind: "pin_entrant", name: "Riverside" },
      { kind: "keep_apart", aName: "Team A", bName: "Team B" },
      { kind: "start_window", target: "e1", targetName: "Under-12s", edge: "before", time: "14:00" },
      { kind: "finish_by", time: "18:00" },
      { kind: "final_last", court: "Court 1" },
    ];
    expect(compileWishes(wishes)).toBe(
      "Keep Riverside's existing slots. Keep Team A and Team B apart. Schedule Under-12s before 14:00. Finish by 18:00. Put the final last on Court 1.",
    );
  });
});

describe("joinNonEmpty", () => {
  it("joins two non-empty parts with a single space", () => {
    expect(joinNonEmpty("Finish by 18:00.", "Leave late.")).toBe("Finish by 18:00. Leave late.");
  });

  it("drops an empty side without a stray space", () => {
    expect(joinNonEmpty("", "Leave late.")).toBe("Leave late.");
    expect(joinNonEmpty("Finish by 18:00.", "")).toBe("Finish by 18:00.");
    expect(joinNonEmpty("", "")).toBe("");
  });
});

describe("deriveFreeText", () => {
  it("returns the instruction unchanged when there is no compiled prefix", () => {
    expect(deriveFreeText("Anything I typed.", "")).toBe("Anything I typed.");
  });

  it("strips the compiled prefix and the space after it", () => {
    expect(deriveFreeText("Finish by 18:00. Leave late.", "Finish by 18:00.")).toBe("Leave late.");
  });

  it("returns empty when the instruction is exactly the compiled prefix", () => {
    expect(deriveFreeText("Finish by 18:00.", "Finish by 18:00.")).toBe("");
  });

  it("trims all leading whitespace left after the prefix", () => {
    expect(deriveFreeText("Finish by 18:00.   Leave late.", "Finish by 18:00.")).toBe("Leave late.");
  });

  it("keeps the whole string (no corruption) when it no longer starts with the prefix", () => {
    // Organiser hand-edited inside the compiled region (18:00 → 19:00).
    expect(deriveFreeText("Finish by 19:00. Leave late.", "Finish by 18:00.")).toBe(
      "Finish by 19:00. Leave late.",
    );
  });
});

// The console's chip ↔ instruction glue is joinNonEmpty(compileWishes(next),
// deriveFreeText(instruction, compileWishes(prev))). These exercise that flow.
describe("chip ↔ instruction round-trips (console glue)", () => {
  it("preserves free text when a chip is added", () => {
    const prev: Wish[] = [{ kind: "finish_by", time: "18:00" }];
    const instruction = "Finish by 18:00. Leave the derby until the evening.";
    const free = deriveFreeText(instruction, compileWishes(prev));
    expect(free).toBe("Leave the derby until the evening.");
    const next: Wish[] = [...prev, { kind: "keep_apart", aName: "A", bName: "B" }];
    expect(joinNonEmpty(compileWishes(next), free)).toBe(
      "Finish by 18:00. Keep A and B apart. Leave the derby until the evening.",
    );
  });

  it("preserves free text when a chip is removed", () => {
    const prev: Wish[] = [{ kind: "finish_by", time: "18:00" }];
    const instruction = "Finish by 18:00. Leave the derby until the evening.";
    const free = deriveFreeText(instruction, compileWishes(prev));
    expect(joinNonEmpty(compileWishes([]), free)).toBe("Leave the derby until the evening.");
  });

  it("degrades to all-free-text when the compiled prefix was hand-edited", () => {
    const prev: Wish[] = [{ kind: "finish_by", time: "18:00" }];
    const edited = "Finish by 19:00. Leave late.";
    const free = deriveFreeText(edited, compileWishes(prev));
    // Nothing dropped: the edited text survives as free text (may re-prepend a
    // fresh compiled sentence, which is the documented graceful degradation).
    expect(free).toBe("Finish by 19:00. Leave late.");
    const next: Wish[] = [{ kind: "final_last", court: "Court 1" }];
    expect(joinNonEmpty(compileWishes(next), free)).toBe(
      "Put the final last on Court 1. Finish by 19:00. Leave late.",
    );
  });

  it("keeps both the preset text and a newly added chip", () => {
    // A preset fill clears the chips, so the prior compiled prefix is empty.
    const preset = "Wrap up by 6pm, juniors before 2pm, final last on Court 1.";
    const free = deriveFreeText(preset, compileWishes([]));
    expect(free).toBe(preset);
    const added: Wish[] = [{ kind: "keep_apart", aName: "A", bName: "B" }];
    expect(joinNonEmpty(compileWishes(added), free)).toBe(
      "Keep A and B apart. Wrap up by 6pm, juniors before 2pm, final last on Court 1.",
    );
  });
});
