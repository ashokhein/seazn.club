import { describe, expect, it } from "vitest";
import { maskEmail } from "../mask-email";

describe("maskEmail", () => {
  it("masks local part and domain, keeping the TLD", () => {
    expect(maskEmail("ashokhein+001@gmail.com")).toBe("a***1@g***.com");
  });

  it("does not leak the raw address anywhere in the output", () => {
    const masked = maskEmail("someone.else@example.org");
    expect(masked).not.toContain("someone.else");
    expect(masked).not.toContain("example");
  });

  it("handles very short local parts without throwing", () => {
    expect(maskEmail("ab@x.io")).toBe("a*@x***.io");
  });
});
