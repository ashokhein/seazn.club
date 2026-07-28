/**
 * Truth-in-copy guards (v17 gap wave 7, #298 / #299).
 *
 * D22's discipline — "every number a plan card quotes must be the number the
 * resolver enforces" (lib/__tests__/pricing-cards.test.ts) — applied to the
 * surfaces D22 never reached, starting with the product descriptions Stripe
 * renders to a buyer inside Checkout. Nothing generates that prose; it is
 * hand-written, so something has to compare it to `plan_entitlements`.
 *
 * A PLAIN MODULE, not a test file, because Tasks 3, 4 and 7 of this wave import
 * these lists to scan help articles and four-locale dictionaries. Exporting them
 * from a `*.test.ts` made every importer re-run this file's own suite (measured:
 * a 4-test probe reported 21).
 *
 * ── HOW THESE GUARDS ARE BUILT, AND WHY ─────────────────────────────────────
 * Wave 6 shipped two copy guards that passed while the copy said the opposite
 * of the truth. Both failures are designed against here:
 *
 *  1. A DENYLIST OF PHRASINGS lets the same falsehood through reworded — a
 *     guard banning "half price" and "same rate" was beaten by "at the same
 *     cost as the ones already on your bill". So these assert on the CLAIM'S
 *     VOCABULARY, not on sentences.
 *  2. A PRESENCE RULE is beaten identically from the other side — "must mention
 *     add-ons" was satisfied by "the add-ons you've bought STOP COUNTING", the
 *     exact inverse claim. So every presence rule below is PAIRED with a
 *     negative on the inverse claim, and every absence rule with an existence
 *     assertion (absence proves "not false", never "still stated").
 *
 * And the reason both shipped green: they were proved by REVERTING the copy,
 * which only shows the guard notices the one string it was written against.
 * Every guard here is therefore a PURE FUNCTION returning readable fault
 * labels, so "prove it by rewording" is a committed test rather than a manual
 * check that happened once. Same shape as config/__tests__/stripe-plans.test.ts's
 * holed clones.
 *
 * Callers assert `toEqual([])` on the fault array, never a bare `not.toMatch`:
 * an equality names every fault at once instead of stopping at the first, and
 * cannot be satisfied by a guard that silently scanned nothing.
 */
import { PASS_CREDIT_GRANT } from "@/lib/pricing-cards";

// ── Surfaces ─────────────────────────────────────────────────────────────────

/** One customer-facing description in the Stripe seed. */
export interface DescribedEntry {
  section: string;
  key: string;
  description: string;
}

/** Keys of the seed that are developer notes or scalars, never a product list. */
const NON_SECTION_KEY = /^\$comment|^currency$/;

/**
 * Every `product.description` in the seed, found by WALKING it.
 *
 * Deliberately NOT a hand-written list of sections. The sibling seed guard kept
 * one and v17 #293 found `org_addons` had escaped it for a whole wave — a list
 * is itself the thing that must be remembered. `describedSections` below lets a
 * test assert the walk reaches every non-comment key, so a new section is
 * covered the day it is written.
 */
export function describedEntries(seed: Record<string, unknown>): DescribedEntry[] {
  const out: DescribedEntry[] = [];
  for (const [section, value] of Object.entries(seed)) {
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      const record = entry as { key?: unknown; product?: { description?: unknown } };
      const description = record.product?.description;
      if (typeof description !== "string") continue;
      out.push({
        section,
        key: typeof record.key === "string" ? record.key : "(unkeyed)",
        description,
      });
    }
  }
  return out;
}

/** The seed keys that ought to carry descriptions — everything but the
 *  `$comment*` notes and the top-level `currency` scalar. */
export function describedSections(seed: Record<string, unknown>): string[] {
  return Object.keys(seed).filter((k) => !NON_SECTION_KEY.test(k));
}

// ── Claim vocabularies ───────────────────────────────────────────────────────

/**
 * v17 Phase 2 (V322, db/migration/deltas/V322__retire_ai_run_cap.sql) deleted
 * `scheduling.ai.runs_per_division.max` from every plan — AI runs are metered
 * by the credit wallet on every tier now, not a graded per-division count.
 * (Verified: the key has zero rows in plan_entitlements.)
 *
 * These describe the CLAIM — "a quantified allowance of AI runs, allotted per
 * division/competition/event" — not the sentence that used to make it, so a
 * reworded reintroduction is caught too. Fix round 1 widened this after three
 * measured misses: "an allowance of AI schedule runs for each division",
 * "AI scheduling: three runs a division", and "a monthly quota of AI schedule
 * generations per division" all previously returned no faults.
 *
 * The unit noun is deliberately broad (runs/generations/invocations/jobs) and
 * the quantifier deliberately optional, because the falsehood is the PER-UNIT
 * ALLOWANCE, not the digit.
 */
