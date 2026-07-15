// Server-side ui catalog lookup (v5 i18n cycle 47). msgFor backs the shared
// server components (status chip, entity card) and feature pages that render the
// `ui` copy in the resolved locale. These guard the lookup + interpolation +
// fallback without depending on which locales are translated yet.
import { describe, expect, it } from "vitest";
import { msgFor } from "@/lib/messages-i18n";
import type { MessageKey } from "@/lib/messages";
import uiEn from "@/dictionaries/en/ui.json";

describe("msgFor (server ui catalog)", () => {
  it("returns English copy and interpolates placeholders", () => {
    expect(msgFor("en", "chip.draft")).toBe("Draft");
    expect(msgFor("en", "confirm.typed.instruction", { name: "DELETE" })).toBe(
      "Type DELETE to confirm",
    );
  });

  it("never throws on a missing key — returns the key (translation-robust)", () => {
    const missing = "nonexistent.key.zzz" as MessageKey;
    expect(msgFor("fr", missing)).toBe("nonexistent.key.zzz");
  });

  it("carries the org-home keys the localized dashboard renders", () => {
    for (const k of [
      "org.home.eyebrow",
      "org.home.title",
      "org.home.newCompetition",
      "org.home.meta.divisions.one",
      "org.home.meta.entrants.other",
      "org.home.menu.schedule",
    ]) {
      expect((uiEn as Record<string, string>)[k], `missing ${k}`).toBeTruthy();
    }
  });
});
