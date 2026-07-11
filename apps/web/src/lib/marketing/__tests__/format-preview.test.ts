import { describe, expect, it } from "vitest";
import { MARKETING_FORMATS, marketingPreview } from "../format-preview";

describe("marketingPreview", () => {
  it("returns drawable phases for all four marketing formats", () => {
    for (const f of MARKETING_FORMATS) {
      const phases = marketingPreview(f, 8);
      expect(phases.length).toBeGreaterThan(0);
      // The whole point of the home demo: never a note-only tab (that is why
      // swiss is excluded — see design/v3/12 §4.4).
      expect(phases.some((p) => p.sections.length > 0)).toBe(true);
    }
  });
  it("groups-knockout yields two phases (groups feed a bracket)", () => {
    expect(marketingPreview("groups-knockout", 8)).toHaveLength(2);
  });
  it("is deterministic and clamps entrants to 4..16", () => {
    expect(marketingPreview("league", 8)).toEqual(marketingPreview("league", 8));
    expect(marketingPreview("league", 2)).toEqual(marketingPreview("league", 4));
    expect(marketingPreview("league", 64)).toEqual(marketingPreview("league", 16));
  });
});
