// Zone math for the scheduler (#397) — the inverse of the pack's `zonedIso`,
// plus the day/weekday extraction the window, per-day caps and weekday targets
// all need. Built as a fixpoint over `Intl` so it is DST-correct with zero
// dependencies.
//
// No wall-clock reads, same rule as calendar.ts: `makeClock` takes the instant
// as a parameter. Reading the clock here would unfreeze every golden pack test.

export type Ymd = string; // "YYYY-MM-DD"
export type Hhmm = string; // "HH:MM", 24-hour
export type Weekday = "SUN" | "MON" | "TUE" | "WED" | "THU" | "FRI" | "SAT";

export interface Clock {
  /** ISO-8601 UTC rendering of the injected instant. */
  now: string;
  /** The calendar day that instant falls on, in the governing zone. */
  today: Ymd;
  tomorrow: Ymd;
  /** Each weekday's next occurrence, strictly after `today`. */
  nextWeekday: Record<Weekday, Ymd>;
}

const WEEKDAYS: readonly Weekday[] = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

const MS_PER_DAY = 86_400_000;

/** Anything before 1971 is a sentinel, not a fixture. Zone-independent on
 *  purpose: `startsWith("1970-")` misses the epoch rendered west of UTC, where
 *  it reads 1969-12-31. */
export const EPOCH_SENTINEL_BEFORE_MS = Date.UTC(1971, 0, 1);

export function isEpochSentinel(instantMs: number): boolean {
  return instantMs < EPOCH_SENTINEL_BEFORE_MS;
}

/** Calendar arithmetic on a bare date — done in UTC on purpose. A YMD carries
 *  no zone, so adding a day is exactly 24h here; the zone only enters when a
 *  YMD is turned back into an instant by `zonedTimeToUtc`. */
export function ymdAddDays(ymd: Ymd, days: number): Ymd {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * MS_PER_DAY).toISOString().slice(0, 10);
}

export function weekdayOfYmd(ymd: Ymd): Weekday {
  return WEEKDAYS[new Date(`${ymd}T00:00:00Z`).getUTCDay()]!;
}

/** The calendar day an instant falls on, in `tz`. `en-CA` formats YYYY-MM-DD. */
export function dayKeyInTz(instantMs: number, tz: string): Ymd {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(instantMs));
}

/** The wall-clock time of an instant, in `tz`. The `^24` guard is the known ICU
 *  quirk: some hour cycles render midnight as "24:00", which sorts after every
 *  other time and would silently invert a session-hours comparison. */
export function hhmmInTz(instantMs: number, tz: string): Hhmm {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(new Date(instantMs))
    .replace(/^24/, "00");
}

/**
 * Wall clock `(ymd, hh:mm)` in `tz` → UTC epoch ms. The inverse of `zonedIso`,
 * which the codebase had no counterpart for.
 *
 * Two correction passes are enough for every real zone: the first lands within
 * the offset error, the second fixes the case where that correction itself
 * crossed a DST boundary. A local time that does not exist — the spring-forward
 * gap — has no exact answer; the fixpoint stops on the closest real instant
 * rather than looping.
 */
export function zonedTimeToUtc(ymd: Ymd, hhmm: Hhmm, tz: string): number {
  const target = Date.parse(`${ymd}T${hhmm}:00Z`);
  let guess = target;
  for (let i = 0; i < 2; i++) {
    const wall = Date.parse(`${dayKeyInTz(guess, tz)}T${hhmmInTz(guess, tz)}:00Z`);
    if (wall === target) break;
    guess += target - wall;
  }
  return guess;
}

/** The calendar anchor, built from an instant the caller supplies. */
export function makeClock(nowMs: number, tz: string): Clock {
  const today = dayKeyInTz(nowMs, tz);
  const nextWeekday = {} as Record<Weekday, Ymd>;
  for (let i = 1; i <= 7; i++) {
    const day = ymdAddDays(today, i);
    const wd = weekdayOfYmd(day);
    if (nextWeekday[wd] === undefined) nextWeekday[wd] = day;
  }
  return {
    now: new Date(nowMs).toISOString(),
    today,
    tomorrow: ymdAddDays(today, 1),
    nextWeekday,
  };
}
