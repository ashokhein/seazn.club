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
  // Fix round 2 (task 3): the same claim with the UNIT NOUN FIRST — "each
  // division gets its own AI schedule generations" put the per-unit phrase
  // ahead of the run noun, so none of the four patterns above could reach it.
  // Deliberately excludes a bare "a" (as in "a competition"), which reads as an
  // article rather than a distributive here and would match ordinary prose.
  // The window is 60, not the 20 the other direction uses: prose puts the
  // allowance between the two ("every competition comes with its own allowance
  // of scheduling runs" — 43 characters, measured green at 40).
  /\b(per|for\s+each|each|every)\s+(division|competition|event)\b[^.;]{0,60}\b(runs?|generations?|invocations?|jobs?)\b/i,
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
  // Fix round 2 (task 3): the separator was a required literal space, so the
  // hyphenated "never-ending" — the most natural way an editor writes this —
  // walked straight through. The participles are covered for the same reason.
  /\bnever[-\s](expir(es?|ing)|laps(es?|ing)|end(s|ing)?)\b/i,
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

/**
 * The POSITIVE half of the duration claim: a limiting conjunction that GOVERNS
 * an activity word. "while it's active" binds the pass to a condition; "active
 * immediately" is a claim of immediate start and NO end, and must not satisfy a
 * rule meant to assert a bound.
 *
 * The window is 60 characters, not 30. At 30 it FALSE-POSITIVED on truthful
 * copy: "until the competition is archived or no longer active" is 41 characters
 * between the conjunction and the activity word and read as "never states the
 * pass is bounded", and the committed seed fixture sat one word from the same
 * edge. It fails closed, so nothing shipped wrong — but a guard that rejects
 * true prose teaches its next editor to work around it.
 *
 * `runs`/`running` are activity words because that is how the help articles
 * phrase the same bound ("upgrades one competition while it runs"). The
 * conjunction is still required, so widening the activity list cannot let an
 * unbounded claim through.
 */
export const BOUNDED_SCOPE_GRAMMAR =
  /\b(while|for\s+as\s+long\s+as|as\s+long\s+as|until|during)\b[^.:;!?]{0,60}\b(active|running|runs|open|live|under\s*way)\b/i;

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
    // A limiting conjunction that GOVERNS the activity word — see
    // BOUNDED_SCOPE_GRAMMAR for why the window is 60 and not 30.
    if (!BOUNDED_SCOPE_GRAMMAR.test(description.slice(0, colon))) {
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

/** A standalone extra-organisation add-on price, as `org_addons` holds it. */
export interface OrgAddon {
  key: string;
  plan_key: string;
  price: { lookup_key: string; unit_amount: number; currency_options?: Record<string, number> };
}

/**
 * `riderRateFaults` pins the "no more than half" claim to the GRADUATED TIERS
 * only. The same money is also charged through `org_addons` (v17 #293 — buy a
 * slot instead of changing plan), and nothing pinned the two together: all ten
 * amounts agree today, so the copy holds, but an add-on price could drift over
 * half the base with that guard still green and the sentence still on the page.
 *
 * Parity is the right rule rather than a second half-the-base comparison: the
 * add-on and the rider are two ways of billing one thing, so they must be the
 * same number, and equality then carries `riderRateFaults`'s ≤-half verdict
 * across to the add-on for free.
 *
 * Checked in BOTH directions. A missing add-on for a plan that has a rider is a
 * fault too — otherwise deleting the `org_addons` section would make this guard
 * examine nothing and report clean, which is exactly how #293 escaped the
 * sibling seed guard's hand-written section list for a whole wave.
 */
export function orgAddonRiderFaults(plans: PricedPlan[], addons: OrgAddon[]): string[] {
  const faults: string[] = [];
  const byKey = new Map(plans.map((p) => [p.key, p]));
  const pinned = new Set<string>();

  for (const addon of addons) {
    const plan = byKey.get(addon.plan_key);
    if (!plan) {
      faults.push(`${addon.key}: plan_key "${addon.plan_key}" matches no plan in the seed`);
      continue;
    }
    const monthly = plan.prices.monthly;
    const rider = monthly?.tiers?.find((t) => t.up_to === "inf");
    if (!monthly || !rider) {
      faults.push(`${addon.key}: ${addon.plan_key} has no graduated monthly rider to compare against`);
      continue;
    }
    pinned.add(plan.key);
    for (const currency of SEED_CURRENCIES) {
      const addonAmount = amountIn(addon.price, currency);
      const riderAmount = amountIn(rider, currency);
      if (addonAmount === undefined || riderAmount === undefined) {
        faults.push(
          `${addon.key} ${currency}: no price point on ${addonAmount === undefined ? "the add-on" : `${monthly.lookup_key}'s rider`}`,
        );
        continue;
      }
      if (addonAmount !== riderAmount) {
        faults.push(
          `${addon.key} ${currency}: add-on charges ${addonAmount} but ${monthly.lookup_key}'s rider is ${riderAmount} — the "no more than half" copy is pinned to the rider only`,
        );
      }
    }
  }

  for (const plan of plans) {
    if (plan.prices.monthly?.tiers?.some((t) => t.up_to === "inf") && !pinned.has(plan.key)) {
      faults.push(
        `${plan.key}: charges a graduated extra-organisation rider but no org_addons entry pins it to the copy`,
      );
    }
  }
  return faults;
}

// ── Help-article prose ───────────────────────────────────────────────────────
//
// The same falsehoods this module was written for are also on the help pages,
// and prose needs shaping before a claim vocabulary can be pointed at it:
//
//  - FRONTMATTER IS NOT BODY COPY. `plans.md`'s `description:` covers all four
//    plans at once and truthfully says Community is "free forever" — scanning it
//    as pass copy would red on a true sentence. It is stripped, deliberately, so
//    a frontmatter claim is out of scope here rather than silently covered.
//  - LINK TARGETS ARE NOT PROSE. `#the-platform-fee-on-entry-fees` reads as a
//    sentence about fees to any regex; links are reduced to their text.
//  - EMPHASIS BREAKS SENTENCES. `**…first paid entry** the fee is **locked**`
//    splits wrongly on `.` inside `**`, which matters because the fee-lock rule
//    below is deliberately SENTENCE-scoped.
//
// These regexes are English-only. That is correct today — `content/help/**` is a
// single English tree (`HELP_ROOT`, no locale segment, and /help is not nested
// under /[lang]) — but it is an assumption, not a property: if the help tree
// ever gains locales, every rule here silently stops covering them.

/** Strip YAML frontmatter. See the note above on why it is out of scope. */
export function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
}

