// Zone math is the one place a scheduler is allowed to know about calendars, so
// it is tested against real DST transitions rather than a mocked offset. Every
// expectation below was checked against Node's own ICU before being written.
import { describe, expect, it } from "vitest";
import {
  dayKeyInTz,
  hhmmInTz,
  isEpochSentinel,
  makeClock,
  weekdayOfYmd,
  ymdAddDays,
  zonedTimeToUtc,
} from "./tz.ts";

const iso = (ms: number): string => new Date(ms).toISOString();

describe("zonedTimeToUtc", () => {
  it("resolves a wall clock through a DST change in both directions", () => {
    // The acceptance criterion on #397: the same wall time, one hour apart.
    expect(iso(zonedTimeToUtc("2026-08-07", "10:00", "America/New_York"))).toBe(
      "2026-08-07T14:00:00.000Z",
    );
    expect(iso(zonedTimeToUtc("2026-01-09", "10:00", "America/New_York"))).toBe(
      "2026-01-09T15:00:00.000Z",
    );
  });

  it("handles zones whose offset is not a whole hour", () => {
    expect(iso(zonedTimeToUtc("2026-08-07", "09:15", "Asia/Kathmandu"))).toBe(
      "2026-08-07T03:30:00.000Z", // +05:45
    );
    expect(iso(zonedTimeToUtc("2026-08-07", "09:15", "Pacific/Chatham"))).toBe(
      "2026-08-06T20:30:00.000Z", // +12:45
    );
  });

  it("terminates on a local time that does not exist (spring-forward gap)", () => {
    // 02:30 never happens in New York on 2026-03-08. The fixpoint must land on a
    // real instant rather than loop or return NaN.
    const ms = zonedTimeToUtc("2026-03-08", "02:30", "America/New_York");
    expect(Number.isFinite(ms)).toBe(true);
    expect(iso(ms)).toBe("2026-03-08T06:30:00.000Z");
  });

  it("picks one instant for an ambiguous local time (fall-back repeat)", () => {
    const ms = zonedTimeToUtc("2026-11-01", "01:30", "America/New_York");
    expect(iso(ms)).toBe("2026-11-01T05:30:00.000Z");
  });

  it("round-trips midnight — never formats it as 24:00", () => {
    // The ICU quirk the design calls out: some hour cycles render midnight as
    // "24:00", which sorts after every other time and would silently invert a
    // session-hours comparison.
    for (const tz of ["UTC", "Europe/London", "America/New_York", "Asia/Kolkata"]) {
      const ms = zonedTimeToUtc("2026-08-07", "00:00", tz);
      expect(hhmmInTz(ms, tz)).toBe("00:00");
      expect(dayKeyInTz(ms, tz)).toBe("2026-08-07");
    }
  });
});

describe("dayKeyInTz / hhmmInTz", () => {
  it("reports the local calendar day, not the UTC one", () => {
    // 2026-08-07T01:00Z is still 2026-08-06 in New York.
    const ms = Date.parse("2026-08-07T01:00:00Z");
    expect(dayKeyInTz(ms, "UTC")).toBe("2026-08-07");
    expect(dayKeyInTz(ms, "America/New_York")).toBe("2026-08-06");
    expect(hhmmInTz(ms, "America/New_York")).toBe("21:00");
  });
});

describe("ymdAddDays / weekdayOfYmd", () => {
  it("crosses a DST boundary without losing or gaining a day", () => {
    expect(ymdAddDays("2026-03-07", 1)).toBe("2026-03-08");
    expect(ymdAddDays("2026-11-01", -1)).toBe("2026-10-31");
    expect(ymdAddDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("names the weekday", () => {
    expect(weekdayOfYmd("2026-08-07")).toBe("FRI");
    expect(weekdayOfYmd("2026-08-09")).toBe("SUN");
  });
});

describe("makeClock", () => {
  it("is a pure function of the instant it is handed", () => {
    const nowMs = Date.parse("2026-08-06T23:30:00Z");
    const a = makeClock(nowMs, "Europe/London");
    const b = makeClock(nowMs, "Europe/London");
    expect(a).toEqual(b);
    expect(a.now).toBe("2026-08-06T23:30:00.000Z");
    // 23:30Z is already 2026-08-07 in London (BST) — the whole reason one zone
    // has to govern the calendar.
    expect(a.today).toBe("2026-08-07");
    expect(a.tomorrow).toBe("2026-08-08");
  });

  it("resolves each weekday to its next occurrence strictly after today", () => {
    const c = makeClock(Date.parse("2026-08-07T12:00:00Z"), "UTC"); // a Friday
    expect(c.today).toBe("2026-08-07");
    expect(c.nextWeekday.SAT).toBe("2026-08-08");
    expect(c.nextWeekday.FRI).toBe("2026-08-14"); // never today
    expect(new Set(Object.values(c.nextWeekday)).size).toBe(7);
  });
});

describe("isEpochSentinel", () => {
  it("catches an epoch draft time in any zone", () => {
    // The reason this is not `startsWith("1970-")`: west of UTC the epoch
    // renders as 1969-12-31.
    expect(isEpochSentinel(0)).toBe(true);
    expect(isEpochSentinel(Date.parse("1970-06-01T00:00:00Z"))).toBe(true);
    expect(isEpochSentinel(Date.parse("1969-12-31T19:00:00Z"))).toBe(true);
    expect(isEpochSentinel(Date.parse("2026-08-07T10:00:00Z"))).toBe(false);
  });
});
