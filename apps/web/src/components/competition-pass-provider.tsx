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
import type { Currency, PassKey } from "@/lib/currency";

interface PassContext {
  /**
   * The RUNG on the `competition_passes` row for the competition in view, or
   * null when there is no row. Carries the rung and not just a boolean because
   * two rungs are live (v17 #294) and the surfaces that say "this competition
   * has a pass" have nothing else on screen to say WHICH one — an org that paid
   * $59 for L would otherwise read its own competition as holding the $29
   * product. `usePassActive()` still answers the plain row question.
   */
  passKey: PassKey | null;
  /**
   * The org's RESOLVED plan is not community — i.e. `isPaidPlan(orgPlanKey())`
   * as `lib/entitlements.ts` computes it, degradations and all. Derived on the
   * server so no plan-key vocabulary crosses into the client bundle.
   */
  paidPlan: boolean;
  /**
   * The currency this org would be CHARGED in — `preferredCurrency(org.id)`,
   * resolved on the server (a subscription's currency, then the switcher cookie,
   * then Accept-Language). A client island cannot compute any of that: cookies
   * and the org's subscription are both server-side, which is why the paywall
   * quoted a hardcoded "usd" to every reader on earth until v17 #294.
   */
  currency: Currency;
}

const CompetitionPassContext = createContext<PassContext>({
  passKey: null,
  paidPlan: false,
  currency: "usd",
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
 * `passKey` is REQUIRED and carries null for "no pass" rather than pairing a
 * boolean with a rung: two sources for one fact is how a card ends up saying
 * "Event Pass M active" over a row that reads `event_pass_l`.
 *
 * `paidPlan` defaults to false — the SAFE default, because it is today's
 * behaviour (offer the pass). Defaulting the other way would silently suppress
 * a real upsell for every community org the moment a caller forgot the prop.
 *
 * `currency` defaults to usd for the same reason: it is exactly what every
 * price under this provider rendered before v17 #294, so an omission degrades
 * to today rather than to a crash. The one production mount passes the real
 * `preferredCurrency`, and `pass-entry-points.test.ts` pins that it does.
 */
export function CompetitionPassProvider({
  passKey,
  paidPlan = false,
  currency = "usd",
  children,
}: {
  passKey: PassKey | null;
  paidPlan?: boolean;
  currency?: Currency;
  children: ReactNode;
}) {
  const value = useMemo(
    () => ({ passKey, paidPlan, currency }),
    [passKey, paidPlan, currency],
  );
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
  return useContext(CompetitionPassContext).passKey !== null;
}

/**
 * WHICH rung the competition in view holds — null when it holds no pass.
 *
 * Strictly the row's own `pass_key`, with the same "presence, never payment"
 * semantics as `usePassActive()`. A surface that says a pass is active and
 * cannot say which one is naming M's product to an L buyer; this is the only
 * thing on the client that knows the difference.
 */
export function usePassRung(): PassKey | null {
  return useContext(CompetitionPassContext).passKey;
}

/**
 * The currency prices under this provider must be quoted in.
 *
 * usd outside a competition — no provider, no org, nothing to resolve — which
 * is what every gate rendered everywhere before v17 #294.
 */
export function usePassCurrency(): Currency {
  return useContext(CompetitionPassContext).currency;
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
  const { passKey, paidPlan } = useContext(CompetitionPassContext);
  if (paidPlan) return "paid_plan";
  return passKey !== null ? "held" : "none";
}
