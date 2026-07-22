/**
 * Which Event Pass call-to-action the /pricing column should carry (task 19,
 * spec D3 — entry point 3 of 4).
 *
 * The column used to send everyone to `/login?tab=signup`, which for a
 * signed-in organiser is a dead end: they already have an account, and the one
 * page that can actually sell them a pass — `routes.competitionUpgrade` — needs
 * a competition, which a marketing page does not have. So the signed-in path
 * hands off to the console instead, where the competition list (entry point 4)
 * offers the pass per competition.
 *
 * `included` exists for the same reason the console entry points render
 * themselves away for a paid org: Pro's matrix is a strict superset of the
 * pass, so inviting a paying customer to spend $29 sells them a DOWNGRADE (the
 * pass grants 10 AI runs per division against pro's 20, and 64 entrants per
 * division against pro's 256). `paidPlan` must come from
 * `isPaidPlan(orgPlanKey())` — the resolver's derivation, degradations and all,
 * not `subscriptions.plan_key` raw — so a lapsed comp or a past_due org beyond
 * its grace, both of which resolve as community, still get the offer.
 *
 * Pure so the rule is pinned by unit tests rather than a browser run.
 */
export type PassCtaVariant = "signup" | "console" | "included";

export function passCtaVariant(opts: {
  signedIn: boolean;
  /** Resolved plan of the viewer's active org; irrelevant when signed out. */
  paidPlan: boolean;
}): PassCtaVariant {
  if (!opts.signedIn) return "signup";
  return opts.paidPlan ? "included" : "console";
}
