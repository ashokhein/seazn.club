import { describe, it, expect } from "vitest";
import { featurePlan, featureReason } from "@/lib/feature-copy";

describe("feature-copy V290", () => {
  it("maps Plus features to pro_plus", () => {
    for (const k of ["api.write", "scorers.max", "scheduling.ai.runs_per_division.max", "officials.auto", "domains.custom", "support.priority"]) {
      expect(featurePlan(k)).toBe("pro_plus");
    }
    expect(featurePlan("scheduling.board")).toBe("pro");
    expect(featurePlan("officials.roles_multi")).toBe("pro");
    // V291 (owner 2026-07-18): AI scheduling unlocks on Pro; only lifting its
    // per-division cap needs Pro Plus.
    expect(featurePlan("scheduling.ai")).toBe("pro");
  });
  it("has reasons for the new keys and none for the dead one", () => {
    expect(featureReason("officials.per_fixture.max")).toMatch(/one official per fixture/i);
    expect(featureReason("schedule.checkpoints.max")).toMatch(/save.point/i);
    expect(featureReason("scheduling.ai")).toMatch(/architect/i);
    expect(featureReason("domains.custom")).toMatch(/domain/i);
    expect(featureReason("support.priority")).toMatch(/priority/i);
    // V291: AI scheduling is now a Pro feature; its cap breach points at Pro Plus.
    expect(featureReason("scheduling.ai")).toMatch(/pro feature/i);
    expect(featureReason("scheduling.ai.runs_per_division.max")).toMatch(/unlimited/i);
    // officials.assignment was deleted (D5) — falls back to the generic line.
    expect(featureReason("officials.assignment")).toBe("This feature needs a plan upgrade.");
  });
  it("has copy for the v16 league-ops entitlements (V293/V294/V295, T84)", () => {
    expect(featureReason("discipline.enforced")).toBe(
      "Automatic suspension tracking is a Pro feature.",
    );
    expect(featureReason("officials.marks")).toBe("Rating your match officials is a Pro feature.");
    expect(featureReason("news.auto")).toBe("Auto-drafted result posts are a Pro feature.");
    expect(featurePlan("discipline.enforced")).toBe("pro");
    expect(featurePlan("officials.marks")).toBe("pro");
    expect(featurePlan("news.auto")).toBe("pro");
  });
});
