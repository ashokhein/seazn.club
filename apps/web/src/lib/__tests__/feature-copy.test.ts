import { describe, it, expect } from "vitest";
import { featurePlan, featureReason } from "@/lib/feature-copy";

describe("feature-copy V290", () => {
  it("maps Plus features to pro_plus", () => {
    for (const k of ["api.write", "scorers.max", "scheduling.ai", "officials.auto", "domains.custom", "support.priority"]) {
      expect(featurePlan(k)).toBe("pro_plus");
    }
    expect(featurePlan("scheduling.board")).toBe("pro");
    expect(featurePlan("officials.roles_multi")).toBe("pro");
  });
  it("has reasons for the new keys and none for the dead one", () => {
    expect(featureReason("officials.per_fixture.max")).toMatch(/one official per fixture/i);
    expect(featureReason("schedule.checkpoints.max")).toMatch(/save.point/i);
    expect(featureReason("domains.custom")).toMatch(/domain/i);
    expect(featureReason("support.priority")).toMatch(/priority/i);
    // officials.assignment was deleted (D5) — falls back to the generic line.
    expect(featureReason("officials.assignment")).toBe("This feature needs a plan upgrade.");
  });
});
