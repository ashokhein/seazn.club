import { describe, expect, it } from "vitest";
import { sortFixturesForOfficials } from "@/components/v2/officials-panel";

describe("sortFixturesForOfficials", () => {
  it("scheduled first (by time), then in_play + decided", () => {
    const f = (id: string, status: string, at: string | null) =>
      ({ id, label: id, scheduled_at: at, status, officials: [] });
    const input = [
      f("done", "finalized", "2026-08-01T09:00:00Z"),
      f("live", "in_play", "2026-08-01T08:00:00Z"),
      f("late", "scheduled", "2026-08-01T12:00:00Z"),
      f("early", "scheduled", "2026-08-01T10:00:00Z"),
      f("cancel", "cancelled", "2026-08-01T07:00:00Z"),
    ];
    expect(sortFixturesForOfficials(input).map((x) => x.id))
      .toEqual(["early", "late", "cancel", "live", "done"]);
  });

  it("handles Date scheduled_at (RSC passes Date, not ISO string) without throwing", () => {
    // Regression: scheduled_at crosses the RSC boundary as a Date; the old
    // impl called .localeCompare on it and threw at render time.
    const f = (id: string, status: string, at: Date | null) =>
      ({ id, label: id, scheduled_at: at, status, officials: [] });
    const input = [
      f("done", "finalized", new Date("2026-08-01T09:00:00Z")),
      f("late", "scheduled", new Date("2026-08-01T12:00:00Z")),
      f("early", "scheduled", new Date("2026-08-01T10:00:00Z")),
      f("unsched", "scheduled", null),
    ];
    expect(sortFixturesForOfficials(input).map((x) => x.id))
      .toEqual(["early", "late", "unsched", "done"]);
  });
});
