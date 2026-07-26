// The "Current plan" card once printed the RAW subscription row: a trial whose
// `status` was stuck at `trialing` past its `trial_end` showed "Pro / trialing"
// with a contradictory "Trial ended" note, even though the resolver had already
// degraded the org to Community. `isPlanLapsed` is the pure derivation the page
// uses to notice that disagreement and switch to the resolved plan + a
// resubscribe path.
import { describe, expect, it } from "vitest";
import { isPlanLapsed } from "@/lib/entitlements";

describe("isPlanLapsed", () => {
  it("is true when the row claims a paid plan the resolver dropped to community", () => {
    // Lapsed trial / expired comp / exhausted dunning: raw pro, effective free.
    expect(isPlanLapsed("pro", "community")).toBe(true);
    expect(isPlanLapsed("pro_plus", "community")).toBe(true);
  });

  it("is false while a trial is live — resolver still reads the paid plan (grace)", () => {
    // A sub inside its trial (or within the 1-day grace) resolves to pro, so the
    // card must keep showing "Pro / trialing", not a lapse.
    expect(isPlanLapsed("pro", "pro")).toBe(false);
    expect(isPlanLapsed("pro_plus", "pro_plus")).toBe(false);
  });

  it("is false for an honest community org — nothing to reconcile", () => {
    expect(isPlanLapsed("community", "community")).toBe(false);
    expect(isPlanLapsed(null, "community")).toBe(false);
    expect(isPlanLapsed(undefined, "community")).toBe(false);
  });

  it("does not fire on a plan change between two paid tiers", () => {
    // pro -> pro_plus is a real paid plan, not a lapse.
    expect(isPlanLapsed("pro", "pro_plus")).toBe(false);
    expect(isPlanLapsed("pro_plus", "pro")).toBe(false);
  });
});
