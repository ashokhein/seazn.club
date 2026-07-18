import { describe, expect, it } from "vitest";
import { kitChipStyle, kitStripeStyle } from "../kit-style";

describe("kitStripeStyle", () => {
  it("splits home primary → secondary at 50%", () => {
    expect(
      kitStripeStyle({ home_primary: "#ff0000", home_secondary: "#0000ff" }).background,
    ).toBe("linear-gradient(90deg, #ff0000 0 50%, #0000ff 50% 100%)");
  });

  it("falls back to a slate-200 hairline when colours are unset", () => {
    expect(kitStripeStyle(null).background).toBe("#e2e8f0");
    expect(kitStripeStyle({}).background).toBe("#e2e8f0");
    // one of the pair missing → still the hairline, never a half-gradient
    expect(kitStripeStyle({ home_primary: "#ff0000" }).background).toBe("#e2e8f0");
  });

  it("ignores non-hex values", () => {
    expect(
      kitStripeStyle({ home_primary: "red", home_secondary: "#0000ff" }).background,
    ).toBe("#e2e8f0");
  });
});

describe("kitChipStyle", () => {
  it("splits a colour pair at 135°", () => {
    expect(kitChipStyle("#111111", "#222222").background).toBe(
      "linear-gradient(135deg, #111111 0 50%, #222222 50% 100%)",
    );
  });

  it("falls back to neutral slate for missing colours", () => {
    expect(kitChipStyle(undefined, undefined).background).toBe(
      "linear-gradient(135deg, #f1f5f9 0 50%, #cbd5e1 50% 100%)",
    );
  });
});
