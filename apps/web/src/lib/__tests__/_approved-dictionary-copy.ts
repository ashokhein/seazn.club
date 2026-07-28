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
];
