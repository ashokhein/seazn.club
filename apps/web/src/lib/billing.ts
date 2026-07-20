import "server-only";
import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { invalidateOrgEntitlements } from "@/lib/entitlements";

/**
 * Params for an EMBEDDED subscription checkout (rendered in-page via Stripe's
 * Embedded Checkout, not a redirect). Pure — no Stripe/DB — so it's unit-tested.
 * `trialDays` 14 = the no-card trial (`payment_method_collection:
 * "if_required"` + cancel when no card is added by trial end); 0 = no trial
 * block at all, so Stripe charges at checkout and always collects a card —
 * one trial per org, decided by the caller via checkoutTrialDays().
 * `ui_mode: "embedded"` requires a `return_url` (not success/cancel urls);
 * Stripe redirects there on completion, where the billing page reconciles
 * from the session id.
 */
export function buildEmbeddedCheckoutParams(args: {
  priceId: string;
  orgId: string;
  returnUrl: string;
  trialDays: number;
  customerId?: string;
  customerEmail?: string;
  /** ISO currency picking one of the price's currency_options (v3/07 §4);
   *  omit for the price's default (usd). */
  currency?: string;
}): Stripe.Checkout.SessionCreateParams {
  return {
    // stripe-node v22 names the embedded UI mode "embedded_page".
    ui_mode: "embedded_page",
    mode: "subscription",
    ...(args.customerId ? { customer: args.customerId } : { customer_email: args.customerEmail }),
    ...(args.currency && args.currency !== "usd" ? { currency: args.currency } : {}),
    metadata: { org_id: args.orgId },
    ...(args.trialDays > 0 ? { payment_method_collection: "if_required" as const } : {}),
    subscription_data: {
      ...(args.trialDays > 0
        ? {
            trial_period_days: args.trialDays,
            trial_settings: { end_behavior: { missing_payment_method: "cancel" as const } },
          }
        : {}),
      metadata: { org_id: args.orgId },
    },
    line_items: [{ price: args.priceId, quantity: 1 }],
    return_url: args.returnUrl,
    allow_promotion_codes: true,
    tax_id_collection: { enabled: true },
    automatic_tax: { enabled: true },
  };
}

/**
 * One trial per organisation (product gap 2026-07-13): the downgrade→upgrade
 * loop must not re-arm the 14-day trial. `trial_used_at` means "this org has
 * had Pro": syncSubscription stamps it on the first sync of ANY subscription,
 * trialing or not, and it is never cleared.
 */
export function checkoutTrialDays(
  sub: { trial_used_at: string | null } | undefined,
): number {
  return sub?.trial_used_at ? 0 : 14;
}

/** Statuses in which a Stripe subscription still owns the org's billing. Our
 *  STATUS_MAP collapses incomplete/unpaid/paused into past_due, so this list
 *  is the whole non-terminal set. `canceled` is terminal — a departed customer
 *  must be able to come back. */
const LIVE_SUBSCRIPTION_STATUSES = ["trialing", "active", "past_due"];

/**
 * Is this org billed by a subscription right now? A cancelled subscription
 * keeps its id on the row forever, so the id alone is NOT the test — anything
 * branching on `stripe_subscription_id` would treat a long-departed customer as
 * Stripe-billed. Shared by the checkout guard and the staff trial grant so the
 * two can never drift apart.
 *
 * Type predicate: a true result means both columns are non-null, so callers can
 * read `sub.stripe_subscription_id` / `sub.status` without a `!` assertion.
 */
export function hasLiveSubscription(
  sub: { stripe_subscription_id: string | null; status: string | null } | undefined,
): sub is { stripe_subscription_id: string; status: string } {
  return (
    !!sub?.stripe_subscription_id &&
    LIVE_SUBSCRIPTION_STATUSES.includes(sub.status ?? "")
  );
}

/**
 * A live Stripe subscription means plan changes go through the in-app manage
 * flow — a second checkout would mint a second subscription for the same org.
 * Dunning counts as live: the subscription is still there, it just needs a
 * working card, so the message points at that rather than at a new purchase.
 */
