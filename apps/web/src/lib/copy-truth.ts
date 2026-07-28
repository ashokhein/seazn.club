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
export const NON_SECTION_KEY = /^\$comment|^currency$/;

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
  // Fix round 2: `every` was missing from the distributive list, so
  // "5 schedule runs for every division" returned no fault (measured).
  // Fix round 2: `attempts` was not a unit noun, so "AI scheduling is limited to
  // 5 attempts per division" scanned clean.
  /\b(runs?|generations?|invocations?|jobs?|attempts?|tries|uses?|calls?)\b[^.;]{0,20}\b(per|for\s+each|for\s+every|each|every|a)\s+(division|competition|event)\b/i,
  // Fix round 2: the allowance stated with NO unit noun at all — "Each division
  // may be scheduled by AI up to 20 times." A count of "times" is the unit.
  /\b(per|for\s+each|each|every)\s+(division|competition|event)\b[^.;]{0,60}\b(?:up\s+to\s+)?\d+\s+times?\b/i,
  // An AI/scheduling subject, then a run noun, then the per-unit allotment —
  // catches the three measured misses, which put words between the two.
  /\b(AI|scheduling)\b[^.;]{0,40}\b(runs?|generations?|invocations?|jobs?)\b[^.;]{0,20}\b(per|for\s+each|for\s+every|each|every|a)\s+(division|competition|event)\b/i,
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
  // Fix round 1 (task 4): forms of the same claim that the list above could not
  // reach. `never expire` was covered only because the plural verb happens to
  // share a stem with the singular; the negated-auxiliary and the
  // lifetime-adverbial forms had no entry at all.
  /\b(do|does|will)\s+not\s+(expire|lapse|end|stop|run\s+out)\b/i,
  /\b(don['’]t|doesn['’]t|won['’]t)\s+(expire|lapse|end|stop|run\s+out)\b/i,
  /\bnever\s+(?:ever\s+)?(stops?|stop|runs?\s+out)\b/i,
  /\bfor\s+life\b/i,
  /\bin\s+perpetuity\b/i,
  /\bno\s+end\s+date\b/i,
  // Fix round 1, second pass. An ADVERSARIAL set — permanence claims written
  // the way a speaker writes them rather than the way the rules above were
  // written — scored 0/8 in English and 0/32 across the four locales. Every
  // pattern above names a specific WORD; none names the CLAIM FAMILY. These
  // three families are what generalise:
  //   1. absence-of-an-end nouns,
  //   2. endurance verbs,
  //   3. "always" bound to a retention word (bare "always" is far too common
  //      in true copy to ban, so it is only a fault when it governs keeping).
  /\bno\s+(end|cut[-\s]?off|expiry|expiration|deadline)\b/i,
  /\bno\s+limit\s+on\s+(how\s+long|time|duration)\b/i,
  /\bwithout\s+(end|expiry|expiration)\b/i,
  /\b(endures?|persists?|carries\s+on|sticks\s+around|remains?\s+in\s+force)\b/i,
  /\bfor\s+the\s+rest\s+of\s+(time|your\s+life)\b/i,
  /\b(keeps?|yours|stays?|remains?)\b[^.;,]{0,24}\balways\b|\balways\b[^.;,]{0,24}\b(yours|keep|keeps|stays?|remains?)\b/i,
  /\b(no\s+matter\s+what|whatever\s+happens)\b/i,
];

/**
 * The POSITIVE half of the duration claim: a limiting conjunction that GOVERNS
 * an activity word. "while it's active" binds the pass to a condition; "active
 * immediately" is a claim of immediate start and NO end, and must not satisfy a
 * rule meant to assert a bound.
 *
 * ── WHY THIS IS A GRAMMATICAL RELATION AND NOT A CHARACTER DISTANCE ──────────
 * Two rounds of this rule were written as `conjunction … {0,N} … activity word`
 * and BOTH were wrong, in opposite directions:
 *
 *   N=30  rejected TRUE copy — "until the competition is archived or no longer
 *         active" is 41 characters, and read as "never states the bound".
 *   N=60  accepted FALSE copy — "Buy it during the summer and your competition
 *         stays active" has no bound at all, but the two words are close
 *         enough. Measured: 3 of 3 no-bound sentences passed at 60.
 *
 * A distance cannot tell governing from adjacent, so neither number was ever
 * going to be right. What actually distinguishes them is CLAUSE MEMBERSHIP: in
 * the true sentence the activity word is the predicate of the clause the
 * conjunction introduces; in the false one a NEW SUBJECT ("and your
 * competition") has started a new clause and the conjunction governs nothing.
 *
 * So the relation is expressed directly: from the conjunction to the activity
 * word there may be no clause boundary — no sentence punctuation, no comma, and
 * no coordinator followed by a determiner (which is a new subject, i.e. a new
 * clause). Distance is unbounded, because a long clause is still one clause.
 *
 * Note "or no longer active" survives this: `or` is followed by an adverb, not
 * a determiner, so it coordinates a predicate rather than starting a clause.
 * That is exactly the distinction the character windows could not draw.
 */
const CLAUSE_BREAK: Record<string, string> = {
  en: String.raw`(?:\b(?:and|or|but|so|then|yet)\s+(?:the|a|an|your|our|my|its|their|this|that|these|those|it|we|you|they)\b)`,
  es: String.raw`(?:\b(?:y|e|o|u|pero|así\s+que)\s+(?:el|la|los|las|un|una|tu|tus|su|sus|este|esta|ese|esa)\b)`,
  fr: String.raw`(?:\b(?:et|ou|mais|donc)\s+(?:le|la|les|un|une|ton|ta|tes|votre|vos|son|sa|ses|ce|cette|ces)\b)`,
  nl: String.raw`(?:\b(?:en|of|maar|dus)\s+(?:de|het|een|je|jouw|uw|zijn|haar|dit|dat|deze|die)\b)`,
};

/**
 * Build the bounded-scope rule for one language from its own vocabulary.
 *
 * A BUILDER, not four copies: the four locale rules in `LOCALE_CLAIMS` and the
 * English rule below are the SAME grammatical claim in different words, and the
 * previous shape had each of them carrying its own `{0,60}`. When the window
 * turned out to be wrong it was wrong in five places. Now the relation lives
 * here and a language supplies only nouns and conjunctions.
 */
export function boundedScopeGrammarSource(
  conjunctions: string[],
  activity: string[],
  locale: keyof typeof CLAUSE_BREAK = "en",
  forbiddenComplement: string[] = [],
): string {
  const guard =
    forbiddenComplement.length === 0 ? "" : String.raw`(?!\s*(?:${forbiddenComplement.join("|")}))`;
  return (
    String.raw`\b(?:${conjunctions.join("|")})\b` +
    guard +
    String.raw`(?:(?!${CLAUSE_BREAK[locale]})[^.:;!?,])*?` +
    String.raw`\b(?:${activity.join("|")})\b`
  );
}

/**
 * `runs`/`running` are activity words because that is how the help articles
 * phrase the same bound ("upgrades one competition while it runs"). The
 * conjunction is still required, so widening the activity list cannot let an
 * unbounded claim through.
 *
 * The source is exported separately from the compiled pattern because the four
 * locale rules must compile the SAME source through `claim()` (Unicode `\b`,
 * for the accented-character bug task 4 measured) while this one is only ever
 * tested against English values, and `claim` is defined further down the file.
 *
 * FIX ROUND 2 — three more ways a conjunction failed to govern, all measured by
 * the reviewer against copy stating no bound at all:
 *
 *  - `during` takes a NOUN PHRASE, never a clause, so "During checkout your
 *    Event Pass becomes active" put the activity word in a different clause with
 *    nothing joining them. It survives only with a competition-shaped
 *    complement, which is the one reading that IS a temporal bound ("during the
 *    event the pass runs").
 *  - "Until NOW nobody could keep a competition active without Pro" is a
 *    statement about the past, not a bound.
 *  - "While BROWSING the pricing page you can keep every competition active" —
 *    a gerund complement has no subject, so the clause the conjunction
 *    introduces is not about the competition at all.
 */
export const BOUNDED_SCOPE_GRAMMAR_SOURCE = boundedScopeGrammarSource(
  [
    "while",
    String.raw`for\s+as\s+long\s+as`,
    String.raw`as\s+long\s+as`,
    "until",
    String.raw`during\s+(?:the\s+|that\s+|this\s+|its\s+|your\s+)?(?:competition|event|season|tournament|pass)`,
  ],
  ["active", "running", "runs", "open", "live", String.raw`under\s*way`],
  "en",
  [String.raw`now\b`, String.raw`\w+ing\b`],
);

export const BOUNDED_SCOPE_GRAMMAR = new RegExp(BOUNDED_SCOPE_GRAMMAR_SOURCE, "i");

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
  // Fix round 2 (M4): the list was MONTHLY-ONLY, but the claim being guarded is
  // "the grant repeats" — a yearly or weekly framing is the same falsehood, and
  // the pass grants once. Verified against all 12 seed descriptions: none of
  // these fire on true copy today.
  /\b(annual|annually|yearly)\b/i,
  /\b(a|per|every|each)\s+year\b/i,
  /\b(weekly|quarterly|daily)\b/i,
  /\b(a|per|every|each)\s+(week|quarter|day)\b/i,
  /\b(renews?|renewing|renewal|tops?\s+up\s+again|again\s+each)\b/i,
  /\b(per|each|every)\s+billing\s+(period|cycle)\b/i,
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
  // Task 4 widened this to BOTH WORD ORDERS. It required "AI" before
  // "schedul…", so "scheduling with AI built in" — an ordinary way to write the
  // same claim, and the order every other language uses — returned no fault
  // (measured). The alternation costs nothing and closes the hole for every
  // surface that imports this list.
  ["scheduling.ai", /\bAI\b[^,.;]{0,20}\bschedul|\bschedul\w*\b[^,.;]{0,20}\bAI\b/i],
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
  return claimSurfaces(markdown)
    .filter((surface) => surface.kind === "prose")
    .map((surface) => surface.text);
}

/** Where in an article a claim can be made. */
export type ClaimSurfaceKind = "frontmatter" | "heading" | "prose";

export interface ClaimSurface {
  kind: ClaimSurfaceKind;
  /** The frontmatter key, for a `frontmatter` surface. */
  field?: string;
  /** The words a reader actually reads, normalised like a prose block. */
  text: string;
}

/**
 * EVERY user-visible surface of an article, not just its paragraphs.
 *
 * ── WHY THIS EXISTS (fix round 3) ────────────────────────────────────────────
 * `proseBlocks` strips frontmatter and filters headings, so until now EVERY rule
 * in this module was blind to both — while `_approved-copy.ts` claimed to pin
 * "the WHOLE article". A reviewer put the wave's two flagship falsehoods into a
 * heading and into `description:` and the suite stayed 42/0. Measured delivery
 * rates: 0/36 through a heading, 0/24 through frontmatter, against 12/12 for the
 * same sentences as paragraphs.
 *
 * Neither surface is decorative. `app/help/[...slug]/page.tsx` renders
 * `description` as the LEAD PARAGRAPH under the title and emits it as page
 * metadata, and `help-search.tsx` shows it as the search-result snippet — so a
 * false `description` is the first sentence a reader sees and the one they see
 * before they even open the page. Headings are read by everyone who skims.
 *
 * `proseBlocks` keeps its old contract (prose only) by being DERIVED from this,
 * so the two cannot drift apart the way the comment and the code just did.
 *
 * Frontmatter fields are included unless their value is purely numeric (`order:
 * 3`), which is deliberately inclusive: a field added later is covered by
 * default, and covering it costs one deliberate re-approval rather than a silent
 * hole.
 */
