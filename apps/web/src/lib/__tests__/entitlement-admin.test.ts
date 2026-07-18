import { describe, expect, it } from "vitest";
import { groupForAdmin, type AdminEntRow } from "../entitlement-admin";

// V290: /admin/entitlements pivots plan_entitlements rows into the same
// domain grouping as /pricing (ENTITLEMENT_DOMAINS), plus a trailing "other"
// section for keys not in that list (vestigial + spec-2 domains.custom).
describe("groupForAdmin", () => {
  const rows: AdminEntRow[] = [
    // scale domain — bool feature (import.bulk), varies by plan
    { feature_key: "import.bulk", plan_key: "community", bool_value: false, int_value: null },
    { feature_key: "import.bulk", plan_key: "pro", bool_value: true, int_value: null },
    // scale domain — dual bool+int feature, no row for event_pass (renders "—")
    { feature_key: "members.max", plan_key: "community", bool_value: true, int_value: 20 },
    { feature_key: "members.max", plan_key: "pro", bool_value: true, int_value: null },
    // unknown key not in ENTITLEMENT_DOMAINS at all
    { feature_key: "some.vestigial.key", plan_key: "pro_plus", bool_value: true, int_value: null },
  ];

  it("caps at 9 sections (8 domains + trailing other)", () => {
    const sections = groupForAdmin(rows);
    expect(sections.length).toBeLessThanOrEqual(9);
  });

  it("puts an unknown key in a trailing 'other' section", () => {
    const sections = groupForAdmin(rows);
    const other = sections.find((s) => s.slug === "other");
    expect(other).toBeDefined();
    expect(other!.features.map((f) => f.feature_key)).toContain("some.vestigial.key");
    expect(sections[sections.length - 1].slug).toBe("other");
  });

  it("renders a plain bool feature as true/false per plan", () => {
    const sections = groupForAdmin(rows);
    const scale = sections.find((s) => s.slug === "scale")!;
    const importBulk = scale.features.find((f) => f.feature_key === "import.bulk")!;
    expect(importBulk.cells.community).toBe("false");
    expect(importBulk.cells.pro).toBe("true");
  });

  it("renders a dual bool+int feature as 'true (N)'", () => {
    const sections = groupForAdmin(rows);
    const scale = sections.find((s) => s.slug === "scale")!;
    const membersMax = scale.features.find((f) => f.feature_key === "members.max")!;
    expect(membersMax.cells.community).toBe("true (20)");
  });

  it("renders a bool-only cell (int_value null) as true, not dual", () => {
    // members.max on pro has bool_value true, int_value null -> plain "true"
    const sections = groupForAdmin(rows);
    const scale = sections.find((s) => s.slug === "scale")!;
    const membersMax = scale.features.find((f) => f.feature_key === "members.max")!;
    expect(membersMax.cells.pro).toBe("true");
  });

  it("renders a missing plan cell as em dash", () => {
    const sections = groupForAdmin(rows);
    const scale = sections.find((s) => s.slug === "scale")!;
    const membersMax = scale.features.find((f) => f.feature_key === "members.max")!;
    expect(membersMax.cells.event_pass).toBe("—");
  });

  it("renders a pure-int feature's null int_value as ∞", () => {
    const rowsInt: AdminEntRow[] = [
      { feature_key: "competitions.max_active", plan_key: "pro", bool_value: null, int_value: null },
      { feature_key: "competitions.max_active", plan_key: "community", bool_value: null, int_value: 2 },
    ];
    const sections = groupForAdmin(rowsInt);
    const scale = sections.find((s) => s.slug === "scale")!;
    const feature = scale.features.find((f) => f.feature_key === "competitions.max_active")!;
    expect(feature.cells.pro).toBe("∞");
    expect(feature.cells.community).toBe("2");
  });
});