export function assertCheckoutAllowed(
  sub: { stripe_subscription_id: string | null; status: string | null } | undefined,
): void {
  if (!hasLiveSubscription(sub)) return;
  if (sub.status === "past_due") {
    throw new HttpError(
      409,
      "This organization's subscription needs a working payment method — update your card or retry the invoice from the billing page instead of starting a new subscription.",
    );
  }
  throw new HttpError(
    409,
    "This organization already has a subscription — manage your plan from the billing page instead.",
  );
}

/**
 * Params for an EMBEDDED one-time Event Pass checkout (v3/07 §3). Same
 * embedded_page/return_url contract as the subscription flow, but
 * mode:"payment" and competition-scoped metadata — the reconcile/webhook path
 * turns a paid session into a competition_passes row. Pure, unit-tested.
 */
export function buildPassCheckoutParams(args: {
  priceId: string;
  orgId: string;
  competitionId: string;
  returnUrl: string;
  customerId?: string;
  customerEmail?: string;
  currency?: string;
}): Stripe.Checkout.SessionCreateParams {
  return {
    ui_mode: "embedded_page",
    mode: "payment",
    ...(args.customerId ? { customer: args.customerId } : { customer_email: args.customerEmail }),
    ...(args.currency && args.currency !== "usd" ? { currency: args.currency } : {}),
    metadata: { org_id: args.orgId, competition_id: args.competitionId, pass_key: "event_pass" },
    line_items: [{ price: args.priceId, quantity: 1 }],
    return_url: args.returnUrl,
    allow_promotion_codes: true,
    tax_id_collection: { enabled: true },
    automatic_tax: { enabled: true },
  };
}

/**
 * In-app downgrade to Community for orgs WITHOUT a Stripe subscription
 * (admin-comped / dev-granted Pro). A Stripe-billed org must cancel through the
 * in-app Cancel (period-end) flow instead, so paid state never desyncs. Idempotent.
 */
export async function downgradeToCommunity(orgId: string): Promise<void> {
  const [sub] = await sql<{ stripe_subscription_id: string | null }[]>`
    select stripe_subscription_id from subscriptions where org_id = ${orgId}`;
  if (sub?.stripe_subscription_id) {
    throw new HttpError(
      400,
      "This organization is billed through Stripe — use “Cancel subscription” on this page.",
    );
  }
  await sql`
    update subscriptions
    set plan_key = 'community', status = 'active', cancel_at_period_end = false,
        status_changed_at = case when status is distinct from 'active'
                                 then now() else status_changed_at end
    where org_id = ${orgId}`;
  await invalidateOrgEntitlements(orgId);
}

/** Map a Stripe subscription status to our subscription status enum. */
const STATUS_MAP: Record<string, string> = {
  trialing: "trialing",
  active: "active",
  past_due: "past_due",
  canceled: "canceled",
  incomplete: "past_due",
  incomplete_expired: "canceled",
  unpaid: "past_due",
  paused: "past_due",
};

/**
 * Label for the primary billing CTA. A trialing Pro org has a Stripe customer
 * but no card yet (14-day no-card trial), so the primary ask is "add a card";
 * once active it's ordinary card management — both in-app now (v3/11).
 */
export function billingCtaLabel(status: string): string {
  return status === "trialing" ? "Add a card to keep Pro →" : "Manage payment methods";
}

/** Look up our plan_key from a Stripe price ID. */
export async function planKeyForPrice(priceId: string): Promise<string | null> {
  const [row] = await sql<{ key: string }[]>`
    select key from plans
    where stripe_price_id_monthly = ${priceId}
       or stripe_price_id_annual  = ${priceId}`;
  return row?.key ?? null;
}

/**
 * Upsert an org's subscription row from a Stripe Subscription object. Shared by
 * the webhook handler and the reconcile-on-return path so both stay in sync.
 */
