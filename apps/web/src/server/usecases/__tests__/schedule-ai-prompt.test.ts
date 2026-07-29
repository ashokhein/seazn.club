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
  // The prompt is hard-wrapped at ~80 columns, so a pinned phrase can straddle a
  // newline plus four spaces of indent. Semantic pins therefore match against a
  // whitespace-normalised copy; the exact bytes, wrapping included, stay frozen
  // by the snapshot below. Without this a pure re-wrap would fail a semantic
  // test, which would train the next reader to reach for `vitest -u`.
  const flat = (s: string): string => s.replace(/\s+/g, " ");
  // Fails CLOSED. A dropped label makes indexOf return -1, and slice(x, -1) then
  // silently returns a WIDER span that the pins may still match — a deleted rule
  // would read as green. Assert the bounds rather than trusting the slice.
  const rule = (id: string, next: string): string => {
    const start = JOINT_RULES.indexOf(id);
    const end = JOINT_RULES.indexOf(next);
    expect(start, `label ${id} missing`).toBeGreaterThanOrEqual(0);
    expect(end, `label ${next} missing or out of order`).toBeGreaterThan(start);
    return flat(JOINT_RULES.slice(start, end));
  };
  const tail = (id: string): string => {
    const start = JOINT_RULES.indexOf(id);
    expect(start, `label ${id} missing`).toBeGreaterThanOrEqual(0);
    return flat(JOINT_RULES.slice(start));
  };

  it("is frozen", () => {
    expect(JOINT_RULES).toMatchSnapshot();
  });

  it("labels every joint rule J1..J7", () => {
    for (const id of ["J1.", "J2.", "J3.", "J4.", "J5.", "J6.", "J7."]) {
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

  it("keeps the unschedulable escape hatch in the OUTPUT clause", () => {
    // SYSTEM_PROMPT:70-72 says every movable fixture appears exactly once — in
    // assignments OR in unschedulable. A joint restatement naming only
    // `assignments` pushes the model to invent illegal slots for overflow, which
    // is the EXPECTED joint failure (it is why draftPlaced can be short and why
    // the 500 cap exists), and the org pays for the repair rounds.
    const out = tail("OUTPUT");
    expect(out).toContain("unschedulable");
    expect(out).toMatch(/appears exactly once/);
    expect(out).toMatch(/assignments array, or in unschedulable/);
  });

  it("ranks J4/J5 as goals under S1, not as hard rules", () => {
    // An unconditional J4 outranks S1 ("the organiser's instruction ... outranks
    // everything except hard rules", SYSTEM_PROMPT:52-54) and collides with that
    // prompt's own worked example, "juniors always before 2pm".
    const preamble = flat(JOINT_RULES.slice(0, JOINT_RULES.indexOf("J1.")));
    expect(preamble).toMatch(/J1, J2, J3 and J6/);
    expect(preamble).toMatch(/J4 and J5/);
    expect(preamble).toMatch(/hard/i);
    expect(preamble).toMatch(/goal/i);
    // Pin the DIRECTION, not just the token. `/S1/` alone is satisfied by the
    // literal "S1-S5", so a rewrite to "ABOVE the organiser's instruction" —
    // the exact inversion this test exists to prevent — would still pass.
    expect(preamble).toMatch(/below the organiser's instruction/);
    // And J4 itself must yield to the instruction rather than dilute it.
    expect(rule("J4.", "J5.")).toMatch(/S1 wins/);
  });

  it("scopes the verifier per division without implying an intersection-only board", () => {
    // "runs H1-H7 once per division against its own settings over the whole
    // board" reads as: apply A's settings to every fixture — which rejects B's
    // fixtures on B-only courts, i.e. demands the INTERSECTION of court sets.
    // That is the opposite of J1, and divergentCourts exists precisely because
    // non-shared courts are expected. The two ideas must be stated separately.
    const preamble = flat(JOINT_RULES.slice(0, JOINT_RULES.indexOf("J1.")));
    expect(preamble).toMatch(/own fixtures/);
    expect(preamble).toMatch(/court and person checks/);
    expect(preamble).toMatch(/occupancy/);
    // The enumeration must cover prior-proposal entries, which carry a
    // division_id too and are read in refine and repair.
    expect(preamble).toMatch(/prior[- ]proposal/i);
  });

  it("explains divergentCourts, the precomputed answer to J1 and J2", () => {
    // The pack ships it and the board warns on it; the model was never told what
    // it means, so the one field that flags a court it may not use went unread.
    const flatAll = flat(JOINT_RULES);
    expect(flatAll).toContain("divergentCourts");
    expect(flatAll).toMatch(/some divisions only|not in every division|exist for some/i);
  });

  it("J3 names perEntrantMinRest, which sits outside constraints", () => {
    // PackSettings.perEntrantMinRest is a SIBLING of constraints, and H4 cites it
    // by name. Its own docstring records that it was added because it had been
    // "silently ignored by AI Schedule" — leaving it unnamed here repeats that.
    expect(rule("J3.", "J4.")).toContain("perEntrantMinRest");
  });

  it("J7 states the shared-player map spans every selected division", () => {
    // buildCompetitionPack now builds `people` over the RUN's whole entrant set,
    // so cross-division sharers are in the map and H4 applies to them normally.
    // J7 is a statement of fact about the pack, not a warning about missing data.
    const j7 = tail("J7.");
    expect(j7).toMatch(/shared-player map/i);
    expect(j7).toMatch(/every selected division|across (every|all)/i);
    expect(j7).toMatch(/H4/);
  });

  it("J7 promises nothing the server does not deliver", () => {
    // The prompt must not claim a rejection the pipeline cannot produce.
    // person_overlap is a WARN (calendar.ts:102) and isBlocking covers only
    // `court` and direct `order` (schedule-ai.ts:831-833), so a plan whose sole
    // flaw is a person clash returns clean and never triggers a repair round.
    // Promising a rejection would be a lie the model then reasons from.
    const j7 = tail("J7.");
    expect(j7).not.toMatch(/reject/i);
    expect(j7).not.toMatch(/repair round/i);
    // And it must not tell the model the data is unavailable — it now is.
    expect(j7).not.toMatch(/cannot predict/i);
    expect(j7).not.toMatch(/within[- ]division only/i);
  });

  it("J5 tells the model to rebalance rather than trust the draft (ruling R4)", () => {
    const j5 = rule("J5.", "J6.");
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
    // J5 is labelled a GOAL, but "place the remainder yourself" is not tradeable
    // against S2/S3: structuralCheck (schedule-ai.ts:865-867) rejects any plan
    // missing a movable id, so those fixtures must still be accounted for.
    expect(j5).toMatch(/still (has to|have to|must)|OUTPUT accounting|accounted for/i);
  });

  it("J6 tells the model divisions may differ in timezone — compare instants", () => {
    const j6 = rule("J6.", "J7.");
    expect(j6.length).toBeGreaterThan(0);
    expect(j6).toMatch(/timezone/i);
    expect(j6).toMatch(/instants,? not strings/i);
    // Name the fields that actually carry a time. PackObstacle is
    // {court, from, to, label} — it has no scheduled_at, so citing one there
    // sends the model looking for a field that does not exist.
    expect(j6).toContain("scheduled_at");
    expect(j6).toContain("from/to");
    // A foreign obstacle (division_id: null) is re-rendered in canonicalTz —
    // divisions[0].tz — NOT in "its own division's" zone, which it has none of.
    expect(j6).toMatch(/null division_id/);
    expect(j6).toMatch(/first listed division/i);
    // …and which zone to EMIT in, since SYSTEM_PROMPT:33's "the division
    // timezone" is singular and becomes per-fixture in joint mode.
    expect(j6).toMatch(/write each assignment/i);
  });
});
