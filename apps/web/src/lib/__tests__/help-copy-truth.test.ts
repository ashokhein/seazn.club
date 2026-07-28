// Truth-in-copy guards for the BILLING HELP ARTICLES (v17 gap wave 7, task 3).
//
// Sibling of `plan-copy-truth.test.ts`, which points the same pure functions in
// `@/lib/copy-truth` at `stripe-plans.json`. Split rather than extended because
// the two surfaces need different scoping — a seed description is one product's
// claim, an article is a page of mixed claims about four plans — and because
// that file's own header says it is the application to the seed.
//
// LOCATION IS LOAD-BEARING: `src/lib/__tests__/`. CI's unit job has no
// DATABASE_URL and its Postgres steps select `src/server src/lib` and `src/app`
// (.github/workflows/ci.yml). From `src/__tests__/` the whole
// `describe.skipIf(!HAS_DB)` half would run in no job at all and report pending
// on a green exit 0.
//
// SCOPE — three sibling articles are deliberately NOT scanned here; see
// KNOWN_GAPS below. Each is a real defect with a real issue, and listing them
// as data rather than leaving them silently unscanned is the point.
import { afterAll, describe, expect, it } from "vitest";
import stripePlans from "@/config/stripe-plans.json";
import { sql } from "@/lib/db";
import { PASS_CREDIT_GRANT } from "@/lib/pricing-cards";
import {
  BOUNDED_SCOPE_GRAMMAR,
  FEE_LADDER_PLAN_KEYS,
  FEE_REVERSION_PATTERNS,
  feeLadderFaults,
  feeLadderRows,
  feeLockStatedFaults,
  markdownSection,
  plainProse,
  passBoundProseFaults,
  passCreditProseFaults,
  type PricedPlan,
  proseBlocks,
  retiredRunCapFaults,
  riderRateFaults,
  statesFeeLock,
  unqualifiedFeeReversionFaults,
} from "@/lib/copy-truth";
import { helpArticle } from "./_help-copy";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

/**
 * Articles this task fixed, and therefore scans.
 *
 * NOT a directory walk. `content/help/billing/downgrade.md` carries the SAME
 * unqualified fee-reversion claim these guards now ban, `scheduling/ai-scheduling.md`
 * still documents the retired per-division run cap, and both are out of scope
 * for this wave by decision, tracked on #303. A `readdirSync` here would red the
 * suite on other people's work; naming the gaps keeps them visible and makes
 * closing one a one-line move rather than a rediscovery.
 */
const KNOWN_GAPS = [
  "billing/downgrade.md:28 — 'the rate returns to 8%', same missing V312 qualifier (#303)",
  "scheduling/ai-scheduling.md — retired per-division run-cap table and hourly brake (#303)",
  "lib/pricing-cards.ts + e2e/pro-plus-tier.spec.ts — card bullets pinned verbatim (#303)",
];

const eventPass = helpArticle("event-pass");
const plans = helpArticle("plans");

/** The pass's own copy, and ONLY the pass's own copy. `plans.md` truthfully
 *  says Community is "free forever" two headings up; a permanence scan over the
 *  whole file would red on a true sentence. */
const plansPassSection = markdownSection(plans, /Event Pass/);
const feeLadderSection = markdownSection(plans, /platform fee/i);
const groupsSection = markdownSection(plans, /several organisations/i);

