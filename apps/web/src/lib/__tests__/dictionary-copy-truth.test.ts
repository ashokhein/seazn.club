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
import { passPrice, proPrice } from "@/lib/currency";
import { TIPS } from "@/config/tips";
import * as copyTruth from "@/lib/copy-truth";
import { APPROVED_DICTIONARY_COPY } from "./_approved-dictionary-copy";
import {
  approvedDictionaryFaults,
  sourceControlCharacterFaults,
  unexportedPatternFaults,
  DICTIONARY_LOCALES,
  type DictionaryLocale,
  type FeatureGrants,
  LOCALE_CLAIMS,
  type LocalisedValue,
  type PricedPlan,
  claim,
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
  valueClauses,
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
  "pricing.faq.groups.a":
    "about billing groups — makes no pass-duration claim, but IS scanned for the half-rate claim via HALF_CLAIM_KEYS (its bare 'half your plan's rate' was live for two rounds)",
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
 * THE PRO PLUS CARD — a THIRD key axis, and the reason it now exists.
 *
 * `PLUS_VALUES` above is the FAQ answer, three cards down the /pricing page.
 * The card itself is six other keys, and nothing scanned them: task 4 removed
 * "AI-assisted scheduling" from the answer while the card two screens above
 * went on selling it, in all four locales. A page disagreeing with itself is
 * worse than either fixing both or fixing neither — and the axis, not the
 * vocabulary, is what was missing. The pattern for this falsehood already
 * existed (`LOCALE_CLAIMS[*].plusClaims["scheduling.ai"]`); nothing pointed it
 * at these keys.
 *
 * The five bullets are scanned as ONE value per locale because that is how a
 * reader reads them — under the `pricing.plus.note` frame, each one asserting
 * the lower plans lack it. Joined with ". " so a claim cannot reach ACROSS two
 * bullets: every window in these vocabularies is bounded by sentence
 * punctuation, and wrong-clause satisfaction has already appeared three times
 * in this wave.
 */
const PLUS_CARD_BULLET_KEYS = [1, 2, 3, 4, 5].map((n) => `pricing.plus.f${n}`);
const PLUS_CARD_KEYS = ["pricing.plus.note", ...PLUS_CARD_BULLET_KEYS];

/** The roadmap under the same card — its label and its eight items. Pinned in
 *  APPROVED_DICTIONARY_COPY; see the note over those entries for why there is no
 *  matrix row to check them against. */
/**
 * ── THE PANEL'S ROW SET, DERIVED FROM THE PAGE (fix round 4) ────────────────
 *
 * Read out of `settings/billing/page.tsx` rather than typed here, so a NEW row
 * is covered the day it is written. A hand-written list was the gap: adding
 * `<li>✓ {t(dict,"billing.community.f8")}</li>` claiming "Unlimited AI schedule
 * credits", with the key in all four dictionaries, scored ZERO faults — the same
 * completeness hole the cards had two rounds ago, on a surface I had just built.
 */
const BILLING_PAGE = readFileSync("src/app/o/[orgSlug]/settings/billing/page.tsx", "utf8");
const PANEL_KEYS: string[] = [
  ...new Set(
    [...BILLING_PAGE.matchAll(/"(billing\.(?:community|pro)\.f\d+)"/g)].map((m) => m[1]!),
  ),
].sort();

const PLUS_SOON_KEYS = [
  "pricing.plus.soonLabel",
  ...Array.from({ length: 8 }, (_, i) => `pricing.plus.soon${i + 1}`),
];

/**
 * A MISSING key is a FAULT, not an empty string (fix round 1, minor).
 *
 * `?? ""` swallowed a deleted key: the value simply got shorter, the scans below
 * found no falsehood in it, and the suite went green on a card bullet that no
 * longer exists. The empty-value case is exactly what `localePassBoundFaults`
 * calls "empty — nothing to scan, so every rule below passes vacuously", and it
 * has to reach the fault list here too rather than be silently normalised away.
 */
const missingCardKeys: string[] = [];
const PLUS_CARD_VALUES: LocalisedValue[] = DICTIONARY_LOCALES.map((locale) => ({
  locale,
  key: "pricing.plus.f1-f5",
  value: PLUS_CARD_BULLET_KEYS.map((key) => {
    const value = load(locale, "marketing")[key];
    if (typeof value !== "string" || value.trim().length === 0) {
      missingCardKeys.push(`${locale} ${key}: missing or empty in marketing.json`);
      return "";
    }
    return value;
  }).join(". "),
}));

/**
 * THE HALF-RATE CLAIM HAS ITS OWN KEY AXIS, and this is why.
 *
 * `localeHalfClaimFaults` was only ever called with `PLUS_VALUES`, so
 * `pricing.faq.groups.a` — which says "half your plan's rate", bare, in all four
 * locales, three FAQ cards away — was never scanned. `en.halfClaim` literally
 * spells that phrase out; the pattern existed and nothing pointed it at the key.
 *
 * The pass-permanence axis had been pinned last round. This one had not, and a
 * per-family axis is the only thing that makes "which keys make THIS claim" a
 * decision rather than an oversight.
 *
 * Fix round 4 (task 7) added the third key. `tips.billing.extra-org.body` said
 * "half your plan's rate", bare, in all four locales, through every earlier
 * round of this wave — the SAME phrase as `pricing.faq.groups.a`, matched by
 * the SAME pattern, and again nobody had pointed the rule at the key. An axis
 * is only a decision once every key that makes the claim is on it.
 */
const HALF_CLAIM_KEYS = [
  "pricing.faq.proPlus.a",
  "pricing.faq.groups.a",
  "pricing.matrix.orgs.max_owned.note",
];

/** …and the same axis in `ui.json`. `across()` takes one file, so the two live
 *  apart; both are pinned by the gate and both are asserted below. */
const HALF_CLAIM_UI_KEYS = [
  "tips.billing.extra-org.body",
  "orgNew.bill.addToExistingHint",
  "billing.group.attach.confirmCharge",
];
const HALF_CLAIM_VALUES: LocalisedValue[] = [
  ...HALF_CLAIM_KEYS.flatMap((key) => across("marketing", key)),
  ...HALF_CLAIM_UI_KEYS.flatMap((key) => across("ui", key)),
];

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
  // CLOSED by task 5: `pricing.plus.f3` (the Pro Plus CARD's third bullet) is
  // now covered by PLUS_CARD_VALUES below and pinned in
  // APPROVED_DICTIONARY_COPY, together with the frame and the other four
  // bullets. lib/pricing-cards.ts PLUS_CARD_FEATURES and
  // e2e/pro-plus-tier.spec.ts moved with it, in the same commit.
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

/**
 * A FRESH adversarial set, written AFTER this round's rules were final —
 * ordinary editorial prose, including the five phrasings the reviewer cited.
 * No rule was adjusted to accommodate any of it. See the two tests that
 * measure against it: the vocabulary catches 1, the approved-wording gate 40.
 */
const FRESH: Record<DictionaryLocale, string[]> = {
  en: [
    "You will never lose it.",
    "There is no use-by date on a pass.",
    "Buy it once and it is settled.",
    "The upgrade is not time-boxed.",
    "Nothing takes it away later.",
    "It is a one-and-done purchase that stands.",
    "The pass will still be there next season.",
    "We do not claw the upgrade back.",
    "It outlives the event itself.",
    "Consider it yours from then on.",
  ],
  es: [
    "El pase no tiene fecha de caducidad.",
    "Nunca lo vas a perder.",
    "Cómpralo una vez y asunto resuelto.",
    "La mejora no está limitada en el tiempo.",
    "Nada te lo quita después.",
    "El pase seguirá ahí la próxima temporada.",
    "No retiramos la mejora.",
    "Sobrevive al propio evento.",
    "Considéralo tuyo a partir de entonces.",
    "La mejora no se retira jamás.",
  ],
  fr: [
    "Le pass ne s'éteint pas.",
    "Vous ne le perdrez jamais.",
    "Achetez-le une fois et c'est réglé.",
    "L'amélioration n'est pas limitée dans le temps.",
    "Rien ne vous le retire ensuite.",
    "Le pass sera encore là la saison prochaine.",
    "Nous ne reprenons pas l'amélioration.",
    "Il survit à l'événement lui-même.",
    "Considérez-le comme acquis dès lors.",
    "Le pass n'a pas de date de péremption.",
  ],
  nl: [
    "De pass wordt nooit ingetrokken.",
    "Je raakt hem nooit kwijt.",
    "Koop hem één keer en het is geregeld.",
    "De upgrade is niet in tijd beperkt.",
    "Niets neemt hem later weg.",
    "De pass staat er volgend seizoen nog.",
    "Wij halen de upgrade niet terug.",
    "Hij overleeft het evenement zelf.",
    "Beschouw hem vanaf dan als de jouwe.",
    "De pass heeft geen houdbaarheidsdatum.",
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
  "AI scheduling is limited to 5 attempts per division",
  "Each division may be scheduled by AI up to 20 times.",
  // ── Task 3's APPROVED FORMS (the help-tree allowlist) ──
  // These are positives in the opposite sense to everything else here: they are
  // the shapes the help copy is ALLOWED to use, so each one is a real sentence
  // from content/help/billing/event-pass.md. A form that matches nothing is a
  // form no copy can satisfy, which would make the allowlist unusable rather
  // than merely inert — the same failure, from the other side.
  "Its end date passed more than 7 days ago, so the pass has stopped applying",
  "It does not carry to next season's edition — a new edition is a new competition",
  "the pass is bought outright for that event and survives a downgrade",
  "the pass is bound to the competition itself, not its name",
  "if the first card entry was taken while the pass was live, the pass's cheaper rate rides on",
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
  // M4: the recurring family beyond monthly — a yearly or weekly repeat is the
  // same falsehood about a one-time grant.
  "25 AI credits annually",
  "an annual credit grant",
  "25 credits a year",
  "credits weekly",
  "credits every week",
  "the grant renews",
  "credits each billing period",
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
  // ── Seed STRUCTURE, not copy: NON_SECTION_KEY names the seed keys that are
  //    developer notes or scalars rather than product lists. ──
  "$comment_tiers",
  "currency",
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

// FIX ROUND 4, CI BLOCKER. Round 3 added an `it` that calls `sql` inside this
// block while it was a bare `describe`, so a DB-less run threw
// "DATABASE_URL is not set" — and ci.yml's unit job has no DATABASE_URL, which
// means this PR redded that job on every push. Measured DB-less before the fix:
// 75 pass / 1 fail / 33 pending. The Postgres job selects `src/server src/lib`,
// so the gated half still runs there.
describe.skipIf(!HAS_DB)("the four-locale dictionaries say what the resolver enforces", () => {
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
    // A deleted card key must reach this list rather than be normalised to "".
    expect(missingCardKeys).toEqual([]);
    for (const { locale, key, value } of [...PASS_BOUND_VALUES, ...PLUS_VALUES, ...PLUS_CARD_VALUES]) {
      expect(value, `${locale} ${key} is missing or empty`).toBeTruthy();
      expect(value.length, `${locale} ${key}`).toBeGreaterThan(20);
    }
    for (const claims of Object.values(LOCALE_CLAIMS)) {
      expect(claims.permanence.length).toBeGreaterThan(4);
      expect(claims.plusClaims.length).toBeGreaterThan(2);
      expect(claims.recurring.length).toBeGreaterThan(2);
    }
  });

  /**
   * THE GATE. Every rule below it reads a sentence and decides whether it is
   * false; this one asks only whether the sentence is the approved sentence.
   *
   * It is first because it is the rule that does not depend on anyone having
   * imagined the right falsehood — and because the falsehood that survived two
   * rounds of vocabulary widening (`pricing.faq.groups.a`) had a pattern
   * written for it already. Nothing had pointed the pattern at that key; a
   * pinned string needs no one to remember.
   */
  it("matches the approved wording, in every locale", () => {
    expect(
      approvedDictionaryFaults(APPROVED_DICTIONARY_COPY, (file, locale) => load(locale, file)),
    ).toEqual([]);
  });

  // …and the gate covers the keys that make the claims. An inventory that has
  // quietly stopped including a key is the failure this whole round was about.
  it("pins every key that makes a pass or rate claim", () => {
    const pinned = new Set(APPROVED_DICTIONARY_COPY.map((e) => e.key));
    for (const [, key] of PASS_BOUND_KEYS) {
      expect(pinned.has(key), `${key} is scanned for pass claims but not pinned`).toBe(true);
    }
    for (const key of [...HALF_CLAIM_KEYS, ...HALF_CLAIM_UI_KEYS]) {
      expect(pinned.has(key), `${key} makes a half-rate claim but is not pinned`).toBe(true);
    }
    // …and the Pro Plus card: its frame AND every bullet it governs. Pinning the
    // bullets without the frame would leave a reword free to delete the thing
    // that makes them exclusivity claims at all.
    for (const key of PLUS_CARD_KEYS) {
      expect(pinned.has(key), `${key} is a Pro Plus card claim but is not pinned`).toBe(true);
    }
    // FIX ROUND 1 (I3): the ROADMAP under the same card. Its claim is
    // availability, which no `plan_entitlements` row records, so the pin is the
    // only thing between a one-word edit and eight undelivered features being
    // advertised as live — measured, in whichever locale it is done.
    for (const key of PLUS_SOON_KEYS) {
      expect(pinned.has(key), `${key} is a roadmap claim but is not pinned`).toBe(true);
    }
    // FIX ROUND 4: the in-app comparison panel. Polarity never reads the string,
    // so without these the original f5 defect could be restored verbatim and
    // ship green — measured, 109/109.
    for (const key of PANEL_KEYS) {
      expect(pinned.has(key), `${key} is an in-app panel claim but is not pinned`).toBe(true);
    }
    expect(APPROVED_DICTIONARY_COPY.length * DICTIONARY_LOCALES.length).toBe(236);
    // Every entry must say what it claims and what decides it — a pin with no
    // `why` is a snapshot, and a snapshot teaches the next editor to re-record
    // rather than to re-check.
    for (const entry of APPROVED_DICTIONARY_COPY) {
      expect(entry.why.length, `${entry.key} has no source-of-truth note`).toBeGreaterThan(40);
    }
  });

  /**
   * ── EVERY `pricing.*` KEY IS A DECISION ──────────────────────────────────
   *
   * The structural version of this file's oldest lesson, applied to the whole
   * page instead of one claim family. `FAQ_EXEMPT` already forces every
   * `pricing.faq.*.a` answer to be classified; this forces every OTHER pricing
   * key to be classified too.
   *
   * It exists because a fresh probe set, written after the card rules were
   * final, found two live holes of the same shape — `pricing.plus.per` and
   * `pricing.credits.perMonthOperator`, both money claims, both one word from
   * false, both scanned by nothing. Neither was exotic; nobody had asked the
   * question "which pricing keys make a claim?" as DATA.
   *
   * A key matching no rule is a fault, so a string added to /pricing tomorrow
   * reds until someone decides which side it falls on. A rule matching no key is
   * a fault too — that is how a disposition list rots into decoration.
   */
  const PRICING_KEY_DISPOSITION: Array<{ match: RegExp; pinned: boolean; why: string }> = [
    {
      match: /^pricing\.(plus\.(note|f\d|soonLabel|soon\d)|pass\.note)$/,
      pinned: true,
      why: "the Pro Plus card, its roadmap, and the pass card's duration note — claim-bearing copy, pinned verbatim",
    },
    {
      match: /^pricing\.(credits\.\w+|addons\.(credits|seat|org|sizePack)|plus\.per|pass\.(per|from|ladder\.caps\w*)|community\.price)$/,
      pinned: true,
      why: "quotes money or an allowance — the number is interpolated live, so the words around it are the claim",
    },
    {
      match: /^pricing\.faq\./,
      pinned: false,
      why: "answers are classified individually by FAQ_PASS_SCOPED / FAQ_EXEMPT above, and the claim-bearing ones are pinned there; questions make no claim",
    },
    {
      // MINOR, fix round 2. "Your plan already includes everything here" was
      // exempted by a rule whose stated reason is "they identify a card, they do
      // not describe what it grants" — it plainly described what a plan grants,
      // and it was FALSE against Event Pass L (unlimited entrants against pro's
      // 256, #337). Rewritten to the resolver-backed reason and pinned.
      match: /^pricing\.pass\.included$/,
      pinned: true,
      why: "explains why a paid org is not offered a pass. It asserted Pro superset-of-pass, which #337 records as untrue for the L rung; it now states the V338 dormancy rule instead",
    },
    {
      // FIX ROUND 2. This key is a whole SENTENCE quoting the extra-organisation
      // rate, not a label — and the "row labels" rule below formally certified
      // it exempt while it still said "half", bare, in all four locales. Its
      // three siblings had already been corrected. The rule written to make
      // every key a decision made the wrong decision about this one, which is
      // why the exempt side is now vocabulary-scanned as well as classified.
      match: /^pricing\.matrix\.orgs\.max_owned\.note$/,
      pinned: true,
      why: "a full sentence in the matrix quoting the extra-organisation rate — pinned by task 7 and scanned by HALF_CLAIM_KEYS; it is emphatically not a row label",
    },
    {
      match: /^pricing\.(?!matrix\.orgs\.max_owned\.note$)(matrix|table)\./,
      pinned: false,
      why: "row labels and column headers of the comparison table. Every VALUE in that table is rendered live from plan_entitlements by lib/pricing-matrix.ts, so the labels name features rather than asserting anything about them. This rule once swallowed pricing.matrix.orgs.max_owned.note, a full sentence quoting a rate, so the exempt side is now scanned by the claim vocabularies too",
    },
    {
      match: /^pricing\.final\.subhead$/,
      pinned: true,
      why: "the closing CTA claims no card is required and names both upgrade paths — three claims in one sentence, and the key this rule found on its first run",
    },
    {
      match: /^pricing\.(meta\.\w+|eyebrow|title|subhead|final\.title)$/,
      pinned: false,
      why: "page chrome, SEO metadata and CTA headings — they set the scene rather than describing what any plan grants",
    },
    {
      match: /^pricing\.enterprise\.(text|link)$/,
      pinned: false,
      why: "the 'talk to us' prompt. It NAMES SSO, which is on the coming-soon roadmap, but asks whether the reader needs it rather than stating we ship it — an availability claim here would have to be pinned like soonLabel",
    },
    {
      match: /^pricing\.(?!addons\.label$)\w+\.(name|cta|ctaSignedIn|popular|label)$/,
      pinned: false,
      why: "tier names, button labels and state text — they identify a card, they do not describe what it grants",
    },
    {
      match: /^pricing\.(community\.note|pass\.(rung\.\w|ladderNote)|addons\.label)$/,
      pinned: false,
      why: "sub-labels: the rung letters (M / L), the ladder's own explanatory note and the add-ons heading. The claims they introduce are pinned on the keys that make them",
    },
  ];

  it("classifies every pricing.* key as pinned or exempt, with a reason", () => {
    const keys = Object.keys(load("en", "marketing")).filter((k) => k.startsWith("pricing."));
    expect(keys.length, "no pricing keys found — the key shape changed").toBeGreaterThan(100);
    const pinned = new Set(APPROVED_DICTIONARY_COPY.map((e) => e.key));
    const unclassified: string[] = [];
    const ambiguous: string[] = [];
    const unpinned: string[] = [];
    const used = new Set<number>();
    for (const key of keys) {
      // EVERY match, not the first. `findIndex` made "exactly one rule" a claim
      // the test never checked: a broad early exempt rule silently swallowed
      // later keys, which is how the matrix note came to be certified a "row
      // label" while it quoted a rate.
      const matches = PRICING_KEY_DISPOSITION.map((rule, i) => (rule.match.test(key) ? i : -1)).filter(
        (i) => i !== -1,
      );
      if (matches.length === 0) {
        unclassified.push(key);
        continue;
      }
      if (matches.length > 1) {
        ambiguous.push(
          `${key}: matched by ${matches.map((i) => PRICING_KEY_DISPOSITION[i]!.match.source).join(" AND ")}`,
        );
        continue;
      }
      used.add(matches[0]!);
      if (PRICING_KEY_DISPOSITION[matches[0]!]!.pinned && !pinned.has(key)) unpinned.push(key);
    }
    expect(unclassified, "pricing keys matching no disposition rule").toEqual([]);
    expect(ambiguous, "pricing keys matched by more than one rule — the classification is not a decision").toEqual([]);
    expect(unpinned, "classified as pinned but absent from APPROVED_DICTIONARY_COPY").toEqual([]);
    // …and the inverse: a rule that matches nothing is decoration, and every
    // reason must be a real one.
    expect(
      PRICING_KEY_DISPOSITION.map((r, i) => (used.has(i) ? null : r.match.source)).filter(Boolean),
      "disposition rules matching no key",
    ).toEqual([]);
    for (const rule of PRICING_KEY_DISPOSITION) {
      expect(rule.why.length, rule.match.source).toBeGreaterThan(30);
    }
    // The rule itself must red on a new key nobody classified — the whole point.
    expect(
      ["pricing.plus.newBadge", "pricing.somethingElse"].filter((k) =>
        PRICING_KEY_DISPOSITION.some((rule) => rule.match.test(k)),
      ),
    ).toEqual([]);
  });

  /**
   * ── AND THE EXEMPT SIDE IS SCANNED, NOT TRUSTED (fix round 2, blocking 3) ──
   *
   * Classifying a key exempt records a decision about what it says TODAY. It
   * does nothing about what it says next month. Measured 0/2 in all four
   * locales: a permanence falsehood dropped into `pricing.community.note` and a
   * free-forever claim into `pricing.matrix.orgs.max_owned.note` were both
   * green, because "exempt" was the end of the conversation.
   *
   * So every exempt key is run through the SAME per-locale vocabularies the
   * pinned keys face. An exemption that stops being true now reds — which is the
   * fix already prescribed for `FAQ_EXEMPT` on #338, applied here at the same
   * time so the two sides of this file do not drift apart again.
   *
   * Scoped to the claim families that are FALSE of the subjects on this page:
   * pass permanence and the bare half-rate. Community's "free forever" is TRUE,
   * so the permanence scan is pointed at values that mention the pass or an
   * upgrade rather than at every string — the measured lesson from the
   * repo-wide sweep that found 18 hits of which 17 were true.
   */
  it("re-scans every exempt pricing key, so an exemption that stops being true reds", () => {
    const pinned = new Set(APPROVED_DICTIONARY_COPY.map((e) => e.key));
    const exemptKeys = Object.keys(load("en", "marketing")).filter(
      (k) =>
        k.startsWith("pricing.") &&
        !pinned.has(k) &&
        !FAQ_PASS_SCOPED.includes(k) &&
        !HALF_CLAIM_KEYS.includes(k),
    );
    expect(exemptKeys.length, "no exempt keys to re-scan — this rule examines nothing").toBeGreaterThan(50);

    const values: LocalisedValue[] = exemptKeys.flatMap((key) => across("marketing", key));
    const faults: string[] = [];
    for (const { locale, key, value } of values) {
      if (value.length === 0) continue;
      const claims = LOCALE_CLAIMS[locale];
      // The half-rate claim is false BARE on every surface, whoever writes it.
      if (claims.halfClaim.test(value) && !claims.atMostHalf.test(value)) {
        faults.push(`${locale} ${key}: quotes half the base rate with no "no more than" qualifier`);
      }
      // Pass permanence, attributed CLAUSE BY CLAUSE. A value-level subject test
      // was measured wrong on the first run: `pricing.meta.description` says
      // "Free forever for small clubs" (Community — TRUE) in the same paragraph
      // as "Upgrade a single event from $29", so the pass subject in one clause
      // vouched for a permanence hit in another, and all four locales redded on
      // honest copy. That is the 18-hits-17-true false-positive class, and a
      // guard that rejects true prose teaches its next editor to route around it.
      for (const clause of valueClauses(value)) {
        if (!claims.passSubject.test(clause)) continue;
        if (!claims.permanence.some((p) => p.test(clause))) continue;
        faults.push(
          `${locale} ${key}: exempt, but "${clause.slice(0, 60)}" now claims the pass has unbounded duration`,
        );
        break;
      }
    }
    expect(faults).toEqual([]);

    // …and the scan FIRES. Both reviewer probes, in every locale, against the
    // real exempt keys they were dropped into.
    const probe = (key: string, add: Record<DictionaryLocale, string>) =>
      DICTIONARY_LOCALES.flatMap((locale) => {
        const value = `${load(locale, "marketing")[key] ?? ""} ${add[locale]}`;
        const claims = LOCALE_CLAIMS[locale];
        const half = claims.halfClaim.test(value) && !claims.atMostHalf.test(value);
        const permanence = valueClauses(value).some(
          (clause) =>
            claims.passSubject.test(clause) && claims.permanence.some((p) => p.test(clause)),
        );
        return half || permanence ? [] : [`${locale} ${key}`];
      });
    expect(
      probe("pricing.community.note", {
        en: "Your Event Pass upgrade lasts forever.",
        es: "La mejora del pase dura para siempre.",
        fr: "L’amélioration du pass dure pour toujours.",
        nl: "De pass-upgrade blijft voor altijd van jou.",
      }),
      "a permanence falsehood in an exempt key must red, in every locale",
    ).toEqual([]);
    expect(
      probe("pricing.addons.label", {
        en: "Each extra organisation is half the base rate.",
        es: "Cada organización adicional cuesta a mitad de la tarifa base.",
        fr: "Chaque organisation supplémentaire coûte à moitié du tarif de base.",
        nl: "Elke extra organisatie kost voor de helft van het basistarief.",
      }),
      "a bare half-rate claim in an exempt key must red, in every locale",
    ).toEqual([]);
  });

  /**
   * FIX ROUND 2 — no /pricing string may hardcode a currency.
   *
   * `pricing.addons.credits` said "$10" in all four locales (es "desde 10 $",
   * fr "à partir de 10 $", nl "vanaf $10") and rendered statically, while every
   * other price on the page is interpolated behind the CurrencySwitcher. The
   * seed's cheapest pack is eur 900 / gbp 800 / aud 1500 / inr 79900, so it was
   * false in four of five currencies.
   *
   * Scanned as a CLASS rather than as that one key: any pricing value carrying a
   * currency symbol or an ISO code is the same defect (#191), whoever writes it
   * next. Amounts belong in a placeholder.
   */
  it("hardcodes no currency anywhere in the pricing copy", () => {
    // A symbol, or an amount with an ISO code. Deliberately not a bare digit:
    // caps, percentages and credit counts are locale-agnostic DATA and belong in
    // the copy.
    const CURRENCY = /[$£€₹]|\b\d[\d.,]*\s?(?:USD|EUR|GBP|INR|AUD)\b|\b(?:USD|EUR|GBP|INR|AUD)\s?\d/i;
    // SEO METADATA IS THE ONE HONEST EXCEPTION, and it is pinned rather than
    // waved through (below). A description is a SINGLE cached document served to
    // every visitor and to crawlers — there is no per-visitor currency to switch
    // to, unlike the page body, which does switch. Every other pricing string is
    // rendered per request and has no excuse.
    const METADATA_EXEMPT = new Set(["pricing.meta.description", "pricing.meta.title"]);
    const faults: string[] = [];
    for (const locale of DICTIONARY_LOCALES) {
      const dict = load(locale, "marketing");
      for (const [key, value] of Object.entries(dict)) {
        if (!key.startsWith("pricing.") || METADATA_EXEMPT.has(key)) continue;
        if (typeof value !== "string" || !CURRENCY.test(value)) continue;
        faults.push(`${locale} ${key}: hardcodes a currency ("${value}") — interpolate it instead`);
      }
    }
    expect(faults).toEqual([]);
    // …and the rule fires on the exact string this round removed, so it is not
    // passing because the pattern can never match.
    expect(CURRENCY.test("AI credits from $10"), "en, pre-fix").toBe(true);
    expect(CURRENCY.test("Créditos de IA desde 10 $"), "es, pre-fix").toBe(true);
    expect(CURRENCY.test("Crédits IA à partir de 10 $"), "fr, pre-fix").toBe(true);
    expect(CURRENCY.test("AI-credits vanaf $10"), "nl, pre-fix").toBe(true);
    expect(CURRENCY.test("Up to 20 divisions, unlimited entrants"), "a true cap line").toBe(false);
    // The replacement must actually interpolate, in every locale — otherwise
    // deleting the amount would satisfy the absence rule above.
    for (const locale of DICTIONARY_LOCALES) {
      expect(load(locale, "marketing")["pricing.addons.credits"], `${locale}`).toContain("{price}");
    }
  });

  /**
   * …and the exemption is a PIN, not a hole.
   *
   * `pricing.meta.description` quotes $29 and $19/month in all four locales and
   * cannot be currency-switched (one cached document, served to crawlers). That
   * makes it the one place a hardcoded amount is defensible — and therefore the
   * one place a stale amount would never be noticed. So the figures are checked
   * against the seed the page itself renders from: move a price and the meta
   * description reds instead of quietly advertising last quarter's.
   */
  it("pins the metadata's hardcoded amounts to the seed that sets them", () => {
    const pass = passPrice("usd", "event_pass") / 100;
    const pro = proPrice("monthly", "usd") / 100;
    expect(pass, "the seed's M-rung list price").toBe(29);
    expect(pro, "the seed's Pro monthly list price").toBe(19);
    for (const locale of DICTIONARY_LOCALES) {
      const description = load(locale, "marketing")["pricing.meta.description"]!;
      expect(description, `${locale}: the pass price`).toMatch(
        new RegExp(`\\$\\s?${pass}\\b|\\b${pass}\\s?\\$`),
      );
      expect(description, `${locale}: Pro's monthly price`).toMatch(
        new RegExp(`\\$\\s?${pro}\\b|\\b${pro}\\s?\\$`),
      );
    }
  });

  /**
   * THE PIN PROVES DELIBERATE; THE SCAN PROVES TRUE — and the matrix note needs
   * both.
   *
   * `pricing.matrix.orgs.max_owned.note` is now pinned AND in HALF_CLAIM_KEYS.
   * Reverting its copy reds the pin, which is what a probe measures — but a
   * future editor who re-words it AND re-approves it would sail past the pin.
   * The scan is what still catches them, and it has to be shown to do so
   * independently, or "pinned" quietly becomes the only guard on a claim that
   * was false in eight of ten plan x currency pairs.
   */
  it("catches a bare half-rate in the matrix note even when it has been re-approved", () => {
    const bare: Record<DictionaryLocale, string> = {
      en: "Each extra organisation costs half the base rate, and takes your plan's entry-fee rate",
      es: "Cada organización adicional cuesta a mitad de la tarifa base y adopta la comisión de tu plan",
      fr: "Chaque organisation supplémentaire coûte à moitié du tarif de base et adopte le taux de votre forfait",
      nl: "Elke extra organisatie kost voor de helft van het basistarief en krijgt het percentage van je abonnement",
    };
    const values: LocalisedValue[] = DICTIONARY_LOCALES.map((locale) => ({
      locale,
      key: "pricing.matrix.orgs.max_owned.note",
      value: bare[locale],
    }));
    const faults = localeHalfClaimFaults(values, "atMost").join(" | ");
    for (const locale of DICTIONARY_LOCALES) {
      expect(faults, `${locale}: a re-approved bare "half" must still red`).toContain(
        `${locale} pricing.matrix.orgs.max_owned.note`,
      );
    }
    // …and the shipped wording does not.
    expect(
      localeHalfClaimFaults(across("marketing", "pricing.matrix.orgs.max_owned.note"), "atMost"),
    ).toEqual([]);
  });

  /**
   * ── THE SAME FIVE CLAIMS, ON THE OTHER SURFACE (fix round 2) ───────────────
   *
   * `billing.plus.f1-f5` in ui.json is the IN-APP Pro Plus upgrade panel
   * (app/o/[orgSlug]/settings/billing/page.tsx renders them as a ✓ list beside
   * Pro), and `pricing-cards.ts` has always described the two as "the same five
   * selling points". They were not: this wave corrected `pricing.plus.f3` on
   * /pricing while `billing.plus.f3` went on saying "AI-assisted scheduling" in
   * all four locales — the identical falsehood, on the surface a paying
   * customer actually reads before upgrading, found by a probe written after
   * the round-2 rules were final.
   *
   * Asserting the MIRROR is the structural fix. Two hand-maintained copies of
   * one claim set will diverge again; one of them being a copy of the other
   * cannot.
   */
  /**
   * ── THE IN-APP COMPARISON PANEL, AND WHY A MIRROR IS THE WRONG GUARD ──────
   *
   * `billing.community.f1-f7` and `billing.pro.f1-f7` render in Settings →
   * Billing as a two-column Community-vs-Pro table, and the ✓/✗ is POSITIONAL:
   * page.tsx marks community f1-f4 with ✓ and f5-f7 with ✗. So the falsehood
   * available here is not wording drift — it is a row in the wrong column.
   *
   * Three were:
   *   f5 "Entry fees (Stripe payouts)" ✗  — `registration.paid` is TRUE on
   *      community, and the public card sells "Online registration & entry fees
   *      (8% fee)". The panel was telling a Community org it cannot take money.
   *   f6 "Branding & exports" ✗           — `branding` and `exports` are BOTH
   *      true on community (V310). Only `exports.branded` and
   *      `dashboard.branding` are denied.
   *   f4 "Free-event registration"        — the exact framing pricing-cards.ts
   *      documents the public card being corrected AWAY from.
   *
   * A literal mirror against FREE_FEATURES/PRO_FEATURES would be the wrong
   * instrument: these panels are a different shape (seven slots, denial rows, no
   * home stub) and forcing them to be string-equal would be false discipline.
   * POLARITY AGAINST THE MATRIX is the guard that actually decides the question
   * — and it is strictly stronger, because it also fails when the matrix moves.
   *
   * Note what the comparison READS: the ✓/✗ lives in the JSX, not in the
   * dictionary, so the polarity here is declared alongside the key and pinned to
   * page.tsx by the positional assertion below. A guard that read only the
   * strings could never have seen this class — the fifth normaliser-shaped hole
   * this wave has found.
   */
  const PANEL_CLAIMS: Array<{
    key: string;
    plan: string;
    /** ✓ or ✗ in page.tsx, and therefore what the row asserts. */
    polarity: "granted" | "denied";
    /** Every feature the row names. ALL must agree with the polarity. */
    features: string[];
  }> = [
    { key: "billing.community.f4", plan: "community", polarity: "granted", features: ["registration.enabled", "registration.paid"] },
    { key: "billing.community.f5", plan: "community", polarity: "denied", features: ["exports.branded", "dashboard.player_profiles"] },
    { key: "billing.community.f6", plan: "community", polarity: "denied", features: ["dashboard.branding"] },
    { key: "billing.community.f7", plan: "community", polarity: "denied", features: ["realtime"] },
    { key: "billing.pro.f4", plan: "pro", polarity: "granted", features: ["scoring.ball_by_ball", "scoring.rally_by_rally"] },
    { key: "billing.pro.f5", plan: "pro", polarity: "granted", features: ["dashboard.branding"] },
    { key: "billing.pro.f6", plan: "pro", polarity: "granted", features: ["exports"] },
    { key: "billing.pro.f7", plan: "pro", polarity: "granted", features: ["realtime"] },
  ];

  /**
   * ── THE ROADMAP LABEL, IN EVERY LANGUAGE (fix round 3) ────────────────────
   *
   * `pricing.plus.soonLabel` was pinned in four locales and asserted by an
   * ENGLISH LITERAL. So flipping es/fr/nl to "Ya incluido" and re-approving them
   * shipped green — the same eight-undelivered-features-reclassified breach that
   * was closed for English only.
   *
   * An ALLOWLIST, not a denylist: the label must MATCH a recognised way of
   * saying "not yet" in its own language. Nobody has to have imagined the right
   * falsehood — "Included now" simply is not a futurity form. Built through
   * `claim()` so the accented forms actually match (`\b` is ASCII-only in JS,
   * which has voided two guards in this wave already).
   */
  const FUTURITY_FORMS: Record<DictionaryLocale, RegExp> = {
    en: claim(String.raw`\b(coming\s+soon|soon|planned|roadmap|in\s+development|next\s+up|on\s+the\s+way)\b`),
    es: claim(String.raw`\b(pr[óo]ximamente|pronto|en\s+desarrollo|previsto|hoja\s+de\s+ruta|en\s+camino)\b`),
    fr: claim(String.raw`\b(bient[ôo]t|prochainement|[àa]\s+venir|en\s+d[ée]veloppement|feuille\s+de\s+route)\b`),
    nl: claim(String.raw`\b(binnenkort|gepland|in\s+ontwikkeling|routekaart|komt\s+eraan|op\s+komst)\b`),
  };

  /**
   * ── A ROW THAT MEANS "NOT YET" MUST NOT READ AS "INCLUDED" ────────────────
   *
   * Two surfaces make a NEGATIVE claim purely by WHERE they sit: the eight
   * roadmap items under the "Coming soon" label, and the ✗ rows of the in-app
   * Community panel. Nothing in the string itself says "not yet", so a reword
   * inverts the meaning while every structural guard stays green — the label is
   * still futurity, the polarity table still points at the same denied feature.
   *
   * Both misses on the strict copy-addition axis were this shape:
   *   soon4  -> "Custom domain & white-label — included forever, on every plan"
   *   f6     -> "Theme colour & badge removal, included"
   *
   * Guarded two ways, because either alone is escapable:
   *  1. SHAPE — a roadmap item is a bare label. Every one of the 32 shipped
   *     strings is a noun phrase with no clause break, so a sentence smuggled in
   *     beside it reds without anyone having to predict its words.
   *  2. VOCABULARY — availability and permanence wording, per locale, for the
   *     rewordings that stay short.
   */
  const AVAILABILITY_CLAIM: Record<DictionaryLocale, RegExp> = {
    en: claim(String.raw`\b(included|includes|available\s+now|live\s+now|already|on\s+every\s+plan|every\s+plan)\b`),
    es: claim(String.raw`\b(incluid[oa]s?|disponible\s+ya|ya\s+disponible|ya\s+incluid|en\s+todos\s+los\s+planes)\b`),
    fr: claim(String.raw`\b(inclus(e|es)?|d[ée]j[àa]\s+disponible|disponible\s+d[ée]s\s+maintenant|sur\s+tous\s+les\s+forfaits)\b`),
    nl: claim(String.raw`\b(inbegrepen|nu\s+beschikbaar|al\s+beschikbaar|bij\s+elk\s+abonnement)\b`),
  };

  /** A bare label: no clause break, no sentence. */
  const CLAUSE_BREAK_IN_LABEL = /[—–:;.]|,\s/;

  /**
   * …AND THE INVERSE, because every presence rule in this file is paired.
   *
   * A ✓ row asserts the plan HAS the thing. Fresh probe D3 inverted one in
   * Spanish alone — `billing.community.f4` "Inscripción online SIN cuotas de
   * inscripción" — and nothing objected: the polarity table checks the FEATURE
   * against the matrix, not the WORDING, so a row can keep its tick while its
   * text says the opposite. Exactly the defect this round fixed in the other
   * direction, one locale over.
   */
  const DENIAL_WORDING: Record<DictionaryLocale, RegExp> = {
    en: claim(String.raw`\b(without|excluded|not\s+included|no\s+entry\s+fees|unavailable)\b`),
    es: claim(String.raw`\b(sin|excluid[oa]s?|no\s+incluid|no\s+disponible)\b`),
    fr: claim(String.raw`\b(sans|exclu(e|s|es)?|non\s+inclus|pas\s+de|indisponible)\b`),
    nl: claim(String.raw`\b(zonder|geen|uitgesloten|niet\s+inbegrepen|niet\s+beschikbaar)\b`),
  };

  /**
   * ── THE THREE NEW MAPS, UNDER THE MODULE-WIDE ANTI-VACUITY RULES ──────────
   *
   * `FUTURITY_FORMS`, `AVAILABILITY_CLAIM` and `DENIAL_WORDING` live in this
   * FILE, not in `@/lib/copy-truth`, so `collectPatterns` — which walks the
   * module's exports — cannot see them. That is the known container-shape hole,
   * and a control character planted in any of the three escapes every existing
   * anti-vacuity rule while the suite stays green (two guards shipped inert in
   * this wave exactly that way, and a third was a NON-EXPORTED pattern).
   *
   * So they are walked here, by the same two rules: no control character in the
   * source, and every pattern must fire on a known-positive fixture.
   */
  it("keeps its own claim maps live, not merely compiled", () => {
    const maps: Array<[string, Record<DictionaryLocale, RegExp>]> = [
      ["FUTURITY_FORMS", FUTURITY_FORMS],
      ["AVAILABILITY_CLAIM", AVAILABILITY_CLAIM],
      ["DENIAL_WORDING", DENIAL_WORDING],
    ];
    const positives: Record<string, Record<DictionaryLocale, string>> = {
      FUTURITY_FORMS: { en: "Coming soon", es: "Próximamente", fr: "Bientôt disponible", nl: "Binnenkort" },
      AVAILABILITY_CLAIM: { en: "included", es: "ya incluido", fr: "déjà disponible", nl: "inbegrepen" },
      DENIAL_WORDING: { en: "without", es: "sin", fr: "sans", nl: "zonder" },
    };
    const faults: string[] = [];
    let fired = 0;
    for (const [name, map] of maps) {
      const locales = Object.keys(map).sort();
      // A map that has quietly stopped covering a locale is the failure
      // `localeCoverageFaults` exists for, applied to this file's own maps.
      expect(locales, `${name} does not cover every locale`).toEqual([...DICTIONARY_LOCALES].sort());
      for (const locale of DICTIONARY_LOCALES) {
        const pattern = map[locale];
        if (/[\x00-\x1F\x7F]/.test(pattern.source)) {
          faults.push(`${name}.${locale}: control character in the pattern source`);
          continue;
        }
        if (!pattern.test(positives[name]![locale])) {
          faults.push(`${name}.${locale}: fires on nothing — inert`);
          continue;
        }
        fired += 1;
      }
    }
    expect(faults).toEqual([]);
    expect(fired, "no pattern fired").toBe(maps.length * DICTIONARY_LOCALES.length);
    // …and the check itself is not vacuous: a planted control character reds.
    expect(/[\x00-\x1F\x7F]/.test(new RegExp("coming\u0001soon").source)).toBe(true);
  });

  it("keeps every 'not yet' row reading as 'not yet', in all four locales", () => {
    const rows: Array<{ key: string; file: "marketing" | "ui"; shape: boolean }> = [
      ...Array.from({ length: 8 }, (_, i) => ({
        key: `pricing.plus.soon${i + 1}`,
        file: "marketing" as const,
        shape: true,
      })),
      // The ✗ column of the in-app Community panel — same negative-by-position
      // claim, different surface.
      { key: "billing.community.f5", file: "ui", shape: false },
      { key: "billing.community.f6", file: "ui", shape: false },
      { key: "billing.community.f7", file: "ui", shape: false },
    ];
    // The ✓ column, judged by the inverse rule (fresh probe D3).
    const TICKED: Array<{ key: string; file: "marketing" | "ui" }> = [
      { key: "billing.community.f1", file: "ui" },
      { key: "billing.community.f2", file: "ui" },
      { key: "billing.community.f3", file: "ui" },
      { key: "billing.community.f4", file: "ui" },
      ...[1, 2, 3, 4, 5, 6, 7].map((n) => ({ key: `billing.pro.f${n}`, file: "ui" as const })),
    ];
    const faults: string[] = [];
    let scanned = 0;
    for (const row of rows) {
      for (const locale of DICTIONARY_LOCALES) {
        const value = load(locale, row.file)[row.key];
        if (typeof value !== "string" || value.length === 0) {
          faults.push(`${locale} ${row.key}: missing`);
          continue;
        }
        scanned += 1;
        if (AVAILABILITY_CLAIM[locale].test(value)) {
          faults.push(`${locale} ${row.key}: "${value}" reads as already included`);
        }
        if (LOCALE_CLAIMS[locale].permanence.some((p) => p.test(value))) {
          faults.push(`${locale} ${row.key}: "${value}" makes a permanence claim`);
        }
        if (row.shape && CLAUSE_BREAK_IN_LABEL.test(value)) {
          faults.push(`${locale} ${row.key}: "${value}" is a sentence, not a roadmap label`);
        }
      }
    }
    for (const row of TICKED) {
      for (const locale of DICTIONARY_LOCALES) {
        const value = load(locale, row.file)[row.key];
        if (typeof value !== "string" || value.length === 0) {
          faults.push(`${locale} ${row.key}: missing`);
          continue;
        }
        scanned += 1;
        if (DENIAL_WORDING[locale].test(value)) {
          faults.push(`${locale} ${row.key}: "${value}" is shown with a ✓ but reads as a denial`);
        }
      }
    }
    expect(faults).toEqual([]);
    expect(scanned, "nothing scanned").toBe(
      (rows.length + TICKED.length) * DICTIONARY_LOCALES.length,
    );

    // ── THE TWO PROBES THAT DEFEATED THE ROUND-2 GUARDS ────────────────────
    const reds = (locale: DictionaryLocale, value: string, shape: boolean) =>
      AVAILABILITY_CLAIM[locale].test(value) ||
      LOCALE_CLAIMS[locale].permanence.some((p) => p.test(value)) ||
      (shape && CLAUSE_BREAK_IN_LABEL.test(value));

    for (const [locale, value] of [
      ["en", "Custom domain & white-label — included forever, on every plan"],
      ["es", "Dominio propio y marca blanca: incluido para siempre en todos los planes"],
      ["fr", "Domaine personnalisé et marque blanche — inclus pour toujours, sur tous les forfaits"],
      ["nl", "Eigen domein & white-label — voor altijd inbegrepen, bij elk abonnement"],
    ] as Array<[DictionaryLocale, string]>) {
      expect(reds(locale, value, true), `${locale}: roadmap item re-approved as shipped`).toBe(true);
    }
    // Fresh probe D3, the inverse: a ✓ row inverted in ONE locale.
    for (const [locale, value] of [
      ["en", "Online registration without entry fees"],
      ["es", "Inscripción online sin cuotas de inscripción"],
      ["fr", "Inscription en ligne sans frais d’inscription"],
      ["nl", "Online inschrijving zonder inschrijfgelden"],
    ] as Array<[DictionaryLocale, string]>) {
      expect(DENIAL_WORDING[locale].test(value), `${locale}: ticked row reading as a denial`).toBe(
        true,
      );
    }
    for (const [locale, value] of [
      ["en", "Theme colour & badge removal, included"],
      ["es", "Color del tema y quitar la insignia, incluido"],
      ["fr", "Couleur du thème et retrait du badge, inclus"],
      ["nl", "Themakleur & badge verwijderen, inbegrepen"],
    ] as Array<[DictionaryLocale, string]>) {
      expect(reds(locale, value, false), `${locale}: denial row reworded as included`).toBe(true);
    }
  });

  it("states futurity in every language, not just English", () => {
    for (const locale of DICTIONARY_LOCALES) {
      const label = load(locale, "marketing")["pricing.plus.soonLabel"]!;
      expect(label, `${locale}: no roadmap label`).toBeTruthy();
      expect(
        FUTURITY_FORMS[locale].test(label),
        `${locale}: "${label}" is not a recognised way of saying "not yet" — eight undelivered features sit under it`,
      ).toBe(true);
      // …AND it must not ALSO claim availability. The allowlist matched
      // anywhere, so "Now included, more soon" and "On the roadmap, and already
      // live" shipped green — 1 of 3. A label that says both says the wrong one.
      expect(
        AVAILABILITY_CLAIM[locale].test(label),
        `${locale}: "${label}" claims availability as well as futurity`,
      ).toBe(false);
      // A roadmap LABEL is a label, not a sentence — the same shape rule its
      // items carry, and what actually kills the "X, and already live" form.
      expect(CLAUSE_BREAK_IN_LABEL.test(label), `${locale}: "${label}" is a sentence`).toBe(false);
    }
    // The reviewer's probe: a plausible availability claim in each language must
    // NOT satisfy the rule, however it is re-approved.
    const labelReds = (locale: DictionaryLocale, value: string) =>
      !FUTURITY_FORMS[locale].test(value) ||
      AVAILABILITY_CLAIM[locale].test(value) ||
      CLAUSE_BREAK_IN_LABEL.test(value);
    for (const [locale, shipped] of [
      ["en", "Included now"],
      ["es", "Ya incluido"],
      ["fr", "Déjà inclus"],
      ["nl", "Nu inbegrepen"],
      // The two that defeated the round-3 allowlist by saying BOTH.
      ["en", "Now included, more soon"],
      ["en", "On the roadmap, and already live"],
      ["es", "Ya incluido, y más próximamente"],
      ["fr", "Déjà inclus, et bientôt plus"],
      ["nl", "Nu inbegrepen, binnenkort meer"],
    ] as Array<[DictionaryLocale, string]>) {
      expect(labelReds(locale, shipped), `${locale}: "${shipped}"`).toBe(true);
    }
    // …and the rule is not vacuous in the other direction: each locale's real
    // label is a positive fixture for its own pattern (asserted above), and a
    // second honest phrasing must also pass.
    for (const [locale, alt] of [
      ["en", "On the way"],
      ["es", "En desarrollo"],
      ["fr", "À venir"],
      ["nl", "In ontwikkeling"],
    ] as Array<[DictionaryLocale, string]>) {
      expect(labelReds(locale, alt), `${locale}: "${alt}" is honest and must pass`).toBe(false);
    }
  });

  it("the in-app panel's ticks and crosses agree with plan_entitlements", async () => {
    const features = [...new Set(PANEL_CLAIMS.flatMap((c) => c.features))];
    const rows = await sql<{ feature_key: string; plan_key: string; bool_value: boolean | null }[]>`
      select feature_key, plan_key, bool_value from plan_entitlements
      where feature_key = any(${features})`;
    expect(rows.length, "no rows for the panel's features").toBeGreaterThan(0);
    const grants: Record<string, Record<string, boolean | null>> = {};
    for (const r of rows) (grants[r.feature_key] ??= {})[r.plan_key] = r.bool_value;

    const faults: string[] = [];
    let checked = 0;
    for (const claim of PANEL_CLAIMS) {
      for (const feature of claim.features) {
        const value = grants[feature]?.[claim.plan];
        if (value === undefined) {
          faults.push(`${claim.key}: no ${claim.plan}/${feature} row — the row is pinned to nothing`);
          continue;
        }
        checked += 1;
        if (claim.polarity === "granted" && value !== true) {
          faults.push(`${claim.key}: shown with a ✓ but ${claim.plan} does not grant ${feature}`);
        }
        if (claim.polarity === "denied" && value === true) {
          faults.push(`${claim.key}: shown with a ✗ but ${claim.plan} DOES grant ${feature}`);
        }
      }
    }
    expect(faults).toEqual([]);
    expect(checked, "the polarity table resolved no rows").toBeGreaterThan(8);

    // The rule fires: the three rows this round corrected, as they shipped.
    const flipped: Record<string, Record<string, boolean | null>> = {
      ...grants,
      "dashboard.branding": { ...grants["dashboard.branding"], community: true },
    };
    const refaults: string[] = [];
    for (const claim of PANEL_CLAIMS.filter((c) => c.key === "billing.community.f6")) {
      for (const feature of claim.features) {
        if (claim.polarity === "denied" && flipped[feature]?.[claim.plan] === true) {
          refaults.push(`${claim.key}: shown with a ✗ but ${claim.plan} DOES grant ${feature}`);
        }
      }
    }
    expect(refaults, "a ✗ row whose feature is granted must red").not.toEqual([]);
  });

  /**
   * ── READ THE POLARITY FROM THE RENDERED STRUCTURE, NOT FROM A LINE ────────
   *
   * NINTH NORMALISER HOLE, and it failed in BOTH directions. Round 3 did
   * `page.split("\n").find(l => l.includes('"key"'))` then `line.includes("✗")`.
   * Wrap the `<li>` the way prettier does — `✗{" "}` and `{t(dict, key)}` on
   * separate lines — and the key's line carries no marker at all:
   *   a GRANTED row rendered with a ✗  -> green (Blocking 2's exact shape, back)
   *   an honest DENIED row, rewrapped  -> false RED
   *
   * So the parser now takes the whole `<li>…</li>` element the key sits in and
   * asks whether a denial marker appears anywhere inside it. Swapping ✗ for an
   * em dash was already caught; this closes the wrap.
   */
  const liFor = (key: string): string | null => {
    const at = BILLING_PAGE.indexOf(`"${key}"`);
    if (at === -1) return null;
    const open = BILLING_PAGE.lastIndexOf("<li", at);
    const close = BILLING_PAGE.indexOf("</li>", at);
    if (open === -1 || close === -1) return null;
    return BILLING_PAGE.slice(open, close);
  };
  /** Any way the page marks a row as NOT granted. */
  const DENIAL_MARKER = /[✗✘×✕]|\bline-through\b/;

  it("declares the polarity the billing page actually renders", () => {
    let read = 0;
    for (const claim of PANEL_CLAIMS) {
      const li = liFor(claim.key);
      expect(li, `${claim.key} is not rendered inside an <li> by the billing page`).toBeTruthy();
      read += 1;
      const rendered = DENIAL_MARKER.test(li!) ? "denied" : "granted";
      expect(rendered, `${claim.key}: page.tsx renders ${rendered}`).toBe(claim.polarity);
    }
    expect(read, "no rows read from the page").toBe(PANEL_CLAIMS.length);

    // The parser must survive a prettier rewrap — the defect above.
    const wrapped = [
      '<li className="text-slate-300">',
      '  ✗{" "}',
      '  {t(dict, "billing.community.f6")}',
      "</li>",
    ].join("\n");
    expect(DENIAL_MARKER.test(wrapped), "a rewrapped denial row must still read as denied").toBe(
      true,
    );
    const wrappedTick = ['<li>', '  ✓{" "}', '  {t(dict, "billing.pro.f5")}', "</li>"].join("\n");
    expect(DENIAL_MARKER.test(wrappedTick), "a rewrapped tick row must not read as denied").toBe(
      false,
    );
  });

  /**
   * …AND EVERY ROW THE PAGE RENDERS MUST BE IN THE TABLE.
   *
   * The completeness rule the cards have had since fix round 1, which I did not
   * give this table when I built it. Adding an eighth `<li>` claiming "Unlimited
   * AI schedule credits" scored zero faults.
   */
  it("classifies every panel row the page renders, or exempts it with a reason", () => {
    const declared = new Set(PANEL_CLAIMS.map((c) => c.key));
    const numeric: Record<string, string> = {
      "billing.community.f1": "a CAP, not a grant — pinned numerically against competitions.max_active",
      "billing.community.f2": "caps — pinned against divisions.per_competition.max and entrants.per_division.max",
      "billing.community.f3": "a cap — pinned against dashboard.public.max",
      "billing.pro.f1": "unlimited caps — pinned against competitions.max_active / divisions.per_competition.max",
      "billing.pro.f2": "a cap — pinned against entrants.per_division.max",
      "billing.pro.f3": "a rate — pinned against registration.fee_percent",
    };
    const unclassified = PANEL_KEYS.filter((k) => !declared.has(k) && !(k in numeric));
    expect(unclassified, "panel rows in neither PANEL_CLAIMS nor the numeric list").toEqual([]);
    // …and the inverse: a declared row the page no longer renders is a rule
    // pointing at nothing.
    expect(
      PANEL_CLAIMS.map((c) => c.key).filter((k) => !PANEL_KEYS.includes(k)),
      "declared rows the page does not render",
    ).toEqual([]);
    for (const [key, why] of Object.entries(numeric)) {
      expect(PANEL_KEYS, `${key} is classified but not rendered`).toContain(key);
      expect(why.length, `${key} has no reason`).toBeGreaterThan(20);
    }
    expect(PANEL_KEYS.length, "the page renders no panel rows — the regex broke").toBeGreaterThan(12);
  });


  it("the in-app Pro Plus panel says exactly what the /pricing card says", () => {
    for (const locale of DICTIONARY_LOCALES) {
      const marketing = load(locale, "marketing");
      const ui = load(locale, "ui");
      for (const n of [1, 2, 3, 4, 5]) {
        expect(ui[`billing.plus.f${n}`], `${locale} billing.plus.f${n}`).toBe(
          marketing[`pricing.plus.f${n}`],
        );
      }
    }
  });

  it("the in-app panel claims only differentiators Pro Plus has, and carries no retired prose", () => {
    const values: LocalisedValue[] = DICTIONARY_LOCALES.map((locale) => ({
      locale,
      key: "billing.plus.f1-f5",
      value: [1, 2, 3, 4, 5].map((n) => load(locale, "ui")[`billing.plus.f${n}`] ?? "").join(". "),
    }));
    for (const { locale, value } of values) {
      expect(value.length, `${locale}: the in-app panel is empty`).toBeGreaterThan(40);
    }
    expect(retiredClaimFaults(values, RETIRED_CLAIMS)).toEqual([]);
  });

  it("never sells the Event Pass as permanent, in any language, and says what bounds it", () => {
    expect(localePassBoundFaults(PASS_BOUND_VALUES)).toEqual([]);
  });

  it("carries none of the retired prose, in any locale", () => {
    expect(retiredClaimFaults(PASS_BOUND_VALUES, RETIRED_CLAIMS)).toEqual([]);
    expect(retiredClaimFaults(PLUS_VALUES, RETIRED_CLAIMS)).toEqual([]);
    // The Pro Plus CARD, which carried the four AI-scheduling literals in
    // RETIRED_CLAIMS for a whole round after the FAQ answer had dropped them.
    expect(retiredClaimFaults(PLUS_CARD_VALUES, RETIRED_CLAIMS)).toEqual([]);
  });

  // …and the registry really does hold the card's own retired wording, in every
  // locale. Without this the test above is satisfied by a registry that never
  // covered these four strings — absence proving "not false", never "scanned".
  it("holds the card's retired AI-scheduling wording, in all four locales", () => {
    for (const [locale, retired] of [
      ["en", "AI-assisted scheduling"],
      ["es", "Programación asistida por IA"],
      ["fr", "Planification assistée par IA"],
      ["nl", "AI-ondersteunde planning"],
    ] as Array<[DictionaryLocale, string]>) {
      expect(
        retiredClaimFaults([{ locale, key: "pricing.plus.f3", value: retired }], RETIRED_CLAIMS),
        `${locale}: ${retired}`,
      ).not.toEqual([]);
    }
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
    expect(localeHalfClaimFaults(HALF_CLAIM_VALUES, shape)).toEqual([]);
    expect(HALF_CLAIM_VALUES).toHaveLength(
      (HALF_CLAIM_KEYS.length + HALF_CLAIM_UI_KEYS.length) * DICTIONARY_LOCALES.length,
    );
  });

  /**
   * `config/tips.ts` IS NOT WHAT RENDERS, and this is the guard that makes that
   * safe (v17 gap wave 7, task 7).
   *
   * `components/ui/tip.tsx` reads `msg("tips.<id>.title")` and
   * `msg("tips.<id>.body")` from these four dictionaries; the TypeScript
   * literals in `config/tips.ts` are the source of truth the en dictionary
   * mirrors, and nothing else. So correcting a falsehood in `tips.ts` alone is
   * a change no customer ever sees — a whole class of cosmetic fix that reads
   * as done. It was live here: `tips.billing.extra-org.body` carried "half your
   * plan's rate" in all four dictionaries while three other surfaces of the
   * same claim were being corrected.
   *
   * Pinned as a MIRROR (assert one equals the other) rather than as two pinned
   * strings, because that is what makes editing either one insufficient on its
   * own. `extra-org-price-parity.test.ts` already lists both as "copy that says
   * half"; this is what stops them drifting apart.
   */
  //
  // EN-ONLY, DELIBERATELY. `config/tips.ts` holds one English string per tip, so
  // there is nothing for es/fr/nl to mirror — a Dutch value that equalled the
  // TypeScript literal would mean the Dutch page renders English. What binds the
  // other three locales is `i18n:check` (every key present in every locale) plus
  // the approved-copy gate for the values that make a pinned claim. A tip whose
  // claim is NOT pinned can still drift in translation; that is the gap, and it
  // is the same one every unpinned dictionary value has.
  const TIP_MIRROR_EXCEPTIONS: Record<string, string> = {
    // PRE-EXISTING, and NOT this task's to fix: both sides are stale against
    // `plan_entitlements.schedule.checkpoints.max` (community 2 since V319, pro
    // 5, pro_plus unlimited). `tips.ts` says "One save point is free, Pro
    // includes five, Pro Plus is unlimited" — wrong about Community. The
    // dictionary says "One save point is free; more need Pro" — wrong about
    // Community AND silent about Pro Plus. Fixing it is a four-locale copy
    // change in a different claim family; listing it keeps it visible.
    "tips.schedule.save-points.body":
      "#303 — both sides stale vs schedule.checkpoints.max (community 2 since V319, pro 5, pro_plus unlimited). tips.ts says 'One save point is free' (V290's 1, not V319's 2); the dictionary says 'more need Pro' and is silent on Pro Plus. A four-locale copy change in a different claim family, tracked with this wave's other out-of-scope copy defects.",
  };

  it("keeps config/tips.ts and the en dictionary identical — a tips.ts-only fix is cosmetic", () => {
    const en = load("en", "ui");
    const drift: string[] = [];
    let compared = 0;
    for (const [id, tip] of Object.entries(TIPS)) {
      for (const field of ["title", "body"] as const) {
        const key = `tips.${id}.${field}`;
        if (key in TIP_MIRROR_EXCEPTIONS) continue;
        const onDisk = en[key];
        if (onDisk === undefined) {
          drift.push(`${key}: in config/tips.ts but ABSENT from en/ui.json`);
          continue;
        }
        compared += 1;
        if (onDisk !== tip[field]) {
          drift.push(
            [
              `${key}: config/tips.ts and en/ui.json disagree.`,
              `  tips.ts:    ${tip[field]}`,
              `  ui.json:    ${onDisk}`,
              "  ui.json is what renders (components/ui/tip.tsx). Fix BOTH, and all four locales.",
            ].join("\n"),
          );
        }
      }
    }
    expect(drift).toEqual([]);
    // ANTI-VACUITY: an exception list that grew to cover everything, or a TIPS
    // export that got renamed, would leave this comparing nothing.
    expect(compared, "the mirror compared nothing").toBeGreaterThan(40);
    for (const key of Object.keys(TIP_MIRROR_EXCEPTIONS)) {
      expect(key in en, `${key} is excepted but does not exist`).toBe(true);
    }
  });

  // …and the mirror really does fire. Absence of drift proves "identical" only
  // if a difference would have been reported.
  it("reports a tip whose dictionary value drifts from config/tips.ts", () => {
    const key = "tips.billing.extra-org.body";
    expect(load("en", "ui")[key], "the tip moved — re-point this guard").toBe(
      TIPS["billing.extra-org"].body,
    );
    expect(TIPS["billing.extra-org"].body).not.toBe(
      "Each organisation after the first is half your plan's rate.",
    );
    // The half-rate rule is what would have caught the drifted value, had it
    // ever been pointed at this key. It is now, and it fires on the old wording.
    expect(
      localeHalfClaimFaults(
        [{ locale: "en", key, value: "Each organisation after the first is half your plan's rate." }],
        "atMost",
      ),
    ).not.toEqual([]);
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

  // ── The Pro Plus CARD, the surface the FAQ answer above had left behind ────

  it("the card claims only differentiators Pro Plus actually has, in all four locales", async () => {
    const grants = await grantsFor([
      "scheduling.ai",
      "officials.auto",
      "api.write",
      "support.priority",
    ]);
    expect(localePlusDifferentiatorFaults(PLUS_CARD_VALUES, grants, ["community", "pro"])).toEqual([]);
    // …and the PRE-FIX bullet, in its own language, so this fails without the
    // copy change rather than merely passing beside it.
    const preFix: LocalisedValue[] = (
      [
        ["en", "AI-assisted scheduling. Auto officials assignment"],
        ["es", "Programación asistida por IA. Asignación automática de árbitros"],
        ["fr", "Planification assistée par IA. Attribution automatique des officiels"],
        ["nl", "AI-ondersteunde planning. Automatische toewijzing van officials"],
      ] as Array<[DictionaryLocale, string]>
    ).map(([locale, value]) => ({ locale, key: "pre-fix", value }));
    const faults = localePlusDifferentiatorFaults(preFix, grants, ["community", "pro"]).join(" | ");
    for (const locale of DICTIONARY_LOCALES) {
      expect(faults, `${locale}: the pre-fix bullet must red`).toContain(
        `${locale} pre-fix: sells scheduling.ai as a Pro Plus differentiator`,
      );
    }
  });

  // FRESH PROBE G8: the FAQ directly under the cards names each plan's
  // organisation cap ("Pro covers up to 5 organisations on one bill and Pro Plus
  // up to 10"). It was PINNED as copy and pinned to nothing else, so moving
  // `orgs.max_owned` left the sentence green and false — the same copy-copy
  // failure the card numbers had. Task 7 pins the add-ons article's version of
  // this sentence the same way; this is its /pricing sibling.
  it("the FAQ quotes each plan's live organisation cap, in all four locales", async () => {
    const rows = await sql<{ plan_key: string; int_value: number | null }[]>`
      select plan_key, int_value from plan_entitlements where feature_key = 'orgs.max_owned'`;
    const caps = Object.fromEntries(rows.map((r) => [r.plan_key, r.int_value]));
    for (const plan of ["pro", "pro_plus"]) {
      expect(caps[plan], `plan_entitlements has no ${plan}/orgs.max_owned row`).toBeDefined();
      expect(caps[plan], `${plan} must have a finite org cap for this sentence`).not.toBeNull();
    }
    for (const { locale, value } of PLUS_VALUES) {
      // Numerals are identical across these four locales, so the digits are
      // checkable without reading the prose around them.
      expect(value, `${locale}: pro's live org cap`).toContain(String(caps.pro));
      expect(value, `${locale}: pro_plus's live org cap`).toContain(String(caps.pro_plus));
    }
  });

  it("the card's AI claim is the comparative the credit rows back, in all four locales", async () => {
    const credits = await monthlyCredits();
    expect(localeCreditLeadershipFaults(PLUS_CARD_VALUES, credits)).toEqual([]);
    // Paired both ways: DELETING the replacement claim must red too, or the card
    // could simply stop saying anything about AI and pass — which is what an
    // absence-shaped rule is happiest with. Proved per locale, because the
    // comparative is the one claim with a different regex in each language.
    for (const locale of DICTIONARY_LOCALES) {
      expect(
        localeCreditLeadershipFaults(
          [{ locale, key: "no-claim", value: load(locale, "marketing")["pricing.plus.f4"]! }],
          credits,
        ),
        locale,
      ).toEqual([`${locale} no-claim: never claims the largest monthly AI credit grant`]);
    }
    // …and it must stop being true the day the matrix moves.
    expect(
      localeCreditLeadershipFaults(PLUS_CARD_VALUES, { ...credits, pro: 500 }).join(" "),
    ).toContain("but pro_plus grants 200");
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

  /**
   * THE HONEST NUMBER, and the reason this suite's primary rule is now a pinned
   * string rather than a vocabulary.
   *
   * Written AFTER the rules were final for this round — ordinary editorial
   * prose, including the five phrasings the reviewer cited. No rule was
   * adjusted to accommodate any of it. Measured: **1 of 40**, with en, es and
   * fr at zero.
   *
   * That is not a bug to be fixed by widening. It is the third and fourth
   * independent measurement of the same property: a rule that reads the
   * sentence scores on the examples its author imagined. Task 3 went 12/12 to
   * 6/30, task 4 went 16/16 to 0/32 to 1/40. Every round of widening has moved
   * the tuned number and left the fresh one on the floor.
   *
   * The rate is asserted so that it stays VISIBLE. If someone widens the
   * vocabulary the number rises and they must update it deliberately — which is
   * the only way an improvement here is distinguishable from a coincidence.
   */
  it("records what the vocabulary actually catches on prose it has never seen", () => {
    const detected = Object.entries(FRESH).flatMap(([locale, lines]) =>
      lines.filter(
        (s) =>
          localePassBoundFaults(v(locale as DictionaryLocale, `${BOUNDED[locale as DictionaryLocale]} ${s}`))
            .length > 0,
      ),
    );
    const total = Object.values(FRESH).flat().length;
    expect(total).toBe(40);
    expect(
      detected.length,
      "the vocabulary's measured recall on unseen prose — update deliberately, and say why",
    ).toBe(1);
  });

  /**
   * …AND WHAT ACTUALLY PROTECTS THE SHIPPED COPY.
   *
   * The same 40 sentences, appended to the real approved values: the
   * approved-wording gate reds on **40 of 40**, because it does not care how
   * the falsehood is phrased. This is the whole argument for the architecture,
   * made as a measurement rather than an assertion.
   */
  it("the approved-wording gate catches all 40, where the vocabulary caught 1", () => {
    const entry = APPROVED_DICTIONARY_COPY.find((e) => e.key === "pricing.faq.eventPass.a")!;
    const missed: string[] = [];
    for (const [locale, lines] of Object.entries(FRESH) as Array<[DictionaryLocale, string[]]>) {
      for (const line of lines) {
        const tampered = `${entry.text[locale]} ${line}`;
        const faults = approvedDictionaryFaults([entry], (file, l) =>
          l === locale
            ? { ...load(l, file), [entry.key]: tampered }
            : load(l, file),
        );
        if (faults.length === 0) missed.push(`${locale}: ${line}`);
      }
    }
    expect(missed, `the gate missed: ${missed.join(" | ")}`).toEqual([]);
  });

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
   * NEW-2, the regression fix round 1 introduced and this round removes.
   *
   * Round 1 answered "is this claim about the rate?" by DROPPING any clause
   * that named a rate and not the pass. Pass copy quotes percentages
   * constantly — `pricing.faq.eventPass.a` carries 5% in every locale — so the
   * exemption sat exactly on the surface it was guarding, and these nine went
   * GREEN (they had all redded before round 1). The repair narrows the MATCH
   * instead: a permanence hit is attributed to the rate only when no
   * coordinator and no pass noun intervene.
   */
  it("attributes a permanence claim to the pass even when the clause quotes a rate", () => {
    const missed = (
      [
        ["en", "It is a one-off at the 5% rate and it lasts forever."],
        ["en", "Your 5% fee and the bigger limits it brings never end."],
        ["en", "The 5% rate applies and it is yours to keep."],
        ["es", "Es un pago único al 5% de comisión y dura para siempre."],
        ["es", "Tu comisión del 5% y los límites que trae no caducan nunca."],
        ["fr", "C'est un paiement unique à 5 % de frais et cela dure pour toujours."],
        ["fr", "Vos 5 % de frais et les limites qu’il apporte ne se terminent jamais."],
        ["nl", "Jouw 5% kosten en de ruimere limieten kennen geen einde."],
        ["nl", "Het 5% tarief geldt en het blijft voor altijd van jou."],
      ] as Array<[DictionaryLocale, string]>
    ).filter(([locale, s]) => localePassBoundFaults(v(locale, `${BOUNDED[locale]} ${s}`)).length === 0);
    expect(missed, `still exempted: ${missed.map(([, s]) => s).join(" | ")}`).toEqual([]);
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
      // No percentage anywhere in this one. All three round-1 fixtures happened
      // to carry a literal 5%, which hid en.rateSubject having no bare `fee`.
      ["en", "Its fee stays locked for good once a first entry is paid"],
      ["en", "The platform fee is fixed permanently after the first paid entry"],
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
  const MODULE_SOURCE = readFileSync("src/lib/copy-truth.ts", "utf8");

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

  // NEW-1: `collectPatterns` walks module EXPORTS, so a top-level pattern that is
  // not exported is invisible to every rule above. Seven were — including
  // DURATION_CLAIM, which this check cites as its own reason for existing.
  // Measured: a literal U+0001 in DURATION_CLAIM left this suite 36/36 green,
  // while the same byte in an exported pattern redded three tests.
  it("exports every top-level pattern, so none is exempt from the checks above", () => {
    expect(unexportedPatternFaults(MODULE_SOURCE)).toEqual([]);
  });

  // …and the control-character scan run over the RAW SOURCE, which reaches what
  // the compiled-pattern scan cannot: non-exported consts, String.raw fragments
  // that are only ever composed into other patterns, and ordinary prose.
  it("has no literal control character anywhere in its source", () => {
    expect(sourceControlCharacterFaults(MODULE_SOURCE)).toEqual([]);
  });

  // …and the corpus itself must not rot into a list nothing reads: if a fixture
  // matches no pattern at all, it is dead weight that hides the next gap.
  it("keeps no fixture that no pattern matches", () => {
    const unused = KNOWN_POSITIVES.filter((text) => !patterns.some(({ pattern }) => pattern.test(text)));
    expect(unused, "corpus lines matched by nothing").toEqual([]);
  });
});
