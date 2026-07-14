import { describe, expect, it } from "vitest";
import { updateProfileSchema } from "@/lib/types";

describe("updateProfileSchema — timezone", () => {
  it("accepts a valid IANA zone", () => {
    expect(updateProfileSchema.parse({ timezone: "Asia/Kolkata" })).toEqual({
      timezone: "Asia/Kolkata",
    });
  });
  it("accepts null (clear = follow browser)", () => {
    expect(updateProfileSchema.parse({ timezone: null })).toEqual({ timezone: null });
  });
  it("rejects a bogus zone", () => {
    expect(() => updateProfileSchema.parse({ timezone: "Mars/Phobos" })).toThrow();
    expect(() => updateProfileSchema.parse({ timezone: "not a zone" })).toThrow();
  });
  it("accepts display_name alone (timezone untouched)", () => {
    expect(updateProfileSchema.parse({ display_name: "Ada" })).toEqual({ display_name: "Ada" });
  });
  it("accepts both together", () => {
    expect(
      updateProfileSchema.parse({ display_name: "Ada", timezone: "Europe/London" }),
    ).toEqual({ display_name: "Ada", timezone: "Europe/London" });
  });
  it("rejects an empty patch (nothing to update)", () => {
    expect(() => updateProfileSchema.parse({})).toThrow();
  });
  it("rejects unknown keys (strict)", () => {
    expect(() => updateProfileSchema.parse({ nickname: "x" })).toThrow();
  });
});
