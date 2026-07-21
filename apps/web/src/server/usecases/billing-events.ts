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
  linkStripeCustomerForGroup,
  recordPassPurchase,
  refundDuplicatePassPayment,
  revokePassForRefundedCharge,
  syncPaymentMethodFlagForSubscription,
  syncSubscriptionForGroup,
} from "@/lib/billing";
import {
  invalidateGroupEntitlements,
  invalidateOrgEntitlements,
} from "@/lib/entitlements";
import { orgIdsInGroup, subscriptionIdForOrg } from "@/lib/billing-group";
import { getStripe } from "@/lib/stripe";
import {
  sendPassRevokedEmail,
  sendStaffDisputeAlertEmail,
  sendStuckEventsAlertEmail,
} from "@/lib/email";
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
  // Cards added/removed/promoted in the STRIPE DASHBOARD (support, or the org
  // via an emailed invoice). Without these the has_payment_method mirror only
  // tracks in-app changes and the trial banner asks for a card that exists.
  "payment_method.attached",
  "payment_method.detached",
  "customer.updated",
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

  // Link the Stripe customer to the GROUP that bought it. A re-buy after a
  // cancel mints a NEW customer, and has_payment_method mirrors cards on the OLD
  // one — so this goes through linkStripeCustomerForGroup, which re-derives the
  // flag on a change.
  //
  // Group-addressed, not org-addressed: `stripe_customer_id` lives on the
  // subscription row, and once orgs move between groups the org named in the
  // metadata may no longer bill through the group that paid — writing through it
  // would stamp this payer's customer onto somebody else's row (the same defect
  // already fixed for the subscription webhooks). The checkout stamp is the
  // durable answer; the org's current group is the fallback for sessions created
  // before the stamp existed.
  if (session.customer) {
    const groupId = await checkoutGroupId(session, orgId);
    if (groupId) await linkStripeCustomerForGroup(groupId, session.customer as string);
  }

  // Subscription details arrive via subscription.created; nothing more to do here.
}

/**
 * Which billing GROUP did this checkout session pay for?
 *
 * `metadata.subscription_id` is stamped by buildEmbeddedCheckoutParams and names
 * the group that actually paid, whatever has happened to the org since. It is
 * verified against the table rather than trusted — a deleted group must not be
 * written, and metadata is not a trusted channel. Falls back to the buying org's
 * current group for sessions created before the stamp shipped.
 */
async function checkoutGroupId(
  session: Stripe.Checkout.Session,
  orgId: string,
): Promise<string | null> {
  const stamped = session.metadata?.subscription_id;
  if (stamped) {
    const [row] = await sql<{ id: string }[]>`
      select id from subscriptions where id = ${stamped}`;
    if (row) return row.id;
    console.error(`[billing] checkout session ${session.id} stamped with unknown group ${stamped}`);
  }
  return subscriptionIdForOrg(orgId);
}

/** Billing GROUP behind a Stripe customer id, or null when we do not bill them.
 *  A Stripe customer belongs to the subscription, not to any one org, so this
 *  deliberately returns the subscription id rather than picking a member org. */
async function groupForCustomer(customerId: string | null | undefined): Promise<string | null> {
  if (!customerId) return null;
  const [row] = await sql<{ id: string }[]>`
    select id from subscriptions where stripe_customer_id = ${customerId}`;
  return row?.id ?? null;
}

/**
 * An org to attribute a group-level event to (staff alert name, audit target,
 * analytics). Oldest LIVE member org, so the choice is stable across sweeps and
 * replays.
 *
 * `deleted_at is null` matters: orgIdsInGroup deliberately includes
 * soft-deleted orgs (they still bear on billing), but a deleted org has no
 * owner left for orgOwnerEmail to find, so attributing a dispute alert or a
 * PAYMENT_FAILED to it would send the notification nowhere. Falls back to the
 * oldest org of any state rather than dropping the event entirely — a group
 * whose every org is deleted still has a real invoice failing.
 */
