import { describe, expect, it } from "vitest";
import { dayLabel, dayWeekday, dayDateShort, timeLabel } from "@/lib/day-label";

// Schedule-board hydration fix: day labels used to format with the runtime's
// default locale — Node's ICU (en-US, "Sat, Jul 11") vs the visitor's browser
// (en-GB, "Sat 11 Jul") is a React hydration text mismatch that regenerated
// the whole board client-side. One explicit locale renders identically on
// both sides; these pin that output.
describe("day-label", () => {
  it("full label is deterministic en-GB regardless of runtime locale", () => {
    expect(dayLabel("2026-07-11")).toBe("Sat 11 Jul");
    expect(dayLabel("2026-01-02")).toBe("Fri 2 Jan");
  });
  it("weekday + short date pieces (by-division columns)", () => {
    expect(dayWeekday("2026-07-11")).toBe("Sat");
    expect(dayDateShort("2026-07-11")).toBe("11 Jul");
  });
  it("noon anchoring keeps the label on the key's own date in any zone", () => {
    // A midnight anchor would slip a day west of UTC; noon never does.
    expect(dayLabel("2026-12-31")).toBe("Thu 31 Dec");
  });
  it("time labels are 24h en-GB — no 12h/24h split between server and browser", () => {
    expect(timeLabel("2026-07-12T21:28:00")).toBe("21:28");
    expect(timeLabel("2026-07-12T09:05:00")).toBe("09:05");
  });

  // design/fix-ui/05-import-schedule-freetier.md: the schedule board's day
  // tabs always showed English weekday abbreviations ("Fri 10 Jul") even on
  // a fully French-localized page, because the locale was hardcoded. An
  // explicit `locale` param now threads the active app locale through.
  it("dayLabel/dayWeekday/dayDateShort format in the given locale, not always en-GB", () => {
    expect(dayLabel("2026-07-11", "fr")).not.toBe(dayLabel("2026-07-11", "en-GB"));
    expect(dayLabel("2026-07-11", "fr")).toMatch(/^sam\.?\s*11\s*juil\.?$/i);
    expect(dayWeekday("2026-07-11", "fr").toLowerCase()).toContain("sam");
    expect(dayDateShort("2026-07-11", "fr").toLowerCase()).toContain("juil");
  });

  it("omitting locale still defaults to en-GB (existing callers unaffected)", () => {
    expect(dayLabel("2026-07-11")).toBe(dayLabel("2026-07-11", "en-GB"));
  });
});
