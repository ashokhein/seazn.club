// ─────────────────────────────────────────────────────────────────────────────
// Truth-in-copy guards (v17 gap wave 7, #298 / #299).
//
// D22's discipline — "every number a plan card quotes must be the number the
// resolver enforces" (lib/__tests__/pricing-cards.test.ts) — applied to the
// surfaces D22 never reached: the product descriptions Stripe renders to a
// buyer inside Checkout. Nothing generates these; they are hand-written prose
// that has to be re-checked against the matrix by something.
//
// Tasks 3, 4 and 7 of this wave extend THIS file with more surfaces (help
// articles, dictionaries, the add-ons page) scanned against the same exported
// pattern lists.
//
// ── HOW THESE GUARDS ARE BUILT, AND WHY ──────────────────────────────────────
// Wave 6 shipped two copy guards that passed while the copy said the opposite
// of the truth. Both failures are designed against here:
//
//  1. A DENYLIST OF PHRASINGS lets the same falsehood through reworded — a
//     guard banning "half price" and "same rate" was beaten by "at the same
//     cost as the ones already on your bill". So these assert on the CLAIM'S
//     VOCABULARY, not on sentences.
//  2. A PRESENCE RULE is beaten identically from the other side — "must
//     mention add-ons" was satisfied by "the add-ons you've bought STOP
//     COUNTING", the exact inverse claim. So every presence rule below is
//     PAIRED with a negative on the inverse claim, and every absence rule is
//     paired with an existence assertion (an absence rule proves "not false",
//     never "still stated").
//
// And the reason both shipped green: they were proved by REVERTING the copy,
// which only ever demonstrates that the guard notices the one string it was
// written against. Every guard here is therefore a PURE FUNCTION returning
// readable fault labels, so the "prove it by rewording" step is a committed
// test (see the `describe` at the bottom) rather than a manual check that
// happened once. This is the same reasoning — and the same shape — as
// config/__tests__/stripe-plans.test.ts's holed clones.
//
// Faults are returned as arrays and asserted with `toEqual([])`, never as a
// bare `not.toMatch`: an equality names every fault at once instead of
// stopping at the first, and it cannot be satisfied by a guard that silently
// scanned nothing.
// ─────────────────────────────────────────────────────────────────────────────
import { afterAll, describe, expect, it } from "vitest";
import stripePlans from "@/config/stripe-plans.json";
import { PASS_CREDIT_GRANT } from "@/lib/pricing-cards";
import { sql } from "@/lib/db";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

/** Same shape as pricing-cards.test.ts's capFor (apps/web/src/lib/__tests__/pricing-cards.test.ts)
 *  — duplicated locally rather than imported across test files. The row must
 *  EXIST: `int_value` is legitimately null on these columns (it means
 *  unlimited), so a missing row would otherwise be read as "unlimited" and the
 *  copy check would sail on. */
const capFor = async (feature: string, plan: string): Promise<number | null> => {
  const [row] = await sql<{ int_value: number | null }[]>`
    select int_value from plan_entitlements
    where plan_key = ${plan} and feature_key = ${feature}`;
  expect(row, `plan_entitlements has no ${plan}/${feature} row`).toBeDefined();
  return row!.int_value;
};

/** A boolean grant. A MISSING row denies (lib/entitlements.ts resolver), so
 *  absent reads as false — unlike capFor, where absent is a matrix bug. */
const grants = async (feature: string, plan: string): Promise<boolean> => {
  const [row] = await sql<{ bool_value: boolean | null }[]>`
    select bool_value from plan_entitlements
    where plan_key = ${plan} and feature_key = ${feature}`;
  return row?.bool_value === true;
};

// ── Surfaces ─────────────────────────────────────────────────────────────────

/** Every field Stripe actually renders to a buyer — not the `$comment*` keys,
 *  which are developer notes and never reach Stripe or a customer. Walked
 *  section by section rather than by a generic tree walk so that a NEW section
 *  is a visible omission here (org_addons was invisible to the sibling seed
 *  guard for exactly one wave, per v17 #293). */
export const stripeRenderedText = [
  ...stripePlans.plans.map((p) => p.product.description),
  ...stripePlans.passes.map((p) => p.product.description),
  ...stripePlans.packs.map((p) => p.product.description),
  ...stripePlans.seats.map((p) => p.product.description),
  ...stripePlans.size_packs.map((p) => p.product.description),
  ...stripePlans.org_addons.map((p) => p.product.description),
].join(" | ");