describe("billing help articles say what the resolver enforces", () => {
  it("names the gaps it does not cover, so an unscanned article is a decision", () => {
    expect(KNOWN_GAPS.length).toBeGreaterThan(0);
  });

  // The section extractors return null when a heading is renamed. Null must be
  // a fault, never a silently empty scan — `passBoundProseFaults("", ...)` on an
  // empty string would report clean.
  it("finds the sections every guard below scopes itself to", () => {
    expect(plansPassSection, "plans.md has no '## Event Pass' heading").not.toBeNull();
    expect(feeLadderSection, "plans.md has no platform-fee heading").not.toBeNull();
    expect(groupsSection, "plans.md has no billing-group heading").not.toBeNull();
    expect(proseBlocks(eventPass).length).toBeGreaterThan(20);
    expect(proseBlocks(plansPassSection!).length).toBeGreaterThan(2);
  });

  it("quotes no retired per-division AI-run cap", () => {
    expect(retiredRunCapFaults(eventPass), "event-pass.md").toEqual([]);
    expect(retiredRunCapFaults(plans), "plans.md").toEqual([]);
  });

  it("sells the Event Pass as bounded, and says what bounds it", () => {
    expect(passBoundProseFaults("event-pass.md", eventPass)).toEqual([]);
    expect(passBoundProseFaults("plans.md#event-pass", plansPassSection!)).toEqual([]);
  });

  it("states the one-time credit grant, at the right size, in both articles", () => {
    expect(passCreditProseFaults("event-pass.md", eventPass)).toEqual([]);
    expect(passCreditProseFaults("plans.md#event-pass", plansPassSection!)).toEqual([]);
  });

  // The V312 fee lock, both halves. `event-pass.md` claimed twice that the fee
  // "returns to your plan's rate" when the pass stops — false for any
  // competition that has taken a paid entry, which is every competition an
  // organiser is reading this page about.
  it("never says the entry-fee rate reverts without the first-paid-entry lock", () => {
    expect(unqualifiedFeeReversionFaults("event-pass.md", eventPass)).toEqual([]);
    expect(unqualifiedFeeReversionFaults("plans.md", plans)).toEqual([]);
  });

  // The extra-organisation rate, taken from the help article and judged against
  // the seed's real tier amounts by the SAME function that judges the Stripe
  // description (`riderRateFaults`, task 1). The claim and the arithmetic have
  // to come from different places or the comparison proves nothing.
  //
  // `plans.md` said "each one after that is half". At $19/$9 the rider is 47.4%
  // of Pro and at $39/$19 it is 48.7% of Pro Plus, so a bare "half" was false in
  // usd — while in eur and aud the halves land on whole units and it is exactly
  // half, which is why the wording is "no more than half" and not "under half".
  it("quotes an extra-organisation rate the seed's tiers actually charge", () => {
    const claimed = (stripePlans.plans as unknown as PricedPlan[]).map((plan) => ({
      ...plan,
      product: { description: plainProse(groupsSection!) },
    }));
    expect(riderRateFaults(claimed)).toEqual([]);

    // …and the two figures the sentence spells out are the seed's own usd
    // riders, so a price move cannot leave a stale dollar amount on the page.
    for (const plan of stripePlans.plans) {
      const rider = plan.prices.monthly.tiers.find((t) => t.up_to === "inf");
      expect(rider, `${plan.key} has no monthly rider tier`).toBeDefined();
      expect(plainProse(groupsSection!), `${plan.key}'s usd rider`).toContain(
        `$${rider!.unit_amount / 100}/month`,
      );
    }
  });

  it("states the lock, rather than merely omitting the false claim", () => {
    expect(feeLockStatedFaults("event-pass.md", eventPass)).toEqual([]);

    // ANTI-VACUITY, the backstop for an all-negative rule: the check above
    // would also pass on an article that simply never mentions the fee, and the
    // one above it would pass because there was nothing left to qualify. So a
    // block must still make the reversion claim AND carry its qualifier — that
    // is the paragraph a reader with an ending pass actually needs.
    const qualified = proseBlocks(eventPass).filter(
      (block) => FEE_REVERSION_PATTERNS.some((p) => p.test(block)) && statesFeeLock(block),
    );
    expect(
      qualified.length,
      "no block both states what happens to the rate and qualifies it — the guards above are passing on silence",
    ).toBeGreaterThan(0);
  });
});

