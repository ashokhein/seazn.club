import { describe, it, expect } from "vitest";
import { t, plural, hasLocale, LOCALES, DEFAULT_LOCALE } from "@/lib/i18n";

const dict = {
  greeting: "Hi {name}",
  "items.one": "{count} item",
  "items.other": "{count} items",
  nested: { deep: "Deep value" },
};

describe("i18n core", () => {
  it("interpolates vars", () => {
    expect(t(dict, "greeting", { name: "Sam" })).toBe("Hi Sam");
  });
  it("resolves dot keys", () => {
    expect(t(dict, "nested.deep")).toBe("Deep value");
  });
  it("returns the key on a miss (never throws)", () => {
    expect(t(dict, "does.not.exist")).toBe("does.not.exist");
  });
  it("leaves an unknown {var} untouched", () => {
    expect(t(dict, "greeting")).toBe("Hi {name}");
  });
  it("pluralizes via Intl.PluralRules", () => {
    expect(plural(dict, "items", 1, "en")).toBe("1 item");
    expect(plural(dict, "items", 3, "en")).toBe("3 items");
  });
  it("hasLocale narrows the set and rejects the pseudolocale + deferred/unknown codes", () => {
    expect(hasLocale("nl")).toBe(true);
    expect(hasLocale("en-XA")).toBe(false);
    expect(hasLocale("ta")).toBe(false); // deferred this cycle
    expect(hasLocale("de")).toBe(false);
  });
  it("exports the cycle-1 four-locale set with en default", () => {
    expect(LOCALES).toEqual(["en", "fr", "es", "nl"]);
    expect(DEFAULT_LOCALE).toBe("en");
  });
});
