// Pure wish → instruction compiler (v4 Task 12). The chip pickers build a
// Wish[]; this turns it into the English sentence(s) that seed the AI
// instruction textarea. English-only by contract (it feeds the LLM, never the
// UI — the pill labels are localized separately), so these assertions are on
// fixed English strings and must not be translated.
import { describe, expect, it } from "vitest";
import { compileWishes, type Wish } from "../wish-compile";

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
