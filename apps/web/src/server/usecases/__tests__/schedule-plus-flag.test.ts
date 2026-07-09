// Feature 3 — the `ai-scheduling` PostHog flag acts as a rollout kill-switch
// evaluated BEFORE the billing entitlement and any DB access. No Postgres
// needed: when the flag is off the call must 503 before touching the database.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthCtx } from "@/server/api-v1/auth";

const auth: AuthCtx = {
  orgId: "org-1",
  via: "session",
  userId: "user-1",
  role: "owner",
  keyId: null,
};

afterEach(() => vi.resetModules());

describe("aiConstraintsForDivision — ai-scheduling flag gate", () => {
  it("throws 503 (before entitlement/DB) when the flag is off", async () => {
    const isServerFeatureEnabled = vi.fn().mockResolvedValue(false);
    const requireFeature = vi.fn();
    vi.doMock("@/lib/posthog-server", () => ({ isServerFeatureEnabled }));
    vi.doMock("@/lib/entitlements", () => ({ requireFeature }));

    const { aiConstraintsForDivision } = await import("../schedule-plus");
    await expect(
      aiConstraintsForDivision(auth, "div-1", "spread teams out"),
    ).rejects.toMatchObject({ status: 503 });

    expect(isServerFeatureEnabled).toHaveBeenCalledWith(
      "ai-scheduling",
      "user-1",
      { orgId: "org-1", fallback: true },
    );
    // Kill-switch short-circuits ahead of the paid gate.
    expect(requireFeature).not.toHaveBeenCalled();
  });

  it("passes the flag gate (fallback on) and proceeds to the entitlement check", async () => {
    const isServerFeatureEnabled = vi.fn().mockResolvedValue(true);
    // requireFeature throws PaymentRequired — proves we got past the flag to the
    // paid gate without needing a DB.
    const requireFeature = vi.fn().mockRejectedValue(
      Object.assign(new Error("402"), { status: 402 }),
    );
    vi.doMock("@/lib/posthog-server", () => ({ isServerFeatureEnabled }));
    vi.doMock("@/lib/entitlements", () => ({ requireFeature }));

    const { aiConstraintsForDivision } = await import("../schedule-plus");
    await expect(
      aiConstraintsForDivision(auth, "div-1", "spread teams out"),
    ).rejects.toMatchObject({ status: 402 });
    expect(requireFeature).toHaveBeenCalledWith("org-1", "scheduling.ai");
  });
});