/** The Event Pass rungs, by key. EVERY guard below iterates this array rather
 *  than naming `event_pass`: v17 #294 added a second rung ($59 L), and a guard
 *  hardcoded to the first key silently stops covering the product the moment a
 *  rung is added — which is the precise failure this wave exists to prevent. */
const passRungs = stripePlans.passes.map((p) => ({
  key: p.key,
  description: p.product.description,
}));

// ── Claim vocabularies ───────────────────────────────────────────────────────

/**
 * v17 Phase 2 (V322, db/migration/deltas/V322__retire_ai_run_cap.sql) deleted
 * `scheduling.ai.runs_per_division.max` from every plan — AI runs are metered
 * by the credit wallet on every tier now, not a graded per-division count.
 * (Verified: the key has zero rows in plan_entitlements.)
 *
 * These describe the CLAIM — "a counted allowance of AI runs, allotted per
 * division" — not the one sentence that used to make it, so a reworded
 * reintroduction ("AI-powered scheduling: 10 runs per competition") is caught
 * too. Their reappearance on any surface means we are quoting a number the
 * resolver no longer enforces.
 */
export const RETIRED_AI_RUN_CAP_PATTERNS = [
  /\d+\s+AI\s+schedule\s+runs/i,
  /\bruns?\s+per\s+(division|competition|event)\b/i,
  /\bper[-\s]division\s+(AI\s+)?(schedule\s+)?runs?\b/i,
  /\b\d+\s+(AI|scheduling)\s+(schedule\s+)?runs?\b/i,
  /\bAI\s+runs?\s+(a|per|each)\s+(division|competition|event)\b/i,
];

/**
 * V328/V334 (`org_has_feature`) lock the Event Pass to the competition's own
 * lifecycle: it stops applying once the competition is archived or completed,
 * or more than 7 days past its end date. It does NOT last "for the event's
 * lifetime", or any synonym of that.
 *
 * Vocabulary of UNBOUNDED DURATION, deliberately kept to terms that cannot be
 * part of a true statement about the pass — Tasks 3/4/7 point this same list at
 * help prose and dictionaries, so a pattern that fires on a correct sentence
 * ("the pass stops applying after the competition ends") would be a booby trap.
 * The one concessive included requires its subject, so "even after you cancel"
 * — a true statement about something else — cannot match.
 *
 * SCOPE: pass copy only. The credit PACKS legitimately say "never expire"
 * (D2, purchased credits are permanent), which is why this is never run
 * against `stripeRenderedText` as a whole.
 */
export const FALSE_PASS_PERMANENCE_PATTERNS = [
  /\blifetime\b/i,
  /\bforever\b/i,
  /\bpermanentl?y?\b/i,
  /\bnever\s+expires?\b/i,
  /\bindefinitely\b/i,
  /\bfor\s+good\b/i,
  /\bno\s+expir(y|ation|ing)\b/i,
  /\beven\s+(after|once)\s+(it|the\s+(competition|event))\b/i,
];

/** The INVERSE of the pass's one-time credit grant: the pass tops the wallet up
 *  ONCE (PASS_CREDIT_GRANT, no `ai.credits.monthly` row for either rung —
 *  verified), so any recurring framing is a false claim, not a rewording. */
const RECURRING_GRANT_PATTERNS = [
  /\bmonthly\b/i,
  /\bevery\s+month\b/i,
  /\beach\s+month\b/i,
  /\bper\s+month\b/i,
  /\ba\s+month\b/i,
  /\brecurring\b/i,
];

/**
 * Pro Plus's description is framed "Everything in Pro, plus …", which makes
 * every item after the frame an assertion of EXCLUSIVITY. Each entry maps a
 * feature_key to the vocabulary a description would use to claim it — broad
 * enough that "AI-powered scheduling" and "AI-assisted scheduling" are the same
 * claim, because they are.
 *
 * Boolean features only: the unlimited-scale claims (members/teams/clubs) are
 * int-shaped and get their own check.
 */