async function primaryOrgForGroup(subscriptionId: string): Promise<string | null> {
  const [live] = await sql<{ id: string }[]>`
    select id from organizations
    where subscription_id = ${subscriptionId} and deleted_at is null
    order by created_at limit 1`;
  if (live) return live.id;
  const orgs = await orgIdsInGroup(subscriptionId);
  return orgs[0] ?? null;
}

/**
 * A card was attached, detached, or the customer's default changed — in the
 * Stripe dashboard, not in our UI. Re-mirror has_payment_method so the trial
 * banner agrees with Stripe either way.
 *
 * A DETACHED payment method carries a null customer (Stripe nulls the link as
 * part of the change), so the org has to come from previous_attributes.
 *
 * customer.updated is CHATTY — it fires for a name, an address, a tax id, a
 * balance change — and only invoice_settings can move the default card, so
 * that event is gated on previous_attributes.invoice_settings and everything
 * else is a cheap ACK instead of a Stripe round trip. attached/detached stay
 * unconditional: those events ARE the card change.
 */
async function handlePaymentMethodChanged(event: Stripe.Event) {
  const object = event.data.object as { id?: string; customer?: string | { id: string } | null };
  const previous = (event.data as {
    previous_attributes?: { customer?: string | null; invoice_settings?: unknown };
  }).previous_attributes;
  if (event.type === "customer.updated" && !(previous && "invoice_settings" in previous)) return;
  const raw =
    event.type === "customer.updated"
      ? object.id
      : (typeof object.customer === "string" ? object.customer : object.customer?.id) ??
        previous?.customer;
  const subscriptionId = await groupForCustomer(raw);
  if (!subscriptionId) return;
  await syncPaymentMethodFlagForSubscription(subscriptionId);
}

/** How a Stripe subscription found its billing group. Ordered strongest first;
 *  `legacy_org_id` is the only one that can name a group this subscription does
 *  not belong to, and is logged so the pre-stamp population is observable. */
export type GroupResolution =
  | "metadata_subscription_id"
  | "stripe_subscription_id"
  | "stripe_customer_id"
  | "legacy_org_id";

/**
 * Which billing GROUP does this Stripe subscription write to?
 *
 * Was `metadata.org_id → that org's subscription`, which was correct only while
 * a subscription belonged to exactly one org. It is now a corruption bug: after
 * a detach, org A still carries the stamp from group 1 while billing through
 * group 2, so an event for group 1 would resolve to — and overwrite — group 2.
 * Silently: wrong plan, wrong status, wrong period end, no exception.
 *
 * The chain, strongest first:
 *   a) `metadata.subscription_id` — stamped at checkout (buildEmbeddedCheckoutParams),
 *      immutable, names the group that actually paid.
 *   b) `subscriptions.stripe_subscription_id = <this sub>` — we already store it.
 *   c) `subscriptions.stripe_customer_id = <event customer>` — the customer is
 *      the group's, not any org's.
 *   d) `metadata.org_id → organizations.subscription_id` — the LEGACY path.
 *
 * (b) and (c) are not belt-and-braces: subscriptions created before the stamp
 * shipped carry no `subscription_id` at all and Stripe metadata cannot be
 * back-filled onto past events, so without them every pre-existing customer
 * would fall to (d) forever.
 *
 * Returns null when nothing resolves — the caller no-ops rather than guesses.
 */
