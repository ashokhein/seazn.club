// Human copy for entitlement feature keys (doc 10 §3 — upgrade moments).
// Isomorphic on purpose: the 402 handlers (server) and <UpgradeGate> (client)
// read the same map so the paywall reason is identical everywhere.

const FEATURE_REASONS: Record<string, string> = {
  // Structure & scale
  "embeds.enabled": "Embedding live widgets on your own website is a Pro feature.",
  // Billing groups (spec 2026-07-21): the cap belongs to the billing GROUP, so
  // the way forward is the group's plan — not a per-org purchase. Never says
  // "clubs", which is a separate in-org entity with its own clubs.max cap.
  // Fires for BOTH caps: the per-USER limit (creating one org too many for your
  // plan — Community allows 1) and the per-GROUP limit (a shared bill that is
  // full). Worded to make sense for either, and to name the upgrade path and the
  // half-price extra-org rule rather than the raw key. v17 gap #293: the way
  // past the cap on a PAID plan is now a purchase (the recurring extra-org
  // rider), not an upgrade — the 402 carries { offer: "extra_org" } alongside
  // this sentence, so the copy has to name the same remedy the machine hint
  // does. `feature-copy.test.ts` pins that pairing.
  //
  // MAKES NO RATE CLAIM, deliberately. There are TWO different prices for "an
  // extra organisation" and they only agree monthly: the plan price's second
  // graduated tier (what the orgs already on the bill cost — 900/1900 a month,
  // but 7900/16300 a YEAR) and the rider SKU this offer sells, which is
  // monthly-only at 900/1900. So "the same rate as the ones already on your
  // bill" is true for a monthly group and ~37% wrong for an annual one, and
  // "half your plan's rate" is a claim about the tier, not about this. The
  // figure belongs to the Add-ons page (Task 6), which knows the currency and
  // reads it from the rider SKU; this sentence names only the CADENCE, which is
  // true on every plan and in every currency.
  "orgs.max_owned":
    "Your current plan covers the most organisations it allows (Community 1, Pro 5, Pro Plus 10). On Pro or Pro Plus, buy an extra organisation from Settings → Add-ons; it's billed monthly on top of your current bill. Community upgrades to Pro first.",
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
  // V353 (#382) opened `scheduling.board` and `scheduling.constraints` to every
  // plan, so neither of these two can be reached from the ordinary plan gates
  // any more. They stay: an entitlement override can still switch either key
  // off for one org, and a paywall with no reason falls back to the flat "This
  // feature needs a plan upgrade.", which reads as a bug next to a priced
  // button. The wording no longer claims a plan.
  "scheduling.constraints": "The scheduling constraints solver is not available on this plan.",
  "scheduling.board": "Editing the schedule board is not available on this plan.",
  // Still a real paywall — and since V353 an Event Pass lifts it for one
  // competition, which is why the key is in `PASS_FEATURES`.
  "scheduling.multi_division":
    "The competition-wide schedule board is a Pro feature — or an Event Pass, for one competition.",
  "officials.auto": "Auto-assigning officials (solver, phased sourcing) is a Pro Plus feature — manual assignment still works.",
  "officials.roles_multi": "Multiple official roles per fixture (judge + referee) are a Pro feature.",
  "officials.per_fixture.max": "Community includes one official per fixture — more need Pro.",
  "officials.marks": "Rating your match officials is a Pro feature.",
  "scheduling.ai": "AI Schedule (plan, refine and repair your schedule from plain-language instructions) is not available on this plan.",
  // scheduling.ai.runs_per_division.max retired (v17 Phase 2 Task 5, V322):
  // the graded per-division run cap below it is gone, replaced by the
  // AI credit wallet's "ai.credits" reason (right below).
  // AI credit wallet (v17 Phase 2, SPEC-2 §5.2): AI Schedule and AI Officials
  // are metered by a prepaid credit balance on every tier, not by plan — this
  // fires when the wallet (`reserve()` in lib/credits.ts) is empty, replacing
  // the old per-division run cap above.
  "ai.credits":
    "You're out of AI credits for this billing period. Top up a credit pack or upgrade your plan to keep using AI Schedule and AI Officials.",
  "schedule.versioning": "Multi-site scope locks are a Pro feature — undo/redo always works.",
  "schedule.checkpoints.max": "You've reached your plan's save points — Pro includes five, Pro Plus unlimited. Undo/redo always works.",
  "domains.custom": "Serving your public pages on your own domain is a Pro Plus feature.",
  "support.priority": "Priority support is included with Pro Plus.",
  "scoring.device_links":
    "Hand-this-device-over scoring links are a Pro feature — your scorer seat still works.",
  // Registration & entry fees (doc 16 §1.1)
  "registration.enabled": "Online registration is not available on this plan.",
  // V309 seeds registration.paid TRUE on every plan, so no PLAN can deny this
  // any more — the only surviving 402 path is an org_entitlement_overrides deny
  // (staff switching entry fees off for one org). The copy has to make sense in
  // that context, so it must not offer an upgrade that would change nothing.
  "registration.paid":
    "Charging entry fees is switched off for this organisation. Free-event registration still works — contact support to turn card entry fees back on.",
  // Sponsors (doc 10 §1). Both are Event Pass-liftable, so <UpgradeGate>
  // renders these lines above a $29 CTA as well as the Pro one — say what is
  // still free on Community rather than implying sponsors need a plan at all.
  "sponsors.tiers":
    "Sponsor tiers (Title, Gold, Silver) and per-competition placement are a Pro feature — the flat partner strip is free on every plan.",
  "sponsors.monetize":
    "Selling priced sponsorship packages is a Pro feature — showing sponsor logos is free on every plan.",
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
// V112 + V240 + V290 + V291 + V302). Everything not listed unlocks on Pro —
// only the above-Pro (Pro Plus) exceptions need rows. (The AI run cap that
// used to be a graded quota here — V302: 5/10/20/50 — was retired in v17
// Phase 2 Task 5, V322: the credit wallet meters runs on every tier now.)
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
