"use client";
// Event Pass state for the competition currently in view (v3/07 §3).
//
// The competition layout resolves BOTH facts a gate needs ONCE per request —
// does a `competition_passes` row exist for this competition, and is the org on
// a paid plan — and provides them here, so every gate under
// /o/[orgSlug]/c/[compSlug] reads an answer instead of issuing its own query.
// Client islands (UpgradeGate and friends) cannot query Postgres at all, which
// is the other half of why this crosses the RSC boundary as plain props.
//
// The default is deliberately FALSE on both: org-level pages have no
// competition in scope and never mount this provider, and a gate there must
// keep behaving exactly as it does today (offer Pro, no "already owned" state).
// Making the absent case indistinguishable from "community org, no pass" means
// an island can call the hooks unconditionally, wherever it renders.
//
// NOTE: pass presence is about the ROW EXISTING, never about payment.
// `competition_passes.stripe_payment_intent` is nullable — a staff-granted pass
// carries no intent and is fully active. Nothing downstream may filter on it.
import { createContext, useContext, useMemo, type ReactNode } from "react";

interface PassContext {
  /** A `competition_passes` row exists for the competition in view. */
  active: boolean;
  /**
   * The org's RESOLVED plan is not community — i.e. `isPaidPlan(orgPlanKey())`
   * as `lib/entitlements.ts` computes it, degradations and all. Derived on the
   * server so no plan-key vocabulary crosses into the client bundle.
   */
  paidPlan: boolean;
}

const CompetitionPassContext = createContext<PassContext>({
  active: false,
  paidPlan: false,
});

/**
 * Which Event Pass upsell is honest at this gate.
 *
 * - `none` — no pass, no paid plan (or no competition in scope): the $29 path
 *   is real and still offered.
 * - `held` — the org bought this competition's pass and has used what it buys.
 * - `paid_plan` — the org is on a paid plan, so the pass is MOOT. Not merely
 *   redundant: every key the pass lifts, the paid matrix lifts further, so
 *   offering it sells the customer less than they already hold.
 */
export type PassGateState = "none" | "held" | "paid_plan";

/**
 * Provide the resolved Event Pass state to a competition subtree. Mounted by
 * `app/o/[orgSlug]/c/[compSlug]/layout.tsx`; nothing else should mount it.
 *
 * `paidPlan` defaults to false — the SAFE default, because it is today's
 * behaviour (offer the pass). Defaulting the other way would silently suppress
 * a real upsell for every community org the moment a caller forgot the prop.
 */
export function CompetitionPassProvider({
  active,
  paidPlan = false,
  children,
}: {
  active: boolean;
  paidPlan?: boolean;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ active, paidPlan }), [active, paidPlan]);
  return (
    <CompetitionPassContext.Provider value={value}>{children}</CompetitionPassContext.Provider>
  );
}

/**
 * Does the org hold an Event Pass for the competition in view?
 *
 * Strictly the row question — it stays TRUE for an org that bought a pass and
 * later upgraded, because it did buy one. Ask `usePassGateState()` instead when
 * the question is "what should I offer here"; that one knows a paid plan makes
 * the pass moot.
 *
 * `false` outside a competition — this never throws for an unprovided context,
 * unlike the DictProvider hooks, because "no competition in scope" is a normal
 * place for a gate to render, not a wiring mistake.
 */
export function usePassActive(): boolean {
  return useContext(CompetitionPassContext).active;
}

/**
 * The one signal a paywall needs. Precedence is decided HERE, once.
 *
 * A paid plan beats a held pass: `lib/entitlements.ts` stops consulting
 * `competition_passes` entirely once the resolved plan is paid, so a gate that
 * fires for such an org was closed by its PLAN's ceiling. Explaining it with
 * "you've used everything the Event Pass includes" would name the wrong limit
 * and offer a credit against a purchase that may not exist.
 */
export function usePassGateState(): PassGateState {
  const { active, paidPlan } = useContext(CompetitionPassContext);
  if (paidPlan) return "paid_plan";
  return active ? "held" : "none";
}