export const RETIRED_AI_RUN_CAP_PATTERNS = [
  // The historical phrasing, kept for traceability.
  /\d+\s+AI\s+schedule\s+runs/i,
  // "<n> runs per division", "runs a competition", "runs for each event".
  /\b(runs?|generations?|invocations?|jobs?)\b[^.;]{0,20}\b(per|for\s+each|each|a)\s+(division|competition|event)\b/i,
  // An AI/scheduling subject, then a run noun, then the per-unit allotment —
  // catches the three measured misses, which put words between the two.
  /\b(AI|scheduling)\b[^.;]{0,40}\b(runs?|generations?|invocations?|jobs?)\b[^.;]{0,20}\b(per|for\s+each|each|a)\s+(division|competition|event)\b/i,
  /\bper[-\s](division|competition|event)\s+(AI\s+)?(schedule\s+)?(runs?|generations?)\b/i,
  // A counted allowance, digits or words.
  /\b\d+\s+(AI|scheduling)\s+(schedule\s+)?(runs?|generations?)\b/i,
  /\b(one|two|three|four|five|six|seven|eight|nine|ten|twelve|twenty)\s+(AI\s+)?(schedule\s+)?runs?\b/i,
];

/**
 * V328/V334 (`org_has_feature`) lock the Event Pass to the competition's own
 * lifecycle: it stops applying once the competition is archived or completed,
 * or more than 7 days past its end date. It does NOT last "for the event's
 * lifetime", or any synonym of that.
 *
 * Vocabulary of UNBOUNDED DURATION. Fix round 1 widened it after three measured
 * misses: "it stays yours for as long as you want", "The upgrade does not
 * lapse", and "Once bought, it is yours to keep".
 *
 * SCOPE — READ BEFORE REUSING. This list is for PASS copy only. Credit packs
 * legitimately never expire (D2, purchased credits are permanent), so several
 * of these patterns are TRUE statements about credits. Never run this against
 * the whole seed, and when Tasks 3/4/7 point it at a help article or a
 * dictionary, scope it to the pass's own paragraph/keys first.
 *
 * Within that scope the patterns are still chosen so a CORRECT sentence ("the
 * pass stops applying after the competition ends") cannot match — the one
 * concessive requires its subject, so "even after you cancel" cannot match
 * either.
 */
export const FALSE_PASS_PERMANENCE_PATTERNS = [
  /\blifetime\b/i,
  /\bforever\b/i,
  /\bpermanentl?y?\b/i,
  /\bnever\s+(expires?|lapses?|ends?)\b/i,
  /\bdoes\s+not\s+(expire|lapse|end)\b/i,
  /\bindefinitely\b/i,
  /\bfor\s+good\b/i,
  /\bno\s+expir(y|ation|ing)\b/i,
  /\bno\s+time\s+limit\b/i,
  /\byours\s+to\s+keep\b/i,
  /\b(stays?|remains?)\s+yours\b/i,
  /\bas\s+long\s+as\s+you\s+(want|like|wish|need|choose)\b/i,
  /\b(even|keeps?\s+working)\s+(after|once)\s+(it|the\s+(competition|event))\b/i,
];

/** The INVERSE of the pass's one-time credit grant: the pass tops the wallet up
 *  ONCE (`PASS_CREDIT_GRANT`; neither rung has an `ai.credits.monthly` row), so
 *  any recurring framing is a false claim, not a rewording. */
