import { afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  FREE_FEATURES,
  PASS_FEATURES,
  PLUS_CARD_FEATURES,
  PRO_FEATURES,
  PASS_CREDIT_GRANT,
  ticketTiers,
} from "../pricing-cards";
import { SUPPORTED_CURRENCIES, passPrice } from "../currency";
import {
  BOUNDED_SCOPE_GRAMMAR,
  FALSE_PASS_PERMANENCE_PATTERNS,
  type FeatureGrants,
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
    array: "PASS_FEATURES",
    why: "the Event Pass card on /pricing (and, sliced, the home ticket stub). Bullet 1 is the pass's DURATION — V328/V334 `org_has_feature` drop the pass arm once the competition is archived/completed or 7 days past ends_on, so it is bounded, not permanent. The caps in bullets 2-3 are pinned against plan_entitlements by the D22 suite below; the fee in bullet 4 against registration.fee_percent.",
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
    array: "PLUS_CARD_FEATURES",
    why: "the Pro Plus card on /pricing, read under the `pricing.plus.note` frame 'Everything in Pro, plus…' — so every bullet asserts EXCLUSIVITY and must name something the lower plans lack. plan_entitlements: officials.auto / api.write / support.priority are pro_plus-only; members.max, teams.max and clubs.max are null (unlimited) on pro_plus and capped on pro; ai.credits.monthly is 10/60/200; registration.fee_percent is 1. scheduling.ai is granted on EVERY plan key and must never appear here.",
    bullets: [
      "Unlimited members, teams & clubs",
      "1% platform fee on entry fees",
      "Largest monthly AI credit grant",
      "Auto officials assignment",
      "Write API access & priority support",
    ],
  },
];

const LIVE_CARD_BULLETS: Record<string, readonly string[]> = {
  PASS_FEATURES,
  PLUS_CARD_FEATURES,
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

describe("the /pricing card bullets say what plan_entitlements enforces", () => {
  // THE GATE, first, because it is the rule that does not depend on anyone
  // having imagined the right falsehood.
  it("matches the approved wording, bullet for bullet", () => {
    expect(approvedBulletFaults(APPROVED_CARD_BULLETS, LIVE_CARD_BULLETS)).toEqual([]);
  });

  // …and it covers the arrays that make claims. An inventory that has quietly
  // stopped including an array is the failure this whole wave was about.
  it("pins every card array that is rendered as a claim", () => {
    expect(APPROVED_CARD_BULLETS.map((e) => e.array).sort()).toEqual([
      "PASS_FEATURES",
      "PLUS_CARD_FEATURES",
    ]);
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
    // …and the frame those bullets are read under, which is what makes each one
    // a claim of exclusivity. A reword that drops it would leave the
    // differentiator rules with nothing to scope to.
    expect(en["pricing.plus.note"]).toMatch(/Everything\s+in\s+Pro,\s*plus/i);
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

  it("the shared pass bullet names both rungs' division caps", async () => {
    const mDivisions = await capFor("divisions.per_competition.max", "event_pass");
    const lDivisions = await capFor("divisions.per_competition.max", "event_pass_l");
    const bullets = PASS_FEATURES.join(" | ");
    expect(bullets).toContain(`${mDivisions} divisions`);
    expect(bullets, "L's ceiling is what the second rung sells").toContain(String(lDivisions));
  });
});
