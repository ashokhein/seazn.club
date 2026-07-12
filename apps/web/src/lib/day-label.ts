// Deterministic day labels for SSR'd client components (the schedule board).
// A `undefined` locale formats with the runtime's ICU default — Node on the
// server (en-US on most hosts) vs the visitor's browser differ, which React
// reports as a hydration text mismatch and regenerates the tree client-side.
// One explicit locale renders identically on both sides. Day keys are
// wall-clock dates (YYYY-MM-DD); anchoring at noon keeps the label on the
// key's own date in every timezone.
const LOCALE = "en-GB";

export function dayLabel(dayKey: string): string {
  return new Date(`${dayKey}T12:00`).toLocaleDateString(LOCALE, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

export function dayWeekday(dayKey: string): string {
  return new Date(`${dayKey}T12:00`).toLocaleDateString(LOCALE, { weekday: "short" });
}

export function dayDateShort(dayKey: string): string {
  return new Date(`${dayKey}T12:00`).toLocaleDateString(LOCALE, {
    day: "numeric",
    month: "short",
  });
}

/** Clock label ("21:28") for board chips/slots. Same determinism story as
 *  the day labels; the moment itself stays in the runtime's zone — the whole
 *  board groups by local wall-clock (see lib/schedule-board.ts dayKey). */
export function timeLabel(value: string | number | Date): string {
  return new Date(value).toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" });
}
