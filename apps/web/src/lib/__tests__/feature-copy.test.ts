import { describe, it, expect } from "vitest";
import { featurePlan, featureReason } from "@/lib/feature-copy";

describe("feature-copy V290", () => {
  it("maps Plus features to pro_plus", () => {
    for (const k of ["api.write", "scorers.max", "officials.auto", "domains.custom", "support.priority"]) {
      expect(featurePlan(k)).toBe("pro_plus");
    }
    expect(featurePlan("scheduling.board")).toBe("pro");
    expect(featurePlan("officials.roles_multi")).toBe("pro");
    // V302 (owner 2026-07-19): AI scheduling exists on every tier; Pro is the
    // next step up for the bool feature-flag itself.
    expect(featurePlan("scheduling.ai")).toBe("pro");
  });
  it("has reasons for the new keys and none for the dead one", () => {
    expect(featureReason("officials.per_fixture.max")).toMatch(/one official per fixture/i);
    expect(featureReason("schedule.checkpoints.max")).toMatch(/save.point/i);
    expect(featureReason("scheduling.ai")).toMatch(/AI Schedule/);
    expect(featureReason("domains.custom")).toMatch(/domain/i);
    expect(featureReason("support.priority")).toMatch(/priority/i);
    // scheduling.ai.runs_per_division.max retired (v17 Phase 2 Task 5, V322):
    // the graded per-division cap copy is gone — falls back to the generic
    // line, same as any other deleted key.
    expect(featureReason("scheduling.ai.runs_per_division.max")).toBe(
      "This feature needs a plan upgrade.",
    );
    // officials.assignment was deleted (D5) — falls back to the generic line.
    expect(featureReason("officials.assignment")).toBe("This feature needs a plan upgrade.");
  });
  it("orgs.max_owned names the same remedy the 402's machine hint does (v17 gap #293)", () => {
    // The refusal ships TWO halves of one message: `{ offer: "extra_org" }` in
    // the body and this sentence next to it. If the copy drifts back to
    // "upgrade in Settings → Billing", the paywall tells the payer to do one
    // thing while the payload offers another, and nothing else notices.
    const reason = featureReason("orgs.max_owned");
    expect(reason).toMatch(/extra organisation/i);
    expect(reason).toMatch(/Add-ons/);
    // The rider is MONTHLY-ONLY, so it must not claim to cost what an org
    // already on the bill costs: the plan price's second graduated tier is
    // 900/1900 a month but 7900/16300 a YEAR, so any rate equivalence is ~37%
    // wrong for an annual group. The figure belongs to the Add-ons page, which
    // knows the currency and reads it from the rider SKU. Absence assertion,
    // so it sits next to the positive ones above deliberately: the sentence
    // must still NAME the purchase, it just must not PRICE it.
    expect(reason).not.toMatch(/half/i);
    expect(reason).not.toMatch(/same rate/i);
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
