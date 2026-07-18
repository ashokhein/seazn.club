import "server-only";
// Stripe event processing (extracted from the webhook route so the staff
// console can replay events): one dispatch table, shared by the signed
// webhook POST and the admin "process now" path. billing_events is the
// idempotency ledger — received_at set on arrival, processed_at only after
// the handler ran, so a NULL processed_at is a stuck event and a missing row
// is an event we never received (the deleted-endpoint incident class).
import type Stripe from "stripe";
import { sql } from "@/lib/db";
import {
  recordPassPurchase,
  refundDuplicatePassPayment,
  revokePassForRefundedCharge,
  syncSubscription,
} from "@/lib/billing";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { sendPassRevokedEmail } from "@/lib/email";
import {
  handleRegistrationCheckoutCompleted,
  handleRegistrationDispute,
  syncRegistrationRefund,
} from "@/server/usecases/registrations";
import { syncConnectAccount } from "@/server/usecases/stripe-connect";
import {
  handleSponsorChargeRefunded,
  handleSponsorDispute,
  handleSponsorPaymentFailed,
  handleSponsorPaymentSucceeded,
} from "@/server/usecases/sponsors";
import { captureServer } from "@/lib/posthog-server";
import { EVENTS } from "@/lib/analytics-events";

/** Every event type the dispatch below acts on — also the filter the staff
 *  console asks Stripe for. Anything else is silently ACKed. */
export const HANDLED_EVENT_TYPES = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.payment_failed",
  "invoice.payment_succeeded",
  "account.updated",
  "charge.dispute.created",
  "charge.dispute.closed",
  "charge.refunded",
  // Sponsor package orders (v10): activation keys off the PaymentIntent
  // because the intent metadata carries kind/order_id. Non-sponsor intents
  // (entry fees, passes) are ignored inside the handlers.
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
] as const;

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
      const res = await recordPassPurchase({
        orgId,
        competitionId,
        paymentIntent:
          typeof session.payment_intent === "string" ? session.payment_intent : null,
      });
      // Second owner / second tab paid for an already-passed comp — send it
      // straight back. The refund is outside any tx and swallows its own
      // failure, so the webhook still ACKs (P0-3b).
      if (res.duplicateIntent) await refundDuplicatePassPayment(res.duplicateIntent);
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

/** Current owner's email via org_members — NOT organizations.created_by, which
 *  an ownership transfer leaves on the original creator. */
async function orgOwnerEmail(orgId: string): Promise<string | null> {
  const [owner] = await sql<{ email: string }[]>`
    select u.email from org_members m join users u on u.id = m.user_id
    where m.org_id = ${orgId} and m.role = 'owner' limit 1`;
  return owner?.email ?? null;
}

/** Event Pass refund (P0-3a): a fully-refunded pass charge — dashboard refunds
 *  included — revokes the pass and emails the org owner. The org + competition
 *  are read BEFORE the revoke deletes the row; the email is fire-and-forget so
 *  a Resend hiccup never blocks the webhook ACK. */
async function revokePassForRefundedChargeAndNotify(charge: Stripe.Charge): Promise<void> {
  const intent =
    typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
  const [ctx] =
    intent && charge.refunded
      ? await sql<{ org_id: string; org_name: string; comp_name: string }[]>`
          select p.org_id, o.name as org_name, c.name as comp_name
          from competition_passes p
          join organizations o on o.id = p.org_id
          join competitions   c on c.id = p.competition_id
          where p.stripe_payment_intent = ${intent}`
      : [];
  const revoked = await revokePassForRefundedCharge(charge);
  if (!revoked || !ctx) return;
  const to = await orgOwnerEmail(ctx.org_id);
  if (!to) return;
  void sendPassRevokedEmail({ to, orgName: ctx.org_name, competitionName: ctx.comp_name }).catch(
    () => {},
  );
}

/** The dispatch table (formerly inline in the webhook route). Unhandled
 *  types are a silent no-op — the caller still stamps processed_at. */
