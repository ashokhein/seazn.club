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
// arm, sell a $29 DOWNGRADE (the M rung grants 128 entrants per division
// against pro's 256, and 10 divisions against pro's uncapped count).
import { describe, expect, it } from "vitest";
import { upgradePageState } from "@/lib/upgrade-page-state";

const state = (over: Partial<Parameters<typeof upgradePageState>[0]> = {}) =>
  upgradePageState({ paidPlan: false, hasPass: false, lockReason: null, isOwner: true, ...over });

describe("upgradePageState", () => {
  it("offers the pass to a community owner with no pass", () => {
    expect(state()).toEqual({ kind: "offer", canBuy: true, beyondPlan: false });
  });

  it("shows the offer to a non-owner but does not let them buy", () => {
    // U4: the price stays visible — a non-owner's next move is to take a number
    // to whoever can spend it — but no checkout is reachable from here.
    expect(state({ isOwner: false })).toEqual({ kind: "offer", canBuy: false, beyondPlan: false });
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
      beyondPlan: false,
    });
  });

  it("ignores a blank feature key", () => {
    // `?feature=` with nothing after it must not fake a ceiling for a happy
    // pass holder — the query string is user-controlled.
    expect(state({ hasPass: true, feature: "   " })).toEqual({ kind: "owned" });
  });

  it("never offers a pass to an org on a paid plan that already covers it", () => {
    expect(state({ paidPlan: true })).toEqual({ kind: "paid_plan" });
    expect(state({ paidPlan: true, isOwner: false })).toEqual({ kind: "paid_plan" });
    // An EMPTY exceeding list says the same thing explicitly — which is what a
    // Pro Plus org, or a Pro org against the M rung, actually resolves to.
    expect(state({ paidPlan: true, exceedingRungs: [] })).toEqual({ kind: "paid_plan" });
  });

  // v17 gap #327. Pro stopped being a superset of every rung when L shipped: L
  // raises `entrants.per_division.max` above Pro's 256. A Pro organiser with one
  // oversized division was refused at the checkout AND told here that their plan
  // already covered it — the dead end this branch removes.
  describe("beyondPlan — a rung that still beats a paid plan", () => {
    it("offers the exceeding rung to a paid owner", () => {
      expect(state({ paidPlan: true, exceedingRungs: ["event_pass_l"] })).toEqual({
        kind: "offer",
        canBuy: true,
        beyondPlan: true,
      });
    });

    it("shows it to a paid non-owner without a checkout", () => {
      expect(state({ paidPlan: true, isOwner: false, exceedingRungs: ["event_pass_l"] })).toEqual({
        kind: "offer",
        canBuy: false,
        beyondPlan: true,
      });
    });

    it("does NOT offer a second pass to a paid org that already holds one", () => {
      // There is no M→L upgrade path (#294 Q3) and one competition takes one
      // pass forever (#248 Q4), so offering here would advertise a purchase the
      // checkout cannot complete — the downgrade-sale defect from the other side.
      expect(state({ paidPlan: true, hasPass: true, exceedingRungs: ["event_pass_l"] })).toEqual({
        kind: "paid_plan",
      });
    });

    it("leaves the community offer untouched", () => {
      // `beyondPlan` is a statement about a PAYING reader. A community org
      // reaching the same offer must not be told its plan covers anything.
      expect(state({ exceedingRungs: ["event_pass_l"] })).toEqual({
        kind: "offer",
        canBuy: true,
        beyondPlan: false,
      });
    });
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

  // v17 gap #301. `hasPass` is row existence, and the row outlives the pass's
  // usefulness: the resolver stops honouring it at a terminal status or a week
  // past `ends_on`, while the row sits there unchanged forever. Every state
  // below this line was therefore reachable with a pass that lifts nothing.
  describe("ended — a held pass that has stopped applying", () => {
    it("shows ended once a held pass has stopped applying", () => {
      expect(state({ hasPass: true, lockReason: "terminal" })).toEqual({
        kind: "ended",
        reason: "terminal",
      });
      expect(state({ hasPass: true, lockReason: "past_ends_on" })).toEqual({
        kind: "ended",
        reason: "past_ends_on",
      });
    });

    it("carries the reason through, rather than collapsing the two", () => {
      // The two arms want different sentences AND different next steps: one
      // competition is over, the other is probably still being played with a
      // stale date. A boolean here would force the page to pick one apology
      // for both.
      const a = state({ hasPass: true, lockReason: "terminal" });
      const b = state({ hasPass: true, lockReason: "past_ends_on" });
      expect(a).not.toEqual(b);
    });

    it("ended beats the ceiling — the real reason is expiry, not a usage ceiling", () => {
      // Arriving from a gate with `?feature=` used to mean "you have used
      // everything the pass includes". With a locked pass that is false: the
      // pass is lifting nothing, so nothing has been used up.
      expect(
        state({ hasPass: true, lockReason: "terminal", feature: "entrants.per_division.max" }),
      ).toEqual({ kind: "ended", reason: "terminal" });
    });

    it("paid_plan still beats an ended pass", () => {
      expect(state({ paidPlan: true, hasPass: true, lockReason: "terminal" })).toEqual({
        kind: "paid_plan",
      });
    });

    it("a pass with no lock reason is unaffected — existing owned/ceiling behaviour", () => {
      expect(state({ hasPass: true, lockReason: null })).toEqual({ kind: "owned" });
      expect(
        state({ hasPass: true, lockReason: null, feature: "entrants.per_division.max" }),
      ).toEqual({ kind: "ceiling", feature: "entrants.per_division.max", liftable: true });
    });

    it("a lock reason with NO pass row is still the ordinary offer", () => {
      // Row existence is checked first on purpose: a reason without a row must
      // not invent an ended pass for a competition that never had one, and
      // that org can genuinely still buy.
      expect(state({ hasPass: false, lockReason: "terminal" })).toEqual({
        kind: "offer",
        canBuy: true,
        beyondPlan: false,
      });
    });
  });
});