/** Markdown reduced to the words a reader actually reads. */
export function plainProse(markdown: string): string {
  return markdown.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`]+/g, "");
}

/**
 * The article split at the granularity a claim is made and qualified at: a
 * paragraph, a list item, or a table row.
 *
 * Blank lines alone are too coarse — `event-pass.md`'s fine print is one block
 * of eleven bullets, and a qualifier in bullet 3 would then answer for the claim
 * in bullet 8. That is the "wrong clause in the same sentence" defeat one level
 * up, and it is why every rule below scopes to a block rather than the file.
 */
export function proseBlocks(markdown: string): string[] {
  return stripFrontmatter(markdown)
    .split(/\n{2,}/)
    .flatMap((block) => block.split(/\n(?=\s*(?:[-*+]\s|\|))/))
    .map((block) => plainProse(block).replace(/\s+/g, " ").trim())
    .filter((block) => block.length > 0 && !/^#{1,6}\s/.test(block));
}

/** Sentences of a block, after `plainProse` has made `.` mean what it says. */
export function sentences(block: string): string[] {
  return block.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
}

/** A `## Heading` section's body, or null if the heading is gone. Null is a
 *  fault at the call site, never a silent empty scan. */
export function markdownSection(markdown: string, heading: RegExp): string | null {
  const lines = stripFrontmatter(markdown).split("\n");
  const start = lines.findIndex((l) => /^##\s/.test(l) && heading.test(l));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^##\s/.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

// ── The entry-fee rate lock (V312, db/migration/deltas/V316__competition_fee_lock.sql)
//
// `effectiveFeePercentFor` (server/usecases/registrations.ts) reads
// `competitions.fee_percent ?? feePercentFor(org)`: once a competition has taken
// a paid entry its rate is STAMPED and every later entry pays that same rate,
// immune to a plan change, a group detach, a downgrade — or an Event Pass
// expiring. The help tree said the opposite, twice, in the two places a reader
// looks when their pass is ending.
//
// Note the fee's own vocabulary is bounded by sentence punctuation on both
// sides: "…entry fees? No — every plan can charge entry fees" is two claims, not
// one, and a window that crossed the `?` would read them as one.

// A bare percentage is a fee subject here: "Community's 8% applies again to
// every later entrant" makes the whole claim without using the word "fee", and
// was measured green before this alternative existed. Precision comes from the
// reversion VERB, which no honest sentence in these articles pairs with a rate.
const FEE_SUBJECT = String.raw`(?:platform\s+fee|entry[-\s]fee\s+rate|fee\s+rate|fee\s+percentage|\bfee\b|\d+(?:\.\d+)?\s*%)`;
const FEE_REVERSION_VERB = String.raw`(?:returns?|reverts?|goes?\s+back|went\s+back|drops?\s+back|falls?\s+back|switch(?:es)?\s+back|rises?|climbs?|jumps?|resets?|moves?|applies\s+again|is\s+restored)`;

/** "…and the platform fee returns to your plan's rate" — the claim, not the
 *  sentence, in either word order. */
export const FEE_REVERSION_PATTERNS = [
  new RegExp(`${FEE_SUBJECT}[^.;:!?]{0,80}\\b${FEE_REVERSION_VERB}\\b`, "i"),
  new RegExp(`\\b${FEE_REVERSION_VERB}\\b[^.;:!?]{0,80}${FEE_SUBJECT}`, "i"),
];

const FEE_LOCK_WORD = String.raw`(?:locked|locks|lock|fixed|frozen|pinned|stays?\s+at|does\s+not\s+(?:rise|change|move))`;
const PAID_ENTRY_TRIGGER = String.raw`(?:first\s+(?:paid\s+)?(?:entry|entrant|registration|payment|payer)|(?:already\s+)?(?:taken|took|had|has\s+had)\s+(?:a|its|the)\s+(?:first\s+)?paid\s+(?:entry|registration)|no\s+paid\s+(?:entry|entrant)|never\s+took\s+a\s+paid\s+(?:entry|entrant))`;

/**
 * Does this block state the lock — a fee subject, a lock word AND the trigger
 * that fires it, all in ONE SENTENCE?
 *
 * All three, together, because each pair alone is satisfiable by the wrong
 * clause: "your refund lock date" plus "every paid entry" two sentences apart
 * would otherwise read as a statement about the platform fee, and a lock with no
 * trigger tells a reader nothing about whether their own competition is locked.
 */
export function statesFeeLock(block: string): boolean {
  const subject = new RegExp(FEE_SUBJECT, "i");
  const lock = new RegExp(FEE_LOCK_WORD, "i");
  const trigger = new RegExp(PAID_ENTRY_TRIGGER, "i");
  return sentences(block).some((s) => subject.test(s) && lock.test(s) && trigger.test(s));
}

/**
 * NEGATIVE half: no block may say the entry-fee rate goes back to the plan's
 * rate without qualifying it, IN THAT SAME BLOCK, with the lock.
 *
 * A reversion claim is not false by itself — it is true of a competition that
 * never took a paid entry — so this cannot be a plain denylist. What makes it
 * false is being stated unconditionally, which is precisely what "the claim and
 * its qualifier must share a block" tests.
 */
export function unqualifiedFeeReversionFaults(label: string, markdown: string): string[] {
  const faults: string[] = [];
  for (const block of proseBlocks(markdown)) {
    if (!FEE_REVERSION_PATTERNS.some((p) => p.test(block))) continue;
    if (statesFeeLock(block)) continue;
    faults.push(
      `${label}: "${block.slice(0, 64)}…" says the entry-fee rate goes back to the plan's rate, unqualified by the first-paid-entry lock (V312)`,
    );
  }
  return faults;
}

/**
 * POSITIVE half, and the reason the negative above is not enough on its own:
 * deleting every mention of the fee would satisfy it perfectly while telling an
 * organiser nothing about the rate their entrants will be charged after the pass
 * ends. Absence proves "not false", never "still stated".
 */
export function feeLockStatedFaults(label: string, markdown: string): string[] {
  return proseBlocks(markdown).some(statesFeeLock)
    ? []
    : [`${label}: never states that the entry-fee rate locks at the first paid entry (V312)`];
}

// ── The pass's duration and credit grant, in prose ───────────────────────────

/**
 * The prose counterpart of `passDurationFaults`. Same two halves — no unbounded
 * vocabulary, and the bound actually stated — but scoped to the pass's own
 * copy, and positioned at the OPENING PARAGRAPH rather than a pre-colon clause,
 * because that is where an article makes its scope statement.
 *
 * SCOPING IS LOAD-BEARING, and measured: `plans.md` truthfully says Community is
 * "free forever" and `credits.md` truthfully says pack credits "never expire".
 * Both are `FALSE_PASS_PERMANENCE_PATTERNS` hits and both are correct — this
 * list is only a falsehood about the PASS. Pass it pass copy, nothing else.
 */
export function passBoundProseFaults(label: string, passProse: string): string[] {
  const faults: string[] = [];
  const text = plainProse(stripFrontmatter(passProse));
  for (const pattern of FALSE_PASS_PERMANENCE_PATTERNS) {
    if (pattern.test(text)) {
      faults.push(`${label}: claims the pass has unbounded duration (${pattern.source})`);
    }
  }
  const [opening] = proseBlocks(passProse);
  if (opening === undefined) {
    faults.push(`${label}: no prose to scan — the section is empty or its heading moved`);
  } else if (!BOUNDED_SCOPE_GRAMMAR.test(opening)) {
    faults.push(
      `${label}: the opening paragraph never states the pass is bounded to a running competition`,
    );
  }
  return faults;
}

/**
 * Every AI-credit figure in the pass's own copy, against `PASS_CREDIT_GRANT`.
 *
 * Two directions, because a table writes the figure on the other side of the
 * noun ("| AI credits | +25, one-time |") and a sentence writes it in front
 * ("a one-time top-up of 25 AI credits"). A guard that only read one of them
 * would leave the comparison table — the first thing a buyer looks at —
 * unchecked.
 *
 * Paired with the positive: SOME block must actually state the grant, and every
 * block that states it must say it is one-time. The recurring vocabulary is the
 * inverse claim, and a block that quotes the right number monthly is worse than
 * one that quotes nothing.
 */
export function passCreditProseFaults(label: string, passProse: string): string[] {
  const faults: string[] = [];
  let stated = 0;
  for (const block of proseBlocks(passProse)) {
    const figures = [
      ...block.matchAll(/(?:\+\s*)?(\d[\d,]*)\s+AI\s+credits?\b/gi),
      // The number-after form needs a SEPARATOR, not merely proximity: a free
      // window of a few characters read "…25 AI credits, and a 5% platform fee"
      // as a claim of 5 AI credits (measured). A table cell or a colon is what
      // actually puts a figure after the label.
      ...block.matchAll(/\bAI\s+credits?\b\s*[:|]\s*\+?\s*(\d[\d,]*)\b/gi),
    ].map((m) => Number(m[1].replace(/,/g, "")));
    if (figures.length === 0) continue;

    const snippet = block.slice(0, 48);
    for (const figure of figures) {
      if (figure !== PASS_CREDIT_GRANT) {
        faults.push(
          `${label}: "${snippet}…" quotes ${figure} AI credits, but the pass grants ${PASS_CREDIT_GRANT}`,
        );
      }
    }
    if (!/\b(one[-\s]time|once|single\s+top[-\s]?up)\b/i.test(block)) {
      faults.push(`${label}: "${snippet}…" states the credit grant without saying it is one-time`);
    } else if (figures.includes(PASS_CREDIT_GRANT)) {
      stated += 1;
    }
    for (const pattern of RECURRING_GRANT_PATTERNS) {
      if (pattern.test(block)) {
        faults.push(`${label}: "${snippet}…" sells the one-time grant as recurring (${pattern.source})`);
      }
    }
  }
  if (stated === 0) {
    faults.push(`${label}: never states the one-time +${PASS_CREDIT_GRANT} AI credit grant`);
  }
  return faults;
}

// ── The fee ladder table, against the matrix ─────────────────────────────────

/** Which `plan_entitlements.plan_key`s a fee-ladder row is a claim about. The
 *  Event Pass row is a claim about BOTH rungs — they share the 5% rate, and a
 *  rung whose rate moved would otherwise be invisible in this table. */
export const FEE_LADDER_PLAN_KEYS: Record<string, string[]> = {
  Community: ["community"],
  "Event Pass": ["event_pass", "event_pass_l"],
  Pro: ["pro"],
  "Pro Plus": ["pro_plus"],
};

/** `| Community | 8% |` rows, from a markdown fee table. */
export function feeLadderRows(section: string): Array<{ plan: string; percent: number }> {
  const rows: Array<{ plan: string; percent: number }> = [];
  for (const line of section.split("\n")) {
    const match = /^\|\s*([^|]+?)\s*\|\s*(\d+(?:\.\d+)?)\s*%\s*\|/.exec(plainProse(line));
    if (match) rows.push({ plan: match[1]!, percent: Number(match[2]) });
  }
  return rows;
}

/**
 * The published fee ladder against `registration.fee_percent`, both ways: a row
 * quoting a rate we do not charge, and a plan we charge that the table has
 * stopped listing. The second matters as much — the table is the page a reader
 * is sent to from four other articles, and a silently dropped row reads as "that
 * plan has no platform fee".
 */
export function feeLadderFaults(
  rows: Array<{ plan: string; percent: number }>,
  live: Record<string, number | null>,
): string[] {
  const faults: string[] = [];
  const seen = new Set<string>();
  for (const { plan, percent } of rows) {
    const keys = FEE_LADDER_PLAN_KEYS[plan];
    if (!keys) {
      faults.push(`fee ladder: row "${plan}" matches no plan key`);
      continue;
    }
    seen.add(plan);
    for (const key of keys) {
      if (live[key] !== percent) {
        faults.push(`fee ladder: "${plan}" quotes ${percent}%, but ${key} enforces ${live[key]}%`);
      }
    }
  }
  for (const plan of Object.keys(FEE_LADDER_PLAN_KEYS)) {
    if (!seen.has(plan)) faults.push(`fee ladder: no row for ${plan}`);
  }
  return faults;
}