const PLUS_DIFFERENTIATOR_VOCAB: Array<[feature: string, claim: RegExp]> = [
  ["scheduling.ai", /\bAI\b[^,.;]{0,20}\bschedul/i],
  ["officials.auto", /\bauto\w*\b[^,.;]{0,20}\bofficials?\b|\bofficials?\b[^,.;]{0,20}\bauto/i],
  ["api.write", /\bwrite\s+API\b/i],
  ["support.priority", /\bpriority\s+support\b/i],
];

// ── Guards, as pure fault-returning functions ────────────────────────────────

/** Retired-feature scan. Returns the source of every pattern that matched. */
export function retiredRunCapFaults(text: string): string[] {
  return RETIRED_AI_RUN_CAP_PATTERNS.filter((p) => p.test(text)).map(
    (p) => `quotes the retired per-division AI-run cap: ${p.source}`,
  );
}

type Rung = { key: string; description: string };

/**
 * The pass's DURATION claim, both halves at once:
 *  - NEGATIVE: no unbounded-duration vocabulary anywhere in the description;
 *  - POSITIVE: the description must still SAY it is bounded. Without this half
 *    the guard only proves "not false" — deleting the qualifier entirely would
 *    pass, and a buyer would be told nothing about when the pass stops.
 *
 * The positive half is CLAUSE-SCOPED to the description's opening clause (the
 * scope statement, before the feature list's colon). A vocabulary rule can
 * otherwise be satisfied by the wrong clause in the same sentence — "10 active
 * competitions" further down would answer a question it was never asked.
 */
export function passDurationFaults(rungs: Rung[]): string[] {
  const faults: string[] = [];
  for (const { key, description } of rungs) {
    for (const pattern of FALSE_PASS_PERMANENCE_PATTERNS) {
      if (pattern.test(description)) {
        faults.push(`${key}: claims unbounded duration (${pattern.source})`);
      }
    }
    const scopeClause = description.split(":")[0] ?? "";
    if (!/\bactive\b/i.test(scopeClause)) {
      faults.push(`${key}: opening clause never states the pass is bounded to an active competition`);
    }
  }
  return faults;
}

/**
 * The pass's CREDIT claim. This is also the POSITIVE PAIRING for the retired
 * AI-run-cap scan above: that scan is absence-shaped, so on its own it proves
 * only that we stopped quoting a dead cap — never that we replaced it with the
 * mechanism that is actually live. Requiring the grant to be STATED is what
 * closes it.
 *
 * Three ways to be wrong, all covered:
 *  - the grant is not mentioned at all;
 *  - a DIFFERENT number is quoted (drift, or a rung-keyed grant — the grant is
 *    flat, `PASS_CREDIT_GRANT`, and never reads `pass_key`);
 *  - the one-time grant is sold as a recurring one (the inverse claim).
 */
export function passCreditGrantFaults(rungs: Rung[]): string[] {
  const faults: string[] = [];
  for (const { key, description } of rungs) {
    if (!description.includes(`+${PASS_CREDIT_GRANT} AI credits`)) {
      faults.push(`${key}: does not state the +${PASS_CREDIT_GRANT} AI credit grant`);
    }
    for (const match of description.matchAll(/(\d+)\s*(?:one-time\s+)?AI\s+credits?/gi)) {
      if (Number(match[1]) !== PASS_CREDIT_GRANT) {
        faults.push(`${key}: quotes ${match[1]} AI credits, but the grant is ${PASS_CREDIT_GRANT}`);
      }
    }
    for (const pattern of RECURRING_GRANT_PATTERNS) {
      if (pattern.test(description)) {
        faults.push(`${key}: sells the one-time grant as recurring (${pattern.source})`);
      }
    }
  }
  return faults;
}

/** A rung's live caps, as the matrix holds them. `null` means unlimited. */
type RungCaps = { key: string; entrants: number | null; divisions: number | null };

/**
 * Every cap a rung's description quotes must be that rung's OWN live cap:
 *  - a numeric cap must appear as "<n> entrants" / "<n> divisions";
 *  - a NULL cap must be said in words ("unlimited entrants"), and the
 *    description must then quote no entrant number at all — a null cap with a
 *    number beside it is the M-rung ceiling sold to an L buyer;
 *  - and no rung may quote ANOTHER rung's distinct figure, which is how one
 *    size's ceiling comes to read as "the pass's" limit.
 */
