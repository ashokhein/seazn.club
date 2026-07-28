// Truth-in-copy guards for the Stripe seed (v17 gap wave 7, #298 / #299).
//
// The guards themselves live in `@/lib/copy-truth` — a plain module, so that
// Tasks 3, 4 and 7 can import the pattern lists without re-running this suite.
// This file is the application of them to `stripe-plans.json`, plus the
// rewording proofs that keep them honest.
//
// LOCATION IS LOAD-BEARING: `src/lib/__tests__/`, not `src/__tests__/`. CI's
// unit job has no DATABASE_URL, and its two Postgres steps select
// `src/server src/lib` (.github/workflows/ci.yml:222) and `src/app` (:234).
// From `src/__tests__/` the entire `describe.skipIf(!HAS_DB)` half — cap↔matrix,
// the organisation allowance, the Pro Plus differentiator and the "largest
// grant" superlative — ran in NO job at all and reported 6 pending / exit 0.
// That is the exact failure vitest.config.ts's own header and ci.yml:215-220
// both document. Do not move this file out of a Postgres-covered tree.
import { afterAll, describe, expect, it } from "vitest";
import stripePlans from "@/config/stripe-plans.json";
import { PASS_CREDIT_GRANT } from "@/lib/pricing-cards";
import { sql } from "@/lib/db";
import {
  PLUS_DIFFERENTIATOR_VOCAB,
  type PricedPlan,
  type Rung,
  type RungCaps,
  capClaimFaults,
  describedEntries,
  describedSections,
  passCreditGrantFaults,
  passDurationFaults,
  plusDifferentiatorFaults,
  retiredRunCapFaults,
  riderRateFaults,
} from "@/lib/copy-truth";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

/** Same shape as pricing-cards.test.ts's capFor — duplicated locally rather
 *  than imported across test files. The row must EXIST: `int_value` is
 *  legitimately null on these columns (it means unlimited), so a missing row
 *  would otherwise read as "unlimited" and the copy check would sail on. */
const capFor = async (feature: string, plan: string): Promise<number | null> => {
  const [row] = await sql<{ int_value: number | null }[]>`
    select int_value from plan_entitlements
    where plan_key = ${plan} and feature_key = ${feature}`;
  expect(row, `plan_entitlements has no ${plan}/${feature} row`).toBeDefined();
  return row!.int_value;
};

/** A boolean grant. A MISSING row denies (lib/entitlements.ts resolver), so
 *  absent reads as false — unlike capFor, where absent is a matrix bug. */
const grants = async (feature: string, plan: string): Promise<boolean> => {
  const [row] = await sql<{ bool_value: boolean | null }[]>`
    select bool_value from plan_entitlements
    where plan_key = ${plan} and feature_key = ${feature}`;
  return row?.bool_value === true;
};

const seed = stripePlans as unknown as Record<string, unknown>;
const entries = describedEntries(seed);
const stripeRenderedText = entries.map((e) => e.description).join(" | ");

/** The Event Pass rungs. EVERY guard iterates this rather than naming
 *  `event_pass`: v17 #294 added a second rung, and a guard hardcoded to the
 *  first key silently stops covering the product the moment a rung is added. */
const passRungs: Rung[] = stripePlans.passes.map((p) => ({
  key: p.key,
  description: p.product.description,
}));

const plusDescription = stripePlans.plans.find((p) => p.key === "pro_plus")!.product.description;

// ─────────────────────────────────────────────────────────────────────────────
// The guards, against the real seed.
// ─────────────────────────────────────────────────────────────────────────────

describe("stripe-plans.json names no retired feature and no false pass permanence", () => {
  // The scan is only as good as what it collects, and a hand-written section
  // list is itself the thing that must be remembered — v17 #293 found
  // `org_addons` had escaped the sibling seed guard's list for a whole wave.
  it("scans every described section in the file, including ones added later", () => {
    const walked = new Set(entries.map((e) => e.section));
    expect([...walked].sort()).toEqual(describedSections(seed).sort());
    expect(entries.length).toBeGreaterThan(10);
  });

  it("quotes no retired per-division AI-run cap, in any section", () => {
    expect(retiredRunCapFaults(stripeRenderedText)).toEqual([]);
  });

  it("every Event Pass rung is sold as bounded, and says so", () => {
    expect(passDurationFaults(passRungs)).toEqual([]);
  });

  it("every Event Pass rung states the flat one-time credit grant, and only that", () => {
    expect(passCreditGrantFaults(passRungs)).toEqual([]);
  });

  // The rungs are told apart ONLY by size, so everything else about them must
  // read identically — a difference in wording between two products that are
  // deliberately identical is how a buyer infers a difference that isn't there.
  it("describes both rungs in the same terms apart from their caps", () => {
    const shape = passRungs.map(({ description }) =>
      description
        .replace(/\b\d+\s+(entrants|divisions)\b/gi, "N $1")
        .replace(/\bunlimited\s+/gi, "N "),
    );
    expect(new Set(shape).size, `rung copy diverged:\n${shape.join("\n")}`).toBe(1);
  });

  // N1: the extra-organisation rider, checked against the claim the copy makes
  // about it. No DB — both halves are in the seed.
  it("charges no more for an extra organisation than the copy claims", () => {
    expect(riderRateFaults(stripePlans.plans as unknown as PricedPlan[])).toEqual([]);
  });
});

