// Truth-in-copy guards for the FOUR-LOCALE DICTIONARIES (v17 gap wave 7, task 4).
//
// Third sibling of `plan-copy-truth.test.ts` (the Stripe seed) and
// `help-copy-truth.test.ts` (the help tree). Same pure functions from
// `@/lib/copy-truth`, same "prove it by rewording" discipline — but this surface
// differs from both in the one way that matters:
//
//   THE SEED IS ONE ENGLISH FILE. THE HELP TREE IS ONE ENGLISH TREE.
//   THESE DICTIONARIES ARE FOUR FILES THAT ALL SAY THE SAME THING.
//
// Tasks 1-3 could point an English regex at their surface and be done. Doing
// that here certifies `en` and passes es/fr/nl in silence. Measured on the exact
// strings this task fixes, BEFORE the fix, with the shared
// `FALSE_PASS_PERMANENCE_PATTERNS`:
//
//   en pricing.pass.note  "Yours for the event's lifetime."        1 hit
//   es pricing.pass.note  "Tuyo durante toda la vida del evento."  0 hits
//   fr pricing.pass.note  "À vous pour toute la durée de …"        0 hits
//   nl pricing.pass.note  "…voor de hele levensduur van het …"     0 hits
//
// Four identical falsehoods, one red. So `LOCALE_CLAIMS` is keyed by locale,
// every vocabulary is cross-applied to every value, a retired-literal registry
// backs both up, and `localeCoverageFaults` makes an unguarded locale a FAULT.
// See the long header over that section in `@/lib/copy-truth` for why three
// layers rather than one.
//
// LOCATION IS LOAD-BEARING: `src/lib/__tests__/`. CI's unit job has no
// DATABASE_URL and its Postgres steps select `src/server src/lib` and `src/app`
// (.github/workflows/ci.yml). From `src/__tests__/` the `describe.skipIf(!HAS_DB)`
// half would run in no job at all and report pending on a green exit 0.
import { afterAll, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import stripePlans from "@/config/stripe-plans.json";
import { sql } from "@/lib/db";
import { PASS_CREDIT_GRANT } from "@/lib/pricing-cards";
import {
  DICTIONARY_LOCALES,
  type DictionaryLocale,
  type FeatureGrants,
  LOCALE_CLAIMS,
  type LocalisedValue,
  type PricedPlan,
  localeCoverageFaults,
  localeCreditGrantFaults,
  localeCreditLeadershipFaults,
  localeHalfClaimFaults,
  localePassBoundFaults,
  localePlusDifferentiatorFaults,
  retiredClaimFaults,
  riderClaimShape,
} from "@/lib/copy-truth";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

// Dictionaries are FLAT dotted-key JSON. Read as a flat record and looked up
// with `in`/indexing — never traversed as if "pricing.pass.note" were three
// nested objects, which is how a present key gets reported missing.
const load = (locale: string, file: string): Record<string, string> =>
  JSON.parse(readFileSync(`src/dictionaries/${locale}/${file}.json`, "utf8"));

const localesOnDisk = readdirSync("src/dictionaries", { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

/** Every value of `key` in `file`, one per locale. */
const across = (file: "marketing" | "ui", key: string): LocalisedValue[] =>
  DICTIONARY_LOCALES.map((locale) => ({ locale, key, value: load(locale, file)[key] ?? "" }));

// ── The keys this task owns ──────────────────────────────────────────────────
//
// `pricing.pass.note` and `pricing.faq.eventPass.a` are the PUBLIC pricing page;
// `upgrade.intro` and `upgrade.active.body` are the in-app purchase page a buyer
// reads immediately before paying (`/o/[orgSlug]/c/[compSlug]/upgrade`, rendered
// at page.tsx:430 as `t(dict, held ? "upgrade.active.body" : "upgrade.intro")`);
// `billing.passOffer.note` is the offer card in Settings → Billing
// (`components/billing-pass-offer.tsx:56`). Five keys, twenty values, one
// falsehood.
//
// `billing.passOffer.note` also makes a SECOND claim — that a passed
// competition stops counting against the active-competition limit. Verified
// TRUE against the resolver before touching the sentence and kept verbatim:
// `usecases/competitions.ts:88` and `usecases/entitlement-freeze.ts:69` both
// count with `not exists (select 1 from competition_passes …)`. Fixing a false
// clause is not a licence to quietly drop a true one.
const PASS_BOUND_VALUES: LocalisedValue[] = [
  ...across("marketing", "pricing.pass.note"),
  ...across("marketing", "pricing.faq.eventPass.a"),
  ...across("ui", "upgrade.intro"),
  ...across("ui", "upgrade.active.body"),
  ...across("ui", "billing.passOffer.note"),
];

/** The one pass string that quantifies the credit grant. */
const PASS_CREDIT_VALUES = across("marketing", "pricing.faq.eventPass.a");

/** The Pro Plus FAQ answer — a different claim family, deliberately NOT scanned
 *  for pass permanence. Pro Plus is a subscription: "for as long as you pay" is
 *  a true thing to say about it, and reusing the pass's vocabulary here would
 *  red on honest copy. (Measured: it carries no permanence hit in any locale
 *  today, in any of the four vocabularies.) */
const PLUS_VALUES = across("marketing", "pricing.faq.proPlus.a");

/**
 * Layer 3 — the literal prose this task deleted, from all four files, checked
 * against all four values of every guarded key.
 *
 * Two of these cannot be vocabulary entries without rejecting true copy, which
 * is exactly why the layer exists:
 *  - fr "pour toute la durée" is a permanence claim about the pass but a
 *    perfectly good BOUND in other sentences ("pendant toute la durée du
 *    match");
 *  - nl "voor de helft van het basistarief" becomes true the moment
 *    "hoogstens" is put in front of it, which is what this task did.
 *
 * Every literal here was checked against the REPLACEMENT copy as well as the
 * old, because a fragment can survive its own retirement: Spanish "a mitad de
 * la tarifa base" is a substring of the corrected "…de **la** mitad de la
 * tarifa base", so the retired form has to carry enough context ("adicional a
 * mitad…") to tell the two apart.
 */
const RETIRED_CLAIMS = [
  // en
  "for its lifetime",
  "survives forever",
  "event's lifetime",
  "AI-assisted scheduling",
  "one at half the base rate",
  // es
  "de por vida",
  "para siempre",
  "toda la vida del evento",
  "durante toda su vida",
  "asistida por IA",
  "adicional a mitad de la tarifa base",
  // fr
  "à vie",
  "pour toujours",
  "pour toute la durée de l",
  "pour toute sa durée",
  "assistée par IA",
  "à moitié du tarif de base",
  // nl
  "volledige levensduur",
  "hele levensduur",
  // The nl `billing.passOffer.note` reached for a different metaphor than the
  // other four keys ("voor het hele verloop", not "levensduur") — which is the
  // single best argument in this file for why a vocabulary built from one
  // string per language is not a vocabulary.
  "voor het hele verloop",
  "voor altijd",
  "AI-ondersteunde planning",
  "organisatie voor de helft van het basistarief",
];

/**
 * Copy carrying the same falsehoods that this wave does NOT own. Named as data
 * rather than left silently unscanned, the way `help-copy-truth.test.ts` names
 * its own gaps — closing one then becomes a one-line move instead of a
 * rediscovery.
 */
const KNOWN_GAPS = [
  "dictionaries/*/marketing.json pricing.plus.f3 — 'AI-assisted scheduling' on the Pro Plus CARD, in all four locales, carrying the SAME falsehood this file removes from pricing.faq.proPlus.a. Pinned by lib/pricing-cards.ts PLUS_CARD_FEATURES and asserted verbatim by e2e/pro-plus-tier.spec.ts:397; both are out of scope for this wave (#303).",
  "config/tips.ts:82 — 'half your plan's rate', bare. Hardcoded English with no dictionary lookup, so it is a four-locale gap of its own class; routed to task 7, which is already editing that tip.",
  "content/help/scheduling/ai-scheduling.md, content/help/billing/downgrade.md — task 3's gaps, still open (#303).",
  "BOUNDED_SCOPE_GRAMMAR (and therefore all four `bounded` rules, which share its shape) decides a bound by PROXIMITY inside one sentence, not grammar: a coordinated clause such as 'buy during checkout and your competitions stay active' satisfies it. Task 3's review has this queued for a fix round; the locale rules deliberately delegate to it rather than fork it, so they inherit the repair.",
];

describe("the four-locale dictionaries say what the resolver enforces", () => {
  it("names the gaps it does not cover, so an unscanned string is a decision", () => {
    expect(KNOWN_GAPS.length).toBeGreaterThan(0);
  });

  // The structural rule. Everything else in this file iterates
  // DICTIONARY_LOCALES; if that list drifts from the directories that actually
  // ship, the iteration is the thing that silently stops covering a language.
  it("guards every dictionary locale that exists, and no phantom ones", () => {
    expect(localesOnDisk).toEqual([...DICTIONARY_LOCALES].sort());
    expect(localeCoverageFaults(localesOnDisk)).toEqual([]);
    // …and a locale added tomorrow reds, rather than shipping unguarded.
    expect(localeCoverageFaults([...localesOnDisk, "de"])).toEqual([
      "de/: a dictionary locale with no entry in LOCALE_CLAIMS — its copy is scanned by nothing",
    ]);
  });

  // Anti-vacuity for the whole file: every guard below is `toEqual([])` over a
  // scan, and a scan of nothing returns []. These are the inputs.
  it("actually has copy to scan, in every locale", () => {
    for (const { locale, key, value } of [...PASS_BOUND_VALUES, ...PLUS_VALUES]) {
      expect(value, `${locale} ${key} is missing or empty`).toBeTruthy();
      expect(value.length, `${locale} ${key}`).toBeGreaterThan(20);
    }
    for (const claims of Object.values(LOCALE_CLAIMS)) {
      expect(claims.permanence.length).toBeGreaterThan(4);
      expect(claims.plusClaims.length).toBeGreaterThan(2);
      expect(claims.recurring.length).toBeGreaterThan(2);
    }
  });

  it("never sells the Event Pass as permanent, in any language, and says what bounds it", () => {
    expect(localePassBoundFaults(PASS_BOUND_VALUES)).toEqual([]);
  });

  it("carries none of the retired prose, in any locale", () => {
    expect(retiredClaimFaults(PASS_BOUND_VALUES, RETIRED_CLAIMS)).toEqual([]);
    expect(retiredClaimFaults(PLUS_VALUES, RETIRED_CLAIMS)).toEqual([]);
  });

  it("quotes the one-time credit grant at its live size, not as a recurring one", () => {
    expect(localeCreditGrantFaults(PASS_CREDIT_VALUES, PASS_CREDIT_GRANT)).toEqual([]);
  });

  // The extra-organisation rate. The CLAIM comes from four dictionaries and the
  // ARITHMETIC from the seed — different places, or the comparison proves
  // nothing. `riderClaimShape` decides which qualifier is honest today.
  it("quotes an extra-organisation rate the seed's tiers actually charge", () => {
    const shape = riderClaimShape(stripePlans.plans as unknown as PricedPlan[]);
    expect(shape, "eur/aud land on exact halves while usd is 47.4% — only 'no more than half' is true").toBe(
      "atMost",
    );
    expect(localeHalfClaimFaults(PLUS_VALUES, shape)).toEqual([]);
  });
});

describe.skipIf(!HAS_DB)("the four-locale dictionaries match plan_entitlements", () => {
  const grantsFor = async (features: string[]): Promise<FeatureGrants> => {
    const rows = await sql<{ feature_key: string; plan_key: string; bool_value: boolean | null }[]>`
      select feature_key, plan_key, bool_value from plan_entitlements
      where feature_key = any(${features})`;
    expect(rows.length, "plan_entitlements returned no rows for the differentiator features").toBeGreaterThan(0);
    const out: FeatureGrants = {};
    for (const row of rows) {
      (out[row.feature_key] ??= {})[row.plan_key] = row.bool_value === true;
    }
    return out;
  };

  const monthlyCredits = async (): Promise<Record<string, number | null>> => {
    const rows = await sql<{ plan_key: string; int_value: number | null }[]>`
      select plan_key, int_value from plan_entitlements
      where feature_key = 'ai.credits.monthly'`;
    return Object.fromEntries(rows.map((r) => [r.plan_key, r.int_value]));
  };

  // THE DEFECT THIS TASK FIXES, stated as the matrix states it. "AI-assisted
  // scheduling" was sold as the thing you get for moving up to Pro Plus while
  // `scheduling.ai` was true on every plan key including community — so the
  // differentiator was worth exactly nothing.
  it("scheduling.ai is granted on every plan, so it differentiates nothing", async () => {
    const grants = await grantsFor(["scheduling.ai"]);
    expect(grants["scheduling.ai"]).toEqual({
      community: true,
      event_pass: true,
      event_pass_l: true,
      pro: true,
      pro_plus: true,
    });
  });

  it("claims only differentiators Pro Plus actually has, in all four locales", async () => {
    const grants = await grantsFor([
      "scheduling.ai",
      "officials.auto",
      "api.write",
      "support.priority",
    ]);
    expect(localePlusDifferentiatorFaults(PLUS_VALUES, grants, ["community", "pro"])).toEqual([]);
  });

  it("the 'largest monthly AI credit grant' claim is the matrix's own ordering", async () => {
    const credits = await monthlyCredits();
    expect(credits.community).toBe(10);
    expect(credits.pro).toBe(60);
    expect(credits.pro_plus).toBe(200);
    expect(localeCreditLeadershipFaults(PLUS_VALUES, credits)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PROVING THE GUARDS — by REWORDING, in four languages, not by reverting.
//
// The dictionaries are (and must stay) correct, so every assertion above passes
// whether or not the guard covers the claim. These point the same pure functions
// at the copy a future editor — or a future TRANSLATOR — plausibly writes.
//
// Restoring the exact sentence this task removed is NOT proof. That is what let
// two guards ship green in wave 6. Every rewording below is a string that does
// not appear anywhere in the repo.
// ─────────────────────────────────────────────────────────────────────────────
describe("the dictionary guards survive a rewording, in every locale", () => {
  const v = (locale: DictionaryLocale, value: string): LocalisedValue[] => [
    { locale, key: "k", value },
  ];

  // The bound, said correctly, in each language. These are the fixtures the
  // negatives below are built on top of — if one of these ever reds, the guard
  // has started rejecting true copy.
  const BOUNDED: Record<DictionaryLocale, string> = {
    en: "One payment upgrades this competition while it's running — bigger limits and a cheaper fee.",
    es: "Un solo pago mejora esta competición mientras está en curso — límites mayores y menos comisión.",
    fr: "Un seul paiement améliore cette compétition tant qu’elle est en cours — des limites plus élevées.",
    nl: "Eén betaling upgradet deze competitie zolang ze loopt — ruimere limieten en lagere kosten.",
  };

  it("accepts a correctly bounded sentence in each language", () => {
    for (const locale of DICTIONARY_LOCALES) {
      expect(localePassBoundFaults(v(locale, BOUNDED[locale])), locale).toEqual([]);
    }
  });

  // THE POINT OF THE WHOLE TASK. Each of these is the permanence claim written
  // fresh in its own language — none of them is the sentence this task deleted.
  it("catches an unbounded pass claim in each language, reworded", () => {
    for (const [locale, reworded] of [
      ["en", "This competition is upgraded and the upgrade never expires."],
      ["en", "Buy once and the pass is yours to keep."],
      ["es", "Esta competición queda mejorada de forma indefinida."],
      ["es", "Págalo una vez y la mejora nunca caduca."],
      ["es", "La mejora es permanente para esa competición."],
      ["fr", "Cette compétition est améliorée définitivement."],
      ["fr", "Payez une fois : l’amélioration n’expire jamais."],
      ["fr", "L’amélioration est permanente pour cette compétition."],
      ["nl", "Deze competitie is voorgoed geüpgraded."],
      ["nl", "Betaal één keer; de upgrade vervalt nooit."],
      ["nl", "De upgrade is permanent voor die competitie."],
    ] as Array<[DictionaryLocale, string]>) {
      expect(localePassBoundFaults(v(locale, reworded)), `${locale}: ${reworded}`).not.toEqual([]);
    }
  });

  // Layer 2, and the failure mode the previous wave actually shipped: a
  // non-English surface rendering new ENGLISH prose. The English vocabulary must
  // fire on the Dutch value, and the French vocabulary on the Spanish one.
  it("catches one language's falsehood sitting in another language's file", () => {
    const faults = localePassBoundFaults([
      { locale: "nl", key: "k", value: `${BOUNDED.nl} Yours for the event's lifetime.` },
      { locale: "es", key: "k", value: `${BOUNDED.es} Válido à vie.` },
      { locale: "fr", key: "k", value: `${BOUNDED.fr} Válido de por vida.` },
    ]);
    expect(faults.join(" | ")).toContain("nl k: claims the pass has unbounded duration in en vocabulary");
    expect(faults.join(" | ")).toContain("es k: claims the pass has unbounded duration in fr vocabulary");
    expect(faults.join(" | ")).toContain("fr k: claims the pass has unbounded duration in es vocabulary");
  });

  // The positive half, defeated from the other side. An absence-shaped rule is
  // happiest when the claim is DELETED — leaving a buyer told nothing about when
  // the upgrade stops.
  it("catches the bound being dropped rather than contradicted", () => {
    for (const [locale, silent] of [
      ["en", "One payment upgrades this competition. Bigger limits and a cheaper fee."],
      ["es", "Un solo pago mejora esta competición. Límites mayores."],
      ["fr", "Un seul paiement améliore cette compétition. Des limites plus élevées."],
      ["nl", "Eén betaling upgradet deze competitie. Ruimere limieten."],
    ] as Array<[DictionaryLocale, string]>) {
      expect(localePassBoundFaults(v(locale, silent)), `${locale}: ${silent}`).toEqual([
        `${locale} k: never states, in ${locale}, that the pass is bounded to a running competition`,
      ]);
    }
    // …and an emptied key is a fault, never a clean scan.
    expect(localePassBoundFaults(v("en", "  "))).toEqual([
      "en k: empty — nothing to scan, so every rule below passes vacuously",
    ]);
  });

  // "Active" with no limiting conjunction is a claim of immediate start and NO
  // end. It must not satisfy a rule meant to assert a bound — the same defeat
  // `BOUNDED_SCOPE_GRAMMAR` was hardened against for the seed, re-proved in each
  // language because each has its own grammar for it.
  it("is not satisfied by a bare activity word without its conjunction", () => {
    for (const [locale, bare] of [
      ["en", "This competition is upgraded — active immediately, with bigger limits."],
      ["es", "Esta competición está mejorada — activa de inmediato, con límites mayores."],
      ["fr", "Cette compétition est améliorée — active immédiatement, limites plus élevées."],
      ["nl", "Deze competitie is geüpgraded — direct actief, met ruimere limieten."],
    ] as Array<[DictionaryLocale, string]>) {
      expect(localePassBoundFaults(v(locale, bare)), `${locale}: ${bare}`).not.toEqual([]);
    }
  });

  // Layer 3 on its own, including the two fragments the vocabularies cannot
  // hold without rejecting true prose.
  it("catches a retired literal restored in any single locale", () => {
    expect(
      retiredClaimFaults(v("fr", "Une compétition, pour toute sa durée."), RETIRED_CLAIMS),
    ).toEqual(['fr k: still carries the retired claim "pour toute sa durée"']);
    expect(
      retiredClaimFaults(v("nl", "elke extra organisatie voor de helft van het basistarief"), RETIRED_CLAIMS),
    ).toEqual(['nl k: still carries the retired claim "organisatie voor de helft van het basistarief"']);
    // …and the qualified Dutch sentence this task shipped is NOT a hit.
    expect(
      retiredClaimFaults(
        v("nl", "elke extra organisatie voor hoogstens de helft van het basistarief"),
        RETIRED_CLAIMS,
      ),
    ).toEqual([]);
    // An empty registry would make this layer examine nothing.
    expect(retiredClaimFaults(v("en", "anything"), [])).toEqual([
      "retired-claim registry is empty — this layer would examine nothing",
    ]);
  });

  it("catches a drifted, missing or recurring credit grant, in each language", () => {
    for (const locale of DICTIONARY_LOCALES) {
      expect(
        localeCreditGrantFaults(v(locale, `los mismos +${PASS_CREDIT_GRANT} AI credits`), PASS_CREDIT_GRANT),
        locale,
      ).toEqual([]);
    }
    // A rung-keyed grant is the drift this guards against: the grant is FLAT,
    // and never reads the pass key.
    expect(localeCreditGrantFaults(v("en", "the same one-time +50 AI credits"), PASS_CREDIT_GRANT)).toEqual(
      [
        `en k: does not state the one-time +${PASS_CREDIT_GRANT} AI credit grant`,
        `en k: quotes +50, but the pass grants +${PASS_CREDIT_GRANT}`,
      ],
    );
    // Deletion.
    expect(
      localeCreditGrantFaults(v("en", "advanced formats, exports and realtime"), PASS_CREDIT_GRANT),
    ).toEqual([`en k: does not state the one-time +${PASS_CREDIT_GRANT} AI credit grant`]);
    // The inverse claim — right number, wrong cadence — in each language.
    for (const [locale, recurring] of [
      ["en", "+25 AI credits every month"],
      ["es", "+25 créditos de IA al mes"],
      ["fr", "+25 crédits IA par mois"],
      ["nl", "+25 AI-credits per maand"],
    ] as Array<[DictionaryLocale, string]>) {
      expect(
        localeCreditGrantFaults(v(locale, recurring), PASS_CREDIT_GRANT).join(" "),
        `${locale}: ${recurring}`,
      ).toContain("sells the one-time grant as recurring");
    }
  });

  // ── The Pro Plus differentiators ───────────────────────────────────────────

  const SHARED = { community: true, pro: true, pro_plus: true };
  const PLUS_ONLY = { community: false, pro: false, pro_plus: true };
  const LIVE_GRANTS: FeatureGrants = {
    "scheduling.ai": SHARED,
    "officials.auto": PLUS_ONLY,
    "api.write": PLUS_ONLY,
    "support.priority": PLUS_ONLY,
  };

  it("catches the AI-scheduling claim in each language, however it is phrased", () => {
    for (const [locale, reworded] of [
      ["en", "Everything in Pro, plus AI-powered scheduling and priority support."],
      ["en", "Everything in Pro, plus scheduling with AI built in, and priority support."],
      ["es", "Todo lo de Pro, más programación con IA y soporte prioritario."],
      ["es", "Todo lo de Pro, más IA para la planificación y soporte prioritario."],
      ["fr", "Tout ce qu’offre Pro, plus une planification par IA et une assistance prioritaire."],
      ["fr", "Tout ce qu’offre Pro, plus l’IA de planification et une assistance prioritaire."],
      ["nl", "Alles van Pro, plus AI-gestuurde planning en prioritaire ondersteuning."],
      ["nl", "Alles van Pro, plus planning met AI en prioritaire ondersteuning."],
    ] as Array<[DictionaryLocale, string]>) {
      expect(
        localePlusDifferentiatorFaults(v(locale, reworded), LIVE_GRANTS, ["community", "pro"]).join(" "),
        `${locale}: ${reworded}`,
      ).toContain("sells scheduling.ai as a Pro Plus differentiator");
    }
  });

  // THE NEGATIVE CASE. A rule that fired unconditionally would satisfy every
  // stated requirement of this task — and be wrong the day the matrix moved.
  // If `scheduling.ai` became pro_plus-only the claim becomes TRUE, and this
  // guard must fall silent rather than keep banning a phrase.
  it("stops objecting to AI scheduling if the matrix ever makes it plus-only", () => {
    const plusOnlyAi: FeatureGrants = { ...LIVE_GRANTS, "scheduling.ai": PLUS_ONLY };
    expect(
      localePlusDifferentiatorFaults(
        v("en", "Everything in Pro, plus AI-assisted scheduling and priority support."),
        plusOnlyAi,
        ["community", "pro"],
      ),
    ).toEqual([]);
    // …and the mirror: a claim Pro Plus does NOT grant is a fault even when no
    // lower plan grants it either.
    expect(
      localePlusDifferentiatorFaults(v("en", "Everything in Pro, plus write API access."), {
        "api.write": { community: false, pro: false, pro_plus: false },
      }, ["community", "pro"]).join(" "),
    ).toContain("claims api.write, but pro_plus does not grant it");
  });

  // Anti-vacuity: an answer phrased entirely outside the vocabulary would have
  // this guard examine NOTHING and report clean — the exact shape that let a
  // wave-6 guard ship green.
  it("reds when it recognises no differentiator at all", () => {
    for (const locale of DICTIONARY_LOCALES) {
      expect(
        localePlusDifferentiatorFaults(v(locale, "Everything in Pro, plus more."), LIVE_GRANTS, [
          "community",
          "pro",
        ]),
        locale,
      ).toEqual([
        `${locale} k: names no recognised differentiator — the ${locale} vocabulary has gone stale and this guard examined nothing`,
      ]);
    }
  });

  it("judges the credit-leadership claim against the numbers, both ways", () => {
    const live = { community: 10, pro: 60, pro_plus: 200 };
    for (const [locale, honest] of [
      ["en", "plus the largest monthly AI credit grant"],
      ["es", "más la mayor asignación mensual de créditos de IA"],
      ["fr", "plus la plus grosse dotation mensuelle de crédits IA"],
      ["nl", "plus de grootste maandelijkse AI-credittoekenning"],
    ] as Array<[DictionaryLocale, string]>) {
      expect(localeCreditLeadershipFaults(v(locale, honest), live), locale).toEqual([]);
      // The claim stated while the matrix contradicts it.
      expect(
        localeCreditLeadershipFaults(v(locale, honest), { ...live, pro: 500 }).join(" "),
        locale,
      ).toContain("but pro_plus grants 200");
    }
    // Deletion: dropping the replacement differentiator entirely.
    expect(localeCreditLeadershipFaults(v("en", "plus priority support"), live)).toEqual([
      "en k: never claims the largest monthly AI credit grant",
    ]);
  });

  // ── The extra-organisation rate ────────────────────────────────────────────

  it("catches a bare 'half the base rate' in each language", () => {
    for (const [locale, bare, qualified] of [
      ["en", "each extra one at half the base rate", "each extra one at no more than half the base rate"],
      [
        "es",
        "cada una adicional a mitad de la tarifa base",
        "cada una adicional por no más de la mitad de la tarifa base",
      ],
      [
        "fr",
        "chaque organisation supplémentaire à moitié du tarif de base",
        "chaque organisation supplémentaire pour au plus la moitié du tarif de base",
      ],
      [
        "nl",
        "elke extra organisatie voor de helft van het basistarief",
        "elke extra organisatie voor hoogstens de helft van het basistarief",
      ],
    ] as Array<[DictionaryLocale, string, string]>) {
      expect(localeHalfClaimFaults(v(locale, bare), "atMost").join(" "), `${locale} bare`).toContain(
        'quotes half the base rate with no "no more than" qualifier',
      );
      expect(localeHalfClaimFaults(v(locale, qualified), "atMost"), `${locale} qualified`).toEqual([]);
      // Deletion: an answer that simply stops saying what a second org costs.
      expect(localeHalfClaimFaults(v(locale, "Pro Plus cubre hasta 10."), "atMost")).toEqual([
        `${locale} k: makes no statement about the extra-organisation rate`,
      ]);
    }
  });

  // THE OTHER NEGATIVE CASE. "no more than half" is required because the seed's
  // riders are not all exact halves. If a price move made them all exact, a bare
  // "half" would become true and this guard must stop demanding the qualifier.
  it("stops demanding the qualifier if every rider becomes an exact half", () => {
    expect(localeHalfClaimFaults(v("en", "each extra one at half the base rate"), "exactly")).toEqual([]);
    // …and `riderClaimShape` is what decides that, from the seed, not a constant.
    const exact: PricedPlan[] = [
      {
        key: "x",
        product: { description: "" },
        prices: {
          monthly: {
            lookup_key: "x_monthly",
            unit_amount: 2000,
            tiers: [
              { up_to: 1, unit_amount: 2000, currency_options: { eur: 2000, gbp: 2000, inr: 2000, aud: 2000 } },
              { up_to: "inf", unit_amount: 1000, currency_options: { eur: 1000, gbp: 1000, inr: 1000, aud: 1000 } },
            ],
          },
        },
      },
    ];
    expect(riderClaimShape(exact)).toBe("exactly");
    // One odd currency is enough to make a bare "half" false again.
    exact[0]!.prices.monthly!.tiers![1]!.currency_options!.inr = 999;
    expect(riderClaimShape(exact)).toBe("atMost");
  });
});
