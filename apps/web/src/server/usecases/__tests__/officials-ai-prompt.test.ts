import { describe, it, expect } from "vitest";
import {
  OFFICIALS_SYSTEM_PROMPT,
  AiOfficialsPlan,
} from "../officials-ai-prompt";

describe("officials-ai prompt contract", () => {
  it("system prompt is frozen", () => {
    // Golden snapshot: any wording drift must be a deliberate, reviewed change.
    expect(OFFICIALS_SYSTEM_PROMPT).toMatchSnapshot();
  });

  it("carries the officials-specific soft goals", () => {
    expect(OFFICIALS_SYSTEM_PROMPT).toContain(
      "You are the officials architect inside league-management software.",
    );
    expect(OFFICIALS_SYSTEM_PROMPT).toContain(
      "c. Continuity: prefer keeping an official on the same court across back-to-back fixtures.",
    );
  });

  it("accepts a well-formed plan", () => {
    const good = {
      assignments: [
        {
          fixture_id: crypto.randomUUID(),
          official_id: crypto.randomUUID(),
          role_key: "umpire",
        },
      ],
      unfilled: [
        {
          fixture_id: crypto.randomUUID(),
          role_key: "linesman",
          reason: "no eligible official free",
        },
      ],
      explanations: [{ fixture_id: crypto.randomUUID(), note: "senior on final" }],
      summary: "Assigned every slot; one linesman gap.",
    };
    expect(AiOfficialsPlan.safeParse(good).success).toBe(true);
  });

  it("rejects an assignment missing role_key", () => {
    const bad = {
      assignments: [
        {
          fixture_id: crypto.randomUUID(),
          official_id: crypto.randomUUID(),
        },
      ],
      unfilled: [],
      explanations: [],
      summary: "x",
    };
    expect(AiOfficialsPlan.safeParse(bad).success).toBe(false);
  });

  it("rejects an unfilled entry without a reason", () => {
    const bad = {
      assignments: [],
      unfilled: [{ fixture_id: crypto.randomUUID(), role_key: "umpire" }],
      explanations: [],
      summary: "x",
    };
    expect(AiOfficialsPlan.safeParse(bad).success).toBe(false);
  });
});
