import { describe, it, expect } from "vitest";
import { featurePlan, featureReason } from "@/lib/feature-copy";

/**
 * The vocabulary a price claim has to reach for. The ruling on the
 * `orgs.max_owned` refusal (v17 gap #293) is "name the purchase, never price
 * it" — a rule about what the sentence CLAIMS, which a denylist of specific
 * phrasings cannot express.
 *
 * Deliberately NOT a no-digits rule: the sentence's job is to state the caps
 * ("Community 1, Pro 5, Pro Plus 10"), so digits are the thing it must keep.
 */
const PRICES_THE_RIDER =
  /[$£€]|\b(rates?|prices?|priced|pricing|costs?|fees?|half|double|cheaper|discount)\b/i;

describe("feature-copy V290", () => {
  it("maps Plus features to pro_plus", () => {
    for (const k of ["api.write", "scorers.max", "officials.auto", "domains.custom", "support.priority"]) {
      expect(featurePlan(k)).toBe("pro_plus");
    }
    expect(featurePlan("scheduling.board")).toBe("pro");
    expect(featurePlan("officials.roles_multi")).toBe("pro");
    // V302 (owner 2026-07-19): AI scheduling exists on every tier; Pro is the
    // next step up for the bool feature-flag itself.
    expect(featurePlan("scheduling.ai")).toBe("pro");
  });
  it("has reasons for the new keys and none for the dead one", () => {
    expect(featureReason("officials.per_fixture.max")).toMatch(/one official per fixture/i);
    expect(featureReason("schedule.checkpoints.max")).toMatch(/save.point/i);
    expect(featureReason("scheduling.ai")).toMatch(/AI Schedule/);
    expect(featureReason("domains.custom")).toMatch(/domain/i);
    expect(featureReason("support.priority")).toMatch(/priority/i);
    // scheduling.ai.runs_per_division.max retired (v17 Phase 2 Task 5, V322):
    // the graded per-division cap copy is gone — falls back to the generic
    // line, same as any other deleted key.
    expect(featureReason("scheduling.ai.runs_per_division.max")).toBe(
      "This feature needs a plan upgrade.",
    );
    // officials.assignment was deleted (D5) — falls back to the generic line.
    expect(featureReason("officials.assignment")).toBe("This feature needs a plan upgrade.");
  });
  it("orgs.max_owned names the same remedy the 402's machine hint does (v17 gap #293)", () => {
    // The refusal ships TWO halves of one message: `{ offer: "extra_org" }` in
    // the body and this sentence next to it. If the copy drifts back to
    // "upgrade in Settings → Billing", the paywall tells the payer to do one
    // thing while the payload offers another, and nothing else notices.
    const reason = featureReason("orgs.max_owned");
    expect(reason).toMatch(/extra organisation/i);
    expect(reason).toMatch(/Add-ons/);
    // The CADENCE is the one commercial fact this sentence may state: it is
    // true on every plan and in every currency. Positive, and it pairs with
    // the absence below — the sentence must still NAME the purchase and its
    // rhythm, it just must not PRICE it.
    expect(reason).toMatch(/monthly/i);
    expect(reason).not.toMatch(PRICES_THE_RIDER);
  });

  it("the no-price rule survives a REWORD — it pins vocabulary, not two phrasings", () => {
    // The rule used to be `not.toMatch(/half/i)` + `not.toMatch(/same rate/i)`,
    // which is a denylist of two sentences rather than the ruling. Putting the
    // exact falsehood back in different words passed.
    //
    // Every claim below is plausible and every one is ~37% wrong for an ANNUAL
    // group: the plan price's second graduated tier (what the organisations
    // already on the bill cost) is 900/1900 a month but 7900/16300 a YEAR,
    // while the rider SKU sold here is monthly-only at 900/1900. The figure
    // belongs to the Add-ons page, which knows the currency and reads it from
    // the rider SKU.
    for (const reworded of [
      "buy an extra organisation at half your plan's rate",
      "buy an extra organisation at the same rate as the ones already on your bill",
      "buy an extra organisation at the same monthly cost as the ones on your bill",
      "buy an extra organisation for $9",
      "buy an extra organisation for £9 a month",
      "buy an extra organisation — €19 on Pro Plus",
      "an extra organisation is priced per month",
      "extra organisations are cheaper than a second bill",
      "there is no extra fee beyond your plan",
    ]) {
      expect(reworded).toMatch(PRICES_THE_RIDER);
    }

    // Discriminators, so the rule is not simply "reject every sentence": the
    // shipped copy passes, and so does the ONE set of numbers it must keep.
    // A no-digits rule would have been WRONG for exactly this reason — the
    // caps themselves are what the refusal is about.
    expect(featureReason("orgs.max_owned")).not.toMatch(PRICES_THE_RIDER);
    expect("Community 1, Pro 5, Pro Plus 10").not.toMatch(PRICES_THE_RIDER);
    expect("it's billed monthly on top of your current bill").not.toMatch(PRICES_THE_RIDER);
  });
  it("has copy for the v16 league-ops entitlements (V293/V294/V295, T84)", () => {
    expect(featureReason("discipline.enforced")).toBe(
      "Automatic suspension tracking is a Pro feature.",
    );
    expect(featureReason("officials.marks")).toBe("Rating your match officials is a Pro feature.");
    expect(featureReason("news.auto")).toBe("Auto-drafted result posts are a Pro feature.");
    expect(featurePlan("discipline.enforced")).toBe("pro");
    expect(featurePlan("officials.marks")).toBe("pro");
    expect(featurePlan("news.auto")).toBe("pro");
  });
});
