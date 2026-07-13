// v8 (spec 2026-07-13): the format is editable until any stage owns
// fixtures — then it's history, not a setting. Shared by the Settings tab
// UI and the PATCH guard so hiding and enforcement can't drift.
import { describe, expect, it } from "vitest";
import { formatLocked } from "../format-lock";

describe("formatLocked", () => {
  it("stays unlocked with no stages", () => {
    expect(formatLocked([])).toBe(false);
  });

  it("stays unlocked while stages have zero fixtures", () => {
    expect(formatLocked([{ fixture_count: 0 }, { fixture_count: 0 }])).toBe(false);
  });

  it("locks as soon as any stage owns a fixture", () => {
    expect(formatLocked([{ fixture_count: 0 }, { fixture_count: 3 }])).toBe(true);
  });
});
