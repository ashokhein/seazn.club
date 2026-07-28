// THE APPROVED WORDING of the billing-help copy that keeps regressing —
// every surface of it, not only its paragraphs.
//
// ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
// Three consecutive rounds of the v17 truth-in-copy wave shipped or preserved a
// falsehood in this copy, and each round was caught by a person reading
// the copy against the code — never by a rule. The rules were all denylists
// (banned phrasings, banned vocabularies, banned "grammatical forms"), and a
// denylist can only contain what its author thought of. Measured, each time by
// someone other than the author: 1/12, then 0/12.
//
// This file is the other half of the answer. It does not generalise, so there is
// no phrasing that evades it: the surface either says the approved words or it
// does not.
//
// ── IF A TEST SENT YOU HERE ──────────────────────────────────────────────────
// The test is a GATE, not a bug. You changed one of these surfaces — a
// paragraph, a heading, a list item, a table row or a frontmatter field — and the
// change needs one deliberate step before it ships:
//
//   1. Read your new wording against the code it describes — the source of truth
//      is named in each entry's `why`, and it is a file path, not a memory.
//   2. Paste the failing test's "on disk:" string into that entry's `text`.
//   3. Say in the commit message what changed and what you checked it against.
//
// That is the step that was skipped three times. It costs a few minutes; the
// falsehoods it is meant to catch have each been about money an organiser is
// charged.
//
// The digests here are taken over NORMALISED text — `claimSurfaces` output, so
// markdown emphasis and link syntax are already stripped, headings are their
// text, and a frontmatter field is "<key>: <value>". Copy the digest the failure
// prints rather than recomputing one by hand.
import type { ApprovedParagraph } from "@/lib/copy-truth";

/** `content/help/billing/event-pass.md`. */
export const APPROVED_EVENT_PASS: ApprovedParagraph[] = [
  {
    id: "event-pass.md#opening",
    find: /^An Event Pass upgrades one competition/,
    why: "the pass's SCOPE — one competition, and only while that competition runs. Source of truth: lib/entitlements.ts (org_has_feature, PASS_END_GRACE_DAYS) and V328/V334.",
    text: "An Event Pass upgrades one competition while it runs — bigger limits, the organiser extras that make an event look the part, and a cheaper platform fee — without a monthly subscription.",
  },
  {
    id: "event-pass.md#when-it-stops",
    find: /^A pass lifts the plan while its competition is running/,
    why: "WHEN the pass stops applying. Source of truth: lib/entitlements.ts (PASS_END_GRACE_DAYS = 7, completed/archived) and V334.",
    text: "A pass lifts the plan while its competition is running. It stops once that competition is over:",
  },
  {
    id: "event-pass.md#fee-lock",
    find: /^Your entry-fee rate is the exception/,
    why: "what an entrant is charged after the pass ends. Source of truth: server/usecases/registrations.ts — it is the ONLY writer of competitions.fee_percent, its `and fee_percent is null` makes the stamp first-wins, and it records what the first paid CARD entry was actually charged (an offline entry carries no rate). A pass bought after that entry cannot lower the locked rate.",
    text: "Your entry-fee rate is the exception. A competition's platform fee is fixed by its first paid card entry: whatever rate that entrant was charged is the rate every later entry in that competition pays, and it does not move when the pass stops applying. So if the first card entry was taken while the pass was live, the pass's cheaper rate rides on to the end. If the competition had already taken a paid card entry before the pass was bought, it stays on the rate it locked in then — buying a pass does not lower an already-locked rate, so buy before you open entries, not after. Only a competition with no paid card entry yet follows your plan's live rate.",
  },
];

/** `content/help/billing/plans.md`, the `## Event Pass` section only. */
export const APPROVED_PLANS_PASS: ApprovedParagraph[] = [
  {
    id: "plans.md#event-pass-opening",
    find: /^One-time upgrade for a single competition/,
    why: "the pass's scope again, on the page most readers meet first. It said 'for that event's lifetime' until this wave, which V328/V334 contradict. Source of truth: lib/entitlements.ts.",
    text: "One-time upgrade for a single competition, while that competition is still running, without a subscription. It comes in two sizes, and the only difference between them is how big that one event may get:",
  },
];


