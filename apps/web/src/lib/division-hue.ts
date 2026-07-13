// Per-division hue (v3/03 §1): the 3px card border and the v3/04 board lanes
// derive the same colour from the division id, so a division looks the same
// on every page without storing a colour anywhere. Twelve stops around the
// wheel, skipping the 260–290° band the brand violet owns so a division never
// impersonates system chrome.

const HUES = [4, 24, 44, 76, 104, 140, 168, 190, 210, 232, 312, 336] as const;

/** FNV-1a — stable across sessions, cheap, good spread on uuids. */
function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function divisionHue(divisionId: string): number {
  return HUES[fnv1a(divisionId) % HUES.length];
}

/** CSS color for the card border / board lane. Fixed s/l keeps every stop
 *  distinguishable on the white card without fighting the text for contrast. */
export function divisionAccent(divisionId: string): string {
  return `hsl(${divisionHue(divisionId)} 62% 48%)`;
}

/** Pale wash for chip/lane backgrounds — readable under divisionInk text. */
export function divisionTint(divisionId: string): string {
  return `hsl(${divisionHue(divisionId)} 70% 93%)`;
}

/** Text colour paired with divisionTint: same hue, dark enough for AA on the
 *  93% wash (axe gate runs serious/critical on the mobile suite). */
export function divisionInk(divisionId: string): string {
  return `hsl(${divisionHue(divisionId)} 75% 26%)`;
}

/** Card-tile monogram (v8): the name's first grapheme, uppercased —
 *  spread iteration keeps surrogate pairs (emoji, CJK) whole. */
export function monogram(name: string): string {
  const first = [...name.trim()][0];
  return (first ?? "D").toUpperCase();
}

/**
 * Short code chip for board blocks (v3/04 §2): "U16 Boys Singles" → U16B.
 * Age-group tokens (U16, O40) survive whole; other words contribute initials;
 * a single-word name keeps its first four letters. Always ≤ 4 chars.
 */
export function divisionShortCode(name: string): string {
  const tokens = name.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return "DIV";
  if (tokens.length === 1) return tokens[0]!.slice(0, 4).toUpperCase();
  const age = tokens.find((t) => /^[UuOo]-?\d{1,2}$/.test(t));
  if (age) {
    const ageCode = age.replace("-", "").toUpperCase();
    const initials = tokens
      .filter((t) => t !== age)
      .map((t) => t[0]!.toUpperCase())
      .join("");
    return (ageCode + initials).slice(0, 4);
  }
  return tokens.map((t) => t[0]!.toUpperCase()).join("").slice(0, 4);
}
