// Daily play hours ⇄ session windows (PROMPT-33 follow-up): the settings
// panel offers "we play 09:00–18:00"; the engine wants absolute intervals.
import { describe, expect, it } from "vitest";
import { dailyHoursToWindows, windowsToDailyHours } from "@/lib/schedule-board";

describe("dailyHoursToWindows", () => {
  it("expands one window per day across the start→end span, inclusive", () => {
    // Noon-anchored timestamps: any offset within ±11h keeps these on the
    // 15th–17th in local wall-clock, which is what the panel passes.
    const windows = dailyHoursToWindows(
      "09:00",
      "18:00",
      "2026-09-15T12:00:00.000Z",
      "2026-09-17T12:00:00.000Z",
    );
    expect(windows).not.toBeNull();
    expect(windows!.length).toBe(3);
    for (const w of windows!) {
      const from = new Date(w.from);
      const to = new Date(w.to);
      expect(`${from.getHours()}:${from.getMinutes()}`).toBe("9:0");
      expect(`${to.getHours()}:${to.getMinutes()}`).toBe("18:0");
      expect(to.getTime()).toBeGreaterThan(from.getTime());
    }
  });

  it("caps at two weeks when the schedule has no end date", () => {
    const windows = dailyHoursToWindows("10:00", "20:00", "2026-09-15T09:00:00.000Z", null);
    expect(windows!.length).toBe(14);
  });

  it("rejects inverted, equal and malformed hours", () => {
    expect(dailyHoursToWindows("18:00", "09:00", "2026-09-15T09:00:00.000Z")).toBeNull();
    expect(dailyHoursToWindows("09:00", "09:00", "2026-09-15T09:00:00.000Z")).toBeNull();
    expect(dailyHoursToWindows("9am", "6pm", "2026-09-15T09:00:00.000Z")).toBeNull();
    expect(dailyHoursToWindows("09:00", "18:00", "not-a-date")).toBeNull();
  });
});

describe("windowsToDailyHours", () => {
  it("round-trips a uniform daily pattern", () => {
    const windows = dailyHoursToWindows(
      "09:30",
      "17:45",
      "2026-09-15T00:00:00.000Z",
      "2026-09-18T00:00:00.000Z",
    )!;
    expect(windowsToDailyHours(windows)).toEqual({ from: "09:30", to: "17:45" });
  });

  it("returns null for hand-built irregular windows (leave them alone)", () => {
    const windows = dailyHoursToWindows(
      "09:00",
      "18:00",
      "2026-09-15T00:00:00.000Z",
      "2026-09-16T00:00:00.000Z",
    )!;
    const irregular = [...windows, { from: "2026-09-17T13:00:00.000Z", to: "2026-09-17T15:00:00.000Z" }];
    expect(windowsToDailyHours(irregular)).toBeNull();
    expect(windowsToDailyHours([])).toBeNull();
  });
});
