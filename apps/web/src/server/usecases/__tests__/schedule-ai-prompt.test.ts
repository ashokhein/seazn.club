import { describe, it, expect } from "vitest";
import {
  SYSTEM_PROMPT,
  JOINT_RULES,
  AiSchedulePlan,
  AiConstraintDelta,
} from "../schedule-ai-prompt";

describe("schedule-ai prompt contract", () => {
  it("system prompt is frozen", () => {
    // Golden snapshot: any wording drift must be a deliberate, reviewed change.
    expect(SYSTEM_PROMPT).toMatchSnapshot();
  });

  it("carries the amended Coverage (S4) + Stability (S5) soft goals", () => {
    expect(SYSTEM_PROMPT).toContain(
      "S4. Coverage: prefer slots where each required officiating role has an eligible, free",
    );
    expect(SYSTEM_PROMPT).toContain(
      "S5. Stability: in refine and repair modes move as few fixtures as possible",
    );
    // The pre-relabel lettering must be gone.
    expect(SYSTEM_PROMPT).not.toContain("d. Stability:");
    expect(SYSTEM_PROMPT).not.toContain("d. Coverage:");
  });

  it("labels hard rules H1-H7 and soft goals S1-S5", () => {
    for (const id of ["H1.", "H2.", "H3.", "H4.", "H5.", "H6.", "H7."]) {
      expect(SYSTEM_PROMPT).toContain(id);
    }
    for (const id of ["S1.", "S2.", "S3.", "S4.", "S5."]) {
      expect(SYSTEM_PROMPT).toContain(id);
    }
    // The old bare numbering and lettering must be gone.
    expect(SYSTEM_PROMPT).not.toContain("\n1. court_label must be");
    expect(SYSTEM_PROMPT).not.toContain("\na. The organiser's instruction.");
  });

  it("requires unschedulable reasons to cite the blocking rule id", () => {
    expect(SYSTEM_PROMPT).toContain("citing the hard rule id");
    expect(SYSTEM_PROMPT).toContain("(H1-H7)");
  });

  it("plan schema accepts an assumptions array and rejects a non-string entry", () => {
    const base = {
      assignments: [],
      unschedulable: [],
      explanations: [],
      summary: "x",
    };
    expect(
      AiSchedulePlan.safeParse({ ...base, assumptions: ["read 'evenings' as after 18:00"] })
        .success,
    ).toBe(true);
    // Omitted is still valid — the field is optional.
    expect(AiSchedulePlan.safeParse(base).success).toBe(true);
    expect(AiSchedulePlan.safeParse({ ...base, assumptions: [42] }).success).toBe(false);
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

describe("JOINT_RULES (issue #350)", () => {
  it("is frozen", () => {
    expect(JOINT_RULES).toMatchSnapshot();
  });

  it("labels every joint rule J1..J6", () => {
    for (const id of ["J1.", "J2.", "J3.", "J4.", "J5.", "J6."]) {
      expect(JOINT_RULES).toContain(id);
    }
  });

  it("does not alter the frozen single-division system prompt", () => {
    expect(SYSTEM_PROMPT).not.toContain("J1");
    expect(SYSTEM_PROMPT).not.toContain("division_id");
  });

  it("tells the model the output shape is unchanged — no division field", () => {
    expect(JOINT_RULES).toMatch(/assignments/i);
    expect(JOINT_RULES).toMatch(/do not add/i);
  });

  it("J5 tells the model to rebalance rather than trust the draft (ruling R4)", () => {
    const j5 = JOINT_RULES.slice(
      JOINT_RULES.indexOf("J5."),
      JOINT_RULES.indexOf("J6."),
    );
    expect(j5.length).toBeGreaterThan(0);
    // The draft's own bias is named, not merely "the draft is a hint".
    expect(j5).toMatch(/legality hint/i);
    expect(j5).toMatch(/not a balance hint/i);
    expect(j5).toMatch(/rebalance/i);
    expect(j5).toMatch(/anchor/i);
    // …and the partial-draft case (ruling R5) is spelled out with the field name
    // that carries it, so the model can detect it rather than assume completeness.
    expect(j5).toContain("draftPlaced");
    expect(j5).toMatch(/partial/i);
  });

  it("J6 tells the model divisions may differ in timezone — compare instants", () => {
    const j6 = JOINT_RULES.slice(JOINT_RULES.indexOf("J6."));
    expect(j6.length).toBeGreaterThan(0);
    expect(j6).toMatch(/timezone/i);
    expect(j6).toMatch(/offset/i);
    expect(j6).toMatch(/instants,? not strings/i);
  });
});
