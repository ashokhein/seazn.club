// Truth-in-copy guards for the AI-CREDIT PRICING articles (#348 + #350).
//
// Sibling of `help-copy-truth.test.ts` and deliberately its own file: that one
// scans the BILLING articles for plan/fee/pass claims, this one pins the three
// articles that quote a *price for an AI run* to the pure functions that decide
// it (`lib/ai-rung.ts`). Same location rule as its sibling — `src/lib/__tests__`
// is what CI's unit job selects.
//
// The failure this exists for already happened once on this branch. Until #348
// every AI run cost a flat credit, and three articles said so in three
// different sentences. #348 replaced that with a rung, and nothing in the suite
// noticed: prose has no types. The guards below are therefore all ANCHORED —
// each number in the copy is compared to the number the code returns, so
// re-tuning `AI_RUNG_BUDGET_*` or the discount reds this file instead of
// shipping a help page that quotes last quarter's price.
//
// What is NOT claimed here: that the prose reads well, or that it is complete.
// This is an arithmetic gate, plus one staleness scan for the specific claim
// family ("a run costs one credit") that #348 falsified.
import { describe, expect, it } from "vitest";
import { claimTexts, plainProse, sentences } from "@/lib/copy-truth";
import { quoteRun, schedulingRungWeights, tokenBudgetForCredits } from "@/lib/ai-rung";
import { helpArticleBySlug } from "./_help-copy";

/** The three articles that quote a price for an AI run. Any of them getting it
 *  wrong is a customer being told the wrong number before they spend. */
const PRICING_ARTICLES = [
  "scheduling/ai-scheduling",
  "scheduling/ai-officials",
  "billing/credits",
] as const;

/** How the confirm card renders a token budget ("32K"). Duplicated from
 *  `formatTokens` rather than imported: that lives in a `"use client"` module,
 *  and it is two lines. */
function asK(tokens: number): string {
  return `${Math.round(tokens / 1000)}K`;
}

