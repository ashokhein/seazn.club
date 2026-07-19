// Human copy for entitlement feature keys (doc 10 §3 — upgrade moments).
// Isomorphic on purpose: the 402 handlers (server) and <UpgradeGate> (client)
// read the same map so the paywall reason is identical everywhere.

const FEATURE_REASONS: Record<string, string> = {
  // Structure & scale
  "embeds.enabled": "Embedding live widgets on your own website is a Pro feature.",
  "orgs.max_owned": "You've reached the number of clubs your plan can own.",
  "members.max": "You've reached your plan's team-member seats.",
  "scorers.max": "You've reached your plan's scorer seats.",
  "competitions.max_active": "Your plan's active-competition limit is reached.",
  "divisions.per_competition.max": "Adding another division needs a bigger plan.",
  "entrants.per_division.max": "This division is at your plan's entrant limit.",
  "stages.per_division.max": "Adding another stage needs a bigger plan.",
  "formats.double_elim": "Double-elimination brackets are a Pro format.",
  "formats.advanced": "Americano, ladders, custom brackets, cross-stage feeds and auto-advance are Pro formats.",
  // Sport depth
  "scoring.ball_by_ball": "Ball-by-ball scoring is a Pro feature.",
  "scoring.rally_by_rally": "Rally-by-rally scoring is a Pro feature.",
  "scoring.match_timeline": "Match timelines (scorers, cards, minutes) are a Pro feature.",
  "cricket.dls": "DLS revised targets are a Pro feature — a manual umpire target still works.",
  "stats.player": "Player stats and scorecard entry are a Pro feature.",
  "scoring.audit_export": "The signed match audit trail download is a Pro feature.",
  "discipline.enforced": "Automatic suspension tracking is a Pro feature.",
  "stats.club_championship": "Club championship tables are a Pro feature.",
  "tiebreakers.custom": "Custom tiebreaker order is a Pro feature.",
  "standings.custom_points": "Bonus-point rules and forfeit points are a Pro feature — plain win/draw/loss points work on every plan.",
  "standings.carry_over": "Carrying Phase-1 standings into Phase 2 is a Pro feature.",
  "eligibility.enforced": "Enforced eligibility locks are a Pro feature.",
  // Public & realtime
  "dashboard.public.max": "Your plan hosts one public dashboard at a time.",
  "dashboard.branding": "Custom dashboard branding is a Pro feature.",
  "dashboard.player_profiles": "Public player profiles are a Pro feature.",
  realtime: "Live push updates are a Pro feature.",
  // Platform
  "api.access": "API keys are a Pro feature.",
  "api.write": "Write access via the API is a Pro Plus feature — read keys work on Pro.",
  exports: "CSV/PDF exports are a Pro feature.",
  "exports.branded": "Branded print templates (club colours, sponsor logos) are a Pro feature.",
  // Clubs & bulk import (Jul3/01 §7)
  "import.bulk": "Files over 20 rows need a Pro plan — split the file or upgrade.",
  "logos.bulk": "Multi-file logo upload is a Pro feature — you can still set logos one at a time.",
  "clubs.hierarchy": "Club hierarchies (parent clubs, group-by-club) — your plan's limits apply.",
  "clubs.max": "You've reached your plan's club limit.",
  "teams.max": "You've reached your plan's team limit.",
  "teams.squad_max": "This squad has reached your plan's size limit.",
  "scheduling.constraints": "The scheduling constraints solver is a Pro feature.",
  "scheduling.board": "Editing the schedule board is a Pro feature — it stays view-only on Community.",
  "scheduling.multi_division": "The competition-wide schedule board is a Pro feature.",
  "officials.auto": "Auto-assigning officials (solver, phased sourcing) is a Pro Plus feature — manual assignment still works.",
  "officials.roles_multi": "Multiple official roles per fixture (judge + referee) are a Pro feature.",
  "officials.per_fixture.max": "Community includes one official per fixture — more need Pro.",
  "officials.marks": "Rating your match officials is a Pro feature.",
  "scheduling.ai": "The AI Schedule Architect (plan, refine and repair your schedule from plain-language instructions) is not available on this plan.",
  "scheduling.ai.runs_per_division.max":
    "You've used this division's AI schedule generations — free plans include 5, an Event Pass 10, Pro 20 and Pro Plus 50.",
  "schedule.versioning": "Multi-site scope locks are a Pro feature — undo/redo always works.",
  "schedule.checkpoints.max": "You've reached your plan's save points — Pro includes five, Pro Plus unlimited. Undo/redo always works.",
  "domains.custom": "Serving your public pages on your own domain is a Pro Plus feature.",
  "support.priority": "Priority support is included with Pro Plus.",
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
  "news.auto": "Auto-drafted result posts are a Pro feature.",
};

/** Human, contextual sentence for a 402 / paywall. Never throws. */
export function featureReason(featureKey: string): string {
  return FEATURE_REASONS[featureKey] ?? "This feature needs a plan upgrade.";
}

// Cheapest plan that unlocks each feature (mirrors plan_entitlements,
// V112 + V240 + V290 + V291 + V294). Everything not listed unlocks on Pro —
// only the above-Pro (Pro Plus) exceptions need rows. The AI run cap is a
// graded quota on every tier (V294: 5/10/20/50), so like
// schedule.checkpoints.max it advertises Pro as the next step up and the
// reason copy spells out the full ladder.
const PLUS_FEATURES = new Set([
  "api.write",
  "scorers.max",
  "officials.auto",
  "domains.custom",
  "support.priority",
]);

export type PaidPlan = "pro" | "pro_plus";

/** Cheapest plan that unlocks a feature key. Never throws. */
export function featurePlan(featureKey: string): PaidPlan {
  return PLUS_FEATURES.has(featureKey) ? "pro_plus" : "pro";
}
