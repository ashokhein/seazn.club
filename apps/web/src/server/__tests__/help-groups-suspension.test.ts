// The billing-groups help article's answer for "every organisation in the
// group is suspended at once" (v17 gap #293).
//
// WHY A TEST FOR PROSE. That answer describes `groupOrgLimit`'s degenerate
// branch (lib/billing-group.ts) — the one taken when no un-suspended org is
// left to resolve the cap through. The branch returns the plan_entitlements
// base PLUS `addonBonusForWallet(subscriptionId, "orgs.max_owned")`, i.e. the
// purchased extra-organisation riders KEEP counting; making them keep counting
// is one of the things this wave fixed. The shipped sentence said the group
// "falls to its plan's own limit", which a payer reads as "the $9/$19 riders I
// am still being charged for stop counting" — the exact inverse. Nothing else
// in the suite reads this file, so that inversion could sit there indefinitely.
//
// Both rules below are VOCABULARY over a located paragraph rather than a pinned
// sentence: the copy is expected to be rewritten, the two claims are not.
//
// EACH RULE IS A PAIR, and it has to be. A presence rule alone ("the sentence
// must mention the add-ons") pins the WORD, not the CLAIM — it is satisfied by
// "…falls to its plan's own limit and the add-ons you've bought stop counting",
// which asserts the exact inverse while naming the thing. That is the mirror of
// the trap this wave already hit from the other side, where a DENYLIST of two
// phrasings was walked around by a reword. So every claim here is pinned twice:
// the vocabulary that must be PRESENT, and the inverse assertion that must be
// ABSENT. Prove a change to either by REWORDING the sentence, never by
// reverting it — a revert reds a presence rule for free and tells you nothing.
//
// SCOPE, so the next reader does not over-trust this. Every rule sees only the
// ONE paragraph the locator finds. A rewrite that moves either claim into a
// neighbouring paragraph — or that answers the same question twice — is
// invisible here, and no other test in the suite reads this article at all.
import { describe, expect, it } from "vitest";
import { allHelpArticles } from "@/server/help-content";

/** Emphasis markers split words ("*every* organisation"), so strip them before
 *  matching prose. Nothing below depends on Markdown structure. */