export const RECURRING_GRANT_PATTERNS = [
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
 * int-shaped and are checked separately against their caps.
 */
export const PLUS_DIFFERENTIATOR_VOCAB: Array<[feature: string, claim: RegExp]> = [
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

/** A pass rung's key and the copy that sells it. */
export interface Rung {
  key: string;
  description: string;
}

/**
 * The pass's DURATION claim, both halves at once:
 *  - NEGATIVE: no unbounded-duration vocabulary anywhere in the description;
 *  - POSITIVE: the description must still SAY it is bounded. Without this half
 *    the guard only proves "not false" — deleting the qualifier entirely would
 *    pass, and a buyer would be told nothing about when the pass stops.
 *
 * The positive half is CLAUSE-SCOPED to the opening scope statement (before the
 * feature list's colon), because a vocabulary rule is otherwise satisfied by the
 * wrong clause in the same sentence — "10 active competitions" further down
 * would answer a question it was never asked.
 *
 * Two ways that scoping was defeated in fix round 1, both now faults:
 *  - NO COLON at all made `split(":")[0]` return the whole description, so the
 *    feature list answered for the scope statement. Measured: dropping one
 *    character took the wrong-clause fixture from red to green.
 *  - Any bare "active" satisfied it, so "active immediately" — a claim of
 *    immediate start and NO end — passed a rule meant to assert a bound. The
 *    bound's GRAMMAR is now required: a limiting conjunction governing it.
 */
export function passDurationFaults(rungs: Rung[]): string[] {
  const faults: string[] = [];
  for (const { key, description } of rungs) {
    for (const pattern of FALSE_PASS_PERMANENCE_PATTERNS) {
      if (pattern.test(description)) {
        faults.push(`${key}: claims unbounded duration (${pattern.source})`);
      }
    }
    const colon = description.indexOf(":");
    if (colon === -1) {
      faults.push(
        `${key}: no ":" separating the scope statement from the feature list — the bound cannot be scoped`,
      );
      continue;
    }
    // A limiting conjunction that GOVERNS the activity word. "while it's
    // active" binds the pass to a condition; "active immediately" does not.
    if (!/\b(while|for\s+as\s+long\s+as|until|during)\b[^:]{0,30}\b(active|running|open|live)\b/i.test(
      description.slice(0, colon),
    )) {
      faults.push(`${key}: opening clause never states the pass is bounded to an active competition`);
    }
  }
  return faults;
}

/**
 * The pass's CREDIT claim. This is also the POSITIVE PAIRING for the retired
 * AI-run-cap scan: that scan is absence-shaped, so alone it proves only that we
 * stopped quoting a dead cap — never that we replaced it with the mechanism
 * that is actually live. Requiring the grant to be STATED closes it.
 *
 * Three ways to be wrong, all covered: not mentioned; a DIFFERENT number
 * (drift, or a rung-keyed grant — the grant is flat and never reads `pass_key`);
 * or sold as recurring (the inverse claim).
 */
export function passCreditGrantFaults(rungs: Rung[]): string[] {
  const faults: string[] = [];
  for (const { key, description } of rungs) {
    if (!description.includes(`+${PASS_CREDIT_GRANT} AI credits`)) {
      faults.push(`${key}: does not state the +${PASS_CREDIT_GRANT} AI credit grant`);
    }
    for (const match of description.matchAll(/(\d+)\s*AI\s+credits?/gi)) {
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
export interface RungCaps {
  key: string;
  entrants: number | null;
  divisions: number | null;
}

/**
 * Every cap a rung's description quotes must be that rung's OWN live cap:
 *  - a numeric cap must appear as "<n> entrants" / "<n> divisions";
 *  - a NULL cap must be said in words ("unlimited entrants"), and the copy must
 *    then quote no entrant number at all — a null cap with a number beside it is
 *    the M-rung ceiling sold to an L buyer;
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
 * Every claim the description actually makes is judged twice: Pro must not
 * already grant it, and Pro Plus must actually grant it.
 *
 * Two ways the guard could be silently switched off, both faults:
 *  - a reword that DROPS THE FRAME would leave nothing to scope to;
 *  - a reword that leaves the frame but phrases every claim outside the
 *    vocabulary would have the guard examine NOTHING and report clean. The
 *    anti-vacuity check is the positive backstop for a list that is otherwise
 *    all negatives.
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
  // the organisation-count sentence, a scale claim rather than a feature one.
  const rest = description.slice(at);
  const end = rest.search(/\.\s/);
  const clause = end === -1 ? rest : rest.slice(0, end);

  const faults: string[] = [];
  let recognised = 0;
  for (const [feature, claim] of PLUS_DIFFERENTIATOR_VOCAB) {
    if (!claim.test(clause)) continue;
    recognised += 1;
    if (proGrants[feature]) {
      faults.push(`pro_plus: sells ${feature} as a differentiator, but Pro already grants it`);
    }
    if (!plusGrants[feature]) {
      faults.push(`pro_plus: claims ${feature}, but Pro Plus does not grant it`);
    }
  }
  if (recognised === 0) {
    faults.push(
      "pro_plus: names no recognised differentiator — the vocabulary has gone stale and this guard examined nothing",
    );
  }
  return faults;
}

// ── The extra-organisation rider rate ────────────────────────────────────────

/** A graduated price as the seed holds it: tier 1 is the plan base, tier 2+ the
 *  per-extra-organisation rider. */
export interface TieredPrice {
  lookup_key: string;
  unit_amount: number;
  currency_options?: Record<string, number>;
  tiers?: Array<{
    up_to: number | string;
    unit_amount: number;
    currency_options?: Record<string, number>;
  }>;
}

export interface PricedPlan {
  key: string;
  product: { description: string };
  prices: Record<string, TieredPrice>;
}

/** usd rides `unit_amount`; the rest are SET points in `currency_options`. */
export const SEED_CURRENCIES = ["usd", "eur", "gbp", "inr", "aud"] as const;

const amountIn = (
  node: { unit_amount: number; currency_options?: Record<string, number> },
  currency: string,
): number | undefined =>
  currency === "usd" ? node.unit_amount : node.currency_options?.[currency];

/**
 * The extra-organisation rider rate, against the claim the copy makes about it.
 *
 * Both plan descriptions quote the rider as a fraction of the base. That claim
 * was measurably false: at $19/$9 the rider is 47.4% of Pro and at $39/$19 it is
 * 48.7% of Pro Plus, because the seed derives it as "half the base rounded DOWN"
 * (its own `$comment_tiers`). It erred in the buyer's favour — but a price move
 * flips it silently to OVER half, and then the copy overcharges.
 *
 * ROUNDING DOWN IS NOT THE SAME AS "UNDER HALF": in eur and aud on
 * `seazn_pro_monthly` the halves are whole units (1800→900, 2800→1400), so the
 * rider is EXACTLY half. Only a "no more than half" claim is true in all twenty
 * (plan × interval × currency) combinations, and the claim shape below is what
 * decides which comparison this guard enforces — so the copy and the arithmetic
 * can never drift apart in either direction.
 *
 * Anchored on `lookup_key`, never on position: each rider's `currency_options`
 * block appears twice in the file (the graduated tier and the matching
 * `org_addons` price carry identical numbers).
 */
export function riderRateFaults(plans: PricedPlan[]): string[] {
  const faults: string[] = [];
  for (const plan of plans) {
    const description = plan.product.description;

    // Which comparison the COPY licenses. Checked most-specific first, because
    // "no more than half the base rate" also contains "half the base rate".
    const claim = /\b(a\s+little\s+|just\s+)?under\s+half\b/i.test(description)
      ? ("under" as const)
      : /\b(no\s+more\s+than|at\s+most|up\s+to)\s+half\b/i.test(description)
        ? ("atMost" as const)
        : /\bhalf\s+the\s+base\s+rate\b/i.test(description)
          ? ("exactly" as const)
          : null;

    if (claim === null) {
      faults.push(`${plan.key}: makes no statement about the extra-organisation rate`);
      continue;
    }

    for (const [interval, price] of Object.entries(plan.prices)) {
      const base = price.tiers?.find((t) => t.up_to === 1);
      const rider = price.tiers?.find((t) => t.up_to === "inf");
      if (!base || !rider) {
        faults.push(`${price.lookup_key}: no graduated base/rider tiers to compare`);
        continue;
      }
      // The seed's own invariant: tier 1 always equals the headline amount, so
      // "the base rate" is unambiguous.
      if (base.unit_amount !== price.unit_amount) {
        faults.push(
          `${price.lookup_key}: tier 1 (${base.unit_amount}) is not the headline amount (${price.unit_amount})`,
        );
      }
      for (const currency of SEED_CURRENCIES) {
        const baseAmount = amountIn(base, currency);
        const riderAmount = amountIn(rider, currency);
        if (baseAmount === undefined || riderAmount === undefined) {
          faults.push(`${price.lookup_key} ${currency}: no ${interval} price point to compare`);
          continue;
        }
        const half = baseAmount / 2;
        const label = `${price.lookup_key} ${currency}: rider ${riderAmount} vs base ${baseAmount}`;
        if (riderAmount > half) {
          faults.push(`${label} — OVER half, the copy undercharges against what we bill`);
        } else if (claim === "under" && riderAmount === half) {
          faults.push(`${label} — exactly half, but the copy claims UNDER half`);
        } else if (claim === "exactly" && riderAmount !== half) {
          faults.push(`${label} — not exactly half, but the copy claims half with no qualifier`);
        }
      }
    }
  }
  return faults;
}
