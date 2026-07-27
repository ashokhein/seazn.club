import { describe, expect, it } from "vitest";
import { EVENTS } from "@/lib/analytics-events";
import { competitionLifecycleEvent } from "../competitions";

// v17 #289: `statusChangedTo === "active" || statusChangedTo === "complete"`
// compared against CompetitionStatus values that never exist — "live" and
// "completed" are the real enum members (schemas.ts's CompetitionStatus) —
// so COMPETITION_STARTED/COMPETITION_COMPLETED never fired. Pure decision
// helper, mirrors shouldFireMadePublic — no DB needed.
describe("competitionLifecycleEvent", () => {
  it("fires COMPETITION_STARTED on the transition to live", () => {
    expect(competitionLifecycleEvent("live")).toBe(EVENTS.COMPETITION_STARTED);
  });

  it("fires COMPETITION_COMPLETED on the transition to completed", () => {
    expect(competitionLifecycleEvent("completed")).toBe(EVENTS.COMPETITION_COMPLETED);
  });

  it("does NOT fire on a transition to published — published is not started", () => {
    expect(competitionLifecycleEvent("published")).toBeNull();
  });

  it("does not fire on a transition to draft or archived", () => {
    expect(competitionLifecycleEvent("draft")).toBeNull();
    expect(competitionLifecycleEvent("archived")).toBeNull();
  });

  it("does not fire when the status did not change (null — no transition)", () => {
    expect(competitionLifecycleEvent(null)).toBeNull();
  });
});
