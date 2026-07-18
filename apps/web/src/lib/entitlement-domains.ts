// Domain grouping for entitlement keys — shared by /pricing and
// /admin/entitlements so the two surfaces tell the same story (V290).
// Keys NOT listed here are deliberately unadvertised (vestigial D9 keys +
// domains.custom until Spec 2 ships) — /admin still shows them under "other".
export const ENTITLEMENT_DOMAINS: { slug: string; features: string[] }[] = [
  { slug: "scale", features: [
    "competitions.max_active", "orgs.max_owned", "divisions.per_competition.max",
    "entrants.per_division.max", "members.max", "scorers.max",
    "stages.per_division.max", "dashboard.public.max", "import.bulk",
  ]},
  { slug: "money", features: [
    "registration.enabled", "registration.paid", "sponsors.tiers", "sponsors.monetize",
  ]},
  { slug: "formats", features: [
    "formats.advanced", "formats.double_elim", "standings.custom_points",
    "standings.carry_over", "tiebreakers.custom",
  ]},
  { slug: "scheduling", features: [
    "scheduling.board", "scheduling.constraints", "scheduling.multi_division",
    "scheduling.ai", "schedule.checkpoints.max", "schedule.versioning",
  ]},
  { slug: "scoring", features: [
    "scoring.ball_by_ball", "scoring.rally_by_rally", "scoring.match_timeline",
    "scoring.device_links", "cricket.dls", "stats.player",
  ]},
  { slug: "officials", features: [
    "officials.per_fixture.max", "officials.roles_multi", "officials.auto",
  ]},
  { slug: "brand", features: [
    "branding", "dashboard.branding", "realtime", "embeds.enabled",
    "discovery.listed", "discovery.featured", "discovery.branding",
    "exports", "exports.branded",
  ]},
  { slug: "platform", features: [
    "clubs.hierarchy", "logos.bulk", "api.access", "api.write", "support.priority",
  ]},
];