/**
 * Every USER-VISIBLE SURFACE of `content/help/billing/event-pass.md`, in order,
 * as a digest: the frontmatter fields, every heading, and every paragraph, list
 * item and table row.
 *
 * FIX ROUND 3 — this used to say "every paragraph … the WHOLE article" while
 * pinning neither frontmatter nor headings, because `proseBlocks` filters both.
 * A reviewer delivered the wave's two flagship falsehoods through a heading and
 * through `description:` and the suite stayed green. Both surfaces are rendered:
 * `description` is the lead paragraph under the title, the page metadata, and
 * the search-result snippet.
 *
 * The whole article, because every paragraph of it is a claim about this one
 * product — there is no part of it that is not a statement about what a buyer
 * gets and for how long.
 *
 * See `inventoryFaults` for why this is a digest list and not prose, and the
 * header of this file for what to do when it fails.
 */
export const APPROVED_EVENT_PASS_INVENTORY: string[] = [
  "7af62a47607d7223",
  "74fb0e84d81cf750",
  "7b44a9ceda103f3a",
  "2b5ae63b6b4f7fef",
  "c265587d5f9e7989",
  "ab3d2d6b1335de57",
  "57618eb0b22ecf4c",
  "c568f8fe6e21cf2a",
  "ca5e9f43ca10e67f",
  "838e381d03407571",
  "ff0840ec5e1d5748",
  "293db3d817dc1664",
  "d30d9ef9b7e39dcd",
  "d245f2a2cbe8b0d6",
  "dd3d5b5673e222ca",
  "6b72dd9495e4af80",
  "ce57acff6db52773",
  "9389b83536af8fa1",
  "193ac3fc3eb05678",
  "1b57ba96756ac962",
  "fcd1bcb9b15230dd",
  "9cdc77f8e4467e2c",
  "4ebceeab83e6a5bf",
  "3ea37f8416583be0",
  "219ccaea5a3878ae",
  "6feca5577c55cf2b",
  "170d10914abdbfe5",
  "c42978cab6965d56",
  "331525dbff809017",
  "32654b5a563aabb6",
  "f9124c9f5c781c13",
  "f1006b950ce393b1",
  "1fe75e6f574e7583",
  "e561392e6cbc80d2",
  "0e1daac0eb19c834",
  "c5c24fdd24f71ce1",
  "867aceb779b0f4db",
  "4f264c9aab6192ce",
  "70414ad4d8194580",
  "ff1027402c486eac",
  "fa7fc864190f0cc0",
  "03c00c96e8e4b592",
  "f5f433f5d5994689",
  "813d51ff5b1e6a03",
  "fb4935c8a0600ef4",
  "2e4b128e7b5331ea",
  "09c784bdca897d29",
  "10c39c76a97d3772",
  "057ca7fca5ccd0b0",
  "1bb443d58b849161",
  "9c62d251033d27b5",
  "c503ebdc56e74a10",
  "157334bc6c0df3e8",
  "9e1079e896d70264",
  "5bc994f6cd963522",
];

/**
 * The WHOLE of `content/help/billing/plans.md`, on the same terms.
 *
 * FIX ROUND 3 — this used to pin only the `## Event Pass` section, so the same
 * falsehood pasted into a sibling section raised zero faults. Scoping by section
 * is exactly how the earlier fee mutation escaped (it landed in a fine-print
 * list, not in a named paragraph), and every section of this file makes a
 * money-bearing claim: the fee ladder, the extra-organisation rate, the
 * proration table. Pinning the section and calling it the file was the same
 * defect as pinning the paragraphs and calling it the article.
 *
 * The cost is that every edit to any plan's copy now needs a re-approval. That
 * is a real tax on whoever edits this page next; it is recorded in the wave
 * notes so it is not mistaken for a broken test.
 */
