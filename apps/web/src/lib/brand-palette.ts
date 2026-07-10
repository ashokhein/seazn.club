// Curated brand colors for org/competition theming. Every hex must survive
// resolvePublicTheme's contrast guard (>= 3:1 against white) — a swatch that
// silently fell back to violet would be a lie in the picker. Pinned by
// lib/__tests__/brand-palette.test.ts.
//
// Names are club colors, not CSS colors: "Crimson", not "red".

export interface BrandSwatch {
  name: string;
  hex: string;
}

export const BRAND_PALETTE: readonly BrandSwatch[] = [
  { name: "Teal", hex: "#0f766e" },
  { name: "Ocean", hex: "#0e7490" },
  { name: "Cobalt", hex: "#1d4ed8" },
  { name: "Midnight", hex: "#1e3a8a" },
  { name: "Forest", hex: "#15803d" },
  { name: "Ember", hex: "#c2410c" },
  { name: "Bronze", hex: "#92400e" },
  { name: "Crimson", hex: "#be123c" },
  { name: "Magenta", hex: "#a21caf" },
  { name: "Graphite", hex: "#334155" },
] as const;

/** Display name for a stored hex; null when it isn't a palette color. */
export function swatchName(hex: string | null | undefined): string | null {
  if (!hex) return null;
  const norm = hex.trim().toLowerCase();
  return BRAND_PALETTE.find((s) => s.hex === norm)?.name ?? null;
}
