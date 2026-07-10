import { describe, expect, it } from "vitest";
import { publicBrandColor, publicThemeStyle, resolvePublicTheme } from "../public-theme";

describe("resolvePublicTheme", () => {
  it("returns null for missing or unparsable colors", () => {
    expect(resolvePublicTheme(undefined)).toBeNull();
    expect(resolvePublicTheme(null)).toBeNull();
    expect(resolvePublicTheme("")).toBeNull();
    expect(resolvePublicTheme("purple")).toBeNull();
    expect(resolvePublicTheme("#12")).toBeNull();
    expect(resolvePublicTheme("#12345g")).toBeNull();
  });

  it("rejects accents that fail the contrast guard (too light for white ink)", () => {
    expect(resolvePublicTheme("#ffe14d")).toBeNull(); // yellow
    expect(resolvePublicTheme("#ffffff")).toBeNull();
    expect(resolvePublicTheme("#7dd3fc")).toBeNull(); // pale sky
  });

  it("matches the --ps-* defaults in globals.css for the platform violet", () => {
    // If this fails, globals.css and the resolver have drifted apart.
    expect(resolvePublicTheme("#7c3aed")).toEqual({
      "--ps-accent": "#7c3aed",
      "--ps-accent-ink": "#ffffff",
      "--ps-accent-strong": "#6931c9",
      "--ps-accent-soft": "#f5effe",
      "--ps-accent-line": "#decefb",
      "--ps-court": "#231738",
      "--ps-court-ink": "#f7f5fb",
      "--ps-court-muted": "rgba(247,245,251,0.64)",
    });
  });

  it("derives a full var set from a dark org accent", () => {
    const theme = resolvePublicTheme("#0f766e"); // teal-700
    expect(theme).not.toBeNull();
    expect(theme!["--ps-accent"]).toBe("#0f766e");
    expect(theme!["--ps-accent-ink"]).toBe("#ffffff");
    // The masthead slab picks up the accent hue: green channel dominates red.
    const court = theme!["--ps-court"];
    const [r, g] = [court.slice(1, 3), court.slice(3, 5)].map((h) => parseInt(h, 16));
    expect(g).toBeGreaterThan(r);
  });

  it("accepts #rgb shorthand", () => {
    expect(resolvePublicTheme("#333")).not.toBeNull();
    expect(resolvePublicTheme("#333")!["--ps-accent"]).toBe("#333333");
  });
});

describe("publicBrandColor", () => {
  it("extracts colors.primary from a branding blob", () => {
    expect(publicBrandColor({ colors: { primary: "#123456" } })).toBe("#123456");
  });

  it("returns null for malformed blobs", () => {
    expect(publicBrandColor(null)).toBeNull();
    expect(publicBrandColor(undefined)).toBeNull();
    expect(publicBrandColor("x")).toBeNull();
    expect(publicBrandColor({})).toBeNull();
    expect(publicBrandColor({ colors: null })).toBeNull();
    expect(publicBrandColor({ colors: { primary: 7 } })).toBeNull();
  });
});

describe("publicThemeStyle", () => {
  it("returns undefined when there is nothing to theme", () => {
    expect(publicThemeStyle({})).toBeUndefined();
    expect(publicThemeStyle({ colors: { primary: "#ffe14d" } })).toBeUndefined();
  });

  it("returns the var map as a style object for a valid brand", () => {
    const style = publicThemeStyle({ colors: { primary: "#0f766e" } });
    expect(style).toBeDefined();
    expect((style as Record<string, string>)["--ps-accent"]).toBe("#0f766e");
  });
});
