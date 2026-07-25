import { formatMinor, passPrice, proPrice, type Currency } from "@/lib/currency";

// Single source for plan-card bullets — shared by /pricing and the home
// ticket stubs so the two can never drift (design/v3/12 §4.8).
// V311 (D22): these numbers are pinned against the live matrix by
// lib/__tests__/pricing-cards.test.ts. Moving a cap means moving the copy here
// AND in billing.community.* / billing.pro.* across all four dictionaries.
export const FREE_FEATURES = [
  "10 active competitions, 4 divisions",
  "64 entrants per division",
  "League, groups + knockout & swiss formats",
  // V310: charging entry fees is free on every plan — only the platform cut
  // differs (8 / 5 / 2 / 1%). "Free-event" undersold Community and made the
  // pass look like it unlocked payment rather than a cheaper rate.
  "Online registration & entry fees (8% fee)",
  "Live standings & public dashboard",
  "Listed on the seazn.club showcase",
];

// Every bullet here must be something the event_pass column actually LIFTS off
// community. "Custom branding & PDF/XLSX exports" was neither: `branding` and
// `exports` are true for Community (V310) and `dashboard.branding` — the org
// theme colour — stays denied to the pass. The real grant is `exports.branded`.
// The first four are also the home-page stub (ticketTiers slices them).
export const PASS_FEATURES = [
  "Upgrades ONE competition, forever",
  "10 divisions, 128 entrants each",
  "Advanced formats — double elim, ladders",
  "5% platform fee on entry fees, not 8%",
  "Branded exports & public player cards",
  "Sponsor tiers & paid sponsorship packages",
  "Realtime scoreboard & slideshow",
  // v17 (SPEC-6 A1): the retired "10 AI schedule runs per division" line is
  // gone — the graded run cap became the credit wallet (V322). The pass's
  // credit story is the dedicated credits line on the card (PASS_CREDIT_GRANT),
  // not a bullet, so it reads as one of the two v17 differentiators (fee % +
  // credits) rather than being buried in the list.
];

// v17 AI credit wallet (SPEC-6 A1 / A7): the Event Pass tops the org wallet up
// by a one-time grant when a competition is upgraded. Unlike the monthly plan
// grants (community/pro/pro_plus), the pass has NO `ai.credits.monthly` row in
// plan_entitlements — it is a one-off top-up, so this is the single source for
// the number the pricing card quotes. Pinned by pricing-cards.test.ts.
export const PASS_CREDIT_GRANT = 25;

export const PRO_FEATURES = [
  "Unlimited competitions & divisions",
  "256 entrants per division",
  "Entry fees at a 2% platform fee",
  "Ball-by-ball & rally scoring, player stats",
  "Officials, exports, API keys, device links",
  "Remove the “Powered by Seazn” badge",
  // v16 league-ops (T84): suspensions/discipline, official ratings and
  // auto-drafted news posts all seed true on Pro (V293/V294/V295).
  "Suspensions & discipline tracking",
  "Rate your match officials",
  "Auto-drafted result posts",
];

// Pro Plus is progressively disclosed on /pricing (spec §4) — same five
// selling points as billing.plus.f1-f5 (Task 8's in-app upgrade prompt), kept
// in marketing tone. Mirrored as dict keys pricing.plus.f1-f5 for i18n.
// #244: "scorers" retired from marketing — the seat is dormant legacy; the card
// leads with members/teams/clubs instead.
export const PLUS_CARD_FEATURES = [
  "Unlimited members, teams & clubs",
  "1% platform fee on entry fees",
  "AI-assisted scheduling",
  "Auto officials assignment",
  "Write API access & priority support",
];

// Pro Plus roadmap (SPEC-1 §6): badged "coming soon", NOT purchasable. Rendered
// as a muted list under the Plus card so the tier's ceiling reads as ambition,
// not a paywall. Mirrored as dict keys pricing.plus.soon1-soon8 for i18n.
export const PLUS_COMING_SOON: string[] = [
  "Multi-org command centre",
  "Shared templates & branding across orgs",
  "Cross-competition analytics",
  "Custom domain & white-label",
  "SSO / SAML",
  "SLA & dedicated support",
  "Data export & warehouse",
  "Bulk & scheduled automation",
];

export interface TicketTier {
  tier: string;
  price: string;
  period?: string;
  bullets: string[];
  glow?: boolean;
}

/** The three home-page ticket stubs (design/v3/12 §4.8): headline bullets
 *  only — the full matrix lives on /pricing. Home STAYS 3 stubs (Community /
 *  Event Pass / Pro) even after Pro Plus ships — /pricing carries the full
 *  4-offer ladder via PlusReveal's progressive disclosure. */
export function ticketTiers(currency: Currency): TicketTier[] {
  return [
    { tier: "Community", price: "Free", bullets: FREE_FEATURES.slice(0, 4) },
    {
      tier: "Event Pass",
      price: formatMinor(passPrice(currency), currency),
      period: " once",
      bullets: PASS_FEATURES.slice(0, 4),
      glow: true,
    },
    {
      tier: "Pro",
      price: formatMinor(proPrice("monthly", currency), currency),
      period: "/mo",
      bullets: PRO_FEATURES.slice(0, 4),
    },
  ];
}
