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
  "32654b5a563aabb6",
  "d90e342a66f0ff56",
  "f1006b950ce393b1",
  "f39d96b7fbbbfc13",
  "665584fd0671d579",
  "3f3be96ac6e6be4e",
  "a28f1eacfd464458",
  // Approved 2026-07-29 (v17 gap #353). ONE new paragraph, inserted here: "The
  // same line decides when a pass can be BOUGHT. You can buy a pass while its
  // competition is still running, or during the 7-day grace after its end date;
  // once a competition has passed that line the purchase is refused rather than
  // sold, so you can never pay for a pass that would apply to nothing."
  //
  // Read against the code before recording, per this file's own rule. The claim
  // is "the buy window is the same window as the apply window", and the code it
  // describes is `lib/entitlements.ts`'s `passLockReason` — status in
  // {completed, archived}, or ends_on + PASS_END_GRACE_DAYS (7) < today (UTC) —
  // which is now what `api/billing/pass-checkout/route.ts` gates the purchase
  // on, and what `pass_applies` (V343) gates the billing page's offer list on.
  // So the two windows are literally the same predicate, and "7 days" is that
  // constant rather than a number written down twice. "Refused rather than sold"
  // is the 410, which is raised BEFORE any Stripe session is created — no money
  // moves, which is the part of the sentence a reader is relying on.
  "3b3bc011debe7da5",
  "9a68888ef2d9aa1a",
  // Approved 2026-08-05 (#376). ONE new section — a heading and six paragraphs,
  // inserted here: "When a competition closes to new passes". The claim is that
  // the line which stops a pass APPLYING is also the line which stops one being
  // SOLD, that it is a property of the competition rather than of a purchase,
  // and that the offer is now withdrawn rather than left on screen in front of a
  // checkout that refuses.
  //
  // Read against the code before recording, per this file's own rule:
  //   - the two reasons and the 7-day grace are `lib/entitlements.ts`
  //     `passLockReason` / `PASS_END_GRACE_DAYS`, unchanged by #376 — the same
  //     predicate the SQL `pass_applies` (V343) uses, which is why the section
  //     says "that same line" rather than writing a second rule down.
  //   - "not offered anywhere", four places: the chip on
  //     `c/[compSlug]/page.tsx` and `c/[compSlug]/settings/page.tsx` (both
  //     render `competition-pass-entry.tsx`, which returns the closed link
  //     instead of the buy pill once `usePassGateState()` is "closed"), the ⋯
  //     menu on `o/[orgSlug]/page.tsx:235` (`!isPassLocked(...)`), and the
  //     billing page's offer list (`pass_applies`, V343).
  //   - "This competition is closed to Event Passes" is the literal
  //     `upgrade.closed.title` string, rendered by `ClosedPanel` in
  //     `c/[compSlug]/upgrade/page.tsx`; the two next steps, and which reason
  //     gets which, are its `Record<PassLockReason, …>` — `terminal` →
  //     `routes.competitionNew`, `past_ends_on` → `routes.competitionSettings`.
  //     Both links are gated on the viewer being able to act, which is why the
  //     copy says only an editor sees one.
  //   - "the checkout behind it refused the sale" is the 410 in
  //     `api/billing/pass-checkout/route.ts:185` — still the server's answer,
  //     and the defect #376 was filed about was that the offer did not agree
  //     with it.
  //   - "correcting either one puts the offer back" is compute-at-read: no
  //     column stores the verdict (`passLockReason`'s own doc comment), which
  //     is the same property `lib/competition-wrapup.ts`'s header gives as the
  //     reason the product PROMPTS for a wrap-up rather than sweeping a status.
  //   - the paid-plan paragraph is `upgrade-page-state.ts`'s paid arm, where
  //     #376 added `closedToPasses === null` to the #327 exceeding-rung offer —
  //     so the L offer a Pro org sometimes gets is withdrawn past the line too.
  //   - the "already bought" paragraph deliberately does NOT say a held pass is
  //     unaffected by the line. `usePassGateState` resolves "ended", not
  //     "held", once `lockReason` is set, and the resolver has already stopped
  //     honouring the row (SPEC-4 §7); the OFFER side is all #376 changed, and
  //     the two sections above this one already state the applying side.
  "4901d7ce5eea800a",
  "e83c931a71f7d62e",
  "f7d474e47cbd8920",
  "d4512720ca211814",
  "8c072be7bd782c73",
  "51f349d614c306b2",
  "38a84f5715684c23",
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
  // Re-approved 2026-08-05 (#376), "Where do I buy one?". The four buy links it
  // lists were unconditional; three of the four are now suppressed for a locked
  // competition and the fourth always was. One sentence added, saying they go
  // together and why. Read against `competition-pass-entry.tsx` (the overview
  // and settings chip, "closed" arm), `o/[orgSlug]/page.tsx:235`'s
  // `!isPassLocked(c.status, c.ends_on)` on the ⋯ menu item, and the billing
  // page's `pass_applies` (V343) offer list.
  "f84bab0a6dac4e46",
  // Re-approved 2026-07-29 (W8 final review, M-1). Both surfaces carried a
  // SUPERSET claim — "your plan already grants more" and "buying one would give
  // you less than you hold" — which is #337: V341 gives event_pass_l unlimited
  // entrants per division against pro's 256 (V270), so Pro is NOT a superset of
  // the L rung and neither sentence is true for an L holder.
  //
  // Read against the code before re-recording, per this file's own rule. The
  // approved replacement is the FEATURES form, which is literally true for both
  // rungs and is the form `api/billing/pass-checkout/route.ts:42-50` already
  // uses — its comment records the same correction being made there when L
  // shipped. The help article never got it; W8 then re-approved these two
  // digests with the stale clause still inside them, which is how a positional
  // gate freezes a falsehood faithfully.
  "e5d3c0403b1876cc",
  // Re-approved 2026-08-05 (#376), "What does the competition's upgrade page
  // show me?". That answer enumerates the page's states and was missing the one
  // #376 added, so it described a checkout on a page that no longer offers one.
  // One clause added for the `closed` state. Read against
  // `lib/upgrade-page-state.ts` — `{ kind: "closed"; reason; canBuy }`, which
  // precedes both offer arms — and against `ClosedPanel` in
  // `c/[compSlug]/upgrade/page.tsx`, which renders a heading, the one reason
  // sentence and at most one link: no rung, no price, no receipt stub.
  "e0f0b80a2a5089c6",
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
  // Community's paragraph, re-approved for V354/V355. It used to end "When
  // something is finished, complete or archive it to free the slot", which read
  // as covering both quotas in a sentence that names competitions AND divisions
  // — and is now false for half of them. It now says the competition rule, then
  // names the division rule as different.
  //
  // Read against the code before recording, per this file's own rule. The
  // competition half is `usecases/competitions.ts`'s `assertActiveQuota`:
  // `competitions.max_active` counts draft/published/live, so completed and
  // archived genuinely free the slot. The division half is
  // `usecases/divisions.ts`'s createDivision count — `d.archived_at is null or
  // (division_has_results(d.id) and d.slot_waived_at is null)` — so an archived
  // division still consumes its slot once it has results, and only an UNPLAYED
  // one hands it back. `division_has_results` is defined in
  // db/migration/deltas/V355__division_results_abandoned_outcome.sql: decided,
  // finalized or forfeited, or abandoned with a non-`no_result` outcome. The
  // linked article (divisions/archive.md) is the long form of the same rule.
  "c7fa6c9c9e79fc08",
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
 *  - "An extra seat stops you adding members, and makes the ones over the
 *    limit read-only … owners never are."
 *    `frozenMemberIds` (`entitlement-freeze.ts:103`) reads
 *    `getLimit(orgId, "members.max")`, which SUMS the add-on bonus, and exempts
 *    owners explicitly. ROUND 2 SAID "re-checked on every write" AND OVERSTATED
 *    IT: `assertMemberNotFrozen` has exactly ONE production call site,
 *    `server/api-v1/auth.ts:213-214`, gated on `via: session` AND
 *    `scope === "write"` AND `role === "admin"` — a bearer token returns from
 *    `apiKeyAuth` first, so API-KEY writes are never freeze-checked. What IS
 *    enforced everywhere is ADMISSION: `lib/invites.ts:72-79` and
 *    `app/api/orgs/[id]/members/[userId]/role/route.ts:47-54` both count the
 *    quota and throw `PaymentRequiredError` inside the same transaction as the
 *    write. (Both were previously cited at the line that merely RESOLVES the
 *    quota key, six and twenty-five lines earlier respectively — and the
 *    route's own comment on that line says "before the tx", the opposite of
 *    what it was cited for.)
 *
 *    ROUND 3'S REPLACEMENT WAS ALSO WRONG about the surface: it said "enforced
 *    on our public API today", but on that API the normal caller is a bearer
 *    `sc_` key and `server/api-v1/auth.ts:204` (`if (token) return apiKeyAuth(...)`) returns
 *    BEFORE the check — so API-key clients are not checked either. (Cited as
 *    `server/api-v1/auth.ts:210` for two rounds; :210 is a comment.)
 *
 *    AND ROUND 3'S OTHER HALF WAS FALSE OUTRIGHT. It said the freeze reaches
 *    "not the app's own screens". `lib/client-v1.ts:23-27` sends only
 *    `Content-Type` — no `Authorization` — so an in-app component hitting
 *    `/api/v1/orgs/**` takes the SESSION branch of `requireOrgAuth` and IS
 *    freeze-checked. Five screens write through it: `components/api-keys.tsx`
 *    (Settings → API), `components/news/composer.tsx`,
 *    `components/org-sponsors.tsx`, `components/sponsor-packages.tsx` and
 *    `components/org-payment-instructions.tsx`. An admin over `members.max`
 *    would have read this article, been told the app was exempt, and then hit a
 *    402 in Settings → API and the news composer.
 *
 *    THE GUARD PINNED THAT FALSEHOOD, and the reason generalises: it counted
 *    the 13 `app/api/v1/**` routes reaching `requireOrgAuth` and never asked
 *    WHO CALLS THEM. Counting a surface proves its SIZE, never its REACH. It
 *    now discovers the in-app callers, requires each to be declared with the
 *    surface name the copy uses, requires the copy to name every one, and
 *    asserts no caller sends an `Authorization` header — which is the fact that
 *    makes them session-authenticated and therefore freeze-checked.
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
  // FIX ROUND 6 (M1). Was "the number of organisations the group is actually
  // using", which names the wrong quantity: the floor is on the RIDER count,
  // not the org count. `ridersInUse` (`lib/billing-group.ts:431-437`) is
  // `clamp(liveOrgs - base - grantedBonus, 0, purchased)`, so a Pro group with
  // 6 live orgs has a floor of 1, not 6. Re-read against that function and
  // against `addOns.extraOrg.floorNote`, which already said it correctly.
  "80ea0dd21adfd486",
  "00df8be3e9bd06ef",
  "df7321201a99bd2c",
  "7151ed1350e7f11f",
  "7d1518387c5c90e4",
  "d1d87a9a3dbdeb8e",
  "b50fa0d68d469172",
  // FIX ROUND 6 (C1 + M2). Was "…not API-key clients and not the app's own
  // screens", and "Members already over the limit are MARKED read-only".
  //
  // C1: the app-screens half was FALSE. `lib/client-v1.ts:23-27` sends only
  // `Content-Type`, so in-app components hitting `/api/v1/orgs/**` take the
  // SESSION branch of `requireOrgAuth` (`server/api-v1/auth.ts:204` returns
  // from `apiKeyAuth` only when a bearer token is present) and ARE
  // freeze-checked. Five screens write through it — api-keys.tsx,
  // news/composer.tsx, org-sponsors.tsx, sponsor-packages.tsx,
  // org-payment-instructions.tsx.
  //
  // M2: nothing renders a MARK. `frozenMemberIds`
  // (`server/usecases/entitlement-freeze.ts:103`) has exactly one production
  // caller, `assertMemberNotFrozen` (`:123`) — no read model flags a member,
  // unlike competitions, which the module header says ARE flagged. "Treated as
  // read-only", resolved when a write arrives.
  //
  // ROUND 7: the C1 correction was RIGHT IN DIRECTION AND AN ORDER OF MAGNITUDE
  // SHORT. It named four screens (API keys, News, Sponsors, Payments) because
  // the guard behind it discovered callers by the single prefix
  // `/api/v1/orgs/`. But the freeze lives in `requireOrgAuth`, and
  // `requireResourceAuth` delegates to it — 83 write-scoped route files are
  // freeze-checked across 17 URL prefixes, and 47 component files write through
  // them. A frozen admin is blocked across essentially the whole editing
  // product, not four screens. Re-read against `server/api-v1/auth.ts`
  // (requireResourceAuth -> requireOrgAuth) and the measured caller walk.
  "066578c9f729b625",
  // ROUND 7 (M1's twin). This paragraph said the control "refuses to go below
  // the number of organisations the group is standing on" — the ORG count,
  // sixteen lines after the identical error was corrected at surface 23 and in
  // the same paragraph this article's freeze guard is named after. The floor is
  // the RIDER count: `ridersInUse` = clamp(liveOrgs - base - grantedBonus, 0,
  // purchased) (`lib/billing-group.ts:431-437`). Nothing asserted on the floor
  // at all before this round; both statements of it are now checked.
  "7e9eaa52377fc2e6",
  "89e6a00cfa216278",
  "e0bc899381ce86af",
  "fe061d7659564782",
];

