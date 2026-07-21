// The upgrade page's five states (spec D10), decided in one place.
//
// The page it replaced branched `pass ? … : isPro ? … : offer` — three shapes
// for five situations — so a non-owner was shown a price nobody would let them
// pay, and a buyer who came back after hitting the pass's own ceiling got the
// same "you're all set" box as one who came to admire the purchase.
//
// The row that MUST NOT regress is `paid_plan` beating a held pass. It is the
// precedence `usePassGateState()` settled in f70b8e52 for exactly the same
// reason: once the resolved plan is paid, lib/entitlements.ts stops consulting
// the pass entirely, so the pass is neither what grants nor what blocks, and a
// page that led with the pass would name the wrong ceiling — and, in the offer
// arm, sell a $29 DOWNGRADE (the pass grants 10 AI runs per division against
// pro's 20, and 64 entrants per division against pro's 256).
import { describe, expect, it } from "vitest";
import { upgradePageState } from "@/lib/upgrade-page-state";

const state = (over: Partial<Parameters<typeof upgradePageState>[0]> = {}) =>
  upgradePageState({ paidPlan: false, hasPass: false, isOwner: true, ...over });

describe("upgradePageState", () => {
  it("offers the pass to a community owner with no pass", () => {
    expect(state()).toEqual({ kind: "offer", canBuy: true });
  });

  it("shows the offer to a non-owner but does not let them buy", () => {
    // U4: the price stays visible — a non-owner's next move is to take a number
    // to whoever can spend it — but no checkout is reachable from here.
    expect(state({ isOwner: false })).toEqual({ kind: "offer", canBuy: false });
  });

  it("confirms a held pass", () => {
    expect(state({ hasPass: true })).toEqual({ kind: "owned" });
  });

  it("treats a held pass plus an incoming feature key as the ceiling", () => {
    expect(state({ hasPass: true, feature: "entrants.per_division.max" })).toEqual({
      kind: "ceiling",
      feature: "entrants.per_division.max",
      liftable: true,
    });
  });

  it("marks a ceiling on a key the pass never covered as not liftable", () => {
    // `scheduling.board` is Pro-only and is absent from PASS_FEATURES, so the
    // page must say "not included" rather than "you've used it all" — the same
    // split <UpgradeGate> makes from the same set.
    expect(state({ hasPass: true, feature: "scheduling.board" })).toEqual({
      kind: "ceiling",
      feature: "scheduling.board",
      liftable: false,
    });
  });

  it("ignores a feature key when no pass is held", () => {
    // Arriving from a bitten gate with no pass is the ORDINARY offer: the pass
    // may well lift that very key, which is why the gate linked here at all.
    expect(state({ feature: "entrants.per_division.max" })).toEqual({
      kind: "offer",
      canBuy: true,
    });
  });

  it("ignores a blank feature key", () => {
    // `?feature=` with nothing after it must not fake a ceiling for a happy
    // pass holder — the query string is user-controlled.
    expect(state({ hasPass: true, feature: "   " })).toEqual({ kind: "owned" });
  });

  it("never offers a pass to an org on a paid plan", () => {
    expect(state({ paidPlan: true })).toEqual({ kind: "paid_plan" });
    expect(state({ paidPlan: true, isOwner: false })).toEqual({ kind: "paid_plan" });
  });

  it("puts the paid plan ahead of a pass the org also holds", () => {
    // Buy a pass, then upgrade: the row survives (U15, and it must — the pass
    // is bought outright and comes back on a downgrade). While the plan is
    // paid, the plan is the ceiling, so the pass cannot be the story.
    expect(state({ paidPlan: true, hasPass: true })).toEqual({ kind: "paid_plan" });
    expect(state({ paidPlan: true, hasPass: true, feature: "entrants.per_division.max" })).toEqual({
      kind: "paid_plan",
    });
  });
});
