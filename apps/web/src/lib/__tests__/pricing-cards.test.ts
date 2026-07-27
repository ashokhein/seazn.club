import { afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  FREE_FEATURES,
  PASS_FEATURES,
  PRO_FEATURES,
  PASS_CREDIT_GRANT,
  ticketTiers,
} from "../pricing-cards";
import { SUPPORTED_CURRENCIES, passPrice } from "../currency";
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

  it("the shared pass bullet names both rungs' division caps", async () => {
    const mDivisions = await capFor("divisions.per_competition.max", "event_pass");
    const lDivisions = await capFor("divisions.per_competition.max", "event_pass_l");
    const bullets = PASS_FEATURES.join(" | ");
    expect(bullets).toContain(`${mDivisions} divisions`);
    expect(bullets, "L's ceiling is what the second rung sells").toContain(String(lDivisions));
  });
});
