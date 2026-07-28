// The extra-org control's refusal copy (v17 gap #293, Task 6). Pure: no DB, no
// Stripe, no DOM.
//
// `POST /api/billing/extra-orgs` answers 400 / 401 / 403 / 409 / 422 / 423 /
// 503 / 500, and THREE of those are different ACTIONS by the customer — 409
// "change plan", 422 "change the number", 423 "move an organisation out".
// Collapsing any two produces copy that tells a paying customer to do the wrong
// thing, and that is not visible in a screenshot. So it is pinned here.
import { describe, expect, it } from "vitest";
import en from "@/dictionaries/en/ui.json";
import { EXTRA_ORGS_REFUSAL_STATUSES, extraOrgsErrorKey } from "@/lib/extra-orgs-copy";

describe("extraOrgsErrorKey", () => {
  it("gives every documented refusal its OWN key", () => {
    const keys = EXTRA_ORGS_REFUSAL_STATUSES.map((s) => extraOrgsErrorKey(s));
    // The real assertion is the second one; the first only makes the failure
    // message name which statuses collided.
    expect(new Set(keys).size, `collided: ${keys.join(", ")}`).toBe(keys.length);
    expect(keys).toEqual([
      "addOns.extraOrg.error.orgState",
      "addOns.extraOrg.error.signedOut",
      "addOns.extraOrg.error.notPayer",
      "addOns.extraOrg.error.planCannot",
      "addOns.extraOrg.error.badCount",
      "addOns.extraOrg.error.inUse",
      "addOns.extraOrg.error.unavailable",
    ]);
  });

  it("keeps the three REMEDIES apart", () => {
    // Named separately from the uniqueness check above because this is the one
    // that matters: a future edit that merges 409 and 423 into a single
    // "cannot right now" key would still pass a set-size assertion if some
    // other pair had been split at the same time.
    const planChange = extraOrgsErrorKey(409);
    const differentNumber = extraOrgsErrorKey(422);
    const moveAnOrgOut = extraOrgsErrorKey(423);
    expect(planChange).not.toBe(differentNumber);
    expect(planChange).not.toBe(moveAnOrgOut);
    expect(differentNumber).not.toBe(moveAnOrgOut);
  });

  it("does not send a stale-org-cookie 400 to the 'fix your number' copy", () => {
    // The route pushes EVERY body-parse failure to 422 precisely so 400 can
    // mean org/session state and nothing else. If this ever collapses, a
    // customer whose org cookie went stale is told to change a number that is
    // already correct.
    expect(extraOrgsErrorKey(400)).not.toBe(extraOrgsErrorKey(422));
  });

  it("says nothing confident about a 500 or a rejected fetch", () => {
    expect(extraOrgsErrorKey(500)).toBe("addOns.extraOrg.error.generic");
    expect(extraOrgsErrorKey(null)).toBe("addOns.extraOrg.error.generic");
    // A status we have never seen must not borrow a specific remedy.
    expect(extraOrgsErrorKey(418)).toBe("addOns.extraOrg.error.generic");
    expect(extraOrgsErrorKey(502)).toBe("addOns.extraOrg.error.generic");
  });

  it("resolves to real copy — every key exists in the shipped dictionary", () => {
    // Dictionaries are FLAT dotted-key JSON, so membership is a plain `in`.
    // Without this, a typo'd key renders as the key itself to a paying
    // customer and every assertion above still passes.
    const dict = en as Record<string, string>;
    const all = [...EXTRA_ORGS_REFUSAL_STATUSES.map(extraOrgsErrorKey), extraOrgsErrorKey(500)];
    const missing = all.filter((k) => !(k in dict));
    expect(missing, `missing from en/ui.json: ${missing.join(", ")}`).toEqual([]);
  });
});
