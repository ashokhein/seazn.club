// The /pricing Event Pass column's call-to-action (task 19, spec D3).
//
// The column used to send EVERY reader to /login?tab=signup. For a signed-in
// organiser that is a dead end — they already have an account, and the page
// that sells the pass (routes.competitionUpgrade) needs a competition, which a
// marketing page does not have. So a signed-in community reader is handed to
// the console, where the competition list offers the pass per competition.
//
// The third variant is the one that must never regress: a paying customer is
// not offered the pass at all. Pro's matrix is a strict superset of the pass
// (10 AI runs per division against 20, 64 entrants per division against 256),
// so the $29 would buy them strictly less than they hold.
import { describe, expect, it } from "vitest";
import { passCtaVariant } from "@/lib/pass-cta";

describe("passCtaVariant", () => {
  it("sends an anonymous visitor to signup, exactly as before", () => {
    expect(passCtaVariant({ signedIn: false, paidPlan: false })).toBe("signup");
  });

  it("ignores the plan flag when signed out", () => {
    // There is no org to have a plan; a stray true must not change the column.
    expect(passCtaVariant({ signedIn: true, paidPlan: false })).toBe("console");
    expect(passCtaVariant({ signedIn: false, paidPlan: true })).toBe("signup");
  });

  it("hands a signed-in community org to the console", () => {
    expect(passCtaVariant({ signedIn: true, paidPlan: false })).toBe("console");
  });

  it("never offers the pass to an org already on a paid plan", () => {
    expect(passCtaVariant({ signedIn: true, paidPlan: true })).toBe("included");
  });
});
