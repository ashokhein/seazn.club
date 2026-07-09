import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// These run with PostHog UNCONFIGURED (no key env) — the default for CI and
// local test. The contract: analytics must be a no-op that never throws and
// never constructs a client, so gated code degrades to known-safe defaults.

const OLD_ENV = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  delete process.env.POSTHOG_KEY;
  delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
});

afterEach(() => {
  process.env = { ...OLD_ENV };
});

describe("posthog-server (unconfigured)", () => {
  it("captureServer resolves without throwing and never touches the SDK", async () => {
    const ctor = vi.fn();
    vi.doMock("posthog-node", () => ({ PostHog: class { constructor() { ctor(); } } }));
    const { captureServer } = await import("@/lib/posthog-server");
    const { EVENTS } = await import("@/lib/analytics-events");

    await expect(
      captureServer({ event: EVENTS.COMPETITION_CREATED, distinctId: "u1", orgId: "o1" }),
    ).resolves.toBeUndefined();
    expect(ctor).not.toHaveBeenCalled();
  });

  it("isServerFeatureEnabled returns false by default and honors an explicit fallback", async () => {
    vi.doMock("posthog-node", () => ({ PostHog: class {} }));
    const { isServerFeatureEnabled } = await import("@/lib/posthog-server");

    expect(await isServerFeatureEnabled("new-scheduler", "u1")).toBe(false);
    expect(
      await isServerFeatureEnabled("new-scheduler", "u1", { fallback: true, orgId: "o1" }),
    ).toBe(true);
  });
});

describe("posthog-server (configured)", () => {
  it("captures with the org group and evaluates flags via the SDK", async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
    const capture = vi.fn();
    const flush = vi.fn().mockResolvedValue(undefined);
    const isFeatureEnabled = vi.fn().mockResolvedValue(true);
    vi.doMock("posthog-node", () => ({
      PostHog: class {
        capture = capture;
        flush = flush;
        isFeatureEnabled = isFeatureEnabled;
      },
    }));
    const { captureServer, isServerFeatureEnabled } = await import("@/lib/posthog-server");
    const { EVENTS } = await import("@/lib/analytics-events");

    await captureServer({ event: EVENTS.SUBSCRIPTION_STARTED, distinctId: "u1", orgId: "o9" });
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({
        distinctId: "u1",
        event: EVENTS.SUBSCRIPTION_STARTED,
        groups: { organization: "o9" },
      }),
    );
    expect(flush).toHaveBeenCalled();

    expect(await isServerFeatureEnabled("f", "u1", { orgId: "o9" })).toBe(true);
    expect(isFeatureEnabled).toHaveBeenCalledWith("f", "u1", { groups: { organization: "o9" } });
  });
});
