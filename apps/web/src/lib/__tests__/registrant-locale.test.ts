// Per-registrant email locale (v5 i18n cycle 47, Deliverable B). The locale a
// registrant sees the public form in is captured at signup and frozen on the
// row; registrant-facing mail sends in it. This guards the capture decision:
// the registrant's explicit switcher pick wins, otherwise the organiser's public
// default, otherwise English.
import { describe, expect, it } from "vitest";
import { captureRegistrantLocale } from "@/lib/registrant-locale";

describe("captureRegistrantLocale", () => {
  it("uses the registrant's explicit locale pick when present", () => {
    expect(captureRegistrantLocale("es", "fr")).toBe("es");
  });

  it("falls back to the organiser's public default when there is no explicit pick", () => {
    expect(captureRegistrantLocale(null, "fr")).toBe("fr");
  });

  it("falls back to English when neither is a supported locale", () => {
    expect(captureRegistrantLocale(null, null)).toBe("en");
    expect(captureRegistrantLocale(null, "de")).toBe("en");
  });
});
