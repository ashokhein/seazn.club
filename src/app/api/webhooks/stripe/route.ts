import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { sql } from "@/lib/db";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Look up our plan_key from a Stripe price ID. */
async function planKeyForPrice(priceId: string): Promise<string | null> {
  const [row] = await sql<{ key: string }[]>`
    select key from plans
    where stripe_price_id_monthly = ${priceId}
       or stripe_price_id_annual  = ${priceId}`;
  return row?.key ?? null;
}

/** Upsert subscription row from a Stripe Subscription object. */
async function syncSubscription(
  orgId: string,
  stripeSub: Stripe.Subscription,
): Promise<void> {
  const priceId = stripeSub.items.data[0]?.price?.id ?? null;
  const planKey = priceId ? (await planKeyForPrice(priceId)) : null;

  // Map Stripe status to our status enum
  const statusMap: Record<string, string> = {
    trialing: "trialing",
    active: "active",
    past_due: "past_due",
    canceled: "canceled",
    incomplete: "past_due",
    incomplete_expired: "canceled",
    unpaid: "past_due",
    paused: "past_due",
  };
  const status = statusMap[stripeSub.status] ?? "past_due";

  // In Stripe v22, current_period_end lives on each subscription item
  const periodEnd = stripeSub.items.data[0]?.current_period_end ?? null;

  await sql`
    insert into subscriptions
      (org_id, plan_key, status, stripe_subscription_id,
       current_period_end, trial_end, cancel_at_period_end, updated_at)
    values
      (${orgId}, ${planKey ?? "community"}, ${status},
       ${stripeSub.id},
       ${periodEnd ? new Date(periodEnd * 1000).toISOString() : null},
       ${stripeSub.trial_end ? new Date(stripeSub.trial_end * 1000).toISOString() : null},
       ${stripeSub.cancel_at_period_end},
       now())
    on conflict (org_id) do update set
      plan_key              = excluded.plan_key,
      status                = excluded.status,
      stripe_subscription_id = excluded.stripe_subscription_id,
      current_period_end    = excluded.current_period_end,
      trial_end             = excluded.trial_end,
      cancel_at_period_end  = excluded.cancel_at_period_end,
      updated_at            = now()`;
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  const orgId = session.metadata?.org_id;
  if (!orgId) return;

  // Link the Stripe customer to this org
  if (session.customer) {
    await sql`
      update subscriptions set stripe_customer_id = ${session.customer as string}
      where org_id = ${orgId}`;
  }

  // Subscription details arrive via subscription.created; nothing more to do here.
}

async function handleSubscriptionChanged(stripeSub: Stripe.Subscription) {
  const orgId = stripeSub.metadata?.org_id;
  if (!orgId) return;
  await syncSubscription(orgId, stripeSub);
}

async function handleSubscriptionDeleted(stripeSub: Stripe.Subscription) {
  const orgId = stripeSub.metadata?.org_id;
  if (!orgId) return;
  await sql`
    update subscriptions
    set plan_key = 'community', status = 'canceled', updated_at = now()
    where org_id = ${orgId}`;
}

/** In Stripe v22 the subscription ref moved to invoice.parent.subscription_details.subscription */
function invoiceSubId(invoice: Stripe.Invoice): string | null {
  const sub = invoice.parent?.subscription_details?.subscription;
  if (!sub) return null;
  return typeof sub === "string" ? sub : sub.id;
}

async function handleInvoicePaymentFailed(invoice: Stripe.Invoice) {
  const subId = invoiceSubId(invoice);
  if (!subId) return;
  await sql`
    update subscriptions set status = 'past_due', updated_at = now()
    where stripe_subscription_id = ${subId}`;
}

async function handleInvoicePaymentSucceeded(invoice: Stripe.Invoice) {
  const subId = invoiceSubId(invoice);
  if (!subId) return;
  await sql`
    update subscriptions set status = 'active', updated_at = now()
    where stripe_subscription_id = ${subId} and status != 'trialing'`;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(req: Request) {
  const rawBody = await req.text();
  const sig = req.headers.get("stripe-signature");
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!sig || !secret) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(rawBody, sig, secret);
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  // Idempotency: skip if already processed
  const [existing] = await sql<{ id: string }[]>`
    select id from billing_events where id = ${event.id}`;
  if (existing) return NextResponse.json({ received: true });

  // Record event before processing (idempotency guard)
  const orgId = (event.data.object as { metadata?: { org_id?: string } })
    .metadata?.org_id ?? null;
  await sql`
    insert into billing_events (id, type, org_id, payload)
    values (${event.id}, ${event.type}, ${orgId}, ${JSON.stringify(event.data.object)})
    on conflict (id) do nothing`;

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
        break;
      case "customer.subscription.created":
      case "customer.subscription.updated":
        await handleSubscriptionChanged(event.data.object as Stripe.Subscription);
        break;
      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
        break;
      case "invoice.payment_failed":
        await handleInvoicePaymentFailed(event.data.object as Stripe.Invoice);
        break;
      case "invoice.payment_succeeded":
        await handleInvoicePaymentSucceeded(event.data.object as Stripe.Invoice);
        break;
      // Unhandled events are silently ACKed
    }

    await sql`
      update billing_events set processed_at = now() where id = ${event.id}`;
  } catch (err) {
    // Return 5xx so Stripe retries
    console.error("Webhook processing error:", err);
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
