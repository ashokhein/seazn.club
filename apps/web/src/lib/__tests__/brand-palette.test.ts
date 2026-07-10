// Every curated swatch must actually theme — a palette color rejected by the
// resolver's contrast guard would silently fall back to violet in production.
import { describe, expect, it } from "vitest";
import { BRAND_PALETTE, swatchName } from "@/lib/brand-palette";
import { resolvePublicTheme } from "@/lib/public-theme";

describe("brand palette", () => {
  it("has 10 uniquely named, lowercase-hex swatches", () => {
    expect(BRAND_PALETTE.length).toBe(10);
    expect(new Set(BRAND_PALETTE.map((s) => s.name)).size).toBe(10);
    expect(new Set(BRAND_PALETTE.map((s) => s.hex)).size).toBe(10);
    for (const s of BRAND_PALETTE) expect(s.hex).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("every swatch passes the resolver contrast guard", () => {
    for (const s of BRAND_PALETTE) {
      const vars = resolvePublicTheme(s.hex);
      expect(vars, `${s.name} (${s.hex}) fell back to violet`).not.toBeNull();
      expect(vars?.["--ps-accent"]).toBe(s.hex);
    }
  });

  it("swatchName maps stored hexes back to display names", () => {
    expect(swatchName("#0f766e")).toBe("Teal");
    expect(swatchName("#0F766E")).toBe("Teal");
    expect(swatchName("#123456")).toBeNull();
    expect(swatchName(null)).toBeNull();
  });
});
