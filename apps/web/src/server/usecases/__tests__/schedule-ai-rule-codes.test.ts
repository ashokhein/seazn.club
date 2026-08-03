// #399 W4 — the rule vocabulary on the AI surfaces.
//
// A repair round is only mechanical if the report speaks the words the prompt
// taught. Two halves: conflicts carry the code (engine, calendar.ts), and an
// unschedulable row carries either the rule the model cited or `CAP` — the
// capacity case, where no single rule was broken and the schedule simply cannot
// exist.
import { describe, expect, it } from "vitest";
import { unschedulableRule } from "../schedule-ai";

describe("unschedulableRule (#399)", () => {
  it("keeps the rule the model cited", () => {
    expect(unschedulableRule("H2 — no free court in the window")).toBe("H2");
    expect(unschedulableRule("breaks H4, the entrant would get no rest")).toBe("H4");
    expect(unschedulableRule("h6: its feeder is unscheduled")).toBe("H6");
  });

  it("falls back to CAP when no rule is named", () => {
    // Demand exceeded capacity: no single rule is violated, the schedule cannot
    // exist. A rule code here would send the repair round after the wrong thing.
    expect(unschedulableRule("not enough court time for 40 matches in one day")).toBe("CAP");
    expect(unschedulableRule("")).toBe("CAP");
  });

  it("does not invent a code the Conflict vocabulary does not have", () => {
    // The prompts teach H1 and H7 as well, but they map to no ConflictReason —
    // passing one through would put a value in the enum nothing can render.
    expect(unschedulableRule("H1 says every fixture needs a slot")).toBe("CAP");
    expect(unschedulableRule("H7 whatever")).toBe("CAP");
    // And a joint (J-series) citation is not an H rule either.
    expect(unschedulableRule("J3 — the divisions share a court")).toBe("CAP");
  });
});