async function resolveGroupForStripeSub(
  stripeSub: Stripe.Subscription,
): Promise<{ subscriptionId: string; via: GroupResolution } | null> {
  // (a) The durable stamp. Verified against the table rather than trusted:
  // metadata is customer-visible-ish and a deleted group must not be written.
  const stamped = stripeSub.metadata?.subscription_id;
  if (stamped) {
    const [row] = await sql<{ id: string }[]>`
      select id from subscriptions where id = ${stamped}`;
    if (row) return { subscriptionId: row.id, via: "metadata_subscription_id" };
    console.error(
      `[billing] subscription ${stripeSub.id} stamped with unknown group ${stamped}`,
    );
  }

  // (b) We already store this subscription id — exact, and cannot mismatch.
  const [bySub] = await sql<{ id: string }[]>`
    select id from subscriptions where stripe_subscription_id = ${stripeSub.id}`;
  if (bySub) return { subscriptionId: bySub.id, via: "stripe_subscription_id" };

  // (c) The Stripe customer belongs to the group.
  const customerId =
    typeof stripeSub.customer === "string" ? stripeSub.customer : stripeSub.customer?.id;
  const byCustomer = await groupForCustomer(customerId);
  if (byCustomer) return { subscriptionId: byCustomer, via: "stripe_customer_id" };

  // (d) Legacy. Logged so the un-stamped population can eventually be retired.
  const orgId = stripeSub.metadata?.org_id;
  if (!orgId) return null;
  const legacy = await subscriptionIdForOrg(orgId);
  if (!legacy) return null;
  console.warn(
    `[billing] subscription ${stripeSub.id} resolved to group ${legacy} via LEGACY metadata.org_id ` +
      `(${orgId}) — no subscription_id stamp, no stored sub id, no customer match`,
  );
  return { subscriptionId: legacy, via: "legacy_org_id" };
}

/**
 * Refuse to write when the resolved group is demonstrably not this
 * subscription's. A missed update is recoverable (replay, reconcile-on-return,
 * the stuck-event sweep); overwriting another customer's subscription row is not.
 *
 * A mismatch is only ever LEGITIMATE on the stamped path, where it means a
 * re-buy: the group cancelled sub_old (whose id stays on the row for ever) and
 * bought sub_new, which is stamped with that same group. So a mismatch there is
 * allowed for a still-LIVE subscription and refused for a dead one — a late
 * `updated` for the replaced sub must not drag the group back to its state
 * (the same class of bug as the P1-5 delete guard).
 *
 * On the inferred paths (customer, legacy org_id) a mismatch is never
 * legitimate: the group is already billing a DIFFERENT subscription and this
 * event has no proof it owns that row.
 */
async function mayWriteGroup(
  resolved: { subscriptionId: string; via: GroupResolution },
  stripeSub: Stripe.Subscription,
): Promise<boolean> {
  const [current] = await sql<{ stripe_subscription_id: string | null }[]>`
    select stripe_subscription_id from subscriptions where id = ${resolved.subscriptionId}`;
  const stored = current?.stripe_subscription_id ?? null;
  if (!stored || stored === stripeSub.id) return true;
  if (resolved.via === "metadata_subscription_id" && isLiveStripeStatus(stripeSub.status)) {
    return true; // re-buy: this subscription replaces the stored one
  }
  console.error(
    `[billing] REFUSING to write group ${resolved.subscriptionId} (billing ${stored}) ` +
      `from subscription ${stripeSub.id} status=${stripeSub.status} resolved via ${resolved.via} — ` +
      `wrong-row write averted`,
  );
  return false;
}

/** Terminal STRIPE statuses. Everything else still owns the subscription (our
 *  STATUS_MAP collapses incomplete/unpaid/paused into past_due, which is live). */
function isLiveStripeStatus(status: Stripe.Subscription.Status): boolean {
  return status !== "canceled" && status !== "incomplete_expired";
}

async function handleSubscriptionChanged(stripeSub: Stripe.Subscription) {
  const resolved = await resolveGroupForStripeSub(stripeSub);
  if (!resolved) return;
  if (!(await mayWriteGroup(resolved, stripeSub))) return;
  await syncSubscriptionForGroup(resolved.subscriptionId, stripeSub);
  // Plan/status just moved on the shared row: every org in the group resolves
  // through it, so a single-org invalidation would leave siblings on the old
  // plan for the 300s TTL.
  await invalidateGroupEntitlements(resolved.subscriptionId);
}

