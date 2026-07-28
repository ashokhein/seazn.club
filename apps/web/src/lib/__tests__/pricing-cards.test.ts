import { afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  FREE_FEATURES,
  PASS_FEATURES,
  PLUS_CARD_FEATURES,
  PLUS_COMING_SOON,
  PRO_FEATURES,
  PASS_CREDIT_GRANT,
  ticketTiers,
} from "../pricing-cards";
import { SUPPORTED_CURRENCIES, lowestCreditPackAmount, passPrice } from "../currency";
import stripePlans from "@/config/stripe-plans.json";
import {
  BOUNDED_SCOPE_GRAMMAR,
  FALSE_PASS_PERMANENCE_PATTERNS,
  type FeatureGrants,
  PLUS_DIFFERENTIATOR_VOCAB,
  localeCreditLeadershipFaults,
  localePlusDifferentiatorFaults,
} from "@/lib/copy-truth";
import { sql } from "@/lib/db";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe("pricing cards", () => {
  it("stub bullets are drawn from the shared /pricing arrays (drift guard)", () => {
    const [community, pass, pro] = ticketTiers("usd");
    expect(community!.bullets.every((b) => FREE_FEATURES.includes(b))).toBe(true);
    expect(pass!.bullets.every((b) => PASS_FEATURES.includes(b))).toBe(true);
    expect(pro!.bullets.every((b) => PRO_FEATURES.includes(b))).toBe(true);
    expect(community!.bullets.length).toBeGreaterThanOrEqual(3);
  });
  it("prices come from lib/currency (multi-currency stays correct)", () => {
    const [, passUsd, proUsd] = ticketTiers("usd");
    expect(passUsd!.price).toBe("$29");
    expect(proUsd!.price).toBe("$19");
    expect(proUsd!.period).toBe("/mo");
    const [, passInr] = ticketTiers("inr");
    expect(passInr!.price).not.toBe("$29");
  });
  // v17 #294: the home stub still leads with M's price, because M is what the
  // lowest rung costs — but with two rungs on sale that figure is a FLOOR, not
  // the price. Unprefixed it reads as "an Event Pass costs $29", which is
  // false for half the product. Community has no prefix: Free really is free.
  it("marks the Event Pass price as a floor, and only that one", () => {
    const [community, pass, pro] = ticketTiers("usd");
    expect(pass!.prefix, "the pass is a ladder, so its price is a 'from'").toBeTruthy();
    expect(community!.prefix).toBeUndefined();
    expect(pro!.prefix).toBeUndefined();
  });

  /**
   * FIX ROUND 2 — the add-on line quoted a HARDCODED "$10" in all four locales
   * while every other price on /pricing goes through `formatMinor(…, currency)`
   * behind the CurrencySwitcher. The seed's cheapest pack is eur 900 / gbp 800 /
   * aud 1500 / inr 79900, so the literal was false in FOUR of five currencies —
   * exactly the defect #191 was filed for on the pass copy.
   *
   * Pinned to the SEED, not to a number: the floor is the smallest amount in the
   * switched currency, so adding a cheaper pack moves the advertised "from".
   */
  it("the credit-pack floor is the seed's cheapest pack, in every currency", () => {
    const packs = (stripePlans as { packs?: Array<{ price: { unit_amount: number; currency_options?: Record<string, number> } }> }).packs ?? [];
    expect(packs.length, "the seed has no credit packs to advertise").toBeGreaterThan(1);
    for (const currency of SUPPORTED_CURRENCIES) {
      const amounts = packs.map((p) =>
        currency === "usd" ? p.price.unit_amount : p.price.currency_options?.[currency],
      );
      expect(amounts.every((a) => typeof a === "number"), `${currency}: a pack has no price point`).toBe(true);
      expect(lowestCreditPackAmount(currency), currency).toBe(Math.min(...(amounts as number[])));
    }
    // The defect itself: the non-usd currencies must NOT resolve to usd's floor,
    // or a hardcoded "$10" would have been accidentally right and this guard
    // would prove nothing.
    const usd = lowestCreditPackAmount("usd");
    const differing = SUPPORTED_CURRENCIES.filter((c) => c !== "usd" && lowestCreditPackAmount(c) !== usd);
    expect(differing.length, "every currency matched usd — the seed lost its price points").toBeGreaterThan(2);
  });

  it("only the Event Pass glows", () => {
    expect(ticketTiers("usd").map((t) => Boolean(t.glow))).toEqual([false, true, false]);
  });

  // v17 (SPEC-6 A1): the graded per-division run cap became the credit wallet
  // (V322). The dead "10 AI schedule runs per division" bullet must stay gone —
  // the pass's credit story is the dedicated credits line, not a bullet.
  it("the retired AI-run-cap bullet is gone from the Event Pass card", () => {
    expect(PASS_FEATURES.join(" | ")).not.toMatch(/AI schedule runs/i);
    expect(PASS_FEATURES.join(" | ")).not.toMatch(/runs per division/i);
  });

  // The Event Pass credit grant is a one-time top-up with NO ai.credits.monthly
  // row in plan_entitlements, so pricing-cards is its single source. Pin it so
  // the card copy and the (future) wallet grant can't silently diverge.
  it("the Event Pass card quotes the +25 one-time credit grant", () => {
    expect(PASS_CREDIT_GRANT).toBe(25);
  });

  // v17 #294 — the L rung's $59 price point, per-currency, alongside M's. Both
  // rungs are resolved by `passKey` from the SAME stripe-plans.json `passes`
  // array stripe-sync seeds Stripe from, so a quoted price cannot drift from
  // the price object Stripe holds for that rung.
  it("passPrice resolves both Event Pass rungs, keyed by passKey", () => {
    expect(passPrice("usd", "event_pass")).toBe(2900);
    expect(passPrice("usd", "event_pass_l")).toBe(5900);
    expect(passPrice("gbp", "event_pass_l")).toBe(4900);
    expect(passPrice("eur", "event_pass_l")).toBe(5900);
    expect(passPrice("inr", "event_pass_l")).toBe(449900);
    expect(passPrice("aud", "event_pass_l")).toBe(8900);
  });

  // `passKey` is REQUIRED (no default), so a surface that forgets the rung is a
  // compile error rather than a page that quotes $29 for a $59 purchase. The
  // per-currency sweep is what makes that guarantee real: if any currency ever
  // resolved both rungs to the same amount, the picker would render two
  // identical prices and no other test would notice.
  it("quotes a DIFFERENT price for M and L in every supported currency", () => {
    const same = SUPPORTED_CURRENCIES.filter(
      (c) => passPrice(c, "event_pass") === passPrice(c, "event_pass_l"),
    );
    expect(same.join(", ")).toBe("");
    for (const c of SUPPORTED_CURRENCIES) {
      expect(passPrice(c, "event_pass_l"), `${c}: L must quote above M`)
        .toBeGreaterThan(passPrice(c, "event_pass"));
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// v17 gap wave 7 (#298 / #299) — THE TWO CARD BULLETS THAT CONTRADICTED THE
// MATRIX, and the shape of guard this wave has paid five times to learn.
//
// Two false bullets, from opposite directions:
//
//   PASS_FEATURES[0]      "Upgrades ONE competition, forever" — V328/V334 bind
//                         the pass to the competition's own lifecycle.
//   PLUS_CARD_FEATURES[2] "AI-assisted scheduling", under an "Everything in
//                         Pro, plus…" frame — `scheduling.ai` is true on all
//                         five plan keys, so it differentiated nothing.
//
// ── WHY THE PRIMARY RULE HERE IS A PINNED STRING ─────────────────────────────
// A denylist of phrasings does not work, and this wave measured that five
// times: guards scored 15/15 and 32/32 against probes their own authors wrote,
// then 0/24 and 0/32 against a reviewer's; one went 12/12 to 6/30 on a fresh
// set by the SAME author an hour later. Any rule that reads the sentence scores
// on the examples its author imagined.
//
// So the primary net is an INVENTORY: the approved bullets, pinned verbatim,
// with a `why` naming the code that decides the claim. It cannot be evaded by
// rewording and needs nobody to have imagined the right falsehood. The
// vocabulary (imported from @/lib/copy-truth — never forked) is the SECONDARY
// net, and its recall is measured below against a set written after these rules
// were final, with both numbers committed.
// ─────────────────────────────────────────────────────────────────────────────

/** One card's approved bullet list. */
interface ApprovedBullets {
  /** The exported array, by name. */
  array: string;
  /** What the bullets claim, and the code that decides whether it is true.
   *  A file path, so re-approval means re-reading the code — not re-recording
   *  a snapshot. */
  why: string;
  bullets: readonly string[];
}

const APPROVED_CARD_BULLETS: ApprovedBullets[] = [
  {
    array: "FREE_FEATURES",
    why: "the Community card on /pricing (and, sliced, the home ticket stub). Numbers pinned to the live matrix by CARD_SURFACES below: competitions.max_active, divisions.per_competition.max, entrants.per_division.max and registration.fee_percent, all on plan_key 'community'. The remaining bullets name capabilities community genuinely has (registration.paid, discovery.listed, dashboard.public.max >= 1).",
    bullets: [
      "10 active competitions, 4 divisions",
      "64 entrants per division",
      "League, groups + knockout & swiss formats",
      "Online registration & entry fees (8% fee)",
      "Live standings & public dashboard",
      "Listed on the seazn.club showcase",
    ],
  },
  {
    array: "PASS_FEATURES",
    why: "the Event Pass card on /pricing (and, sliced, the home ticket stub). Bullet 1 is the pass's DURATION — V328/V334 `org_has_feature` drop the pass arm once the competition is archived/completed or 7 days past ends_on, so it is bounded, not permanent; that is asserted by passBulletDurationFaults. Bullet 2 carries BOTH rungs' caps and bullet 4 the fee, all pinned to the live matrix by CARD_SURFACES below: divisions.per_competition.max and entrants.per_division.max on event_pass AND event_pass_l (L's entrant cap is null, so the copy must say 'unlimited'), registration.fee_percent on event_pass, and community's registration.fee_percent for the 'not 8%' comparison. Bullets 3 and 5-7 name boolean grants (formats.advanced, exports.branded, dashboard.player_profiles, sponsors.*, realtime) that the pass lifts off community.",
    bullets: [
      "Upgrades ONE competition while it runs",
      "10 divisions, 128 entrants each — 20 & unlimited on L",
      "Advanced formats — double elim, ladders",
      "5% platform fee on entry fees, not 8%",
      "Branded exports & public player cards",
      "Sponsor tiers & paid sponsorship packages",
      "Realtime scoreboard & slideshow",
    ],
  },
  {
    array: "PRO_FEATURES",
    why: "the Pro card on /pricing (and, sliced, the home ticket stub). Pinned to the live matrix by CARD_SURFACES below: competitions.max_active and divisions.per_competition.max are null on pro, so 'Unlimited competitions & divisions' must stay literally true; entrants.per_division.max is 256 and registration.fee_percent is 2. The capability bullets are boolean pro grants (scoring.*, stats.player, api.access, dashboard.branding for the badge, discipline.enforced, news.auto, officials.marks). It must NOT claim a pro_plus-only feature — crossCardExclusivityFaults judges that against the rows.",
    bullets: [
      "Unlimited competitions & divisions",
      "256 entrants per division",
      "Entry fees at a 2% platform fee",
      "Ball-by-ball & rally scoring, player stats",
      "Officials, exports, API keys, device links",
      "Remove the “Powered by Seazn” badge",
      "Suspensions & discipline tracking",
      "Rate your match officials",
      "Auto-drafted result posts",
    ],
  },
  {
    array: "PLUS_CARD_FEATURES",
    why: "the Pro Plus card on /pricing, read under the `pricing.plus.note` frame 'Everything in Pro, plus…' — so every bullet asserts EXCLUSIVITY and must name something the lower plans lack. Pinned to the live matrix by CARD_SURFACES below (members.max / teams.max / clubs.max are null on pro_plus, registration.fee_percent is 1) and by localePlusDifferentiatorFaults (officials.auto, api.write, support.priority are pro_plus-only) and localeCreditLeadershipFaults (ai.credits.monthly 10/60/200, so 'largest' is the matrix's own ordering). scheduling.ai is granted on EVERY plan key and must never appear here. THE TEXT IS DICTIONARY-BACKED: this array pins count and order, `pricing.plus.f1-f5` is what renders.",
    bullets: [
      "Unlimited members, teams & clubs",
      "1% platform fee on entry fees",
      "Largest monthly AI credit grant",
      "Auto officials assignment",
      "Write API access & priority support",
    ],
  },
  {
    // ── FIX ROUND 1 (I3): this block was covered by NOTHING ──────────────────
    // `PLUS_COMING_SOON`, `pricing.plus.soon1-8` and `pricing.plus.soonLabel`
    // were outside every rule, and the previous round's "pins every card array"
    // assertion listed exactly two arrays — codifying the omission structurally
    // rather than merely forgetting it. Measured: flipping `soonLabel` to
    // "Included now" reclassifies EIGHT undelivered features as shipped and the
    // whole suite stayed green.
    //
    // There is no matrix row to pin this to — availability is not in
    // plan_entitlements, and SPEC-1 §9 deliberately seeds `domains.custom` on
    // pro_plus while the DNS product is unbuilt (`pricing-matrix.ts` never
    // renders that row). So the gate IS the guard here, which is precisely the
    // case the inventory shape exists for.
    array: "PLUS_COMING_SOON",
    why: "the ROADMAP under the Pro Plus card — SPEC-1 §6 requires these to read as ambition and never as a paywall, and §9 keeps `domains.custom` seeded-but-unshipped. Nothing in plan_entitlements records shipped-ness, so this pin and `pricing.plus.soonLabel` (pinned in _approved-dictionary-copy.ts, four locales) are the ONLY thing standing between a one-word edit and eight undelivered features being advertised as live. Re-approving an entry here means confirming the feature is still unbuilt, and moving one out means deleting it from this list in the same commit that ships it. THE TEXT IS DICTIONARY-BACKED: `pricing.plus.soon1-8` renders; this array pins count and order.",
    bullets: [
      "Multi-org command centre",
      "Shared templates & branding across orgs",
      "Cross-competition analytics",
      "Custom domain & white-label",
      "SSO / SAML",
      "SLA & dedicated support",
      "Data export & warehouse",
      "Bulk & scheduled automation",
    ],
  },
];

const LIVE_CARD_BULLETS: Record<string, readonly string[]> = {
  FREE_FEATURES,
  PASS_FEATURES,
  PRO_FEATURES,
  PLUS_CARD_FEATURES,
  PLUS_COMING_SOON,
};

/**
 * The gate, as a pure fault-returning function so "prove it by rewording" is a
 * committed test rather than a manual check that happened once.
 *
 * An approved entry naming an array that does not exist is a fault of its own —
 * otherwise renaming the export would leave this gate examining nothing and
 * reporting clean, which is the exact failure this wave found five times.
 */
function approvedBulletFaults(
  approved: ApprovedBullets[],
  live: Record<string, readonly string[]>,
): string[] {
  if (approved.length === 0) return ["the approved-bullet inventory is empty — this gate examines nothing"];
  const faults: string[] = [];
  for (const entry of approved) {
    const onDisk = live[entry.array];
    if (!onDisk) {
      faults.push(`${entry.array}: approved but no such export — the gate is pointing at nothing`);
      continue;
    }
    if (onDisk.length !== entry.bullets.length) {
      faults.push(
        `${entry.array}: ${onDisk.length} bullets on disk, ${entry.bullets.length} approved`,
      );
    }
    for (let i = 0; i < Math.max(onDisk.length, entry.bullets.length); i += 1) {
      const want = entry.bullets[i];
      const got = onDisk[i];
      if (want === got) continue;
      faults.push(
        [
          `${entry.array}[${i}]: wording changed and has not been re-approved.`,
          `  what it claims: ${entry.why}`,
          `  approved: ${want ?? "(no bullet)"}`,
          `  on disk:  ${got ?? "(no bullet)"}`,
        ].join("\n"),
      );
    }
  }
  return faults;
}

/**
 * The SECONDARY net for the pass card's duration claim, both halves at once.
 *
 * Absence alone proves "not false", never "still stated": bullet 1 is the only
 * place the /pricing pass card says anything about when the upgrade stops, so a
 * reword that simply deletes the qualifier would leave a buyer told nothing —
 * and would pass an absence-shaped rule. Hence the positive half.
 *
 * Both patterns are IMPORTED. `FALSE_PASS_PERMANENCE_PATTERNS` and
 * `BOUNDED_SCOPE_GRAMMAR` are the same rules the Stripe seed, the help tree and
 * the four dictionaries are held to, so a pattern added for any of them covers
 * this card the same day.
 */
function passBulletDurationFaults(bullets: readonly string[]): string[] {
  const faults: string[] = [];
  if (bullets.length === 0) return ["no bullets — nothing to scan, so every rule below passes vacuously"];
  // Joined with ". " so a claim cannot reach across two bullets: every window in
  // the imported vocabulary is bounded by sentence punctuation, and a reader
  // reads each bullet as its own statement.
  const joined = bullets.join(". ");
  for (const pattern of FALSE_PASS_PERMANENCE_PATTERNS) {
    if (pattern.test(joined)) faults.push(`claims unbounded duration (${pattern.source})`);
  }
  if (!bullets.some((b) => BOUNDED_SCOPE_GRAMMAR.test(b))) {
    faults.push("no bullet states the pass is bounded to a running competition");
  }
  return faults;
}

// ─────────────────────────────────────────────────────────────────────────────
// FIX ROUND 1 (I2) — THE CARD'S NUMBERS, PINNED TO THE MATRIX AND NOT TO A
// SECOND COPY OF THEMSELVES.
//
// The inventory above is copy↔copy. That is the right primary net against an
// EDIT, and it is worth nothing against a MIGRATION: with the numbers pinned
// only to a literal in a test, moving `members.max` from null to 500 left
// "Unlimited members, teams & clubs" green, and so did moving every fee
// percentage on every card. Measured against a 10-probe battery of falsehoods
// that keep every true string: 1 caught.
//
// Worse, four of those probes LOOKED caught. `pricing-cards.test.ts` also
// carries the help-article suites (plans.md's fee-ladder table, add-a-division),
// which do read the matrix — so a fee move redded the file while the card was
// guarded by nothing. A red in the file is not a red on the surface, and that is
// the vacuity trap this wave keeps paying for.
//
// So: a DECLARATIVE claim table, iterated. A literal in a test is a second copy
// of the claim, not a check of it — the same lesson task 1 applied to the Stripe
// seed with `capFor(cap, rung.key)`.
// ─────────────────────────────────────────────────────────────────────────────

/** `plan_entitlements.int_value`, by feature and plan. `null` means unlimited;
 *  a MISSING plan key means no row at all, which is a fault, not "unlimited". */
type Matrix = Record<string, Record<string, number | null>>;

interface CardClaim {
  /** `plan_entitlements.feature_key`. */
  feature: string;
  /** The `plan_key` this bullet is making the claim ABOUT — not necessarily the
   *  card's own plan: the pass card quotes community's 8% as its comparator. */
  plan: string;
  /** How the bullets must render a NUMERIC value. Built from the live value, so
   *  a matrix move changes what is required rather than what is compared. */
  says: (value: number) => RegExp;
  /** How they must render a NULL (unlimited) value. Absent means the card has no
   *  approved wording for "unlimited", so a null value is itself a fault. */
  unlimited?: RegExp;
  /**
   * Plans this claim asserts do NOT have the same allowance.
   *
   * Only meaningful under the "Everything in Pro, plus…" frame: "Unlimited
   * members, teams & clubs" is not merely a fact about pro_plus, it is a claim
   * that Pro is capped. Moving `members.max` on PRO to null makes the Plus
   * card's bullet stop differentiating anything, with every string on both
   * cards still word-for-word true (fresh probe G6).
   */
  exclusiveAgainst?: string[];
}

/**
 * A CAPABILITY bullet: "we do X on this plan", against the boolean row.
 *
 * Added after the numeric pins, because a FRESH probe set written once those
 * were final scored 1/10 against them — every miss was a capability bullet.
 * `dashboard.branding` going false on pro while the Pro card still promises
 * "Remove the Powered by Seazn badge" is the same falsehood class as a moved
 * cap, and it was invisible: nothing on any card read a boolean row except the
 * four in `PLUS_DIFFERENTIATOR_VOCAB`.
 */
interface CardBooleanClaim {
  feature: string;
  /** EVERY plan the card sells. The Event Pass card sells two rungs out of one
   *  bullet list, and naming only `event_pass` let `formats.advanced` go false
   *  on `event_pass_l` with the card still promising advanced formats to an L
   *  buyer (measured — fresh probe G1). */
  plans: string[];
  /** The bullet that asserts it. Required to MATCH the shipped copy — see
   *  `cardBooleanFaults` for why that is the positive half and not a formality. */
  says: RegExp;
  /** For INT-shaped capabilities: the bullet is true while the row is null
   *  (unlimited) or at least this. `dashboard.public.max` going 1 -> 0 makes
   *  "Live standings & public dashboard" false without any boolean moving. */
  atLeast?: number;
}

/** One `plan_entitlements` row, both columns, because a capability can be
 *  expressed either way and the card cannot tell which. */
interface EntitlementRow {
  bool: boolean | null;
  int: number | null;
}
type RowsByFeature = Record<string, Record<string, EntitlementRow>>;

interface CardSurface {
  array: string;
  /** The `plan_key` this card sells, for the cross-card exclusivity rule.
   *  `null` for a surface that sells no plan (the roadmap). */
  plan: string | null;
  claims: CardClaim[];
  booleans?: CardBooleanClaim[];
  /** Required when `claims` is empty: why this surface quotes no matrix value.
   *  An undocumented empty table is the omission that hid the roadmap block. */
  noMatrixClaims?: string;
  /**
   * Bullets attributed to NO matrix row, each with its reason.
   *
   * ── WHY THIS FIELD EXISTS ────────────────────────────────────────────────
   * Everything above is a HAND-WRITTEN LIST, and a hand-written list is the
   * thing that silently stops covering something — v17 #293 lost `org_addons`
   * from the seed guard's section list for a whole wave exactly this way.
   *
   * Measured here: once the numeric and capability pins were final, a FRESH
   * probe set scored 1/10, and five of the misses were simply bullets nobody
   * had thought to enumerate (`exports` on Pro, `registration.enabled` and
   * `dashboard.public.max` on Community, `clubs.hierarchy` on Pro Plus, and the
   * L rung on the Pass card). No additional pattern fixes that. Only making the
   * ENUMERATION ITSELF checkable does.
   *
   * `cardBulletAttributionFaults` therefore requires every bullet to be claimed
   * by some rule or listed here: forgetting one is a red, and exempting one is a
   * decision with a reason attached.
   */
  unclaimed?: Record<string, string>;
}

/** Every rung the Event Pass card sells out of ONE bullet list. */
const PASS_RUNGS = ["event_pass", "event_pass_l"];

const CARD_SURFACES: CardSurface[] = [
  {
    array: "FREE_FEATURES",
    plan: "community",
    claims: [
      { feature: "competitions.max_active", plan: "community", says: (n) => new RegExp(`\\b${n}\\s+active\\s+competitions\\b`, "i") },
      { feature: "divisions.per_competition.max", plan: "community", says: (n) => new RegExp(`\\b${n}\\s+divisions\\b`, "i") },
      { feature: "entrants.per_division.max", plan: "community", says: (n) => new RegExp(`\\b${n}\\s+entrants\\s+per\\s+division\\b`, "i") },
      { feature: "registration.fee_percent", plan: "community", says: (n) => new RegExp(`\\(${n}%\\s+fee\\)`, "i") },
    ],
    booleans: [
      { feature: "registration.paid", plans: ["community"], says: /\bonline registration & entry fees\b/i },
      { feature: "registration.enabled", plans: ["community"], says: /\bonline registration\b/i },
      { feature: "discovery.listed", plans: ["community"], says: /\blisted on the seazn\.club showcase\b/i },
      // INT-shaped: "public dashboard" is true while the org may publish at
      // least one. 1 -> 0 makes the bullet false with no boolean moving.
      { feature: "dashboard.public.max", plans: ["community"], says: /\bpublic dashboard\b/i, atLeast: 1 },
    ],
    unclaimed: {
      // Found by the residue check the moment attribution became per-claim:
      // "public dashboard" was covered by dashboard.public.max while "Live
      // standings" beside it was covered by nothing.
      "Live standings":
        "the standings table is core engine output (packages/engine), produced on every plan and gated by no row. The GATED standings features are `standings.carry_over` and `standings.custom_points`, both Pro-only, and neither is claimed on this card.",
      "League, groups + knockout & swiss formats":
        "the base formats are the engine's own repertoire (packages/engine), not a plan_entitlements row — `formats.advanced` and `formats.double_elim` are the GATED ones and are claimed on the Pass card. Nothing here is plan-conditional.",
    },
  },
  {
    array: "PASS_FEATURES",
    plan: "event_pass",
    claims: [
      { feature: "divisions.per_competition.max", plan: "event_pass", says: (n) => new RegExp(`\\b${n}\\s+divisions\\b`, "i") },
      { feature: "entrants.per_division.max", plan: "event_pass", says: (n) => new RegExp(`\\b${n}\\s+entrants\\s+each\\b`, "i") },
      { feature: "registration.fee_percent", plan: "event_pass", says: (n) => new RegExp(`\\b${n}%\\s+platform\\s+fee\\b`, "i") },
      // The comparator the same bullet makes: "…not 8%". It is a claim about
      // COMMUNITY's rate sitting on the pass card, and it goes stale the moment
      // community's fee moves — which is exactly what F5 of the battery did.
      { feature: "registration.fee_percent", plan: "community", says: (n) => new RegExp(`\\bnot\\s+${n}%`, "i") },
      // Both rungs. The L rung's entrant cap is NULL, so the copy has to say so
      // in words — a null cap with a number beside it is M's ceiling sold to an
      // L buyer, the defect v17 #294 was filed for.
      { feature: "divisions.per_competition.max", plan: "event_pass_l", says: (n) => new RegExp(`\\b${n}\\s*&\\s*unlimited\\b`, "i") },
      {
        feature: "entrants.per_division.max",
        plan: "event_pass_l",
        says: (n) => new RegExp(`\\b${n}\\s+entrants\\b[^.]{0,20}\\bon\\s+L\\b`, "i"),
        unlimited: /\bunlimited\s+on\s+L\b/i,
      },
    ],
    // BOTH RUNGS. This card sells M and L out of one bullet list, so a
    // capability that goes false on `event_pass_l` alone still misleads an L
    // buyer — fresh probe G1, missed when these named `event_pass` only.
    booleans: [
      { feature: "formats.advanced", plans: PASS_RUNGS, says: /\badvanced formats\b/i },
      { feature: "formats.double_elim", plans: PASS_RUNGS, says: /\bdouble elim\b/i },
      { feature: "exports.branded", plans: PASS_RUNGS, says: /\bbranded exports\b/i },
      { feature: "dashboard.player_profiles", plans: PASS_RUNGS, says: /\bpublic player cards\b/i },
      { feature: "sponsors.tiers", plans: PASS_RUNGS, says: /\bsponsor tiers\b/i },
      { feature: "sponsors.monetize", plans: PASS_RUNGS, says: /\bpaid sponsorship packages\b/i },
      { feature: "realtime", plans: PASS_RUNGS, says: /\brealtime scoreboard\b/i },
    ],
    unclaimed: {
      "Upgrades ONE competition while it runs":
        "the pass's DURATION, not a feature grant. V328/V334 `org_has_feature` decide it and `passBulletDurationFaults` asserts both halves of it — the permanence vocabulary and the required bound.",
    },
  },
  {
    array: "PRO_FEATURES",
    plan: "pro",
    claims: [
      {
        feature: "competitions.max_active",
        plan: "pro",
        says: (n) => new RegExp(`\\b${n}\\s+(?:active\\s+)?competitions\\b`, "i"),
        unlimited: /\bunlimited\s+competitions\b/i,
      },
      {
        feature: "divisions.per_competition.max",
        plan: "pro",
        says: (n) => new RegExp(`\\b${n}\\s+divisions\\b`, "i"),
        unlimited: /\bunlimited\s+competitions\s*&\s*divisions\b/i,
      },
      { feature: "entrants.per_division.max", plan: "pro", says: (n) => new RegExp(`\\b${n}\\s+entrants\\s+per\\s+division\\b`, "i") },
      { feature: "registration.fee_percent", plan: "pro", says: (n) => new RegExp(`\\b${n}%\\s+platform\\s+fee\\b`, "i") },
    ],
    booleans: [
      { feature: "scoring.ball_by_ball", plans: ["pro"], says: /\bball-by-ball\b/i },
      { feature: "scoring.rally_by_rally", plans: ["pro"], says: /\brally scoring\b/i },
      { feature: "stats.player", plans: ["pro"], says: /\bplayer stats\b/i },
      { feature: "api.access", plans: ["pro"], says: /\bAPI keys\b/i },
      { feature: "scoring.device_links", plans: ["pro"], says: /\bdevice links\b/i },
      // The same bullet names four things; each is its own row, and `exports`
      // and `officials.marks` were missed when only two of the four were pinned.
      { feature: "exports", plans: ["pro"], says: /\bofficials, exports\b/i },
      { feature: "officials.marks", plans: ["pro"], says: /\bofficials, exports\b/i },
      // The badge bullet IS `dashboard.branding` — the same row SPEC-1 §5 ticked
      // for the pass in error. Pro has it; the pass does not.
      { feature: "dashboard.branding", plans: ["pro"], says: /\bremove the “powered by seazn” badge\b/i },
      { feature: "discipline.enforced", plans: ["pro"], says: /\bsuspensions & discipline tracking\b/i },
      { feature: "officials.marks", plans: ["pro"], says: /\brate your match officials\b/i },
      { feature: "news.auto", plans: ["pro"], says: /\bauto-drafted result posts\b/i },
    ],
  },
  {
    array: "PLUS_CARD_FEATURES",
    plan: "pro_plus",
    claims: [
      // Three separate rows behind one bullet. Pinned one by one, because
      // "Unlimited members, teams & clubs" is three claims and any one of them
      // can go false on its own.
      { feature: "members.max", plan: "pro_plus", exclusiveAgainst: ["pro"], says: (n) => new RegExp(`\\b${n}\\b[^.]{0,40}\\bmembers\\b`, "i"), unlimited: /\bunlimited\b[^.]{0,40}\bmembers\b/i },
      { feature: "teams.max", plan: "pro_plus", exclusiveAgainst: ["pro"], says: (n) => new RegExp(`\\b${n}\\b[^.]{0,40}\\bteams\\b`, "i"), unlimited: /\bunlimited\b[^.]{0,40}\bteams\b/i },
      { feature: "clubs.max", plan: "pro_plus", exclusiveAgainst: ["pro"], says: (n) => new RegExp(`\\b${n}\\b[^.]{0,40}\\bclubs\\b`, "i"), unlimited: /\bunlimited\b[^.]{0,40}\bclubs\b/i },
      { feature: "registration.fee_percent", plan: "pro_plus", says: (n) => new RegExp(`\\b${n}%\\s+platform\\s+fee\\b`, "i") },
    ],
    booleans: [
      { feature: "officials.auto", plans: ["pro_plus"], says: /\bauto officials assignment\b/i },
      { feature: "api.write", plans: ["pro_plus"], says: /\bwrite API access\b/i },
      { feature: "support.priority", plans: ["pro_plus"], says: /\bpriority support\b/i },
      // The "clubs" in "Unlimited members, teams & clubs" is a capability as
      // well as a cap: `clubs.max` being null means nothing if `clubs.hierarchy`
      // is off (fresh probe G5).
      { feature: "clubs.hierarchy", plans: ["pro_plus"], says: /\bclubs\b/i },
    ],
    unclaimed: {
      "Largest monthly AI credit grant":
        "a COMPARATIVE over `ai.credits.monthly` (10 / 60 / 200), not a grant this card either has or lacks. Asserted by localeCreditLeadershipFaults against the numbers, in all four locales, which is the only rule shape that can judge 'largest'.",
    },
  },
  {
    array: "PLUS_COMING_SOON",
    plan: null,
    claims: [],
    noMatrixClaims:
      "the roadmap quotes no number and sells no plan. Its claim is AVAILABILITY, which plan_entitlements does not record — SPEC-1 §9 deliberately seeds `domains.custom` on pro_plus while the DNS product is unbuilt, so the rows would say 'shipped' about a feature that is not. Guarded by the approved-bullet inventory and by the four-locale pin on `pricing.plus.soonLabel`, and by nothing else, on purpose.",
  },
];

/**
 * Every number a card quotes, against the row that decides it.
 *
 * Both directions are faults, which is the point:
 *  - a numeric row the copy does not quote (the matrix moved under the copy);
 *  - a numeric row while the copy says "unlimited" (the cap arrived and the
 *    copy still promises none) — the F1 probe, and the one that reads most
 *    plausibly in review;
 *  - a null row the copy never calls unlimited, or has no wording for at all.
 *
 * A MISSING row is a fault too. `?? null` would read "no row" as "unlimited"
 * and quietly certify a card against a feature key that no longer exists.
 */
function cardMatrixFaults(
  surfaces: CardSurface[],
  live: Record<string, readonly string[]>,
  matrix: Matrix,
): string[] {
  if (surfaces.length === 0) return ["no card surfaces — this rule examines nothing"];
  const faults: string[] = [];
  let claimsChecked = 0;

  for (const surface of surfaces) {
    const bullets = live[surface.array];
    if (!bullets) {
      faults.push(`${surface.array}: no such export — its matrix claims are pinned to nothing`);
      continue;
    }
    if (surface.claims.length === 0) {
      if (!surface.noMatrixClaims) {
        faults.push(
          `${surface.array}: quotes no matrix value and gives no reason — an empty claim table must be a decision, not a silence`,
        );
      }
      continue;
    }
    const joined = bullets.join(". ");
    for (const claim of surface.claims) {
      const row = matrix[claim.feature];
      if (!row || !(claim.plan in row)) {
        faults.push(
          `${surface.array}: plan_entitlements has no ${claim.plan}/${claim.feature} row — the bullet is pinned to nothing`,
        );
        continue;
      }
      claimsChecked += 1;
      const value = row[claim.plan]!;
      if (value === null) {
        if (!claim.unlimited) {
          faults.push(
            `${surface.array}: ${claim.plan}/${claim.feature} is unlimited but this card has no approved wording for an unlimited value`,
          );
        } else if (!claim.unlimited.test(joined)) {
          faults.push(
            `${surface.array}: ${claim.plan}/${claim.feature} is unlimited but the card never says so`,
          );
        }
        // …and, under an exclusivity frame, that the lower plans are NOT also
        // unlimited. Without this the bullet can quietly stop differentiating
        // anything while every string on both cards stays true.
        for (const lower of claim.exclusiveAgainst ?? []) {
          if (claim.plan in row && lower in row && row[lower] === null) {
            faults.push(
              `${surface.array}: sells unlimited ${claim.feature} as a differentiator, but ${lower} is unlimited too`,
            );
          }
        }
        continue;
      }
      if (claim.unlimited?.test(joined)) {
        faults.push(
          `${surface.array}: card claims UNLIMITED ${claim.feature}, but the matrix caps ${claim.plan} at ${value}`,
        );
      }
      if (!claim.says(value).test(joined)) {
        faults.push(
          `${surface.array}: does not quote the live ${claim.plan}/${claim.feature} (${value}) — expected ${claim.says(value).source}`,
        );
      }
    }
  }

  if (claimsChecked === 0) {
    faults.push("no claim resolved a live row — this rule compared the cards against nothing");
  }
  return faults;
}

/**
 * Every CAPABILITY a card promises, against the boolean row that grants it.
 *
 * BOTH HALVES, and the positive one is what stops this rotting:
 *  - the bullet the claim describes must still BE on the card. A claim whose
 *    regex matches nothing is a pin examining nothing, and it would go on
 *    reporting clean forever after the bullet it named was reworded away;
 *  - and the plan must actually grant it.
 *
 * Deliberately one-directional on the other axis: a card need not list every
 * boolean its plan has. Requiring that would red every time a migration added a
 * feature, which is not a copy defect.
 */
function cardBooleanFaults(
  surfaces: CardSurface[],
  live: Record<string, readonly string[]>,
  rows: RowsByFeature,
): string[] {
  const faults: string[] = [];
  let checked = 0;
  for (const surface of surfaces) {
    const bullets = live[surface.array];
    if (!bullets || !surface.booleans) continue;
    const joined = bullets.join(". ");
    for (const claim of surface.booleans) {
      if (!claim.says.test(joined)) {
        faults.push(
          `${surface.array}: no bullet matches ${claim.says.source} — the copy this ${claim.feature} pin describes is gone, so the pin examines nothing`,
        );
        continue;
      }
      for (const plan of claim.plans) {
        const row = rows[claim.feature]?.[plan];
        if (!row) {
          faults.push(
            `${surface.array}: plan_entitlements has no ${plan}/${claim.feature} row — the bullet is pinned to nothing`,
          );
          continue;
        }
        checked += 1;
        // INT-shaped capability: null is unlimited, otherwise it must clear the
        // floor the bullet implies.
        if (claim.atLeast !== undefined) {
          if (row.int !== null && row.int < claim.atLeast) {
            faults.push(
              `${surface.array}: promises ${claim.feature}, but ${plan} allows only ${row.int}`,
            );
          }
          continue;
        }
        if (row.bool !== true) {
          faults.push(
            `${surface.array}: promises ${claim.feature}, but ${plan} does not grant it`,
          );
        }
      }
    }
  }
  if (checked === 0) {
    faults.push("no capability claim matched a bullet — this rule examined nothing");
  }
  return faults;
}

/**
 * ── THE RULE THAT MAKES THE OTHER RULES CHECKABLE ────────────────────────────
 *
 * Every bullet on every card must be ATTRIBUTED: matched by a numeric claim, a
 * capability claim, the duration grammar, or the differentiator vocabulary — or
 * else listed in `unclaimed` with a reason.
 *
 * This exists because everything above is a hand-written list, and the measured
 * failure of a hand-written list is not that its rules are weak but that it
 * silently stops covering something. A fresh probe set written after the
 * numeric and capability pins were final scored 1/10, and five of the nine
 * misses were bullets nobody had enumerated. Adding five more entries fixes
 * those five; making the enumeration self-checking fixes the class.
 *
 * A STALE exemption is a fault too: an `unclaimed` key naming a bullet that no
 * longer exists is an exemption doing nothing, which is how a list rots back
 * into silence.
 */
/**
 * The vocabulary a CLAIM is made in, derived from the feature keys themselves.
 *
 * Not a hand-written noun list: the tokens are the `plan_entitlements`
 * feature_key segments the cards actually declare, so a new feature brings its
 * own word with it. Stopwords are the structural halves of a key (`per`, `max`,
 * `enabled`) that carry no marketing meaning.
 */
const CLAIM_TOKEN_STOPWORDS = new Set([
  "per", "max", "min", "value", "enabled", "monthly", "percent", "hierarchy", "public", "listed",
]);

function claimTokens(allFeatureKeys: string[]): string[] {
  // EVERY feature key in plan_entitlements, not merely the ones a card happens
  // to declare. Deriving the lexicon from the declared subset made the rule
  // circular: a bullet naming a feature nobody had declared contained no
  // recognised token and sailed through, which is the exact hole this rule
  // exists to close ("Custom domain & white-label" on the Pro card).
  const fromFeatures = allFeatureKeys
    .flatMap((feature) => feature.split(/[._]/))
    .filter((word) => word.length >= 4 && !CLAIM_TOKEN_STOPWORDS.has(word));
  // Quantity words are claims in their own right and belong to no feature key.
  return [...new Set([...fromFeatures, "unlimited"])];
}

/**
 * ── ATTRIBUTION, PER CLAIM RATHER THAN PER BULLET (fix round 2, blocking 3) ──
 *
 * Round 1 accepted a bullet the moment ANY declared claim matched a FRAGMENT of
 * it, so a second claim could ride along inside the same bullet untouched.
 * Measured 0/3 by the reviewer, and every miss is a sentence a marketer would
 * plausibly write:
 *
 *   Pro card       "Unlimited entrants while your competition runs"
 *                  — attributed by BOUNDED_SCOPE_GRAMMAR; pro caps at 256.
 *   Community card "Branded exports on your public dashboard"
 *                  — attributed by the dashboard.public.max regex;
 *                    `exports.branded` is FALSE on community.
 *   Community card "64 entrants per division, with unlimited clubs & teams"
 *                  — attributed by says(64); `clubs.max` on community is 5.
 *
 * The fix is a RESIDUE check. Blank out every span a declared claim (or a
 * recorded exemption) actually matches, then require the leftovers to contain no
 * claim vocabulary. A claim cannot hide behind its neighbour, because its own
 * words are still sitting in the residue.
 *
 * `BOUNDED_SCOPE_GRAMMAR` and `PLUS_DIFFERENTIATOR_VOCAB` are NO LONGER blanket
 * attributors — they attributed whole bullets while proving nothing about the
 * numbers in them, which is how the first two misses passed.
 */
function cardBulletAttributionFaults(
  surfaces: CardSurface[],
  live: Record<string, readonly string[]>,
  matrix: Matrix,
  allFeatureKeys: string[],
): string[] {
  const faults: string[] = [];
  const tokens = claimTokens(allFeatureKeys);
  if (tokens.length < 10) return ["the claim vocabulary is nearly empty — this rule examines nothing"];

  for (const surface of surfaces) {
    const bullets = live[surface.array];
    if (!bullets) continue;
    const exemptions = surface.unclaimed ?? {};

    for (const [phrase, why] of Object.entries(exemptions)) {
      if (!bullets.some((b) => b.includes(phrase))) {
        faults.push(
          `${surface.array}: "${phrase}" is exempted but appears in no bullet — a stale exemption covers nothing`,
        );
      }
      if (why.length <= 20) {
        faults.push(`${surface.array}: "${phrase}" has an empty exemption reason`);
      }
    }
    // A surface that quotes no matrix value at all (the roadmap) is exempt
    // wholesale, with the reason recorded on `noMatrixClaims`.
    if (surface.claims.length === 0 && surface.noMatrixClaims) continue;

    for (const bullet of bullets) {
      // Every pattern that genuinely matches THIS bullet, blanked out of it.
      const patterns: RegExp[] = [];
      for (const claim of surface.claims) {
        const value = matrix[claim.feature]?.[claim.plan];
        if (value === undefined) continue;
        if (value !== null) patterns.push(claim.says(value));
        if (claim.unlimited) patterns.push(claim.unlimited);
      }
      for (const claim of surface.booleans ?? []) patterns.push(claim.says);

      // Spans are collected against the ORIGINAL bullet and blanked afterwards.
      // Blanking sequentially made the rule ORDER-DEPENDENT: `competitions`'
      // "Unlimited competitions" erased the prefix that `divisions`' own
      // "Unlimited competitions & divisions" needed, so a correctly declared
      // claim reported as unattributed. Overlapping claims are normal — three
      // rows sit behind "Unlimited members, teams & clubs".
      const covered: boolean[] = new Array(bullet.length).fill(false);
      const mark = (pattern: RegExp) => {
        const global = new RegExp(pattern.source, pattern.flags.replace("g", "") + "g");
        for (const match of bullet.matchAll(global)) {
          const at = match.index ?? 0;
          for (let i = at; i < at + match[0].length; i += 1) covered[i] = true;
        }
      };
      for (const pattern of patterns) mark(pattern);
      for (const phrase of Object.keys(exemptions)) {
        let at = bullet.indexOf(phrase);
        while (at !== -1) {
          for (let i = at; i < at + phrase.length; i += 1) covered[i] = true;
          at = bullet.indexOf(phrase, at + 1);
        }
      }
      const residue = [...bullet].map((ch, i) => (covered[i] ? " " : ch)).join("");

      const leftover = tokens.filter((token) =>
        new RegExp(`\\b${token}`, "i").test(residue),
      );
      if (leftover.length === 0) continue;
      faults.push(
        `${surface.array}: "${bullet}" makes an unattributed claim about ${leftover.join(", ")} — the words "${residue.replace(/\s+/g, " ").trim()}" are matched by no declared claim and by no recorded exemption`,
      );
    }
  }
  return faults;
}

/**
 * FIX ROUND 1 (I4) — THE CARDS, AGAINST EACH OTHER.
 *
 * A bullet can be true of the card it is on and false against the card beside
 * it. That is the class that pulled `PLUS_CARD_FEATURES` into this task's scope
 * in the first place — the FAQ dropped "AI-assisted scheduling" while the card
 * above went on selling it — and it was still open in the other direction:
 * appending "Auto officials assignment" to `PRO_FEATURES` was green, which would
 * have the Pro card claim the exact feature the Plus card sells as its
 * exclusive.
 *
 * Judged against the ROWS, not against a banned phrase, so it falls silent the
 * day a migration grants the feature lower down — the same negative case
 * `localePlusDifferentiatorFaults` is built around.
 */
function crossCardExclusivityFaults(
  surfaces: CardSurface[],
  live: Record<string, readonly string[]>,
  grants: FeatureGrants,
): string[] {
  const faults: string[] = [];
  let recognised = 0;
  for (const surface of surfaces) {
    if (surface.plan === null) continue;
    const bullets = live[surface.array];
    if (!bullets) continue;
    const joined = bullets.join(". ");
    for (const [feature, claim] of PLUS_DIFFERENTIATOR_VOCAB) {
      if (!claim.test(joined)) continue;
      recognised += 1;
      const row = grants[feature];
      if (!row) {
        faults.push(`${surface.array}: claims ${feature}, which has no rows in plan_entitlements`);
        continue;
      }
      if (!row[surface.plan]) {
        faults.push(
          `${surface.array}: the ${surface.plan} card claims ${feature}, but ${surface.plan} does not grant it — and the Pro Plus card sells it as exclusive`,
        );
      }
    }
  }
  // Anti-vacuity. The Plus card matches three entries today; a vocabulary that
  // stopped matching anything would have this rule examine nothing and report
  // clean, which is how five guards in this wave were found inert.
  if (recognised === 0) {
    faults.push(
      "no card matched any differentiator vocabulary — this rule examined nothing",
    );
  }
  return faults;
}

describe("the /pricing card bullets say what plan_entitlements enforces", () => {
  // THE GATE, first, because it is the rule that does not depend on anyone
  // having imagined the right falsehood.
  it("matches the approved wording, bullet for bullet", () => {
    expect(approvedBulletFaults(APPROVED_CARD_BULLETS, LIVE_CARD_BULLETS)).toEqual([]);
  });

  /**
   * …and it covers EVERY array `/pricing` renders as a claim.
   *
   * FIX ROUND 1 (I3). The previous round listed exactly two arrays here, which
   * did not merely forget the other three — it CODIFIED the omission, so the
   * assertion that was supposed to prove coverage was the thing certifying the
   * gap. `FREE_FEATURES`, `PRO_FEATURES` and the whole `PLUS_COMING_SOON`
   * roadmap were outside every rule in the file.
   *
   * The list is now derived from the module's own exports rather than typed out
   * again, so a sixth array added to `pricing-cards.ts` reds here until someone
   * decides whether it makes a claim.
   */
  it("pins every card array pricing-cards.ts exports", async () => {
    const cards: Record<string, unknown> = await import("../pricing-cards");
    const exportedArrays = Object.entries(cards)
      .filter(([, v]) => Array.isArray(v) && v.every((x) => typeof x === "string"))
      .map(([k]) => k)
      .sort();
    expect(exportedArrays.length, "found no string arrays — the module's shape changed").toBe(5);
    expect(APPROVED_CARD_BULLETS.map((e) => e.array).sort()).toEqual(exportedArrays);
    expect(CARD_SURFACES.map((s) => s.array).sort()).toEqual(exportedArrays);
    for (const entry of APPROVED_CARD_BULLETS) {
      expect(entry.why.length, `${entry.array} has no source-of-truth note`).toBeGreaterThan(40);
      expect(entry.bullets.length, `${entry.array} has no bullets`).toBeGreaterThan(3);
    }
  });

  // THE PASS BULLET, by vocabulary as well — the secondary net.
  it("never sells the Event Pass as permanent, and still says what bounds it", () => {
    expect(passBulletDurationFaults(PASS_FEATURES)).toEqual([]);
  });

  /**
   * PLUS_CARD_FEATURES IS THE ENGLISH MIRROR, NOT THE RENDERED TEXT.
   *
   * `/pricing` renders `t(d, "pricing.plus.f{i+1}")` and uses the array only for
   * the count and the order (page.tsx:402). Nothing pinned the two together
   * before this wave, so an edit to the array alone would change no pixel and an
   * edit to `en/marketing.json` alone would leave the array lying. Both are
   * "the Pro Plus card"; they must be one string.
   */
  it("mirrors the en dictionary the card actually renders, key for key", () => {
    const en: Record<string, string> = JSON.parse(
      readFileSync("src/dictionaries/en/marketing.json", "utf8"),
    );
    expect(PLUS_CARD_FEATURES).toEqual(
      PLUS_CARD_FEATURES.map((_, i) => en[`pricing.plus.f${i + 1}`]),
    );
    // FIX ROUND 1 (I3): the roadmap is a mirror of exactly the same shape, and
    // was not pinned either. Same failure mode — editing `soon4` alone would
    // leave the array lying, and editing the array alone would change no pixel.
    expect(PLUS_COMING_SOON).toEqual(
      PLUS_COMING_SOON.map((_, i) => en[`pricing.plus.soon${i + 1}`]),
    );
    // …and the frame those bullets are read under, which is what makes each one
    // a claim of exclusivity. A reword that drops it would leave the
    // differentiator rules with nothing to scope to.
    expect(en["pricing.plus.note"]).toMatch(/Everything\s+in\s+Pro,\s*plus/i);
    // The roadmap's own frame. Without it the eight items below read as shipped
    // features of the tier they sit under.
    expect(en["pricing.plus.soonLabel"], "the roadmap label must state futurity").toBe(
      "Coming soon",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PROVING THE GUARDS — by REWORDING, not by reverting.
//
// The arrays above are (and must stay) correct, so every assertion in the block
// above passes whether or not the guard covers the claim. Restoring the exact
// bullet this task removed is NOT proof; that is what let two wave-6 guards ship
// green. These point the same pure functions at the copy a future editor
// plausibly writes.
// ─────────────────────────────────────────────────────────────────────────────
describe("the card-bullet guards survive a rewording", () => {
  /** The bullets exactly as they shipped before this task — a holed clone, the
   *  same shape as config/__tests__/stripe-plans.test.ts uses. */
  const PRE_FIX: Record<string, readonly string[]> = {
    PASS_FEATURES: ["Upgrades ONE competition, forever", ...PASS_FEATURES.slice(1)],
    PLUS_CARD_FEATURES: [
      ...PLUS_CARD_FEATURES.slice(0, 2),
      "AI-assisted scheduling",
      ...PLUS_CARD_FEATURES.slice(3),
    ],
  };

  it("reds on the exact copy this task replaced", () => {
    const faults = approvedBulletFaults(APPROVED_CARD_BULLETS, PRE_FIX).join("\n");
    expect(faults).toContain("PASS_FEATURES[0]");
    expect(faults).toContain("Upgrades ONE competition, forever");
    expect(faults).toContain("PLUS_CARD_FEATURES[2]");
    expect(faults).toContain("AI-assisted scheduling");
  });

  // The gate is not a snapshot of the array: it must red when an approved array
  // stops existing, or renaming the export silently switches the gate off.
  it("reds when an approved array is renamed out from under it", () => {
    expect(approvedBulletFaults(APPROVED_CARD_BULLETS, { PASS_FEATURES }).join(" ")).toContain(
      "PLUS_CARD_FEATURES: approved but no such export",
    );
    expect(approvedBulletFaults([], LIVE_CARD_BULLETS)).toEqual([
      "the approved-bullet inventory is empty — this gate examines nothing",
    ]);
  });

  // …and a bullet APPENDED, which changes no approved string at all.
  it("reds on a sixth Pro Plus bullet nobody approved", () => {
    expect(
      approvedBulletFaults(APPROVED_CARD_BULLETS, {
        ...LIVE_CARD_BULLETS,
        PLUS_CARD_FEATURES: [...PLUS_CARD_FEATURES, "AI-powered scheduling"],
      }).join(" "),
    ).toContain("6 bullets on disk, 5 approved");
  });

  // The vocabulary half, on permanence claims written fresh — none of these is
  // the sentence this task deleted.
  it("catches the pass bullet reworded to promise permanence", () => {
    for (const reworded of [
      "Upgrades ONE competition, permanently",
      "Upgrades ONE competition — yours to keep",
      "Upgrades ONE competition for life",
      "Upgrades ONE competition; the upgrade never expires",
      "Upgrades ONE competition and it does not lapse",
      "Upgrades ONE competition for as long as you want",
      "Upgrades ONE competition with no expiry",
      "Upgrades ONE competition in perpetuity",
    ]) {
      expect(
        passBulletDurationFaults([reworded, ...PASS_FEATURES.slice(1)]).join(" "),
        reworded,
      ).toContain("claims unbounded duration");
    }
  });

  // The positive half, defeated from the other side: the bound DELETED rather
  // than contradicted, which an absence-shaped rule is happiest with.
  it("catches the bound being dropped rather than contradicted", () => {
    expect(passBulletDurationFaults(["Upgrades ONE competition", ...PASS_FEATURES.slice(1)])).toEqual([
      "no bullet states the pass is bounded to a running competition",
    ]);
    // "active" with no limiting conjunction is a claim of immediate start and NO
    // end — it must not satisfy a rule meant to assert a bound.
    expect(
      passBulletDurationFaults(["Upgrades ONE competition — active immediately", ...PASS_FEATURES.slice(1)]),
    ).toEqual(["no bullet states the pass is bounded to a running competition"]);
    // …and an emptied array is a fault, never a clean scan.
    expect(passBulletDurationFaults([])).toEqual([
      "no bullets — nothing to scan, so every rule below passes vacuously",
    ]);
  });

  /**
   * ── THE HONEST NUMBER ────────────────────────────────────────────────────────
   *
   * The eight rewordings above were written alongside these rules, so they
   * partly measure my own memory. THESE ten were written AFTER the rules were
   * final — ordinary editorial prose for a marketing bullet, deliberately
   * avoiding the words the vocabulary enumerates. No rule was adjusted to
   * accommodate any of them.
   *
   * Both rates are asserted so a regression reads as a number rather than a
   * boolean, and so that widening the vocabulary has to be a deliberate edit.
   */
  const FRESH_PERMANENCE = [
    "Upgrades ONE competition — no take-backs",
    "Upgrades ONE competition, and nothing switches it off later",
    "Upgrades ONE competition; it will still be there next season",
    "Upgrades ONE competition, settled in one payment",
    "Upgrades ONE competition — not time-boxed",
    "Upgrades ONE competition, and we never claw it back",
    "Upgrades ONE competition. It outlives the event itself",
    "Upgrades ONE competition — consider it done from then on",
    "Upgrades ONE competition, with no use-by date",
    "Upgrades ONE competition that outlasts the season",
  ];

  it("records what the vocabulary catches on prose it has never seen", () => {
    const caught = FRESH_PERMANENCE.filter(
      (line) => passBulletDurationFaults([line, ...PASS_FEATURES.slice(1)]).length > 0,
    );
    expect(FRESH_PERMANENCE.length).toBe(10);
    // Every one of these DROPS the bound as well as implying permanence, so the
    // POSITIVE half catches all ten. That is the measurement worth having: the
    // negative half — the permanence vocabulary itself — catches far fewer.
    expect(caught.length, "the paired rule's recall on unseen prose").toBe(10);
    const byVocabulary = FRESH_PERMANENCE.filter((line) =>
      FALSE_PASS_PERMANENCE_PATTERNS.some((p) => p.test(line)),
    );
    // MEASURED, not predicted: I expected 1 (guessing "no use-by date" would
    // reach the `no (end|cut-off|expiry|expiration|deadline)` family — it does
    // not; "use-by date" is not in the list). The real number is ZERO. That is
    // the sixth independent measurement of the same property in this wave, and
    // it is why the gate above is the primary rule and this is the backstop.
    expect(
      byVocabulary.length,
      "the VOCABULARY's own recall on unseen prose — update deliberately, and say why",
    ).toBe(0);
  });

  /**
   * …AND WHAT ACTUALLY PROTECTS THE SHIPPED COPY.
   *
   * The same ten sentences, put into the real array: the inventory gate reds on
   * 10 of 10, because it does not care how the falsehood is phrased. This is the
   * whole argument for the architecture, made as a measurement rather than an
   * assertion.
   */
  it("the inventory gate catches all 10, where the vocabulary alone caught 0", () => {
    const missed = FRESH_PERMANENCE.filter(
      (line) =>
        approvedBulletFaults(APPROVED_CARD_BULLETS, {
          ...LIVE_CARD_BULLETS,
          PASS_FEATURES: [line, ...PASS_FEATURES.slice(1)],
        }).length === 0,
    );
    expect(missed, `the gate missed: ${missed.join(" | ")}`).toEqual([]);
  });

  /**
   * The same measurement for the Pro Plus bullet, whose falsehood is not a
   * permanence claim at all: ten fresh ways to sell AI scheduling as a Pro Plus
   * differentiator. The gate reds on all ten; `PLUS_DIFFERENTIATOR_VOCAB` — the
   * shared claim vocabulary — is the secondary net and is measured beside it.
   */
  const FRESH_AI_SCHEDULING = [
    "Smart fixture generation",
    "Let the assistant build your schedule",
    "Machine-drafted fixture lists",
    "Automatic draw building",
    "Our model plans your rounds for you",
    "Intelligent scheduling assistance",
    "AI-drafted fixtures",
    "Scheduling, done for you by AI",
    "One-click AI draws",
    "Fixtures written by the AI architect",
  ];

  it("the gate reds on every fresh way of re-selling AI scheduling", () => {
    const missed = FRESH_AI_SCHEDULING.filter(
      (line) =>
        approvedBulletFaults(APPROVED_CARD_BULLETS, {
          ...LIVE_CARD_BULLETS,
          PLUS_CARD_FEATURES: [
            ...PLUS_CARD_FEATURES.slice(0, 2),
            line,
            ...PLUS_CARD_FEATURES.slice(3),
          ],
        }).length === 0,
    );
    expect(FRESH_AI_SCHEDULING.length).toBe(10);
    expect(missed, `the gate missed: ${missed.join(" | ")}`).toEqual([]);
  });
});

// D22, the standing version of it. The bug V311 fixes was NOT a code bug: the
// cards and the help pages had advertised "32 players" and "5 seasons" for a
// release while plan_entitlements said 16 and 1, and nothing anywhere compared
// the two. These bullets and the in-app billing panel are hand-written prose —
// they cannot be generated from the matrix — so this is the comparison.
//
// Every number a plan card quotes must be the number the resolver enforces. If
// you are here because you moved a cap: change the copy, in all four
// dictionaries, not this test.
//
// Real Postgres required; skipped without DATABASE_URL (CI sets it).
describe.skipIf(!HAS_DB)("plan-card copy quotes the numbers the matrix enforces", () => {
  // The row must EXIST. `int_value` is legitimately null on this column (it
  // means unlimited), so `row?.int_value ?? null` cannot distinguish "no row"
  // from "unlimited" — and a missing row would sail on to assert the copy
  // contains the literal string "null entrants per division", which reads as a
  // copy bug rather than the matrix gap it actually is. Fail at the source.
  const capFor = async (feature: string, plan: string): Promise<number | null> => {
    const [row] = await sql<{ int_value: number | null }[]>`
      select int_value from plan_entitlements
      where plan_key = ${plan} and feature_key = ${feature}`;
    expect(row, `plan_entitlements has no ${plan}/${feature} row`).toBeDefined();
    return row!.int_value;
  };

  const dict = (locale: string): Record<string, string> =>
    JSON.parse(readFileSync(`src/dictionaries/${locale}/ui.json`, "utf8"));

  const marketing = (locale: string): Record<string, string> =>
    JSON.parse(readFileSync(`src/dictionaries/${locale}/marketing.json`, "utf8"));

  const LOCALES = ["en", "fr", "es", "nl"];

  it("the Community card quotes the live entrant and competition caps", async () => {
    const entrants = await capFor("entrants.per_division.max", "community");
    const comps = await capFor("competitions.max_active", "community");
    const bullets = FREE_FEATURES.join(" | ");
    expect(bullets).toContain(`${entrants} entrants per division`);
    expect(bullets).toMatch(new RegExp(`\\b${comps} active competitions?\\b`));
  });

  it("the Event Pass card quotes the live pass entrant cap", async () => {
    const entrants = await capFor("entrants.per_division.max", "event_pass");
    expect(PASS_FEATURES.join(" | ")).toContain(`${entrants} entrants each`);
  });

  it("the Pro card quotes the live pro entrant cap", async () => {
    const entrants = await capFor("entrants.per_division.max", "pro");
    expect(PRO_FEATURES.join(" | ")).toContain(`${entrants} entrants per division`);
  });

  // v17 (SPEC-6 A1): the /pricing card credit lines render the live
  // `ai.credits.monthly` value straight off plan_entitlements (no hardcoded
  // second source). This pins the wireframe numbers (10 / 60 / 200) so a matrix
  // move surfaces as a failing test rather than silent marketing drift.
  it("plan_entitlements grants the credit-line numbers the cards quote (10 / 60 / 200)", async () => {
    expect(await capFor("ai.credits.monthly", "community")).toBe(10);
    expect(await capFor("ai.credits.monthly", "pro")).toBe(60);
    expect(await capFor("ai.credits.monthly", "pro_plus")).toBe(200);
  });

  // The in-app billing panel is a SECOND hand-written copy of the same claims,
  // localised four ways. Numerals are identical across these locales, so the
  // digits are checkable without reading the prose around them — and a
  // half-updated translation set is exactly how the drift started.
  it("billing.community.f1/f2 carry the same numbers in all four locales", async () => {
    const entrants = await capFor("entrants.per_division.max", "community");
    const comps = await capFor("competitions.max_active", "community");
    for (const locale of LOCALES) {
      const d = dict(locale);
      expect(d["billing.community.f1"], `${locale} f1`).toContain(String(comps));
      expect(d["billing.community.f2"], `${locale} f2`).toContain(String(entrants));
    }
  });

  it("billing.pro.f2 carries the live pro entrant cap in all four locales", async () => {
    const entrants = await capFor("entrants.per_division.max", "pro");
    for (const locale of LOCALES) {
      expect(dict(locale)["billing.pro.f2"], `${locale}`).toContain(String(entrants));
    }
  });

  // ── v17 #294: the same D22 discipline, now for TWO rungs ──────────────────
  //
  // Every surface below is hand-written prose that quotes a cap, and each one
  // described only the M rung before this task. The numerals are identical
  // across en/fr/es/nl, so the digits are checkable without reading the prose
  // around them — the same reasoning the four-locale tests above rely on.

  it("the /pricing FAQ answer names the L rung's live caps and its price", async () => {
    const divisions = await capFor("divisions.per_competition.max", "event_pass_l");
    expect(divisions).toBe(20);
    for (const locale of LOCALES) {
      const answer = marketing(locale)["pricing.faq.eventPass.a"];
      expect(answer, `${locale}: no answer`).toBeTruthy();
      expect(answer, `${locale}: L's division cap`).toContain(String(divisions));
      // The price must be INTERPOLATED, never written down: `{passL}` is
      // substituted with the switched currency at render time, so a hardcoded
      // "$59" here would show dollars to a GBP visitor — the exact bug #191
      // was filed for on the M rung's copy.
      expect(answer, `${locale}: interpolated L price`).toContain("{passL}");
    }
  });

  // GAP B from T3's sweep: this tip said "64 entrants per division" while the
  // live matrix has said 128 since V319 — a PRE-EXISTING content bug, wrong by
  // half, independent of the L rung. Pinning it against the matrix is what
  // stops it recurring; naming L is what this wave adds.
  it("the Event Pass tip quotes the live M entrant cap and L's ceiling", async () => {
    const mEntrants = await capFor("entrants.per_division.max", "event_pass");
    const lDivisions = await capFor("divisions.per_competition.max", "event_pass_l");
    const communityEntrants = await capFor("entrants.per_division.max", "community");
    expect(mEntrants).toBe(128);
    for (const locale of LOCALES) {
      const body = dict(locale)["tips.billing.event-pass.body"];
      expect(body, `${locale}: no tip body`).toBeTruthy();
      expect(body, `${locale}: M entrant cap`).toContain(String(mEntrants));
      expect(body, `${locale}: L division cap`).toContain(String(lDivisions));
      // The bug itself: the tip must never quote COMMUNITY's cap as the
      // pass's. The tip describes only what the pass grants, so this figure
      // has no legitimate reason to appear in it.
      expect(body, `${locale}: must not quote community's cap`).not.toContain(
        String(communityEntrants),
      );
    }
  });

  it("the Event Pass help article presents both rungs with their live caps", async () => {
    const article = readFileSync("content/help/billing/event-pass.md", "utf8");
    const mEntrants = await capFor("entrants.per_division.max", "event_pass");
    const mDivisions = await capFor("divisions.per_competition.max", "event_pass");
    const lDivisions = await capFor("divisions.per_competition.max", "event_pass_l");
    expect(await capFor("entrants.per_division.max", "event_pass_l"), "L is unlimited").toBeNull();
    expect(article).toContain(`**${mEntrants} entrants**`);
    expect(article).toContain(`**${mDivisions} divisions**`);
    expect(article).toContain(`**${lDivisions} divisions**`);
    // The article's own name for L's null cap. Without it a reader comparing
    // the two sizes has no reason to pay the difference.
    expect(article.toLowerCase()).toContain("unlimited entrants");
    // Same 64-for-128 defect as the tip, in the "Can I buy a pass on top of
    // Pro?" answer, which compared Pro's 256 against "the pass's 64".
    expect(article).not.toMatch(/pass(?:'s|es)?\s+64\b/i);
  });

  // The article a buyer opens at the exact moment a cap bites, and the one the
  // v17 #294 sweep MISSED — it stopped at `content/help/billing/`, so this file
  // went on stating M's ceilings as *the pass's* ("128 under an Event Pass…
  // 10 under a pass") for the whole wave. An L buyer read the two numbers they
  // had just paid $59 to remove.
  //
  // Pinned the same way as its billing-section siblings: against the live
  // matrix, and against the shape of the defect (a ceiling attributed to "a
  // pass" with no rung beside it).
  it("the add-a-division article gives BOTH rungs, at their live caps", async () => {
    const md = readFileSync("content/help/getting-started/add-a-division.md", "utf8");
    /** One `**Question?**` line — the answers are scoped so a figure that
     *  belongs to the divisions answer cannot satisfy the entrants one. */
    const answer = (question: string) =>
      md.split("\n").find((l) => l.startsWith(`**${question}`)) ?? "";

    const entrants = answer("How many entrants");
    expect(entrants, "no entrants answer").toBeTruthy();
    expect(entrants).toContain(`**${await capFor("entrants.per_division.max", "community")}**`);
    expect(entrants).toContain(`**${await capFor("entrants.per_division.max", "event_pass")}**`);
    expect(entrants).toContain(`**${await capFor("entrants.per_division.max", "pro")}**`);
    // L's cap is NULL in the matrix, so the article has to say so in words.
    expect(await capFor("entrants.per_division.max", "event_pass_l"), "L is unlimited").toBeNull();
    expect(entrants.toLowerCase()).toContain("no limit at all");

    const divisions = answer("How many divisions");
    expect(divisions, "no divisions answer").toBeTruthy();
    expect(divisions).toContain(`**${await capFor("divisions.per_competition.max", "community")}**`);
    expect(divisions).toContain(
      `**${await capFor("divisions.per_competition.max", "event_pass")}**`,
    );
    expect(divisions).toContain(
      `**${await capFor("divisions.per_competition.max", "event_pass_l")}**`,
    );

    // THE defect, in both answers: a ceiling handed to "an Event Pass" / "a
    // pass" with no size beside it states one rung's limit as the product's.
    // Requiring both size letters in each answer is what the pre-fix text
    // fails — it named neither.
    for (const [name, line] of [
      ["entrants", entrants],
      ["divisions", divisions],
    ] as const) {
      expect(line, `${name}: names the M rung`).toMatch(/\*\*M\*\*/);
      expect(line, `${name}: names the L rung`).toMatch(/\*\*L\*\*/);
    }
  });

  // `content/help/billing/plans.md` was the ONE help article with no test
  // reading it — its sibling `event-pass.md` (which it links to) has been
  // pinned above since T6. That gap is not hypothetical: plans.md is exactly
  // where the "64 entrants" rot survived V319 *and* V341, describing the pass
  // with Community's cap for two migrations, and it is `order: 1` in the
  // billing section — the first thing a reader deciding what to buy opens.
  describe("the plans-at-a-glance article quotes the matrix, not remembered numbers", () => {
    const article = () => readFileSync("content/help/billing/plans.md", "utf8");

    /** One `## ` section's body. Scoped because the article legitimately quotes
     *  FOUR plans' caps, so a page-wide assertion about any single number can
     *  neither confirm nor deny which plan it belongs to — the precise reason
     *  "64 entrants" read as correct here while describing the wrong plan. */
    const section = (heading: string): string => {
      const md = article();
      const start = md.indexOf(`## ${heading}`);
      expect(start, `no "## ${heading}" section`).toBeGreaterThan(-1);
      const rest = md.slice(start + 3);
      const end = rest.indexOf("\n## ");
      return end === -1 ? rest : rest.slice(0, end);
    };

    it("gives each Event Pass rung its own live caps, and neither the other's", async () => {
      const mEntrants = await capFor("entrants.per_division.max", "event_pass");
      const mDivisions = await capFor("divisions.per_competition.max", "event_pass");
      const lDivisions = await capFor("divisions.per_competition.max", "event_pass_l");
      expect(await capFor("entrants.per_division.max", "event_pass_l"), "L is unlimited").toBeNull();

      const pass = section("Event Pass");
      expect(pass, "M's entrant cap").toContain(`**${mEntrants} entrants**`);
      expect(pass, "M's division cap").toContain(`**${mDivisions} divisions**`);
      expect(pass, "L's division cap").toContain(`**${lDivisions} divisions**`);
      // L's null cap has to be SAID, or a reader has no reason to pay the
      // difference between the two sizes.
      expect(pass.toLowerCase(), "L's null entrant cap").toContain("unlimited entrants");
    });

    it("never describes the pass with Community's entrant cap — the bug that lived here", async () => {
      const communityEntrants = await capFor("entrants.per_division.max", "community");
      const proEntrants = await capFor("entrants.per_division.max", "pro");
      const pass = section("Event Pass");
      // Both neighbours: the rot was Community's number, but Pro's would read
      // just as plausibly and would oversell the pass rather than undersell it.
      expect(pass, "community's cap").not.toContain(String(communityEntrants));
      expect(pass, "pro's cap").not.toContain(String(proEntrants));
    });

    it("quotes each plan's own live entrant cap in its own section", async () => {
      const cases: Array<[string, string]> = [
        ["Community", "community"],
        ["Pro", "pro"],
      ];
      for (const [heading, planKey] of cases) {
        const entrants = await capFor("entrants.per_division.max", planKey);
        expect(section(heading), `${heading} entrants`).toContain(
          `${entrants} entrants per division`,
        );
      }
      // Pro Plus's cap is NULL in the matrix, so the article must say so in
      // words rather than print a number.
      expect(await capFor("entrants.per_division.max", "pro_plus")).toBeNull();
      expect(section("Pro Plus").toLowerCase()).toContain("unlimited entrants per division");
    });

    it("quotes the live monthly credit allowances", async () => {
      // The same three numbers the /pricing cards render live. Here they are
      // hand-written prose, in a table-shaped sentence, four plans deep.
      const md = article();
      for (const plan of ["community", "pro", "pro_plus"]) {
        const credits = await capFor("ai.credits.monthly", plan);
        expect(md, `${plan} credits`).toContain(String(credits));
      }
    });

    it("quotes the live platform fee in its table ROW, for every plan", async () => {
      // The fee table is the article's densest claim about money and the only
      // place a reader compares every plan at once. Asserted as the whole ROW,
      // not as a bare "5%" anywhere in the file: the pass section separately
      // mentions "a 5% platform fee", so an unscoped search finds a match even
      // when the table itself has drifted.
      const md = article();
      const fee = async (plan: string) => await capFor("registration.fee_percent", plan);
      const rows: Array<[string, number | null]> = [
        ["Community", await fee("community")],
        ["Pro", await fee("pro")],
        ["Pro Plus", await fee("pro_plus")],
      ];
      for (const [label, pct] of rows) {
        expect(md, `${label} fee row`).toContain(`| ${label} | ${pct}% |`);
      }
      // ONE "Event Pass" row covers both rungs, which is only honest while they
      // charge the same. If a rung's fee ever moves, this fails and the article
      // needs two rows — the same reasoning that gave each rung its own column
      // on /pricing.
      const m = await fee("event_pass");
      const l = await fee("event_pass_l");
      expect(l, "the rungs share one fee row, so they must share a fee").toBe(m);
      expect(md, "Event Pass fee row").toContain(`| Event Pass | ${m}% |`);
    });
  });

  // ── v17 gap wave 7 (#299): the Pro Plus card, against the matrix ───────────
  //
  // Every bullet on that card is read under "Everything in Pro, plus…", so each
  // asserts the lower plans do NOT have the thing. Judged against the rows, not
  // against a banned phrase — note the negative case in
  // `localePlusDifferentiatorFaults`: if a migration ever made `scheduling.ai`
  // pro_plus-only the claim becomes TRUE and the guard must fall silent. A rule
  // that fired unconditionally would satisfy every requirement of this task and
  // be wrong the day the matrix moved.

  const boolGrants = async (features: string[]): Promise<FeatureGrants> => {
    const rows = await sql<{ feature_key: string; plan_key: string; bool_value: boolean | null }[]>`
      select feature_key, plan_key, bool_value from plan_entitlements
      where feature_key = any(${features})`;
    expect(rows.length, "plan_entitlements returned no rows for these features").toBeGreaterThan(0);
    const out: FeatureGrants = {};
    for (const row of rows) (out[row.feature_key] ??= {})[row.plan_key] = row.bool_value === true;
    return out;
  };

  /** The card as one value: its bullets, joined so a claim cannot reach across
   *  two of them (every window in the vocabulary stops at sentence punctuation). */
  const plusCardValue = () => [
    { locale: "en" as const, key: "PLUS_CARD_FEATURES", value: PLUS_CARD_FEATURES.join(". ") },
  ];

  // THE DEFECT, stated the way the matrix states it. "AI-assisted scheduling"
  // was sold as what you get for moving up to Pro Plus while `scheduling.ai` was
  // true on every plan key including community — the differentiator was worth
  // exactly nothing.
  it("scheduling.ai is granted on every plan, so it differentiates nothing", async () => {
    expect((await boolGrants(["scheduling.ai"]))["scheduling.ai"]).toEqual({
      community: true,
      event_pass: true,
      event_pass_l: true,
      pro: true,
      pro_plus: true,
    });
  });

  it("the Pro Plus card claims only differentiators Pro Plus actually has", async () => {
    const grants = await boolGrants([
      "scheduling.ai",
      "officials.auto",
      "api.write",
      "support.priority",
    ]);
    expect(localePlusDifferentiatorFaults(plusCardValue(), grants, ["community", "pro"])).toEqual([]);
    // …and the same guard on the PRE-FIX bullet, so this test fails without the
    // copy change rather than merely passing beside it.
    expect(
      localePlusDifferentiatorFaults(
        [{ locale: "en", key: "pre-fix", value: "AI-assisted scheduling. Auto officials assignment" }],
        grants,
        ["community", "pro"],
      ).join(" "),
    ).toContain("sells scheduling.ai as a Pro Plus differentiator, but community already grants it");
  });

  // The replacement claim, judged as the COMPARATIVE it is: true only while
  // pro_plus's `ai.credits.monthly` is strictly greater than every other plan's.
  it("the AI claim the card does make is the one the credit rows back", async () => {
    const rows = await sql<{ plan_key: string; int_value: number | null }[]>`
      select plan_key, int_value from plan_entitlements
      where feature_key = 'ai.credits.monthly'`;
    const credits = Object.fromEntries(rows.map((r) => [r.plan_key, r.int_value]));
    expect(credits.community).toBe(10);
    expect(credits.pro).toBe(60);
    expect(credits.pro_plus).toBe(200);
    expect(localeCreditLeadershipFaults(plusCardValue(), credits)).toEqual([]);
    // Paired both ways. Deleting the claim must red — an absence rule alone
    // would be happiest with a card that says nothing about AI at all.
    expect(
      localeCreditLeadershipFaults(
        [{ locale: "en", key: "pre-fix", value: "AI-assisted scheduling" }],
        credits,
      ),
    ).toEqual(["en pre-fix: never claims the largest monthly AI credit grant"]);
    // …and it must stop being true if the matrix ever moves.
    expect(
      localeCreditLeadershipFaults(plusCardValue(), { ...credits, pro: 500 }).join(" "),
    ).toContain("but pro_plus grants 200");
  });

  // ── FIX ROUND 1 (I2 / I4): every card number against its row ───────────────

  /** The live matrix, for exactly the features the claim tables name. */
  const cardMatrix = async (): Promise<Matrix> => {
    const features = [...new Set(CARD_SURFACES.flatMap((s) => s.claims.map((c) => c.feature)))];
    expect(features.length, "the claim tables name no features").toBeGreaterThan(4);
    const rows = await sql<{ feature_key: string; plan_key: string; int_value: number | null }[]>`
      select feature_key, plan_key, int_value from plan_entitlements
      where feature_key = any(${features})`;
    expect(rows.length, "plan_entitlements returned no rows for the card features").toBeGreaterThan(0);
    const out: Matrix = {};
    for (const row of rows) (out[row.feature_key] ??= {})[row.plan_key] = row.int_value;
    return out;
  };

  it("quotes every cap and fee at the value the matrix holds, on every card", async () => {
    expect(cardMatrixFaults(CARD_SURFACES, LIVE_CARD_BULLETS, await cardMatrix())).toEqual([]);
  });

  /**
   * …and it is a CHECK, not a second copy. Each probe below moves the matrix
   * under copy that stays word-for-word identical — the shape the whole rule
   * exists for, and the shape that scored 1/10 before this round.
   *
   * Committed rather than run once: a literal in a test looks exactly like a
   * check until someone moves the thing it was supposed to be checking.
   */
  it("reds when the matrix moves under copy that never changed", async () => {
    const live = await cardMatrix();
    const moved = (feature: string, plan: string, value: number | null): Matrix => ({
      ...live,
      [feature]: { ...live[feature], [plan]: value },
    });
    const cases: Array<[string, Matrix, string]> = [
      ["members.max null -> 500", moved("members.max", "pro_plus", 500), "card claims UNLIMITED members.max, but the matrix caps pro_plus at 500"],
      ["competitions.max_active null -> 3", moved("competitions.max_active", "pro", 3), "card claims UNLIMITED competitions.max_active, but the matrix caps pro at 3"],
      ["pro_plus fee 1 -> 3", moved("registration.fee_percent", "pro_plus", 3), "does not quote the live pro_plus/registration.fee_percent (3)"],
      ["community fee 8 -> 12", moved("registration.fee_percent", "community", 12), "does not quote the live community/registration.fee_percent (12)"],
      ["event_pass fee 5 -> 7", moved("registration.fee_percent", "event_pass", 7), "does not quote the live event_pass/registration.fee_percent (7)"],
      ["pro fee 2 -> 4", moved("registration.fee_percent", "pro", 4), "does not quote the live pro/registration.fee_percent (4)"],
      ["community divisions 4 -> 2", moved("divisions.per_competition.max", "community", 2), "does not quote the live community/divisions.per_competition.max (2)"],
      ["community entrants 64 -> 16", moved("entrants.per_division.max", "community", 16), "does not quote the live community/entrants.per_division.max (16)"],
      ["pro entrants 256 -> 64", moved("entrants.per_division.max", "pro", 64), "does not quote the live pro/entrants.per_division.max (64)"],
      ["L's entrant cap stops being unlimited", moved("entrants.per_division.max", "event_pass_l", 300), "card claims UNLIMITED entrants.per_division.max, but the matrix caps event_pass_l at 300"],
      ["teams.max null -> 40", moved("teams.max", "pro_plus", 40), "card claims UNLIMITED teams.max, but the matrix caps pro_plus at 40"],
      // Fresh probe G6, from the OTHER side: the lower plan catches up, so the
      // bullet stops differentiating while every string stays true.
      ["pro members.max 15 -> unlimited", moved("members.max", "pro", null), "sells unlimited members.max as a differentiator, but pro is unlimited too"],
      ["pro teams.max 40 -> unlimited", moved("teams.max", "pro", null), "sells unlimited teams.max as a differentiator, but pro is unlimited too"],
      ["clubs.max null -> 20", moved("clubs.max", "pro_plus", 20), "card claims UNLIMITED clubs.max, but the matrix caps pro_plus at 20"],
    ];
    for (const [label, matrix, expected] of cases) {
      expect(cardMatrixFaults(CARD_SURFACES, LIVE_CARD_BULLETS, matrix).join(" | "), label).toContain(
        expected,
      );
    }
    // A DELETED row must be a fault, not "unlimited". `?? null` would have read
    // a vanished feature key as an unlimited allowance and certified the card.
    const withoutMembers = { ...live };
    delete withoutMembers["members.max"];
    expect(cardMatrixFaults(CARD_SURFACES, LIVE_CARD_BULLETS, withoutMembers).join(" | ")).toContain(
      "plan_entitlements has no pro_plus/members.max row",
    );
    // …and an empty matrix must not read as clean.
    expect(cardMatrixFaults(CARD_SURFACES, LIVE_CARD_BULLETS, {}).join(" | ")).toContain(
      "compared the cards against nothing",
    );
    expect(cardMatrixFaults([], LIVE_CARD_BULLETS, live)).toEqual([
      "no card surfaces — this rule examines nothing",
    ]);
    // An empty claim table with no stated reason is a fault; with one, it is a
    // decision. This is what stopped the roadmap being silently uncovered.
    expect(
      cardMatrixFaults(
        [{ array: "PLUS_COMING_SOON", plan: null, claims: [] }, ...CARD_SURFACES],
        LIVE_CARD_BULLETS,
        live,
      ).join(" | "),
    ).toContain("an empty claim table must be a decision, not a silence");
  });

  /**
   * The capability bullets, against the boolean rows.
   *
   * This rule exists because of a FRESH probe set written after the numeric
   * pins were final: 10 falsehoods, 1 caught. Every miss was a capability
   * bullet — `dashboard.branding` going false on pro while the Pro card still
   * promises to remove the badge, `realtime` going false on event_pass while
   * the Pass card still sells a realtime scoreboard. Same falsehood class as a
   * moved cap, invisible to a rule that only reads `int_value`.
   */
  /** Both columns of every row the capability claims name. A capability can be
   *  boolean or int-shaped and the card cannot tell which, so the guard reads
   *  the row rather than a column. */
  const capabilityRows = async (): Promise<RowsByFeature> => {
    const features = [
      ...new Set(CARD_SURFACES.flatMap((s) => (s.booleans ?? []).map((c) => c.feature))),
    ];
    expect(features.length, "no capability claims declared").toBeGreaterThan(15);
    const rows = await sql<
      { feature_key: string; plan_key: string; bool_value: boolean | null; int_value: number | null }[]
    >`select feature_key, plan_key, bool_value, int_value from plan_entitlements
      where feature_key = any(${features})`;
    expect(rows.length, "plan_entitlements returned no capability rows").toBeGreaterThan(0);
    const out: RowsByFeature = {};
    for (const row of rows) {
      (out[row.feature_key] ??= {})[row.plan_key] = { bool: row.bool_value, int: row.int_value };
    }
    return out;
  };

  /**
   * The capability bullets, against the rows.
   *
   * This rule exists because of a fresh probe set written after the numeric
   * pins were final: 10 falsehoods, 1 caught, every miss a capability bullet.
   * `dashboard.branding` going false on pro while the Pro card still promises
   * to remove the badge is the same falsehood class as a moved cap, invisible
   * to a rule that only reads `int_value`.
   */
  it("promises no capability its plan does not grant, on any card", async () => {
    const rows = await capabilityRows();
    expect(cardBooleanFaults(CARD_SURFACES, LIVE_CARD_BULLETS, rows)).toEqual([]);

    // …and it is a check, not a restatement. Each of these revokes a grant and
    // leaves the bullet promising it word for word.
    const revoke = (feature: string, plan: string, patch: Partial<EntitlementRow>): RowsByFeature => ({
      ...rows,
      [feature]: { ...rows[feature], [plan]: { ...rows[feature]![plan]!, ...patch } },
    });
    for (const [feature, plan, patch, expected] of [
      ["dashboard.branding", "pro", { bool: false }, "PRO_FEATURES: promises dashboard.branding, but pro does not grant it"],
      ["realtime", "event_pass", { bool: false }, "PASS_FEATURES: promises realtime, but event_pass does not grant it"],
      // THE L RUNG — fresh probe G1. The card sells both rungs from one list, so
      // a capability lost on L alone still misleads an L buyer.
      ["formats.advanced", "event_pass_l", { bool: false }, "PASS_FEATURES: promises formats.advanced, but event_pass_l does not grant it"],
      ["sponsors.monetize", "event_pass_l", { bool: false }, "PASS_FEATURES: promises sponsors.monetize, but event_pass_l does not grant it"],
      ["api.access", "pro", { bool: false }, "PRO_FEATURES: promises api.access, but pro does not grant it"],
      // Fresh probes G2 / G4 / G5 — bullets that were simply not enumerated.
      ["exports", "pro", { bool: false }, "PRO_FEATURES: promises exports, but pro does not grant it"],
      ["registration.enabled", "community", { bool: false }, "FREE_FEATURES: promises registration.enabled, but community does not grant it"],
      ["clubs.hierarchy", "pro_plus", { bool: false }, "PLUS_CARD_FEATURES: promises clubs.hierarchy, but pro_plus does not grant it"],
      ["discovery.listed", "community", { bool: false }, "FREE_FEATURES: promises discovery.listed, but community does not grant it"],
      ["news.auto", "pro", { bool: false }, "PRO_FEATURES: promises news.auto, but pro does not grant it"],
      ["support.priority", "pro_plus", { bool: false }, "PLUS_CARD_FEATURES: promises support.priority, but pro_plus does not grant it"],
      // Fresh probe G3 — an INT-shaped capability. No boolean moves at all.
      ["dashboard.public.max", "community", { int: 0 }, "FREE_FEATURES: promises dashboard.public.max, but community allows only 0"],
    ] as Array<[string, string, Partial<EntitlementRow>, string]>) {
      expect(
        cardBooleanFaults(CARD_SURFACES, LIVE_CARD_BULLETS, revoke(feature, plan, patch)).join(" | "),
        `${plan}/${feature}`,
      ).toContain(expected);
    }

    // THE POSITIVE HALF. A claim whose bullet has been reworded away must red,
    // or the pin quietly stops examining anything — the failure five guards in
    // this wave shipped with.
    expect(
      cardBooleanFaults(
        CARD_SURFACES,
        { ...LIVE_CARD_BULLETS, PRO_FEATURES: PRO_FEATURES.filter((b) => !/badge/i.test(b)) },
        rows,
      ).join(" | "),
    ).toContain("the copy this dashboard.branding pin describes is gone");
    // …and a deleted row is a fault, not a pass.
    const withoutNews = { ...rows };
    delete withoutNews["news.auto"];
    expect(cardBooleanFaults(CARD_SURFACES, LIVE_CARD_BULLETS, withoutNews).join(" | ")).toContain(
      "plan_entitlements has no pro/news.auto row",
    );
    expect(cardBooleanFaults(CARD_SURFACES, LIVE_CARD_BULLETS, {}).join(" | ")).toContain(
      "this rule examined nothing",
    );
  });

  /**
   * …AND THE RULE THAT MAKES THE ENUMERATION ITSELF CHECKABLE.
   *
   * Every bullet claimed by something, or exempted with a reason. This is the
   * structural answer to a fresh set scoring 1/10 while the tuned set scored
   * 10/10: the rules were not weak, the LIST was incomplete, and nothing could
   * tell the difference.
   */
  /** EVERY feature key the matrix holds — the attribution lexicon is derived
   *  from these, so a bullet naming a feature no card declared is still
   *  recognised as making a claim. */
  const allFeatureKeys = async (): Promise<string[]> => {
    const rows = await sql<{ feature_key: string }[]>`
      select distinct feature_key from plan_entitlements`;
    expect(rows.length, "plan_entitlements has no features").toBeGreaterThan(30);
    return rows.map((r) => r.feature_key);
  };

  it("attributes every bullet on every card to a row or a recorded decision", async () => {
    expect(
      cardBulletAttributionFaults(
        CARD_SURFACES,
        LIVE_CARD_BULLETS,
        await cardMatrix(),
        await allFeatureKeys(),
      ),
    ).toEqual([]);
  });

  it("reds on a bullet nobody attributed, and on an exemption that covers nothing", async () => {
    const matrix = await cardMatrix();
    const features = await allFeatureKeys();
    const faults = (live: Record<string, readonly string[]>, surfaces = CARD_SURFACES) =>
      cardBulletAttributionFaults(surfaces, live, matrix, features).join(" | ");

    // A bullet naming a feature NO card declared. The lexicon is built from the
    // whole matrix precisely so this is still recognised as a claim.
    expect(
      faults({ ...LIVE_CARD_BULLETS, PRO_FEATURES: [...PRO_FEATURES, "Custom domain & white-label"] }),
      // Reported via `custom` (from `domains.custom`) rather than `domain` —
      // the lexicon holds the key's own segments, and singular/plural need not
      // match for the bullet to be flagged.
    ).toContain('"Custom domain & white-label" makes an unattributed claim');

    // ── THE REVIEWER'S THREE, each a second claim riding inside a bullet whose
    //    first claim IS declared. All three were green under per-bullet
    //    attribution; the residue check is what sees them.
    expect(
      faults({ ...LIVE_CARD_BULLETS, PRO_FEATURES: [...PRO_FEATURES, "Unlimited entrants while your competition runs"] }),
      "Pro caps entrants at 256, and the duration grammar used to attribute this whole bullet",
    ).toContain('"Unlimited entrants while your competition runs" makes an unattributed claim');
    expect(
      faults({ ...LIVE_CARD_BULLETS, FREE_FEATURES: [...FREE_FEATURES, "Branded exports on your public dashboard"] }),
      "exports.branded is FALSE on community; the dashboard regex used to cover the whole bullet",
    ).toContain('"Branded exports on your public dashboard" makes an unattributed claim');
    expect(
      faults({ ...LIVE_CARD_BULLETS, FREE_FEATURES: [...FREE_FEATURES, "64 entrants per division, with unlimited clubs & teams"] }),
      "clubs.max on community is 5; says(64) used to attribute the whole bullet",
    ).toContain('"64 entrants per division, with unlimited clubs & teams" makes an unattributed claim');

    // A stale exemption: the phrase it names is gone, so it covers nothing and
    // hides whatever replaced it.
    const stale: CardSurface[] = CARD_SURFACES.map((s) =>
      s.array === "PASS_FEATURES"
        ? { ...s, unclaimed: { ...s.unclaimed, "Upgrades ONE competition, forever": "the old wording" } }
        : s,
    );
    expect(faults(LIVE_CARD_BULLETS, stale)).toContain("is exempted but appears in no bullet");

    // …and an exemption with no real reason is not an exemption.
    const empty: CardSurface[] = CARD_SURFACES.map((s) =>
      s.array === "FREE_FEATURES" ? { ...s, unclaimed: { ...s.unclaimed, "Live standings": "n/a" } } : s,
    );
    expect(faults(LIVE_CARD_BULLETS, empty)).toContain("has an empty exemption reason");
  });

  it("no card claims a feature its own plan does not grant", async () => {
    const grants = await boolGrants([
      "scheduling.ai",
      "officials.auto",
      "api.write",
      "support.priority",
    ]);
    expect(crossCardExclusivityFaults(CARD_SURFACES, LIVE_CARD_BULLETS, grants)).toEqual([]);
    // THE PROBE: the Pro card gaining the Plus card's exclusivity bullet. Every
    // existing string stays true; the two cards simply contradict each other.
    expect(
      crossCardExclusivityFaults(
        CARD_SURFACES,
        { ...LIVE_CARD_BULLETS, PRO_FEATURES: [...PRO_FEATURES, "Auto officials assignment"] },
        grants,
      ).join(" | "),
    ).toContain("the pro card claims officials.auto, but pro does not grant it");
    // …and the negative case: if a migration granted it to pro, saying so on the
    // Pro card becomes true and this rule must fall silent.
    expect(
      crossCardExclusivityFaults(
        CARD_SURFACES,
        { ...LIVE_CARD_BULLETS, PRO_FEATURES: [...PRO_FEATURES, "Auto officials assignment"] },
        { ...grants, "officials.auto": { ...grants["officials.auto"], pro: true } },
      ),
    ).toEqual([]);
    // Anti-vacuity: the rule must be examining something. The Plus card matches
    // three vocabulary entries today.
    expect(
      crossCardExclusivityFaults(
        CARD_SURFACES,
        { ...LIVE_CARD_BULLETS, PLUS_CARD_FEATURES: ["More of everything"] },
        grants,
      ),
    ).toEqual(["no card matched any differentiator vocabulary — this rule examined nothing"]);
  });

  it("the shared pass bullet names both rungs' division caps", async () => {
    const mDivisions = await capFor("divisions.per_competition.max", "event_pass");
    const lDivisions = await capFor("divisions.per_competition.max", "event_pass_l");
    const bullets = PASS_FEATURES.join(" | ");
    expect(bullets).toContain(`${mDivisions} divisions`);
    expect(bullets, "L's ceiling is what the second rung sells").toContain(String(lDivisions));
  });
});