export const APPROVED_PLANS_INVENTORY: string[] = [
  "bc2337dbe88e419f",
  "5b2cc6eea4cf751a",
  "5ef78cfff635a513",
  "5a5a9da7d2c5e80b",
  "4cc311ddc69a48c1",
  "4d5875384bf155e4",
  "43e1d69d597e5579",
  "b3b732cc02d27ad8",
  "9fea5a1e65adc92a",
  "23ead2d9846fff5d",
  "1d48d4377c637fbb",
  "87619eb00e3415c4",
  "88f54c8d84fe39f9",
  "894ad2338e0976bf",
  "e14a6ded6b393859",
  "2f2961e11a66159d",
  "44379ceba055ec0f",
  "f8caf2ade16bbe59",
  "1bd31d9b7a370257",
  "63402ce5db94d1d1",
  "d2190ce79f9684a3",
  "87261be9da787175",
  "83ad164e750b9232",
  "beaab221487f9585",
  "edd2b6da9a126c56",
  "077d725be913cdc7",
  "0acb8e961819e27a",
  "4ee173df88b4ac53",
  "da146eaf5a60a77b",
  "36e15d26466a260a",
  "03e4c9c866a25934",
  "d2190ce79f9684a3",
  "bc09bd75cc18ee11",
  "3ceba9b2fd13b8c6",
  "3c0bb9276a12a253",
  "0ca68a771384ef53",
  "6fa96bd59b17b841",
  "09c784bdca897d29",
  "951db7b9a2c1569d",
  "ac7b429848f9f114",
  "cf5ec66b42651197",
  "36cda4bf12f7677b",
  "c75ef841931dc4cd",
];

/**
 * The WHOLE of `content/help/billing/add-ons.md` (v17 gap wave 7, task 7, #299).
 *
 * WHY A BRAND-NEW ARTICLE IS GATED FROM DAY ONE, rather than after it has
 * carried a falsehood the way the two above did. Everything on this page is a
 * statement about money an organiser is charged — what each add-on costs, on
 * what cadence, who may buy it, and what happens when it stops — and it makes
 * the rate claim (`no more than half the base rate`) that this wave has now
 * spent four rounds correcting on other surfaces. The two articles above were
 * pinned only after a lexical rule was measured at 1/12, 0/12, 6/30 and 1/40
 * against sets their own authors had not written; there is no reason to repeat
 * that experiment on a page whose claims are the same shape.
 *
 * ── A GATE PROVES DELIBERATE, NEVER TRUE ─────────────────────────────────────
 * Round 1 of this article was inventory-approved and shipped THREE false money
 * claims, and the `why` notes below named the very files that contradicted
 * them. That is not a defect in the gate; it is the gate's contract. Approving
 * a digest records that somebody chose these words — it cannot record that they
 * checked them. So each bullet below now states WHAT IS ASSERTED, in the words
 * the article uses, next to the code that decides it. Re-approving means
 * reading the file and confirming the assertion still holds, not re-recording
 * a hash.
 *
 * WHAT THE ARTICLE ASSERTS, AND WHAT DECIDES IT:
 *
 *  - "the credits themselves never expire", one-time, whole-wallet.
 *    `config/stripe-plans.json` `packs[]` (no `interval`), and
 *    `lib/entitlements.ts` `addonBonusForWallet` keying the sum on
 *    `coalesce(group_subscription_id, org_id)`.
 *
 *  - "raises ONE organisation's member limit by one", monthly, payer-only, and
 *    "added to your next invoice rather than charged on the spot".
 *    `server/usecases/extra-seats.ts` — `requireBillingOwner` (payer gate), a
 *    subscription ITEM on the group's existing subscription (`:79`), and
 *    `proration_behavior: "create_prorations"` on create/raise (`:75`, `:83`)
 *    against `"none"` on removal (`:64`). ROUND 1 SAID "charged pro rata
 *    straight away" AND WAS WRONG: `create_prorations` books the adjustment
 *    onto the NEXT INVOICE rather than charging immediately — stated in
 *    `server/usecases/billing-events.ts:738-740`, and the product's own UI copy
 *    already had it right (`en/ui.json` `addOns.extraOrg.prorateUp`, which
 *    deliberately does not say "now").
 *
 *  - "raises ONE competition's limit by 32", permanent, stacking, owner-gated,
 *    "never lifts an organisation-wide limit".
 *    `server/usecases/size-pack-checkout.ts` (owner-of-the-competition's-org
 *    gate; the group card only when that owner IS the payer; a 30s idempotency
 *    bucket that does NOT block a genuine second pack) and
 *    `stripe-plans.json` `size_packs[0]`. The scope claim is
 *    `addonBonusForWallet`'s `target_competition_id` predicate: a comp-scoped
 *    row cannot match an org-level cap read.
 *
 *  - "Pro covers 5 and Pro Plus covers 10" — `plan_entitlements.orgs.max_owned`,
 *    set by V314. Asserted against the LIVE matrix, not restated here.
 *
 *  - "no more than half the base rate" for a slot INSIDE the plan, and "on a
 *    monthly bill it matches that half rate exactly, and on an annual bill it
 *    does not … about a third more over a year".
 *    `lib/org-addons.ts:95-107` names this exact trap: the rider is a MONTHLY
 *    price on every plan, so an annual Pro group pays 900/month (~10800/year)
 *    for a rider against 7900/year for an in-plan slot. Measured from the seed:
 *    Pro $108/yr vs $79/yr (+36.7%), Pro Plus $228/yr vs $163/yr (+39.9%).
 *    ROUND 1 SAID "charged at exactly that same rate" AND WAS WRONG — an
 *    unqualified comparative price claim one clause after the one it had just
 *    qualified.
 *
 *  - "An extra seat freezes members … Owners are never frozen."
 *    `server/usecases/entitlement-freeze.ts` `frozenMemberIds` (`:103`) reads
 *    `getLimit(orgId, "members.max")`, which SUMS the add-on bonus, and exempts
 *    owners explicitly (`:113-116`).
 *
 *  - "An extra organisation does not freeze anything … what it loses is the
 *    ability to add another."
 *    `orgs.max_owned` IS NOT A FREEZE AXIS. `entitlement-freeze.ts` freezes
 *    exactly two things — `competitions.max_active` (`:64`) and `members.max`
 *    (`:104`) — and `lib/billing-group.ts:411-414` states the cap is
 *    ADMISSION-ONLY: `assertWithinGroupCap` checks `count + 1 > limit` on the
 *    way IN and "is never re-evaluated against organisations that already
 *    exist". ROUND 1 CLAIMED THE EXCESS FREEZES AND WAS WRONG. The companion
 *    claim — that you cannot cancel your way over the line — is the 423 usage
 *    floor in `server/usecases/extra-orgs.ts:144-166`.
 *
 *  - "nothing is deleted" — `lib/entitlements.ts` `COUNTING_ADDON_STATUSES`:
 *    'canceled' is frozen-not-deleted (V323).
 *
 * NOT PINNED BY THIS INVENTORY, and therefore free to rot: link TARGETS.
 * `claimSurfaces` reduces `[text](/url)` to `text`, so repointing a `mailto:`
 * or a help URL raises zero faults here. (Distinct from the link-TITLE hole,
 * filed as #338.)
 */
