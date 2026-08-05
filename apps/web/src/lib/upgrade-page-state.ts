import { PASS_FEATURES } from "@/lib/pass-features";
import type { PassLockReason } from "@/lib/entitlements";

/**
 * Which of the upgrade page's seven states is honest for this viewer (spec D10;
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
 *
 * A locked competition with NO pass wins over both offer arms (#376). The
 * route refuses the sale with 410 whatever the plan is, so a Buy button here
 * is a dead end for a community org and for a paid org holding a #327
 * exceeding rung alike. `hasPass` is what separates this from `ended`: same
 * line crossed, but nothing was ever bought, so there is no purchase to
 * report as stopped.
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
  /**
   * Past the pass line, and NO pass was ever held (#376) — *sellable: no,
   * held: never*. The fourth situation, which neither `ended` nor `offer`
   * fits: `ended` would claim a purchase nobody made, and `offer` puts a Buy
   * button on a checkout that answers 410 Gone
   * (`pass-checkout/route.ts` — `if (passLockReason(comp.status, comp.ends_on))`).
   *
   * `reason` rather than a boolean because the two arms want opposite next
   * steps, and this is the state where that matters most: `terminal` is done
   * and the organiser's move is next season, while `past_ends_on` is usually a
   * stale date on a competition still being played — fix the date and the pass
   * becomes buyable again. This state is RECOVERABLE on one arm and not the
   * other, and the copy has to say which.
   */
  | { kind: "closed"; reason: PassLockReason; canBuy: boolean }
  /**
   * No pass. `canBuy` is false for anyone but the owner — nobody else can spend.
   *
   * `beyondPlan` is the v17 #327 case: the viewer is on a PAID plan and a rung
   * still raises a limit that plan caps, so the offer is honest and the checkout
   * will take it. Only the exceeding rungs get a column, and the copy has to
   * explain why a paying customer is being shown a pass at all.
   */
  | { kind: "offer"; canBuy: boolean; beyondPlan: boolean };

export function upgradePageState(input: {
  paidPlan: boolean;
  hasPass: boolean;
  /** Why a held pass has stopped applying, or null while it still does / no pass. */
  lockReason: PassLockReason | null;
  isOwner: boolean;
  /** `?feature=` — the entitlement key of the gate that sent them here. */
  feature?: string | null;
  /**
   * Rungs that beat this org's plan on some axis (`passExceedsPlan`, #327).
   * Empty for a community org: every rung beats community, and populating it
   * there would only route the ordinary offer through the paid-plan branch.
   */
  exceedingRungs?: readonly string[];
}): UpgradePageState {
  // A paid plan no longer ends the conversation. It still does wherever the plan
  // really is a superset — but L raises `entrants.per_division.max` above Pro's
  // 256, so a Pro organiser with one oversized division has something real to
  // buy (#327). The list is computed from `plan_entitlements`, so this branch
  // closes by itself if Pro's cap is ever lifted.
  //
  // Only when NO pass is held: there is no M→L upgrade path (#294 Q3), so
  // offering a second pass for one competition would advertise a purchase this
  // product cannot complete.
  // The lock, but ONLY where no pass was ever held. Bound once, as a
  // `PassLockReason | null`, so both branches below narrow off the same value
  // rather than re-deriving the condition — and so the `closed` return needs
  // no non-null assertion.
  const closedToPasses = input.hasPass ? null : input.lockReason;

  if (input.paidPlan) {
    // #327's offer is subject to the line like every other offer. A paid org
    // with an exceeding rung on a FINISHED competition was being sold a pass
    // the route refuses — the same defect as the community chip, one plan tier
    // up, and absent from #376's write-up.
    if (!input.hasPass && closedToPasses === null && (input.exceedingRungs?.length ?? 0) > 0)
      return { kind: "offer", canBuy: input.isOwner, beyondPlan: true };
    return { kind: "paid_plan" };
  }
  // Before `hasPass`, and before the ordinary offer: this is the arm that used
  // to fall through to `offer` and render a checkout.
  if (closedToPasses !== null)
    return { kind: "closed", reason: closedToPasses, canBuy: input.isOwner };
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
  return { kind: "offer", canBuy: input.isOwner, beyondPlan: false };
}
