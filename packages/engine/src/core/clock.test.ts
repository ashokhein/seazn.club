// Injected time — spec 03 §1/§6. Ambient time is allowed in this file only
// (boundary gate allowlist: core/clock*.ts).
import { describe, expect, it } from "vitest";
import { fixedClock, systemClock, tickingClock, type Clock } from "./clock.ts";

describe("fixedClock", () => {
  it("always returns the injected instant", () => {
    const clock: Clock = fixedClock("2026-01-01T00:00:00.000Z");
    expect(clock.now()).toBe("2026-01-01T00:00:00.000Z");
    expect(clock.now()).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("tickingClock", () => {
  it("advances a fixed step per call, deterministically", () => {
    const clock = tickingClock("2026-01-01T00:00:00.000Z", 60_000);
    expect(clock.now()).toBe("2026-01-01T00:00:00.000Z");
    expect(clock.now()).toBe("2026-01-01T00:01:00.000Z");
    expect(clock.now()).toBe("2026-01-01T00:02:00.000Z");
  });

  it("defaults to 1s steps", () => {
    const clock = tickingClock("2026-01-01T00:00:00.000Z");
    clock.now();
    expect(clock.now()).toBe("2026-01-01T00:00:01.000Z");
  });
});

describe("systemClock", () => {
  it("returns a valid ISO timestamp near wall time", () => {
    const before = Date.now();
    const iso = systemClock.now();
    const after = Date.now();
    const t = new Date(iso).getTime();
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(after);
  });
});
