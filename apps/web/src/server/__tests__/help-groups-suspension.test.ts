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

/** A sentence that says the group cannot add an organisation. */
const CANNOT_ADD = /\b(can'?t|cannot|unable to)\b[^.]*\b(add|added|take on)\b/i;

/** …must say the group has to be AT its limit for that to be true. */
const AT_CAPACITY = /\b(full|no room|already using|at (that|the|its|this) limit)\b/i;

function sentences(paragraph: string): string[] {
  return paragraph.split(/(?<=[.?!])\s+/).filter((s) => s.trim().length > 0);
}

describe("help/billing/groups — the every-organisation-suspended answer", () => {
  const article = allHelpArticles().get("billing/groups");
  const paragraphs = plain(article?.markdown ?? "").split(/\n{2,}/);
  const answer = paragraphs.find((p) => ALL_SUSPENDED.test(p));

  it("still exists at all", () => {
    // The discriminator for both rules below: each of them is a per-sentence
    // rule, so deleting the answer would satisfy them vacuously.
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
});
