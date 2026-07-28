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
import * as copyTruth from "@/lib/copy-truth";
import {
  DICTIONARY_LOCALES,
  type DictionaryLocale,
  type FeatureGrants,
  LOCALE_CLAIMS,
  type LocalisedValue,
  type PricedPlan,
  collectPatterns,
  controlCharacterFaults,
  inertPatternFaults,
  riderRateFaults,
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
/**
 * THE KEY AXIS IS AN INVENTORY, PINNED. Fix round 1 added
 * `pricing.faq.upgraded.a`, which sat on the SAME PAGE saying "passes never
 * expire" while the key two cards above it had already been corrected — and it
 * was invisible because deleting a key from this list left the suite green
 * while deleting a *locale* correctly reds. An axis that is not asserted is not
 * covered, and the asymmetry is what hid a live falsehood for a whole round.
 */
const PASS_BOUND_KEYS = [
  ["marketing", "pricing.pass.note"],
  ["marketing", "pricing.faq.eventPass.a"],
  ["marketing", "pricing.faq.upgraded.a"],
  ["ui", "upgrade.intro"],
  ["ui", "upgrade.active.body"],
  ["ui", "billing.passOffer.note"],
] as const;

const PASS_BOUND_VALUES: LocalisedValue[] = PASS_BOUND_KEYS.flatMap(([file, key]) =>
  across(file, key),
);

/**
 * Every `pricing.faq.*.a` answer, classified. The /pricing FAQ is where the
 * missed key lived, so the question "which answers make a pass-duration claim"
 * is answered as DATA, computed from the dictionary — a NEW faq key reds this
 * suite until someone decides which side it falls on.
 *
 * A blanket permanence scan over all FAQ answers is the wrong tool and was
 * measured as such: `pricing.faq.card.a` truthfully says Community is "free
 * forever", and a repo-wide sweep found 18 keys with permanence hits of which
 * 17 are TRUE claims about other subjects (permanent deletion, credit packs
 * that genuinely never expire, the Community plan). Scoping is not laziness
 * here; it is the only way the rule stays honest.
 */
const FAQ_PASS_SCOPED = ["pricing.faq.eventPass.a", "pricing.faq.upgraded.a"];
const FAQ_EXEMPT: Record<string, string> = {
  "pricing.faq.card.a": "about payment details; its 'free forever' is Community's, and true",
  "pricing.faq.trialEnd.a": "about the trial ending; makes no pass-duration claim",
  "pricing.faq.fees.a": "about the fee ladder; a rate claim, guarded by the help-tree fee-lock rules",
  "pricing.faq.groups.a": "about billing groups",
  "pricing.faq.currencies.a": "about currency pinning",
  "pricing.faq.annual.a": "about annual billing",
  "pricing.faq.cancel.a": "about cancelling Pro; no pass claim",
  "pricing.faq.proPlus.a": "scanned, but for differentiators and the rider rate — not pass permanence",
};

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
  // Fix round 1 — `pricing.faq.upgraded.a`. Two claims per locale: the
  // permanence one, and the "Pro covers everything the pass does" over-claim,
  // which is false for the L rung (event_pass_l allows unlimited entrants per
  // division; pro allows 256).
  "passes never expire",
  "covers everything the pass does",
  "nunca caducan",
  "cubre todo lo que hace el pase",
  "expirent jamais",
  "couvre tout ce que fait le pass",
  "verlopen nooit",
  "dekt alles wat de pass doet",
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

const BOUNDED: Record<DictionaryLocale, string> = {
  en: "One payment upgrades this competition while it's running — bigger limits and a cheaper fee.",
  es: "Un solo pago mejora esta competición mientras está en curso — límites mayores y menos comisión.",
  fr: "Un seul paiement améliore cette compétition tant qu’elle est en cours — des limites plus élevées.",
  nl: "Eén betaling upgradet deze competitie zolang ze loopt — ruimere limieten en lagere kosten.",
};

const REWORDINGS: Record<DictionaryLocale, string[]> = {
  en: [
    "The upgrade never expires.",
    "Passes never expire.",
    "The pass does not expire.",
    "These passes don't expire.",
    "It is yours for life.",
    "The upgrade runs in perpetuity.",
    "There is no end date.",
    "The pass never runs out.",
    "It will not lapse.",
    "The upgrade stays yours.",
    "Bought once, it is yours to keep.",
    "The pass is permanent.",
    "It lasts forever.",
    "The upgrade holds for good.",
    "It never stops.",
    "The pass lasts indefinitely.",
  ],
  es: [
    "La mejora nunca caduca.",
    "Los pases nunca caducan.",
    "El pase no caduca.",
    "Los pases no caducan.",
    "Las mejoras nunca expiran.",
    "El pase nunca vence.",
    "Los pases nunca vencen.",
    "Es tuyo de por vida.",
    "La mejora es permanente.",
    "Las mejoras son permanentes.",
    "El pase dura indefinidamente.",
    "Sin fecha de caducidad.",
    "Sin vencimiento.",
    "La mejora se conserva para siempre.",
    "El pase se mantiene de forma indefinida.",
    "Los pases caducan nunca.",
  ],
  fr: [
    "L'amélioration n'expire jamais.",
    "Les pass n'expirent jamais.",
    "Le pass n'expire pas.",
    "Les pass expirent jamais.",
    "L'amélioration ne se termine jamais.",
    "Les améliorations ne se terminent jamais.",
    "C'est à vous à vie.",
    "L'amélioration est permanente.",
    "Les pass sont permanents.",
    "Le pass dure indéfiniment.",
    "Sans date d'expiration.",
    "Sans échéance.",
    "L'amélioration vaut pour toujours.",
    "Le pass est acquis définitivement.",
    "Sans limite de durée.",
    "Le pass tient pour de bon.",
  ],
  nl: [
    "De upgrade verloopt nooit.",
    "Passes verlopen nooit.",
    "De pass vervalt nooit.",
    "Passes vervallen nooit.",
    "De upgrade eindigt nooit.",
    "De pass stopt nooit.",
    "Het is voorgoed van jou.",
    "De upgrade is permanent.",
    "De passes zijn permanent.",
    "Geen vervaldatum.",
    "Geen einddatum.",
    "De pass is onbeperkt geldig.",
    "De upgrade geldt voor onbepaalde tijd.",
    "De pass blijft altijd geldig.",
    "Het blijft eeuwig staan.",
    "De pass verloopt niet.",
  ],
};

const ADVERSARIAL: Record<DictionaryLocale, string[]> = {
  en: [
    "The pass has no end.",
    "Once bought, it is yours for the rest of time.",
    "The upgrade carries on without limit.",
    "There is no cut-off.",
    "It sticks around no matter what.",
    "The pass endures.",
    "You keep it always.",
    "It remains in force whatever happens.",
  ],
  es: [
    "El pase no tiene fin.",
    "No hay fecha límite.",
    "La mejora perdura.",
    "El pase te acompaña siempre.",
    "El pase sigue activo siempre.",
    "Lo conservas sin límite de tiempo.",
    "La mejora queda ahí para el resto del tiempo.",
    "El pase permanece.",
  ],
  fr: [
    "Le pass ne prend jamais fin.",
    "Aucune date limite.",
    "Le pass demeure valable.",
    "Une fois acheté, c’est pour la vie.",
    "L’amélioration subsiste.",
    "Vous le gardez toujours.",
    "Le pass tient sans limite de durée.",
    "Il n’y a pas de terme.",
  ],
  nl: [
    "De pass kent geen einde.",
    "De pass blijft bestaan.",
    "De pass houdt niet op.",
    "Je houdt hem altijd.",
    "Er is geen afkapdatum.",
    "De upgrade blijft staan wat er ook gebeurt.",
    "De pass duurt onbeperkt.",
    "Het blijft je hele leven gelden.",
  ],
};

/**
 * The known-positive corpus for the module-wide anti-vacuity check.
 *
 * Every exported pattern in `@/lib/copy-truth` must match at least one line
 * here. It is assembled from the fixture sets this suite already maintains plus
 * a supplementary list for the rules owned by tasks 1 and 3 (the Stripe seed and
 * the help tree), so the check covers the WHOLE module — the point being that a
 * pattern which can never fire is invisible to the suite that owns it, as this
 * wave has now demonstrated twice.
 *
 * Adding a pattern therefore means adding a string it matches. That is the
 * cheapest possible proof that it does something, and it is enforced in both
 * directions: an unused fixture is a fault too.
 */
const KNOWN_POSITIVES: string[] = [
  ...Object.values(REWORDINGS).flat(),
  ...Object.values(ADVERSARIAL).flat(),
  ...Object.values(BOUNDED),
  // ── The bound, in each language, and the activity words it can govern ──
  "the pass applies while the competition is open",
  "valid until the competition is live",
  "during the event the pass runs",
  "for as long as the competition is under way",
  "el pase se aplica mientras la competición está activa",
  "válido hasta que la competición esté abierta",
  "mientras dure la competición",
  "durante el tiempo que la competición esté en marcha",
  "mientras se juegue la competición",
  "hasta que dura la competición",
  "le pass s'applique tant que la compétition est ouverte",
  "pendant que la compétition est active",
  "jusqu'à ce que la compétition se déroule",
  "aussi longtemps que la compétition dure",
  "de pass geldt zolang de competitie actief is",
  "terwijl de competitie open is",
  "totdat de competitie bezig is",
  "tot de competitie draait",
  "zolang de competitie duurt",
  // ── Retired AI-run cap (task 1/3) ──
  "10 AI schedule runs per division",
  "three runs a division",
  "an allowance of AI schedule runs for each division",
  "a monthly quota of AI schedule generations per division",
  "per-division AI schedule runs",
  "each division gets its own AI schedule generations",
  "every competition comes with its own allowance of scheduling runs",
  "5 AI runs",
  "two schedule runs",
  // ── Pro Plus differentiators, four languages ──
  "AI-assisted scheduling",
  "scheduling powered by AI",
  "auto officials assignment",
  "officials assigned automatically",
  "write API access",
  "priority support",
  "the largest monthly AI credit grant",
  "programación asistida por IA",
  "IA para la planificación",
  "asignación automática de árbitros",
  "los árbitros se asignan automáticamente",
  "acceso de escritura a la API",
  "la API con permisos de escritura",
  "soporte prioritario",
  "la mayor asignación mensual de créditos de IA",
  "une planification assistée par IA",
  "l'IA de planification",
  "attribution automatique des officiels",
  "les officiels sont assignés de façon automatique",
  "accès API en écriture",
  "l'écriture via API",
  "assistance prioritaire",
  "la plus grosse dotation mensuelle de crédits IA",
  "AI-ondersteunde planning",
  "planning met AI",
  "automatische toewijzing van officials",
  "officials automatische toewijzing",
  "schrijftoegang tot de API",
  "de API schrijftoegang",
  "prioritaire ondersteuning",
  "de grootste maandelijkse AI-credittoekenning",
  // ── The rider rate, four languages ──
  "each extra one at half the base rate",
  "at no more than half the base rate",
  "half your plan's rate",
  "cada una adicional a mitad de la tarifa base",
  "a mitad de precio",
  "por no más de la mitad de la tarifa base",
  "à moitié du tarif de base",
  "à moitié prix",
  "pour au plus la moitié du tarif de base",
  "voor de helft van het basistarief",
  "tegen halve prijs",
  "voor hoogstens de helft van het basistarief",
  // ── Recurring cadence (the inverse of the one-time grant) ──
  "25 AI credits monthly",
  "credits every month",
  "credits each month",
  "credits per month",
  "25 credits a month",
  "a recurring top-up",
  "créditos mensuales",
  "créditos al mes",
  "créditos cada mes",
  "créditos por mes",
  "un abono recurrente",
  "des crédits mensuels",
  "des crédits par mois",
  "des crédits chaque mois",
  "un crédit récurrent",
  "maandelijkse credits",
  "credits per maand",
  "elke maand credits",
  "iedere maand credits",
  "een terugkerende bijboeking",
  // ── The V312 fee lock and its reversion claim (task 3) ──
  "the platform fee returns to your plan's rate",
  "the fee reverts to whatever your plan charges",
  "Community's 8% applies again to every later entrant",
  "the rate goes back to 8%",
  "the fee will rise once the event closes",
  "the 5% resets to the plan rate",
  "the fee rate moves to your plan's own rate",
  "the fee went back up",
  "the entry-fee rate drops back to the plan rate",
  "the fee falls back to your plan's rate",
  "the rate switches back after the pass ends",
  "the fee climbs to Community's rate",
  "the fee jumps to 8%",
  "the platform fee is restored to your plan's rate",
  "Once a competition has taken its first paid entry the platform fee it charges is locked for the rest of that competition.",
  "the fee is fixed after the first paid entry",
  "the rate is frozen once you have taken a paid registration",
  "the fee is pinned at the first paid entrant",
  "the rate stays at 5% after the first paid payment",
  "the fee does not rise once the competition has had its first paid entry",
  "the fee does not change after the first paid entry",
  "the fee does not move once the first paid entry lands",
  "a competition that never took a paid entrant keeps its plan rate",
  "no paid entry means the rate still follows your plan",
  "the competition has already taken a paid registration, so its fee is locked",
  "it took its first paid entry last week and the rate is locked",
  "the competition had a paid entry, so the fee is fixed",
  "the competition has had a paid registration and the rate is frozen",
  // ── The permanence claim about a RATE, which is TRUE and must be matchable ──
  "that 5% rate is locked for good",
  "esa comisión queda fijada permanentemente",
  "ce taux est verrouillé définitivement",
  "dat tarief staat permanent vast",
  // ── Fee ladder rows ──
  "| Community | 8% |",
  // ── Permanence vocabulary whose exemplars this wave DELETED from the copy ──
  //
  // These are the reason the corpus exists rather than being derived from the
  // shipped strings: a pattern written to catch a falsehood has, by the time the
  // fix lands, nothing left in the repo to match. Without a fixture it becomes
  // indistinguishable from a pattern that never worked.
  "yours for the event's lifetime",
  "the pass has no expiry",
  "there is no time limit",
  "keep it as long as you want",
  "it keeps working after the competition ends",
  "the upgrade never switches off",
  "no limit on how long it lasts",
  "the upgrade holds without end",
  "tuyo durante toda la vida del evento",
  "el pase vale por tiempo indefinido",
  "el pase es siempre tuyo",
  "el pase es tuyo para siempre",
  "la mejora sigue siendo tuya",
  "un pase sin fin",
  "el pase sigue vigente",
  "le pass est à vous à jamais",
  "le pass vaut de manière permanente",
  "un pass à durée illimitée",
  "le pass ne se termine jamais",
  "le pass reste valable à vie",
  "aucune limite de durée",
  "un pass sans fin",
  "van jou voor de hele levensduur van het evenement",
  "de pass geldt voor het hele verloop",
  "de pass is voor altijd van jou",
  "de pass verloopt nooit meer",
  "de pass gaat nooit verlopen",
  "de upgrade is altijd van jou",
  "een pass zonder einde",
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

  // THE KEY AXIS, asserted the way the locale axis already was. Deleting a key
  // from PASS_BOUND_KEYS must red — before fix round 1 it did not, and that is
  // precisely how `pricing.faq.upgraded.a` stayed invisible.
  it("scans every key it claims to, so dropping one reds", () => {
    expect(PASS_BOUND_VALUES).toHaveLength(PASS_BOUND_KEYS.length * DICTIONARY_LOCALES.length);
    expect([...new Set(PASS_BOUND_VALUES.map((v) => v.key))].sort()).toEqual(
      [...new Set(PASS_BOUND_KEYS.map(([, k]) => k))].sort(),
    );
    expect(PASS_BOUND_KEYS.length).toBeGreaterThanOrEqual(6);
  });

  // …and the discovery rule that would have caught it: every FAQ answer on the
  // pricing page is either pass-scoped or exempt WITH A REASON. A new one is a
  // decision, not an omission.
  it("classifies every pricing FAQ answer as pass-scoped or exempt", () => {
    const en = load("en", "marketing");
    const answers = Object.keys(en)
      .filter((k) => /^pricing\.faq\..+\.a$/.test(k))
      .sort();
    expect(answers.length, "no FAQ answers found — the key shape changed").toBeGreaterThan(5);
    expect(answers).toEqual([...FAQ_PASS_SCOPED, ...Object.keys(FAQ_EXEMPT)].sort());
    // Every pass-scoped FAQ answer must actually be in the guarded set.
    for (const key of FAQ_PASS_SCOPED) {
      expect(PASS_BOUND_KEYS.some(([, k]) => k === key), `${key} classified pass-scoped but unguarded`).toBe(true);
    }
    // …and no exemption may be blank, so "exempt" always carries a why.
    for (const [key, why] of Object.entries(FAQ_EXEMPT)) {
      expect(why.length, `${key} has an empty exemption reason`).toBeGreaterThan(10);
    }
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

  it("accepts a correctly bounded sentence in each language", () => {
    for (const locale of DICTIONARY_LOCALES) {
      expect(localePassBoundFaults(v(locale, BOUNDED[locale])), locale).toEqual([]);
    }
  });

  // ── DETECTION RATE, MEASURED ───────────────────────────────────────────────
  //
  // Fix round 1's central finding: the es/fr/nl vocabularies were
  // SINGULAR-VERB-ONLY, so the architecture above was carrying nothing. Review
  // measured 2 of 16 rewordings detected, with fr and nl at ZERO.
  //
  // This is the measurement itself, committed. Each fixture is the permanence
  // claim appended to that locale's CORRECT bounded sentence, so the value
  // still satisfies the positive rule and ONLY the vocabulary can catch it —
  // the "keep the true copy, add the false claim" shape, which is how a
  // translator actually reintroduces one. None of these strings is the retired
  // literal, and the list deliberately includes inflections, tenses and
  // periphrases the rules were not written against one-for-one.

  it("detects the permanence claim in EVERY locale, at a measured rate", () => {
    const scores: string[] = [];
    for (const locale of DICTIONARY_LOCALES) {
      const fixtures = REWORDINGS[locale];
      const missed = fixtures.filter(
        (reworded) => localePassBoundFaults(v(locale, `${BOUNDED[locale]} ${reworded}`)).length === 0,
      );
      scores.push(`${locale} ${fixtures.length - missed.length}/${fixtures.length}`);
      expect(missed, `${locale} missed: ${missed.join(" | ")}`).toEqual([]);
    }
    // Recorded so a regression reads as a number, not a boolean.
    expect(scores).toEqual(["en 16/16", "es 16/16", "fr 16/16", "nl 16/16"]);
  });

  /**
   * …and the honest version of the same measurement.
   *
   * The fixtures above were written alongside the rules, so 16/16 partly
   * measures my own memory. THESE were written to defeat them: permanence
   * claims phrased the way a speaker phrases them, deliberately avoiding the
   * verb stems and adverbials the vocabulary enumerates. On the first run of
   * fix round 1's rebuilt vocabulary they scored **0/32 — including 0/8 in
   * English**, which is what a word-list buys you: it catches the words in it.
   *
   * What closed the gap was not more words but three CLAIM FAMILIES — absence
   * of an end, endurance verbs, and "always" bound to a retention word. Those
   * generalise; "caduca" does not.
   */

  it("detects permanence claims written to DEFEAT the vocabulary, not to match it", () => {
    const scores: string[] = [];
    for (const locale of DICTIONARY_LOCALES) {
      const fixtures = ADVERSARIAL[locale];
      const missed = fixtures.filter(
        (reworded) => localePassBoundFaults(v(locale, `${BOUNDED[locale]} ${reworded}`)).length === 0,
      );
      scores.push(`${locale} ${fixtures.length - missed.length}/${fixtures.length}`);
      expect(missed, `${locale} missed: ${missed.join(" | ")}`).toEqual([]);
    }
    expect(scores).toEqual(["en 8/8", "es 8/8", "fr 8/8", "nl 8/8"]);
  });

  /**
   * The other direction, and the reason the no-limit family is scoped to TIME.
   *
   * A bare "limit" noun is about whatever it limits. The first cut of the
   * family banned "aucune limite", which reds French `pricing.faq.eventPass.a`
   * — "sans aucune limite de participants" is a TRUE statement of the L rung's
   * unlimited entrant cap (measured; it was the only false positive across all
   * twenty-four shipped values). A guard that rejects true prose teaches its
   * next editor to route around it.
   */
  it("does not read an unlimited ENTRANT cap as an unlimited DURATION", () => {
    for (const [locale, honest] of [
      ["en", "the L pass takes it to 20 divisions and no entrant limit at all"],
      ["es", "el pase L lleva la misma competición a 20 divisiones y sin ningún límite de participantes"],
      ["fr", "le pass L porte la même compétition à 20 divisions et sans aucune limite de participants"],
      ["nl", "de L-pass tilt dezelfde competitie naar 20 divisies en helemaal geen deelnemerslimiet"],
    ] as Array<[DictionaryLocale, string]>) {
      expect(
        localePassBoundFaults(v(locale, `${BOUNDED[locale]} ${honest}`)),
        `${locale}: ${honest}`,
      ).toEqual([]);
    }
  });

  /**
   * "THE PASS NEVER ENDS" IS FALSE; "THE LOCKED RATE NEVER CHANGES" IS TRUE.
   *
   * The permanence vocabulary contains `for good`, `permanentemente`,
   * `définitivement` and `permanent` — all of which are legitimate ways to say
   * the V312 fee lock holds. Task 3 has just rewritten the fee-lock prose, so
   * without a subject test this fires on true copy the moment that wording
   * reaches a guarded value.
   */
  it("allows a permanence claim about the LOCKED RATE, whose subject is not the pass", () => {
    for (const [locale, rateClause] of [
      ["en", "once the first paid entry lands, that 5% rate is locked for good"],
      ["es", "tras la primera inscripción de pago, esa comisión del 5% queda fijada permanentemente"],
      ["fr", "dès la première inscription payante, ce taux de 5 % est verrouillé définitivement"],
      ["nl", "na de eerste betaalde inschrijving staat dat tarief van 5% permanent vast"],
    ] as Array<[DictionaryLocale, string]>) {
      expect(
        localePassBoundFaults(v(locale, `${BOUNDED[locale]} — ${rateClause}.`)),
        `${locale}: ${rateClause}`,
      ).toEqual([]);
    }
  });

  // …and the exemption is not a hiding place: a clause that names the RATE but
  // also names the PASS is still scanned, so "a 5% fee, and the pass lasts
  // forever" cannot smuggle the falsehood in behind a percentage.
  it("still reds when a rate clause also makes the claim about the pass", () => {
    expect(
      localePassBoundFaults(
        v("en", `${BOUNDED.en} — the 5% platform fee applies and the pass lasts forever.`),
      ).join(" "),
    ).toContain("unbounded duration");
    expect(
      localePassBoundFaults(v("fr", `${BOUNDED.fr} — ce taux de 5 % et le pass sont permanents.`)).join(
        " ",
      ),
    ).toContain("unbounded duration");
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

  // WRONG-CLAUSE SATISFACTION, the third occurrence of that defect in this
  // wave. The rule was value-scoped, so a bare "half the base rate" appended to
  // a corrected value stayed green: `atMostHalf` was satisfied by the EARLIER,
  // correct clause. A qualifier in another clause qualifies nothing.
  it("requires the qualifier in the clause that makes the claim, not merely somewhere", () => {
    const corrected = "Pro Plus covers up to 10, each extra one at no more than half the base rate";
    expect(localeHalfClaimFaults(v("en", corrected), "atMost"), "the corrected value").toEqual([]);
    // …and the same value with a second, unqualified claim appended.
    expect(
      localeHalfClaimFaults(
        v("en", `${corrected}. Extra organisations are billed at half the base rate.`),
        "atMost",
      ).join(" "),
      "an unqualified second clause must not be covered by the first",
    ).toContain('quotes half the base rate with no "no more than" qualifier');
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

  // `riderClaimShape` and `riderRateFaults` compute the same thing two ways and
  // were unpinned to each other. They must agree: whenever the shape is
  // "atMost", a description claiming a bare "half the base rate" has to be a
  // fault by the seed guard too, or the dictionary rule and the Stripe rule are
  // enforcing different arithmetic on the same number.
  it("agrees with the seed guard about what the riders actually charge", () => {
    const plans = stripePlans.plans as unknown as PricedPlan[];
    const shape = riderClaimShape(plans);
    const bare = plans.map((p) => ({
      ...p,
      product: { description: "Extra organisations are billed at half the base rate." },
    }));
    const qualified = plans.map((p) => ({
      ...p,
      product: { description: "Extra organisations are billed at no more than half the base rate." },
    }));
    if (shape === "atMost") {
      expect(riderRateFaults(bare), "shape says atMost, so a bare 'half' must fault").not.toEqual([]);
      expect(riderRateFaults(qualified), "…and the qualified claim must not").toEqual([]);
    } else {
      expect(riderRateFaults(bare), "shape says exactly, so a bare 'half' is true").toEqual([]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MODULE-WIDE ANTI-VACUITY.
//
// Twice in this wave a guard has passed while examining nothing: the French
// permanence list could not match its own language (ASCII `\b`), and task 3's
// `DURATION_CLAIM` matched NOTHING AT ALL after a stray control character
// replaced a `\b` — with the suite green both times, carried by sibling rules.
//
// A pattern that compiles but can never fire makes every assertion resting on
// it report clean, so this check belongs to the whole module rather than to the
// rule that happened to break. It walks every exported RegExp — including ones
// nested in arrays, in LOCALE_CLAIMS, and in [feature, RegExp] tuples — and
// demands each one fire on something.
// ─────────────────────────────────────────────────────────────────────────────
describe("every pattern in @/lib/copy-truth does something", () => {
  const patterns = collectPatterns(copyTruth as unknown as Record<string, unknown>);

  it("finds patterns everywhere they are declared, not just at the top level", () => {
    expect(patterns.length, "the walk found almost nothing — its shape assumption broke").toBeGreaterThan(
      80,
    );
    // Proof the walk actually descends: these three live at three different
    // depths (bare export, array element, and inside a tuple in a record).
    const paths = patterns.map((p) => p.path);
    expect(paths).toContain("BOUNDED_SCOPE_GRAMMAR");
    expect(paths.some((p) => /^FALSE_PASS_PERMANENCE_PATTERNS\[\d+\]$/.test(p))).toBe(true);
    expect(paths.some((p) => /^LOCALE_CLAIMS\.fr\.plusClaims\[\d+\]\[1\]$/.test(p))).toBe(true);
  });

  // Defect 2's signature: a mangled escape leaves a raw control character in the
  // source, and the pattern quietly stops matching.
  it("contains no control character in any pattern source", () => {
    expect(controlCharacterFaults(patterns)).toEqual([]);
  });

  // Defect 1's signature: a pattern that cannot fire. Every pattern must match
  // at least one line of the corpus — so adding a pattern means adding a string
  // it matches, which is the cheapest possible proof that it does something.
  it("fires on at least one known-positive fixture, every one of them", () => {
    expect(inertPatternFaults(patterns, KNOWN_POSITIVES)).toEqual([]);
  });

  // …and the corpus itself must not rot into a list nothing reads: if a fixture
  // matches no pattern at all, it is dead weight that hides the next gap.
  it("keeps no fixture that no pattern matches", () => {
    const unused = KNOWN_POSITIVES.filter((text) => !patterns.some(({ pattern }) => pattern.test(text)));
    expect(unused, "corpus lines matched by nothing").toEqual([]);
  });
});