async function handleSubscriptionDeleted(stripeSub: Stripe.Subscription) {
  const resolved = await resolveGroupForStripeSub(stripeSub);
  if (!resolved) return;
  const subscriptionId = resolved.subscriptionId;
  // Stale-event guard (P1-5): only the CURRENTLY stored subscription may
  // downgrade the group — a late-delivered deleted for a replaced sub must not
  // touch a resubscribed customer. A delete is terminal, so this holds on the
  // stamped path too (mayWriteGroup's re-buy exemption needs a LIVE status).
  if (!(await mayWriteGroup(resolved, stripeSub))) return;
  await sql`
    update subscriptions
    set plan_key = 'community', status = 'canceled', updated_at = now(),
        status_changed_at = case when status is distinct from 'canceled'
                                 then now() else status_changed_at end
    where id = ${subscriptionId}`;
  // A cancel drops EVERY org in the group to Community at once.
  await invalidateGroupEntitlements(subscriptionId);
  // Attribution only. Prefer the org the checkout named, but ONLY if it still
  // bills through this group — otherwise a cancel would be reported against an
  // org that has since moved elsewhere.
  const orgId = await attributionOrgForGroup(subscriptionId, stripeSub.metadata?.org_id);
  if (!orgId) return;
  await captureServer({
    event: EVENTS.SUBSCRIPTION_CANCELED,
    distinctId: await ownerDistinctId(orgId),
    orgId,
  });
}

/** An org to hang a group-level analytics/audit event on: the org named in the
 *  metadata when it is still a member of the group, else the group's primary. */
async function attributionOrgForGroup(
  subscriptionId: string,
  metadataOrgId: string | null | undefined,
): Promise<string | null> {
  if (metadataOrgId) {
    const [row] = await sql<{ id: string }[]>`
      select id from organizations
      where id = ${metadataOrgId} and subscription_id = ${subscriptionId}`;
    if (row) return row.id;
  }
  return primaryOrgForGroup(subscriptionId);
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
  const [row] = await sql<{ id: string }[]>`
    update subscriptions
    set status = 'past_due', updated_at = now(),
        -- Grace anchor: only the FIRST failure starts the 14-day clock;
        -- every dunning retry lands here again and must not re-arm it.
        status_changed_at = case when status is distinct from 'past_due'
                                 then now() else status_changed_at end
    where stripe_subscription_id = ${subId}
    returning id`;
  if (row) {
    // past_due starts the 14-day grace the resolver reads, so it is a plan
    // change in all but name — drop the whole group's cached entitlements.
    await invalidateGroupEntitlements(row.id);
    // One event per failed invoice, attributed to the group's primary org
    // (there is one payer and one invoice, however many orgs share it).
    const orgId = await primaryOrgForGroup(row.id);
    if (orgId) {
      await captureServer({
        event: EVENTS.PAYMENT_FAILED,
        distinctId: await ownerDistinctId(orgId),
        orgId,
      });
    }
  }
}

async function handleInvoicePaymentSucceeded(invoice: Stripe.Invoice) {
  const subId = invoiceSubId(invoice);
  if (!subId) return;
  const [row] = await sql<{ id: string }[]>`
    update subscriptions set status = 'active', updated_at = now()
    where stripe_subscription_id = ${subId} and status != 'trialing'
    returning id`;
  // Leaving dunning restores the plan for every org in the group.
  if (row) await invalidateGroupEntitlements(row.id);
  await trueUpQuantityPaid(invoice, subId);
}

/**
 * The deferred decrement, settled.
 *
 * `stripe_quantity = max(active_org_count, quantity_paid)` only keeps its
 * promise — "a removed org frees a paid slot you can reuse at no charge until
 * the period ends" — if `quantity_paid` eventually comes back DOWN. Nothing but
 * a renewal may lower it: at that moment Stripe has just billed the new period
 * at the true count, so the slots the customer paid for last period are spent
 * and the count is the truth again.
 *
 * Gated on `billing_reason`, not merely on "an invoice was paid". A mid-period
 * PRORATION invoice is also `invoice.payment_succeeded`, and lowering
 * quantity_paid on one would confiscate a slot the customer has this second
 * paid for: attach (3 seats charged), detach (2 orgs, 1 slot still owed to
 * them), any other prorated change → the freed slot silently disappears.
 * `subscription_create` is included because that first invoice IS the count the
 * checkout bought, and nothing else records it.
 */
