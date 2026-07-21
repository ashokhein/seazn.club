/**
 * Feature keys an Event Pass lifts — every key whose `event_pass` row in
 * `plan_entitlements` beats the `community` row.
 *
 * ONE key the pass lifts is deliberately absent: `registration.fee_percent`
 * (8% → 5%). It is a deduction RATE read through `getLimit`
 * (server/usecases/registrations.ts) and never throws PaymentRequiredError, so
 * no paywall can ever render for it — listing it would be dead weight, not a
 * lost sale.
 *
 * Do not hand-edit this set against a spec doc: it drifted that way once and
 * cost the pass five paywalls.
 * `components/__tests__/upgrade-gate-pass-features.test.ts` derives the same set
 * from the live matrix and fails if the two disagree.
 *
 * ── Why this lives in lib/ and not in the component that reads it ────────────
 * `components/upgrade-gate.tsx` is `"use client"`. In the RSC graph every export
 * of a client module is replaced by a client *reference*, so a SERVER component
 * importing `PASS_FEATURES` from there would receive a proxy and
 * `PASS_FEATURES.has(...)` would throw. The upgrade page (a server component)
 * needs exactly this question — "is the key that sent them here one the pass
 * could ever lift?" — to tell its ceiling copy apart, and it must be the SAME
 * set the paywall uses or the two surfaces will describe one blocked feature
 * two different ways. So the set is a pure module and both sides import it;
 * `upgrade-gate.tsx` re-exports it so its existing importers are untouched.
 */
export const PASS_FEATURES = new Set([
  "divisions.per_competition.max",
  "entrants.per_division.max",
  "formats.advanced",
  "formats.double_elim",
  "realtime",
  "dashboard.player_profiles",
  "exports.branded",
  "sponsors.tiers",
  "sponsors.monetize",
  "scheduling.ai.runs_per_division.max",
]);
