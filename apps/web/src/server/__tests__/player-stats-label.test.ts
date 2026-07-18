// G6 — shared stat labelling against the REAL football module registry:
// labels come from the declared playerStats model, zero rows drop, retired
// builds yield [] instead of throwing.
import { describe, expect, it } from "vitest";
import { labelPlayerStats } from "@/server/player-stats";

describe("labelPlayerStats", () => {
  it("labels football counters from the module model and drops zeros", () => {
    const rows = labelPlayerStats("football", "1.0.0", { goals: 3, assists: 0 });
    const goals = rows.find((r) => r.key === "goals");
    expect(goals?.value).toBe(3);
    expect(goals?.label.toLowerCase()).toContain("goal");
    expect(rows.find((r) => r.key === "assists")).toBeUndefined();
  });

  it("returns [] for a retired module build", () => {
    expect(labelPlayerStats("football", "0.0.1-gone", { goals: 3 })).toEqual([]);
  });
});
