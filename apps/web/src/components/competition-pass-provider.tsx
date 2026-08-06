"use client";
// Event Pass state for the competition currently in view (v3/07 §3, v17 #301).
//
// The competition layout resolves every fact a gate needs ONCE per request —
// does a `competition_passes` row exist for this competition and at which rung,
// is the org on a paid plan, what currency does it buy in, and (if a row
// exists) WHY the pass has stopped applying if it has — and provides them here,
// so every gate under /o/[orgSlug]/c/[compSlug] reads an answer instead of
// issuing its own query. Client islands (UpgradeGate and friends) cannot query
// Postgres at all, which is the other half of why this crosses the RSC boundary
// as plain props.
//
// The default is deliberately the ABSENT/SAFE value on all of them: org-level
// pages have no competition in scope and never mount this provider, and a gate
// there must keep behaving exactly as it does today (offer Pro, no "already
// owned" state). Making the absent case indistinguishable from "community org,
// no pass" means an island can call the hooks unconditionally, wherever it
// renders.
//
// NOTE: pass presence is about the ROW EXISTING, never about payment.
// `competition_passes.stripe_payment_intent` is nullable — a staff-granted pass
// carries no intent and is fully active. Nothing downstream may filter on it.
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { PASS_KEYS, type Currency, type PassKey } from "@/lib/currency";
import type { PassLockReason } from "@/lib/entitlements";

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
  /**
   * v17 #301 — WHY the held pass has stopped applying, or `null` while it still
   * does (or there is no pass at all). Computed server-side by
   * `passLockReason(status, ends_on)` in `lib/entitlements.ts`, the ONE place
   * the arms live, and never re-derived here: a second copy of "which statuses
   * are terminal" or of the grace-window arithmetic is exactly how the UI and
   * the resolver drift apart again.
   */
  lockReason: PassLockReason | null;
  /**
   * The rungs this org may still BUY here (v17 #327). The whole ladder on a free
   * plan; on a paid plan only the rungs that beat it, which today means L
   * against Pro and nothing at all against Pro Plus.
   *
   * Carried so a buy surface can quote the floor of what is ACTUALLY for sale.
   * Without it a Pro organiser at their entrant ceiling is offered "from $29"
   * and lands on a page selling one $59 rung — a price for something the
   * checkout would refuse, which is the #294 mis-sale in a new costume.
   */
  sellableRungs: readonly PassKey[];
}

const CompetitionPassContext = createContext<PassContext>({
  passKey: null,
  paidPlan: false,
  currency: "usd",
  lockReason: null,
  sellableRungs: PASS_KEYS,
});

/**
 * Which Event Pass upsell is honest at this gate.
 *
 * - `none` — no pass, no paid plan (or no competition in scope): the $29 path
 *   is real and still offered.
 * - `held` — the org bought this competition's pass and it is STILL APPLYING.
 * - `ended` — the org bought this competition's pass, but it has stopped
 *   applying: the competition reached a terminal status, or ran past its end
 *   date plus grace. The row is never deleted and the pass is never re-sold
 *   (one per competition, forever) but it is no longer lifting anything, so
 *   nothing may claim the org is still getting something from it. `held` used
 *   to swallow this case whole — v17 gap #301.
 * - `paid_plan` — the org is on a paid plan, so the pass is MOOT. Not merely
 *   redundant: every key the pass lifts, the paid matrix lifts further, so
 *   offering it sells the customer less than they already hold.
 * - `closed` — the competition is past the line where a pass may be sold at
 *   all, and NO pass was ever held (#376). Distinct from `ended`, which reports
 *   a purchase that has stopped applying: there is no purchase here, so nothing
 *   to report as stopped — only a sale that is no longer available. `none`
 *   used to swallow this whole, which put the buy link on a checkout the route
 *   refuses with 410 Gone.
 */
export type PassGateState = "none" | "held" | "ended" | "paid_plan" | "closed";

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
 *
 * `lockReason` defaults to null on the same principle, pointed the other way:
 * "still applying" is what every call site meant before v17 #301, so an
 * omission cannot silently declare a live pass dead and strip an org of a
 * signal it paid for.
 */
export function CompetitionPassProvider({
  passKey,
  paidPlan = false,
  currency = "usd",
  lockReason = null,
  // Defaults to the WHOLE ladder for the same reason `currency` defaults to usd:
  // an omission has to degrade to the behaviour that shipped before #327, which
  // is "every rung is for sale", never to "nothing is".
  sellableRungs = PASS_KEYS,
  children,
}: {
  passKey: PassKey | null;
  paidPlan?: boolean;
  currency?: Currency;
  lockReason?: PassLockReason | null;
  sellableRungs?: readonly PassKey[];
  children: ReactNode;
}) {
  const value = useMemo(
    () => ({ passKey, paidPlan, currency, lockReason, sellableRungs }),
    [passKey, paidPlan, currency, lockReason, sellableRungs],
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
 * WHY a held pass has stopped applying, or `null` — still applying, no pass, or
 * no competition in scope. Only worth reading when `usePassGateState()` is
 * `"ended"`; a surface that just needs the yes/no should use that instead.
 *
 * Carries the REASON rather than a boolean because the two arms want different
 * sentences and different next steps: a competition that finished is done and
 * the org should be pointed at its next one, while a competition that merely
 * ran past `ends_on` is often still being played and the date is the thing to
 * fix. Collapsing them is how one apologetic "your pass has ended" ends up
 * shown to an organiser whose only problem is a stale end date.
 *
 * Like `usePassActive`/`usePassRung` this answers the PASS's own question and
 * ignores the plan — `usePassGateState()` is where the precedence lives.
 */
export function usePassLockReason(): PassLockReason | null {
  return useContext(CompetitionPassContext).lockReason;
}

/**
 * The one signal a paywall needs. Precedence is decided HERE, once.
 *
 * A paid plan beats everything: `lib/entitlements.ts` stops consulting
 * `competition_passes` entirely once the resolved plan is paid, so a gate that
 * fires for such an org was closed by its PLAN's ceiling. Explaining it with
 * "you've used everything the Event Pass includes" would name the wrong limit
 * and offer a credit against a purchase that may not exist.
 *
 * A locked pass beats "held": once `lockReason` is set the resolver has already
 * stopped honouring the row (SPEC-4 §7), so no surface may present it as still
 * active (v17 gap #301). It is not "none" either — the pass is never re-sold,
 * so offering the purchase again would be a second lie in the other direction.
 *
 * Note the ORDER of the last two: `passKey` is checked before `lockReason`,
 * and a lock reason with NO pass row resolves `closed` (#376) — never `ended`,
 * which would invent a purchase for a competition that never had one, and
 * never `none`, which would put the buy link on a sale the route answers with
 * 410 Gone.
 */
/** The rungs this org may still buy here (#327) — see `sellableRungs`. */
export function usePassSellableRungs(): readonly PassKey[] {
  return useContext(CompetitionPassContext).sellableRungs;
}

export function usePassGateState(): PassGateState {
  const { passKey, paidPlan, lockReason } = useContext(CompetitionPassContext);
  if (paidPlan) return "paid_plan";
  // No pass row, and the competition is past the line: `closed` (#376). This
  // used to resolve `none`, which put the buy link on a purchase the route
  // refuses with 410. It is NOT `ended` — nothing was bought, so there is no
  // purchase to report as stopped, which is what the note above was right
  // about and what `closed` exists to preserve.
  if (passKey === null) return lockReason !== null ? "closed" : "none";
  return lockReason !== null ? "ended" : "held";
}
