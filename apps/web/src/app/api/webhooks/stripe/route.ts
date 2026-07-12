import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { sql } from "@/lib/db";
import { recordPassPurchase, syncSubscription } from "@/lib/billing";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import {
  handleRegistrationCheckoutCompleted,
  handleRegistrationDispute,
  syncRegistrationRefund,
} from "@/server/usecases/registrations";
import { syncConnectAccount } from "@/server/usecases/stripe-connect";
import { captureServer } from "@/lib/posthog-server";
import { EVENTS } from "@/lib/analytics-events";

/** Best-effort person id for org-scoped revenue events: the org owner, falling
 *  back to a synthetic org id so the event still lands on the org group. */
async function ownerDistinctId(orgId: string): Promise<string> {
  const [row] = await sql<{ created_by: string | null }[]>`
    select created_by from organizations where id = ${orgId}`;
  return row?.created_by ?? `org:${orgId}`;
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  // Entry-fee checkouts (PROMPT-20a) share the endpoint; kind disambiguates.
  if (session.metadata?.kind === "registration") {
    await handleRegistrationCheckoutCompleted(session);
    return;
  }
  const orgId = session.metadata?.org_id;
  if (!orgId) return;

  // Event Pass one-time purchase (v3/07 §3) — reconcile-on-return usually
  // lands first; recordPassPurchase is idempotent either way.
  if (session.metadata?.pass_key === "event_pass") {
    const competitionId = session.metadata.competition_id;
    if (competitionId && session.payment_status === "paid") {
      await recordPassPurchase({
        orgId,
        competitionId,
        paymentIntent:
          typeof session.payment_intent === "string" ? session.payment_intent : null,
      });
    }
    return;
  }

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
  await invalidateOrgEntitlements(orgId);
}

async function handleSubscriptionDeleted(stripeSub: Stripe.Subscription) {
  const orgId = stripeSub.metadata?.org_id;
  if (!orgId) return;
  await sql`
    update subscriptions
    set plan_key = 'community', status = 'canceled', updated_at = now()
    where org_id = ${orgId}`;
  await invalidateOrgEntitlements(orgId);
  await captureServer({
    event: EVENTS.SUBSCRIPTION_CANCELED,
    distinctId: await ownerDistinctId(orgId),
    orgId,
  });
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
  const [row] = await sql<{ org_id: string }[]>`
    update subscriptions set status = 'past_due', updated_at = now()
    where stripe_subscription_id = ${subId}
    returning org_id`;
  if (row) {
    await captureServer({
      event: EVENTS.PAYMENT_FAILED,
      distinctId: await ownerDistinctId(row.org_id),
      orgId: row.org_id,
    });
  }
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
      case "customer.subscription.updated": {
        const stripeSub = event.data.object as Stripe.Subscription;
        await handleSubscriptionChanged(stripeSub);
        // Fire the activation-of-revenue event once, on creation only.
        if (event.type === "customer.subscription.created" && stripeSub.metadata?.org_id) {
          await captureServer({
            event: EVENTS.SUBSCRIPTION_STARTED,
            distinctId: await ownerDistinctId(stripeSub.metadata.org_id),
            orgId: stripeSub.metadata.org_id,
            properties: { plan_key: stripeSub.metadata?.plan_key, status: stripeSub.status },
          });
        }
        break;
      }
      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
        break;
      case "invoice.payment_failed":
        await handleInvoicePaymentFailed(event.data.object as Stripe.Invoice);
        break;
      case "invoice.payment_succeeded":
        await handleInvoicePaymentSucceeded(event.data.object as Stripe.Invoice);
        break;
      case "account.updated":
        // Connect Express onboarding progress (PROMPT-20a): mirror the
        // charges_enabled flag that gates entry-fee checkout.
        await syncConnectAccount(event.data.object as Stripe.Account);
        break;
      case "charge.dispute.created":
        // Entry-fee chargeback (spec issue #5): flag + alert the organiser.
        await handleRegistrationDispute(event.data.object as Stripe.Dispute, "created");
        break;
      case "charge.dispute.closed":
        await handleRegistrationDispute(event.data.object as Stripe.Dispute, "closed");
        break;
      case "charge.refunded":
        // Refunds made in the Stripe dashboard still show on the console.
        await syncRegistrationRefund(event.data.object as Stripe.Charge);
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