export function claimSurfaces(markdown: string): ClaimSurface[] {
  const surfaces: ClaimSurface[] = [];
  const normalise = (text: string): string => plainProse(text).replace(/\s+/g, " ").trim();

  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(markdown);
  if (frontmatter) {
    for (const line of frontmatter[1]!.split(/\r?\n/)) {
      const field = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
      if (!field) continue;
      const value = field[2]!.trim().replace(/^["']|["']$/g, "");
      if (value.length === 0 || /^\d+(?:\.\d+)?$/.test(value)) continue;
      surfaces.push({ kind: "frontmatter", field: field[1]!, text: normalise(value) });
    }
  }

  for (const block of stripFrontmatter(markdown).split(/\n{2,}/)) {
    for (const piece of block
      .split(/\n(?=\s*#{1,6}\s)/)
      .flatMap((part) => part.split(/\n(?=\s*(?:[-*+]\s|\|))/))) {
      const heading = /^\s*#{1,6}\s+(.*)$/.exec(piece);
      const text = normalise(heading ? heading[1]! : piece);
      if (text.length === 0) continue;
      surfaces.push({ kind: heading ? "heading" : "prose", text });
    }
  }
  return surfaces;
}

/**
 * The surfaces the SENTENCE-level rules read: prose and frontmatter.
 *
 * Headings are deliberately NOT here, and this is a limit rather than an
 * oversight: a heading is a fragment, so sentence-shaped rules mis-read it
 * ("When a pass stops applying" is a true heading that no approved form fits).
 * Headings are covered by the inventory gate, which does not read them.
 */
export function claimTexts(markdown: string): string[] {
  return claimSurfaces(markdown)
    .filter((surface) => surface.kind !== "heading")
    .map((surface) => surface.text);
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
const FEE_SUBJECT = String.raw`(?:platform\s+fees?|entry[-\s]fee\s+rate|fee\s+rate|fee\s+percentage|\bfees?\b|(?:plan|we|platform)\s+charges?\b|\bcharged\b|\bpricing\b|\d+(?:\.\d+)?\s*%)`;
const FEE_REVERSION_VERB = String.raw`(?:returns?|reverts?|goes?\s+back|went\s+back|drops?\s+back|falls?\s+back|switch(?:es)?\s+back|rises?|climbs?|jumps?|resets?|moves?|applies\s+again|is\s+restored)`;

/** "…and the platform fee returns to your plan's rate" — the claim, not the
 *  sentence, in either word order. */
export const FEE_REVERSION_PATTERNS = [
  new RegExp(`${FEE_SUBJECT}[^.;:!?]{0,80}\\b${FEE_REVERSION_VERB}\\b`, "i"),
  new RegExp(`\\b${FEE_REVERSION_VERB}\\b[^.;:!?]{0,80}${FEE_SUBJECT}`, "i"),
];

const FEE_LOCK_WORD = String.raw`(?:locked|locks|lock|fixed|frozen|pinned|stays?\s+at|does\s+not\s+(?:rise|change|move))`;
// `card` is optional-but-recognised throughout: the trigger is the first paid
// CARD entry (an offline entry carries no rate and leaves the competition
// unlocked — see the comment above the stamp in registrations.ts), so copy that
// says so precisely must satisfy this, not fall through it.
const PAID_ENTRY_TRIGGER = String.raw`(?:first\s+(?:paid\s+)?(?:card\s+)?(?:entry|entrant|registration|payment|payer)|(?:already\s+)?(?:taken|took|had|has\s+had)\s+(?:a|its|the)\s+(?:first\s+)?paid\s+(?:card\s+)?(?:entry|registration)|no\s+paid\s+(?:card\s+)?(?:entry|entrant)|never\s+took\s+a\s+paid\s+(?:card\s+)?(?:entry|entrant))`;

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
 * ── THE SHAPE FIX (fix round 1) ──────────────────────────────────────────────
 *
 * Round 1 of this rule detected the CLAIM by its verb — "the fee RETURNS to your
 * plan's rate" — and required the qualifier somewhere in the same block. Both
 * halves were defeated at once by a reviewer who simply ADDED a false sentence
 * and kept the true one:
 *
 *   "After the event closes, later entrants are charged 8% again, and the 5%
 *    you were enjoying no longer applies."
 *
 * The verb list had no "charged … again" and no "no longer applies", so the
 * claim was never detected; and even had it been, the true sentence elsewhere in
 * the block would have excused it. Measured detection rate: 1 in 12 rewordings.
 *
 * A verb list is an open set — there is no end to the ways English says "goes
 * back up" — so this now detects the TOPIC instead, which is closed: a sentence
 * is about the rate after the pass if it names a RATE and names the pass ENDING.
 * You cannot make the false claim without doing both. Whatever such a sentence
 * says, it must carry the lock ITSELF.
 *
 * Two granularity rules follow from the same defeat:
 *  - the claim and its excuse must be the SAME SENTENCE. A true qualifier
 *    elsewhere in the block excused a false claim beside it (measured).
 *  - `feeLockStatedFaults` stays, because a topic rule is vacuous on an article
 *    that never raises the topic.
 */
export const RATE_MENTION = new RegExp(FEE_SUBJECT, "i");
export const PASS_ENDING_MENTION =
  /\b(after|once|when)\b[^.;:!?]*\b(ends?|ended|ending|closes?|closed|finish\w*|over|expir\w*|stops?|stopped|lapses?|archiv\w*|completed?)\b|(?:\b(?:revok\w+|refund\w*|chargeback)\b[^.;:!?]*\bpass\b|\bpass\b[^.;:!?]*\b(?:revok\w+|refund\w*|chargeback)\b)|\b(no\s+longer|later\s+entrants?|downgrad\w+|when\s+the\s+pass|after\s+the\s+pass|after\s+(?:that|then|it)|pass\s+(?:ends?|stops?|expires?|lapses?|does))\b/i;

/** Is this sentence about the entry-fee rate once the pass is no longer in
 *  force? Either by TOPIC (a rate plus an ending) or by the round-1 verb list,
 *  which still catches "the platform fee returns to your plan's rate" in a
 *  clause with no ending word of its own. Union, not replacement: the verb list
 *  was too narrow to be the only detector, not wrong. */
export function mentionsRateAfterPass(sentence: string): boolean {
  if (FEE_REVERSION_PATTERNS.some((p) => p.test(sentence))) return true;
  return RATE_MENTION.test(sentence) && PASS_ENDING_MENTION.test(sentence);
}

/**
 * Every sentence about the entry-fee rate AFTER a pass ends must state the lock.
 *
 * The topic is deliberately high-recall and the requirement precise — the
 * inverse of round 1, which had a precise claim detector and a loose excuse.
 */
export function unqualifiedFeeReversionFaults(label: string, markdown: string): string[] {
  const faults: string[] = [];
  for (const block of claimTexts(markdown)) {
    for (const sentence of sentences(block)) {
      if (!mentionsRateAfterPass(sentence)) continue;
      if (statesFeeLock(sentence)) continue;
      faults.push(
        `${label}: "${sentence.slice(0, 72)}…" talks about the entry-fee rate after the pass ends without stating the first-paid-entry lock (V312)`,
      );
    }
  }
  return faults;
}

/**
 * CRITICAL 2, fix round 1 — a falsehood this task's own round-1 copy shipped.
 *
 * The locked rate is NOT a constant. `registrations.ts` is the only writer of
 * `competitions.fee_percent`, its `where … and fee_percent is null` makes it
 * first-wins, and `lockRate = chargedFeePercent ?? reg.fee_percent` records what
 * the first paid CARD entry was actually billed (offline entries carry no rate
 * and leave the competition unlocked). So a competition that took a paid entry
 * BEFORE its pass was bought is locked at the pre-pass rate, and the pass cannot
 * lower it. Round 1 wrote "a late entrant pays the same 5% as the first one",
 * which is true only of the case it happened to have in mind.
 *
 * FIX ROUND 2 — the rule fired only on a literal `\d+\s*%`, which is one way of
 * naming a rate out of several. Measured misses: "drops to THE PASS RATE for
 * every remaining entry" and "stays at THE EVENT PASS RATE" name it by brand,
 * and "five per cent" spells it out. All three make exactly the claim the digit
 * version makes.
 *
 * So the detector is now "names a PARTICULAR rate" — a figure, a spelled-out
 * figure, or a branded one — and the verdict flips to an allowlist: a sentence
 * that says a particular rate persists must ALSO name the condition that decides
 * it, the first paid card entry. That condition is the whole content of the
 * rule; a sentence without it is asserting the rate is a constant, which it is
 * not.
 */
// NOTE the missing `\b` after `%`: a word boundary needs a word character on
// one side, and `% ` has none — `/\b5\s*%\b/` can never match "5% as". That is
// how the first draft of this rule returned no fault for the very sentence it
// was written against.
export const NAMES_A_PARTICULAR_RATE =
  /\b\d+(?:\.\d+)?\s*%|\b\d+(?:\.\d+)?\s*per\s*cent\b|\b\d+(?:\.\d+)?\s*percent\b|\b(?:one|two|three|four|five|six|seven|eight|nine|ten)\s+per\s*cent\b|\b(?:the\s+)?(?:Event\s+)?pass(?:'s|’s)?\s+(?:own\s+|cheaper\s+|discounted\s+)?(?:rate|fee|percentage)\b|\b(?:cheaper|discounted)\s+rate\b/i;

export function lockedRateConstantFaults(label: string, passProse: string): string[] {
  const faults: string[] = [];
  const lock = new RegExp(FEE_LOCK_WORD, "i");
  const persists =
    /\b(stays?|remains?|keeps?|rides?|goes?\s+on|carries?\s+on|drops?\s+to|falls?\s+to|pays?|charged|applies)\b/i;
  // NOT merely "a first paid entry is mentioned": round 1's falsehood said
  // "Once a competition has taken its first paid entry … a late entrant pays the
  // same 5% as the first one" — it named the trigger and still asserted a
  // constant. What licenses naming a rate is the condition that the first entry
  // was taken WHILE THE PASS WAS LIVE, which is the only case where the pass's
  // own rate is the one locked in.
  const condition =
    /\bfirst\s+(?:paid\s+)?(?:card\s+)?(?:entry|entrant|payment)\b[^.;:!?]*\b(?:while|before|after|during)\b[^.;:!?]*\bpass\b/i;
  for (const block of claimTexts(passProse)) {
    for (const sentence of sentences(block)) {
      if (!NAMES_A_PARTICULAR_RATE.test(sentence)) continue;
      if (!lock.test(sentence) && !persists.test(sentence)) continue;
      if (condition.test(sentence)) continue;
      faults.push(
        `${label}: "${sentence.slice(0, 88)}" says a particular rate carries on without naming what decides it. The locked rate is whatever the FIRST PAID CARD ENTRY was charged — for a competition that already had one, that is the PRE-PASS rate, and the pass cannot lower it.`,
      );
    }
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
  return claimTexts(markdown).some(statesFeeLock)
    ? []
    : [`${label}: never states that the entry-fee rate locks at the first paid entry (V312)`];
}

/**
 * The retired-cap scan, sentence by sentence, with one exemption the seed does
 * not need: prose is allowed to say the cap is GONE.
 *
 * `retiredRunCapFaults` bans the vocabulary outright, which is right for a
 * product description — nothing there ever needs to mention a dead feature. An
 * article does: "there is no per-division run cap any more" is an accurate,
 * useful sentence for a reader who remembers the old limits, and round 1 forced
 * it out of `plans.md`. A guard that bans true sentences gets worked around.
 *
 * The exemption is deliberately narrow: the denial must be in the SAME sentence
 * and the sentence must quote NO NUMBER. "There is no per-division run cap; each
 * division gets 5" is two sentences and reds on the second, and "no cap beyond
 * 20 runs a division" reds on its own digit.
 */
export function retiredRunCapProseFaults(label: string, markdown: string): string[] {
  const faults: string[] = [];
  const denial = /\b(no|not|never|without|isn'?t|aren'?t|dropped|retired|removed|gone|scrapped)\b/i;
  for (const block of claimTexts(markdown)) {
    for (const sentence of sentences(block)) {
      const hits = retiredRunCapFaults(sentence);
      if (hits.length === 0) continue;
      if (denial.test(sentence) && !/\d/.test(sentence)) continue;
      faults.push(...hits.map((h) => `${label}: "${sentence.slice(0, 72)}…" ${h}`));
    }
  }
  return faults;
}

// ── The pass's duration and credit grant, in prose ───────────────────────────

/**
 * ── THE SHAPE FIX, second half (fix round 1) ─────────────────────────────────
 *
 * Round 1 ran `FALSE_PASS_PERMANENCE_PATTERNS` — a list of FALSEHOODS — over the
 * pass copy. A reviewer beat it in one line by writing a falsehood that was not
 * on the list, while leaving the true sentence in place so the positive half
 * stayed satisfied:
 *
 *   "The pass has no end date and applies for the life of the event."
 *
 * "no end date" and "life of" were both absent. Measured detection: 1 in 11.
 * That is inherent: the falsehoods are an OPEN set, so enumerating them is a
 * race the editor always wins.
 *
 * What is CLOSED is the set of grammatical forms English uses to state how long
 * something applies. There are only so many ways: a negated limit, a negated
 * stop, a maximal extent, a bare permanence adverb, a possessive, an open
 * personal extent, a concessive survival. Each form below is UNBOUNDED BY
 * CONSTRUCTION — none of them has a bounded reading in pass copy — so a new
 * falsehood has to be written in one of them to be a duration claim at all.
 *
 * The bounded ways of saying it are the other list: `BOUNDED_SCOPE_GRAMMAR`,
 * where a limiting conjunction governs an activity word. That is the sentence a
 * true pass description writes, and it is required, not merely permitted.
 */
export const DURATION_EXTENT_FORMS: Array<[form: string, pattern: RegExp]> = [
  ["a negated limit", /\bno\s+(end\s*(?:date)?|expiry|expiration|time\s+limit|deadline|cut[-\s]?off|final\s+date|last\s+day)\b/i],
  [
    "a negated stop",
    // NOT `switch off`: "a grace window, so the pass doesn't switch off
    // mid-finals" is true copy about the 7-day grace, and banning it was a
    // measured false positive. The absolute form is kept below.
    /\b(never|does\s+not|doesn'?t|will\s+not|won'?t|cannot|can'?t)\s+(expire|end|lapse|stop|run\s+out|finish|be\s+removed)\w*/i,
  ],
  ["a hyphenated permanence", /\bnever[-\s](expir|laps|end)\w*\b/i],
  ["an absolute non-stop", /\bnever\s+(switch(?:es)?\s+off|goes?\s+away|comes?\s+off)\b/i],
  [
    "a maximal extent",
    /\bfor\s+(?:the\s+|its\s+|your\s+)?(life|lifetime|whole\s+life|entire\s+life|rest\s+of\s+time|all\s+time)\b|\blifetime\b/i,
  ],
  [
    "an unqualified permanence",
    /\b(forever|for\s+ever|for\s+good|permanentl?y?|in\s+perpetuity|indefinitely|open[-\s]ended|everlasting|always\s+applies)\b/i,
  ],
  ["a possessive permanence", /\b(yours\s+to\s+keep|(stays?|remains?)\s+yours)\b/i],
  ["an open personal extent", /\bas\s+long\s+as\s+you\s+(want|like|wish|need|choose)\b/i],
  [
    "a concessive survival",
    /\b(keeps?\s+(working|applying|going)|still\s+applies|stays?\s+in\s+force|carries\s+on)\b[^.;:!?]*\b(even\s+)?(after|once|beyond)\b|\b(even|keeps?\s+working)\s+(after|once)\s+(it|the\s+(competition|event))\b/i,
  ],
];

/**
 * "This sentence says how long the pass applies." High recall on purpose — it
 * only decides whether a sentence must be BOUNDED, and every bounded phrasing
 * satisfies that requirement trivially.
 */
export const DURATION_CLAIM = new RegExp(
  [
    // A duration ADVERBIAL — "for <a stretch of time>". Round 1 used
    // "<verb> … for", which matched "bought outright FOR THAT EVENT" and three
    // other true sentences: any preposition near any verb is not a claim about
    // duration. The object has to BE a time.
    String.raw`\bfor\s+(?:the\s+|its\s+|your\s+|that\s+|this\s+)?(?:life|lifetime|duration|rest|remainder|whole|entire|ever|good|as\s+long\s+as|\d+\s+(?:day|week|month|year)s?)\b`,
    // NOT a bare "while"/"until"/"during". It was here on the theory that a
    // bounded form is a duration claim which then satisfies the rule trivially
    // — but the theory is circular, and it red-flagged a true sentence whose
    // "while" is CONDITIONAL, not temporal: "So while you're on a paid plan,
    // upgrade prompts don't offer the pass at all" says nothing about how long
    // anything lasts. A genuinely bounded sentence passes on its own merits.
    // Explicitly asking or answering "how long".
    String.raw`\b(?:no\s+end|expiry|expiration|how\s+long|life\s+of|lifetime|forever|permanent|in\s+perpetuity|indefinitely)\w*`,
  ].join("|"),
  "i",
);

/**
 * The pass's duration, in prose. Three rules, and the third is the one round 1
 * was missing:
 *
 *  1. NEGATIVE — no unbounded extent form anywhere in the pass's copy.
 *  2. POSITIVE — the opening paragraph must state the bound in its own words,
 *     so deleting the true sentence fails.
 *  3. PER-SENTENCE — every sentence that makes a duration claim at all must be
 *     a bounded one. This is what makes ADDING a false sentence fail: rule 1
 *     needs the falsehood to be on a list, rule 2 is satisfied by the surviving
 *     true sentence, but rule 3 judges the new sentence on its own.
 *
 * SCOPING IS LOAD-BEARING, and measured: `plans.md` truthfully says Community is
 * "free forever" and `credits.md` truthfully says pack credits "never expire".
 * Both are extent-form hits and both are correct — these forms are falsehoods
 * only about the PASS. Pass it pass copy, nothing else.
 */
export function passBoundProseFaults(label: string, passProse: string): string[] {
  const faults: string[] = [];
  // Scanned over prose AND frontmatter; the opening-paragraph rule below still
  // reads the first PROSE block, because a `description:` is not the article's
  // scope statement even though it is the first thing rendered.
  const blocks = claimTexts(passProse);

  for (const block of blocks) {
    for (const sentence of sentences(block)) {
      const bounded = BOUNDED_SCOPE_GRAMMAR.test(sentence);
      for (const [form, pattern] of DURATION_EXTENT_FORMS) {
        if (!pattern.test(sentence)) continue;
        faults.push(
          `${label}: "${sentence.slice(0, 72)}…" states the pass's duration as ${form} — an unbounded extent`,
        );
      }
      // FIX ROUND 2: the `namesStop` exemption that used to sit here is GONE.
      // It was a false-green widener with ZERO coverage — rule 3 flagged no
      // sentence of either real article, so nothing exercised it, yet it was
      // reachable and exempted "It applies for the whole duration, and stops
      // once that competition is over." Naming a stop condition is now an
      // APPROVED FORM in `DURATION_ALLOWLIST`, where it is exercised, rather
      // than an escape hatch here.
      if (DURATION_CLAIM.test(sentence) && !bounded) {
        faults.push(
          `${label}: "${sentence.slice(0, 72)}…" says how long the pass applies without bounding it to a running competition`,
        );
      }
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
  for (const block of claimTexts(passProse)) {
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

// ── FOUR-LOCALE DICTIONARY COPY ──────────────────────────────────────────────
//
// Everything above this line is an ENGLISH regex pointed at an ENGLISH-ONLY
// surface: `stripe-plans.json` (one seed, English descriptions) and
// `content/help/**` (a single English tree — HELP_ROOT has no locale segment).
// That was correct for tasks 1-3 and it is a TRAP for task 4.
//
// `src/dictionaries/*/marketing.json` and `*/ui.json` are FOUR files each. Point
// `FALSE_PASS_PERMANENCE_PATTERNS` at them and it reds on `en` and passes
// silently on es/fr/nl — measured, before this task's fix, on the exact strings
// it was written for:
//
//   en pricing.pass.note     "Yours for the event's lifetime."        → 1 hit
//   es pricing.pass.note     "Tuyo durante toda la vida del evento."  → 0 hits
//   fr pricing.pass.note     "À vous pour toute la durée de …"        → 0 hits
//   nl pricing.pass.note     "…voor de hele levensduur van het …"     → 0 hits
//
// All four say the same false thing. A guard that reds only on `en` is not a
// guard on this surface — it is a guard that certifies a falsehood in three
// languages. So the claim vocabularies below are keyed BY LOCALE, and
// `localesAreCovered` makes a locale with no vocabulary a FAULT rather than a
// silent pass. Adding a fifth dictionary directory reds this suite on day one.
//
// Three layers, deliberately, because each covers what the others cannot:
//
//  1. VOCABULARY, per locale — the general rule. Catches a reworded falsehood
//     in the language it is written in. Holes are possible (nobody can enumerate
//     a language), which is why it is not the only layer.
//  2. THE SAME VOCABULARIES, CROSS-APPLIED to every locale. Free, and it closes
//     the failure mode wave 6 actually shipped: a Spanish/French/Dutch surface
//     rendering new ENGLISH prose. An English falsehood pasted into `nl` is
//     caught by the English list; a French one in `es` by the French list.
//  3. RETIRED LITERALS — the exact prose this task removed, from all four
//     files, checked against all four values. This layer CANNOT have a hole,
//     and it pins fragments the vocabularies deliberately omit: French "pour
//     toute la durée" is a permanence claim about the pass but a TRUE bound in
//     other sentences, so it is a retired literal rather than a vocabulary
//     entry (a guard that rejects true prose teaches its next editor to route
//     around it).
//
// And every absence rule here is paired with a POSITIVE: `bounded` must match,
// in that locale's own grammar. Absence proves "not false", never "still
// stated" — deleting the sentence would otherwise be the cheapest way to green.

export const DICTIONARY_LOCALES = ["en", "es", "fr", "nl"] as const;
export type DictionaryLocale = (typeof DICTIONARY_LOCALES)[number];

/**
 * `\b` AND `\w` ARE ASCII-ONLY IN JAVASCRIPT, AND THAT SILENTLY VOIDS A GUARD
 * WRITTEN IN A LANGUAGE WITH ACCENTS.
 *
 * There is no word boundary between a space and "à" — both are non-word
 * characters to `\b` — so `/\bà\s+vie\b/i` does not match "Valable à vie". Nor
 * does `/\bmoitié\b/i` match "la moitié du tarif": the trailing `\b` sits
 * between "é" and a space, two non-word characters again. `\w` fails the same
 * way, so `/asignaci\w*\s+autom/i` cannot reach "asignación automática".
 *
 * MEASURED, on the first run of this task's suite: the French permanence list
 * returned ZERO faults for a value that plainly said "à vie", and the French
 * "au plus la moitié" qualifier read as absent when it was right there. A guard
 * that cannot match its own language is worse than no guard — it reports clean.
 *
 * So every non-English pattern is built through here: `\b` becomes the Unicode
 * definition of a word boundary and `\w` a Unicode word character, under the
 * `u` flag. English patterns keep plain literals; they are ASCII by definition
 * and are shared with the seed and help guards.
 */
const UNICODE_WORD = String.raw`[\p{L}\p{N}_]`;
const UNICODE_BOUNDARY = `(?:(?<=${UNICODE_WORD})(?!${UNICODE_WORD})|(?<!${UNICODE_WORD})(?=${UNICODE_WORD}))`;

/**
 * The expansion is ~90 characters per `\b`, which turns a fault label into an
 * unreadable blob — and an unreadable fault is one nobody acts on. The written
 * source is kept here and `describeClaim` hands it back for labels.
 */
const CLAIM_SOURCE = new WeakMap<RegExp, string>();

export function claim(source: string): RegExp {
  const compiled = new RegExp(
    source.replaceAll(String.raw`\w`, UNICODE_WORD).replaceAll(String.raw`\b`, UNICODE_BOUNDARY),
    "iu",
  );
  CLAIM_SOURCE.set(compiled, source);
  return compiled;
}

/** What a pattern says, as it was written. */
export function describeClaim(pattern: RegExp): string {
  return CLAIM_SOURCE.get(pattern) ?? pattern.source;
}

/** One language's way of making each claim these dictionaries make. */
export interface LocaleClaims {
  /** Unbounded duration. Deliberately EXCLUDES the "unlimited" family
   *  (`ilimitado`/`illimité`/`onbeperkt`), which is a TRUE claim about the L
   *  rung's entrant cap in three of these very strings. */
  permanence: RegExp[];
  /** A limiting conjunction GOVERNING an activity word — the positive half.
   *  Same shape and 60-character window as `BOUNDED_SCOPE_GRAMMAR`, for the
   *  same measured reason: at 30 it rejected true copy. */
  bounded: RegExp;
  /** Recurring cadence — the inverse of the pass's one-time credit grant. */
  recurring: RegExp[];
  /** A claim that the plan grants X, keyed by `plan_entitlements.feature_key`.
   *  Both word orders, because Romance languages put the noun first
   *  ("programación asistida por IA") and Germanic ones the modifier
   *  ("AI-ondersteunde planning"). */
  plusClaims: Array<[feature: string, claim: RegExp]>;
  /** "the largest monthly AI credit grant" — the TRUE differentiator that
   *  replaced the false AI-scheduling one. Its own regex because it is a
   *  COMPARATIVE, not a boolean grant. */
  creditLeadership: RegExp;
  /** Any claim about half the base rate, qualified or not. */
  halfClaim: RegExp;
  /** …and the "no more than" qualifier that makes it true. */
  atMostHalf: RegExp;
  /** The entry-fee/rate subject. A permanence claim about THIS is the V312 fee
   *  lock, which is true — see `isRateClause`. */
  rateSubject: RegExp;
  /** The pass/upgrade subject. Its presence in a clause overrides the rate
   *  exemption, so the exemption cannot become a hiding place. */
  passSubject: RegExp;
}

export const LOCALE_CLAIMS: Record<DictionaryLocale, LocaleClaims> = {
  en: {
    // The English half is the SAME list the seed and help guards use. Sharing
    // it is the point: a pattern added for task 1 or 3 must not have to be
    // remembered again here.
    permanence: FALSE_PASS_PERMANENCE_PATTERNS,
    bounded: BOUNDED_SCOPE_GRAMMAR,
    recurring: RECURRING_GRANT_PATTERNS,
    plusClaims: PLUS_DIFFERENTIATOR_VOCAB,
    creditLeadership: /\b(largest|biggest|highest)\b[^,.;]{0,30}\bcredit/i,
    halfClaim: /\bhalf\s+the\s+base\s+rate\b|\bhalf\s+(your|the)\s+plan['’]s\s+rate\b/i,
    atMostHalf: /\b(no\s+more\s+than|at\s+most|up\s+to)\s+half\b/i,
    rateSubject: /\b(platform\s+fees?|entry[-\s]fees?|fees?|rates?|percentage|commission)\b|\d+(\.\d+)?\s*%/i,
    passSubject: /\b(pass|passes|upgrade[ds]?|competition|event)\b/i,
  },
  es: {
    // Fix round 1: this list was SINGULAR-VERB-ONLY and therefore inert. Every
    // verb below was spelled out in one inflection ("nunca caduca"), so the
    // plural the shipped copy actually used — "los pases nunca caducan" — went
    // undetected, in the key this round had to fix. The verbs are now STEMS
    // with `\w*`, which covers number, person and tense at once, and each form
    // of the claim is listed rather than each sentence that makes it.
    permanence: [
      // A — lifetime adverbials.
      String.raw`\bde\s+por\s+vida\b`,
      String.raw`\bpara\s+siempre\b`,
      String.raw`\btoda\s+(la|su)\s+vida\b`,
      String.raw`\bde\s+(manera|forma)\s+(permanente|indefinida)\b`,
      String.raw`\bindefinidamente\b`,
      String.raw`\bpor\s+tiempo\s+(ilimitado|indefinido)\b`,
      String.raw`\bsiempre\s+(tuy[oa]s?|activ[oa]s?|válid[oa]s?)\b`,
      // B — negated termination, BOTH ORDERS, verb inflected. `nunca`/`jamás`
      // take the full stem list; a bare `no` takes only the unambiguous expiry
      // verbs, because "la competición no termina hasta el domingo" is ordinary
      // true prose and must not red.
      String.raw`\b(nunca|jamás)\s+(?:se\s+)?(caduc|expir|venc|termin|acab|finaliz|prescrib)\w*`,
      String.raw`\bno\s+(?:se\s+)?(caduc|expir|venc|prescrib)\w*`,
      String.raw`\b(caduc|expir|venc|termin|acab|finaliz|prescrib)\w*\s+(nunca|jamás)\b`,
      // C — absence of a limit.
      String.raw`\bsin\s+(fecha\s+de\s+)?(caducidad|vencimiento|expiración)\b`,
      String.raw`\bsin\s+límite\s+de\s+tiempo\b`,
      // D — permanence adjectives/adverbs, inflected.
      String.raw`\bpermanente(s|mente)?\b`,
      // E — retention.
      String.raw`\bes\s+tuy[oa]s?\s+(para\s+siempre|y\s+lo\s+conservas)\b`,
      String.raw`\b(sigue|siguen|seguirá|seguirán)\s+siendo\s+tuy[oa]s?\b`,
      // F — absence of an end, endurance verbs, and guarded "siempre".
      String.raw`\bno\s+(tiene|tienen)\s+fin\b`,
      String.raw`\bno\s+hay\s+(fecha\s+límite|fin|caducidad|vencimiento)\b`,
      String.raw`\bsin\s+(fin|fecha\s+límite|plazo)\b`,
      String.raw`\b(perdur|permanec|subsist)\w*`,
      String.raw`\bsigue\w*\s+vigente\b`,
      String.raw`\bpara\s+el\s+resto\s+del\s+tiempo\b`,
      String.raw`\bsiempre\b[^.;,]{0,24}\b(tuy|activ|válid|acompañ|conserv|dispon)\w*|\b(tuy|activ|válid|acompañ|conserv)\w*[^.;,]{0,24}\bsiempre\b`,
    ].map(claim),
    bounded: claim(
      boundedScopeGrammarSource(
        ["mientras", String.raw`hasta\s+que`, String.raw`durante\s+el\s+tiempo\s+que`],
        ["activ[ao]s?", String.raw`en\s+curso`, String.raw`en\s+marcha`, "abiert[ao]s?", "dure", "dura", String.raw`se\s+juegue`],
        "es",
      ),
    ),
    recurring: [
      String.raw`\bmensual(es|mente)?\b`,
      String.raw`\bal\s+mes\b`,
      String.raw`\bcada\s+mes\b`,
      String.raw`\bpor\s+mes\b`,
      String.raw`\brecurrente\b`,
    ].map(claim),
    plusClaims: [
      [
        "scheduling.ai",
        claim(
          String.raw`\b(programaci|planificaci)\w*[^,.;]{0,30}\b(IA|AI)\b|\b(IA|AI)\b[^,.;]{0,30}\b(programaci|planificaci)`,
        ),
      ],
      [
        "officials.auto",
        claim(
          String.raw`\basignaci\w*\s+autom\w*[^,.;]{0,25}\b(árbitros?|oficiales?)\b|\b(árbitros?|oficiales?)\b[^,.;]{0,25}\bautom`,
        ),
      ],
      ["api.write", claim(String.raw`\bescritura\b[^,.;]{0,25}\bAPI\b|\bAPI\b[^,.;]{0,25}\bescritura\b`)],
      ["support.priority", claim(String.raw`\bsoporte\s+priorit\w+\b`)],
    ],
    creditLeadership: claim(String.raw`\b(mayor|más\s+grande)\b[^,.;]{0,30}\bcréditos?\b`),
    halfClaim: claim(String.raw`\bmitad\s+de\s+(la\s+tarifa\s+base|la\s+tarifa\s+de\s+tu\s+plan|precio|tarifa)\b`),
    atMostHalf: claim(String.raw`\b(no\s+más\s+de|como\s+máximo|a\s+lo\s+sumo|máximo)\s+(la\s+)?mitad\b`),
    rateSubject: claim(String.raw`\b(comisi\w*|tarifa|tasa|porcentaje)\b|\d+(\.\d+)?\s*%`),
    passSubject: claim(String.raw`\b(pase|pases|mejora\w*|competici\w*|evento)\b`),
  },
  fr: {
    // Fix round 1: same defect as es. `n['’]expire\s+(jamais|pas)` pinned the
    // THIRD-PERSON SINGULAR, so the shipped plural "les pass n'expirent jamais"
    // was invisible. Stems and `\w*` now carry the inflection, and the
    // verb-then-`jamais` order is matched without requiring the negator, since
    // that is where the plural actually broke.
    permanence: [
      // A — lifetime adverbials.
      String.raw`\bà\s+vie\b`,
      String.raw`\bpour\s+toujours\b`,
      String.raw`\bà\s+jamais\b`,
      String.raw`\bdéfinitivement\b`,
      String.raw`\bindéfiniment\b`,
      String.raw`\bde\s+(manière|façon)\s+(permanente|définitive)\b`,
      String.raw`\bà\s+durée\s+(illimitée|indéterminée)\b`,
      String.raw`\bpour\s+de\s+bon\b`,
      // B — negated termination: circumfix `ne … jamais`, elided `n'…`, and the
      // bare verb-then-`jamais` order.
      String.raw`\bn['’](expir|arrêt|achèv|termin|fini)\w*\s+(jamais|pas)\b`,
      String.raw`\bne\s+(?:s['’]|se\s+)?(expir|arrêt|achèv|termin|fini)\w*\s+(jamais|pas)\b`,
      String.raw`\b(expir|arrêt|achèv|termin)\w*\s+jamais\b`,
      // C — absence of a limit.
      String.raw`\bsans\s+(date\s+d['’])?(expiration|échéance)\b`,
      String.raw`\bsans\s+limite\s+de\s+(temps|durée)\b`,
      // D — permanence adjectives/adverbs, inflected.
      String.raw`\bpermanent\w*\b`,
      // E — retention.
      String.raw`\brest\w*\s+(valable|acquis|actif|active)s?\s+(à\s+vie|indéfiniment|pour\s+toujours)\b`,
      // F — absence of an end, endurance verbs, and guarded "toujours".
      String.raw`\bjamais\s+fin\b`,
      String.raw`\baucun(e)?\s+(date\s+limite|échéance|fin|terme)\b`,
      String.raw`\baucune\s+limite\s+de\s+(temps|durée)\b`,
      String.raw`\bsans\s+(fin|terme)\b`,
      String.raw`\bpas\s+de\s+(terme|fin|limite|date\s+limite)\b`,
      String.raw`\b(demeur|subsist|perdur)\w*`,
      String.raw`\bpour\s+la\s+vie\b`,
      String.raw`\btoujours\b[^.;,]{0,24}\b(vôtre|gard|valable|actif|active|conserv)\w*|\b(gard|valable|actif|active|conserv)\w*[^.;,]{0,24}\btoujours\b`,
    ].map(claim),
    bounded: claim(
      boundedScopeGrammarSource(
        [
          String.raw`tant\s+qu\w*`,
          String.raw`pendant\s+qu\w*`,
          String.raw`jusqu['’]à\s+ce\s+qu\w*`,
          String.raw`aussi\s+longtemps\s+qu\w*`,
        ],
        [String.raw`activ\w*`, String.raw`en\s+cours`, String.raw`ouvert\w*`, String.raw`se\s+déroule`, "dure"],
        "fr",
      ),
    ),
    recurring: [
      String.raw`\bmensuel(le|s|les)?\b`,
      String.raw`\bpar\s+mois\b`,
      String.raw`\bchaque\s+mois\b`,
      String.raw`\brécurrent(e|s)?\b`,
    ].map(claim),
    plusClaims: [
      [
        "scheduling.ai",
        claim(
          String.raw`\b(planification|ordonnancement)\b[^,.;]{0,30}\b(IA|AI)\b|\b(IA|AI)\b[^,.;]{0,30}\b(planification|ordonnancement)\b`,
        ),
      ],
      [
        "officials.auto",
        claim(
          String.raw`\battribution\s+automatique\b[^,.;]{0,30}\bofficiels?\b|\bofficiels?\b[^,.;]{0,30}\bautomatique\b`,
        ),
      ],
      ["api.write", claim(String.raw`\bAPI\b[^,.;]{0,25}\bécriture\b|\bécriture\b[^,.;]{0,25}\bAPI\b`)],
      ["support.priority", claim(String.raw`\b(assistance|support)\s+prioritaire\b`)],
    ],
    creditLeadership: claim(String.raw`\bplus\s+(grosse|grande|élevée|important\w*)\b[^,.;]{0,30}\bcrédits?\b|\bcrédits?\b[^,.;]{0,30}\bla\s+plus\s+(élevée|grande|grosse|important\w*)\b`),
    halfClaim: claim(String.raw`\bmoitié\s+du\s+(tarif\s+de\s+base|tarif\s+de\s+votre\s+forfait|prix)\b|\bmoitié\s+prix\b`),
    atMostHalf: claim(String.raw`\b(au\s+plus|pas\s+plus\s+de|au\s+maximum|maximum)\s+(la\s+)?moitié\b`),
    rateSubject: claim(String.raw`\b(frais|commission|taux|pourcentage)\b|\d+(\.\d+)?\s*%`),
    passSubject: claim(String.raw`\b(pass|am\u00e9lioration\w*|comp\u00e9tition\w*|\u00e9v\u00e9nement\w*)\b`),
  },
  nl: {
    // Fix round 1: same defect again — the verbs were enumerated as finite
    // singular forms (`verloopt|vervalt|eindigt`), so the shipped plural
    // "passes verlopen nooit" matched nothing. Note Dutch needs BOTH `verloop`
    // and `verlop` as stems: "verloopt" has two o's and "verlopen" has one, so
    // neither is a prefix of the other and a single stem silently covers half
    // the paradigm.
    permanence: [
      String.raw`\blevensduur\b(?!\s+van\s+(de|het)\s+competitie)`,  // M2: a lifetime OF THE COMPETITION is a bound, not a permanence claim
      // "voor het hele verloop" — the nl wording of `billing.passOffer.note`,
      // which reached for a different metaphor than the other three keys. Proof
      // that a vocabulary written from ONE string per language is not a
      // vocabulary; the positive `bounded` rule is what actually caught it.
      String.raw`\b(hele|volledige)\s+(verloop|duur)\b`,
      // A — lifetime adverbials.
      String.raw`\bvoor\s+altijd\b`,
      String.raw`\bvoorgoed\b`,
      String.raw`\beeuwig\w*\b`,
      String.raw`\bvoor\s+onbepaalde\s+tijd\b`,
      String.raw`\bonbeperkt\s+(geldig|houdbaar)\b`,
      String.raw`\b(altijd|permanent)\s+(geldig|actief)\b`,
      // B — negated termination, both orders, verb inflected.
      String.raw`\bnooit\s+(?:meer\s+)?(verloop|verlop|verval|eindig|stop|afloop|aflop)\w*`,
      String.raw`\b(verloop|verlop|verval|eindig|stop|afloop|aflop)\w*\s+(nooit|niet)\b`,
      // C — absence of a limit.
      String.raw`\bgeen\s+(vervaldatum|einddatum|tijdslimiet|houdbaarheidsdatum|verloopdatum|vervaltermijn)\b`,
      // D — permanence adjectives, inflected.
      String.raw`\bpermanent\w*\b`,
      // E — retention.
      String.raw`\baltijd\s+van\s+jou\b`,
      String.raw`\b(blijft|blijven)\s+(altijd\s+)?(geldig|actief|van\s+jou)\b`,
      // F — absence of an end, endurance verbs, and guarded "altijd".
      String.raw`\bgeen\s+(einde|afkapdatum|termijn)\b`,
      String.raw`\bzonder\s+(einde|termijn)\b`,
      String.raw`\bkent\s+geen\s+einde\b`,
      String.raw`\b(blijft|blijven)\s+(bestaan|staan|gelden)\b`,
      String.raw`\bhoudt?\s+niet\s+op\b`,
      String.raw`\b(duurt|geldt|loopt)\s+onbeperkt\b`,
      String.raw`\bhele\s+leven\b`,
      String.raw`\baltijd\b[^.;,]{0,24}\b(van\s+jou|houdt?|geldig|actief|bewaar)\w*|\b(houdt?|geldig|actief)\w*[^.;,]{0,24}\baltijd\b`,
    ].map(claim),
    bounded: claim(
      boundedScopeGrammarSource(
        ["zolang", "terwijl", "totdat", String.raw`tot\s+de`],
        ["loopt", "actief", "open", "bezig", "duurt", "draait"],
        "nl",
      ),
    ),
    recurring: [
      String.raw`\bmaandelijks(e)?\b`,
      String.raw`\bper\s+maand\b`,
      String.raw`\b(elke|iedere)\s+maand\b`,
      String.raw`\bterugkerend(e)?\b`,
    ].map(claim),
    plusClaims: [
      [
        "scheduling.ai",
        claim(
          String.raw`\bAI\b[^,.;]{0,30}\b(planning|inplannen|plannen|scheduling)\b|\b(planning|inplannen|plannen)\b[^,.;]{0,30}\bAI\b`,
        ),
      ],
      [
        "officials.auto",
        claim(
          String.raw`\bautomatische\s+toewijzing\b[^,.;]{0,30}\bofficials?\b|\bofficials?\b[^,.;]{0,30}\bautomatische\b`,
        ),
      ],
      ["api.write", claim(String.raw`\bschrijftoegang\b[^,.;]{0,25}\bAPI\b|\bAPI\b[^,.;]{0,25}\bschrijftoegang\b`)],
      ["support.priority", claim(String.raw`\bprioritaire\s+onderst\w+\b`)],
    ],
    creditLeadership: claim(String.raw`\b(grootste|hoogste)\b[^,.;]{0,30}\bcredit`),
    halfClaim: claim(String.raw`\bhelft\s+van\s+het\s+(basistarief|tarief\s+van\s+je\s+abonnement)\b|\bhalve\s+(prijs|tarief)\b`),
    atMostHalf: claim(String.raw`\b(hoogstens|maximaal|ten\s+hoogste|niet\s+meer\s+dan)\s+(de\s+)?helft\b`),
    rateSubject: claim(String.raw`\b(kosten|tarief|percentage|commissie)\b|\d+(\.\d+)?\s*%`),
    passSubject: claim(String.raw`\b(pass|passes|upgrade\w*|competitie\w*|evenement\w*)\b`),
  },
};

/**
 * The structural rule that makes everything above non-optional: the vocabulary
 * map must cover exactly the locales that EXIST. A dictionary directory with no
 * entry here is unguarded copy, and it must red rather than pass — that is the
 * whole difference between "we guard the pricing copy" and "we guard the
 * English pricing copy and hope".
 *
 * Checked in BOTH directions. A stale entry for a deleted locale is a fault too:
 * it makes the map look like it covers more than it does, and a cross-applied
 * vocabulary for a language nobody ships is dead weight that hides a real gap.
 */
export function localeCoverageFaults(localesOnDisk: string[]): string[] {
  const faults: string[] = [];
  const covered = new Set<string>(Object.keys(LOCALE_CLAIMS));
  for (const locale of localesOnDisk) {
    if (!covered.has(locale)) {
      faults.push(
        `${locale}/: a dictionary locale with no entry in LOCALE_CLAIMS — its copy is scanned by nothing`,
      );
    }
  }
  for (const locale of covered) {
    if (!localesOnDisk.includes(locale)) {
      faults.push(`${locale}: LOCALE_CLAIMS covers a locale that no longer exists on disk`);
    }
  }
  return faults;
}

/** One dictionary value under scan. */
export interface LocalisedValue {
  locale: DictionaryLocale;
  key: string;
  value: string;
}

/**
 * Layers 1 + 2: every locale's permanence vocabulary against every locale's
 * value, plus that locale's OWN positive bound.
 *
 * Cross-application is what stops "we translated it" from meaning "we guarded
 * it". The previous wave shipped a Spanish/French/Dutch surface carrying new
 * English prose; under this rule the English list reds on the Dutch value, and
 * the fault label names which language's vocabulary fired so the reader knows
 * whether they are looking at a falsehood or a mistranslation.
 *
 * The POSITIVE half is deliberately the locale's OWN grammar and nothing else:
 * a Dutch value satisfying the English "while … running" would mean the Dutch
 * page renders English, which is the bug, not the fix.
 */
/**
 * A dictionary value split at the boundaries a claim's SUBJECT can change:
 * sentence punctuation, commas, and the dashes/colons this copy uses to join
 * two statements. One clause, one subject — which is what makes it possible to
 * ask "what is this permanence claim ABOUT".
 */
export function valueClauses(value: string): string[] {
  return value
    .split(/[.:;!?]+|\s+[—–-]\s+|,/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

/**
 * "THE PASS NEVER ENDS" IS FALSE. "THE LOCKED RATE NEVER CHANGES" IS TRUE.
 * The permanence vocabulary cannot tell them apart on its own — `for good`,
 * `permanentemente`, `définitivement` and `permanent` are all in it, and the
 * V312 fee lock is a genuine forever-claim about a different subject. Task 3
 * has just rewritten the fee-lock prose, so this would have started firing on
 * true copy the moment that wording reached a guarded dictionary value.
 *
 * The discriminator is the SUBJECT OF THE CLAUSE, not the words in it: a
 * permanence hit is a pass falsehood unless its clause is about the rate AND
 * says nothing about the pass. Requiring both halves is what stops the
 * exemption becoming a hole — "a 5% platform fee, and the pass lasts forever"
 * mentions the fee, but it also mentions the pass, so it still reds.
 */
/**
 * A NEW SUBJECT, for the purpose of asking what a permanence claim is about.
 *
 * This is `CLAUSE_BREAK` plus pronouns. The bounded-scope rule can ignore
 * pronouns because it looks for a conjunction governing an activity word; this
 * rule cannot, because "the 5% rate AND IT lasts forever" is precisely the
 * shape where the rate stops being the subject.
 */
/**
 * THE COORDINATOR ALONE IS THE BREAK — deliberately coarser than
 * `CLAUSE_BREAK`, which requires a following determiner.
 *
 * A first cut required coordinator + determiner/pronoun and scored 8/9: it
 * missed Spanish "…al 5% de comisión y dura para siempre", because Spanish is
 * PRO-DROP. "y dura" starts a new predicate with no pronoun to detect, and no
 * regex is going to reliably tell a verb from a noun across four languages.
 *
 * So attribution stops at any coordinator. The cost is a true sentence like
 * "the fee is locked and stays locked for good", which now reds. That trade is
 * deliberate and it is the right way round HERE, because this rule is the
 * SECONDARY net: `approvedDictionaryFaults` pins the copy that actually ships,
 * so a false positive costs one reword on unpinned copy, while a false negative
 * is how this wave shipped the same falsehood four times.
 *
 * Note the difference from `CLAUSE_BREAK`, which must stay precise: it decides
 * whether a bound was STATED, where rejecting true prose would be the expensive
 * error.
 */
const SUBJECT_BREAK: Record<DictionaryLocale, string> = {
  en: String.raw`\b(?:and|or|but|so|then|yet|while|whereas)\b`,
  es: String.raw`\b(?:y|e|o|u|pero|aunque|mientras)\b`,
  fr: String.raw`\b(?:et|ou|mais|donc|alors|tandis)\b`,
  nl: String.raw`\b(?:en|of|maar|dus|terwijl)\b`,
};

/**
 * IS THIS PERMANENCE CLAIM ABOUT THE RATE, OR ABOUT THE PASS?
 *
 * Fix round 1 answered this by DROPPING any clause where a rate was mentioned
 * and the pass was not — and that opened a percentage-shaped hole in the rule
 * it was repairing. Measured 0/9: "It is a one-off at the 5% rate and it lasts
 * forever" went green, because the clause names a rate and the pass only ever
 * appears as the pronoun "it". Pass copy quotes percentages constantly, so the
 * exemption sat exactly on the surface it was guarding.
 *
 * The repair is to narrow the MATCH, not to remove text from the scan. A
 * permanence hit is exempt only when the rate is the noun that hit actually
 * governs, which requires all three:
 *   1. a rate word appears BEFORE the permanence match (the nearest one wins);
 *   2. no NEW SUBJECT intervenes — "and it", "et cela", "en de" start a new
 *      clause, so the rate is no longer the subject;
 *   3. the pass is not named in between, which would make the claim about it.
 *
 * Everything else is scanned. The rule fails closed: an unattributable claim
 * ("It lasts forever") is treated as a claim about the pass.
 */
function permanenceHitIsAboutRate(
  locale: DictionaryLocale,
  clause: string,
  matchIndex: number,
): boolean {
  const { rateSubject, passSubject } = LOCALE_CLAIMS[locale];
  const before = clause.slice(0, matchIndex);

  // The NEAREST preceding rate word — a rate mentioned earlier, with a new
  // subject after it, is not the subject of this claim.
  const rate = new RegExp(rateSubject.source, rateSubject.flags.includes("g") ? rateSubject.flags : `${rateSubject.flags}g`);
  let lastRateEnd = -1;
  for (const m of before.matchAll(rate)) lastRateEnd = m.index! + m[0].length;
  if (lastRateEnd === -1) return false;

  const between = clause.slice(lastRateEnd, matchIndex);
  if (new RegExp(SUBJECT_BREAK[locale], "iu").test(between)) return false;
  if (passSubject.test(between)) return false;
  return true;
}

export function localePassBoundFaults(values: LocalisedValue[]): string[] {
  const faults: string[] = [];
  for (const { locale, key, value } of values) {
    if (value.trim().length === 0) {
      faults.push(`${locale} ${key}: empty — nothing to scan, so every rule below passes vacuously`);
      continue;
    }
    // EVERY clause is scanned. What varies is whether an individual hit is
    // attributed to the rate (true, the V312 lock) or to the pass (false) —
    // see `permanenceHitIsAboutRate`. Fix round 1 dropped whole clauses here
    // and that was a regression: a clause quoting a percentage stopped being
    // scanned at all.
    const clauses = valueClauses(value);
    for (const [vocabLocale, claims] of Object.entries(LOCALE_CLAIMS)) {
      for (const pattern of claims.permanence) {
        const hit = clauses.some((clause) => {
          const found = pattern.exec(clause);
          return found !== null && !permanenceHitIsAboutRate(locale, clause, found.index);
        });
        if (hit) {
          faults.push(
            `${locale} ${key}: claims the pass has unbounded duration in ${vocabLocale} vocabulary (${describeClaim(pattern)})`,
          );
        }
      }
    }
    if (!LOCALE_CLAIMS[locale].bounded.test(value)) {
      faults.push(
        `${locale} ${key}: never states, in ${locale}, that the pass is bounded to a running competition`,
      );
    }
  }
  return faults;
}

/**
 * Layer 3. `retired` is the prose this task deleted, per locale; every value is
 * checked against ALL of it, not just its own language's share.
 *
 * Why a literal list is worth keeping next to a vocabulary: the vocabularies
 * cannot include French "pour toute la durée" (true of a bound, false of the
 * pass) or Dutch "voor de helft van het basistarief" (true once "hoogstens" is
 * in front of it). Those are precisely the fragments a translator restores by
 * accident, and a literal has no hole.
 */
export function retiredClaimFaults(values: LocalisedValue[], retired: string[]): string[] {
  const faults: string[] = [];
  if (retired.length === 0) {
    return ["retired-claim registry is empty — this layer would examine nothing"];
  }
  for (const { locale, key, value } of values) {
    const haystack = value.toLowerCase();
    for (const phrase of retired) {
      if (haystack.includes(phrase.toLowerCase())) {
        faults.push(`${locale} ${key}: still carries the retired claim "${phrase}"`);
      }
    }
  }
  return faults;
}

/** The one-time credit grant, in a language-independent way: the FIGURE. Digits
 *  are the same in all four locales, which is what makes this checkable without
 *  a fourth vocabulary — and it is paired with the recurring-cadence negative so
 *  "+25 AI credits every month" cannot satisfy it. */
export function localeCreditGrantFaults(values: LocalisedValue[], grant: number): string[] {
  const faults: string[] = [];
  for (const { locale, key, value } of values) {
    if (!value.includes(`+${grant}`)) {
      faults.push(`${locale} ${key}: does not state the one-time +${grant} AI credit grant`);
    }
    for (const match of value.matchAll(/\+(\d[\d,]*)\b/g)) {
      const figure = Number(match[1]!.replace(/,/g, ""));
      if (figure !== grant) {
        faults.push(`${locale} ${key}: quotes +${figure}, but the pass grants +${grant}`);
      }
    }
    for (const pattern of LOCALE_CLAIMS[locale].recurring) {
      if (pattern.test(value)) {
        faults.push(`${locale} ${key}: sells the one-time grant as recurring (${describeClaim(pattern)})`);
      }
    }
  }
  return faults;
}

/** `plan_entitlements` boolean rows, as `{ feature: { plan: granted } }`. */
export type FeatureGrants = Record<string, Record<string, boolean>>;

/**
 * A Pro Plus differentiator claim is judged against the MATRIX, per locale.
 *
 * NOTE THE NEGATIVE CASE, which is the whole reason this reads the grants
 * instead of banning a phrase: "AI-assisted scheduling" is false TODAY because
 * `scheduling.ai` is `true` on all five plan keys (community, event_pass,
 * event_pass_l, pro, pro_plus — measured). If a future migration made it
 * pro_plus-only, the claim would become TRUE and this guard must fall silent.
 * A rule that fired unconditionally would satisfy every stated requirement of
 * this task and be wrong the moment the matrix moved.
 *
 * `lowerPlans` are the plans the "Everything in Pro, plus …" frame asserts do
 * NOT have the feature. Anti-vacuity closes the other side: an answer that
 * names no recognised differentiator has had this guard examine nothing.
 */
export function localePlusDifferentiatorFaults(
  values: LocalisedValue[],
  grants: FeatureGrants,
  lowerPlans: string[],
): string[] {
  const faults: string[] = [];
  for (const { locale, key, value } of values) {
    let recognised = 0;
    for (const [feature, claim] of LOCALE_CLAIMS[locale].plusClaims) {
      if (!claim.test(value)) continue;
      recognised += 1;
      const row = grants[feature];
      if (!row) {
        faults.push(`${locale} ${key}: claims ${feature}, which has no rows in plan_entitlements`);
        continue;
      }
      for (const plan of lowerPlans) {
        if (row[plan]) {
          faults.push(
            `${locale} ${key}: sells ${feature} as a Pro Plus differentiator, but ${plan} already grants it`,
          );
        }
      }
      if (!row.pro_plus) {
        faults.push(`${locale} ${key}: claims ${feature}, but pro_plus does not grant it`);
      }
    }
    if (recognised === 0) {
      faults.push(
        `${locale} ${key}: names no recognised differentiator — the ${locale} vocabulary has gone stale and this guard examined nothing`,
      );
    }
  }
  return faults;
}

/**
 * The comparative that REPLACED the false AI-scheduling claim. A boolean-grant
 * guard cannot judge it: "the largest monthly AI credit grant" is true only
 * while `ai.credits.monthly` for pro_plus is strictly greater than every other
 * plan's, so it is checked against the numbers, in every locale.
 *
 * Paired both ways, like every presence rule here: the claim must be STATED (an
 * answer that just deletes it tells a buyer nothing about what they get instead
 * of the scheduling they were wrongly promised), and it must be TRUE.
 */
export function localeCreditLeadershipFaults(
  values: LocalisedValue[],
  monthlyGrants: Record<string, number | null>,
): string[] {
  const faults: string[] = [];
  const plus = monthlyGrants.pro_plus;
  const others = Object.entries(monthlyGrants).filter(([plan]) => plan !== "pro_plus");
  const leads =
    typeof plus === "number" &&
    others.length > 0 &&
    others.every(([, value]) => typeof value === "number" && value < plus);

  for (const { locale, key, value } of values) {
    const stated = LOCALE_CLAIMS[locale].creditLeadership.test(value);
    if (!stated) {
      faults.push(`${locale} ${key}: never claims the largest monthly AI credit grant`);
    } else if (!leads) {
      faults.push(
        `${locale} ${key}: claims the largest monthly AI credit grant, but pro_plus grants ${plus} against ${others
          .map(([plan, v]) => `${plan}=${v}`)
          .join(", ")}`,
      );
    }
  }
  return faults;
}

/**
 * Which comparison the extra-organisation rate ACTUALLY licenses, derived from
 * the seed rather than asserted.
 *
 * "exactly" only if every rider in every plan × interval × currency is exactly
 * half; otherwise the honest claim is "no more than half". Measured on today's
 * seed: `seazn_pro_monthly` eur 1800→900 and aud 2800→1400 are exactly 50.0%,
 * while usd is 47.4% — so a bare "half" is false in usd and "under half" is
 * false in eur. Only "no more than half" is true in all twenty combinations,
 * and deriving the shape here is what keeps the copy honest in EITHER direction
 * if a price moves.
 */
export function riderClaimShape(plans: PricedPlan[]): "exactly" | "atMost" {
  for (const plan of plans) {
    for (const price of Object.values(plan.prices)) {
      const base = price.tiers?.find((t) => t.up_to === 1);
      const rider = price.tiers?.find((t) => t.up_to === "inf");
      if (!base || !rider) return "atMost";
      for (const currency of SEED_CURRENCIES) {
        const baseAmount = amountIn(base, currency);
        const riderAmount = amountIn(rider, currency);
        if (baseAmount === undefined || riderAmount === undefined) return "atMost";
        if (riderAmount !== baseAmount / 2) return "atMost";
      }
    }
  }
  return "exactly";
}

/**
 * The half-rate sentence, four locales, against the shape the seed licenses.
 *
 * Paired, again: the claim must be MADE (an answer that drops it leaves a buyer
 * with no idea what a second organisation costs) and it must carry the
 * qualifier the arithmetic requires. And note the guard is not "always demand
 * 'no more than'" — if every rider became an exact half, `riderClaimShape`
 * returns "exactly" and an unqualified "half the base rate" stops being a
 * fault, because it stops being false.
 */
export function localeHalfClaimFaults(
  values: LocalisedValue[],
  shape: "exactly" | "atMost",
): string[] {
  const faults: string[] = [];
  for (const { locale, key, value } of values) {
    const claims = LOCALE_CLAIMS[locale];
    // CLAUSE-SCOPED, not value-scoped. Value-scoped was wrong-clause
    // satisfaction — the third occurrence of that defect in this wave: append
    // a bare "each extra one at half the base rate" to a value whose EARLIER
    // clause already said "no more than half", and the qualifier from the first
    // clause answered for the second. The qualifier has to be in the clause
    // that makes the claim, or it qualifies nothing.
    const claiming = valueClauses(value).filter((c) => claims.halfClaim.test(c));
    if (claiming.length === 0) {
      faults.push(`${locale} ${key}: makes no statement about the extra-organisation rate`);
      continue;
    }
    if (shape !== "atMost") continue;
    for (const clause of claiming) {
      if (!claims.atMostHalf.test(clause)) {
        faults.push(
          `${locale} ${key}: "${clause.slice(0, 56)}" quotes half the base rate with no "no more than" qualifier, but the seed's riders are not all exactly half`,
        );
      }
    }
  }
  return faults;
}

// ── THE APPROVED-WORDING GATE, for four-locale dictionary values ─────────────
//
// The positive half of this file's guards, and the one that does not depend on
// anyone having imagined the right falsehood.
//
// Every rule above reads a sentence and decides whether it is false. Four
// independent measurements in this wave say that shape scores on the examples
// its author imagined and collapses on anyone else's — task 3 went 12/12 to
// 6/30, task 4 went 16/16 to 0/32, and a percentage-shaped rate clause scored
// 0/9 against a rule written specifically about rate clauses. Worse, the
// falsehood that survived two rounds of widening (`pricing.faq.groups.a`, "half
// your plan's rate", four locales) had a pattern written for it ALREADY; nobody
// had pointed the rule at that key.
//
// A pinned string has neither failure mode. It does not generalise, so no
// rewording evades it, and it needs no claim-family coverage — the value either
// is the approved value or it is not. The vocabulary rules stay as the
// SECONDARY net, for copy that is not yet pinned.

/** One approved dictionary value, in every locale. See `_approved-dictionary-copy.ts`. */
export interface ApprovedValue {
  file: "marketing" | "ui";
  key: string;
  why: string;
  text: Record<DictionaryLocale, string>;
}

/**
 * The gate. `read(file, locale)` returns the flat dictionary — flat dotted keys,
 * never nested traversal.
 *
 * The fault carries the on-disk string verbatim so the reviewer's step is to
 * read it against `why` and paste it in, not to retype it. A missing key is a
 * fault of its own: an approved entry pointing at nothing is a rule that has
 * quietly stopped covering anything.
 */
export function approvedDictionaryFaults(
  approved: ApprovedValue[],
  read: (file: "marketing" | "ui", locale: DictionaryLocale) => Record<string, string>,
): string[] {
  const faults: string[] = [];
  if (approved.length === 0) return ["the approved-copy inventory is empty — this gate examines nothing"];
  for (const entry of approved) {
    for (const locale of DICTIONARY_LOCALES) {
      const onDisk = read(entry.file, locale)[entry.key];
      if (typeof onDisk !== "string") {
        faults.push(`${locale} ${entry.key}: approved but ABSENT from ${entry.file}.json`);
        continue;
      }
      const want = entry.text[locale];
      if (want === undefined) {
        faults.push(`${entry.key}: no approved ${locale} wording — every locale must be approved together`);
        continue;
      }
      if (onDisk !== want) {
        faults.push(
          [
            `${locale} ${entry.key}: wording changed and has not been re-approved.`,
            `  what it claims: ${entry.why}`,
            `  approved: ${want}`,
            `  on disk:  ${onDisk}`,
          ].join("\n"),
        );
      }
    }
  }
  return faults;
}

// ── MODULE-WIDE ANTI-VACUITY ─────────────────────────────────────────────────
//
// TWICE IN THIS WAVE A GUARD HAS PASSED WHILE EXAMINING NOTHING, and neither
// was caught by the suite that owned it:
//
//  1. the French permanence list could not match its own language, because JS
//     `\b` is ASCII-only and `/\bà\s+vie\b/` never fires (task 4 found it);
//  2. `DURATION_CLAIM` matched NOTHING AT ALL — a stray control character where
//     `\b` belonged, introduced by tooling — and the suite stayed green because
//     a sibling rule happened to cover the same fixtures (task 3 found it).
//
// Both are the same class: a pattern that is *syntactically* valid, compiles
// without error, and silently matches nothing. Every assertion built on it then
// reports clean. This makes every other guard in the file untrustworthy, so the
// check belongs to the MODULE rather than to any one rule.
//
// `collectPatterns` walks the module's exported values — including patterns
// nested in arrays, in `LOCALE_CLAIMS`, and in the `[feature, RegExp]` tuples —
// so a pattern cannot escape by being somewhere new. A caller then asserts:
//   - no pattern source contains a CONTROL CHARACTER (defect 2's signature);
//   - every pattern matches at least one string in a known-positive corpus
//     (defect 1's signature: a pattern that can never fire).
// Adding a pattern therefore requires adding a fixture it matches, which is the
// cheapest possible proof that the pattern does something.

/** One regex found anywhere in the module's exports, with the path to it. */
export interface LocatedPattern {
  path: string;
  pattern: RegExp;
}

export function collectPatterns(module: Record<string, unknown>): LocatedPattern[] {
  const found: LocatedPattern[] = [];
  const seen = new Set<unknown>();
  const walk = (node: unknown, path: string): void => {
    if (node instanceof RegExp) {
      found.push({ path, pattern: node });
      return;
    }
    if (node === null || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, `${path}[${i}]`));
      return;
    }
    for (const [key, child] of Object.entries(node)) walk(child, `${path}.${key}`);
  };
  for (const [name, value] of Object.entries(module)) walk(value, name);
  return found;
}

/** Control characters are never intentional in a hand-written pattern; they are
 *  what a broken edit leaves behind where an escape belonged. */
const CONTROL_CHARACTER = /[\x00-\x1F\x7F]/;

export function controlCharacterFaults(patterns: LocatedPattern[]): string[] {
  return patterns
    .filter(({ pattern }) => CONTROL_CHARACTER.test(pattern.source))
    .map(
      ({ path, pattern }) =>
        `${path}: pattern source contains a control character (U+${pattern.source
          .split("")
          .find((c) => CONTROL_CHARACTER.test(c))!
          .charCodeAt(0)
          .toString(16)
          .padStart(4, "0")}) — almost certainly a mangled escape`,
    );
}

/**
 * `collectPatterns` walks module EXPORTS, so a top-level pattern that is not
 * exported is invisible to it — and seven were, including `DURATION_CLAIM`,
 * which this very check names as reason #2 for existing. Measured: a literal
 * U+0001 in `DURATION_CLAIM` left the suite 36/36 green, while the identical
 * byte in an exported pattern redded three tests.
 *
 * So the reachability is enforced at the SOURCE level rather than trusted: any
 * top-level `const NAME = <pattern>` that is not exported is a fault, because
 * nothing downstream can see it. `CONTROL_CHARACTER` is the one legitimate
 * exception — it is the checker, not a claim, and demanding it match a
 * known-positive fixture would mean putting a control character in the corpus.
 */
const PATTERN_SHAPED = /=\s*(\/|new RegExp\b|claim\()/;
export const UNEXPORTED_PATTERN_ALLOWLIST = ["CONTROL_CHARACTER", "PATTERN_SHAPED"];

export function unexportedPatternFaults(moduleSource: string): string[] {
  const faults: string[] = [];
  for (const line of moduleSource.split("\n")) {
    const match = /^const ([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=/.exec(line);
    if (!match || !PATTERN_SHAPED.test(line)) continue;
    const name = match[1]!;
    if (UNEXPORTED_PATTERN_ALLOWLIST.includes(name)) continue;
    faults.push(
      `${name}: a top-level pattern that is not exported — collectPatterns cannot see it, so it is exempt from every anti-vacuity rule below. Add \`export\`.`,
    );
  }
  return faults;
}

/**
 * The control-character scan, run over the module's RAW SOURCE rather than over
 * compiled patterns. Belt and braces: it catches a mangled escape anywhere in
 * the file — in a non-exported const, in a `String.raw` fragment that is only
 * ever composed into another pattern, or in ordinary prose — none of which the
 * compiled-pattern scan can reach. Tabs and newlines are legitimate source.
 */
export function sourceControlCharacterFaults(moduleSource: string): string[] {
  const faults: string[] = [];
  moduleSource.split("\n").forEach((line, i) => {
    const found = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.exec(line);
    if (found) {
      faults.push(
        `line ${i + 1}: literal control character U+${found[0]!.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase()} in the source — almost certainly a mangled escape`,
      );
    }
  });
  return faults;
}

/** Every pattern must fire on SOMETHING. One that matches nothing in the corpus
 *  is either dead or untested, and the two are indistinguishable from here. */
export function inertPatternFaults(patterns: LocatedPattern[], corpus: string[]): string[] {
  return patterns
    .filter(({ pattern }) => !corpus.some((text) => pattern.test(text)))
    .map(
      ({ path, pattern }) =>
        `${path}: matches nothing in the known-positive corpus (${describeClaim(pattern)}) — it is inert, and every assertion resting on it reports clean`,
    );
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

// ═════════════════════════════════════════════════════════════════════════════
// ALLOWLIST — APPROVED FORMS, NOT BANNED ONES  (fix round 2)
// ═════════════════════════════════════════════════════════════════════════════
//
// Three rounds of this wave widened the NEGATIVE side and lost three times. The
// measurements, all by someone other than the pattern's author:
//
//   round 0  the seed guards          defeated by a reword
//   round 1  topic + verb vocabulary  fee 1/12, permanence 1/11
//   round 2  "closed set of forms"    fee 0/12, permanence 0/12, constant 0/4
//
// Round 2's diagnosis is the one that matters, and it is correct: the forms were
// not closed. "A negated limit" was a word list — end|expiry|deadline|cut-off —
// so the same FORM with a different word walked straight through. It was a
// denylist wearing grammar's clothes. Every author scores well against their own
// rewordings and badly against a stranger's, because a denylist can only ever
// contain what its author thought of.
//
// THE SPACE OF FALSE PHRASINGS IS OPEN. THE SPACE OF APPROVED COPY IS CLOSED.
//
// So the verdict flips. A sentence that makes one of these claims must MATCH AN
// APPROVED FORM, and a wording nobody predicted fails by default.
//
// ── WHAT THIS LAYER ACTUALLY DELIVERS, MEASURED ──────────────────────────────
// Do not read the paragraph above as a claim that this catches these families.
// It does not. Against a committed set of twelve rewordings per family, with the
// inventory gate excluded, this layer scores:
//
//     duration   1/12        fee reversion   4/12
//
// (`help-copy-truth.test.ts` asserts both numbers EXACTLY, so widening this
// layer has to update them deliberately. An independent reviewer measured 1/12
// and 0/12 on its own sets — the agreement is the point.)
//
// THE INVENTORY GATE IS DOING THE WORK. This layer is a secondary net: it gives
// a specific, actionable failure where it does fire, and it covers articles the
// gate does not pin. It is not the reason a falsehood cannot ship.
//
// The cost is friction: a genuinely new true sentence also fails until someone
// approves a form for it.

/** A claim we police, as "how to spot one" plus "the ways we accept it". */
export interface ClaimAllowlist {
  /** What the claim is about, for the fault label. */
  kind: string;
  /** Broad, deliberately over-inclusive: does this sentence make such a claim?
   *  Recall matters here and precision does not, because the verdict is decided
   *  by `approved` below — a sentence swept in wrongly is one an approved form
   *  then accepts. */
  classifies: RegExp[];
  /** Narrow: the shapes this claim may take. Each is a SHAPE, and the fault
   *  label names which one matched so an editor can see what is on offer. */
  approved: Array<[form: string, pattern: RegExp]>;
  /** What to do about a fault, printed in the label. */
  guidance: string;
}

/**
 * Every sentence making the claim must match an approved form.
 *
 * Returns the sentence AND the list of forms on offer, because the failure an
 * editor meets must be actionable: "this is not one of the four ways we say
 * this" is useless without the four ways.
 */
export function unapprovedClaimFaults(
  label: string,
  prose: string,
  allowlist: ClaimAllowlist,
  /** Paragraphs already pinned word-for-word by `goldenParagraphFaults`. They
   *  are excluded because the gate is STRICTER than any allowlist — it permits
   *  exactly one wording — so re-judging them here only adds forms that exist to
   *  describe sentences the generalising rules were never meant to cover. */
  gatedParagraphs: string[] = [],
): string[] {
  const faults: string[] = [];
  for (const block of claimTexts(prose)) {
    if (gatedParagraphs.includes(block)) continue;
    for (const sentence of sentences(block)) {
      if (!allowlist.classifies.some((p) => p.test(sentence))) continue;
      if (allowlist.approved.some(([, p]) => p.test(sentence))) continue;
      faults.push(
        `${label}: "${sentence.slice(0, 96)}" makes a ${allowlist.kind} claim in no approved form. ${allowlist.guidance} Approved forms: ${allowlist.approved.map(([form]) => form).join("; ")}.`,
      );
    }
  }
  return faults;
}

/** Which approved forms actually fired on this prose. The anti-vacuity backstop
 *  for an allowlist: a `classifies` list that has drifted narrow sweeps nothing
 *  in, every sentence passes, and the rule reports clean while examining
 *  nothing — the exact failure this wave has now hit three times. */
export function approvedFormsExercised(prose: string, allowlist: ClaimAllowlist): string[] {
  const fired = new Set<string>();
  for (const block of claimTexts(prose)) {
    for (const sentence of sentences(block)) {
      if (!allowlist.classifies.some((p) => p.test(sentence))) continue;
      for (const [form, pattern] of allowlist.approved) {
        if (pattern.test(sentence)) fired.add(form);
      }
    }
  }
  return [...fired];
}

// ── The pass's duration ──────────────────────────────────────────────────────

/**
 * Does this sentence say anything about how long the pass holds? Cast wide:
 * persistence, termination and extent vocabulary, in any combination. The two
 * rewordings that beat round 2 are both caught here — "the upgrade is yours
 * from then on and your competition never loses it" on `yours`/`never`/`loses`,
 * and "it applies for the entire duration" on the extent phrase — and then fail
 * because no approved form fits them.
 *
 * MEASURED AND NARROWED. The first draft used bare verbs — `stays`, `ends`,
 * `never`, `while`, `switch off` — and swept in seventeen true sentences that
 * make no duration claim at all ("your brand colour STAYS a Pro feature", "the
 * checkout quotes YOURS", "a competition is NEVER billed twice", "SO WHILE
 * you're on a paid plan"). An allowlist whose classifier over-fires forces
 * approved forms to be invented for sentences the rule was never about, and
 * those forms are then holes. So each entry below requires the predicate to be
 * about DURATION specifically, and several require the pass to be its subject.
 */
export const DURATION_CLAIM_CLASSIFIERS = [
  // An extent, named.
  /\bfor\s+(?:the\s+|its\s+|your\s+|that\s+|this\s+)?(?:life|lifetime|duration|rest|remainder|whole|entire)\b/i,
  /\b(?:from\s+(?:then|now)\s+on|for\s*ever|forever|for\s+good|in\s+perpetuity|indefinitely|open[-\s]ended|how\s+long|always\s+(?:applies|works|holds))\b/i,
  /\bpermanent\w*\b/i,
  // A bound, stated temporally — "while it runs", not "while you're on Pro".
  /\bwhile\b[^.;:!?]*\b(?:runs?|running|active|live|open|under\s*way)\b/i,
  /\b(?:until|for\s+as\s+long\s+as|as\s+long\s+as)\b[^.;:!?]*\b(?:runs?|running|active|live|open|over|archived?|completed?)\b/i,
  // A stop, or its denial, with the PASS as its subject.
  /\b(?:pass|upgrade)\b[^.;:!?]*\b(?:expires?|lapses?|runs?\s+out|stops?\s+(?:applying|working)|switch(?:es)?\s+off)\b|\b(?:expires?|lapses?|runs?\s+out|stops?\s+applying|switch(?:es)?\s+off)\b[^.;:!?]*\b(?:pass|upgrade)\b/i,
  /\bno\s+(?:end\s*date|expiry|expiration|time\s+limit|deadline|cut[-\s]?off|last\s+day)\b/i,
  /\bnever\s+(?:loses?|lose|expires?|ends?|lapses?|stops?|switch\w*|goes?\s+away|comes?\s+off|runs?\s+out)\b/i,
  /\bend\s*date\b/i,
  // Persistence, as a claim rather than as an ordinary verb.
  /\b(?:stays?|remains?|is)\s+yours\b|\byours\s+(?:to\s+keep|from)\b|\bto\s+keep\b/i,
  /\b(?:stays?|remains?)\s+in\s+force\b|\bkeeps?\s+(?:working|applying)\b|\bstill\s+applies\b|\bcarries?\s+on\b|\brides?\s+(?:on|along)\b|\bsurvives?\b/i,
];

/**
 * The ways this product's duration may truthfully be stated. Four, because the
 * behaviour has four parts: it is bounded to a running competition; it stops on
 * a named condition; it does not transfer to the next edition; and it outlives a
 * subscription lapse because it was bought outright.
 *
 * Each is anchored on the CONDITION, not on adjectives — that is what stops a
 * new falsehood slipping in as a variant. "Once bought, the upgrade is yours
 * from then on" matches none of the four, and cannot be made to without stating
 * a condition that is not true.
 */
export const APPROVED_DURATION_FORMS: Array<[form: string, pattern: RegExp]> = [
  ["bounded to a running competition (`while it runs`)", BOUNDED_SCOPE_GRAMMAR],
  [
    "stops on a named condition (`stops once the competition is completed or archived`)",
    /\bend\s*date\b[^.;:!?]*\bpassed\b|\bcompleted\s+or\s+archived\b|\b(stops?|ends?|switch(?:es)?\s+off|no\s+longer\s+applies|lifts?\s+off|drops?\s+back)\b[^.;:!?]*\b(once|when|after)\b[^.;:!?]*\b(completed?|archived?|over|finished?|end\s*date|\d+\s+days?)\b|\b(once|when|after)\b[^.;:!?]*\b(completed?|archived?|over|finished?|end\s*date|\d+\s+days?)\b[^.;:!?]*\b(stops?|ends?|switch(?:es)?\s+off|no\s+longer|drops?\s+back)\b/i,
  ],
  [
    "does not transfer to a new competition (`a new edition needs its own pass`)",
    /\b(does\s+not|doesn'?t|won'?t|never)\b[^.;:!?]*\bcarr(?:y|ies)\b[^.;:!?]*\b(next|new|another|season|edition|year)\b|\b(new|next|another)\b[^.;:!?]*\b(competition|edition|event)\b[^.;:!?]*\b(needs?|is)\b[^.;:!?]*\b(own\s+pass|new\s+pass|a\s+new\s+purchase)\b/i,
  ],
  [
    "outlives a subscription lapse, because it was bought outright for that event",
    /\bbought\s+outright\b|\bsurvives?\s+a\s+downgrade\b/i,
  ],
  [
    "bound to the competition itself, not to its name (`rename it freely`)",
    /\bbound\s+to\s+the\s+competition\b/i,
  ],
];

export const DURATION_ALLOWLIST: ClaimAllowlist = {
  kind: "pass-duration",
  classifies: DURATION_CLAIM_CLASSIFIERS,
  approved: APPROVED_DURATION_FORMS,
  guidance:
    "Rewrite it as one of the approved forms, or — if the product genuinely behaves a new way — add a form here and say why in the commit.",
};

// ── The entry-fee rate ───────────────────────────────────────────────────────

/**
 * A claim about what an entrant is charged, once the pass is no longer in force.
 *
 * Both halves are needed. Rate vocabulary alone sweeps in every true sentence
 * that merely quotes the 5% (there are nine), and the transition alone sweeps in
 * every sentence about the pass ending that says nothing about money. The
 * INTERSECTION is where the falsehood has to live, because the claim cannot be
 * made without naming both.
 *
 * Note the rate vocabulary is about a RATE, not about money in general: "only
 * the first charge sticks — the duplicate is refunded automatically" is a
 * statement about a duplicate payment, and was a measured false positive when
 * `charge` was in this list on its own.
 */
export const RATE_VOCABULARY =
  /\b(platform\s+fees?|entry[-\s]fees?|fee\s+rate|rates?|fees?|per\s*cent|percent|pricing|entry\s+costs?|costs?\s+you\s+more|cheaper|dearer|commission|\d+(?:\.\d+)?\s*%)\b/i;

export const PASS_TRANSITION_VOCABULARY =
  /\b(after|once|when)\b[^.;:!?]*\b(ends?|ended|ending|closes?|closed|finish\w*|over|expir\w*|stops?|stopped|lapses?|archiv\w*|completed?|handed\s+out|trophy)\b|\b(no\s+longer|later\s+(?:entrants?|entries|entry|payers?)|back\s+to|goes?\s+back|returns?\s+to|again|revert\w*|normal|standard|downgrad\w+|after\s+(?:that|then|it)|when\s+the\s+pass|after\s+the\s+pass|pass\s+(?:ends?|stops?|expires?|lapses?|does))\b|(?:\b(?:revok\w+|refund\w*|chargeback)\b[^.;:!?]*\bpass\b|\bpass\b[^.;:!?]*\b(?:revok\w+|refund\w*|chargeback)\b)/i;

// `(?=A)(?=B)` requires BOTH to match at the SAME index, which is almost never
// true of two different vocabularies — measured: it classified nothing at all,
// and the rule built on it reported clean over the whole article. The `.*`
// prefixes are what make each lookahead mean "somewhere in this sentence".
// (Caught by `approvedFormsExercised`, which exists for exactly this.)
export const FEE_RATE_CLAIM_CLASSIFIERS = [
  new RegExp(`(?=.*(?:${RATE_VOCABULARY.source}))(?=.*(?:${PASS_TRANSITION_VOCABULARY.source}))`, "i"),
];

/**
 * The three true things there are to say about the rate after a pass ends, all
 * of them anchored on the FIRST PAID CARD ENTRY, because that is the only thing
 * that decides the answer (`registrations.ts` is the sole writer of
 * `competitions.fee_percent`, and its `where … and fee_percent is null` makes it
 * first-wins).
 *
 * There is deliberately no form for "the rate goes back up", because there is no
 * true sentence of that shape: a competition that has taken a paid card entry
 * keeps its rate, and one that has not was never on the pass rate to begin with.
 */
export const APPROVED_FEE_RATE_FORMS: Array<[form: string, pattern: RegExp]> = [
  [
    "the lock (`the platform fee stays locked at what the first paid card entry was charged`)",
    new RegExp(`(?=.*${FEE_SUBJECT})(?=.*${FEE_LOCK_WORD})(?=.*${PAID_ENTRY_TRIGGER})`, "i"),
  ],
  [
    "the unlocked case (`a competition with no paid card entry yet follows your plan's rate`)",
    /\bno\s+paid\s+(?:card\s+)?(?:entry|entrant|registration)\b[^.;:!?]*\b(plan|live|standard)\b|\b(plan|live|standard)\b[^.;:!?]*\bno\s+paid\s+(?:card\s+)?(?:entry|entrant|registration)\b/i,
  ],
  [
    "the pass rate riding on, conditioned on when the first entry was taken",
    /\bfirst\s+(?:paid\s+)?(?:card\s+)?(?:entry|entrant|payment)\b[^.;:!?]*\b(while|before|after|during)\b[^.;:!?]*\bpass\b/i,
  ],
];

export const FEE_RATE_ALLOWLIST: ClaimAllowlist = {
  kind: "entry-fee-rate-after-the-pass",
  classifies: FEE_RATE_CLAIM_CLASSIFIERS,
  approved: APPROVED_FEE_RATE_FORMS,
  guidance:
    "The rate is decided by the FIRST PAID CARD ENTRY and nothing else — check registrations.ts before rewording.",
};

// ── A golden fixture over the two paragraphs that keep regressing ────────────

/** One paragraph whose exact wording has been read against the code and
 *  approved. `find` locates it; `text` is what it must say. */
export interface ApprovedParagraph {
  id: string;
  find: RegExp;
  text: string;
  why: string;
}

/**
 * The two paragraphs that carry this product's two most-regressed claims, pinned
 * WORD FOR WORD.
 *
 * Every rule above generalises, and generalising is how all three previous
 * rounds were beaten. This one does not generalise: it compares the paragraph to
 * an approved string. There is no phrasing that evades it, because it is not
 * looking at phrasing.
 *
 * The friction is deliberate and is the whole point. These paragraphs describe
 * money an organiser is charged, they have carried a falsehood in three
 * consecutive rounds, and the cost of changing them is now one deliberate
 * re-approval — which is a person reading the new words against
 * `registrations.ts` and `org_has_feature`, exactly the step that was skipped
 * each time.
 */
export function goldenParagraphFaults(
  label: string,
  markdown: string,
  approved: ApprovedParagraph[],
): string[] {
  const faults: string[] = [];
  const blocks = proseBlocks(markdown);
  for (const paragraph of approved) {
    const matches = blocks.filter((block) => paragraph.find.test(block));
    if (matches.length === 0) {
      faults.push(
        `${label}: the approved paragraph "${paragraph.id}" is GONE — renamed, split or deleted. It stated: ${paragraph.why} If that is intended, update the fixture; if not, this is the regression.`,
      );
      continue;
    }
    if (matches.length > 1) {
      faults.push(
        `${label}: "${paragraph.id}" matches ${matches.length} paragraphs, so this fixture is pinning an ambiguous target — tighten its \`find\`.`,
      );
      continue;
    }
    const actual = matches[0]!;
    if (actual === paragraph.text) continue;
    faults.push(
      [
        `${label}: the approved paragraph "${paragraph.id}" CHANGED.`,
        "",
        "  THIS TEST IS A GATE, NOT A BUG. This paragraph states " + paragraph.why,
        "  It has shipped a falsehood in three consecutive rounds of this wave, so",
        "  its wording is pinned and changing it requires a deliberate re-approval:",
        "  read the new text against server/usecases/registrations.ts (the fee lock)",
        "  and lib/entitlements.ts (the pass window), then paste it into",
        "  src/lib/__tests__/_approved-copy.ts.",
        "",
        `  approved: ${paragraph.text}`,
        `  on disk:  ${actual}`,
      ].join("\n"),
    );
  }
  return faults;
}

// ── THE INVENTORY GATE ───────────────────────────────────────────────────────
//
// Measured, after the allowlist above was final: a fresh adversarial set scored
// 6/30, while the reviewer's own set — which the rules had been tuned against —
// scored 12/12. Same author, same rules, twice the effort, and the gap is the
// whole story: EVERY LEXICAL RULE SCORES WELL AGAINST THE EXAMPLES IT WAS
// WRITTEN FOR AND BADLY AGAINST THE NEXT ONES. Four rounds of this wave have now
// demonstrated it (1/12, 0/12, 12/12-then-6/30). It is not a tuning problem.
//
// So the primary defence stops being about words. This pins the INVENTORY of the
// pass's own copy: a digest per paragraph, in order. A sentence added anywhere
// in it — in a new paragraph or inside an existing one — changes the inventory
// and fails, whatever it says, because nothing here is reading it.
//
// The cost is that every legitimate edit to this copy also fails until someone
// updates the fixture. That is the accepted trade: this article describes money
// an organiser is charged, it has carried a falsehood in three consecutive
// rounds, and the one step that would have caught all three — a person reading
// the new words against the code — is exactly what the fixture forces.
//
// Digests rather than the prose itself, so the fixture does not become a second
// copy of the article that reviewers must diff twice. The text is printed from
// disk when a check fails, so the failure is still actionable.

/**
 * FNV-1a, run twice from different offset bases and concatenated — 64 bits of
 * separation out of 32-bit integer arithmetic.
 *
 * Not cryptographic and does not need to be: the thing being detected is an
 * edit, not a forgery. Hand-rolled so this module keeps its zero-import surface
 * (`node:crypto` here would be one careless import away from a client bundle),
 * and in plain numbers rather than BigInt because `apps/web/tsconfig.json`
 * targets ES2017, which rejects BigInt literals outright (TS2737). An earlier
 * version of this comment blamed `tsconfig.scripts.json`, which in fact targets
 * es2022 — a false comment, in the module this wave exists to make truthful.
 */
function fnv1a(text: string, offsetBasis: number): number {
  let hash = offsetBasis;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function blockDigest(text: string): string {
  const low = fnv1a(text, 0x811c9dc5);
  const high = fnv1a(text, 0x9e3779b9);
  return high.toString(16).padStart(8, "0") + low.toString(16).padStart(8, "0");
}

/** The digest of every prose block, in order. */
export function blockDigests(markdown: string): string[] {
  return proseBlocks(markdown).map(blockDigest);
}

const GATE_PREAMBLE = [
  "  THIS TEST IS A GATE, NOT A BUG.",
  "  The pass's copy is inventory-pinned. Four rounds of vocabulary rules failed",
  "  to catch a falsehood ADDED beside true sentences (measured 1/12, 0/12, and",
  "  6/30 against a fresh set), so what is checked here is that the copy is the",
  "  copy that was approved — not that it avoids any particular wording.",
  "",
  "  To make this pass: read your new text against the code it describes —",
  "  server/usecases/registrations.ts for the entry-fee lock, lib/entitlements.ts",
  "  for the pass window — then update the digests in",
  "  src/lib/__tests__/_approved-copy.ts and say in the commit what you checked.",
].join("\n");

/**
 * The pass's copy, paragraph by paragraph, against the approved inventory.
 *
 * Reports ADDED, REMOVED and CHANGED blocks separately, with the on-disk text
 * and the digest to paste, because a gate whose failure message is a hex string
 * is a gate people route around.
 */
export function inventoryFaults(label: string, markdown: string, approved: string[]): string[] {
  const surfaces = claimSurfaces(markdown);
  const blocks = surfaces.map((surface) =>
    surface.kind === "frontmatter" ? `${surface.field}: ${surface.text}` : surface.text,
  );
  const actual = blocks.map(blockDigest);
  if (approved.length === 0) {
    return [`${label}: the approved inventory is EMPTY, so this gate is checking nothing.`];
  }
  const faults: string[] = [];
  const actualSet = new Set(actual);

  // POSITIONAL, not set-membership (fix round 3). The set version raised ZERO
  // faults when two real paragraphs were SWAPPED, while its own message claimed
  // to catch "duplicated or reordered" — a comment promising more than the code
  // delivered, which is the exact defect this wave exists to remove. Order is
  // part of the approved copy: "It stops once that competition is over:" means
  // something different two paragraphs away from its bullets.
  blocks.forEach((block, i) => {
    if (actual[i] === approved[i]) return;
    const movedFrom = approved.indexOf(actual[i]!);
    const detail =
      movedFrom === -1
        ? `is NOT in the approved inventory`
        : `is approved copy, but MOVED here from position ${movedFrom + 1}`;
    faults.push(
      [
        `${label}: surface ${i + 1} of ${blocks.length} (${surfaces[i]!.kind}) ${detail}.`,
        "",
        GATE_PREAMBLE,
        "",
        `  digest: "${actual[i]}"`,
        `  text:   ${block}`,
      ].join("\n"),
    );
  });

  for (const digest of approved) {
    if (actualSet.has(digest)) continue;
    faults.push(
      [
        `${label}: an approved surface (digest "${digest}") is GONE from the article.`,
        "",
        GATE_PREAMBLE,
      ].join("\n"),
    );
  }

  if (faults.length === 0 && actual.length !== approved.length) {
    faults.push(
      `${label}: the article has ${actual.length} surfaces and the inventory has ${approved.length}.`,
    );
  }
  return faults;
}