function plain(md: string): string {
  return md.replace(/[*_`]/g, "");
}

/** The answer, located by the state it is about rather than by its question. */
const ALL_SUSPENDED = /every\s+organisation[^.]{0,60}suspended/i;

/** A sentence that says the group's limit comes DOWN. */
const LIMIT_FALLS = /\b(falls?|drops?|reverts?|reduced|lowers?|lowered)\b/i;

/** …must name the riders as survivors of that fall. */
const KEEPS_ADDONS = /\badd-ons?\b|\bextra organisations?\b/i;

/** …and must never say they are LOST, in either word order. Naming them is not
 *  the claim; keeping them is. */
const DENIES_ADDONS = [
  /\b(add-ons?|extra organisations?)\b[^.]{0,80}\b(stops?|stopped|no longer|don'?t|do not|doesn'?t|does not|cease[sd]?|lapse[sd]?)\b/i,
  /\b(lose[s]?|losing|lost|without|forfeits?|revokes?|revoked)\b[^.]{0,40}\b(add-ons?|extra organisations?)\b/i,
];

/** A sentence that says the group cannot add an organisation. */
const CANNOT_ADD = /\b(can'?t|cannot|unable to)\b[^.]*\b(add|added|take on)\b/i;

/** The one vocabulary of "there is no headroom", shared by all three rules
 *  below so a word added for one of them cannot go missing from the others. */
const CAPACITY = "full|at capacity|no room|already using|at (?:that|the|its|this) limit";

/** …must say the group has to be AT its limit for that to be true. */
const AT_CAPACITY = new RegExp(`\\b(?:${CAPACITY})\\b`, "i");

/** …and must not smuggle the unconditional refusal back in by ASSERTING the
 *  headroom is gone ("the group is full while this lasts, so it can't add
 *  another") instead of conditioning the refusal on it. Both regexes are needed:
 *  "if the group is full, it can't add another" states it too, and is correct. */
const STATES_CAPACITY = new RegExp(
  `\\b(?:is|are|stays?|becomes?|remains?)\\s+(?:already\\s+)?(?:${CAPACITY})\\b`,
  "i",
);
const CONDITIONS_ON_CAPACITY = new RegExp(
  `\\b(?:if|once|unless|when|whenever|while|as long as)\\b[^.]{0,60}?\\b(?:${CAPACITY})\\b`,
  "i",
);

function sentences(paragraph: string): string[] {
  return paragraph.split(/(?<=[.?!])\s+/).filter((s) => s.trim().length > 0);
}

describe("help/billing/groups — the every-organisation-suspended answer", () => {
  const article = allHelpArticles().get("billing/groups");
  const paragraphs = plain(article?.markdown ?? "").split(/\n{2,}/);
  const answer = paragraphs.find((p) => ALL_SUSPENDED.test(p));

  it("still exists at all", () => {
    // What this buys is a LEGIBLE FAILURE, not coverage — be precise about
    // which, because the difference decides whether the rules below can be
    // trusted on their own. Delete the paragraph and every rule reds anyway,
    // but as `TypeError: Cannot read properties of undefined (reading 'split')`
    // from `sentences(answer!)`, which reads like a broken test rather than
    // like missing copy. This one names the actual cause first.
    expect(article, "content/help/billing/groups.md is missing").toBeTruthy();
    expect(
      answer,
      "no paragraph in groups.md answers what happens while every organisation in the group is suspended",
    ).toBeTruthy();
  });

  it("does not say the group loses the add-ons it is still paying for", () => {
    // groupOrgLimit's degenerate branch answers `plan base + addonBonusForWallet`.
    // Prose that names only the PLAN describes a cap this code does not return.
    const offenders = sentences(answer!).filter(
      (s) => LIMIT_FALLS.test(s) && !KEEPS_ADDONS.test(s),
    );
    expect(
      offenders,
      `lib/billing-group.ts adds the purchased extra-organisation riders back on top of the plan base in this branch, but this says the limit falls to the plan alone:\n  - ${offenders.join("\n  - ")}`,
    ).toEqual([]);
  });

  it("does not say they stop counting while naming them", () => {
    // The half the rule above CANNOT see, and the reason it is not enough on
    // its own: "…falls to its plan's own limit and the add-ons you've bought
    // stop counting until then" satisfies KEEPS_ADDONS — it names them — while
    // asserting the exact inverse of billing-group.ts:219-220. A presence rule
    // pins the word; this pins the claim.
    const offenders = sentences(answer!).filter((s) => DENIES_ADDONS.some((r) => r.test(s)));
    expect(
      offenders,
      `the purchased riders are added back on top of the plan base in this branch, so nothing here may say they stop counting:\n  - ${offenders.join("\n  - ")}`,
    ).toEqual([]);
  });

  it("only refuses another organisation when the group is at that limit", () => {
    // The fallen limit is still a LIMIT, not zero: a group of 3 with a Pro cap
    // of 5 has room throughout. `assertWithinGroupCap` refuses on count, not on
    // suspension, so an unconditional "can't add another" is false for every
    // group that is not already full.
    const offenders = sentences(answer!).filter(
      (s) => CANNOT_ADD.test(s) && !AT_CAPACITY.test(s),
    );
    expect(
      offenders,
      `the cap refuses on the organisation COUNT, so this claim is only true for a group already at its limit:\n  - ${offenders.join("\n  - ")}`,
    ).toEqual([]);
  });

  it("conditions the refusal on that limit rather than asserting it", () => {
    // Same mirror. "The group is full while this lasts, so it can't add another
    // organisation meanwhile" satisfies AT_CAPACITY — it says "full" — while
    // restating the unconditional refusal as a fact about every group in this
    // state. STATES_CAPACITY alone would also flag the CORRECT phrasing ("if
    // the group is full, it can't add another"), which is why the second regex
    // is not optional: only an unconditioned assertion is an offender.
    const offenders = sentences(answer!).filter(
      (s) => CANNOT_ADD.test(s) && STATES_CAPACITY.test(s) && !CONDITIONS_ON_CAPACITY.test(s),
    );
    expect(
      offenders,
      `whether the group has headroom is a fact about its organisation COUNT, not about the suspension — this states it as though every group in this state were full:\n  - ${offenders.join("\n  - ")}`,
    ).toEqual([]);
  });
});
