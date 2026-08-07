// The z3 objective minimizes makespan and has nothing that spreads a board
// across a multi-day window (T1 in build.ts pulls every fixture toward the
// earliest reachable day) — so a 7-day window with no explicit day cap piled
// every fixture onto day one exactly like a 1-day window did. This is the
// default `max_fixtures_per_day` the auto pass now injects to close that gap,
// tested as the pure function it is rather than through a full autoSchedule
// DB round trip.
import { describe, expect, it } from "vitest";
import { calendarDaysCovering, type SlotConfig, type VerifyConfig } from "@seazn/engine/scheduling";
import { withDefaultDaySpread } from "../schedule";

type Config = SlotConfig & VerifyConfig;

const DIVISION = "div-1";
const DAY_MS = 86_400_000;
// Jan 1 00:00 UTC → Jan 8 00:00 UTC: exactly 7 whole UTC calendar days,
// midnight-aligned so the expected day count is unambiguous.
const WEEK_WINDOW = { from: Date.UTC(2026, 0, 1), to: Date.UTC(2026, 0, 1) + 7 * DAY_MS };
const SAME_DAY_WINDOW = { from: Date.UTC(2026, 0, 1, 9, 0), to: Date.UTC(2026, 0, 1, 18, 0) };
const CONSTRAINT_DEFAULTS = {
  noBackToBack: false,
  startWindows: [],
  fieldFairness: "off" as const,
  parallelism: "mixed" as const,
  crossPersonClash: "warn" as const,
};

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    startAt: WEEK_WINDOW.from,
    matchMinutes: 30,
    gapMinutes: 10,
    courts: ["C1", "C2"],
    perEntrantMinRest: 10,
    window: WEEK_WINDOW,
    tz: "UTC",
    ...overrides,
  };
}

describe("withDefaultDaySpread", () => {
  it("injects ceil(fixtures / availableDays) when nothing was set", () => {
    // calendarDaysCovering's own convention (repair-domain.ts) is inclusive of
    // the boundary day, so a from-Jan1-to-Jan8-midnight window covers 8 day
    // buckets (Jan1..Jan8), not 7 — asserted here so a future change to that
    // shared function shows up as a failure here too, not just a silent
    // reshaping of the injected count.
    const days = calendarDaysCovering(WEEK_WINDOW, "UTC").length - 2;
    expect(days).toBe(8);

    const out = withDefaultDaySpread(baseConfig(), DIVISION, 37);

    expect(out.constraints?.hard).toEqual([
      { type: "max_fixtures_per_day", count: Math.ceil(37 / days), scope: { kind: "division", divisionId: DIVISION } },
    ]);
  });

  it("never overwrites an explicit whole-division cap the organiser already set", () => {
    const explicit = [
      { type: "max_fixtures_per_day" as const, count: 3, scope: { kind: "division" as const, divisionId: DIVISION } },
    ];
    const config = baseConfig({ constraints: { ...CONSTRAINT_DEFAULTS, hard: explicit } });

    const out = withDefaultDaySpread(config, DIVISION, 37);

    expect(out).toBe(config);
    expect(out.constraints?.hard).toEqual(explicit);
  });

  it("leaves an AI-compiled cap for a DIFFERENT scope alone and still adds the default", () => {
    const entrantScoped = [
      { type: "max_fixtures_per_day" as const, count: 2, scope: { kind: "entrant" as const, entrantId: "e1" } },
    ];
    const config = baseConfig({ constraints: { ...CONSTRAINT_DEFAULTS, hard: entrantScoped } });

    const out = withDefaultDaySpread(config, DIVISION, 14);

    expect(out.constraints?.hard).toEqual([
      ...entrantScoped,
      { type: "max_fixtures_per_day", count: 2, scope: { kind: "division", divisionId: DIVISION } },
    ]);
  });

  it("does nothing for a single-day window — nothing to spread across", () => {
    const config = baseConfig({ window: SAME_DAY_WINDOW });

    const out = withDefaultDaySpread(config, DIVISION, 40);

    expect(out).toBe(config);
  });

  it("does nothing without a resolved org timezone", () => {
    const config = baseConfig({ tz: undefined });

    const out = withDefaultDaySpread(config, DIVISION, 40);

    expect(out).toBe(config);
  });

  it("does nothing for zero schedulable fixtures", () => {
    const config = baseConfig();

    const out = withDefaultDaySpread(config, DIVISION, 0);

    expect(out).toBe(config);
  });

  it("always caps at 1, never 0, even with far more days than fixtures", () => {
    const days = calendarDaysCovering(WEEK_WINDOW, "UTC").length - 2;
    const out = withDefaultDaySpread(baseConfig(), DIVISION, 1);

    expect(days).toBeGreaterThan(1);
    expect(out.constraints?.hard).toEqual([
      { type: "max_fixtures_per_day", count: 1, scope: { kind: "division", divisionId: DIVISION } },
    ]);
  });
});
