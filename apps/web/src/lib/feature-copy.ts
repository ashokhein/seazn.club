// Human copy for entitlement feature keys (doc 10 §3 — upgrade moments).
// Isomorphic on purpose: the 402 handlers (server) and <UpgradeGate> (client)
// read the same map so the paywall reason is identical everywhere.

const FEATURE_REASONS: Record<string, string> = {
  // Structure & scale
  "orgs.max_owned": "You've reached the number of clubs your plan can own.",
  "members.max": "You've reached your plan's team-member seats.",
  "scorers.max": "You've reached your plan's scorer seats.",
  "competitions.max_active": "Your plan's active-competition limit is reached.",
  "divisions.per_competition.max": "Adding another division needs a bigger plan.",
  "entrants.per_division.max": "This division is at your plan's entrant limit.",
  "stages.per_division.max": "Adding another stage needs a bigger plan.",
  "formats.double_elim": "Double-elimination brackets are a Pro format.",
  // Sport depth
  "scoring.ball_by_ball": "Ball-by-ball scoring is a Pro feature.",
  "scoring.rally_by_rally": "Rally-by-rally scoring is a Pro feature.",
  "scoring.match_timeline": "Match timelines (scorers, cards, minutes) are a Pro feature.",
  "cricket.dls": "DLS revised targets are a Pro feature — a manual umpire target still works.",
  "stats.player": "Player stats and scorecard entry are a Pro feature.",
  "stats.club_championship": "Club championship tables are a Pro feature.",
  "tiebreakers.custom": "Custom tiebreaker order is a Pro feature.",
  "eligibility.enforced": "Enforced eligibility locks are a Pro feature.",
  // Public & realtime
  "dashboard.public.max": "Your plan hosts one public dashboard at a time.",
  "dashboard.branding": "Custom dashboard branding is a Pro feature.",
  "dashboard.player_profiles": "Public player profiles are a Pro feature.",
  realtime: "Live push updates are a Pro feature.",
  // Platform
  "api.access": "API keys are a Pro feature.",
  "api.write": "Write access via the API needs the Business plan.",
  webhooks: "Webhooks need the Business plan.",
  exports: "CSV/PDF exports are a Pro feature.",
  // Clubs & bulk import (Jul3/01 §7)
  "import.bulk": "Files over 20 rows need a Pro plan — split the file or upgrade.",
  "logos.bulk": "Multi-file logo upload is a Pro feature — you can still set logos one at a time.",
  "clubs.hierarchy": "Club hierarchies (parent clubs, group-by-club) are a Pro feature.",
  "scheduling.constraints": "The scheduling constraints solver is a Pro feature.",
  "scheduling.board": "Editing the schedule board is a Pro feature — it stays view-only on Community.",
  "scheduling.multi_division": "The competition-wide schedule board is a Pro feature.",
  "officials.assignment": "Officials assignment is a Pro feature.",
  "officials.auto": "Auto-assigning officials (solver, phased sourcing) is a Pro feature — manual assignment still works.",
  "officials.roles_multi": "Multiple official roles per fixture (judge + referee) are a Pro feature.",
  "scheduling.ai": "AI-assisted planning (describe constraints in plain language) is a Pro feature.",
  "schedule.versioning": "Extra save points and multi-site scope locks are a Pro feature — undo/redo always works.",
  "scoring.device_links":
    "Hand-this-device-over scoring links are a Pro feature — your scorer seat still works.",
  // Registration & entry fees (doc 16 §1.1)
  "registration.enabled": "Online registration is not available on this plan.",
  "registration.paid":
    "Charging entry fees is a Pro feature — free-event registration still works on every plan.",
  // Discovery showcase (doc 15 §5)
  "discovery.listed": "Showcasing on seazn.club is not available on this plan.",
  "discovery.featured": "The featured showcase row is a Pro perk.",
  "discovery.branding": "Card tagline and hero image on seazn.club are a Pro feature.",
};

/** Human, contextual sentence for a 402 / paywall. Never throws. */
export function featureReason(featureKey: string): string {
  return FEATURE_REASONS[featureKey] ?? "This feature needs a plan upgrade.";
}

// Cheapest plan that unlocks each feature (mirrors the plan_entitlements
// seeds, V112 + V240). Everything not listed here unlocks on Pro — only the
// Business-tier exceptions need rows.
const BUSINESS_FEATURES = new Set(["api.write", "webhooks", "scorers.max"]);

export type PaidPlan = "pro" | "business";

/** Cheapest plan that unlocks a feature key. Never throws. */
export function featurePlan(featureKey: string): PaidPlan {
  return BUSINESS_FEATURES.has(featureKey) ? "business" : "pro";
}
