// V304 — the scheduling timezone is an ORGANISATION setting that divisions
// inherit. The division-level control was removed from the console entirely,
// but `schedule_settings.tz` survives and keeps winning: divisions created
// before V304 hold real zones, and if resolution stopped honouring them their
// published timetables would silently shift.
import { describe, expect, it } from "vitest";
import { pickTimezone, resolveVenueTz } from "@/lib/tz";
import { PutScheduleSettings } from "@/server/api-v1/schemas";

const CONFIG = {
  startAt: null,
  endAt: null,
  matchMinutes: 30,
  gapMinutes: 0,
  courts: ["Court 1"],
  perEntrantMinRest: 0,
  blackouts: [],
  sessionWindows: [],
};

describe("resolveVenueTz — venue lane precedence", () => {
  it("keeps an existing per-division tz even though the UI can no longer set one", () => {
    // The load-bearing case. Org says Madrid; this division was pinned to
    // Chennai before V304 and must stay there.
    expect(resolveVenueTz("Asia/Kolkata", "Europe/Madrid")).toBe("Asia/Kolkata");
  });

  it("inherits the org timezone when the division has none", () => {
    expect(resolveVenueTz(null, "Europe/Madrid")).toBe("Europe/Madrid");
    expect(resolveVenueTz(undefined, "Europe/Madrid")).toBe("Europe/Madrid");
  });

  it("falls back to UTC when neither is set", () => {
    expect(resolveVenueTz(null, null)).toBe("UTC");
  });

  it("skips blank or unknown zones rather than trusting them", () => {
    expect(resolveVenueTz("  ", "Europe/Madrid")).toBe("Europe/Madrid");
    expect(resolveVenueTz("Mars/Olympus_Mons", "Europe/Madrid")).toBe("Europe/Madrid");
    expect(resolveVenueTz("Mars/Olympus_Mons", "Nowhere/Nothing")).toBe("UTC");
  });

  it("never consults the personal lane (a London organiser can play in Malaga)", () => {
    // pickTimezone is the PERSONAL lane and takes the user's own zone; the
    // venue lane must produce a different answer from the same inputs.
    expect(pickTimezone("Europe/London", null)).toBe("Europe/London");
    expect(resolveVenueTz(null, "Europe/Madrid")).toBe("Europe/Madrid");
  });
});

describe("PutScheduleSettings.tz — tri-state", () => {
  it("leaves tz undefined when the body omits it, so a save cannot move a division's zone", () => {
    // The console now ALWAYS omits tz. If this defaulted (it used to default
    // to "UTC"), every settings save would stamp UTC over an inherited or
    // pre-existing zone.
    const parsed = PutScheduleSettings.parse({ config: CONFIG });
    expect("tz" in parsed ? parsed.tz : undefined).toBeUndefined();
  });

  it("still accepts an explicit zone, and null to clear back to inheriting", () => {
    expect(PutScheduleSettings.parse({ config: CONFIG, tz: "Europe/Madrid" }).tz).toBe("Europe/Madrid");
    expect(PutScheduleSettings.parse({ config: CONFIG, tz: null }).tz).toBeNull();
  });
});
