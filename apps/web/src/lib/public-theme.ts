// Public-site theming (v3/11 gap 7): an org/competition accent re-themes the
// public "courtside" surface by overriding the --ps-* CSS vars that every
// public component reads. The resolver derives the full var set from ONE
// brand color, with a WCAG contrast guard — an accent too light to carry
// white ink (or to read as link text on white) is rejected and the surface
// falls back to the platform violet defined in globals.css.
//
// The default violet outputs here MUST match the --ps-* defaults in
// app/globals.css; lib/__tests__/public-theme.test.ts pins that.
import type { CSSProperties } from "react";

interface Rgb {
  r: number;
  g: number;
  b: number;
}

const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const BLACK: Rgb = { r: 0, g: 0, b: 0 };
/** Near-black base the "court" masthead slab is mixed from (#131118). */
const COURT_BASE: Rgb = { r: 19, g: 17, b: 24 };

function parseHex(value: string): Rgb | null {
  const hex = value.trim().replace(/^#/, "");
  const full =
    hex.length === 3 && /^[0-9a-f]{3}$/i.test(hex)
      ? hex
          .split("")
          .map((c) => c + c)
          .join("")
      : hex;
  if (!/^[0-9a-f]{6}$/i.test(full)) return null;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

function toHex({ r, g, b }: Rgb): string {
  const h = (n: number) => n.toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** sRGB mix: `weight` of `a` over `1 - weight` of `b`. */
function mix(a: Rgb, b: Rgb, weight: number): Rgb {
  const ch = (x: number, y: number) => Math.round(x * weight + y * (1 - weight));
  return { r: ch(a.r, b.r), g: ch(a.g, b.g), b: ch(a.b, b.b) };
}

/** WCAG 2.x relative luminance. */
function luminance({ r, g, b }: Rgb): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export type PublicThemeVars = Record<`--ps-${string}`, string>;

/**
 * Derive the full public-theme var set from one brand color.
 * Returns `null` (= keep the violet defaults from globals.css) when the
 * color is missing, unparsable, or fails the contrast guard: the accent must
 * hold white ink AND read as text on a white card (>= 3:1 against white).
 */
export function resolvePublicTheme(brand?: string | null): PublicThemeVars | null {
  if (!brand) return null;
  const accent = parseHex(brand);
  if (!accent) return null;
  if (contrast(accent, WHITE) < 3) return null;

  return {
    "--ps-accent": toHex(accent),
    "--ps-accent-ink": "#ffffff",
    "--ps-accent-strong": toHex(mix(accent, BLACK, 0.85)),
    "--ps-accent-soft": toHex(mix(accent, WHITE, 0.08)),
    "--ps-accent-line": toHex(mix(accent, WHITE, 0.25)),
    "--ps-court": toHex(mix(accent, COURT_BASE, 0.15)),
    "--ps-court-ink": "#f7f5fb",
    "--ps-court-muted": "rgba(247,245,251,0.64)",
  };
}

/**
 * Pull the brand color out of a competition/org `branding` JSON blob
 * (`{ colors: { primary } }`). The public views already null branding for
 * orgs without the Pro branding entitlement, so reaching here implies the
 * org may theme its public pages.
 */
export function publicBrandColor(branding: unknown): string | null {
  if (typeof branding !== "object" || branding === null) return null;
  const colors = (branding as { colors?: unknown }).colors;
  if (typeof colors !== "object" || colors === null) return null;
  const primary = (colors as { primary?: unknown }).primary;
  return typeof primary === "string" ? primary : null;
}

/** Inline-style form for a page/section wrapper; undefined = defaults. */
export function publicThemeStyle(branding: unknown): CSSProperties | undefined {
  const vars = resolvePublicTheme(publicBrandColor(branding));
  return vars ? (vars as CSSProperties) : undefined;
}

/**
 * Resolution chain: first branding blob that carries a color wins
 * (competition override before org default). A winner that then fails the
 * contrast guard falls to the violet defaults, not to the next blob — same
 * behavior a lone `publicThemeStyle` has.
 */
export function publicThemeStyleChain(...brandings: unknown[]): CSSProperties | undefined {
  for (const b of brandings) {
    if (publicBrandColor(b)) return publicThemeStyle(b);
  }
  return undefined;
}
