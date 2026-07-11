import "server-only";
import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { invalidateOrgEntitlements } from "@/lib/entitlements";

/**
 * Params for an EMBEDDED subscription checkout (rendered in-page via Stripe's
 * Embedded Checkout, not a redirect). Pure — no Stripe/DB — so it's unit-tested.
 * Honours the 14-day no-card trial: `payment_method_collection: "if_required"`
 * + cancel when no card is added by trial end. `ui_mode: "embedded"` requires a
 * `return_url` (not success/cancel urls); Stripe redirects there on completion,
 * where the billing page reconciles from the session id.
 */
export function buildEmbeddedCheckoutParams(args: {
  priceId: string;
  orgId: string;
  returnUrl: string;
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
    payment_method_collection: "if_required",
    subscription_data: {
      trial_period_days: 14,
      trial_settings: { end_behavior: { missing_payment_method: "cancel" } },
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
 * customer portal instead, so paid state never desyncs. Idempotent.
 */
export async function downgradeToCommunity(orgId: string): Promise<void> {
  const [sub] = await sql<{ stripe_subscription_id: string | null }[]>`
    select stripe_subscription_id from subscriptions where org_id = ${orgId}`;
  if (sub?.stripe_subscription_id) {
    throw new HttpError(
      400,
      "This organization is billed through Stripe — cancel via Manage billing.",
    );
  }
  await sql`
    update subscriptions
    set plan_key = 'community', status = 'active', cancel_at_period_end = false
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
 * Label for the portal button on the billing page. A trialing Pro org has a
 * Stripe customer but no card yet (14-day no-card trial), so the primary ask is
 * "add a card"; once active it becomes ordinary billing management.
 */
export function billingCtaLabel(status: string): string {
  return status === "trialing" ? "Add a card to keep Pro →" : "Manage billing →";
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
  const planKey = priceId ? await planKeyForPrice(priceId) : null;
  const status = STATUS_MAP[stripeSub.status] ?? "past_due";
  // In Stripe v22, current_period_end lives on each subscription item.
  const periodEnd = stripeSub.items.data[0]?.current_period_end ?? null;

  await sql`
    insert into subscriptions
      (org_id, plan_key, status, stripe_subscription_id,
       current_period_end, trial_end, cancel_at_period_end, currency, updated_at)
    values
      (${orgId}, ${planKey ?? "community"}, ${status},
       ${stripeSub.id},
       ${periodEnd ? new Date(periodEnd * 1000).toISOString() : null},
       ${stripeSub.trial_end ? new Date(stripeSub.trial_end * 1000).toISOString() : null},
       ${stripeSub.cancel_at_period_end},
       ${stripeSub.currency ?? null},
       now())
    on conflict (org_id) do update set
      plan_key               = excluded.plan_key,
      status                 = excluded.status,
      stripe_subscription_id = excluded.stripe_subscription_id,
      current_period_end     = excluded.current_period_end,
      trial_end              = excluded.trial_end,
      cancel_at_period_end   = excluded.cancel_at_period_end,
      currency               = coalesce(excluded.currency, subscriptions.currency),
      updated_at             = now()`;
}

/**
 * Record an Event Pass purchase (v3/07 §3). Idempotent — shared by the
 * webhook and the reconcile-on-return path. Invalidates the org's cached
 * entitlements so the pass takes effect immediately.
 */
export async function recordPassPurchase(args: {
  orgId: string;
  competitionId: string;
  paymentIntent?: string | null;
}): Promise<void> {
  await sql`
    insert into competition_passes (competition_id, org_id, stripe_payment_intent)
    values (${args.competitionId}, ${args.orgId}, ${args.paymentIntent ?? null})
    on conflict (competition_id) do nothing`;
  await invalidateOrgEntitlements(args.orgId);
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
    await recordPassPurchase({
      orgId,
      competitionId,
      paymentIntent: typeof session.payment_intent === "string" ? session.payment_intent : null,
    });
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
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
