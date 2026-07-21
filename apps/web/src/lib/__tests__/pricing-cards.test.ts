import { afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  FREE_FEATURES,
  PASS_FEATURES,
  PRO_FEATURES,
  ticketTiers,
} from "../pricing-cards";
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
  it("only the Event Pass glows", () => {
    expect(ticketTiers("usd").map((t) => Boolean(t.glow))).toEqual([false, true, false]);
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
});