export async function syncSubscription(
  orgId: string,
  stripeSub: Stripe.Subscription,
): Promise<void> {
  const priceId = stripeSub.items.data[0]?.price?.id ?? null;
  const knownPlanKey = priceId ? await planKeyForPrice(priceId) : null;
  // Unknown price (grandfathered/migrated in Stripe but not synced into `plans`):
  // keep the org's current plan instead of silently downgrading every affected
  // customer — the stripe:sync drift is a staff problem, not the customer's.
  if (priceId && !knownPlanKey) console.error("syncSubscription: unknown price", priceId);
  const status = STATUS_MAP[stripeSub.status] ?? "past_due";
  // In Stripe v22, current_period_end lives on each subscription item.
  const periodEnd = stripeSub.items.data[0]?.current_period_end ?? null;

  await sql`
    insert into subscriptions
      (org_id, plan_key, status, stripe_subscription_id,
       current_period_end, trial_end, trial_used_at, cancel_at_period_end, currency,
       updated_at, status_changed_at)
    values
      (${orgId}, ${knownPlanKey ?? "community"}, ${status},
       ${stripeSub.id},
       ${periodEnd ? new Date(periodEnd * 1000).toISOString() : null},
       ${stripeSub.trial_end ? new Date(stripeSub.trial_end * 1000).toISOString() : null},
       ${new Date().toISOString()},
       ${stripeSub.cancel_at_period_end},
       ${stripeSub.currency ?? null},
       now(), now())
    on conflict (org_id) do update set
      -- Unknown price keeps the org's current plan (never mass-downgrade on drift).
      plan_key               = coalesce(${knownPlanKey}, subscriptions.plan_key, 'community'),
      status                 = excluded.status,
      stripe_subscription_id = excluded.stripe_subscription_id,
      current_period_end     = excluded.current_period_end,
      trial_end              = excluded.trial_end,
      -- One trial per org — and "trial" means "has had Pro". Any subscription
      -- reaching us counts, including a dashboard-created one that never
      -- carried a trial_end (V277's backfill always assumed this; the code
      -- did not). Never cleared except by the staff Restore trial action.
      -- excluded.trial_used_at is always non-null (the insert stamps it
      -- unconditionally); now() is a backstop should that ever become
      -- conditional again.
      trial_used_at          = coalesce(subscriptions.trial_used_at,
                                        excluded.trial_used_at, now()),
      cancel_at_period_end   = excluded.cancel_at_period_end,
      currency               = coalesce(excluded.currency, subscriptions.currency),
      -- Task 7 fold-in: a re-buy (new sub id) clears any stale dispute flags so an
      -- old dispute's late loss can't downgrade the fresh sub; a renewal (same id)
      -- leaves an in-flight dispute's flags intact.
      disputed_at            = case when subscriptions.stripe_subscription_id
                                      is distinct from excluded.stripe_subscription_id
                                    then null else subscriptions.disputed_at end,
      dispute_id             = case when subscriptions.stripe_subscription_id
                                      is distinct from excluded.stripe_subscription_id
                                    then null else subscriptions.dispute_id end,
      -- Grace anchor: stamp only on a real status TRANSITION — a same-status
      -- re-sync (webhook replay, dunning retry) must not move it.
      status_changed_at      = case when subscriptions.status is distinct from excluded.status
                                    then now() else subscriptions.status_changed_at end,
      updated_at             = now()`;
}

/**
 * Record an Event Pass purchase (v3/07 §3). Idempotent — shared by the webhook
 * and the reconcile-on-return path; invalidates the org's cached entitlements
 * so the pass takes effect immediately.
 *
 * The pass is keyed by competition_id, so only the FIRST payment records. An
 * insert that loses the conflict is either a REPLAY of the same payment
 * (webhook + reconcile racing on one intent — NOT a duplicate) or a genuine
 * SECOND charge (two owners / two tabs). `duplicateIntent` is the losing intent
 * only in the second case, so callers can send it straight back (P0-3b).
 */
export async function recordPassPurchase(args: {
  orgId: string;
  competitionId: string;
  paymentIntent?: string | null;
}): Promise<{ recorded: boolean; duplicateIntent: string | null }> {
  const [inserted] = await sql<{ competition_id: string }[]>`
    insert into competition_passes (competition_id, org_id, stripe_payment_intent)
    values (${args.competitionId}, ${args.orgId}, ${args.paymentIntent ?? null})
    on conflict (competition_id) do nothing
    returning competition_id`;
  if (inserted) {
    await invalidateOrgEntitlements(args.orgId);
    return { recorded: true, duplicateIntent: null };
  }
  const [existing] = await sql<{ stripe_payment_intent: string | null }[]>`
    select stripe_payment_intent from competition_passes
    where competition_id = ${args.competitionId}`;
  const dup =
    args.paymentIntent && existing?.stripe_payment_intent !== args.paymentIntent
      ? args.paymentIntent
      : null;
  return { recorded: false, duplicateIntent: dup };
}

