import { formatMinor, passPrice, proPrice, type Currency } from "@/lib/currency";

// Single source for plan-card bullets — shared by /pricing and the home
// ticket stubs so the two can never drift (design/v3/12 §4.8).
export const FREE_FEATURES = [
  "1 active competition, 2 divisions",
  "16 entrants per division",
  "League, groups + knockout & swiss formats",
  // V309: charging entry fees is no longer gated — every plan can, and what a
  // plan buys is a smaller cut. The matrix row next to this card renders
  // "✓ 8%" for community, so the bullet has to say the same thing.
  "Online registration + entry fees (8% fee)",
  "Live standings & public dashboard",
  "Listed on the seazn.club showcase",
];

export const PASS_FEATURES = [
  "Upgrades ONE competition, forever",
  "10 divisions, 32 entrants each",
  "Advanced formats — double elim, ladders",
  "Entry fees at a 5% platform fee, not 8%",
  // Not "custom branding": V309 gives event_pass the same `branding` (logo) as
  // community, and leaves dashboard.branding (the theme colour) denied to both.
  "PDF/XLSX exports",
  "Realtime scoreboard & slideshow",
];

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
export const PLUS_CARD_FEATURES = [
  "Unlimited members, scorers & clubs",
  "1% platform fee on entry fees",
  "AI-assisted scheduling",
  "Auto officials assignment",
  "Write API access & priority support",
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