describe.skipIf(!HAS_DB)("stripe-plans.json quotes the numbers the matrix enforces", () => {
  it("every Event Pass rung quotes its OWN live caps, and no other rung's", async () => {
    const caps: RungCaps[] = [];
    for (const { key } of passRungs) {
      caps.push({
        key,
        entrants: await capFor("entrants.per_division.max", key),
        divisions: await capFor("divisions.per_competition.max", key),
      });
    }
    expect(capClaimFaults(passRungs, caps)).toEqual([]);
  });

  // The pass grant is a ONE-TIME top-up: neither rung has an
  // `ai.credits.monthly` row, which is what makes "monthly" a false word in
  // that copy rather than a stylistic one, and PASS_CREDIT_GRANT its single
  // source.
  it("neither rung carries a monthly credit allowance in the matrix", async () => {
    expect(PASS_CREDIT_GRANT).toBe(25);
    for (const { key } of passRungs) {
      const [row] = await sql<{ int_value: number | null }[]>`
        select int_value from plan_entitlements
        where plan_key = ${key} and feature_key = 'ai.credits.monthly'`;
      expect(row, `${key} must have no monthly credit row`).toBeUndefined();
    }
  });

  it("Pro Plus claims no differentiator that Pro already has", async () => {
    const proGrants: Record<string, boolean> = {};
    const plusGrants: Record<string, boolean> = {};
    for (const [feature] of PLUS_DIFFERENTIATOR_VOCAB) {
      proGrants[feature] = await grants(feature, "pro");
      plusGrants[feature] = await grants(feature, "pro_plus");
    }
    expect(plusDifferentiatorFaults(plusDescription, proGrants, plusGrants)).toEqual([]);
  });

  // The int-shaped half of the same "Everything in Pro, plus…" claim.
  it("Pro Plus's unlimited-scale claim is unlimited on Plus and capped on Pro", async () => {
    for (const [word, feature] of [
      ["members", "members.max"],
      ["teams", "teams.max"],
      ["clubs", "clubs.max"],
    ] as const) {
      if (!new RegExp(`\\b${word}\\b`, "i").test(plusDescription)) continue;
      expect(await capFor(feature, "pro_plus"), `${feature}: Plus must be unlimited`).toBeNull();
      expect(await capFor(feature, "pro"), `${feature}: Pro must be capped`).not.toBeNull();
    }
  });

  // A superlative is a claim about every OTHER plan too, so it is checked
  // against every other plan — not just against Pro Plus's own number.
  it("Pro Plus's 'largest credit grant' claim is the matrix's strict maximum", async () => {
    // Presence half: Plus's real, live AI differentiator is the wallet size, so
    // the description has to carry it. Its absence is a fault, not a style.
    expect(plusDescription, "Pro Plus must state its AI credit differentiator").toMatch(
      /\bAI\s+credit/i,
    );
    if (!/\b(largest|biggest|most|highest|greatest)\b[^,.;]{0,40}credit/i.test(plusDescription)) {
      return;
    }
    const rows = await sql<{ plan_key: string; int_value: number | null }[]>`
      select plan_key, int_value from plan_entitlements
      where feature_key = 'ai.credits.monthly'`;
    expect(rows.length, "no monthly credit rows to compare against").toBeGreaterThan(1);
    const plusRow = rows.find((r) => r.plan_key === "pro_plus");
    expect(plusRow?.int_value, "pro_plus has no monthly credit row").toBeTypeOf("number");
    for (const row of rows) {
      if (row.plan_key === "pro_plus") continue;
      expect(
        plusRow!.int_value!,
        `"largest" is false: ${row.plan_key} grants ${row.int_value}`,
      ).toBeGreaterThan(row.int_value ?? Number.POSITIVE_INFINITY);
    }
  });

  // Every plan description quotes its group ceiling in prose. That number is
  // `orgs.max_owned`, and exceeding it is a PURCHASE (the extra-org add-on,
  // v17 #293) — so the figure is the included allowance, not a hard wall, and
  // it has to track the matrix row that decides when the add-on is offered.
  it("each plan quotes its own live organisation allowance", async () => {
    for (const plan of stripePlans.plans) {
      const quoted = /up\s+to\s+(\d+)\s+organisations?/i.exec(plan.product.description);
      expect(quoted, `${plan.key}: no organisation allowance in the copy`).not.toBeNull();
      expect(Number(quoted![1]), `${plan.key} organisation allowance`).toBe(
        await capFor("orgs.max_owned", plan.key),
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PROVING THE GUARDS — by REWORDING, not by reverting.
//
// The real seed is (and must stay) correct, so every assertion above passes
// whether or not the guard actually covers the claim. These point the same pure
// functions at the copy a future editor plausibly writes: the falsehood said a
// different way, and — for each presence rule — its inverse.
//
// Every case marked "fix round 1" is one that was MEASURED green against the
// first version of these guards. They are the evidence the widenings work, and
// they are why this block exists instead of a revert.
//
// Asserted with `toEqual([...])` on exact fault labels: "it returned something"
// would be satisfied by a guard firing for an unrelated reason.
// ─────────────────────────────────────────────────────────────────────────────
describe("the guards survive a rewording, not just a revert", () => {
  const M = "event_pass";

  it("catches the retired AI-run cap however it is phrased", () => {
    // The historical sentence…
    expect(retiredRunCapFaults("realtime and 10 AI schedule runs per division")).not.toEqual([]);
    // …and rewordings of the same claim, none of which contain it. The last
    // three were measured GREEN against the first version of this list.
    for (const reworded of [
      "AI-powered scheduling with 6 runs per competition",
      "includes 12 scheduling runs",
      "5 AI runs per division, included",
      "includes an allowance of AI schedule runs for each division", // fix round 1
      "AI scheduling: three runs a division", // fix round 1
      "a monthly quota of AI schedule generations per division", // fix round 1
    ]) {
      expect(retiredRunCapFaults(reworded), reworded).not.toEqual([]);
    }
    // …while the live, credit-metered story is not a false positive. "news
    // runs" in the credit packs is the phrase that makes a loose /runs?/ rule
    // unusable, so it is pinned here.
    for (const honest of [
      "40 AI credits (schedule / officials / news runs) for your organisation's shared wallet",
      "a one-time +25 AI credits added to your wallet",
      "AI-assisted scheduling, metered by your credit wallet",
      "One extra member seat for an organisation, billed monthly.",
    ]) {
      expect(retiredRunCapFaults(honest), honest).toEqual([]);
    }
  });

  it("catches unbounded-duration claims however they are phrased", () => {
    const bounded = "One-time upgrade for a single competition, while it's active: 10 divisions";
    expect(passDurationFaults([{ key: M, description: bounded }])).toEqual([]);

    for (const [label, reworded] of [
      ["the original", `${bounded.replace(", while it's active", "")} — for the event's lifetime`],
      ["a synonym", `${bounded} — yours forever`],
      ["another synonym", `${bounded} — a permanent upgrade`],
      ["a third", `${bounded} — it never expires`],
      ["a concessive", `${bounded} — it keeps working even after the competition finishes`],
      ["fix round 1 (as long as you want)", `${bounded} — it stays yours for as long as you want`],
      ["fix round 1 (does not lapse)", `${bounded}. The upgrade does not lapse.`],
      ["fix round 1 (yours to keep)", `${bounded} — once bought, it is yours to keep`],
    ] as const) {
      const faults = passDurationFaults([{ key: M, description: reworded }]);
      expect(faults, label).not.toEqual([]);
      expect(faults.join(" "), label).toContain("unbounded duration");
    }
  });

  // The other half of the same rule. An absence-shaped guard is happiest when
  // the claim is deleted outright — which tells the buyer nothing about when
  // the pass stops, and is exactly how "must mention add-ons" was satisfied by
  // copy saying they stop counting.
  it("catches the bound being DELETED, not just contradicted", () => {
    const silent = "One-time upgrade for a single competition: 10 divisions, 128 entrants";
    expect(passDurationFaults([{ key: M, description: silent }])).toEqual([
      `${M}: opening clause never states the pass is bounded to an active competition`,
    ]);
  });

  // …and it must not be satisfiable by the WRONG CLAUSE in the same sentence:
  // "active competitions" is a feature-list item, not a scope statement.
  it("is not satisfied by the word 'active' appearing further down the sentence", () => {
    const wrongClause =
      "One-time upgrade for a single competition: 10 active competitions, 128 entrants";
    expect(passDurationFaults([{ key: M, description: wrongClause }])).not.toEqual([]);
  });

  // fix round 1: the clause scoping was defeated by DROPPING THE COLON —
  // `split(":")[0]` then returns the whole description, so the feature list
  // answers for the scope statement. Measured: one character took the fixture
  // above from red to green.
  it("is not defeated by removing the colon that defines the clause", () => {
    const noColon =
      "One-time upgrade for a single competition — 10 active competitions, 128 entrants per division, advanced formats.";
    expect(passDurationFaults([{ key: M, description: noColon }])).toEqual([
      `${M}: no ":" separating the scope statement from the feature list — the bound cannot be scoped`,
    ]);
  });

  // fix round 1: wrong-clause satisfaction surviving INSIDE the scoped clause.
  // "active immediately" asserts an immediate start and no end at all, yet
  // satisfied a rule meant to assert a bound. The bound's grammar is required.
  it("requires the bound's grammar, not merely the word 'active'", () => {
    for (const unbounded of [
      "One-time upgrade for a single competition, active immediately: 10 divisions",
      "One-time upgrade for an active competition: 10 divisions",
    ]) {
      expect(passDurationFaults([{ key: M, description: unbounded }]), unbounded).toEqual([
        `${M}: opening clause never states the pass is bounded to an active competition`,
      ]);
    }
    // …and the genuine bound, in more than one phrasing, still passes.
    for (const bounded of [
      "One-time upgrade for a single competition, while it's active: 10 divisions",
      "One-time upgrade, for as long as the competition is active: 10 divisions",
      "One-time upgrade, until the competition is no longer active: 10 divisions",
    ]) {
      expect(passDurationFaults([{ key: M, description: bounded }]), bounded).toEqual([]);
    }
  });

  it("catches a missing, drifted, or recurring credit grant", () => {
    const honest = "…and a one-time +25 AI credits added to your wallet.";
    expect(passCreditGrantFaults([{ key: M, description: honest }])).toEqual([]);

    expect(passCreditGrantFaults([{ key: M, description: "…realtime scoreboard." }])).toEqual([
      `${M}: does not state the +25 AI credit grant`,
    ]);
    // Drift, and the rung-keyed grant PASS_CREDIT_GRANT must never become.
    expect(
      passCreditGrantFaults([{ key: M, description: "…and a one-time +50 AI credits." }]).join(" "),
    ).toContain("quotes 50 AI credits");
    // The inverse claim: right number, wrong cadence.
    expect(
      passCreditGrantFaults([
        { key: M, description: "…and +25 AI credits every month while it runs." },
      ]).join(" "),
    ).toContain("recurring");
  });

  it("catches one rung wearing the other's caps", () => {
    const caps: RungCaps[] = [
      { key: "event_pass", entrants: 128, divisions: 10 },
      { key: "event_pass_l", entrants: null, divisions: 20 },
    ];
    const honest: Rung[] = [
      { key: "event_pass", description: "10 divisions, 128 entrants per division" },
      { key: "event_pass_l", description: "20 divisions, unlimited entrants per division" },
    ];
    expect(capClaimFaults(honest, caps)).toEqual([]);

    // L sold with M's ceiling — the exact defect that made "an Event Pass caps
    // at 128" read as true for the product a buyer paid $59 to escape.
    expect(
      capClaimFaults(
        [{ key: "event_pass_l", description: "20 divisions, 128 entrants per division" }],
        caps,
      ),
    ).toEqual([
      "event_pass_l: entrant cap is unlimited but the copy never says so",
      'event_pass_l: quotes "128 entrants" for an unlimited cap',
      "event_pass_l: quotes event_pass's entrant cap (128)",
    ]);

    // A stale number that belongs to nobody.
    expect(
      capClaimFaults([{ key: "event_pass", description: "10 divisions, 64 entrants" }], caps).join(
        " ",
      ),
    ).toContain("does not quote its live entrant cap (128)");
  });

  it("catches a Pro Plus differentiator Pro already has, however it is phrased", () => {
    // The live matrix, as this file's DB tests read it: scheduling.ai is true
    // on EVERY plan, so it can never be a Pro Plus differentiator.
    const proGrants = {
      "scheduling.ai": true,
      "officials.auto": false,
      "api.write": false,
      "support.priority": false,
    };
    const plusGrants = {
      "scheduling.ai": true,
      "officials.auto": true,
      "api.write": true,
      "support.priority": true,
    };
    const honest =
      "Everything in Pro, plus automatic officials assignment, write API access and priority support. Covers up to 10 organisations.";
    expect(plusDifferentiatorFaults(honest, proGrants, plusGrants)).toEqual([]);

    for (const reworded of [
      "Everything in Pro, plus AI-assisted scheduling and priority support.",
      "Everything in Pro, plus AI-powered scheduling.",
      "Everything in Pro, plus AI schedule building.",
    ]) {
      expect(plusDifferentiatorFaults(reworded, proGrants, plusGrants), reworded).toContain(
        "pro_plus: sells scheduling.ai as a differentiator, but Pro already grants it",
      );
    }

    // A claim Pro Plus does not actually grant, caught from the other side.
    expect(
      plusDifferentiatorFaults("Everything in Pro, plus write API access.", proGrants, {
        ...plusGrants,
        "api.write": false,
      }),
    ).toEqual(["pro_plus: claims api.write, but Pro Plus does not grant it"]);

    // Dropping the frame disables the scope — a fault in itself.
    expect(
      plusDifferentiatorFaults("Now with AI-assisted scheduling.", proGrants, plusGrants),
    ).toEqual(['pro_plus: no "Everything in Pro, plus" frame — nothing to scope the claims to']);

    // fix round 1 — the positive backstop for an all-negative list: a reword
    // that keeps the frame but phrases every claim outside the vocabulary
    // would have the guard examine NOTHING and report clean.
    expect(
      plusDifferentiatorFaults(
        "Everything in Pro, plus a bigger allowance and nicer colours.",
        proGrants,
        plusGrants,
      ),
    ).toEqual([
      "pro_plus: names no recognised differentiator — the vocabulary has gone stale and this guard examined nothing",
    ]);
  });

  // N1. The claim and the arithmetic are checked against each other, so the
  // guard reds whichever of the two moves.
  it("ties the extra-organisation rate claim to the actual tier amounts", () => {
    // Every non-usd currency gets a SET point, because a MISSING one is its own
    // fault (the guard says so, and config/__tests__/stripe-plans.test.ts covers
    // it in depth) — supplying only one would drown the rate signal in three
    // "no price point" faults.
    const points = (amount: number) => ({ eur: amount, gbp: amount, inr: amount, aud: amount });
    const priced = (description: string, base: number, rider: number): PricedPlan[] => [
      {
        key: "pro",
        product: { description },
        prices: {
          monthly: {
            lookup_key: "seazn_pro_monthly",
            unit_amount: base,
            currency_options: points(base),
            tiers: [
              { up_to: 1, unit_amount: base, currency_options: points(base) },
              { up_to: "inf", unit_amount: rider, currency_options: points(rider) },
            ],
          },
        },
      },
    ];
    const AT_MOST = "each extra organisation costs no more than half the base rate.";

    // Shipped shape: rider below half, claim says "no more than half".
    expect(riderRateFaults(priced(AT_MOST, 1900, 900))).toEqual([]);
    // Exactly half is still within "no more than half" — this is the eur/aud
    // case on seazn_pro_monthly, which is why the copy cannot say "under".
    expect(riderRateFaults(priced(AT_MOST, 1800, 900))).toEqual([]);

    // The direction that overcharges against the copy.
    expect(riderRateFaults(priced(AT_MOST, 1900, 1000)).join(" ")).toContain("OVER half");

    // The wording this task replaced: a bare "half" with no qualifier is only
    // true where the rider is EXACTLY half, which it is not in usd.
    const BARE = "each extra organisation is half the base rate.";
    expect(riderRateFaults(priced(BARE, 1900, 900)).join(" ")).toContain("not exactly half");
    // …and "under half" is false wherever the halves land on whole units.
    const UNDER = "each extra organisation is a little under half the base rate.";
    expect(riderRateFaults(priced(UNDER, 1800, 900)).join(" ")).toContain(
      "exactly half, but the copy claims UNDER half",
    );
    // Saying nothing about the rate at all is a fault, not a pass.
    expect(riderRateFaults(priced("Covers up to 5 organisations.", 1900, 900))).toEqual([
      "pro: makes no statement about the extra-organisation rate",
    ]);
  });
});
