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