async function trueUpQuantityPaid(invoice: Stripe.Invoice, subId: string): Promise<void> {
  const reason = invoice.billing_reason;
  if (reason !== "subscription_cycle" && reason !== "subscription_create") return;
  await sql`
    update subscriptions s
       set quantity_paid = greatest(1, (
             select count(*) from organizations o
              where o.subscription_id = s.id and o.deleted_at is null)),
           updated_at = now()
     where s.stripe_subscription_id = ${subId}`;
}

/** Current owner's email via org_members — NOT organizations.created_by, which
 *  an ownership transfer leaves on the original creator. */
async function orgOwnerEmail(orgId: string): Promise<string | null> {
  const [owner] = await sql<{ email: string }[]>`
    select u.email from org_members m join users u on u.id = m.user_id
    where m.org_id = ${orgId} and m.role = 'owner'
    order by m.created_at, m.user_id limit 1`;
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

// ---------------------------------------------------------------------------
// Platform-charge disputes (Task 7, P1-4, decisions §6.2)
// ---------------------------------------------------------------------------

/** The Stripe customer behind a dispute's charge. A charge.dispute.* event
 *  carries `charge` as an id STRING, so reading the customer needs a charge
 *  retrieve — done OUTSIDE any tx and guarded on STRIPE_SECRET_KEY (mirroring
 *  platform-revenue); keyless envs skip it and the subscription branch no-ops.
 *  An already-expanded charge object (tests) is read inline, no Stripe call. */
async function disputeCustomerId(dispute: Stripe.Dispute): Promise<string | null> {
  const charge = dispute.charge;
  if (typeof charge === "object" && charge) {
    return typeof charge.customer === "string" ? charge.customer : (charge.customer?.id ?? null);
  }
  if (typeof charge === "string" && process.env.STRIPE_SECRET_KEY) {
    try {
      const full = await getStripe().charges.retrieve(charge);
      return typeof full.customer === "string" ? full.customer : (full.customer?.id ?? null);
    } catch {
      return null; // a retrieve failure must never block the webhook ACK
    }
  }
  return null;
}

/** Staff notification for a PLATFORM-charge dispute: an email to
 *  STAFF_ALERT_EMAIL (skipped when unset) plus a best-effort staff_audit_log
 *  breadcrumb. staff_audit_log.actor_id is NOT NULL (FK users) and a webhook
 *  dispute has no staff actor, so the row is attributed to the accountable
 *  superadmin and skipped when none exists (e.g. tests) — the same actorless
 *  limitation sponsors.ts documents. Never throws: the flag / downgrade /
 *  revoke is the source of truth and must not be undone by an alerting hiccup,
 *  and the email is fire-and-forget. */
async function notifyStaffDispute(
  kind: "subscription" | "event_pass",
  orgId: string,
  dispute: Stripe.Dispute,
  phase: "created" | "closed",
): Promise<void> {
  const [org] = await sql<{ name: string }[]>`
    select name from organizations where id = ${orgId}`;
  const orgName = org?.name ?? "the organisation";

  try {
    const [actor] = await sql<{ id: string }[]>`
      select id from users where is_staff = true and staff_role = 'superadmin'
      order by created_at limit 1`;
    if (actor) {
      await sql`
        insert into staff_audit_log (actor_id, action, target_type, target_id, detail)
        values (${actor.id}, 'platform_dispute', 'org', ${orgId},
                ${sql.json({
                  kind,
                  phase,
                  dispute_id: dispute.id,
                  status: dispute.status,
                  amount_cents: dispute.amount,
                } as never)})`;
    }
  } catch {
    /* breadcrumb is best-effort — never block the ACK */
  }

  const to = process.env.STAFF_ALERT_EMAIL;
  if (!to) return;
  void sendStaffDisputeAlertEmail({
    to,
    kind,
    orgName,
    phase,
    status: dispute.status,
    amountCents: dispute.amount,
    currency: dispute.currency,
    disputeId: dispute.id,
  }).catch(() => {});
}

/**
 * Disputes on PLATFORM charges (decisions 2026-07-18 §6.2): `created` = flag +
 * staff alert; `closed lost` on a subscription charge = auto-downgrade the org;
 * `closed lost` on a pass charge = revoke the pass; `closed won` clears the
 * flag. Unlike a destination-charge dispute there is NO transfer to reverse —
 * a platform charge's money left the platform account directly, so recovery is
 * entitlement truth-up, never recoverDisputedTransfer. Registration + sponsor
 * handlers already no-op'd (no matching rows) before this runs; it is dispatched
 * LAST in both dispute cases.
 *
 * Replay-safe: the flag / clear / downgrade / revoke writes all converge, and
 * the staff breadcrumb + email never throw. Stripe calls (charge retrieve) stay
 * OUTSIDE any sql tx.
 */
async function handlePlatformDispute(
  dispute: Stripe.Dispute,
  phase: "created" | "closed",
): Promise<boolean> {
  const intent =
    typeof dispute.payment_intent === "string" ? dispute.payment_intent : dispute.payment_intent?.id;

  // Pass charge? Matched by payment intent — works keyless.
  if (intent) {
    const [pass] = await sql<{ org_id: string }[]>`
      select org_id from competition_passes where stripe_payment_intent = ${intent}`;
    if (pass) {
      if (phase === "closed" && dispute.status === "lost") {
        await sql`delete from competition_passes where stripe_payment_intent = ${intent}`;
        await invalidateOrgEntitlements(pass.org_id);
      }
      await notifyStaffDispute("event_pass", pass.org_id, dispute, phase);
      return true;
    }
  }

  // Subscription charge? Matched by the Stripe customer on the charge.
  const customer = await disputeCustomerId(dispute);
  if (!customer) return false;
  const subscriptionId = await groupForCustomer(customer);
  if (!subscriptionId) return false; // not a platform subscription charge
  // The dispute is against the GROUP's invoice; staff notification still needs
  // one org to name, so the group's primary org stands in for it.
  const orgId = await primaryOrgForGroup(subscriptionId);
  if (!orgId) return false;

  if (phase === "created") {
    // coalesce keeps the FIRST flag time so a duplicate created (or a manual
    // /admin/billing-events re-process) never re-stamps disputed_at — mirrors
    // sponsors.ts's created path.
    await sql`update subscriptions set disputed_at = coalesce(disputed_at, now()),
              dispute_id = ${dispute.id}, updated_at = now() where id = ${subscriptionId}`;
  } else if (dispute.status === "won") {
    // Guard on dispute_id: a win resolving long after the customer re-bought
    // clears ONLY the flag it set, never a newer dispute's — and clears
    // dispute_id too so no sticky flag is left behind.
    await sql`update subscriptions set disputed_at = null, dispute_id = null, updated_at = now()
              where id = ${subscriptionId} and dispute_id = ${dispute.id}`;
  } else if (dispute.status === "lost") {
    // Same guard: a stale loss (60+ days on) must not clobber a subscription the
    // customer has since renewed/re-bought under a different (or no) dispute.
    await sql`update subscriptions set plan_key = 'community', status = 'canceled',
              updated_at = now() where id = ${subscriptionId} and dispute_id = ${dispute.id}`;
    // A lost dispute cancels the plan for every org in the group.
    await invalidateGroupEntitlements(subscriptionId);
  }
  await notifyStaffDispute("subscription", orgId, dispute, phase);
  return true;
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
    case "payment_method.attached":
    case "payment_method.detached":
    case "customer.updated":
      await handlePaymentMethodChanged(event);
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
    case "account.updated":
      // Connect Express onboarding progress (PROMPT-20a): mirror the four
      // Connect-health flags (charges_enabled, payouts_enabled, disabled_reason,
      // requirements_due) that gate entry-fee checkout and drive the payout banner.
      await syncConnectAccount(event.data.object as Stripe.Account);
      break;
    case "charge.dispute.created":
    case "charge.dispute.closed": {
      // Entry-fee, sponsor-order AND platform (subscription / Event Pass)
      // chargebacks (spec issue #5, P0-2, Task 7 P1-4): flag + alert. Each
      // handler no-ops on the others' charges, same pattern as charge.refunded;
      // the platform handler runs LAST (the destination-charge handlers write
      // nothing on a platform charge).
      const dispute = event.data.object as Stripe.Dispute;
      const phase = event.type === "charge.dispute.created" ? "created" : "closed";
      const matched =
        (await handleRegistrationDispute(dispute, phase)) ||
        (await handleSponsorDispute(dispute, phase)) ||
        (await handlePlatformDispute(dispute, phase));
      // Dispute-before-activation race (stg 2026-07-19): Stripe can deliver
      // the dispute BEFORE checkout.session.completed writes the money row's
      // payment_intent_id. An unmatched CREATED must FAIL the event so the
      // ledger keeps it unprocessed — the stuck-event sweeper (or an admin
      // replay) re-runs it once the row knows its intent. CLOSED stays a
      // silent no-op: it trails created by days (no race window), and a
      // replayed closed-lost legitimately matches nothing once the pass row
      // was deleted by the first run.
      if (!matched && phase === "created") {
        throw new Error(
          `dispute ${dispute.id} matched no registration/sponsor/platform charge yet — retry via sweeper`,
        );
      }
      break;
    }
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

/**
 * Auto-heal stuck events (spec P1-7): rows that landed in the ledger but never
 * reached processed_at (deploy crash / transient DB error mid-handler) sit
 * `received` forever, and /admin/billing-events (#87) only exposes MANUAL
 * replay. This cron sweep re-pulls each stuck row FRESH from Stripe (the trust
 * anchor — never the stored payload) and replays it; handlers are
 * replay-idempotent by contract, so replaying a `received` row is always safe.
 *
 * A row is retried up to 3 times; on the 3rd-attempt row it is PARKED
 * (replay_attempts bumped to 4, which the `< 4` filter excludes from every
 * future sweep) and staff are alerted ONCE, so the sweep stays quiet instead of
 * hammering a permanently-broken event. Stripe calls stay OUTSIDE any sql.begin.
 */
export async function sweepStuckEvents(limit = 25): Promise<{
  replayed: number;
  failed: number;
  alerted: number;
}> {
  if (!process.env.STRIPE_SECRET_KEY) return { replayed: 0, failed: 0, alerted: 0 };
  const rows = await sql<{ id: string; type: string; replay_attempts: number }[]>`
    select id, type, replay_attempts from billing_events
    where processed_at is null
      and received_at < now() - interval '10 minutes'
      and replay_attempts < 4
    order by received_at
    limit ${limit}`;
  let replayed = 0,
    failed = 0,
    alerted = 0;
  const alertTo = process.env.STAFF_ALERT_EMAIL;
  for (const row of rows) {
    // Cap reached: park it (bump to 4 → never selected again) and alert once.
    if (row.replay_attempts >= 3) {
      await sql`update billing_events set replay_attempts = replay_attempts + 1 where id = ${row.id}`;
      alerted++;
      if (alertTo) {
        void sendStuckEventsAlertEmail({
          to: alertTo,
          eventId: row.id,
          eventType: row.type,
          attempts: row.replay_attempts + 1,
        }).catch(() => {});
      }
      continue;
    }
    try {
      const event = await getStripe().events.retrieve(row.id);
      await replayEvent(event);
      replayed++;
    } catch {
      // A retrieve/handler failure leaves the row `received`; bump the counter
      // so the next pass advances it toward the cap rather than looping forever.
      await sql`update billing_events set replay_attempts = replay_attempts + 1 where id = ${row.id}`;
      failed++;
    }
  }
  return { replayed, failed, alerted };
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