describe.skipIf(!HAS_DB)("billing help articles quote the numbers the matrix enforces", () => {
  const capFor = async (feature: string, plan: string): Promise<number | null> => {
    const [row] = await sql<{ int_value: number | null }[]>`
      select int_value from plan_entitlements
      where plan_key = ${plan} and feature_key = ${feature}`;
    expect(row, `plan_entitlements has no ${plan}/${feature} row`).toBeDefined();
    return row!.int_value;
  };

  it("the fee ladder table is the fee the matrix charges, row for row", async () => {
    const live: Record<string, number | null> = {};
    for (const keys of Object.values(FEE_LADDER_PLAN_KEYS)) {
      for (const key of keys) live[key] = await capFor("registration.fee_percent", key);
    }
    const rows = feeLadderRows(feeLadderSection!);
    expect(rows.length, "no fee rows parsed — the table's shape changed").toBe(
      Object.keys(FEE_LADDER_PLAN_KEYS).length,
    );
    expect(feeLadderFaults(rows, live)).toEqual([]);
  });

  it("the Event Pass articles quote each rung's own live caps", async () => {
    const m = {
      entrants: await capFor("entrants.per_division.max", "event_pass"),
      divisions: await capFor("divisions.per_competition.max", "event_pass"),
    };
    const l = {
      entrants: await capFor("entrants.per_division.max", "event_pass_l"),
      divisions: await capFor("divisions.per_competition.max", "event_pass_l"),
    };
    expect(l.entrants, "L's entrant cap is unlimited — the copy says so in words").toBeNull();

    for (const [label, text] of [
      ["event-pass.md", eventPass],
      ["plans.md#event-pass", plansPassSection!],
    ] as const) {
      expect(text, `${label}: M's entrant cap`).toContain(`${m.entrants} entrants`);
      expect(text, `${label}: M's division cap`).toContain(`${m.divisions} divisions`);
      expect(text, `${label}: L's division cap`).toContain(`${l.divisions} divisions`);
      expect(text, `${label}: L is unlimited`).toMatch(/\bunlimited\s+entrants\b/i);
    }
  });

  // A cross-plan claim is a claim about the OTHER plan's matrix row too. Both
  // parenthetical comparisons in `event-pass.md` are read in order, so a drifted
  // Community cap cannot hide behind the pass's own numbers being right.
  it("the 'Community allows N' comparisons are Community's live caps", async () => {
    const quoted = [...eventPass.matchAll(/Community allows (\d+)/g)].map((m) => Number(m[1]));
    expect(quoted, "the comparisons were reworded — re-point this guard").toHaveLength(2);
    expect(quoted).toEqual([
      await capFor("entrants.per_division.max", "community"),
      await capFor("divisions.per_competition.max", "community"),
    ]);
  });

  it("every monthly AI credit figure in plans.md is that plan's live grant", async () => {
    for (const key of ["community", "pro", "pro_plus"]) {
      const live = await capFor("ai.credits.monthly", key);
      expect(plans, `${key}'s monthly grant`).toContain(`${live} AI credits a month`);
    }
    // …and the pass's grant is the one-time constant, not a monthly row.
    for (const key of ["event_pass", "event_pass_l"]) {
      const [row] = await sql<{ int_value: number | null }[]>`
        select int_value from plan_entitlements
        where plan_key = ${key} and feature_key = 'ai.credits.monthly'`;
      expect(row, `${key} must have no monthly credit row`).toBeUndefined();
    }
    expect(PASS_CREDIT_GRANT).toBe(25);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PROVING THE GUARDS — by REWORDING, not by reverting.
//
// The articles are (and must stay) correct, so every assertion above passes
// whether or not the guard covers the claim. These point the same pure functions
// at the copy a future editor plausibly writes instead: the falsehood said a
// different way, and — for each presence rule — its inverse and its deletion.
//
// Restoring the exact sentence this task removed is NOT proof. That is what let
// two guards ship green in wave 6.
// ─────────────────────────────────────────────────────────────────────────────
describe("the help-prose guards survive a rewording, not just a revert", () => {
  const LOCKED =
    "Once a competition has taken its first paid entry the platform fee it charges is locked for the rest of that competition.";

  it("catches the fee-reversion claim however it is phrased", () => {
    for (const reworded of [
      // The two sentences this task removed…
      "the realtime board and sponsor tools stop, and the platform fee returns to your plan's rate.",
      "the sponsor tools simply switch off and the platform fee returns to your plan's rate, exactly like a downgrade.",
      // …and the same claim, none of which contain those words.
      "When the pass ends your entry-fee rate goes back to 8%.",
      "The platform fee reverts to whatever your plan charges.",
      "Community's 8% applies again to every later entrant.",
      "Expect the fee to rise back to your plan's percentage once the event closes.",
      "After that, the 5% you were enjoying resets to the plan rate.",
      "The fee rate simply moves to your plan's own rate.",
    ]) {
      expect(unqualifiedFeeReversionFaults("x", reworded), reworded).not.toEqual([]);
    }
  });

  it("accepts the same claim once it carries the lock, in the same block", () => {
    const claim = "When the pass ends the entry-fee rate goes back to your plan's rate.";
    expect(unqualifiedFeeReversionFaults("x", claim), "unqualified").not.toEqual([]);
    expect(unqualifiedFeeReversionFaults("x", `${claim} ${LOCKED}`), "qualified").toEqual([]);
  });

  // The scoping that makes the rule mean anything: a qualifier in a DIFFERENT
  // bullet does not qualify this bullet's claim. Without block scoping,
  // `event-pass.md`'s eleven-bullet fine print would let one lock sentence
  // license a false claim eight bullets away.
  it("is not satisfied by the lock sitting in a different block", () => {
    const article = `- ${LOCKED}\n- When the pass ends the platform fee returns to your plan's rate.`;
    expect(unqualifiedFeeReversionFaults("x", article)).not.toEqual([]);
    // …and the two halves in ONE bullet is the shape that passes.
    expect(
      unqualifiedFeeReversionFaults(
        "x",
        `- When the pass ends the platform fee returns to your plan's rate. ${LOCKED}`,
      ),
    ).toEqual([]);
  });

  // The other half. An absence-shaped rule is happiest when the claim is
  // DELETED — which leaves an organiser knowing nothing about the rate their
  // entrants pay after the pass ends.
  it("catches the lock being deleted, not just contradicted", () => {
    expect(feeLockStatedFaults("x", "The pass gives you a 5% platform fee while it runs.")).toEqual(
      ["x: never states that the entry-fee rate locks at the first paid entry (V312)"],
    );
    expect(feeLockStatedFaults("x", LOCKED)).toEqual([]);
  });

  // …and a lock word with no trigger is not a statement of the lock: it tells a
  // reader a rate is fixed without saying what fixes it, so nobody can tell
  // whether their own competition is locked.
  it("requires the trigger, not merely the word 'locked'", () => {
    expect(statesFeeLock("Your platform fee is locked for the rest of the competition.")).toBe(
      false,
    );
    expect(statesFeeLock("Refunds before the refund lock date return the first paid entry.")).toBe(
      false,
    );
    expect(statesFeeLock(LOCKED)).toBe(true);
  });

  it("catches the retired AI-run cap in prose, including the unit-noun-first form", () => {
    for (const reworded of [
      "AI Schedule runs on every plan. There is no per-division run cap any more.",
      "Community gets 5 AI schedule runs per division.",
      "each division gets its own AI schedule generations", // fix round 2
      "every competition comes with its own allowance of scheduling runs", // fix round 2
    ]) {
      expect(retiredRunCapFaults(reworded), reworded).not.toEqual([]);
    }
    // The live, credit-metered story, and the ordinary prose around it, are not
    // false positives. Every one of these is a real sentence in the two articles.
    for (const honest of [
      "AI Schedule runs on every plan, including Community.",
      "An Event Pass upgrades one competition while it runs.",
      "a Community org keeps all 10 free slots while its passed event runs",
      "Every organisation in the group runs on the group's plan.",
      "For the competition it covers, and every division inside it",
      "your organisation gets 10 AI credits a month to spend on AI scheduling and officials",
    ]) {
      expect(retiredRunCapFaults(honest), honest).toEqual([]);
    }
  });

  it("catches an unbounded pass claim in prose, and the bound being dropped", () => {
    const bounded = "An Event Pass upgrades one competition while it runs — bigger limits.";
    expect(passBoundProseFaults("x", bounded)).toEqual([]);

    for (const [label, reworded] of [
      ["the original", "One-time upgrade for a single competition, for that event's lifetime."],
      ["a synonym", `${bounded} It is yours forever.`],
      ["a third", `${bounded} The upgrade never expires.`],
      ["fix round 2 (hyphenated)", `${bounded} A never-ending upgrade.`],
      ["fix round 2 (participle)", `${bounded} It is never ending.`],
    ] as const) {
      expect(passBoundProseFaults("x", reworded), label).not.toEqual([]);
    }

    // Deletion, and wrong-clause satisfaction inside the opening paragraph.
    for (const silent of [
      "An Event Pass upgrades one competition — bigger limits and a cheaper fee.",
      "An Event Pass upgrades an active competition.",
      "An Event Pass is active immediately on one competition.",
    ]) {
      expect(passBoundProseFaults("x", silent), silent).toEqual([
        "x: the opening paragraph never states the pass is bounded to a running competition",
      ]);
    }
    // An empty section (a renamed heading, a deleted body) is a fault, never a
    // clean scan.
    expect(passBoundProseFaults("x", "")).toEqual([
      "x: no prose to scan — the section is empty or its heading moved",
    ]);
  });

  // fix round 2: the bound's window was 30 characters and rejected TRUE copy.
  // Both of these are sentences an editor writes; both read as "never states the
  // pass is bounded" before the widening.
  it("does not reject a true bound that spends a few more words saying it", () => {
    for (const bounded of [
      "The pass lifts the plan until the competition is archived or no longer active: more entrants.",
      "One-time upgrade, for as long as the competition it covers is still open: more entrants.",
    ]) {
      expect(BOUNDED_SCOPE_GRAMMAR.test(bounded), bounded).toBe(true);
    }
    // …while the conjunction must still GOVERN the activity word.
    expect(
      BOUNDED_SCOPE_GRAMMAR.test("Buy it during checkout. Your competitions stay active."),
    ).toBe(false);
  });

  it("catches a drifted, missing or recurring credit grant in prose", () => {
    const honest = "- A one-time top-up of 25 AI credits, added to your wallet when you buy.";
    expect(passCreditProseFaults("x", honest)).toEqual([]);
    // The table form, where the number sits on the other side of the noun.
    expect(passCreditProseFaults("x", "| AI credits | +25, one-time | +25, one-time |")).toEqual([]);

    expect(passCreditProseFaults("x", "- A one-time top-up of 40 AI credits.").join(" ")).toContain(
      `quotes 40 AI credits, but the pass grants ${PASS_CREDIT_GRANT}`,
    );
    expect(passCreditProseFaults("x", "| AI credits | +50, one-time |").join(" ")).toContain(
      "quotes 50 AI credits",
    );
    // The inverse claim: right number, wrong cadence.
    expect(passCreditProseFaults("x", "- 25 AI credits a month, once you buy.").join(" ")).toContain(
      "sells the one-time grant as recurring",
    );
    // Right number, no cadence at all — a reader cannot tell it does not repeat.
    expect(passCreditProseFaults("x", "- The pass adds 25 AI credits.").join(" ")).toContain(
      "without saying it is one-time",
    );
    // Deletion.
    expect(passCreditProseFaults("x", "- Branded exports and sponsor tiers.")).toEqual([
      `x: never states the one-time +${PASS_CREDIT_GRANT} AI credit grant`,
    ]);
  });

  it("catches a fee-ladder row that drifts from the matrix, and one that vanishes", () => {
    const live = { community: 8, event_pass: 5, event_pass_l: 5, pro: 2, pro_plus: 1 };
    const table = [
      "| Plan | Platform fee |",
      "| --- | --- |",
      "| Community | 8% |",
      "| Event Pass | 5% |",
      "| Pro | 2% |",
      "| Pro Plus | 1% |",
    ].join("\n");
    expect(feeLadderFaults(feeLadderRows(table), live)).toEqual([]);

    // A rate the matrix does not charge.
    expect(
      feeLadderFaults(feeLadderRows(table.replace("| Pro | 2% |", "| Pro | 3% |")), live).join(" "),
    ).toContain('"Pro" quotes 3%, but pro enforces 2%');
    // One rung moving is a fault even though the other rung still matches.
    expect(feeLadderFaults(feeLadderRows(table), { ...live, event_pass_l: 4 }).join(" ")).toContain(
      "event_pass_l enforces 4%",
    );
    // A dropped row reads as "that plan has no platform fee".
    expect(
      feeLadderFaults(feeLadderRows(table.replace("| Event Pass | 5% |\n", "")), live),
    ).toEqual(["fee ladder: no row for Event Pass"]);
    // …and an empty table is not a clean scan.
    expect(feeLadderFaults(feeLadderRows("no table here"), live)).toHaveLength(
      Object.keys(FEE_LADDER_PLAN_KEYS).length,
    );
  });
});
