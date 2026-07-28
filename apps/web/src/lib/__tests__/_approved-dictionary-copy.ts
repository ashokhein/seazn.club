// THE APPROVED WORDING of the four-locale dictionary strings that make claims
// about the Event Pass and the extra-organisation rate.
//
// ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
// Sibling of _approved-copy.ts, which does the same job for the help articles,
// and it exists for the same measured reason.
//
// Every rule in dictionary-copy-truth reads the sentence and decides whether it
// is false. Four independent measurements in this wave say that shape scores on
// the examples its author imagined and collapses on anyone else's:
//
//   task 3: 12/12 on its own tuned set, 6/30 on a fresh set by the same author
//   task 4: 16/16 on its own rewordings, 0/32 on an adversarial set
//   task 4 round 2: still 0/9 on the reviewer's percentage-shaped rate clauses
//
// And the falsehood that survived TWO rounds of vocabulary widening was not
// exotic at all — pricing.faq.groups.a said "half your plan's rate", bare, in
// all four locales, three cards from the answer that had just been corrected to
// "no more than half". The pattern for it EXISTED (en.halfClaim spells that
// phrase out); nothing ever pointed the rule at that key.
//
// This file is the positive half. It does not generalise, so there is no
// phrasing that evades it, and it does not depend on anyone remembering to
// write a pattern for a claim family: the string either is the approved string
// or it is not.
//
// ── IF A TEST SENT YOU HERE ──────────────────────────────────────────────────
// The test is a GATE, not a bug. You changed one of these strings, and the
// change needs one deliberate step before it ships:
//
//   1. Read your new wording against the code it describes — the source of
//      truth is named in each entry's `why`, and it is a file path, not a
//      memory.
//   2. Paste the failing test's "on disk:" string into that entry's `text`.
//   3. Say in the commit message what changed and what you checked it against.
//
// Because all four locales sit side by side, a translation that drifts from the
// English is visible here as a diff rather than invisible in another file.
import type { DictionaryLocale } from "@/lib/copy-truth";

export interface ApprovedValue {
  /** Which dictionary file the key lives in. */
  file: "marketing" | "ui";
  /** Flat dotted key. Dictionaries are FLAT JSON — never nested. */
  key: string;
  /** What the string claims, and the code that decides whether it is true. */
  why: string;
  /** The approved wording, per locale. */
  text: Record<DictionaryLocale, string>;
}

