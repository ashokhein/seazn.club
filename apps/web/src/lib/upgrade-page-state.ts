import { PASS_FEATURES } from "@/lib/pass-features";
import type { PassLockReason } from "@/lib/entitlements";

/**
 * Which of the upgrade page's six states is honest for this viewer (spec D10;
 * v17 gap #301 added the sixth — the five below counted `offer` twice, once
 * per `canBuy`).
 *
 * The page had exactly one shape per branch of `pass ? … : isPro ? … : offer`,
 * which is three states for five situations: a non-owner was shown a price they
 * cannot pay behind a sentence, and a pass holder who came back after hitting
 * the pass's own ceiling got the same "you're all set" box as one who arrived
 * to admire the purchase.
 *
 * ── Precedence ──────────────────────────────────────────────────────────────
 * A paid plan wins over EVERYTHING, including a pass row. That is not a
 * cosmetic ordering: `lib/entitlements.ts` stops consulting the pass entirely
 * once the resolved plan is paid, so under a paid plan the pass is not what
 * grants anything and cannot be what blocks anything. It is the same precedence
 * `usePassGateState()` applies (f70b8e52), written here rather than re-derived,
 * because "the pass does nothing here" and "stop selling the pass here" must
 * never be able to disagree.
 *
 * `paidPlan` MUST come from `isPaidPlan(orgPlanKey(orgId))` — the resolver's own
 * derivation. `subscriptions.plan_key` raw is a different question and gets the
 * lapsed-comp and past-grace-past_due cases backwards in both directions.
 *
 * `hasPass` is ROW EXISTENCE in `competition_passes`, never payment:
 * `stripe_payment_intent` is nullable (V271) and a staff-granted pass is fully
 * active.
 *
 * A LOCKED pass wins over the ceiling (v17 gap #301). Once `lockReason` is set
 * the resolver has already stopped honouring the pass (SPEC-4 §7), so a viewer
 * arriving with a `?feature=` query is not "at the pass's ceiling" at all — the
 * pass is lifting nothing any more, which is a different and truer story, and
 * the one that tells them what to actually do next. `lockReason` MUST come from
 * `passLockReason(status, ends_on)`, the ONE place the terminal-status and
 * past-ends-on arms live.
 */
export type UpgradePageState =
  /** The org is on a paid plan. No pass is offered, at any price. */
  | { kind: "paid_plan" }
  /**
   * A pass is held but has stopped applying — the competition reached a
   * terminal status, or ran past its end date plus the grace week. Never
   * re-offered (decision #248 Q4: one pass per competition, forever), so the
   * only real next steps are the plan, or a fresh competition for next time.
   */
  | { kind: "ended"; reason: PassLockReason }
  /**
   * A pass is held AND a feature key came in with the request — the viewer was
   * sent here by something the pass cannot clear. `liftable` splits "you have
   * used everything the pass includes" from "that was never on the pass",
   * exactly as the paywall splits them.
   */
  | { kind: "ceiling"; feature: string; liftable: boolean }
  /** A pass is held and nothing is blocked. Confirm it, receipt it, offer Pro. */
  | { kind: "owned" }
  /** No pass. `canBuy` is false for anyone but the owner — nobody else can spend. */
  | { kind: "offer"; canBuy: boolean };

export function upgradePageState(input: {
  paidPlan: boolean;
  hasPass: boolean;
  /** Why a held pass has stopped applying, or null while it still does / no pass. */
  lockReason: PassLockReason | null;
  isOwner: boolean;
  /** `?feature=` — the entitlement key of the gate that sent them here. */
  feature?: string | null;
}): UpgradePageState {
  if (input.paidPlan) return { kind: "paid_plan" };
  if (input.hasPass) {
    // Before the ceiling, deliberately: see the precedence note above.
    if (input.lockReason) return { kind: "ended", reason: input.lockReason };
    const feature = input.feature?.trim();
    // A feature key only means "ceiling" when a pass is actually held. Arriving
    // with one and no pass is the ordinary offer: the pass may well lift it,
    // which is the whole reason the gate linked here.
    if (feature) return { kind: "ceiling", feature, liftable: PASS_FEATURES.has(feature) };
    return { kind: "owned" };
  }
  return { kind: "offer", canBuy: input.isOwner };
}
