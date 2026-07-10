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
