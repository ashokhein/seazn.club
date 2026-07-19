import { describe, it, expect } from "vitest";
import {
  SYSTEM_PROMPT,
  AiSchedulePlan,
  AiConstraintDelta,
} from "../schedule-ai-prompt";

describe("schedule-ai prompt contract", () => {
  it("system prompt is frozen", () => {
    // Golden snapshot: any wording drift must be a deliberate, reviewed change.
    expect(SYSTEM_PROMPT).toMatchSnapshot();
  });

  it("carries the amended Coverage (d) + Stability (e) soft goals", () => {
    expect(SYSTEM_PROMPT).toContain(
      "d. Coverage: prefer slots where each required officiating role has an eligible, free",
    );
    expect(SYSTEM_PROMPT).toContain(
      "e. Stability: in refine and repair modes move as few fixtures as possible",
    );
    // The old lettering must be gone.
    expect(SYSTEM_PROMPT).not.toContain("d. Stability:");
  });

  it("plan schema rejects an assignment missing a court", () => {
    const bad = {
      assignments: [
        {
          fixture_id: crypto.randomUUID(),
          scheduled_at: "2026-07-18T10:00:00+01:00",
        },
      ],
      unschedulable: [],
      explanations: [],
      summary: "x",
    };
    expect(AiSchedulePlan.safeParse(bad).success).toBe(false);
  });

  it("accepts a well-formed plan", () => {
    const good = {
      assignments: [
        {
          fixture_id: crypto.randomUUID(),
          scheduled_at: "2026-07-18T10:00:00+01:00",
          court_label: "Court 1",
          schedule_locked: true,
        },
      ],
      unschedulable: [
        { fixture_id: crypto.randomUUID(), reason: "no free window" },
      ],
      explanations: [{ fixture_id: crypto.randomUUID(), note: "final last" }],
      constraint_suggestions: { noBackToBack: true, restMin: 20 },
      summary: "Placed everything; one fixture stranded.",
    };
    expect(AiSchedulePlan.safeParse(good).success).toBe(true);
  });

  it("rejects a scheduled_at without a UTC offset", () => {
    const bad = {
      assignments: [
        {
          fixture_id: crypto.randomUUID(),
          scheduled_at: "2026-07-18T10:00:00", // no offset
          court_label: "Court 1",
        },
      ],
      unschedulable: [],
      explanations: [],
      summary: "x",
    };
    expect(AiSchedulePlan.safeParse(bad).success).toBe(false);
  });

  it("constraint delta reuses the engine schema (all fields optional)", () => {
    // A partial of SchedulingConstraints accepts the empty object.
    expect(AiConstraintDelta.safeParse({}).success).toBe(true);
    // And still validates field shapes it does carry.
    expect(
      AiConstraintDelta.safeParse({ crossPersonClash: "nope" }).success,
    ).toBe(false);
  });
});