export const APPROVED_ADD_ONS_INVENTORY: string[] = [
  "58a683b53e5184b9",
  "2f6f0a90f146909c",
  "86f7fbbc9cd26f08",
  "535adfa4bbb23fb0",
  "7bc95c0f047118eb",
  "ecd4ad8f51fde6ab",
  "f58db85d7d962581",
  "7a3863a273a702d6",
  "fe1787304c8e8f0c",
  "696896c6174d0812",
  "81f45d76b157c68a",
  "5cbbcf82d4703a2e",
  "51ec9ed81333165c",
  "05b585e71c12137b",
  "b315422a65436656",
  "628281436c3b5d97",
  "57ab4cb8d1c7ae64",
  "dd3682cfbbbd86eb",
  "904600a779329e0b",
  "81ba6ce07303ccdc",
  "88ce7e8f444d70eb",
  "122c884440848810",
  "e0ff162b4d324107",
  "00df8be3e9bd06ef",
  "df7321201a99bd2c",
  "7151ed1350e7f11f",
  "7d1518387c5c90e4",
  "d1d87a9a3dbdeb8e",
  "b50fa0d68d469172",
  "2a1276c7fbee0c93",
  "704faf902d99b14c",
  "89e6a00cfa216278",
  "e0bc899381ce86af",
  "fe061d7659564782",
];
