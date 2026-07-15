import { describe, it, expect } from "vitest";
import { updateProfileSchema } from "@/lib/types";

describe("updateProfileSchema — locale", () => {
  it("accepts a supported locale", () => {
    expect(updateProfileSchema.parse({ locale: "fr" }).locale).toBe("fr");
  });
  it("accepts null to clear the preference", () => {
    expect(updateProfileSchema.parse({ locale: null }).locale).toBeNull();
  });
  it("rejects unsupported / deferred locales", () => {
    expect(() => updateProfileSchema.parse({ locale: "de" })).toThrow();
    expect(() => updateProfileSchema.parse({ locale: "ta" })).toThrow(); // deferred
  });
  it("still rejects an empty patch (nothing to update)", () => {
    expect(() => updateProfileSchema.parse({})).toThrow();
  });
});