/**
 * Send a duplicate Event Pass payment straight back (registrations' duplicate
 * contract): a second owner / second tab paid for a competition that already
 * has a pass. The Stripe call is deliberately OUTSIDE any transaction and
 * swallows its own failure — a refund hiccup surfaces in the Stripe dashboard
 * but NEVER blocks the webhook / reconcile ACK. A pass charge is a plain
 * platform charge, so no reverse_transfer/application_fee flags. The idempotency
 * key makes a retried refund of the same intent a no-op. (P0-3b)
 */
export async function refundDuplicatePassPayment(intent: string): Promise<void> {
  try {
    await getStripe().refunds.create(
      { payment_intent: intent },
      { idempotencyKey: `pass-dup-refund-${intent}` },
    );
  } catch {
    /* surfaces in Stripe dashboard; never blocks the ACK */
  }
}

/**
 * charge.refunded for an Event Pass (dashboard refunds included): a FULLY
 * refunded pass charge revokes the pass — money back means the comp rejoins
 * the quota (the freeze machinery handles any overage lazily). Partial
 * refunds leave the pass; owner outreach is a support flow, not code.
 */
export async function revokePassForRefundedCharge(charge: Stripe.Charge): Promise<boolean> {
  const intent =
    typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
  if (!intent || !charge.refunded) return false;
  const [revoked] = await sql<{ org_id: string; competition_id: string }[]>`
    delete from competition_passes where stripe_payment_intent = ${intent}
    returning org_id, competition_id`;
  if (!revoked) return false;
  await invalidateOrgEntitlements(revoked.org_id);
  return true;
}

/**
 * Reconcile a completed Event Pass checkout directly from Stripe (same
 * webhook-optional contract as reconcileCheckout). Returns true once the pass
 * is recorded. Best-effort and idempotent; never throws.
 */
export async function reconcilePassCheckout(
  orgId: string,
  sessionId: string,
): Promise<boolean> {
  try {
    const session = await getStripe().checkout.sessions.retrieve(sessionId);
    // Only trust a paid, pass-shaped session that belongs to this org.
    if (session.metadata?.pass_key !== "event_pass") return false;
    if (session.metadata.org_id !== orgId) return false;
    const competitionId = session.metadata.competition_id;
    if (!competitionId || session.payment_status !== "paid") return false;
    const res = await recordPassPurchase({
      orgId,
      competitionId,
      paymentIntent: typeof session.payment_intent === "string" ? session.payment_intent : null,
    });
    // Reconcile-on-return can land a second owner's payment; refund it (the
    // pass is already active from the first). The helper swallows its own
    // errors, so a refund hiccup never flips this reconcile to a failure.
    if (res.duplicateIntent) await refundDuplicatePassPayment(res.duplicateIntent);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reconcile a completed checkout directly from Stripe, so a paid org's plan
 * updates even if the webhook is delayed, missed, or (as happened) the endpoint
 * was deleted. Best-effort and idempotent; never throws.
 */
export async function reconcileCheckout(
  orgId: string,
  sessionId: string,
): Promise<boolean> {
  try {
    const session = await getStripe().checkout.sessions.retrieve(sessionId, {
      expand: ["subscription", "subscription.items.data.price"],
    });

    // Only trust a session that belongs to this org.
    if (session.metadata?.org_id && session.metadata.org_id !== orgId) {
      return false;
    }

    if (session.customer) {
      await sql`
        update subscriptions set stripe_customer_id = ${session.customer as string}
        where org_id = ${orgId}`;
    }

    const subObj = session.subscription;
    if (subObj && typeof subObj !== "string") {
      await syncSubscription(orgId, subObj);
      // The plan just changed in `subscriptions`; drop the cached entitlement
      // resolver so a missed-webhook reconcile takes effect immediately instead
      // of waiting out the TTL (mirrors recordPassPurchase on the pass path).
      await invalidateOrgEntitlements(orgId);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
