"use client";
// Event Pass state for the competition currently in view (v3/07 §3).
//
// The competition layout resolves `competition_passes` ONCE per request and
// provides the answer here, so every gate under /o/[orgSlug]/c/[compSlug]
// reads a boolean instead of issuing its own query. Client islands (UpgradeGate
// and friends) cannot query Postgres at all, which is the other half of why
// this crosses the RSC boundary as a plain prop.
//
// The default is deliberately FALSE, not null/undefined: org-level pages have
// no competition in scope and never mount this provider, and a gate there must
// keep behaving exactly as it does today (offer Pro, no "already owned" state).
// Making the absent case indistinguishable from "no pass" means an island can
// call usePassActive() unconditionally, wherever it renders.
//
// NOTE: presence is about the ROW EXISTING, never about payment.
// `competition_passes.stripe_payment_intent` is nullable — a staff-granted pass
// carries no intent and is fully active. Nothing downstream may filter on it.
import { createContext, useContext, type ReactNode } from "react";

const CompetitionPassContext = createContext<boolean>(false);

/**
 * Provide the resolved Event Pass state to a competition subtree. Mounted by
 * `app/o/[orgSlug]/c/[compSlug]/layout.tsx`; nothing else should mount it.
 */
export function CompetitionPassProvider({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  return (
    <CompetitionPassContext.Provider value={active}>{children}</CompetitionPassContext.Provider>
  );
}

/**
 * Does the org hold an Event Pass for the competition in view?
 *
 * `false` outside a competition — this never throws for an unprovided context,
 * unlike the DictProvider hooks, because "no competition in scope" is a normal
 * place for a gate to render, not a wiring mistake.
 */
export function usePassActive(): boolean {
  return useContext(CompetitionPassContext);
}
