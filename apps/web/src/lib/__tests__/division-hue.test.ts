// Division identity on the v3 board (v3/04 §2): stable hue per division id
// plus a short code chip derived from the name ("U16 Boys Singles" → U16B).
import { describe, expect, it } from "vitest";
import { divisionAccent, divisionHue, divisionShortCode } from "@/lib/division-hue";

describe("divisionHue", () => {
  it("is stable for the same id and inside the palette", () => {
    const a = divisionHue("6c1f9f9a-0000-4000-8000-000000000001");
    expect(divisionHue("6c1f9f9a-0000-4000-8000-000000000001")).toBe(a);
    expect(divisionAccent("6c1f9f9a-0000-4000-8000-000000000001")).toContain(`hsl(${a}`);
  });
});

describe("divisionShortCode", () => {
  it("keeps age-group prefixes with the gender initial", () => {
    expect(divisionShortCode("U16 Boys Singles")).toBe("U16B");
    expect(divisionShortCode("U16 Girls")).toBe("U16G");
    expect(divisionShortCode("U18 Boys")).toBe("U18B");
  });

  it("initialises multi-word names", () => {
    expect(divisionShortCode("Open Singles")).toBe("OS");
    expect(divisionShortCode("Mixed Doubles A")).toBe("MDA");
  });

  it("truncates single words to four chars, uppercased", () => {
    expect(divisionShortCode("Open")).toBe("OPEN");
    expect(divisionShortCode("premiership")).toBe("PREM");
  });

  it("never exceeds four characters", () => {
    expect(divisionShortCode("U16 Boys Singles Premier League").length).toBeLessThanOrEqual(4);
    expect(divisionShortCode("Alpha Beta Gamma Delta Epsilon Zeta").length).toBeLessThanOrEqual(4);
  });

  it("is unique-ish across a typical competition's divisions", () => {
    const names = ["U16 Boys", "U16 Girls", "U18 Boys", "U18 Girls", "Open Singles"];
    const codes = names.map(divisionShortCode);
    expect(new Set(codes).size).toBe(names.length);
  });
});