/**
 * The WHOLE of `content/help/billing/groups.md` (v17 gap wave 7, task 7, round 3).
 *
 * GATED BECAUSE THE VOCABULARY WAS MEASURED AT 0/24 ON IT. Off-vocabulary false
 * rate claims pasted into this file — "costs 50% of the base rate", "half as
 * much as the first", "half of what the plan costs", plus native es/fr/nl —
 * shipped 119/119 green, as did an entire new help article. The same edit to
 * the gated `add-ons.md` redded immediately.
 *
 * That number also bears on the computed half-rate axis in
 * `help-copy-truth.test.ts`: the axis is computed THROUGH `en.halfClaim`, so
 * membership was being decided by a regex that catches almost nothing. Gating
 * the two articles on the axis is what makes the axis mean something.
 *
 * WHAT THIS ARTICLE ASSERTS, AND WHAT DECIDES IT:
 *  - the extra-organisation rate, five times — `stripe-plans.json`'s graduated
 *    tiers via `riderClaimShape`; only "no more than half" is true in all
 *    twenty plan x interval x currency combinations.
 *  - WHEN THE ATTACH CHARGE LANDS. `attachOrgToGroup` bills entirely through
 *    `syncGroupQuantity`, whose only Stripe mutation is
 *    `subscriptions.update` with `create_prorations`
 *    (`billing-groups.ts:327-330`) — the NEXT invoice, not the card, and the
 *    same behaviour the add-on paths have. Round 2 said "charged now" on six
 *    surfaces here on the strength of a stale comment.
 *  - the dunning window — real, but it is the next INVOICE that can fail;
 *    nothing is attempted against the card at attach.
 *  - "Removing never refunds, and adding never takes money from your card there
 *    and then" (`## No refunds, and the freed slot`). ROUND 5: this said
 *    "adding ALWAYS CHARGES IMMEDIATELY", false three ways — prorations book to
 *    the next invoice (`billing-groups.ts:327-330`), a freed-slot attach raises
 *    no proration at all (`previewAttachCharge:122`, `raising` requires
 *    `active > quantity_paid`), and a trial attach charges nothing (`:123`,
 *    `:320`). It also contradicted line 41 of this same article, which round 3
 *    had corrected.
 *
 *    THE GATE FROZE IT FAITHFULLY FOR TWO ROUNDS. That is not a failure of the
 *    gate; it is the gate's contract, and this wave's thesis in one line: an
 *    inventory proves a wording was DELIBERATE, never that it was TRUE. Only
 *    reading the sentence against `billing-groups.ts` found it, which is the
 *    step the fixture exists to force and which nobody had performed on this
 *    paragraph.
 *  - the freed slot, the fee lock, payouts, the detach modes — see the
 *    per-section notes in `server/usecases/billing-groups.ts`.
 */
