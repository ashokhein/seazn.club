import { describe, expect, it } from "vitest";
import { pluralizeVenue, venueLabel } from "@/lib/venue";

// The venues label was the copy string "{venue}s", so a football division
// rendered "Pitchs". Worse, all four locales carried that same English rule —
// es/fr/nl were pluralising with an English "s" as well. Pluralising in code
// keeps the rule out of the translations entirely.
describe("pluralizeVenue", () => {
  it("uses -es after a sibilant, which is the case that was broken", () => {
    expect(pluralizeVenue("Pitch")).toBe("Pitches");
  });

  it("uses a plain -s otherwise", () => {
    expect(pluralizeVenue("Court")).toBe("Courts");
    expect(pluralizeVenue("Board")).toBe("Boards");
    expect(pluralizeVenue("Table")).toBe("Tables");
    expect(pluralizeVenue("Rink")).toBe("Rinks");
  });

  it("handles every noun venueLabel can actually produce", () => {
    // If a sport is added with a new noun, this is where an odd plural shows up.
    for (const sport of [
      "football", "cricket", "rugby", "hockey", "icehockey",
      "tabletennis", "badminton", "tennis", "squash", "padel",
      "basketball", "netball", "volleyball", "boardgame", "chess",
      "carrom", "draughts", "checkers", "unknown-sport",
    ]) {
      const plural = pluralizeVenue(venueLabel(sport));
      expect(plural, `${sport} → ${plural}`).not.toMatch(/chs$/);
      expect(plural).toMatch(/s$/);
    }
  });
});
