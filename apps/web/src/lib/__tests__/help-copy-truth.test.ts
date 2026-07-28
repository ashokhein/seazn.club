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
import { readFileSync } from "node:fs";
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
  claimTexts,
  LOCALE_CLAIMS,
  localeHalfClaimFaults,
  riderClaimShape,
  type LocalisedValue,
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
import { HELP_ARTICLE_SLUGS, helpUrl } from "@/lib/help";
import { allHelpArticles } from "@/server/help-content";
import { TIPS } from "@/config/tips";
import { attachConfirmKey } from "@/lib/billing-group-view";
import { allSourceFiles, codeOnly, helpArticle, helpArticleBySlug, webSource } from "./_help-copy";
import {
  APPROVED_EVENT_PASS,
  APPROVED_EVENT_PASS_INVENTORY,
  APPROVED_PLANS_PASS,
  APPROVED_PLANS_INVENTORY,
  APPROVED_ADD_ONS_INVENTORY,
  APPROVED_GROUPS_INVENTORY,
  APPROVED_CREATE_ORG_INVENTORY,
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
  "config/tips.ts + dictionaries/*/ui.json — tips.schedule.save-points.body is stale on BOTH sides vs schedule.checkpoints.max (community 2 since V319, pro 5, pro_plus unlimited); documented as the tip-mirror exception in dictionary-copy-truth.test.ts (#303)",
  "content/help/** link TARGETS are invisible to the inventory gate — claimSurfaces reduces [text](/url) to text, so repointing a URL raises 0 faults (sibling of the link-TITLE hole, #338)",
  "app/globals.css .competition-prose table — the horizontal scroll box added for #299 is NOT keyboard-reachable: it needs tabindex=0, and renderHelpMarkdown's sanitiser (server/help-content.ts) drops the attribute, so it cannot be set from Markdown. Needs a rehype step or a wrapper element (#303)",
  "app/globals.css .competition-prose table — `display: block` is what gives that scroll box its overflow, and it drops the implicit table role in some assistive tech (row/column relationships stop being announced). Mitigation is an explicit role=\"table\"/rowgroup set, which the same sanitiser strips (#303)",
  // ── Round 4 bookkeeping: the residuals, named rather than left implicit ────
  "THE AXIS IS CIRCULAR. `claiming` is computed by running `en.halfClaim` over the tree, so an article only joins the half-rate axis — and therefore only earns a gate — if that vocabulary already matches it. The vocabulary has been measured at 0/12 and 0/24, so an article stating the rate in an unseen shape is invisible to the axis AND ungated. The axis narrows the ungated set; it does not close it (#303)",
  "THE FOURTH ARTICLE. `billing/plans.md` states the plan org caps and the fee ladder and is inventory-gated, but `billing/downgrade.md`, `billing/credits.md`, `billing/operator.md` and every non-billing article are ungated and unscanned. They are defended only by the vocabulary above (#303)",
  "FRONTMATTER PARSER DIVERGENCE, STILL LIVE. `server/help-content.ts`'s parseFrontmatter splits on `indexOf(\":\")` and is last-wins, so an indented `  description:` or a spaced `description :` is still RENDERED as the article's description while `copy-truth.ts`'s claimSurfaces regex (`^([A-Za-z_][\\w-]*):`) does not match it — the field scores 0 gate faults and is invisible to every rule. A falsehood delivered that way ships green (#303)",
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

// ─────────────────────────────────────────────────────────────────────────────
// TASK 7 — `content/help/billing/add-ons.md`, the article the shipped
// `billing.addons.extra-org` tip used to point around.
//
// It is GATED FROM DAY ONE rather than after it has carried a falsehood. See
// APPROVED_ADD_ONS_INVENTORY's header for the argument; the short version is
// that every paragraph of it is about money an organiser is charged, and it
// makes the very rate claim this wave has spent three rounds correcting.
//
// The only LEXICAL rule pointed at it is the half-rate one, reused whole from
// the dictionary guards — no new pattern is added anywhere for this article.
// That is deliberate: this wave's measured lesson is that a rule which reads
// the sentence scores on its author's imagination (1/12, 0/12, 6/30, 0/32,
// 1/40), so the answer to "cover a new page" is a pinned inventory, not another
// vocabulary. The pass-duration and fee-rate allowlists are deliberately NOT
// pointed here either: "the credits themselves never expire" is TRUE of a
// credit pack, and a guard that reds on true prose teaches the next editor to
// route around it.
// ─────────────────────────────────────────────────────────────────────────────
const addOns = helpArticle("add-ons");
const groups = helpArticle("groups");

/** Every inventory-gated help article, by slug. Shared by the axis describe and
 *  the rate measurements below so the two cannot disagree about what is gated. */
const GATED_ARTICLES: Record<string, string[]> = {
  "billing/add-ons": APPROVED_ADD_ONS_INVENTORY,
  "billing/groups": APPROVED_GROUPS_INVENTORY,
  "getting-started/create-your-organisation": APPROVED_CREATE_ORG_INVENTORY,
};

/** The seed rows this article quotes. Read from the seed, never restated — the
 *  claim and the number have to come from different places or the comparison
 *  proves nothing. */
const seatAddon = stripePlans.seats.find((s) => s.key === "extra_seat")!;
const sizePack = stripePlans.size_packs.find((s) => s.key === "size_pack_32")!;
const orgAddons = stripePlans.org_addons;

/** The article as ONE value for the half-rate rule, joined the way
 *  `PLUS_CARD_VALUES` joins the Pro Plus bullets: with a full stop, so a
 *  qualifier cannot reach across two blocks. `claimTexts` covers frontmatter
 *  and prose (headings are a fragment, and are covered by the gate). */
const addOnsClaim = (text: string): LocalisedValue[] => [
  { locale: "en", key: "content/help/billing/add-ons.md", value: claimTexts(text).join(". ") },
];

describe("the add-ons article says what the billing code actually does", () => {
  it("is registered, non-empty, and has the surfaces the gate pins", () => {
    expect(HELP_ARTICLE_SLUGS).toContain("billing/add-ons");
    // The registry and the disk are gated both ways by
    // server/__tests__/help-content.test.ts; this asserts the tip that sent a
    // reader here resolves, which is the reason the article exists at all.
    expect(helpUrl(TIPS["billing.addons.extra-org"].helpSlug)).toBe("/help/billing/add-ons");
    expect(claimTexts(addOns).length, "the article scans as nothing").toBeGreaterThan(10);
    expect(APPROVED_ADD_ONS_INVENTORY.length, "an empty inventory gates nothing").toBeGreaterThan(20);
  });

  // THE GATE. Same rule, same reasons, as event-pass.md and plans.md above.
  it("is the copy that was approved, surface for surface", () => {
    expect(inventoryFaults("add-ons.md", addOns, APPROVED_ADD_ONS_INVENTORY)).toEqual([]);
  });

  // The extra-organisation rate, from the seed's own tiers. `riderClaimShape`
  // decides which qualifier is honest today, so if every rider ever became an
  // exact half a bare "half the base rate" stops being a fault — the guard is
  // not "always demand 'no more than'".
  it("quotes the extra-organisation rate in the shape the seed licenses", () => {
    const shape = riderClaimShape(stripePlans.plans as unknown as PricedPlan[]);
    expect(shape, "usd riders round DOWN (47.4% / 48.7%) while eur and aud are exact halves").toBe(
      "atMost",
    );
    expect(localeHalfClaimFaults(addOnsClaim(addOns), shape)).toEqual([]);
  });

  // ANTI-VACUITY for the rule above, both directions. An all-negative check
  // passes on an article that never mentions the rate at all, and a
  // presence-only check passes on one that states it wrongly.
  it("actually examines the rate sentence, rather than passing on silence", () => {
    const bare = addOns.replace(
      "costs no more than half the base rate",
      "costs half the base rate",
    );
    expect(bare, "the rate sentence moved — re-point this guard").not.toBe(addOns);
    expect(localeHalfClaimFaults(addOnsClaim(bare), "atMost")).not.toEqual([]);

    // …and deleting the claim is a fault too, not a way to pass. A buyer with
    // no idea what a second organisation costs is not better served than one
    // told the wrong number.
    const dropped = addOns.replace(/Each organisation after the first costs[^.]*\./, "");
    expect(dropped, "the rate sentence moved — re-point this guard").not.toBe(addOns);
    expect(localeHalfClaimFaults(addOnsClaim(dropped), "atMost")).not.toEqual([]);
  });

  // The three additive deltas, taken from the seed rather than restated. A
  // catalog edit that changes what a pack grants reds the page that sells it.
  it("quotes the seed's own add-on deltas", () => {
    expect(addOns, "the extra seat's delta").toContain(`+${seatAddon.delta_each} each`);
    expect(addOns, "the size pack's delta").toContain(`+${sizePack.delta_each} each`);
    expect(sizePack.delta_each, "the prose spells this one out in words too").toBe(32);
    expect(addOns).toContain(`limit by ${sizePack.delta_each}`);
    expect(orgAddons.length, "no extra-organisation add-on to describe").toBeGreaterThan(0);
    for (const addon of orgAddons) {
      expect(addOns, `${addon.key}'s delta`).toContain(`+${addon.delta_each} each`);
      // Monthly-only is a CLAIM the article makes ("every month, whatever your
      // plan's own billing period"), so it is pinned to the seed, not assumed.
      expect(addon.price.interval, `${addon.key} is no longer monthly`).toBe("month");
    }
    expect(seatAddon.price.interval, "the extra seat is no longer monthly").toBe("month");
    // …and the two one-time add-ons have no interval at all, which is what
    // makes "one-time" true of them and "every month" true of the other two.
    expect(sizePack.price).not.toHaveProperty("interval");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE THREE CLAIMS ROUND 1 GOT WRONG — pinned to the code, not to the gate.
//
// A GATE PROVES DELIBERATE, NEVER TRUE. Round 1 of this article was
// inventory-approved and shipped three false money claims; the fixture's own
// `why` notes named the files that contradicted them. Approving a digest
// records that somebody CHOSE these words — nothing more. So each of the three
// now has a rule that reads the code, and each asserts a known-positive on the
// same read before asserting the negative, so a rename reds rather than
// quietly making the guard vacuous.
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// THE HALF-RATE CLAIM ACROSS THE WHOLE HELP TREE (fix round 2).
//
// Round 1 pinned the claim in the dictionaries and left the help tree alone.
// The review found it live in TWO articles — `billing/groups.md` six times
// (frontmatter included) and `getting-started/create-your-organisation.md`
// once, a file nothing in this wave had opened. Neither was scanned by any
// suite, and neither was in KNOWN_GAPS, so both were oversights rather than
// decisions.
//
// The fix is not "scan those two". It is to compute WHICH ARTICLES MAKE THE
// CLAIM from the tree itself: a new article that states the rate reds this
// suite until someone puts it on the axis. That is the same shape as
// `FAQ_PASS_SCOPED` in the dictionary suite, and it is the only version that
// survives somebody writing a fifth article.
// ─────────────────────────────────────────────────────────────────────────────
describe("every help article stating the extra-organisation rate states it honestly", () => {
  /** Article slug -> its claim text, for every article whose prose makes a
   *  half-rate claim in ANY shape the English vocabulary knows. Computed, not
   *  listed. */
  const claiming = new Map<string, string>();
  for (const article of allHelpArticles().values()) {
    // RAW, not `article.markdown`: `allHelpArticles` has already stripped the
    // frontmatter, and `groups.md` carried this very claim in its
    // `description:` — which is the lead paragraph, the page metadata and the
    // search snippet.
    const text = claimTexts(helpArticleBySlug(article.slug)).join(". ");
    if (LOCALE_CLAIMS.en.halfClaim.test(text)) claiming.set(article.slug, text);
  }

  /** The axis, pinned. Adding an article that states the rate is a decision. */
  const ON_THE_AXIS = [
    "billing/add-ons",
    "billing/groups",
    "getting-started/create-your-organisation",
  ];

  /** Every article on the axis is INVENTORY-GATED. Shared, so "what is gated"
   *  has one definition. */
  const GATES = GATED_ARTICLES;

  it("knows exactly which articles make the claim", () => {
    expect([...claiming.keys()].sort()).toEqual(ON_THE_AXIS);
    // ANTI-VACUITY: a vocabulary that drifted narrow would sweep nothing in and
    // every article below would pass by never being examined.
    expect(claiming.size, "no article was classified at all").toBeGreaterThan(2);
  });

  /**
   * ON THE AXIS MEANS GATED. Measured: off-vocabulary false rate claims pasted
   * into groups.md and create-your-organisation.md shipped 119/119 GREEN, and
   * so did a whole new help article; the same edit to the gated add-ons.md
   * redded at once. The vocabulary scored 0/24 on the reviewer's set.
   *
   * That number bites the axis itself, because the axis is computed THROUGH
   * `en.halfClaim`: membership was being decided by a regex that catches
   * almost nothing. So the axis is not the defence — the gate is — and this
   * assertion is what stops an article joining the axis without one.
   */
  it("gates every article on the axis, because the vocabulary cannot defend them", () => {
    for (const slug of ON_THE_AXIS) {
      expect(GATES[slug], `${slug} is on the half-rate axis but has no inventory`).toBeDefined();
      expect(GATES[slug]!.length, `${slug}'s inventory is empty`).toBeGreaterThan(8);
    }
    expect(Object.keys(GATES).sort(), "a gate exists for an article not on the axis").toEqual(
      ON_THE_AXIS,
    );
  });

  it("is the copy that was approved, surface for surface, in all of them", () => {
    for (const [slug, approved] of Object.entries(GATES)) {
      expect(allHelpArticles().has(slug), `${slug} is gated but not on disk`).toBe(true);
      expect(inventoryFaults(`${slug}.md`, helpArticleBySlug(slug), approved), slug).toEqual([]);
    }
  });

  // …and the gate catches what the vocabulary provably does not: the reviewer's
  // own off-vocabulary set, which shipped green against these two files.
  it("catches the off-vocabulary claims that scored 0/24 on the vocabulary", () => {
    const OFF_VOCABULARY = [
      "Each extra organisation costs 50% of the base rate.",
      "Every organisation after the first costs half as much as the first.",
      "An extra organisation is half of what the plan costs.",
      "Extra organisations come in at fifty percent of the base rate.",
    ];
    for (const slug of ON_THE_AXIS) {
      const markdown = helpArticleBySlug(slug);
      for (const added of OFF_VOCABULARY) {
        const mutated = `${markdown}\n\n${added}\n`;
        // The vocabulary: this is the 0/24 result, asserted rather than described.
        expect(
          LOCALE_CLAIMS.en.halfClaim.test(added),
          `${added} — if the vocabulary now catches this, re-measure the rate below`,
        ).toBe(false);
        // The gate: catches every one, because it is not reading them.
        expect(inventoryFaults("x", mutated, GATES[slug]!), `${slug} <- ${added}`).not.toEqual([]);
      }
    }
  });

  it("states it in the shape the seed licenses, in all of them", () => {
    const shape = riderClaimShape(stripePlans.plans as unknown as PricedPlan[]);
    for (const [slug, text] of claiming) {
      expect(
        localeHalfClaimFaults([{ locale: "en", key: `content/help/${slug}.md`, value: text }], shape),
        slug,
      ).toEqual([]);
    }
  });

  // …and the rule really fires on the wording each article actually shipped.
  // Absence of faults proves "honest" only if the dishonest form would fault.
  it("faults the exact phrasings these two articles carried", () => {
    for (const shipped of [
      "Every organisation after that is half the base rate",       // groups.md:13
      "extra organisations are half price",                        // groups.md frontmatter
      "The bill goes up by half the plan rate straight away",      // groups.md:41
      "that headroom is what the extra half-price rate buys",      // groups.md:137
      "each one after the first at half the rate",                 // create-your-organisation.md:25
      "each organisation after the first is half your plan's rate", // the dictionaries
    ]) {
      expect(
        localeHalfClaimFaults([{ locale: "en", key: "x", value: shipped }], "atMost"),
        shipped,
      ).not.toEqual([]);
    }
  });
});

describe("codeOnly strips comments and nothing else", () => {
  // Written against the shapes that defeated the hand-rolled version. Each one
  // is a real idiom in this repo, not a synthetic curiosity.
  const CASES: Array<[name: string, source: string, mustKeep: string, mustDrop: string]> = [
    [
      "a `/*` inside a string literal (the live defect)",
      'const a = <input accept="image/*" />;\n// gone\nconst b = 1;',
      'accept="image/*"',
      "gone",
    ],
    [
      "a `//` inside a regex literal",
      "const url = /https?:\\/\\//; // gone\nconst keep = 2;",
      "const keep = 2;",
      "gone",
    ],
    [
      "a `/*` inside a template literal spanning lines",
      "const t = `line one /* not a comment\nline two`; /* gone */\nconst keep = 3;",
      "line two`",
      "gone",
    ],
    [
      "an apostrophe in a block comment",
      "/* it's fine */\nconst keep = 4;",
      "const keep = 4;",
      "it's fine",
    ],
    [
      "a block comment containing a quote character",
      'const keep = 5; /* say "hello" */\nconst also = 6;',
      "const also = 6;",
      "hello",
    ],
  ];

  it.each(CASES)("keeps the code and drops the comment: %s", (_name, source, keep, drop) => {
    const stripped = codeOnly(source, "case.tsx");
    expect(stripped, "code was lost").toContain(keep);
    expect(stripped, "a comment survived").not.toContain(drop);
    // BLANKING, not deleting: offsets and line numbers must still line up, or a
    // fault message quoting a line number starts lying.
    expect(stripped.length).toBe(source.length);
    expect(stripped.split("\n").length).toBe(source.split("\n").length);
  });

  // ANTI-VACUITY: the cases must actually exercise the failure. Each `mustDrop`
  // has to be present before stripping, or "not.toContain" proves nothing.
  it("every case really contains what it claims to drop", () => {
    for (const [name, source, , drop] of CASES) {
      expect(source.includes(drop), `${name}: the fixture never contained "${drop}"`).toBe(true);
    }
  });
});

describe("the add-ons article's behaviour claims are pinned to the code", () => {
  // CLAIM: "An extra seat freezes members … An extra organisation does not
  // freeze anything." Round 1 said the excess freezes for BOTH.
  it("freezes exactly the two axes the article says, and orgs.max_owned is not one", () => {
    const source = webSource("server/usecases/entitlement-freeze.ts");
    const frozen = [...source.matchAll(/getLimit\(orgId,\s*"([^"]+)"\)/g)].map((m) => m[1]!);

    // KNOWN-POSITIVE FIRST: if `getLimit(orgId, "...")` is ever spelled another
    // way, this reds instead of the negative below passing on an empty list.
    expect(frozen.sort(), "the freeze axes changed — re-read the article").toEqual([
      "competitions.max_active",
      "members.max",
    ]);

    // THE NEGATIVE the prose depends on. `lib/billing-group.ts` states the org
    // cap is ADMISSION-ONLY (`count + 1 > limit` on the way IN, never
    // re-evaluated), so there is no freeze for an extra organisation to cause.
    expect(frozen, "orgs.max_owned is now a freeze axis — the article says it is not").not.toContain(
      "orgs.max_owned",
    );
    expect(
      webSource("lib/billing-group.ts"),
      "the ADMISSION-ONLY note is gone — re-check what an over-cap group can do",
    ).toContain("never re-evaluated against organisations that already exist");

    // …and the article says both halves, so neither can be dropped silently.
    expect(addOns, "the seat half").toMatch(/extra seat stops you adding members/i);
    expect(addOns, "the org non-freeze").toMatch(/extra organisation does not freeze anything/i);
    // The owner exemption is real (`frozenMemberIds` filters role === "owner").
    expect(source).toContain('r.role === "owner"');
    expect(addOns).toMatch(/owners are never marked/i);

    // HOW FAR THE SEAT FREEZE ACTUALLY REACHES. Round 2 said the limit is
    // "re-checked on every write". It is not: `assertMemberNotFrozen` has ONE
    // production call site, and it is gated three ways.
    const apiAuth = codeOnly(webSource("server/api-v1/auth.ts"), "auth.ts");
    // PER-FILE KNOWN-POSITIVE, not one global fixture. A walk over ~1,400
    // files with a single count assertion cannot notice that ONE file was
    // silently skipped — and one was: `codeOnly`'s first implementation ate
    // 198 lines of `components/v2/division-settings.tsx` because
    // `accept="image/*"` opened a phantom block comment, and a call planted
    // inside that span was invisible while the suite stayed green.
    //
    // `codeOnly` BLANKS rather than deletes, so length and line count are
    // invariants of a correct strip. Asserting them per file is what makes a
    // swallowed span impossible to miss, whatever swallows it.
    const mangled: string[] = [];
    const callSites: string[] = [];
    for (const [file, raw] of allSourceFiles()) {
      const stripped = codeOnly(raw, file);
      if (stripped.length !== raw.length) {
        mangled.push(`${file}: ${raw.length} chars in, ${stripped.length} out`);
      } else if (stripped.split("\n").length !== raw.split("\n").length) {
        mangled.push(`${file}: line count changed`);
      }
      if (file.includes("__tests__") || file === "server/usecases/entitlement-freeze.ts") continue;
      if (stripped.includes("assertMemberNotFrozen")) callSites.push(file);
    }
    expect(mangled, "codeOnly mangled these files — every negative scan over them is unsound").toEqual(
      [],
    );
    // …and the specific string that broke it, pinned as a regression.
    const divisionSettings = allSourceFiles().find(
      ([f]) => f === "components/v2/division-settings.tsx",
    );
    expect(divisionSettings, "the regression fixture moved — re-point it").toBeDefined();
    expect(
      codeOnly(divisionSettings![1], divisionSettings![0]),
      'a `/*` inside a string literal must not open a comment',
    ).toContain('accept="image/*"');
    expect(callSites, "the freeze reaches further than the article says — re-read it").toEqual([
      "server/api-v1/auth.ts",
    ]);
    // …and that one site is admin-only, write-only, session-only: a bearer
    // token returns from `apiKeyAuth` before ever reaching it, so API-KEY
    // writes are never freeze-checked at all.
    expect(apiAuth).toContain('if (scope === "write" && role === "admin")');
    expect(apiAuth).toContain("if (token) return apiKeyAuth(req, token, orgId);");
    expect(addOns, "the article must not over-promise enforcement").not.toMatch(
      /re-?checked on every write/i,
    );
    // …and it must name the RIGHT surface. "our public API" was still wrong:
    // on that API the normal caller is a bearer `sc_` key, and `auth.ts:210`
    // returns from `apiKeyAuth` BEFORE the freeze check — so an API-key client
    // is never checked either. The only callers that are: signed-in admins
    // writing through the REST routes.
    expect(addOns, "…and must say where it IS enforced").toMatch(
      /blocks only signed-in admins writing through our REST API, not API-key clients/i,
    );
    // The 13 routes that reach `requireOrgAuth`, counted rather than asserted
    // as prose — if the surface grows, the sentence above needs re-reading.
    const restRoutes = [...allSourceFiles()].filter(
      ([f, src]) => f.startsWith("app/api/v1/") && codeOnly(src, f).includes("requireOrgAuth"),
    );
    expect(restRoutes.length, "the REST surface changed size — re-read the copy").toBe(13);

    // The half that IS enforced everywhere is ADMISSION: an invite or a
    // promotion past members.max is refused in the same transaction.
    expect(codeOnly(webSource("lib/invites.ts"), "invites.ts")).toContain('"members.max"');
    expect(
      codeOnly(webSource("app/api/orgs/[id]/members/[userId]/role/route.ts"), "route.ts"),
    ).toContain('"members.max"');
    expect(addOns).toMatch(/invitation or a promotion that would take you past the limit is refused/i);
  });

  // CLAIM: "added to your next invoice rather than charged on the spot."
  // Round 1 said "charged pro rata straight away" / "charges the difference now".
  it("raises with create_prorations, which bills next invoice — never always_invoice", () => {
    for (const file of ["server/usecases/extra-seats.ts", "server/usecases/extra-orgs.ts"]) {
      const source = webSource(file);
      // KNOWN-POSITIVE: the raise path really does set a proration behaviour.
      expect(source, `${file} sets no proration behaviour at all`).toContain(
        'proration_behavior: "create_prorations"',
      );
      // THE NEGATIVE: `always_invoice` is what would charge immediately.
      expect(source, `${file} now invoices immediately — the article says it does not`).not.toContain(
        "always_invoice",
      );
    }
    // Stated where the behaviour is documented, so the article and the comment
    // cannot drift apart.
    expect(webSource("server/usecases/billing-events.ts")).toContain(
      "books those adjustments onto the next invoice rather than",
    );
    // BOTH raise paths say it. One would leave the other free to drift back to
    // "now" — which is exactly the shape round 1 shipped.
    expect(
      addOns.match(/\*\*added to your next invoice\*\* rather than charged on the spot/g) ?? [],
      "both raise paths must state the timing",
    ).toHaveLength(2);
    expect(addOns).not.toMatch(/charged pro rata straight away|the difference[^.]*\bnow\b/i);

    // The product's own UI copy already avoided "now" on this exact claim; the
    // article contradicting it was the tell. Pinned so they move together.
    const prorateUp = JSON.parse(
      readFileSync("src/dictionaries/en/ui.json", "utf8"),
    )["addOns.extraOrg.prorateUp"] as string;
    expect(prorateUp, "the UI copy that got this right").toBe(
      "You'll pay the difference for the rest of this billing period.",
    );
    expect(prorateUp).not.toMatch(/\bnow\b/i);
  });

  // CLAIM (groups.md + the attach dialog): the added organisation is prorated
  // onto the NEXT invoice, and nothing is charged at the moment of attach.
  //
  // ROUND 2 ASSERTED THE OPPOSITE, in this file's sibling fixture, on the
  // strength of a COMMENT (billing-groups.ts:206-207, "charged immediately")
  // that the code contradicted — the same defect this wave exists to remove,
  // committed while fixing it. The comment is corrected; this is what stops it
  // mattering again.
  it("attaches with create_prorations too — nothing charges a card at attach", () => {
    // CODE ONLY. The comment correcting this very defect names `always_invoice`,
    // so a raw scan would fire on its own explanation.
    const source = codeOnly(webSource("server/usecases/billing-groups.ts"), "billing-groups.ts");
    const withComments = webSource("server/usecases/billing-groups.ts");

    // KNOWN-POSITIVE: the quantity write really is here and really does set a
    // proration behaviour. Without this, a refactor that moved the call would
    // leave every negative below passing on a file that no longer bills.
    expect(source, "syncGroupQuantity's proration write moved").toContain(
      'proration_behavior: raising ? "create_prorations" : "none"',
    );

    // THE NEGATIVES the copy depends on. `always_invoice` is the idiom that
    // charges on the spot — it exists in this repo (lib/billing-manage.ts, the
    // PLAN-CHANGE path), so its absence here is a real distinction, not a
    // vacuous one.
    for (const immediate of ["always_invoice", "invoices.create(", "invoices.pay", "payment_behavior", "billing_cycle_anchor"]) {
      expect(source, `billing-groups.ts now uses ${immediate} — the attach copy says nothing is charged at attach`).not.toContain(
        immediate,
      );
    }
    // …and the distinction is real: the plan-change path DOES invoice at once.
    expect(
      codeOnly(webSource("lib/billing-manage.ts"), "billing-manage.ts"),
      "the always_invoice idiom vanished — re-check what still charges immediately",
    ).toContain('proration_behavior: "always_invoice"');

    // The preview is read-only. It is the only `invoices.*` call in the file,
    // and the dialog's figure comes from it.
    expect(source).toContain("invoices.createPreview");

    // The corrected comment, so the next reader is not caught the way I was.
    expect(withComments, "the stale 'charged immediately' comment is back").not.toContain(
      "seat is charged immediately",
    );

    // …and the copy says the true thing, in both the article and the dialog.
    expect(groups).toMatch(/added to your next invoice, not charged to your card there and then/i);
    expect(groups).not.toMatch(/and charged now/i);
    const ui = JSON.parse(readFileSync("src/dictionaries/en/ui.json", "utf8")) as Record<string, string>;
    for (const key of ["billing.group.attach.confirmCharge", "billing.group.attach.confirmChargeAmount"]) {
      expect(ui[key], key).toMatch(/added to your next invoice/);
      expect(ui[key], key).not.toMatch(/\bnow\b/);
    }
  });

  // CLAIM (the attach dialog, round 4): the TRIAL path prorates nothing, so it
  // gets its own body rather than the charged one.
  it("gives the trial path its own confirm body, because freeSlots cannot see it", () => {
    const source = codeOnly(webSource("server/usecases/billing-groups.ts"), "billing-groups.ts");

    // KNOWN-POSITIVES: the three lines the claim rests on.
    expect(source, "the trial early-return in previewAttachCharge moved").toContain(
      'if (group.status === "trialing") return null;',
    );
    expect(source, "`raising` no longer excludes trialing").toContain("&& !trialing");
    expect(source, "the trialing flag moved").toContain('const trialing = group.status === "trialing";');

    // THE SELECTION. `freeSlots` is 0 during a trial (quantity_paid is frozen),
    // so the two-way version handed a trialing payer the CHARGED body.
    expect(attachConfirmKey(0, true)).toBe("billing.group.attach.confirmTrial");
    expect(attachConfirmKey(3, true), "the trial is the more specific truth").toBe(
      "billing.group.attach.confirmTrial",
    );
    expect(attachConfirmKey(0, false)).toBe("billing.group.attach.confirmCharge");
    expect(attachConfirmKey(1, false)).toBe("billing.group.attach.confirmFree");
    // …and the default must not silently reintroduce the bug for a caller that
    // forgets the argument — it is the CHARGED path that is wrong on a trial,
    // so the panel passing `trialing` explicitly is asserted too.
    expect(
      codeOnly(webSource("components/billing-group-panel.tsx"), "billing-group-panel.tsx"),
      "the panel stopped passing trialing",
    ).toContain("attachConfirmKey(freeSlots, trialing)");

    const ui = JSON.parse(readFileSync("src/dictionaries/en/ui.json", "utf8")) as Record<string, string>;
    // The trial body must not promise an invoice line, and the charged one must.
    expect(ui["billing.group.attach.confirmTrial"]).toMatch(/nothing is added to a bill now/i);
    expect(ui["billing.group.attach.confirmTrial"]).not.toMatch(/added to your next invoice/i);
    expect(ui["billing.group.attach.confirmCharge"]).toMatch(/added to your next invoice/i);
    // …and the FREE body carries the renewal bound it was missing (N3): the
    // item quantity still rises, so the renewal invoice bills the seat.
    expect(ui["billing.group.attach.confirmFree"]).toMatch(/from your next renewal onwards/i);
    // groups.md already said the trial thing; the two must agree.
    expect(groups).toMatch(/rides the same trial to the same end date and costs nothing now/i);
  });

  // CLAIM: "Extra seats have no control in Settings yet" / "Size packs have no
  // control in Settings yet either." True today and the single most rot-prone
  // sentence on the page: the day somebody builds either control, the article
  // starts telling customers to email support for a button that is on screen.
  // Nothing about the copy can detect that, so this watches the CODE.
  it("says 'no control in Settings yet' only while that is still true", () => {
    // The purchase entry points. A control means a component or page reaching
    // for one of these — the API routes and the usecases themselves are not
    // evidence of a UI, which is exactly the distinction the sentence makes.
    for (const [addOn, route] of [
      ["extra seats", "/api/billing/extra-seats"],
      ["size packs", "/api/billing/size-pack-checkout"],
    ] as const) {
      const callers = [...allSourceFiles()]
        .filter(([file]) => file.startsWith("components/") || file.startsWith("app/"))
        .filter(([file, source]) => !file.includes("__tests__") && source.includes(route))
        // The route handler itself lives under app/ and always mentions its own
        // path; it is the thing being called, not a caller.
        .filter(([file]) => !file.startsWith(`app${route}/`))
        .map(([file]) => file);
      expect(
        callers,
        `${addOn} now has a caller in the UI — content/help/billing/add-ons.md still says there is no control in Settings, and that sentence has to go`,
      ).toEqual([]);
    }
    // KNOWN-POSITIVE on the same read: the routes DO exist, so the walk is
    // looking at a real tree and an empty result means "no UI", not "no files".
    const files = [...allSourceFiles()];
    expect(files.length, "the source walk found nothing").toBeGreaterThan(200);
    expect(
      files.some(([f]) => f === "app/api/billing/extra-seats/route.ts"),
      "the extra-seats route moved — re-point this guard",
    ).toBe(true);
    expect(addOns.match(/no control in Settings yet/g) ?? []).toHaveLength(2);
  });

  // CLAIM: the rider matches the half rate monthly but NOT annually — "about a
  // third more over a year". Round 1 said "charged at exactly that same rate".
  it("says the annual rider costs more, and by the factor the seed actually charges", () => {
    const ratios: string[] = [];
    for (const addon of orgAddons) {
      const plan = stripePlans.plans.find((p) => p.key === addon.plan_key)!;
      const annualRider = plan.prices.annual.tiers!.find((t) => t.up_to === "inf")!;
      for (const currency of ["usd", "eur", "gbp", "inr", "aud"] as const) {
        const perMonth =
          currency === "usd"
            ? addon.price.unit_amount
            : (addon.price.currency_options as Record<string, number>)[currency]!;
        const inPlanPerYear =
          currency === "usd"
            ? annualRider.unit_amount
            : (annualRider.currency_options as Record<string, number>)![currency]!;
        const ratio = (perMonth * 12) / inPlanPerYear;
        // The add-on must be DEARER annually — that is the whole claim. If a
        // price move ever made them equal, "and on an annual bill it does not"
        // becomes false and the sentence has to change.
        if (ratio <= 1.001) ratios.push(`${addon.key} ${currency}: ratio ${ratio.toFixed(3)} — no longer dearer`);
        // THE FLOOR IS CHOSEN, THE RATIOS ARE DERIVED. `4/3` is a constant
        // picked to match the wording, not a number computed from the seed —
        // an earlier report described it as "derived from the seed" and that
        // was wrong. What the seed decides is every `ratio` above; this line
        // only asks whether the sentence pinned three lines down is still a
        // true description of them. Changing the wording means changing this
        // constant, deliberately, in the same edit.
        //
        // "AT LEAST a third more" is a FLOOR, and it is a floor because the
        // gap is not one number: measured across the seed it runs 1.355 (gbp)
        // to 1.472 (inr). The review that caught the original "exactly that
        // same rate" quoted usd alone (+36.7% / +39.9%), and a sentence tuned
        // to usd would have been false in eur and inr by the same mechanism
        // that made "half the base rate" false — the third time this wave has
        // met a comparative that only holds in one currency. So the claim is
        // the LOWER bound over all ten combinations, and this is what keeps it
        // honest if a price moves.
        if (ratio < 4 / 3)
          ratios.push(
            `${addon.key} ${currency}: ratio ${ratio.toFixed(3)} is below a third more — "at least a third more over a year" is now false`,
          );
        // …and a floor that has drifted absurdly far below the truth is also a
        // defect: it under-warns a customer the sentence exists to warn.
        if (ratio > 1.8)
          ratios.push(
            `${addon.key} ${currency}: ratio ${ratio.toFixed(3)} — the floor is now so far below the real gap that the wording under-warns`,
          );
      }
    }
    expect(ratios).toEqual([]);
    expect(addOns, "the annual divergence is stated").toMatch(
      /on a monthly bill it matches that half rate exactly, and on an annual bill it does not/i,
    );
    expect(addOns).toMatch(/at least a third more over a year/i);
    // …and the false round-1 clause cannot come back.
    expect(addOns).not.toMatch(/charged at exactly that same rate/i);
  });
});

describe.skipIf(!HAS_DB)("the add-ons article quotes the caps the matrix enforces", () => {
  it("names each plan's own organisation limit", async () => {
    for (const [plan, label] of [
      ["pro", "Pro"],
      ["pro_plus", "Pro Plus"],
    ] as const) {
      const [row] = await sql<{ int_value: number | null }[]>`
        select int_value from plan_entitlements
        where plan_key = ${plan} and feature_key = 'orgs.max_owned'`;
      expect(row, `plan_entitlements has no ${plan}/orgs.max_owned row`).toBeDefined();
      expect(row!.int_value, `${plan} must have a finite org cap for this sentence`).not.toBeNull();
      expect(addOns, `${label}'s live organisation cap`).toContain(`${label} covers ${row!.int_value}`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE HONEST RATE, for the add-ons article.
//
// Asserted EXACTLY, the way the pass guards pin 1/12 and 4/12 and the
// dictionary guards pin 1/40: the lexical layer is a SECONDARY net, and any
// widening of it has to update these numbers deliberately rather than quietly
// improving a claim nobody re-measures.
//
// Two sets. The first is rewordings of the phrases `en.halfClaim` literally
// spells out — the set the pattern was written for. The second was written
// AFTER the rules above were final, is about the OTHER things this article
// claims (cadence, scope, who may buy, what lapsing does), and is what the next
// editor's mistake will actually look like.
// ─────────────────────────────────────────────────────────────────────────────
describe("the add-ons gate catches what the vocabulary cannot", () => {
  const lexicalOnly = (added: string): boolean =>
    localeHalfClaimFaults(addOnsClaim(`${addOns}\n\n${added}\n`), "atMost").length > 0;

  const gated = (added: string): boolean =>
    inventoryFaults("x", `${addOns}\n\n${added}\n`, APPROVED_ADD_ONS_INVENTORY).length > 0;

  /** Rewordings of the exact phrases the half-rate pattern names. */
  const PATTERNS_OWN_SET = [
    "Each organisation after the first costs half the base rate.",
    "Every extra organisation is half your plan's rate.",
    "Extra slots cost half the base rate each.",
    "Each one after the first is half the plan's rate.",
    "Extra organisations are half price.",
    "An extra organisation costs 50% of your plan's rate.",
    "Each extra organisation is priced at one half of the base rate.",
    "You pay half as much for every organisation after the first.",
    "The second organisation and every one after it costs 50% less.",
    "Extra organisations come in at half what the first one costs.",
    "Each organisation past the first is billed at half rate.",
    "A second organisation costs half of your plan.",
  ];

  /** Written after the rules were final, about this article's OTHER claims. */
  const FRESH_SET = [
    "An extra organisation is billed on the same cycle as your plan, so an annual bill pays for it once a year.",
    "Cancel an extra seat and any members over the limit are removed from the organisation.",
    "A size pack lifts your organisation's member limit as well.",
    "Any member of an organisation can buy an extra seat for it.",
    "Removing an extra organisation refunds the unused part of the month.",
    "Credit packs expire at the end of the billing period they were bought in.",
    "Extra organisations cost the same as your plan's own rate.",
    "You can drop your extra organisations to zero at any time, whatever the group is using.",
    "A size pack is charged every month for as long as the competition runs.",
    "Community organisations can buy extra organisations from Settings → Add-ons.",
    "Each extra organisation costs half your plan's rate.",
    "Buying a second size pack for the same competition replaces the first.",
  ];

  // RE-MEASURED after the vocabulary was widened in fix round 2, not adjusted
  // to keep a number green. `en.halfClaim` gained "half price" and a bare "half
  // the (plan) rate" — the two shapes the shipped help articles used — so the
  // pattern's own set moved 4 -> 5 ("Extra organisations are half price" is now
  // caught) while the fresh set did not move at all. That is the finding, and
  // it is the same one this wave keeps making: widening a vocabulary improves
  // it only against the examples the widener was looking at. The gate is
  // unmoved at 24/24 because it does not read the words.
  it("scores 5/12 and 1/12 lexically — the gate is doing the work", () => {
    expect(PATTERNS_OWN_SET.filter(lexicalOnly).length, "the pattern's own set").toBe(5);
    expect(FRESH_SET.filter(lexicalOnly).length, "a set written after the rules were final").toBe(1);
  });

  // …and every one of them fails once the gate is included, because the gate is
  // not reading them. This is the assertion that makes the two numbers above a
  // measurement rather than a hole.
  /**
   * ROUND 3, measured after these rules were final — and the number that
   * settles the argument.
   *
   * Twelve claims about what round 3 actually fixed: when the attach charge
   * lands, how far the seat freeze reaches, and rate shapes the WIDENED
   * vocabulary still has not seen. The vocabulary scores ZERO. It scored 5/12
   * on the set that was written around its own phrases, 1/12 on round 2's
   * fresh set, and 0/12 here; an independent reviewer measured 0/24 on a set
   * of their own. Four measurements, one conclusion.
   *
   * The gate scores 12/12 against all three gated articles, because it is not
   * reading them. This is the whole reason `groups.md` and
   * `create-your-organisation.md` are now gated rather than merely corrected.
   */
  const ROUND_3_FRESH = [
    "Adding an organisation takes the money off your card the moment you confirm.",
    "The proration for a new organisation is billed on the spot.",
    "You will see the charge on your statement within minutes of adding.",
    "A failed card at the moment you add will bounce the organisation back out of the group.",
    "Every extra organisation is billed at fifty per cent of what you already pay.",
    "The second organisation onwards costs one half of the headline price.",
    "Cancel a seat and everyone over the limit loses write access across the whole app.",
    "An over-limit member cannot use the API or the app until you buy the seat back.",
    "Owners are frozen along with everyone else once you are over the seat limit.",
    "Adding an organisation mid-year on an annual plan bills you a full extra year today.",
    "Your extra organisations renew on their own separate date.",
    "A group that goes over its organisation limit has its newest organisations switched off.",
  ];

  it("scores 0/12 lexically on round 3's set, and 12/12 through the gate", () => {
    const caughtLexically = ROUND_3_FRESH.filter(
      (claim) =>
        LOCALE_CLAIMS.en.halfClaim.test(claim) &&
        localeHalfClaimFaults([{ locale: "en", key: "x", value: claim }], "atMost").length > 0,
    );
    expect(caughtLexically, "the vocabulary now catches some of these — re-measure").toEqual([]);

    // …and every one of them reds against every gated article.
    const escaped: string[] = [];
    for (const claim of ROUND_3_FRESH) {
      for (const [slug, approved] of Object.entries(GATED_ARTICLES)) {
        const mutated = `${helpArticleBySlug(slug)}\n\n${claim}\n`;
        if (inventoryFaults("x", mutated, approved).length === 0) escaped.push(`${slug} <- ${claim}`);
      }
    }
    expect(escaped).toEqual([]);
  });

  it("catches all 24 once the inventory is included", () => {
    expect([...PATTERNS_OWN_SET, ...FRESH_SET].filter((s) => !gated(s))).toEqual([]);
  });

  // Delivered through the two surfaces that were measured at 0/24 and 0/36
  // before `claimSurfaces` existed. They are pinned here from the first commit.
  it("catches a falsehood delivered through frontmatter or a heading", () => {
    for (const description of [
      "Four ways to buy extra capacity, all of them billed once and none of them expiring.",
      "Extra organisations are half price on every plan.",
    ]) {
      const mutated = addOns.replace(/^description: .*$/m, `description: ${description}`);
      expect(mutated, "the frontmatter anchor moved").not.toBe(addOns);
      expect(inventoryFaults("x", mutated, APPROVED_ADD_ONS_INVENTORY), description).not.toEqual([]);
    }
    for (const heading of [
      "Extra seats — buy them yourself in Settings",
      "Size packs — refundable any time",
    ]) {
      const mutated = addOns.replace("## See also", `## ${heading}\n\n## See also`);
      expect(mutated, "the heading anchor moved").not.toBe(addOns);
      expect(inventoryFaults("x", mutated, APPROVED_ADD_ONS_INVENTORY), heading).not.toEqual([]);
    }
  });

  // The gate is POSITIONAL, and an edit INSIDE a paragraph is the mutation a
  // set-membership check misses. Both are asserted rather than assumed.
  it("catches an edit inside a paragraph, a deletion, and a reorder", () => {
    const edited = addOns.replace("Nothing is ever deleted", "Members over the limit are removed");
    expect(edited, "the anchor moved").not.toBe(addOns);
    expect(inventoryFaults("x", edited, APPROVED_ADD_ONS_INVENTORY)).not.toEqual([]);

    const deleted = addOns.replace(/\n## Who can buy[\s\S]*?(?=\n## When an add-on)/, "\n");
    expect(deleted, "the section anchor moved").not.toBe(addOns);
    expect(inventoryFaults("x", deleted, APPROVED_ADD_ONS_INVENTORY)).not.toEqual([]);

    const rows = /\| Extra seat \|([^\n]*)\n(\| Size pack \|[^\n]*)\n/.exec(addOns);
    expect(rows, "the table rows moved").not.toBeNull();
    const swapped = addOns.replace(rows![0], `${rows![2]}\n| Extra seat |${rows![1]}\n`);
    expect(swapped, "the swap was a no-op").not.toBe(addOns);
    expect(inventoryFaults("x", swapped, APPROVED_ADD_ONS_INVENTORY)).not.toEqual([]);
  });
});
