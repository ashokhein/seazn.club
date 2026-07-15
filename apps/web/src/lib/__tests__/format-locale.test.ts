import { describe, it, expect } from "vitest";
import { fmtNumber, fmtDuration, fmtRelative } from "@/lib/format";
import { formatMinor } from "@/lib/currency";

describe("locale-aware formatting", () => {
  it("groups numbers per locale", () => {
    // en uses comma grouping (stable across ICU builds).
    expect(fmtNumber("en", 1234567)).toBe("1,234,567");
    // fr groups with a (narrow) space, never a comma — assert robustly.
    const fr = fmtNumber("fr", 1234567);
    expect(fr).not.toContain(",");
    expect(fr.replace(/\D/g, "")).toBe("1234567");
  });

  it("formats a match duration in hours + minutes", () => {
    const d = fmtDuration("en", 3900); // 65 min → 1 hr 5 min
    expect(d).toMatch(/1/);
    expect(d).toMatch(/5/);
  });

  it("omits an empty hours field for short durations", () => {
    const d = fmtDuration("en", 300); // 5 min
    expect(d).toMatch(/5/);
    expect(d).not.toMatch(/\bhr\b|\bhour/i);
  });

  it("formats relative time", () => {
    expect(fmtRelative("en", -2, "hour")).toMatch(/2 hours ago/i);
  });

  it("formatMinor stays back-compatible (2-arg) and localizes with a locale", () => {
    expect(formatMinor(1500, "gbp")).toContain("15");
    expect(formatMinor(1500, "eur", "fr")).toMatch(/15/);
  });
});