export function capClaimFaults(rungs: Rung[], caps: RungCaps[]): string[] {
  const faults: string[] = [];
  const capsFor = (key: string) => caps.find((c) => c.key === key);

  for (const { key, description } of rungs) {
    const own = capsFor(key);
    if (!own) {
      faults.push(`${key}: no live caps resolved for this rung`);
      continue;
    }

    if (own.entrants === null) {
      if (!/\bunlimited\s+entrants\b/i.test(description)) {
        faults.push(`${key}: entrant cap is unlimited but the copy never says so`);
      }
      for (const match of description.matchAll(/(\d[\d,]*)\s+entrants\b/gi)) {
        faults.push(`${key}: quotes "${match[1]} entrants" for an unlimited cap`);
      }
    } else if (!description.includes(`${own.entrants} entrants`)) {
      faults.push(`${key}: does not quote its live entrant cap (${own.entrants})`);
    }

    if (own.divisions === null) {
      if (!/\bunlimited\s+divisions\b/i.test(description)) {
        faults.push(`${key}: division cap is unlimited but the copy never says so`);
      }
    } else if (!description.includes(`${own.divisions} divisions`)) {
      faults.push(`${key}: does not quote its live division cap (${own.divisions})`);
    }

    // Cross-rung contamination. Skipped where two rungs genuinely share a
    // figure — there the number is not evidence of anything.
    for (const other of caps) {
      if (other.key === key) continue;
      if (other.entrants !== null && other.entrants !== own.entrants) {
        if (description.includes(`${other.entrants} entrants`)) {
          faults.push(`${key}: quotes ${other.key}'s entrant cap (${other.entrants})`);
        }
      }
      if (other.divisions !== null && other.divisions !== own.divisions) {
        if (description.includes(`${other.divisions} divisions`)) {
          faults.push(`${key}: quotes ${other.key}'s division cap (${other.divisions})`);
        }
      }
    }
  }
  return faults;
}

/**
 * "Everything in Pro, plus X" asserts that X is something Pro does NOT have.
 * Every claim the description actually makes is therefore judged twice: Pro
 * must not already grant it, and Pro Plus must actually grant it.
 *
 * A missing frame is itself a fault. Otherwise a reword that drops it would
 * silently disable this guard and read as a pass — the failure mode this whole
 * file is written against.
 */
export function plusDifferentiatorFaults(
  description: string,
  proGrants: Record<string, boolean>,
  plusGrants: Record<string, boolean>,
): string[] {
  const frame = /Everything\s+in\s+Pro,\s*plus\b/i;
  const at = description.search(frame);
  if (at === -1) {
    return ['pro_plus: no "Everything in Pro, plus" frame — nothing to scope the claims to'];
  }
  // The differentiator list runs to the end of that sentence; what follows is
  // the organisation-count sentence, which is a scale claim, not a feature one.
  const rest = description.slice(at);
  const end = rest.search(/\.\s/);
  const clause = end === -1 ? rest : rest.slice(0, end);

  const faults: string[] = [];
  for (const [feature, claim] of PLUS_DIFFERENTIATOR_VOCAB) {
    if (!claim.test(clause)) continue;
    if (proGrants[feature]) {
      faults.push(`pro_plus: sells ${feature} as a differentiator, but Pro already grants it`);
    }
    if (!plusGrants[feature]) {
      faults.push(`pro_plus: claims ${feature}, but Pro Plus does not grant it`);
    }
  }
  return faults;
}

// ─────────────────────────────────────────────────────────────────────────────
// The guards, against the real seed.
// ─────────────────────────────────────────────────────────────────────────────

describe("stripe-plans.json names no retired feature and no false pass permanence", () => {
  it("quotes no retired per-division AI-run cap, in any section", () => {
    expect(retiredRunCapFaults(stripeRenderedText)).toEqual([]);
  });

  it("every Event Pass rung is sold as bounded, and says so", () => {
    expect(passDurationFaults(passRungs)).toEqual([]);
  });

  it("every Event Pass rung states the flat one-time credit grant, and only that", () => {
    expect(passCreditGrantFaults(passRungs)).toEqual([]);
  });

  // The rungs are told apart ONLY by size, so everything else about them must
  // read identically — a difference in wording between two products that are
  // deliberately identical is how a buyer infers a difference that isn't there.
  it("describes both rungs in the same terms apart from their caps", () => {
    const shape = passRungs.map(({ description }) =>
      description.replace(/\b\d+\s+(entrants|divisions)\b/gi, "N $1").replace(/\bunlimited\s+/gi, "N "),
    );
    expect(new Set(shape).size, `rung copy diverged:\n${shape.join("\n")}`).toBe(1);
  });
});

