// v8: division tile monogram — first grapheme, uppercase, "D" fallback.
import { describe, expect, it } from "vitest";
import { monogram } from "../division-hue";

describe("monogram", () => {
  it("takes the first letter, uppercased, trimming lead space", () => {
    expect(monogram("badminton singles")).toBe("B");
    expect(monogram("  élite")).toBe("É");
  });

  it("keeps multi-byte graphemes whole and falls back to D", () => {
    expect(monogram("🏸 Smash")).toBe("🏸");
    expect(monogram("")).toBe("D");
  });
});