export async function processStripeEvent(event: Stripe.Event): Promise<void> {
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
      // Entry-fee AND sponsor-order chargebacks (spec issue #5, P0-2): flag +
      // alert the organiser. Each handler no-ops on the other's intents, same
      // pattern as charge.refunded.
      await handleRegistrationDispute(event.data.object as Stripe.Dispute, "created");
      await handleSponsorDispute(event.data.object as Stripe.Dispute, "created");
      break;
    case "charge.dispute.closed":
      await handleRegistrationDispute(event.data.object as Stripe.Dispute, "closed");
      await handleSponsorDispute(event.data.object as Stripe.Dispute, "closed");
      break;
    case "charge.refunded":
      // Refunds made in the Stripe dashboard still show on the console.
      // Registration, sponsor and Event Pass charges share the event type; each
      // handler no-ops on the others' charges.
      await syncRegistrationRefund(event.data.object as Stripe.Charge);
      await handleSponsorChargeRefunded(event.data.object as Stripe.Charge);
      await revokePassForRefundedChargeAndNotify(event.data.object as Stripe.Charge);
      break;
    case "payment_intent.succeeded":
      // Sponsor order paid (v10) — activates the sponsor row, replay-safe.
      await handleSponsorPaymentSucceeded(event.data.object as Stripe.PaymentIntent);
      break;
    case "payment_intent.payment_failed":
      await handleSponsorPaymentFailed(event.data.object as Stripe.PaymentIntent);
      break;
    // Unhandled events are silently ACKed
  }
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export interface LedgerRow {
  id: string;
  type: string;
  org_id: string | null;
  org_name?: string | null;
  received_at: string;
  processed_at: string | null;
}

export type EventStatus = "processed" | "received" | "missing";

/** Status of a Stripe event against the ledger: no row = never received
 *  (webhook missed), row without processed_at = handler didn't finish. */
export function eventStatus(row: { processed_at: string | Date | null } | undefined): EventStatus {
  if (!row) return "missing";
  return row.processed_at ? "processed" : "received";
}

/**
 * Record + process one event, stamping processed_at only after the handler
 * ran (a throw leaves the row in the "received" state for the console).
 * Shared by the signed webhook and the staff replay.
 */
export async function runEvent(event: Stripe.Event): Promise<void> {
  const orgId =
    (event.data.object as { metadata?: { org_id?: string } }).metadata?.org_id ?? null;
  await sql`
    insert into billing_events (id, type, org_id, payload)
    values (${event.id}, ${event.type}, ${orgId}, ${JSON.stringify(event.data.object)})
    on conflict (id) do nothing`;
  await processStripeEvent(event);
  await sql`
    update billing_events set processed_at = now() where id = ${event.id}`;
}

/** Staff replay: skip events the ledger already saw through. */
export async function replayEvent(
  event: Stripe.Event,
): Promise<"processed" | "already_processed"> {
  const [existing] = await sql<{ processed_at: string | null }[]>`
    select processed_at from billing_events where id = ${event.id}`;
  if (existing?.processed_at) return "already_processed";
  await runEvent(event);
  return "processed";
}

/** Ledger rows for a set of live Stripe event ids (the diff read). */
export async function ledgerByIds(ids: string[]): Promise<Map<string, LedgerRow>> {
  if (ids.length === 0) return new Map();
  const rows = await sql<LedgerRow[]>`
    select b.id, b.type, b.org_id, o.name as org_name, b.received_at, b.processed_at
    from billing_events b
    left join organizations o on o.id = b.org_id
    where b.id in ${sql(ids)}`;
  return new Map(rows.map((r) => [r.id, r]));
}

/** Stuck rows outside the live window: received, never processed. */
export async function stuckLedgerEvents(
  excludeIds: string[],
  limit = 50,
): Promise<LedgerRow[]> {
  return sql<LedgerRow[]>`
    select b.id, b.type, b.org_id, o.name as org_name, b.received_at, b.processed_at
    from billing_events b
    left join organizations o on o.id = b.org_id
    where b.processed_at is null
      ${excludeIds.length ? sql`and b.id not in ${sql(excludeIds)}` : sql``}
    order by b.received_at desc
    limit ${limit}`;
}