describe.skipIf(!HAS_DB)("stripe-plans.json quotes the numbers the matrix enforces", () => {
  it("every Event Pass rung quotes its OWN live caps, and no other rung's", async () => {
    const caps: RungCaps[] = [];
    for (const { key } of passRungs) {
      caps.push({
        key,
        entrants: await capFor("entrants.per_division.max", key),
        divisions: await capFor("divisions.per_competition.max", key),
      });
    }
    // Both rungs must actually be in the matrix, or the sweep above proves
    // nothing about a rung that is on sale.
    expect(caps.map((c) => c.key)).toEqual(passRungs.map((r) => r.key));
    expect(capClaimFaults(passRungs, caps)).toEqual([]);
  });

  // The pass grant is a ONE-TIME top-up: neither rung has an `ai.credits.monthly`
  // row, which is what makes "monthly" a false word in that copy rather than a
  // stylistic one, and what makes PASS_CREDIT_GRANT the single source.
  it("neither rung carries a monthly credit allowance in the matrix", async () => {
    for (const { key } of passRungs) {
      const [row] = await sql<{ int_value: number | null }[]>`
        select int_value from plan_entitlements
        where plan_key = ${key} and feature_key = 'ai.credits.monthly'`;
      expect(row, `${key} must have no monthly credit row`).toBeUndefined();
    }
  });

  it("Pro Plus claims no differentiator that Pro already has", async () => {
    const features = PLUS_DIFFERENTIATOR_VOCAB.map(([f]) => f);
    const proGrants: Record<string, boolean> = {};
    const plusGrants: Record<string, boolean> = {};
    for (const feature of features) {
      proGrants[feature] = await grants(feature, "pro");
      plusGrants[feature] = await grants(feature, "pro_plus");
    }
    const plus = stripePlans.plans.find((p) => p.key === "pro_plus")!;
    expect(plusDifferentiatorFaults(plus.product.description, proGrants, plusGrants)).toEqual([]);
  });

  // The int-shaped half of the same "Everything in Pro, plus…" claim.
  it("Pro Plus's unlimited-scale claim is unlimited on Plus and capped on Pro", async () => {
    const plus = stripePlans.plans.find((p) => p.key === "pro_plus")!.product.description;
    for (const [word, feature] of [
      ["members", "members.max"],
      ["teams", "teams.max"],
      ["clubs", "clubs.max"],
    ] as const) {
      if (!new RegExp(`\\b${word}\\b`, "i").test(plus)) continue;
      expect(await capFor(feature, "pro_plus"), `${feature}: Plus must be unlimited`).toBeNull();
      expect(await capFor(feature, "pro"), `${feature}: Pro must be capped`).not.toBeNull();
    }
  });

  // A superlative is a claim about every OTHER plan too, so it is checked
  // against every other plan — not just against Pro Plus's own number.
  it("Pro Plus's 'largest credit grant' claim is the matrix's strict maximum", async () => {
    const plus = stripePlans.plans.find((p) => p.key === "pro_plus")!.product.description;
    // Presence half: Plus's real, live AI differentiator is the wallet size, so
    // the description has to carry it. Its absence is a fault, not a style.
    expect(plus, "Pro Plus must state its AI credit differentiator").toMatch(/\bAI\s+credit/i);
    if (!/\b(largest|biggest|most|highest|greatest)\b[^,.;]{0,40}credit/i.test(plus)) return;
    const rows = await sql<{ plan_key: string; int_value: number | null }[]>`
      select plan_key, int_value from plan_entitlements
      where feature_key = 'ai.credits.monthly'`;
    expect(rows.length, "no monthly credit rows to compare against").toBeGreaterThan(1);
    const plusRow = rows.find((r) => r.plan_key === "pro_plus");
    expect(plusRow?.int_value, "pro_plus has no monthly credit row").toBeTypeOf("number");
    for (const row of rows) {
      if (row.plan_key === "pro_plus") continue;
      expect(
        plusRow!.int_value!,
        `"largest" is false: ${row.plan_key} grants ${row.int_value}`,
      ).toBeGreaterThan(row.int_value ?? Number.POSITIVE_INFINITY);
    }
  });

  // Every plan description quotes its group ceiling in prose. That number is
  // `orgs.max_owned`, and exceeding it is a PURCHASE (the extra-org add-on,
  // v17 #293) — so the figure is the included allowance, not a hard wall, and
  // it has to track the matrix row that decides when the add-on is offered.
  it("each plan quotes its own live organisation allowance", async () => {
    for (const plan of stripePlans.plans) {
      const quoted = /up\s+to\s+(\d+)\s+organisations?/i.exec(plan.product.description);
      expect(quoted, `${plan.key}: no organisation allowance in the copy`).not.toBeNull();
      expect(Number(quoted![1]), `${plan.key} organisation allowance`).toBe(
        await capFor("orgs.max_owned", plan.key),
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PROVING THE GUARDS — by REWORDING, not by reverting.
//
// The real seed is (and must stay) correct, so every assertion above passes
// whether or not the guard actually covers the claim. These point the same pure
// functions at the copy a future editor plausibly writes: the falsehood said a
// different way, and — for each presence rule — its inverse. A guard that only
// notices the exact string it was born against fails here.
//
// Asserted with `toEqual([...])` on the exact fault labels: "it returned
// something" would be satisfied by a guard firing for an unrelated reason.
// ─────────────────────────────────────────────────────────────────────────────
describe("the guards survive a rewording, not just a revert", () => {
  const M = "event_pass";

  it("catches the retired AI-run cap however it is phrased", () => {
    // The historical sentence…
    expect(retiredRunCapFaults("realtime and 10 AI schedule runs per division")).not.toEqual([]);
    // …and four rewordings of the same claim, none of which contain it.
    for (const reworded of [
      "AI-powered scheduling with 6 runs per competition",
      "includes 12 scheduling runs",
      "a generous per-division AI run allowance",
      "5 AI runs per division, included",
    ]) {
      expect(retiredRunCapFaults(reworded), reworded).not.toEqual([]);
    }
    // …while the live, credit-metered story is not a false positive. "news
    // runs" in the credit packs is the phrase that makes a loose /runs?/ rule
    // unusable, so it is pinned here.
    for (const honest of [
      "40 AI credits (schedule / officials / news runs) for your shared wallet",
      "a one-time +25 AI credits added to your wallet",
      "AI-assisted scheduling, metered by your credit wallet",
    ]) {
      expect(retiredRunCapFaults(honest), honest).toEqual([]);
    }
  });

  it("catches unbounded-duration claims however they are phrased", () => {
    const bounded = "One-time upgrade for a single competition, while it's active: 10 divisions";
    expect(passDurationFaults([{ key: M, description: bounded }])).toEqual([]);

    for (const [label, reworded] of [
      ["the original", `${bounded.replace(", while it's active", "")} — for the event's lifetime`],
      ["a synonym", `${bounded} — yours forever`],
      ["another synonym", `${bounded} — a permanent upgrade`],
      ["a third", `${bounded} — it never expires`],
      ["a concessive", `${bounded} — it keeps working even after the competition finishes`],
    ] as const) {
      const faults = passDurationFaults([{ key: M, description: reworded }]);
      expect(faults, label).not.toEqual([]);
      expect(faults.join(" "), label).toContain("unbounded duration");
    }
  });

  // The other half of the same rule. An absence-shaped guard is happiest when
  // the claim is deleted outright — which tells the buyer nothing about when
  // the pass stops, and is exactly how "must mention add-ons" was satisfied by
  // copy saying they stop counting.
  it("catches the bound being DELETED, not just contradicted", () => {
    const silent = "One-time upgrade for a single competition: 10 divisions, 128 entrants";
    const faults = passDurationFaults([{ key: M, description: silent }]);
    expect(faults).toEqual([`${M}: opening clause never states the pass is bounded to an active competition`]);
  });

  // …and it must not be satisfiable by the WRONG CLAUSE in the same sentence:
  // "active competitions" is a feature-list item, not a scope statement.
  it("is not satisfied by the word 'active' appearing further down the sentence", () => {
    const wrongClause = "One-time upgrade for a single competition: 10 active competitions, 128 entrants";
    expect(passDurationFaults([{ key: M, description: wrongClause }])).not.toEqual([]);
  });

  it("catches a missing, drifted, or recurring credit grant", () => {
    const honest = "…and a one-time +25 AI credits added to your wallet.";
    expect(passCreditGrantFaults([{ key: M, description: honest }])).toEqual([]);

    expect(passCreditGrantFaults([{ key: M, description: "…realtime scoreboard." }])).toEqual([
      `${M}: does not state the +25 AI credit grant`,
    ]);
    // Drift, and the rung-keyed grant PASS_CREDIT_GRANT must never become.
    expect(
      passCreditGrantFaults([{ key: M, description: "…and a one-time +50 AI credits." }]).join(" "),
    ).toContain("quotes 50 AI credits");
    // The inverse claim: right number, wrong cadence.
    expect(
      passCreditGrantFaults([
        { key: M, description: "…and +25 AI credits every month while it runs." },
      ]).join(" "),
    ).toContain("recurring");
  });

  it("catches one rung wearing the other's caps", () => {
    const caps: RungCaps[] = [
      { key: "event_pass", entrants: 128, divisions: 10 },
      { key: "event_pass_l", entrants: null, divisions: 20 },
    ];
    const honest: Rung[] = [
      { key: "event_pass", description: "10 divisions, 128 entrants per division" },
      { key: "event_pass_l", description: "20 divisions, unlimited entrants per division" },
    ];
    expect(capClaimFaults(honest, caps)).toEqual([]);

    // L sold with M's ceiling — the exact defect that made "an Event Pass caps
    // at 128" read as true for the product a buyer paid $59 to escape.
    expect(
      capClaimFaults(
        [{ key: "event_pass_l", description: "20 divisions, 128 entrants per division" }],
        caps,
      ),
    ).toEqual([
      "event_pass_l: entrant cap is unlimited but the copy never says so",
      'event_pass_l: quotes "128 entrants" for an unlimited cap',
      "event_pass_l: quotes event_pass's entrant cap (128)",
    ]);

    // A stale number that belongs to nobody.
    expect(
      capClaimFaults([{ key: "event_pass", description: "10 divisions, 64 entrants" }], caps).join(" "),
    ).toContain("does not quote its live entrant cap (128)");
  });

  it("catches a Pro Plus differentiator Pro already has, however it is phrased", () => {
    // The live matrix, as this file's DB tests read it: scheduling.ai is true
    // on EVERY plan, so it can never be a Pro Plus differentiator.
    const proGrants = {
      "scheduling.ai": true,
      "officials.auto": false,
      "api.write": false,
      "support.priority": false,
    };
    const plusGrants = {
      "scheduling.ai": true,
      "officials.auto": true,
      "api.write": true,
      "support.priority": true,
    };
    const honest =
      "Everything in Pro, plus automatic officials assignment, write API access and priority support. Covers up to 10 organisations.";
    expect(plusDifferentiatorFaults(honest, proGrants, plusGrants)).toEqual([]);

    for (const reworded of [
      "Everything in Pro, plus AI-assisted scheduling and priority support.",
      "Everything in Pro, plus AI-powered scheduling.",
      "Everything in Pro, plus AI schedule building.",
    ]) {
      expect(plusDifferentiatorFaults(reworded, proGrants, plusGrants), reworded).toEqual([
        "pro_plus: sells scheduling.ai as a differentiator, but Pro already grants it",
      ]);
    }

    // A claim Pro Plus does not actually grant, caught from the other side.
    expect(
      plusDifferentiatorFaults("Everything in Pro, plus write API access.", proGrants, {
        ...plusGrants,
        "api.write": false,
      }),
    ).toEqual(["pro_plus: claims api.write, but Pro Plus does not grant it"]);

    // And dropping the frame disables the scope — so it is a fault in itself.
    expect(plusDifferentiatorFaults("Now with AI-assisted scheduling.", proGrants, plusGrants)).toEqual([
      'pro_plus: no "Everything in Pro, plus" frame — nothing to scope the claims to',
    ]);
  });
});
