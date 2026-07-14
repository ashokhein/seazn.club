import { describe, it, expect } from "vitest";
import { toPseudo, buildPseudoDictionary } from "@/lib/pseudo";

describe("toPseudo", () => {
  it("wraps in ⟦…⟧ markers and accents letters", () => {
    const out = toPseudo("Publish");
    expect(out.startsWith("⟦")).toBe(true);
    expect(out.endsWith("⟧")).toBe(true);
    expect(out).not.toContain("Publish"); // every letter accented
  });
  it("preserves {var} placeholders verbatim", () => {
    expect(toPseudo("Hi {name}")).toContain("{name}");
  });
  it("expands length by roughly 30%", () => {
    const src = "A short label here";
    expect(toPseudo(src).length).toBeGreaterThan(src.length * 1.25);
  });
});

describe("buildPseudoDictionary", () => {
  it("pseudo-izes every string leaf, nested included", () => {
    const out = buildPseudoDictionary({ a: "Save", b: { c: "Cancel" } }) as {
      a: string;
      b: { c: string };
    };
    expect(out.a).toContain("⟦");
    expect(out.b.c).toContain("⟦");
  });
});
