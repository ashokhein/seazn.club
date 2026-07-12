import { formatMinor, passPrice, proPrice, type Currency } from "@/lib/currency";

// Single source for plan-card bullets — shared by /pricing and the home
// ticket stubs so the two can never drift (design/v3/12 §4.8).
export const FREE_FEATURES = [
  "1 active competition, 2 divisions",
  "16 entrants per division",
  "League, groups + knockout & swiss formats",
  "Free-event online registration",
  "Live standings & public dashboard",
  "Listed on the seazn.club showcase",
];

export const PASS_FEATURES = [
  "Upgrades ONE competition, forever",
  "10 divisions, 32 entrants each",
  "Advanced formats — double elim, ladders",
  "Entry fees via Stripe (5% platform fee)",
  "Custom branding & PDF/XLSX exports",
  "Realtime scoreboard & slideshow",
];

export const PRO_FEATURES = [
  "Unlimited competitions & divisions",
  "256 entrants per division",
  "Entry fees at a 2% platform fee",
  "Ball-by-ball & rally scoring, player stats",
  "Officials, exports, API keys, device links",
  "Remove the “Powered by Seazn” badge",
];

export interface TicketTier {
  tier: string;
  price: string;
  period?: string;
  bullets: string[];
  glow?: boolean;
}

/** The three home-page ticket stubs (design/v3/12 §4.8): headline bullets
 *  only — the full matrix lives on /pricing. */
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
