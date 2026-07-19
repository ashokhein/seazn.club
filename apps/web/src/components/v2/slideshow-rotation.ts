// PROMPT-64 (v13) — in-play pinning for the noticeboard rotation, pure and
// unit-tested: when a pinned slide exists (live matches), it interleaves into
// every other step — a screen with live action is never parked on a static
// table for long. Without a pinned slide the rotation is the plain cycle.

const isPinned = (s: object): boolean => (s as { pinned?: boolean }).pinned === true;

/** Rotation length: with a pinned slide, [pinned, other] pairs (pinned slides
 *  beyond the first rotate like normal slides). */
export function rotationLength(slides: readonly object[]): number {
  const pinned = slides.findIndex(isPinned);
  if (pinned < 0 || slides.length <= 1) return slides.length;
  return 2 * (slides.length - 1);
}

/** Slide index shown at a rotation step. Pinned present: even steps show the
 *  pinned slide, odd steps walk the others in order. */
export function slideAt(step: number, slides: readonly object[]): number {
  if (slides.length === 0) return 0;
  const pinned = slides.findIndex(isPinned);
  const len = rotationLength(slides);
  const s = ((step % len) + len) % len;
  if (pinned < 0 || slides.length <= 1) return s;
  if (s % 2 === 0) return pinned;
  const others = slides.map((_, i) => i).filter((i) => i !== pinned);
  return others[((s - 1) / 2) % others.length]!;
}

/** A step that displays the requested slide (dot / arrow-key navigation). */
export function stepFor(slideIndex: number, slides: readonly object[]): number {
  const pinned = slides.findIndex(isPinned);
  if (pinned < 0 || slides.length <= 1) return slideIndex;
  if (slideIndex === pinned) return 0;
  const others = slides.map((_, i) => i).filter((i) => i !== pinned);
  const pos = others.indexOf(slideIndex);
  return pos < 0 ? 0 : 2 * pos + 1;
}

// G-audit: which bracket-shaped stages earn a slideshow slide, and whether
// the shape actually lays out. Pure — shared by the server slide builder and
// its unit tests (stepladder always lays out: the rung list IS the shape).
import { doubleElimBracket, twoSidedBracket } from "@seazn/engine/scheduling";

export const BRACKET_SLIDE_KINDS = new Set(["knockout", "double_elim", "stepladder"]);

export function bracketSlideLaysOut(
  kind: string,
  refs: { id: string; round_no: number; seq_in_round: number }[],
): boolean {
  if (kind === "double_elim") return doubleElimBracket(refs).ok;
  if (kind === "stepladder") return true;
  return twoSidedBracket(refs).ok;
}
