// Format gallery gates (v3/06 §4):
//  1. enumeration — every engine stage kind has an explainer family, so a
//     new format cannot ship undocumented;
//  2. the canned stage graphs actually run through the real engine preview;
//  3. the recommendation function's golden ranking for 16 entrants /
//     2 courts / 4 hours.
import { describe, expect, it } from "vitest";
import { StageKind } from "@/server/api-v1/schemas";
import { FORMAT_FAMILIES, familyForKind } from "@/config/format-gallery";
import { previewDivisionFixtures } from "@/server/usecases/stages";
import { recommendFormats } from "@/lib/format-recommend";
import { helpUrl } from "@/lib/help";

describe("format gallery enumeration", () => {
  it("every engine stage kind has an explainer family", () => {
    for (const kind of StageKind.options) {
      expect(familyForKind(kind), `stage kind '${kind}' has no gallery family`).toBeTruthy();
    }
  });

  it("every family resolves through helpUrl (picker + tips deep-links)", () => {
    for (const f of FORMAT_FAMILIES) {
      expect(helpUrl(`formats/${f.slug}`)).toBe(`/help/formats/${f.slug}`);
    }
    expect(helpUrl("formats/overview")).toBe("/help/formats");
  });

  it("every family's canned stage graph runs through the real engine", () => {
    for (const f of FORMAT_FAMILIES) {
      const phases = previewDivisionFixtures(f.cannedStages, 8);
      expect(phases.length, f.slug).toBe(f.cannedStages.length);
      for (const phase of phases) {
        // Either concrete fixtures or an honest live-draw note — never blank.
        expect(
          phase.sections.length > 0 || (phase.note ?? "").length > 10,
          `${f.slug} / ${phase.title} rendered empty`,
        ).toBe(true);
      }
    }
  });
});

describe("recommendFormats golden — 16 entrants, 2 courts, 4 hours", () => {
  it("ranks knockout first (only bracket that fits 16 court-slots)", () => {
    const picks = recommendFormats({ entrants: 16, courts: 2, hours: 4 });
    expect(picks).toHaveLength(3);
    // Capacity = 2 courts × 8 slots = 16 matches; knockout (15) is the only
    // model that fits, so it must lead; the rest are least-overrun first.
    expect(picks[0]!.slug).toBe("knockout");
    expect(picks[0]!.matches).toBe(15);
    expect(picks.map((p) => p.slug)).toEqual(["knockout", "double_elim", "groups-knockout"]);
    for (const p of picks) {
      expect(p.reason).toMatch(/matches/);
      expect(p.reason.length).toBeLessThan(160); // one sentence, not an essay
    }
  });

  it("with a full weekend the league leads (most play per entrant)", () => {
    const picks = recommendFormats({ entrants: 8, courts: 2, hours: 12 });
    expect(picks[0]!.slug).toBe("league"); // 28 matches fit 48 slots
  });
});
