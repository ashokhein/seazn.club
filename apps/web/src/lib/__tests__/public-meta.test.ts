import { describe, expect, it } from "vitest";
import { competitionMetaDescription, playerMetaDescription } from "@/lib/public-meta";

describe("competitionMetaDescription", () => {
  it("uses the competition's own description, truncated to 160", () => {
    const long = "x".repeat(200);
    expect(competitionMetaDescription("WC", "FIFA", long)).toBe("x".repeat(160));
  });

  it("falls back to generated copy when the description is missing or blank", () => {
    for (const empty of [undefined, null, "", "   "]) {
      expect(competitionMetaDescription("FIFA World Cup 2026", "FIFA", empty)).toBe(
        "Live scores, standings and brackets for FIFA World Cup 2026 — hosted by FIFA on Seazn Club.",
      );
    }
  });
});

describe("playerMetaDescription", () => {
  it("always yields supporting text for the player card", () => {
    expect(playerMetaDescription("A. Kannan", "Riverside Open")).toBe(
      "A. Kannan's player card at Riverside Open — appearances, results and stats on Seazn Club.",
    );
  });
});
