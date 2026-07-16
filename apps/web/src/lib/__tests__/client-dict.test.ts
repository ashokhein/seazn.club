import { describe, expect, it } from "vitest";
import { localeFromPath } from "@/lib/client-dict";

describe("localeFromPath", () => {
  it("reads the locale from a [lang] route's first segment", () => {
    expect(localeFromPath("/en")).toBe("en");
    expect(localeFromPath("/fr")).toBe("fr");
    expect(localeFromPath("/fr/formats")).toBe("fr");
    expect(localeFromPath("/es/discover/cricket")).toBe("es");
    expect(localeFromPath("/nl/live")).toBe("nl");
  });

  it("returns null when the path carries no locale segment", () => {
    expect(localeFromPath("/")).toBeNull();
    expect(localeFromPath("/login")).toBeNull();
    expect(localeFromPath("/o/riverside/settings/billing")).toBeNull();
    expect(localeFromPath("/reset-password")).toBeNull();
    // unsupported locale is not a [lang] route
    expect(localeFromPath("/de/start")).toBeNull();
  });
});