export const APPROVED_DICTIONARY_COPY: ApprovedValue[] = [
  {
    file: "marketing",
    key: "pricing.pass.note",
    why: "the pass's DURATION, on the public pricing card. It said 'Yours for the event's lifetime' until this wave. Source of truth: V328/V334 (org_has_feature's pass arm drops out once the competition is archived/completed or 7 days past ends_on) and lib/entitlements.ts isPassLocked.",
    text: {
      en: "One-time. No subscription. Yours while the competition is running.",
      es: "Pago único. Sin suscripción. Tuyo mientras la competición está en curso.",
      fr: "Ponctuel. Sans abonnement. À vous tant que la compétition est en cours.",
      nl: "Eenmalig. Geen abonnement. Van jou zolang de competitie loopt.",
    },
  },
  {
    file: "marketing",
    key: "pricing.faq.eventPass.a",
    why: "what the pass buys, for how long, and the size of the one-time credit grant. Caps come from plan_entitlements (event_pass / event_pass_l); the grant is PASS_CREDIT_GRANT in lib/pricing-cards.ts and is FLAT across rungs; the duration is V328/V334.",
    text: {
      en: "One competition, for as long as it’s running. The M pass ({pass}) gives that competition 10 divisions and 128 entrants per division; the L pass ({passL}) takes the same competition to 20 divisions and no entrant limit at all. Either way you get advanced formats, exports and realtime, the same one-time +25 AI credits added to your wallet, and a 5% platform fee on its entry fees instead of Community’s 8% — and it stops counting against your free active-competition slot. Pick the size at checkout; a competition holds one pass and keeps it. Your club logo and card entry fees work on every plan already, pass or no pass. Other competitions in your org stay on Community limits.",
      es: "Una competición, mientras está en curso. El pase M ({pass}) le da a esa competición 10 divisiones y 128 participantes por división; el pase L ({passL}) lleva la misma competición a 20 divisiones y sin ningún límite de participantes. En ambos casos obtienes formatos avanzados, exportaciones y tiempo real, los mismos +25 créditos de IA de una sola vez añadidos a tu monedero, y una comisión de plataforma del 5% sobre sus cuotas de inscripción en lugar del 8% de Community — y deja de contar en tu cupo gratuito de competiciones activas. Elige el tamaño al pagar; una competición tiene un solo pase y lo conserva. El logotipo de tu club y las cuotas con tarjeta ya funcionan en todos los planes, con pase o sin él. Otras competiciones de tu organización se mantienen con los límites de Community.",
      fr: "Une compétition, tant qu’elle est en cours. Le pass M ({pass}) donne à cette compétition 10 divisions et 128 participants par division ; le pass L ({passL}) porte la même compétition à 20 divisions et sans aucune limite de participants. Dans les deux cas vous bénéficiez des formats avancés, des exports et du temps réel, des mêmes +25 crédits IA ponctuels ajoutés à votre portefeuille, ainsi que de 5 % de frais de plateforme sur ses frais d’inscription au lieu des 8 % de Communauté — et elle cesse de compter dans votre quota gratuit de compétition active. Choisissez la taille au moment de payer ; une compétition détient un seul pass et le conserve. Le logo de votre club et les frais d’inscription par carte fonctionnent déjà sur tous les forfaits, avec ou sans pass. Les autres compétitions de votre organisation restent soumises aux limites Communauté.",
      nl: "Één competitie, zolang ze loopt. De M-pass ({pass}) geeft die competitie 10 divisies en 128 deelnemers per divisie; de L-pass ({passL}) tilt dezelfde competitie naar 20 divisies en helemaal geen deelnemerslimiet. In beide gevallen krijg je geavanceerde formats, exports en realtime, dezelfde eenmalige +25 AI-credits in je wallet, plus 5% platformkosten op de inschrijfgelden in plaats van de 8% van Community — en telt de competitie niet meer mee voor je gratis actieve-competitieplek. Kies de maat bij het afrekenen; een competitie heeft één pass en houdt die. Het logo van je club en inschrijfgelden per kaart werken al bij elk abonnement, met of zonder pass. Andere competities in je organisatie blijven op de Community-limieten.",
    },
  },
  {
    file: "marketing",
    key: "pricing.faq.upgraded.a",
    why: "what happens to a pass when the org is on Pro and when Pro is cancelled. Source of truth: V338 org_has_feature — the pass arm requires the resolved plan to be 'community', and the canceled arm resolves 'community'; pass rows are deleted only on refund/dispute (usecases/billing-events.ts, lib/billing.ts), never on a plan change. NOTE #337: 'Pro covers everything the pass does' is the INTENDED principle but is not true today (entrants.per_division.max is unlimited on event_pass_l, 256 on pro), so this answer deliberately asserts neither.",
    text: {
      en: "While you're on Pro, Pro's own limits apply across the whole organisation, so the pass sits dormant. If you ever cancel Pro the pass applies again, for as long as that competition is still running — a pass is tied to the competition it was bought for and stops with it.",
      es: "Mientras estés en Pro se aplican los límites de Pro en toda la organización, así que el pase queda inactivo. Si alguna vez cancelas Pro, el pase vuelve a aplicarse mientras esa competición siga en curso: un pase está ligado a la competición para la que se compró y termina con ella.",
      fr: "Tant que vous êtes en Pro, ce sont les limites de Pro qui s'appliquent à toute l'organisation et le pass reste en veille. Si vous annulez Pro, le pass s'applique de nouveau tant que cette compétition est encore en cours : un pass est lié à la compétition pour laquelle il a été acheté et s'arrête avec elle.",
      nl: "Zolang je Pro hebt gelden de limieten van Pro voor de hele organisatie en ligt de pass slapend. Zeg je Pro op, dan geldt de pass weer zolang die competitie nog loopt: een pass hoort bij de competitie waarvoor hij gekocht is en stopt daarmee.",
    },
  },
  {
    file: "marketing",
    key: "pricing.faq.groups.a",
    why: "the extra-organisation rate. 'half your plan's rate' unqualified is false — the seed rounds the rider DOWN (usd pro monthly 1900 -> 900 = 47.4%) while eur/aud land on exact halves, so only 'no more than half' is true in all twenty plan x interval x currency combinations. Source of truth: config/stripe-plans.json graduated tiers, via riderClaimShape.",
    text: {
      en: "Yes. A subscription is a billing group: it can hold several organisations under one card and one invoice, and each organisation after the first costs no more than half your plan’s rate. Every organisation in the group runs on the group’s plan, so joining a Pro Plus group takes an organisation’s entry-fee rate from 8% to 1%. Payouts are untouched — each organisation keeps its own Stripe account and its own bank details.",
      es: "Sí. Una suscripción es un grupo de facturación: puede incluir varias organizaciones con una sola tarjeta y una sola factura, y cada organización a partir de la primera cuesta no más de la mitad de la tarifa de tu plan. Todas las organizaciones del grupo funcionan con el plan del grupo, así que unirse a un grupo Pro Plus baja la comisión de inscripción de una organización del 8% al 1%. Los pagos no cambian: cada organización conserva su propia cuenta de Stripe y sus propios datos bancarios.",
      fr: "Oui. Un abonnement est un groupe de facturation : il peut réunir plusieurs organisations sous une seule carte et une seule facture, et chaque organisation après la première coûte au plus la moitié du tarif de votre forfait. Toutes les organisations du groupe fonctionnent avec le forfait du groupe : rejoindre un groupe Pro Plus fait passer les frais d’inscription d’une organisation de 8 % à 1 %. Les reversements ne changent pas : chaque organisation conserve son propre compte Stripe et ses propres coordonnées bancaires.",
      nl: "Ja. Een abonnement is een facturatiegroep: het kan meerdere organisaties omvatten met één kaart en één factuur, en elke organisatie na de eerste kost hoogstens de helft van het tarief van je abonnement. Elke organisatie in de groep draait op het abonnement van de groep, dus toetreden tot een Pro Plus-groep brengt het inschrijfkostenpercentage van een organisatie van 8% naar 1%. Uitbetalingen veranderen niet: elke organisatie houdt haar eigen Stripe-account en haar eigen bankgegevens.",
    },
  },
  {
    file: "marketing",
    key: "pricing.faq.proPlus.a",
    why: "Pro Plus's differentiators and the extra-organisation rate. Every claim after 'Everything in Pro, plus' asserts EXCLUSIVITY, so each must be a feature lower plans lack: scheduling.ai is granted on all five plan keys and must NOT appear here. Source of truth: plan_entitlements (officials.auto, api.write, support.priority are pro_plus-only; ai.credits.monthly is 10/60/200).",
    text: {
      en: "Everything in Pro, plus unlimited members, teams and clubs inside every organisation, a 1% platform fee, the largest monthly AI credit grant, auto officials assignment, write API access and priority support. Pro is {pro}/month; Pro Plus is {plus}/month or {plusAnnual}/year. Pro covers up to 5 organisations on one bill and Pro Plus up to 10, each extra one at no more than half the base rate.",
      es: "Todo lo de Pro, más miembros, equipos y clubes ilimitados dentro de cada organización, comisión de plataforma del 1 %, la mayor dotación mensual de créditos de IA, asignación automática de árbitros, acceso de escritura a la API y soporte prioritario. Pro cuesta {pro}/mes; Pro Plus cuesta {plus}/mes o {plusAnnual}/año. Pro cubre hasta 5 organizaciones en una sola factura y Pro Plus hasta 10, cada una adicional por no más de la mitad de la tarifa base.",
      fr: "Tout ce qu’offre Pro, plus des membres, équipes et clubs illimités au sein de chaque organisation, 1 % de frais de plateforme, la dotation mensuelle de crédits IA la plus élevée, l’attribution automatique des officiels, l’accès API en écriture et une assistance prioritaire. Pro est à {pro}/mois ; Pro Plus est à {plus}/mois ou {plusAnnual}/an. Pro couvre jusqu’à 5 organisations sur une seule facture et Pro Plus jusqu’à 10, chaque organisation supplémentaire pour au plus la moitié du tarif de base.",
      nl: "Alles van Pro, plus onbeperkt leden, teams en clubs binnen elke organisatie, 1% platformkosten, het grootste maandelijkse AI-credittegoed, automatische toewijzing van officials, schrijftoegang tot de API en prioritaire ondersteuning. Pro is {pro}/maand; Pro Plus is {plus}/maand of {plusAnnual}/jaar. Pro dekt tot 5 organisaties op één factuur en Pro Plus tot 10, elke extra organisatie voor hoogstens de helft van het basistarief.",
    },
  },
  // ── The Pro Plus CARD (v17 gap wave 7, #299) ───────────────────────────────
  //
  // `pricing.faq.proPlus.a` above is the ANSWER three cards down the page. These
  // six keys are the CARD itself — the frame plus its five bullets — and until
  // this task they were the only Pro Plus surface nothing pinned. The result was
  // a page that disagreed with itself: the FAQ had dropped "AI-assisted
  // scheduling" as a differentiator while the card two screens above still sold
  // it. Pinned as its own claim family, the way the pass-permanence and
  // half-rate families already are.
  //
  // The frame is pinned WITH the bullets deliberately: "Everything in Pro,
  // plus…" is what makes each bullet an assertion of exclusivity, so a reword
  // that drops it would leave the differentiator rules with nothing to scope to.
  {
    file: "marketing",
    key: "pricing.plus.note",
    why: "the frame the five Pro Plus card bullets are read under. It is what turns each bullet into a claim of EXCLUSIVITY, so dropping it silently changes what f1-f5 mean. Source of truth: app/[lang]/(marketing)/pricing/page.tsx renders it directly above the f1-f5 list.",
    text: {
      en: "Everything in Pro, plus…",
      es: "Todo lo de Pro, más…",
      fr: "Tout ce qu'offre Pro, plus…",
      nl: "Alles van Pro, plus…",
    },
  },
  {
    file: "marketing",
    key: "pricing.plus.f1",
    why: "unlimited members, teams and clubs. Source of truth: plan_entitlements members.max / teams.max / clubs.max — all null (unlimited) on pro_plus, and capped on pro (15 / 40 / 20), so the claim is both true and a genuine differentiator.",
    text: {
      en: "Unlimited members, teams & clubs",
      es: "Miembros, equipos y clubes ilimitados",
      fr: "Membres, équipes et clubs illimités",
      nl: "Onbeperkt aantal leden, teams & clubs",
    },
  },
  {
    file: "marketing",
    key: "pricing.plus.f2",
    why: "the entry-fee platform rate on Pro Plus. Source of truth: plan_entitlements registration.fee_percent — 1 on pro_plus against 2 on pro and 8 on community.",
    text: {
      en: "1% platform fee on entry fees",
      es: "Comisión de plataforma del 1% en las cuotas de inscripción",
      fr: "Frais de plateforme de 1 % sur les frais d'inscription",
      nl: "1% platformkosten op inschrijfgelden",
    },
  },
  {
    file: "marketing",
    key: "pricing.plus.f3",
    why: "THE BULLET THIS TASK FIXED. It read 'AI-assisted scheduling' (four locales) under the 'Everything in Pro, plus…' frame while plan_entitlements grants scheduling.ai on ALL FIVE plan keys — community, event_pass, event_pass_l, pro and pro_plus — so it differentiated nothing. The replacement is the one AI claim the matrix does back: ai.credits.monthly is 10 / 60 / 200, so pro_plus really does carry the largest monthly grant. It is a COMPARATIVE, judged by localeCreditLeadershipFaults against those numbers, not by a boolean grant. Mirrored in English by PLUS_CARD_FEATURES[2] in lib/pricing-cards.ts.",
    text: {
      en: "Largest monthly AI credit grant",
      es: "Mayor dotación mensual de créditos de IA",
      fr: "La plus grosse dotation mensuelle de crédits IA",
      nl: "Grootste maandelijkse AI-credittegoed",
    },
  },
  {
    file: "marketing",
    key: "pricing.plus.f4",
    why: "automatic officials assignment. Source of truth: plan_entitlements officials.auto — false on community and pro, true on pro_plus, so it is a real differentiator under the frame.",
    text: {
      en: "Auto officials assignment",
      es: "Asignación automática de árbitros",
      fr: "Attribution automatique des officiels",
      nl: "Automatische toewijzing van officials",
    },
  },
  {
    file: "marketing",
    key: "pricing.plus.f5",
    why: "write-scoped API keys and priority support. Source of truth: plan_entitlements api.write and support.priority — both false on community and pro, true on pro_plus. (api.read/api.access is granted on pro, so the WRITE qualifier is load-bearing and must not be dropped in translation.)",
    text: {
      en: "Write API access & priority support",
      es: "Acceso de escritura a la API y soporte prioritario",
      fr: "Accès API en écriture et assistance prioritaire",
      nl: "Schrijftoegang tot de API & prioritaire ondersteuning",
    },
  },
  {
    file: "ui",
    key: "upgrade.intro",
    why: "the in-app Event Pass purchase page, read immediately before paying (/o/[orgSlug]/c/[compSlug]/upgrade). Same duration claim as pricing.pass.note. Source of truth: V328/V334.",
    text: {
      en: "One payment upgrades this competition while it’s running — no subscription, and it stays in place even if you never go Pro.",
      es: "Un solo pago mejora esta competición mientras está en curso — sin suscripción, y se mantiene aunque nunca pases a Pro.",
      fr: "Un seul paiement améliore cette compétition tant qu’elle est en cours — pas d’abonnement, et cela reste en place même si vous ne passez jamais à Pro.",
      nl: "Eén betaling upgradet deze competitie zolang ze loopt — geen abonnement, en dat blijft zo, ook als je nooit Pro neemt.",
    },
  },
  {
    file: "ui",
    key: "upgrade.active.body",
    why: "the same page once the pass is held. Source of truth: V328/V334.",
    text: {
      en: "This competition is upgraded while it’s running — divisions, entrants, formats, fees, branding and exports are all unlocked here.",
      es: "Esta competición está mejorada mientras está en curso — divisiones, participantes, formatos, cuotas, personalización y exportaciones están todos desbloqueados aquí.",
      fr: "Cette compétition est améliorée tant qu’elle est en cours — divisions, participants, formats, frais, image de marque et exports sont tous débloqués ici.",
      nl: "Deze competitie is geüpgraded zolang ze loopt — divisies, deelnemers, formats, kosten, branding en exports zijn hier allemaal ontgrendeld.",
    },
  },
  {
    file: "ui",
    key: "billing.passOffer.note",
    why: "the Settings -> Billing offer card (components/billing-pass-offer.tsx). Two claims: the pass's duration (V328/V334) and that a passed competition stops counting against competitions.max_active — the latter is TRUE, enforced by `not exists (select 1 from competition_passes ...)` in usecases/competitions.ts and usecases/entitlement-freeze.ts.",
    text: {
      en: "From {price} once, upgrade a single competition while it’s running — and a competition with a pass stops counting against your active-competition limit.",
      es: "Desde {price} una sola vez, mejora una única competición mientras está en curso: y una competición con pase deja de contar para tu límite de competiciones activas.",
      fr: "À partir de {price} en une fois, améliorez une seule compétition tant qu’elle est en cours — et une compétition avec un pass cesse de compter dans votre limite de compétitions actives.",
      nl: "Vanaf {price} eenmalig upgrade je één competitie zolang ze loopt — en een competitie met een pass telt niet meer mee voor je limiet van actieve competities.",
    },
  },
  {
    file: "marketing",
    key: "pricing.final.subhead",
    why: "the closing CTA under the cards, and it makes three claims at once: that signing up needs no card (Community creates no Stripe customer — usecases/orgs.ts mints one only at checkout), that a SINGLE EVENT can be upgraded (the Event Pass, competition-scoped per V328/V334), and that the whole club can be upgraded instead (Pro/Pro Plus, org-scoped). Found by PRICING_KEY_DISPOSITION, which is the point of that rule — nobody had noticed this string made a claim at all.",
    text: {
      en: "No card required. Upgrade a single event, or the whole club, when it grows.",
      es: "Sin tarjeta. Mejora un solo evento, o todo el club, cuando crezca.",
      fr: "Aucune carte requise. Améliorez un seul événement, ou tout le club, lorsqu'il grandit.",
      nl: "Geen kaart nodig. Upgrade één evenement of de hele club wanneer die groeit.",
    },
  },
  {
    file: "marketing",
    key: "pricing.pass.included",
    why: "the Event Pass column when a PAID org views it (pass-cta.ts `included`). It said \"Your plan already includes everything here\", which asserts Pro superset-of-pass — the same claim #337 records as INTENDED BUT NOT TRUE TODAY: entrants.per_division.max is null (unlimited) on event_pass_l against 256 on pro, so an L pass really would lift a Pro org’s entrant cap. pricing.faq.upgraded.a was already rewritten in this wave to assert neither; this string was the last surface still asserting it, and PRICING_KEY_DISPOSITION exempted it as a button label whose stated reason was “they identify a card, they do not describe what it grants”. Replaced with the reason that IS true and resolver-backed: V338 org_has_feature requires the resolved plan to be ‘community’ for the pass arm to apply, so a pass held by a paid org sits dormant — the same wording pricing.faq.upgraded.a uses.",
    text: {
      en: "Your plan applies across the whole organisation, so a pass would sit dormant.",
      es: "Tu plan se aplica a toda la organización, así que un pase quedaría inactivo.",
      fr: "Votre formule s’applique à toute l’organisation : un pass resterait en veille.",
      nl: "Je abonnement geldt voor de hele organisatie, dus een pass zou slapend blijven.",
    },
  },
  // ── Every /pricing string that quotes MONEY or an ALLOWANCE (fix round 1) ──
  //
  // Added after a fresh probe set — written once the card rules were final —
  // found two of this class open and invisible: `pricing.plus.per` flipped from
  // "/month" to "/year" beside a monthly figure, and the Pro Plus credit chip
  // re-sold a monthly allowance as a one-time top-up. Both are one-word edits,
  // both make a money claim false, and neither touched a card array.
  //
  // Most of these interpolate their NUMBER from the matrix or the seed, which is
  // exactly why the words around it need pinning: the figure stays right while
  // the sentence stops meaning what it meant. `PRICING_KEY_DISPOSITION` in
  // dictionary-copy-truth.test.ts now makes every `pricing.*` key either pinned
  // here or exempt with a reason, so this list cannot quietly stop growing.
  {
    file: "marketing",
    key: "pricing.credits.perMonth",
    why: "the Community and Pro credit chips. The COUNT is interpolated live from ai.credits.monthly, so the pin guards the CADENCE around it — \"/ month\" is the claim, and re-wording it to a one-time top-up (or vice versa) makes the chip false while the number stays right. Source of truth: plan_entitlements ai.credits.monthly, rendered by pricing/page.tsx.",
    text: {
      en: "{count} AI credits / month",
      es: "{count} créditos de IA / mes",
      fr: "{count} crédits IA / mois",
      nl: "{count} AI-credits / maand",
    },
  },
  {
    file: "marketing",
    key: "pricing.credits.passGrant",
    why: "the Event Pass credit chip. The pass has NO ai.credits.monthly row — the grant is the one-time PASS_CREDIT_GRANT in lib/pricing-cards.ts — so \"one-time\" is the load-bearing word and a recurring re-wording is the exact inverse claim RECURRING_GRANT_PATTERNS exists for.",
    text: {
      en: "+{count} AI credits, one-time",
      es: "+{count} créditos de IA, una sola vez",
      fr: "+{count} crédits IA, une seule fois",
      nl: "+{count} AI-credits, eenmalig",
    },
  },
  {
    file: "marketing",
    key: "pricing.credits.perMonthOperator",
    why: "the Pro Plus credit chip. Same cadence claim as pricing.credits.perMonth, plus \"operator wallet\" (SPEC-2 §11: the wallet is org-scoped and shared across a billing group). Measured as a gap — re-selling this monthly allowance as a one-time top-up was invisible to every rule.",
    text: {
      en: "{count} AI credits / month · operator wallet",
      es: "{count} créditos de IA / mes · monedero de operador",
      fr: "{count} crédits IA / mois · portefeuille opérateur",
      nl: "{count} AI-credits / maand · operator-portemonnee",
    },
  },
  {
    file: "marketing",
    key: "pricing.plus.per",
    why: "the billing period beside Pro Plus’s headline price. page.tsx renders the MONTHLY amount here (plusMonthly), so \"/month\" is a claim about what the number means; \"/year\" beside a monthly figure understates the price by 12x. Source of truth: config/stripe-plans.json seazn_pro_plus_monthly.",
    text: {
      en: "/month",
      es: "/mes",
      fr: "/mois",
      nl: "/maand",
    },
  },
  {
    file: "marketing",
    key: "pricing.pass.per",
    why: "the unit beside the Event Pass price. The pass is bought per COMPETITION, once (V328/V334, and usecases/competition-passes.ts mints one row per competition) — not per month and not per org.",
    text: {
      en: " / event",
      es: " / evento",
      fr: " / événement",
      nl: " / evenement",
    },
  },
  {
    file: "marketing",
    key: "pricing.pass.from",
    why: "the qualifier marking the pass price as a FLOOR. v17 #294 put two rungs on sale, so the quoted figure is the cheapest of two; ticketTiers sets this prefix and pricing-cards.test.ts asserts only the pass carries it. Dropping the word states M’s price as the product’s.",
    text: {
      en: "from",
      es: "desde",
      fr: "à partir de",
      nl: "vanaf",
    },
  },
  {
    file: "marketing",
    key: "pricing.community.price",
    why: "Community’s headline price. It is genuinely free — no plans row, no Stripe price, and config/stripe-plans.json has no community product — so this is the one card where a price word is a claim about the absence of a charge.",
    text: {
      en: "Free",
      es: "Gratis",
      fr: "Gratuit",
      nl: "Gratis",
    },
  },
  {
    file: "marketing",
    key: "pricing.addons.credits",
    why: "the credit-pack add-on line. FIX ROUND 2: this hardcoded \"$10\" in all four locales and rendered statically, while every other price on /pricing goes through formatMinor(…, currency) behind the CurrencySwitcher — and config/stripe-plans.json `packs` prices the cheapest pack at eur 900 / gbp 800 / aud 1500 / inr 79900, so the literal was false in FOUR of the five supported currencies (#191's defect). The amount is now interpolated as {price} from lib/currency.ts lowestCreditPackAmount(), so what is pinned here is the WORDING around it: \"from\" is load-bearing because larger packs cost more. Packs never expire (D2), which is why no duration qualifier belongs here. NOTE the previous version of this note asserted the claim was true and named `credit_packs`, an identifier that does not exist — the JSON key is `packs`.",
    text: {
      en: "AI credits from {price}",
      es: "Créditos de IA desde {price}",
      fr: "Crédits IA à partir de {price}",
      nl: "AI-credits vanaf {price}",
    },
  },
  {
    file: "marketing",
    key: "pricing.addons.seat",
    why: "the extra-seat add-on label. Priced and delta-ed in config/stripe-plans.json (seat add-on, monthly interval, +1 each) and described in content/help/billing/add-ons.md, which task 7 pins against the seed.",
    text: {
      en: "Extra seat",
      es: "Plaza adicional",
      fr: "Siège supplémentaire",
      nl: "Extra plaats",
    },
  },
  {
    file: "marketing",
    key: "pricing.addons.org",
    why: "the extra-organisation add-on label. Its RATE is the “no more than half the base rate” claim pinned on pricing.faq.groups.a and pricing.faq.proPlus.a and verified against the seed’s graduated tiers by riderClaimShape.",
    text: {
      en: "Extra org",
      es: "Organización adicional",
      fr: "Organisation supplémentaire",
      nl: "Extra organisatie",
    },
  },
  {
    file: "marketing",
    key: "pricing.addons.sizePack",
    why: "the size-pack add-on label. Raises the entrant limit by a fixed delta (config/stripe-plans.json, +32 each) and is a ONE-OFF, not a subscription — the seed price carries no interval, which task 7’s guard asserts.",
    text: {
      en: "Size pack",
      es: "Paquete de tamaño",
      fr: "Pack de taille",
      nl: "Size-pack",
    },
  },
  {
    file: "marketing",
    key: "pricing.pass.ladder.caps",
    why: "the M rung’s caps in the ladder list. Both numbers are interpolated live from plan_entitlements (divisions.per_competition.max / entrants.per_division.max on event_pass), so the pin guards the words around them — “Up to” is what makes them ceilings rather than allocations.",
    text: {
      en: "Up to {divisions} divisions, {entrants} entrants each",
      es: "Hasta {divisions} divisiones, {entrants} participantes cada una",
      fr: "Jusqu’à {divisions} divisions, {entrants} participants chacune",
      nl: "Tot {divisions} divisies, {entrants} deelnemers per divisie",
    },
  },
  {
    file: "marketing",
    key: "pricing.pass.ladder.capsUnlimited",
    why: "the L rung’s caps. entrants.per_division.max is NULL on event_pass_l, so this variant must SAY unlimited rather than print a number — quoting M’s 128 here is the exact defect v17 #294 was filed for.",
    text: {
      en: "Up to {divisions} divisions, unlimited entrants",
      es: "Hasta {divisions} divisiones, participantes ilimitados",
      fr: "Jusqu’à {divisions} divisions, participants illimités",
      nl: "Tot {divisions} divisies, onbeperkt deelnemers",
    },
  },
  // ── The Pro Plus ROADMAP block (fix round 1, I3) ───────────────────────────
  //
  // `pricing.plus.soonLabel` + `soon1-8`, under the Pro Plus card. Added because
  // the block was covered by NOTHING — not by a vocabulary, not by a pin, and
  // not by the card's own coverage assertion, which listed two arrays and so
  // codified the omission rather than merely forgetting it.
  //
  // Measured: flipping `soonLabel` to "Included now" reclassifies EIGHT
  // undelivered features as shipped, in whichever locale it is done, and the
  // whole suite stayed green. That is a direct breach of SPEC-1 §6's ethics
  // guardrail and it reads in review as a harmless copy tweak.
  //
  // There is no row to pin this to: availability is not in plan_entitlements,
  // and SPEC-1 §9 deliberately seeds `domains.custom` on pro_plus while the DNS
  // product is unbuilt (`pricing-matrix.ts` never renders that row), so the
  // matrix would say "shipped" about a feature that is not. This gate is the
  // guard, which is exactly the case the approved-wording shape exists for.
  {
    file: "marketing",
    key: "pricing.plus.soonLabel",
    why: "the ROADMAP LABEL under the Pro Plus card, and the single highest-leverage string on /pricing: it is what classifies the eight items below as NOT YET AVAILABLE. Measured in fix round 1 — flipping it to \"Included now\" advertised eight undelivered features as shipped and every test stayed green. SPEC-1 §6 requires the roadmap to read as ambition and never as a paywall; §9 keeps domains.custom seeded-but-unshipped, so plan_entitlements cannot decide this and the pin is the only guard. Re-approving means confirming the block is still a roadmap.",
    text: {
      en: "Coming soon",
      es: "Próximamente",
      fr: "Bientôt disponible",
      nl: "Binnenkort",
    },
  },
  {
    file: "marketing",
    key: "pricing.plus.soon1",
    why: "Pro Plus ROADMAP item 1 (SPEC-1 §6) — badged \"coming soon\", NOT purchasable and NOT built. Mirrored in English by PLUS_COMING_SOON[0] in lib/pricing-cards.ts, which pricing-cards.test.ts pins. Re-approving means confirming the feature is still unshipped; shipping it means deleting it from this list and from PLUS_COMING_SOON in the same commit. Nothing in plan_entitlements records shipped-ness — SPEC-1 §9 deliberately seeds domains.custom on pro_plus while the DNS product is unbuilt — so no matrix pin is possible and this gate is the guard.",
    text: {
      en: "Multi-org command centre",
      es: "Centro de mando multiorganización",
      fr: "Centre de commande multi-organisations",
      nl: "Commandocentrum voor meerdere organisaties",
    },
  },
  {
    file: "marketing",
    key: "pricing.plus.soon2",
    why: "Pro Plus ROADMAP item 2 (SPEC-1 §6) — badged \"coming soon\", NOT purchasable and NOT built. Mirrored in English by PLUS_COMING_SOON[1] in lib/pricing-cards.ts, which pricing-cards.test.ts pins. Re-approving means confirming the feature is still unshipped; shipping it means deleting it from this list and from PLUS_COMING_SOON in the same commit. Nothing in plan_entitlements records shipped-ness — SPEC-1 §9 deliberately seeds domains.custom on pro_plus while the DNS product is unbuilt — so no matrix pin is possible and this gate is the guard.",
    text: {
      en: "Shared templates & branding across orgs",
      es: "Plantillas y marca compartidas entre organizaciones",
      fr: "Modèles et identité partagés entre organisations",
      nl: "Gedeelde sjablonen & branding over organisaties",
    },
  },
  {
    file: "marketing",
    key: "pricing.plus.soon3",
    why: "Pro Plus ROADMAP item 3 (SPEC-1 §6) — badged \"coming soon\", NOT purchasable and NOT built. Mirrored in English by PLUS_COMING_SOON[2] in lib/pricing-cards.ts, which pricing-cards.test.ts pins. Re-approving means confirming the feature is still unshipped; shipping it means deleting it from this list and from PLUS_COMING_SOON in the same commit. Nothing in plan_entitlements records shipped-ness — SPEC-1 §9 deliberately seeds domains.custom on pro_plus while the DNS product is unbuilt — so no matrix pin is possible and this gate is the guard.",
    text: {
      en: "Cross-competition analytics",
      es: "Analíticas entre competiciones",
      fr: "Analyses inter-compétitions",
      nl: "Analyses over competities heen",
    },
  },
  {
    file: "marketing",
    key: "pricing.plus.soon4",
    why: "Pro Plus ROADMAP item 4 (SPEC-1 §6) — badged \"coming soon\", NOT purchasable and NOT built. Mirrored in English by PLUS_COMING_SOON[3] in lib/pricing-cards.ts, which pricing-cards.test.ts pins. Re-approving means confirming the feature is still unshipped; shipping it means deleting it from this list and from PLUS_COMING_SOON in the same commit. Nothing in plan_entitlements records shipped-ness — SPEC-1 §9 deliberately seeds domains.custom on pro_plus while the DNS product is unbuilt — so no matrix pin is possible and this gate is the guard.",
    text: {
      en: "Custom domain & white-label",
      es: "Dominio propio y marca blanca",
      fr: "Domaine personnalisé et marque blanche",
      nl: "Eigen domein & white-label",
    },
  },
  {
    file: "marketing",
    key: "pricing.plus.soon5",
    why: "Pro Plus ROADMAP item 5 (SPEC-1 §6) — badged \"coming soon\", NOT purchasable and NOT built. Mirrored in English by PLUS_COMING_SOON[4] in lib/pricing-cards.ts, which pricing-cards.test.ts pins. Re-approving means confirming the feature is still unshipped; shipping it means deleting it from this list and from PLUS_COMING_SOON in the same commit. Nothing in plan_entitlements records shipped-ness — SPEC-1 §9 deliberately seeds domains.custom on pro_plus while the DNS product is unbuilt — so no matrix pin is possible and this gate is the guard.",
    text: {
      en: "SSO / SAML",
      es: "SSO / SAML",
      fr: "SSO / SAML",
      nl: "SSO / SAML",
    },
  },
  {
    file: "marketing",
    key: "pricing.plus.soon6",
    why: "Pro Plus ROADMAP item 6 (SPEC-1 §6) — badged \"coming soon\", NOT purchasable and NOT built. Mirrored in English by PLUS_COMING_SOON[5] in lib/pricing-cards.ts, which pricing-cards.test.ts pins. Re-approving means confirming the feature is still unshipped; shipping it means deleting it from this list and from PLUS_COMING_SOON in the same commit. Nothing in plan_entitlements records shipped-ness — SPEC-1 §9 deliberately seeds domains.custom on pro_plus while the DNS product is unbuilt — so no matrix pin is possible and this gate is the guard.",
    text: {
      en: "SLA & dedicated support",
      es: "SLA y soporte dedicado",
      fr: "SLA et support dédié",
      nl: "SLA & toegewijde ondersteuning",
    },
  },
  {
    file: "marketing",
    key: "pricing.plus.soon7",
    why: "Pro Plus ROADMAP item 7 (SPEC-1 §6) — badged \"coming soon\", NOT purchasable and NOT built. Mirrored in English by PLUS_COMING_SOON[6] in lib/pricing-cards.ts, which pricing-cards.test.ts pins. Re-approving means confirming the feature is still unshipped; shipping it means deleting it from this list and from PLUS_COMING_SOON in the same commit. Nothing in plan_entitlements records shipped-ness — SPEC-1 §9 deliberately seeds domains.custom on pro_plus while the DNS product is unbuilt — so no matrix pin is possible and this gate is the guard.",
    text: {
      en: "Data export & warehouse",
      es: "Exportación de datos y data warehouse",
      fr: "Export de données et entrepôt de données",
      nl: "Data-export & datawarehouse",
    },
  },
  {
    file: "marketing",
    key: "pricing.plus.soon8",
    why: "Pro Plus ROADMAP item 8 (SPEC-1 §6) — badged \"coming soon\", NOT purchasable and NOT built. Mirrored in English by PLUS_COMING_SOON[7] in lib/pricing-cards.ts, which pricing-cards.test.ts pins. Re-approving means confirming the feature is still unshipped; shipping it means deleting it from this list and from PLUS_COMING_SOON in the same commit. Nothing in plan_entitlements records shipped-ness — SPEC-1 §9 deliberately seeds domains.custom on pro_plus while the DNS product is unbuilt — so no matrix pin is possible and this gate is the guard.",
    text: {
      en: "Bulk & scheduled automation",
      es: "Automatización masiva y programada",
      fr: "Automatisation en masse et planifiée",
      nl: "Bulk- & geplande automatisering",
    },
  },
  // ── The extra-organisation TIP (v17 gap wave 7, task 7, #299) ──────────────
  //
  // A FOURTH surface of the half-rate claim, and the one that showed the axis
  // was still not closed. `pricing.faq.groups.a` and `pricing.faq.proPlus.a`
  // were corrected earlier in this wave; this key said "half your plan's rate",
  // bare, in all four locales the whole time — the same phrase, the same
  // pattern (`en.halfClaim` spells it out), and again nothing pointed the rule
  // at the key. Third occurrence of that defect in one wave.
  //
  // It is also the key that showed `config/tips.ts` is NOT what renders:
  // `components/ui/tip.tsx` reads msg(`tips.${id}.body`) from these
  // dictionaries, so correcting the TypeScript literal alone would have changed
  // nothing a customer sees. The mirror between the two is asserted in
  // dictionary-copy-truth.test.ts for exactly that reason.
  {
    file: "ui",
    key: "tips.billing.extra-org.body",
    why: "the extra-organisation rate, in the ⓘ tip beside the billing-group controls. 'half your plan's rate' unqualified is false — the seed rounds the rider DOWN (usd pro monthly 1900 -> 900 = 47.4%, pro_plus 3900 -> 1900 = 48.7%) while eur and aud land on exact halves, so only 'no more than half' is true in all twenty plan x interval x currency combinations. Source of truth: config/stripe-plans.json graduated tiers, via riderClaimShape. The 2%/1%/8% clause is registration.fee_percent in plan_entitlements and is unchanged.",
    text: {
      en: "Each organisation after the first costs no more than half the base rate. It also moves to your plan's entry-fee cut — 2% on Pro or 1% on Pro Plus, instead of the 8% a free organisation pays.",
      es: "Cada organización después de la primera cuesta no más de la mitad de la tarifa base. También pasa a la comisión de inscripción de tu plan: 2 % en Pro o 1 % en Pro Plus, en lugar del 8 % que paga una organización gratuita.",
      fr: "Chaque organisation après la première coûte au plus la moitié du tarif de base. Elle passe aussi à la commission d'inscription de votre formule — 2 % sur Pro ou 1 % sur Pro Plus, au lieu des 8 % que paie une organisation gratuite.",
      nl: "Elke organisatie na de eerste kost hoogstens de helft van het basistarief. Ze gaat ook over op het inschrijfgeldpercentage van je abonnement — 2% op Pro of 1% op Pro Plus, in plaats van de 8% die een gratis organisatie betaalt.",
    },
  },
  // ── The remaining three half-rate surfaces (v17 gap wave 7, task 7 round 2) ──
  //
  // Round 1 reported these as a follow-up and scoped them out. That was the
  // wrong call and the review ruled them in: leaving the identical falsehood on
  // surfaces ADJACENT to the ones just corrected is how this claim family has
  // survived four rounds. With these three the axis is closed — every key in
  // the repo that states the extra-organisation rate is pinned, which is what
  // makes `HALF_CLAIM_KEYS` a decision instead of a list somebody stopped
  // adding to.
  //
  // Two of the three were invisible to `en.halfClaim` as it stood ("half
  // price", "half the plan rate"), so the vocabulary was widened in the same
  // change. The pin does not depend on that widening — it never did — but the
  // secondary net should not have a hole this claim has already walked through.
  {
    file: "marketing",
    key: "pricing.matrix.orgs.max_owned.note",
    why: "the extra-organisation rate, in the /pricing comparison matrix's own footnote on the orgs.max_owned row. Said 'half your plan's rate' bare. Same arithmetic as pricing.faq.groups.a: the seed rounds the rider DOWN (usd pro 1900 -> 900 = 47.4%) while eur/aud are exact halves, so only 'no more than half' is true in all twenty plan x interval x currency combinations. Source of truth: config/stripe-plans.json graduated tiers, via riderClaimShape. The entry-fee half of the sentence is registration.fee_percent and is unchanged.",
    text: {
      en: "Each extra organisation costs no more than half the base rate, and takes your plan's entry-fee rate",
      es: "Cada organización adicional cuesta no más de la mitad de la tarifa base y adopta la comisión de inscripción de tu plan",
      fr: "Chaque organisation supplémentaire coûte au plus la moitié du tarif de base et adopte le taux de frais d'inscription de votre forfait",
      nl: "Elke extra organisatie kost hoogstens de helft van het basistarief en krijgt het inschrijfkostenpercentage van je abonnement",
    },
  },
  {
    file: "ui",
    key: "orgNew.bill.addToExistingHint",
    why: "the extra-organisation rate, sitting directly above the create-organisation picker's 'add to an existing bill' control — so it is read as the rate that choice will charge. Said 'half price', which en.halfClaim did not match and nl.halfClaim did not match either ('voor de helft van de prijs' needed the determiner to be optional); both were widened. Source of truth: config/stripe-plans.json graduated tiers, via riderClaimShape.",
    text: {
      en: "Every extra organisation costs no more than half the base rate, on the same card and invoice.",
      es: "Cada organización adicional cuesta no más de la mitad de la tarifa base, en la misma tarjeta y factura.",
      fr: "Chaque organisation supplémentaire coûte au plus la moitié du tarif de base, sur la même carte et la même facture.",
      nl: "Elke extra organisatie kost hoogstens de helft van het basistarief, op dezelfde kaart en factuur.",
    },
  },
  {
    file: "ui",
    key: "billing.group.attach.confirmCharge",
    why: "the extra-organisation rate AND the attach charge's TIMING, in the confirmation dialog — the last sentence a payer reads before agreeing, and the only one of these surfaces asserted by e2e (billing-groups.spec.ts, billing-groups-journey.spec.ts), which move with it. RATE: said 'half your plan's rate' bare; source of truth is config/stripe-plans.json's graduated tiers, via riderClaimShape. TIMING: said 'charged now', which is FALSE. attachOrgToGroup bills entirely through syncGroupQuantity, whose only Stripe mutation is subscriptions.update with proration_behavior 'create_prorations' (billing-groups.ts:306-309) — booked onto the NEXT INVOICE, exactly like the add-on paths. No invoices.create, no invoices.pay, no always_invoice, no payment_behavior anywhere in that file; previewAttachCharge uses invoices.createPreview, which is read-only. `charged = raising` is a proration flag, not a statement that money moved. I asserted the opposite here in round 2 on the strength of a stale comment at billing-groups.ts:206-207, which is now corrected — the comment was contradicted by billing-events.ts:738-740 in the same repo.",
    text: {
      en: "{org} moves onto this plan straight away, and your bill goes up by no more than half the base rate — prorated to the rest of this period and added to your next invoice.",
      es: "{org} pasa a este plan de inmediato y tu factura sube no más de la mitad de la tarifa base, prorrateado al resto de este periodo y añadido a tu próxima factura.",
      fr: "{org} passe sur cette formule immédiatement, et votre facture augmente d'au plus la moitié du tarif de base — au prorata du reste de la période et ajouté à votre prochaine facture.",
      nl: "{org} gaat meteen over op dit abonnement en je factuur stijgt met hoogstens de helft van het basistarief — naar rato van de rest van deze periode en toegevoegd aan je volgende factuur.",
    },
  },
  {
    file: "ui",
    key: "billing.group.attach.confirmChargeAmount",
    why: "the SAME dialog when previewAttachCharge returns a figure — billing-group-panel.tsx:227 substitutes this for confirmCharge whenever the preview is non-null, so it is the sentence most payers actually see and it carried the identical 'goes up by {amount} now' falsehood. Timing source of truth: billing-groups.ts:306-309 (create_prorations, next invoice). The AMOUNT itself is Stripe's own proration arithmetic via invoices.createPreview (billing-groups.ts:130), which is read-only and charges nothing.",
    text: {
      en: "Straight away, and your bill goes up by {amount} — prorated to the rest of this period and added to your next invoice.",
      es: "De inmediato, y tu factura sube {amount}, prorrateado al resto de este periodo y añadido a tu próxima factura.",
      fr: "Immédiatement, et votre facture augmente de {amount} — au prorata du reste de la période et ajouté à votre prochaine facture.",
      nl: "Meteen, en je factuur stijgt met {amount} — naar rato van de rest van deze periode en toegevoegd aan je volgende factuur.",
    },
  },
  // ── The attach dialog's THIRD body, and the bound its second was missing ──
  // (v17 gap wave 7, task 7, round 4)
  {
    file: "ui",
    key: "billing.group.attach.confirmTrial",
    why: "the attach dialog on the TRIAL path, which had no body of its own and therefore read the CHARGED one. `attachConfirmKey` selected on `freeSlots` alone, and `freeSlots = max(0, quantity_paid - onBill)` is 0 during a trial because syncGroupQuantity deliberately freezes quantity_paid while trialing (billing-groups.ts:300) — so a trialing payer was told their bill goes up and the amount lands on the next invoice, when `raising` is false (`&& !trialing`, :320), proration_behavior is \"none\", and previewAttachCharge returns null at :123. Nothing is prorated at all. groups.md:43 said the opposite two sections away. Source of truth: billing-groups.ts:123, :300, :320.",
    text: {
      en: "{org} moves onto this plan straight away and rides your free trial to the same end date — nothing is charged and nothing is added to a bill now. It is first billed when the trial converts.",
      es: "{org} pasa a este plan de inmediato y se acoge a tu prueba gratuita hasta la misma fecha de finalización: no se cobra nada ni se añade nada a ninguna factura ahora. Se factura por primera vez cuando termine la prueba.",
      fr: "{org} passe sur cette formule immédiatement et suit votre essai gratuit jusqu'à la même date de fin — rien n'est prélevé et rien n'est ajouté à une facture maintenant. La première facturation intervient à la conversion de l'essai.",
      nl: "{org} gaat meteen over op dit abonnement en loopt mee met je gratis proefperiode tot dezelfde einddatum — er wordt nu niets in rekening gebracht en niets aan een factuur toegevoegd. De eerste facturatie volgt wanneer de proefperiode overgaat.",
    },
  },
  {
    file: "ui",
    key: "billing.group.attach.confirmFree",
    why: "the attach dialog when a PAID slot is free. 'there is nothing to pay now' is literally true — no charge, and no proration reaches the next invoice — but it was materially incomplete: syncGroupQuantity still RAISES the Stripe item quantity, so the renewal invoice bills the extra seat at the full rider rate. groups.md:90 already carried the bound ('at no extra charge UNTIL RENEWAL'), as does detach.mode.release.body; this dialog was the only one of the four surfaces that omitted it, and once its sibling started naming the next invoice explicitly the pair read as 'charged -> next invoice / free -> nothing, full stop'. Source of truth: billing-groups.ts:306-309 (the quantity write happens on every path) and the quantity_paid bookkeeping at :325.",
    text: {
      en: "{org} moves onto this plan straight away. You have a slot you have already paid for, so there is nothing to pay now — and nothing is added to your next invoice. From your next renewal onwards it is billed like any other organisation on the bill.",
      es: "{org} pasa a este plan de inmediato. Tienes una plaza que ya has pagado, así que no hay nada que pagar ahora ni se añade nada a tu próxima factura. A partir de tu próxima renovación se factura como cualquier otra organización de la cuenta.",
      fr: "{org} passe sur cette formule immédiatement. Vous avez une place déjà payée : il n'y a donc rien à payer maintenant, et rien n'est ajouté à votre prochaine facture. À partir de votre prochain renouvellement, elle est facturée comme toute autre organisation de la facture.",
      nl: "{org} gaat meteen over op dit abonnement. Je hebt een plek die je al betaald hebt, dus er is nu niets te betalen en er wordt niets aan je volgende factuur toegevoegd. Vanaf je volgende verlenging wordt ze gefactureerd als elke andere organisatie op de rekening.",
    },
  },
];
