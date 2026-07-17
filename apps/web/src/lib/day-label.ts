// Deterministic day labels for SSR'd client components (the schedule board).
// A `undefined` locale formats with the runtime's ICU default — Node on the
// server (en-US on most hosts) vs the visitor's browser differ, which React
// reports as a hydration text mismatch and regenerates the tree client-side.
// One explicit locale renders identically on both sides. Day keys are
// wall-clock dates (YYYY-MM-DD); anchoring at noon keeps the label on the
// key's own date in every timezone.
//
// `locale` defaults to "en-GB" for callers that haven't threaded the active
// app locale through yet — but the schedule board's day tabs DO thread it
// (via useLocale()), because leaving this hardcoded produced English weekday
// abbreviations ("Fri 10 Jul") inside an otherwise fully French page
// (design/fix-ui/05-import-schedule-freetier.md).
const DEFAULT_LOCALE = "en-GB";

export function dayLabel(dayKey: string, locale: string = DEFAULT_LOCALE): string {
  return new Date(`${dayKey}T12:00`).toLocaleDateString(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

export function dayWeekday(dayKey: string, locale: string = DEFAULT_LOCALE): string {
  return new Date(`${dayKey}T12:00`).toLocaleDateString(locale, { weekday: "short" });
}

export function dayDateShort(dayKey: string, locale: string = DEFAULT_LOCALE): string {
  return new Date(`${dayKey}T12:00`).toLocaleDateString(locale, {
    day: "numeric",
    month: "short",
  });
}

/** Clock label ("21:28") for board chips/slots. Same determinism story as
 *  the day labels; the moment itself stays in the runtime's zone — the whole
 *  board groups by local wall-clock (see lib/schedule-board.ts dayKey). */
export function timeLabel(value: string | number | Date, locale: string = DEFAULT_LOCALE): string {
  return new Date(value).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
}
