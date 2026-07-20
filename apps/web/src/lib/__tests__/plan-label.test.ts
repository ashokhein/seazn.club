// Plan display names. The billing page rendered the raw `plan_key` under a CSS
// `capitalize`, so a Pro Plus org's Current plan card read "Pro_plus"; the
// cancel dialog and the resume button said "Pro" to that same subscriber, and
// "Keep Pro" actually restored Pro Plus.
import { describe, expect, it } from "vitest";
import { planLabel } from "@/lib/plan-label";

describe("planLabel", () => {
  it("spells the paid plans the way the product does", () => {
    expect(planLabel("pro_plus")).toBe("Pro Plus");
    expect(planLabel("pro")).toBe("Pro");
    expect(planLabel("community")).toBe("Community");
  });

  it("never leaks a raw key: an unmapped plan is title-cased, not shown as-is", () => {
    expect(planLabel("pro_ultra")).toBe("Pro Ultra");
  });

  it("treats a missing plan as Community — a row with no subscription is free", () => {
    expect(planLabel(null)).toBe("Community");
    expect(planLabel(undefined)).toBe("Community");
    expect(planLabel("")).toBe("Community");
  });

  // CSS `capitalize` is what produced "Pro_plus"; it also cannot fix it, since
  // it only touches the first letter of a whitespace-delimited word.
  it("produces a label that needs no CSS capitalize to read correctly", () => {
    expect(planLabel("pro_plus")).not.toContain("_");
  });
});