describe("the budget table quotes tokenBudgetForCredits, not a remembered number", () => {
  const article = plainProse(helpArticleBySlug("scheduling/ai-scheduling"));

  it.each([1, 2, 3])("%d credit(s) is documented as the budget the code hands out", (credits) => {
    const budget = asK(tokenBudgetForCredits(credits));
    // The table row: "| 1 | up to 32K tokens |". Matching the ROW rather than
    // the bare string is what makes this an anchored claim — "32K" alone
    // appears in the prose too, and would pass while the table said anything.
    const row = new RegExp(`^\\|\\s*${credits}\\s*\\|[^|]*\\b${budget}\\b[^|]*\\|`, "m");
    expect(row.test(article), `no table row prices ${credits} credit(s) at ${budget}`).toBe(true);
  });

  it("the run-cost section says the credits buy a BUDGET rather than a run", () => {
    // The single sentence #348 turns on. Without it the table above is three
    // numbers with no stated meaning, and the old "one credit = one run" model
    // reads back in.
    expect(article).toMatch(/credits?\s+(?:do(?:es)?\s+not|don't)\s+buy\b|buys?\s+the\s+model\s+a\s+\*{0,2}thinking\s+budget/i);
  });

  it.each(PRICING_ARTICLES)("%s explains the budget, not just the price", (slug) => {
    expect(plainProse(helpArticleBySlug(slug))).toMatch(/thinking budget/i);
  });
});

describe("the joint worked example is the arithmetic quoteRun actually does", () => {
  const article = plainProse(helpArticleBySlug("scheduling/ai-scheduling"));
  // The article's own example: three divisions the organiser sized 1, 2 and 3.
  // Sizes are forced with `chosen`, so this asserts the PRICING rule and never
  // depends on the (uncalibrated) predictor thresholds.
  const big = { movableFixtures: 40, entrants: 12, courts: 3 };
  const quote = quoteRun(
    [
      { key: "a", input: big, chosen: 1 },
      { key: "b", input: big, chosen: 2 },
      { key: "c", input: big, chosen: 3 },
    ],
    schedulingRungWeights(),
  );

  it("prices at Σ rungs − 1 — the number in the copy is the number charged", () => {
    expect(quote.rungTotal).toBe(6);
    expect(quote.credits).toBe(5);
    const example = new RegExp(
      `sized 1, 2 and 3 add up to ${quote.rungTotal} and are charged \\*{0,2}${quote.credits} credits`,
      "i",
    );
    expect(example.test(article), "the worked example no longer matches quoteRun").toBe(true);
  });

  it("states the formula with its floor, so a one-division reading is impossible", () => {
    expect(article).toMatch(/never less than 1/i);
    expect(quoteRun([{ key: "a", input: big, chosen: 1 }, { key: "b", input: big, chosen: 1 }], schedulingRungWeights()).credits).toBe(1);
  });

  it("says the budget comes from the UNDISCOUNTED total, and that is what the code does", () => {
    // The claim the amendment to #350 §2 exists for: the discount is a margin
    // gift, not a capability cut. If the code ever sized the budget from
    // `credits`, this article would be selling something we do not deliver.
    expect(quote.budget).toBe(tokenBudgetForCredits(quote.rungTotal));
    expect(quote.budget).not.toBe(tokenBudgetForCredits(quote.credits));
    expect(article).toMatch(/budget is sized from the undiscounted total/i);
  });

  it("warns that shared courts are matched by NAME — the only court identity there is", () => {
    // Two divisions typing different labels for one physical court is the one
    // way a joint run double-books in a way the engine cannot see, so the
    // article has to say it in as many words.
    expect(article).toMatch(/matched by name/i);
  });
});

/**
 * The claim family #348 falsified: "an AI run costs one credit."
 *
 * A vocabulary, not a list of the exact old sentences — three articles said it
 * three different ways, and a fourth would say it a fourth. Scoped to the WORD
 * "one"/"a" so the two remaining TRUE flat-price sentences (Phase B's zero-token
 * default spread, which really is "a flat 1 credit") do not trip it: they are
 * written with the digit, and they are about a run that makes no model call.
 */
const FLAT_RUN_PRICE_PATTERNS = [
  /\b(?:each|every)\s+run\s+(?:costs?|spends?)\s+(?:one|a)\b/i,
  /\bruns?\s+(?:costs?|spends?)\s+one\s+(?:AI\s+)?credit\b/i,
  /\b(?:costs?|spends?|charged)\s+one\s+(?:AI\s+)?credit\s+(?:on\s+every\s+plan|per\s+run)\b/i,
  /\bone\s+(?:AI\s+)?credit\s+(?:a|per)\s+run\b/i,
  // Subject-first, which the four above all miss: "Generate, refine and repair
  // each spend one AI credit." Found by the self-check below, not by reading.
  /\bspends?\s+(?:one|a)\s+(?:AI\s+)?credit\b/i,
];

describe("no help article still sells a flat one-credit run", () => {
  it.each(PRICING_ARTICLES)("%s", (slug) => {
    const faults: string[] = [];
    for (const block of claimTexts(helpArticleBySlug(slug))) {
      for (const sentence of sentences(block)) {
        for (const pattern of FLAT_RUN_PRICE_PATTERNS) {
          if (pattern.test(sentence)) faults.push(`${slug}: "${sentence.slice(0, 90)}…"`);
        }
      }
    }
    expect(faults).toEqual([]);
  });

  it("the vocabulary can actually fire (it is not a regex that matches nothing)", () => {
    // Without this the suite above is satisfied by four patterns that never
    // match anything, which is the shape a deleted guard leaves behind. These
    // are the exact sentences the three articles carried before #348.
    const historical = [
      "Each run costs one credit, on every plan.",
      "Generate, refine and repair each spend one AI credit, and the officials pass spends one too.",
      "AI Officials is metered the same way as the schedule pass: every run spends one AI credit from your organisation's shared wallet.",
    ];
    for (const sentence of historical) {
      expect(
        FLAT_RUN_PRICE_PATTERNS.some((p) => p.test(sentence)),
        `nothing catches: ${sentence}`,
      ).toBe(true);
    }
    // …and the TRUE flat-price sentence about the zero-token draft survives it.
    expect(
      FLAT_RUN_PRICE_PATTERNS.some((p) =>
        p.test("The no-instruction default spread makes no model call at all and is charged a flat 1 credit."),
      ),
    ).toBe(false);
  });
});
