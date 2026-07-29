import { describe, it, expect } from "vitest";
import { betterInt, intIsBetter, passBeatsPlan } from "@/lib/pass-vs-plan";

// v17 gap #327/#337 — "does this rung still add anything to that plan?", the
// question the checkout gate, the upgrade page and the resolver all now ask.
//
// Kept pure so the three cannot answer it differently, and so the ONE key where
// better means smaller has a home that is not a comment.

describe("betterInt", () => {
  it("takes the larger number on a cap", () => {
    expect(betterInt("entrants.per_division.max", 128, 256)).toBe(256);
    expect(betterInt("entrants.per_division.max", 256, 128)).toBe(256);
  });

  it("treats null as unlimited on a cap, from either side", () => {
    expect(betterInt("entrants.per_division.max", null, 256)).toBeNull();
    expect(betterInt("entrants.per_division.max", 256, null)).toBeNull();
  });

  it("takes the SMALLER number on registration.fee_percent", () => {
    // The money case. Pro charges 2%, both pass rungs charge 5%. A plain max
    // would call the pass "better" and, once the resolver overlays it, bill a
    // Pro organiser 5% on every entry fee for their passed competition — a pass
    // they PAID for making them worse off.
    expect(betterInt("registration.fee_percent", 5, 2)).toBe(2);
    expect(betterInt("registration.fee_percent", 2, 5)).toBe(2);
  });

  it("treats null as NO ANSWER on registration.fee_percent, not as unlimited", () => {
    expect(betterInt("registration.fee_percent", null, 2)).toBe(2);
    expect(betterInt("registration.fee_percent", 5, null)).toBe(5);
    expect(betterInt("registration.fee_percent", null, null)).toBeNull();
  });
});

describe("intIsBetter", () => {
  it("is false when the two are the same, including both null", () => {
    expect(intIsBetter("divisions.per_competition.max", 10, 10)).toBe(false);
    expect(intIsBetter("divisions.per_competition.max", null, null)).toBe(false);
  });

  it("reports unlimited as better than any number, and never the reverse", () => {
    expect(intIsBetter("entrants.per_division.max", null, 256)).toBe(true);
    expect(intIsBetter("entrants.per_division.max", 256, null)).toBe(false);
  });
});

describe("passBeatsPlan", () => {
  /** The live matrix, verified against plan_entitlements (#327's own table). */
  const proRows = [
    { feature_key: "entrants.per_division.max", bool_value: null, int_value: 256 },
    { feature_key: "divisions.per_competition.max", bool_value: null, int_value: null },
    { feature_key: "registration.fee_percent", bool_value: null, int_value: 2 },
    { feature_key: "dashboard.branding", bool_value: true, int_value: null },
  ];
  const passM = [
    { feature_key: "entrants.per_division.max", bool_value: null, int_value: 128 },
    { feature_key: "divisions.per_competition.max", bool_value: null, int_value: 10 },
    { feature_key: "registration.fee_percent", bool_value: null, int_value: 5 },
    { feature_key: "dashboard.branding", bool_value: false, int_value: null },
  ];
  const passL = [
    { feature_key: "entrants.per_division.max", bool_value: null, int_value: null },
    { feature_key: "divisions.per_competition.max", bool_value: null, int_value: 20 },
    { feature_key: "registration.fee_percent", bool_value: null, int_value: 5 },
    { feature_key: "dashboard.branding", bool_value: false, int_value: null },
  ];

  it("L beats Pro — unlimited entrants against Pro's 256", () => {
    expect(passBeatsPlan(passL, proRows)).toBe(true);
  });

  it("M does not beat Pro — Pro is a strict superset of M", () => {
    // The premise the whole product was built on, still true for this pair.
    // If this ever flips, the checkout starts selling M to Pro and it should
    // fail here first.
    expect(passBeatsPlan(passM, proRows)).toBe(false);
  });

  it("a lower fee on the plan is not something the pass 'beats'", () => {
    const feeOnly = [{ feature_key: "registration.fee_percent", bool_value: null, int_value: 5 }];
    expect(passBeatsPlan(feeOnly, proRows)).toBe(false);
  });

  it("a pass that says false where the plan says true beats nothing", () => {
    // A pass GRANTS, never revokes: `dashboard.branding` is false on both rungs
    // and true on Pro, and reading that as a difference would sell a pass whose
    // only effect is to take something away.
    const boolOnly = [{ feature_key: "dashboard.branding", bool_value: false, int_value: null }];
    expect(passBeatsPlan(boolOnly, proRows)).toBe(false);
  });

  it("a pass that grants a bool the plan lacks does beat it", () => {
    const community = [{ feature_key: "board.realtime", bool_value: false, int_value: null }];
    const grants = [{ feature_key: "board.realtime", bool_value: true, int_value: null }];
    expect(passBeatsPlan(grants, community)).toBe(true);
  });

  it("ignores keys the plan does not carry at all", () => {
    // The plan matrix is sparse and a missing row already means "fall through to
    // false/0" in the resolver, NOT "unlimited". Counting absence as a win would
    // make every rung beat every plan and open the gate to everybody.
    const exotic = [{ feature_key: "not.on.the.plan", bool_value: true, int_value: null }];
    expect(passBeatsPlan(exotic, proRows)).toBe(false);
  });
});
