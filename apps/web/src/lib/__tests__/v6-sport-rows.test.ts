// v6 sport wiring — PROMPT-48/49 acceptance: the scheduling defaults and
// venue nouns must carry rows for the three new sports (tennis/hockey rows
// pre-existed as placeholders; icehockey is new). Fails if a row is dropped.
import { describe, expect, it } from "vitest";
import { defaultMatchMinutes } from "../match-length";
import { venueNoun } from "../venue";

describe("v6 sports — scheduling + venue rows", () => {
  it("match-length defaults exist for tennis / icehockey / hockey", () => {
    expect(defaultMatchMinutes("tennis")).toBe(90);
    expect(defaultMatchMinutes("icehockey")).toBe(75);
    expect(defaultMatchMinutes("hockey")).toBe(70);
    expect(defaultMatchMinutes("tennis", "fast4")).toBe(45);
  });

  it("venue nouns: tennis court, icehockey rink, hockey pitch", () => {
    expect(venueNoun("tennis")).toBe("court");
    expect(venueNoun("icehockey")).toBe("rink");
    expect(venueNoun("hockey")).toBe("pitch");
  });
});
