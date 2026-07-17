/**
 * Canonical PostHog event names, shared by the client tracker (lib/analytics)
 * and the server capture path (lib/posthog-server). No imports here so both
 * runtimes can pull it in freely.
 *
 * Funnels these power:
 *  - Activation (feature 1): signup → onboarding → COMPETITION_CREATED →
 *    DIVISION_CREATED → RESULT_ENTERED (the true "aha": a live scoreline)
 *  - Revenue (feature 2): PRICING_VIEWED / BILLING_VIEWED → CHECKOUT_STARTED
 *    → SUBSCRIPTION_STARTED (or PAYMENT_FAILED / SUBSCRIPTION_CANCELED)
 */
export const EVENTS = {
  PRICING_VIEWED: "pricing_viewed",
  BILLING_VIEWED: "billing_viewed",
  CHECKOUT_STARTED: "checkout_started",
  // Start-a-competition funnel (v3/07 §6): draft-created → claimed, then
  // COMPETITION_CREATED continues into the activation funnel below.
  FUNNEL_DRAFT_CREATED: "funnel_draft_created",
  FUNNEL_CLAIMED: "funnel_claimed",
  COMPETITION_CREATED: "competition_created",
  DIVISION_CREATED: "division_created",
  SCHEDULE_GENERATED: "schedule_generated",
  REGISTRATION_SUBMITTED: "registration_submitted",
  COMPETITION_STARTED: "competition_started",
  RESULT_ENTERED: "result_entered",
  COMPETITION_COMPLETED: "competition_completed",
  SUBSCRIPTION_STARTED: "subscription_started",
  SUBSCRIPTION_CANCELED: "subscription_canceled",
  PAYMENT_FAILED: "payment_failed",
  // In-app billing management (v3/11) — the portal-replacement surface.
  BILLING_CARD_ADDED: "billing_card_added",
  BILLING_INTERVAL_CHANGED: "billing_interval_changed",
  SUBSCRIPTION_CANCEL_SCHEDULED: "subscription_cancel_scheduled",
  SUBSCRIPTION_RESUMED: "subscription_resumed",
  // PLG growth loops (2026-07-17 plan) — distribution + referral.
  ATTRIBUTION_CLICKED: "attribution_clicked",
  SHARE_FIRED: "share_fired",
  PLAYER_STARTED_OWN_ORG: "player_started_own_org",
  COMPETITION_MADE_PUBLIC: "competition_made_public",
  EMBED_RENDERED: "embed_rendered",
} as const;

export type AnalyticsEvent = (typeof EVENTS)[keyof typeof EVENTS];

/** PostHog group type for our multi-tenant model — one group per club/org. */
export const ORG_GROUP = "organization";
