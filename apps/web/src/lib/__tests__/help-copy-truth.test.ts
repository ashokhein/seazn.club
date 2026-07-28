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
  mentionsRateAfterPass,
  feeLadderFaults,
  feeLadderRows,
  DURATION_ALLOWLIST,
  FEE_RATE_ALLOWLIST,
  approvedFormsExercised,
  feeLockStatedFaults,
  goldenParagraphFaults,
  inventoryFaults,
  unapprovedClaimFaults,
  lockedRateConstantFaults,
  markdownSection,
  plainProse,
  passBoundProseFaults,
  passCreditProseFaults,
  type PricedPlan,
  proseBlocks,
  sentences,
  retiredRunCapProseFaults,
  riderRateFaults,
  statesFeeLock,
  unqualifiedFeeReversionFaults,
} from "@/lib/copy-truth";
import { helpArticle } from "./_help-copy";
import {
  APPROVED_EVENT_PASS,
  APPROVED_EVENT_PASS_INVENTORY,
  APPROVED_PLANS_PASS,
  APPROVED_PLANS_INVENTORY,
} from "./_approved-copy";

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

/** The paragraphs the GATE pins word for word. The allowlists skip them: the
 *  gate permits exactly one wording, which is stricter than any set of forms. */
const GATED = [...APPROVED_EVENT_PASS, ...APPROVED_PLANS_PASS].map((p) => p.text);

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

  // ── THE GATE (fix round 2) ────────────────────────────────────────────────
  // Every generalising rule in this file has now been beaten by a reword — three
  // rounds, three denylists, measured 1/12 then 0/12 by people who did not write
  // them. These four paragraphs are pinned word for word instead. There is no
  // phrasing that evades this, because it is not looking at phrasing.
  // The PRIMARY gate. Measured, after the allowlist below was final: a fresh
  // adversarial set scored 6/30 while the reviewer's own set — which the rules
  // had been tuned against — scored 12/12. Four rounds of lexical rules, four
  // demonstrations that they score well only on the examples they were written
  // for. This one does not read the words at all: the pass's copy either is the
  // copy that was approved, or it is not.
  it("the pass's copy is the copy that was approved, paragraph for paragraph", () => {
    expect(inventoryFaults("event-pass.md", eventPass, APPROVED_EVENT_PASS_INVENTORY)).toEqual([]);
    expect(
      inventoryFaults("plans.md", plans, APPROVED_PLANS_INVENTORY),
    ).toEqual([]);
  });

  it("the approved paragraphs still say exactly what was approved", () => {
    expect(goldenParagraphFaults("event-pass.md", eventPass, APPROVED_EVENT_PASS)).toEqual([]);
    expect(
      goldenParagraphFaults("plans.md#event-pass", plansPassSection!, APPROVED_PLANS_PASS),
    ).toEqual([]);
  });

  // ── THE ALLOWLIST (fix round 2) ───────────────────────────────────────────
  // The gate covers four paragraphs; this covers every OTHER sentence in the
  // pass's copy, which is where a new falsehood gets added. A sentence making
  // either claim must match an approved FORM — so a wording nobody predicted
  // fails by default instead of passing by default.
  it("makes every pass-duration claim in an approved form", () => {
    expect(unapprovedClaimFaults("event-pass.md", eventPass, DURATION_ALLOWLIST, GATED)).toEqual([]);
    expect(
      unapprovedClaimFaults("plans.md#event-pass", plansPassSection!, DURATION_ALLOWLIST, GATED),
    ).toEqual([]);
  });

  it("makes every entry-fee-rate claim in an approved form", () => {
    expect(unapprovedClaimFaults("event-pass.md", eventPass, FEE_RATE_ALLOWLIST, GATED)).toEqual([]);
    expect(unapprovedClaimFaults("plans.md", plans, FEE_RATE_ALLOWLIST, GATED)).toEqual([]);
  });

  // ANTI-VACUITY for the allowlists. A `classifies` list that drifts narrow
  // sweeps nothing in, every sentence passes, and the rule reports clean while
  // examining nothing — this wave's most repeated failure. If the real articles
  // stop exercising an approved form, either the copy or the form is dead.
  it("exercises the approved forms it offers, rather than sweeping nothing in", () => {
    const duration = approvedFormsExercised(eventPass, DURATION_ALLOWLIST);
    const fee = approvedFormsExercised(eventPass, FEE_RATE_ALLOWLIST);
    expect(duration.length, "no duration sentence was classified at all").toBeGreaterThan(1);
    expect(fee.length, "no fee-rate sentence was classified at all").toBeGreaterThan(0);
  });

  it("quotes no retired per-division AI-run cap", () => {
    expect(retiredRunCapProseFaults("event-pass.md", eventPass)).toEqual([]);
    expect(retiredRunCapProseFaults("plans.md", plans)).toEqual([]);
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

  // Fix round 1, critical 2: round 1 shipped "a late entrant pays the same 5%
  // as the first one". The lock records what the FIRST PAID CARD ENTRY was
  // charged, so a competition that took one before its pass was bought is
  // locked at the pre-pass rate and the pass cannot lower it.
  it("never names a constant percentage as the locked rate", () => {
    expect(lockedRateConstantFaults("event-pass.md", eventPass)).toEqual([]);
    expect(lockedRateConstantFaults("plans.md#event-pass", plansPassSection!)).toEqual([]);
  });

  it("states the lock, rather than merely omitting the false claim", () => {
    expect(feeLockStatedFaults("event-pass.md", eventPass)).toEqual([]);

    // ANTI-VACUITY, the backstop for an all-negative rule: the check above
    // would also pass on an article that simply never mentions the fee, and the
    // one above it would pass because there was nothing left to qualify. So a
    // block must still make the reversion claim AND carry its qualifier — that
    // is the paragraph a reader with an ending pass actually needs.
    const qualified = proseBlocks(eventPass)
      .flatMap((block) => sentences(block))
      .filter((sentence) => mentionsRateAfterPass(sentence) && statesFeeLock(sentence));
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

  // ── FIX ROUND 1: the mutations that beat the round-1 guards ───────────────
  // Both were made by ADDING a false sentence and KEEPING every true one, so
  // the positive halves stayed satisfied and only the negative had to fail —
  // which it did, because a list of falsehoods is an open set. These two are
  // the reviewer's own; the ten below are new ones neither guard was written
  // against.
  it("catches a false sentence ADDED beside the true one — fee", () => {
    const added =
      "After the event closes, later entrants are charged 8% again, and the 5% you were enjoying no longer applies.";
    expect(unqualifiedFeeReversionFaults("x", added), "the reviewer's mutation").not.toEqual([]);
    // …and in situ: appended to the real article, with every true sentence left
    // in place, exactly as it was mutated.
    expect(unqualifiedFeeReversionFaults("event-pass.md", `${eventPass}\n\n${added}\n`)).not.toEqual(
      [],
    );
  });

  it("catches a false sentence ADDED beside the true one — duration", () => {
    const added = "The pass has no end date and applies for the life of the event.";
    expect(passBoundProseFaults("x", `An Event Pass upgrades one competition while it runs.\n\n${added}`))
      .not.toEqual([]);
    expect(
      passBoundProseFaults("plans.md#event-pass", `${plansPassSection!}\n\n${added}\n`),
    ).not.toEqual([]);
  });

  // Five NEW rewordings of each falsehood, written to defeat the rule rather
  // than to confirm it. None appears in any pattern list.
  it("catches five fee rewordings the rule was not written against", () => {
    for (const reworded of [
      "Once the competition is over, entrants pay whatever your plan charges.",
      "When your pass lapses the cheaper rate stops and Community pricing takes over.",
      "After the pass expires we keep our usual 8% on every remaining entry.",
      "Refunding the pass puts the competition back on its plan pricing, fee included.",
      "The discount on entry fees only lasts while the pass does; after that it is gone.",
    ]) {
      expect(unqualifiedFeeReversionFaults("x", reworded), reworded).not.toEqual([]);
    }
  });

  it("catches five duration rewordings the rule was not written against", () => {
    for (const reworded of [
      "An Event Pass upgrades one competition while it runs. Once bought there is no cut-off date.",
      "An Event Pass upgrades one competition while it runs. The upgrade cannot expire.",
      "An Event Pass upgrades one competition while it runs. It stays in force even after the final.",
      "An Event Pass upgrades one competition while it runs. The pass applies for its whole life.",
      "An Event Pass upgrades one competition while it runs. Your competition keeps it in perpetuity.",
    ]) {
      expect(passBoundProseFaults("x", reworded), reworded).not.toEqual([]);
    }
  });

  // Critical 2's guard, proved the same way.
  it("catches a constant percentage sold as the locked rate", () => {
    for (const reworded of [
      // The exact sentence round 1 shipped.
      "Once a competition has taken its first paid entry, the platform fee is locked for the rest of it — a late entrant pays the same 5% as the first one.",
      "Your competition's fee is fixed at 5% for good once entries open.",
      "The locked rate is 5%, whatever happens to your plan.",
      "Buy a pass and the 5% stays locked in for every entry after it.",
      "Its platform fee is frozen at 5% from the first payment onwards.",
    ]) {
      expect(lockedRateConstantFaults("x", reworded), reworded).not.toEqual([]);
    }
    // …while attributing the locked rate to its SOURCE, with no number, passes.
    expect(
      lockedRateConstantFaults(
        "x",
        "Its platform fee stays locked at the rate the first payer was charged.",
      ),
    ).toEqual([]);
  });

  // The Minor: an accurate DENIAL of the retired cap must be writable.
  it("lets prose say the retired cap is gone, but not quote one", () => {
    expect(
      retiredRunCapProseFaults("x", "There is no per-division run cap any more."),
      "a true denial",
    ).toEqual([]);
    expect(
      retiredRunCapProseFaults("x", "There is no per-division run cap beyond 20 runs a division."),
      "a denial with a number in it is still a cap",
    ).not.toEqual([]);
    expect(
      retiredRunCapProseFaults("x", "Community gets 5 AI schedule runs per division."),
    ).not.toEqual([]);
  });

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

  // FIX ROUND 1 (Minor): the claim was matched block-wide while the excuse was
  // matched sentence-wide, so a true qualifier ANYWHERE in the block excused a
  // false claim beside it. Both are sentence-scoped now, and this is the test
  // that says so: the same two sentences pass or fail on whether the ONE
  // sentence making the claim also carries the lock.
  it("requires the lock in the SAME SENTENCE as the claim, not merely nearby", () => {
    const claim = "When the pass ends the entry-fee rate goes back to your plan's rate.";
    expect(unqualifiedFeeReversionFaults("x", claim), "unqualified").not.toEqual([]);
    // The lock in the next sentence of the same paragraph does NOT excuse it —
    // this exact shape passed in round 1.
    expect(unqualifiedFeeReversionFaults("x", `${claim} ${LOCKED}`), "next sentence").not.toEqual(
      [],
    );
    // Only the claim and its qualifier in one sentence passes.
    expect(
      unqualifiedFeeReversionFaults(
        "x",
        "When the pass ends, a competition that has taken its first paid card entry keeps the platform fee locked at what that entrant was charged.",
      ),
      "one sentence",
    ).toEqual([]);
  });

  it("is not satisfied by the lock sitting in a different block either", () => {
    const article = `- ${LOCKED}\n- When the pass ends the platform fee returns to your plan's rate.`;
    expect(unqualifiedFeeReversionFaults("x", article)).not.toEqual([]);
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
      "Community gets 5 AI schedule runs per division.",
      "each division gets its own AI schedule generations", // fix round 2
      "every competition comes with its own allowance of scheduling runs", // fix round 2
      "5 schedule runs for every division", // fix round 1: `every` was missing
      "the AI console allows 20 generations for each competition",
    ]) {
      expect(retiredRunCapProseFaults("x", reworded), reworded).not.toEqual([]);
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
      expect(retiredRunCapProseFaults("x", honest), honest).toEqual([]);
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
  // FIX ROUND 1: the rule was `conjunction … {0,N} … activity word`, and both
  // values of N shipped a bug — 30 rejected true copy, 60 accepted copy with no
  // bound at all (3 of 3, measured). A distance cannot tell GOVERNING from
  // ADJACENT. The relation is now clause membership, and this table is the
  // evidence: seven true bounds and seven sentences where the two words are
  // near each other and the conjunction governs nothing.
  //
  // This is a SHARED dependency — task 4's four locale `bounded` rules are
  // built from the same `boundedScopeGrammarSource`, so a regression here is a
  // regression in es/fr/nl too.
  it("distinguishes a governing conjunction from a merely adjacent one", () => {
    for (const bounded of [
      "The pass lifts the plan until the competition is archived or no longer active: more entrants.",
      "One-time upgrade, for as long as the competition it covers is still open: more entrants.",
      "while it's active",
      "while that competition is still running",
      "An Event Pass upgrades one competition while it runs",
      "One-time upgrade, until the competition is no longer active",
      "the pass applies while the event is still open",
    ]) {
      expect(BOUNDED_SCOPE_GRAMMAR.test(bounded), `false red: ${bounded}`).toBe(true);
    }
    for (const unbounded of [
      // A new subject after a coordinator starts a new clause: the conjunction
      // is not governing "active" at all. All of these passed at {0,60}.
      "Buy it during the summer and your competition stays active.",
      "During checkout your card is charged and the pass is active",
      "You can buy while browsing the pricing page; your competition becomes active at once",
      "while you wait, the competition is not yet active",
      "Buy it during checkout. Your competitions stay active.",
      // …and no conjunction at all is still no bound.
      "One-time upgrade for a single competition, active immediately",
      "One-time upgrade for an active competition",
    ]) {
      expect(BOUNDED_SCOPE_GRAMMAR.test(unbounded), `false green: ${unbounded}`).toBe(false);
    }
  });

  // ANTI-VACUITY for rule 3. Rule 1 (the extent forms) would carry almost every
  // fixture above on its own, so a dead rule 3 would go unnoticed — and did:
  // a stray control character left `DURATION_CLAIM` matching nothing while this
  // suite stayed green. This asserts rule 3 fires where NO extent form does.
  it("faults an unbounded duration claim that matches no extent form", () => {
    const opening = "An Event Pass upgrades one competition while it runs.";
    const faults = passBoundProseFaults("x", `${opening} It applies for the entire duration and beyond.`);
    expect(
      faults.filter((f) => f.includes("without bounding it")),
      "rule 3 did nothing — DURATION_CLAIM may be dead",
    ).not.toEqual([]);
    expect(
      faults.filter((f) => f.includes("unbounded extent")),
      "an extent form fired, so this fixture proves nothing about rule 3",
    ).toEqual([]);
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

// ─────────────────────────────────────────────────────────────────────────────
// THE REGRESSION SET, AND WHY THE GATE EXISTS.
//
// Four rounds of this wave defended this copy with lexical rules. Every round
// scored well against the examples it was written for and badly against the
// next ones — measured, each time by someone who did not write the rules:
//
//   round 1   topic + verb vocabulary      fee 1/12, permanence 1/11
//   round 2   "closed set of forms"        fee 0/12, permanence 0/12, rate 0/4
//   round 3   allowlist of approved forms  reviewer's set 12/12, fresh set 6/30
//
// That last pair is the whole argument. Same author, same day, same rules: 12/12
// on the set the rules had been tuned against and 6/30 on a set written
// afterwards. Tuning is not convergence.
//
// The inventory gate takes the rates to 30/30 and 15/15 on those same two sets,
// because it does not read the sentence. Everything below is kept as a
// regression set so the lexical layer cannot silently rot, but the gate is what
// is actually load-bearing.
// ─────────────────────────────────────────────────────────────────────────────
describe("an added falsehood fails whatever it says", () => {
  const GATE_INPUTS = [...APPROVED_EVENT_PASS.map((p) => p.text)];

  /** Every guard, over the real article with one sentence ADDED — the shape all
   *  four lexical rounds missed. */
  const detects = (added: string): boolean => {
    const mutated = `${eventPass}\n\n${added}\n`;
    return (
      inventoryFaults("x", mutated, APPROVED_EVENT_PASS_INVENTORY).length > 0 ||
      goldenParagraphFaults("x", mutated, APPROVED_EVENT_PASS).length > 0 ||
      unapprovedClaimFaults("x", mutated, DURATION_ALLOWLIST, GATE_INPUTS).length > 0 ||
      unapprovedClaimFaults("x", mutated, FEE_RATE_ALLOWLIST, GATE_INPUTS).length > 0 ||
      passBoundProseFaults("x", mutated).length > 0 ||
      unqualifiedFeeReversionFaults("x", mutated).length > 0 ||
      lockedRateConstantFaults("x", mutated).length > 0
    );
  };

  // The reviewer's own rewordings, which beat round 3's allowlist.
  it("catches the two sentences that beat the previous round", () => {
    for (const added of [
      "Once bought, the upgrade is yours from then on and your competition never loses it.",
      "Once the trophy is handed out, entry costs return to normal and later entrants cost you more per head.",
    ]) {
      expect(detects(added), added).toBe(true);
    }
  });

  // A sample of the two fresh adversarial sets, chosen because NONE of them
  // shares vocabulary with any rule in this module — which is exactly why they
  // scored 6/30 before the gate and 30/30 after it.
  it("catches rewordings that share no vocabulary with any rule here", () => {
    for (const added of [
      "The upgrade outlives the event.",
      "A passed competition is passed for keeps.",
      "Whatever the season does, the upgrade abides.",
      "Sign-ups arriving after the closing whistle are charged the plan's percentage.",
      "Once the fixtures are done we go back to taking a bigger share of each entry.",
      "The competition is billed at the pass's number for every single entrant.",
      "Consider the upgrade banked.",
      "No calendar governs an Event Pass.",
    ]) {
      expect(detects(added), added).toBe(true);
    }
  });

  // …and the other two ways copy goes wrong, which a per-paragraph fixture alone
  // would miss: a falsehood edited INTO an existing paragraph, and a true
  // paragraph quietly deleted.
  it("catches an edit inside an existing paragraph, and a deletion", () => {
    const edited = eventPass.replace(
      "It does **not** carry to next season's edition",
      "It **does** carry to next season's edition",
    );
    expect(edited, "the anchor moved — re-point this test").not.toBe(eventPass);
    expect(inventoryFaults("x", edited, APPROVED_EVENT_PASS_INVENTORY)).not.toEqual([]);

    const deleted = eventPass.replace(
      "- The pass covers **that competition only**, while it runs.\n",
      "",
    );
    expect(deleted).not.toBe(eventPass);
    expect(inventoryFaults("x", deleted, APPROVED_EVENT_PASS_INVENTORY)).not.toEqual([]);
  });

  // The gate must fail LOUDLY. A hex digest with no prose is a gate people route
  // around, and this one will fire on every legitimate copy edit.
  it("explains itself when it fires", () => {
    const [fault] = inventoryFaults(
      "event-pass.md",
      `${eventPass}\n\nSomething new.\n`,
      APPROVED_EVENT_PASS_INVENTORY,
    );
    expect(fault).toContain("THIS TEST IS A GATE, NOT A BUG");
    expect(fault).toContain("_approved-copy.ts");
    expect(fault).toContain("registrations.ts");
    expect(fault, "the on-disk text must be printed, not just its digest").toContain("Something new.");
  });

  // The reviewer's Important-1 set: sentences with no bound at all, which the
  // character-window versions of this rule accepted 5 out of 6 times.
  it("reads none of these as a statement that the pass is bounded", () => {
    for (const unbounded of [
      "During checkout your Event Pass becomes active.",
      "Until now nobody could keep a competition active without Pro.",
      "While browsing the pricing page you can keep every competition active.",
      "During the summer your competition stays open.",
      "Buy during checkout to make your competition live.",
    ]) {
      expect(BOUNDED_SCOPE_GRAMMAR.test(unbounded), unbounded).toBe(false);
    }
    // …so an article whose only candidate bound is one of them states no bound.
    expect(
      passBoundProseFaults(
        "x",
        "During checkout your Event Pass becomes active. It is a one-time upgrade for a single competition.",
      ),
    ).not.toEqual([]);
  });

  // Important 2's residual.
  it("catches the two run-cap phrasings that were still missing", () => {
    for (const quoted of [
      "AI scheduling is limited to 5 attempts per division.",
      "Each division may be scheduled by AI up to 20 times.",
    ]) {
      expect(retiredRunCapProseFaults("x", quoted), quoted).not.toEqual([]);
    }
  });

  // …and the locked-rate rule, no longer keyed on a literal `%`.
  it("catches a rate named by brand or spelled out, not just as a figure", () => {
    for (const named of [
      "Its platform fee drops to the pass rate for every remaining entry.",
      "After that it stays at the Event Pass rate.",
      "The locked rate is five per cent, whatever happens to your plan.",
      "Your competition is pinned to the pass's cheaper rate.",
    ]) {
      expect(lockedRateConstantFaults("x", named), named).not.toEqual([]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FIX ROUND 3 — the surfaces the gate did not reach, and the honest rate.
// ─────────────────────────────────────────────────────────────────────────────
describe("every surface a reader sees is covered, not just the paragraphs", () => {
  const GATE_INPUTS = APPROVED_EVENT_PASS.map((p) => p.text);
  const detects = (mutated: string): boolean =>
    inventoryFaults("x", mutated, APPROVED_EVENT_PASS_INVENTORY).length > 0 ||
    goldenParagraphFaults("x", mutated, APPROVED_EVENT_PASS).length > 0 ||
    unapprovedClaimFaults("x", mutated, DURATION_ALLOWLIST, GATE_INPUTS).length > 0 ||
    unapprovedClaimFaults("x", mutated, FEE_RATE_ALLOWLIST, GATE_INPUTS).length > 0 ||
    passBoundProseFaults("x", mutated).length > 0 ||
    unqualifiedFeeReversionFaults("x", mutated).length > 0 ||
    lockedRateConstantFaults("x", mutated).length > 0;

  // `description` is rendered as the lead paragraph under the title
  // (app/help/[...slug]/page.tsx), emitted as page metadata, and shown as the
  // search-result snippet (help-search.tsx). It was unscanned by every rule in
  // the module: measured 0/24 before this, 12/12 after.
  it("catches a falsehood delivered through frontmatter", () => {
    for (const description of [
      "Buy once and the upgrade is yours for the lifetime of the event, with every entrant held at the cheaper rate.",
      "A one-time upgrade that never expires.",
      "Entry fees go back to 8% as soon as the event is archived.",
      "The Event Pass rate applies to every entry, whenever it arrives.",
    ]) {
      const mutated = eventPass.replace(/^description: .*$/m, `description: ${description}`);
      expect(mutated, "the frontmatter anchor moved").not.toBe(eventPass);
      expect(detects(mutated), description).toBe(true);
    }
  });

  // Headings were filtered by `proseBlocks` and therefore unscanned too:
  // measured 0/36 before, 12/12 after.
  it("catches a falsehood delivered through a heading", () => {
    for (const heading of [
      "Yours forever — the pass never expires and later entrants stay at 5%",
      "Buy once, covered for good",
      "Entry costs return to normal once the trophy is handed out",
      "An upgrade with no shelf life",
    ]) {
      const mutated = eventPass.replace("## The fine print", `## ${heading}\n\n## The fine print`);
      expect(mutated, "the heading anchor moved").not.toBe(eventPass);
      expect(detects(mutated), heading).toBe(true);
    }
  });

  // The gate is POSITIONAL. Set membership raised zero faults when two real
  // paragraphs were swapped, while its own message claimed to catch reordering.
  it("catches two approved paragraphs being swapped", () => {
    const first = "- The pass covers **that competition only**, while it runs.";
    const second =
      "- It does **not** carry to next season's edition — a new edition is a new competition, so a new pass (or the moment Pro starts making sense).";
    expect(eventPass.includes(`${first}\n${second}`), "the anchors moved").toBe(true);
    const swapped = eventPass.replace(`${first}\n${second}`, `${second}\n${first}`);
    expect(inventoryFaults("x", swapped, APPROVED_EVENT_PASS_INVENTORY)).not.toEqual([]);
  });

  // plans.md is pinned WHOLE, not by section: the same falsehood pasted into a
  // sibling section used to raise zero faults.
  it("covers plans.md outside the Event Pass section", () => {
    const mutated = plans.replace(
      "## Pro — $19/month",
      "The pass has no end date and applies for the life of the event.\n\n## Pro — $19/month",
    );
    expect(mutated, "the section anchor moved").not.toBe(plans);
    expect(inventoryFaults("x", mutated, APPROVED_PLANS_INVENTORY)).not.toEqual([]);
  });

  // ── THE HONEST RATE ───────────────────────────────────────────────────────
  // Asserted EXACTLY, the way task 4 pinned its vocabulary at 1/40: the lexical
  // layer is a secondary net, and any widening of it must update these numbers
  // deliberately rather than quietly improving a claim nobody re-measures.
  // An independent reviewer measured 1/12 and 0/12 on its own sets.
  it("scores 1/12 and 4/12 on its own — the gate is doing the work", () => {
    const lexicalOnly = (added: string): boolean => {
      const m = `${eventPass}\n\n${added}\n`;
      return (
        unapprovedClaimFaults("x", m, DURATION_ALLOWLIST, GATE_INPUTS).length > 0 ||
        unapprovedClaimFaults("x", m, FEE_RATE_ALLOWLIST, GATE_INPUTS).length > 0 ||
        passBoundProseFaults("x", m).length > 0 ||
        unqualifiedFeeReversionFaults("x", m).length > 0 ||
        lockedRateConstantFaults("x", m).length > 0
      );
    };
    const duration = [
      "Once bought, the upgrade is yours from then on and your competition never loses it.",
      "The upgrade outlives the event.",
      "A passed competition is passed for keeps.",
      "Whatever the season does, the upgrade abides.",
      "Consider the upgrade banked.",
      "No calendar governs an Event Pass.",
      "Your pass sticks with the competition no matter what.",
      "The pass has no shelf life.",
      "Nobody can take the upgrade off a competition after checkout.",
      "Treat it as a one-off purchase that simply does not wear out.",
      "The upgrade will be there whenever you come back to the event.",
      "Buy it and the competition is covered from that day onward.",
    ];
    const fee = [
      "Once the trophy is handed out, entry costs return to normal and later entrants cost you more per head.",
      "Sign-ups arriving after the closing whistle are charged the plan's percentage.",
      "Once the fixtures are done we go back to taking a bigger share of each entry.",
      "Later sign-ups are billed at Community's percentage.",
      "Entrants who sign up after the final pay the full platform fee.",
      "The moment a competition is archived we take 8% again.",
      "Your take-home per entry shrinks once the pass is spent.",
      "Post-tournament entries carry the standard commission.",
      "When the event wraps up, your entrants go back to the standard 8%.",
      "The five per cent deal only covers entries taken before the event ends.",
      "Entry fees revert to the usual cut when the tournament finishes.",
      "Once the pass has done its job the cheaper rate is over.",
    ];
    expect(duration.filter(lexicalOnly).length, "lexical duration rate").toBe(1);
    expect(fee.filter(lexicalOnly).length, "lexical fee rate").toBe(4);
    // …and every one of them is caught once the gate is included.
    expect([...duration, ...fee].filter((s) => !detects(`${eventPass}\n\n${s}\n`))).toEqual([]);
  });
});