export const APPROVED_GROUPS_INVENTORY: string[] = [
  "6dfdc975fd75c021",
  "56e3282cee657350",
  "889eb9bb8adb1b8f",
  "0b3f064c075f4830",
  "2c08e52c75400e40",
  "b27d737d14d930a1",
  "650ab572d939bca6",
  "f78e9f343b9dc2e8",
  "d2190ce79f9684a3",
  "87261be9da787175",
  "beaab221487f9585",
  "edd2b6da9a126c56",
  "9faecfa06325046c",
  "a09dc0137f8e8527",
  "e12f4df63f6cc9ea",
  "03db06a1af2d3405",
  // v17 gap #333, position 17. Read against `server/page-auth.ts`
  // requireBillingPage: the payer branch is entered only on
  // `subscriptions.owner_user_id` of the org's OWN group ("any organisation on
  // it"), and hands back role null / canEdit false while every other page in
  // the /o tree stays on requireOrgPage — which is what makes "the bill and
  // nothing else" true. The three tabs named are exactly the three that call
  // it: settings/{billing,credits,add-ons}/page.tsx.
  "8cca87480a6deb54",
  "696c2fcc2ecfec40",
  "a052c3f07ce2508c",
  "0efcbcbfd21cd2d3",
  "f3e48e76dfb4c932",
  "71f2718498988d98",
  "19f8dbd797ab2df3",
  "86457c10b518c75c",
  "670d6537399af0cb",
  "44b8772e6777bd12",
  "8d62189b191b015f",
  "bb6e0a58fdb569a4",
  "93cbb9e0a733ea84",
  "a082daadd09b8b31",
  "506437e366fdbb9f",
  "3eca421ec4c1ecd2",
  "ce62fde77df9f3cb",
  "af77535948d286c5",
  "791c29feee358ae2",
  "3b9f1b1cb23117b0",
  "afe3dfcd35264bc9",
  "45ac520e121a63aa",
  "845db4ff8eae0223",
  "3812af4fc53ba873",
  "7e50122fa44a6f4b",
  "f1eec393ae73101f",
  "e20498cfa56931d3",
  "858c8b7b0159c14f",
  "af0c83ae6240326a",
  "eb9b66040aaa25d8",
  "5b365c93cb4a5637",
  "7104f26a03ffde1e",
  "537d992c53d3e378",
  "cc5546e9475093dd",
  "68ae3680386824c4",
  "1687f37c2560ab80",
  "2a82d5d161253e15",
  "79756849efc57255",
  "25eb5c468a8a54a2",
  "9eb0591ae278ad76",
  "37e0ccd2e5e57b16",
  "80a8c63adbf7acf6",
  "aa38f07aed66bd26",
  "3b68d1b4c3fc4888",
  "cbfceb3121b039d5",
  "14babe148d741a28",
  "c1952e825277a576",
  "5a31bc0dd92a9d01",
  "529f239aa64eaa4e",
  "ef90d0b1078b0b3d",
  "7a89a4a943513245",
  "19438b187f04e834",
  "84701e090fcbf515",
  "ddc8366bdf93737f",
  "bb92ff4f463ccd7b",
  "29c9a5af721c8abb",
  "a04e4219f607e695",
  "2b57b36732a3e9fb",
  "16727d4791a0a08b",
  "c5c32d350da1d6b1",
  "09c784bdca897d29",
  "3d324adb3ee0b927",
  "e2fe25cfb8981353",
  "1415f62ed176347a",
  "a83851ffc59ddfeb",
  "290e525981e1463d",
  "364b1c1d4b1409c9",
  "8d2ecf6ae325690e",
  "7dde35de16939fb2",
  "2f102e765460c832",
  "3b281af0174847e4",
];

/**
 * The WHOLE of `content/help/getting-started/create-your-organisation.md`
 * (v17 gap wave 7, task 7, round 3).
 *
 * A file nothing in this wave had opened until the review found it stating the
 * extra-organisation rate at `:25`. Small, and gated for the same measured
 * reason as `groups.md`: it is a funnel page, it quotes the fee ladder and the
 * plan org caps, and the vocabulary that was supposedly defending it scored
 * 0/24.
 *
 * WHAT IT ASSERTS: the fee ladder (8/5/2/1, `plan_entitlements`
 * `registration.fee_percent`), the plan org caps (5 / 10, `orgs.max_owned`,
 * V314), the extra-organisation rate (`riderClaimShape`), and that Community
 * can already take card entry fees.
 */
export const APPROVED_CREATE_ORG_INVENTORY: string[] = [
  "5a9aee8c75f74828",
  "c7abb53b293957ff",
  "7780e9adec7a42e1",
  "97afdcb5cc7373e9",
  "332fd65e1bd72032",
  "b29441d979e91695",
  "b389c86ad2de4a26",
  "264f686b9b00d09f",
  "09c784bdca897d29",
  "37c315ff03bb75b3",
  "d78a55bea4454182",
  "ec33da78b550dcac",
];
