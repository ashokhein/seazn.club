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
  linkStripeCustomer,
  passKeyForSession,
  pinBillingCurrency,
  recordPassPurchase,
  refundDuplicatePassPayment,
  revokePassForRefundedCharge,
  syncPaymentMethodFlagForSubscription,
  syncSubscriptionForGroup,
} from "@/lib/billing";
import { CREDIT_PACKS } from "@/lib/credit-packs";
import {
  recordPackPurchase,
  recordPackRefund,
  recordPassRefund,
  walletIdFor,
} from "@/lib/credits";
import { isPassKey, type PassKey } from "@/lib/currency";
import { SEAT_ADDON, isSeatAddonItem } from "@/lib/seat-addons";
import {
  ORG_ADDON_FEATURE_KEY,
  ORG_ADDON_DELTA_EACH,
  isOrgAddonItem,
  orgAddonForPlan,
  resolveOrgAddonPriceId,
} from "@/lib/org-addons";
import { getSizePack } from "@/lib/size-packs";
import {
  invalidateGroupEntitlements,
  invalidateOrgEntitlements,
} from "@/lib/entitlements";
import { orgIdsInGroup, subscriptionIdForOrg } from "@/lib/billing-group";
import { syncGroupQuantity } from "@/server/usecases/billing-groups";
import {
  creditPassTowardSubscription,
  reversePassCreditOnRefund,
} from "@/server/usecases/pass-credit";
import { getStripe } from "@/lib/stripe";
import {
  sendPassRevokedEmail,
  sendStaffDisputeAlertEmail,
  sendStuckEventsAlertEmail,
  sendCreditPackGrantFailedAlertEmail,
  sendSizePackGrantFailedAlertEmail,
  sendExtraOrgRepriceFailedAlertEmail,
} from "@/lib/email";
import type { StaffDisputeAlertArgs } from "@/lib/email-templates";
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

  // Size-pack one-time purchase (v17 SPEC-2 §3, Phase 3 Task 3b) — lifts ONE
  // competition's entrant cap by writing an org_addons row. This is the SINGLE
  // writer of that row; idempotent on the payment_intent id (the V324 partial
  // unique index on stripe_item_id). Handled before the generic org_id gate
  // below because it keys on its own target_org_id metadata, not org_id.
  if (session.metadata?.kind === "size_pack") {
    if (session.payment_status === "paid") await grantSizePackAddon(session);
    return;
  }

  const orgId = session.metadata?.org_id;
  if (!orgId) return;

  // AI credit pack one-time purchase (v17 SPEC-2 §5.1/§6, Phase 3 Task 1) —
  // grants the pack into the org's wallet. Unlike the Event Pass branch below
  // there is no reconcile-on-return path (credit packs are not competition-
  // scoped, so there is nowhere in-app to reconcile from); this webhook is the
  // only writer, made safe to replay by recordPackPurchase's idempotency key.
  if (session.metadata?.kind === "credit_pack") {
    if (session.payment_status === "paid") {
      const packKey = session.metadata.pack_key;
      // The grant amount is SNAPSHOTTED into metadata.credits at checkout
      // creation (review fix, P3 T1) — the webhook can fire long after this
      // session was created, so re-deriving the amount from the live
      // CREDIT_PACKS catalog by pack_key here would grant the WRONG amount if
      // a deploy changed the pack's credits in the meantime, or silently
      // grant ZERO if the pack_key was removed. The catalog lookup is kept
      // only as a logged last-resort fallback for pre-fix sessions that never
      // got a snapshot; it is never a silent no-op.
      const snapshotRaw = session.metadata.credits;
      const snapshot = snapshotRaw ? Number(snapshotRaw) : NaN;
      const credits =
        Number.isFinite(snapshot) && snapshot > 0
          ? snapshot
          : (() => {
              const fallback = packKey ? CREDIT_PACKS[packKey]?.credits : undefined;
              if (fallback) {
                console.error(
                  `[billing] credit_pack session ${session.id} had no usable credits snapshot ` +
                    `(metadata.credits=${String(snapshotRaw)}) — fell back to catalog lookup by pack_key ${packKey}`,
                );
              }
              return fallback;
            })();
      if (credits) {
        // The payment_intent id is the durable "which charge paid for this"
        // reference; falling back to the session id only covers a session type
        // that somehow completed with no intent (never expected for mode:
        // "payment", but a session id is still a valid, unique idempotency
        // anchor either way).
        const stripeRef =
          (typeof session.payment_intent === "string" ? session.payment_intent : null) ??
          session.id;
        const walletId = await walletIdFor(orgId);
        await recordPackPurchase(walletId, credits, stripeRef);
        if (session.customer) await linkStripeCustomer(orgId, session.customer as string);
        await pinBillingCurrency(orgId, session.currency);
      } else {
        // Paid, but neither the metadata snapshot nor the catalog fallback
        // could resolve a credit amount — a silent zero-grant here would be
        // an invisible paid-but-ungranted purchase (the bug this fix closes).
        // Surface it the same way other billing anomalies in this file are
        // surfaced: a `[billing]` console.error plus a best-effort staff
        // alert email, and still ACK the webhook (nothing here is retryable
        // into a better outcome — a human must grant this manually).
        console.error(
          `[billing] credit_pack session ${session.id} (org ${orgId}) paid but ungranted — ` +
            `no credits snapshot and no resolvable pack_key (${packKey ?? "none"})`,
        );
        const alertTo = process.env.STAFF_ALERT_EMAIL;
        if (alertTo) {
          void sendCreditPackGrantFailedAlertEmail({
            to: alertTo,
            sessionId: session.id,
            orgId,
            packKey,
            reason: "no credits snapshot and no resolvable pack_key",
          }).catch(() => {});
        }
      }
    }
    return;
  }

  // Event Pass one-time purchase (v3/07 §3, rung ladder v17 #294) —
  // reconcile-on-return usually lands first; recordPassPurchase is idempotent
  // either way. passKeyForSession owns the gate for BOTH paths: a session with
  // no pass_key is not a pass session and falls through to the subscription
  // handling below; an unrecognised rung falls back to M rather than being
  // dropped. See its doc comment in lib/billing.ts.
  const passKey = passKeyForSession(session);
  if (passKey) {
    const competitionId = session.metadata?.competition_id;
    if (competitionId && session.payment_status === "paid") {
      const res = await recordPassPurchase({
        orgId,
        competitionId,
        passKey,
        paymentIntent:
          typeof session.payment_intent === "string" ? session.payment_intent : null,
      });
      // Second owner / second tab paid for an already-passed comp — send it
      // straight back. The refund is outside any tx and swallows its own
      // failure, so the webhook still ACKs (P0-3b).
      if (res.duplicateIntent) {
        await refundDuplicatePassPayment(res.duplicateIntent);
      } else {
        // The money trace. This branch RETURNS before the shared
        // linkStripeCustomer below, so a pass-only org's stripe_customer_id
        // stayed NULL — and the billing page lists invoices.list({ customer }),
        // so it showed nothing at all for a $29 purchase. Skipped for the
        // refunded duplicate above: that payer is not this org's customer, and
        // their currency is not the one we kept. Both writes are idempotent, so
        // the reconcile/webhook replay is free.
        if (session.customer) await linkStripeCustomer(orgId, session.customer as string);
        // First purchase of ANY kind fixes the org's billing currency, so a
        // pass buyer is never re-quoted in another currency for Pro later.
        await pinBillingCurrency(orgId, session.currency);
        // NB: the SPEC-5 §2 "first paid competition" earn grant is NOT hooked
        // here. Buying an Event Pass is not the same as an org taking a paid
        // registration, and stacking +10 onto the pass's +25 credits was wrong.
        // The earn now fires on the first genuinely-confirmed paid registration
        // (confirmPaidRegistration in registrations.ts); the pass keeps only +25.
      }
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
 * Grant a paid size-pack purchase (v17 Phase 3 Task 3b): write ONE org_addons
 * row lifting the target competition's entrant cap. The SINGLE writer of that
 * row.
 *
 * Snapshot-first (T1 lesson): the grant reads feature_key + delta_each from the
 * session metadata SNAPSHOT stamped at checkout creation, so a later catalog
 * edit can never change an already-bought pack. The live size_pack_catalog is
 * only a LOGGED last-resort fallback (staff-alerted on drift) — never a silent
 * wrong/zero grant.
 *
 * Idempotent: a one-time pack has no subscription item, so stripe_item_id holds
 * the PAYMENT_INTENT id (the Stripe object that created the row); the V324
 * partial unique index makes a redelivered webhook a no-op via
 * `on conflict (stripe_item_id) where stripe_item_id is not null do nothing` —
 * the WHERE predicate matches the partial index. A replay must not double-lift.
 */
async function grantSizePackAddon(session: Stripe.Checkout.Session): Promise<void> {
  const md = session.metadata ?? {};
  const targetOrgId = md.target_org_id;
  const targetCompetitionId = md.target_competition_id;
  const sizePackKey = md.size_pack_key;
  if (!targetOrgId || !targetCompetitionId) {
    console.error(
      `[billing] size_pack session ${session.id} missing target_org_id/target_competition_id ` +
        `— cannot resolve which cap to lift; skipping`,
    );
    return;
  }

  // Snapshot-first: trust what was stamped at checkout creation.
  const snapDelta = md.delta_each ? Number(md.delta_each) : NaN;
  let featureKey = md.feature_key || "";
  let deltaEach = Number.isFinite(snapDelta) && snapDelta > 0 ? snapDelta : NaN;
  if (!featureKey || !Number.isFinite(deltaEach)) {
    const cat = sizePackKey ? await getSizePack(sizePackKey) : null;
    if (cat) {
      featureKey = featureKey || cat.feature_key;
      deltaEach = Number.isFinite(deltaEach) ? deltaEach : cat.delta_each;
      console.error(
        `[billing] size_pack session ${session.id} had no usable snapshot ` +
          `(feature_key=${md.feature_key ?? "none"}, delta_each=${md.delta_each ?? "none"}) ` +
          `— fell back to catalog lookup by size_pack_key ${sizePackKey}`,
      );
    }
  }
  if (!featureKey || !Number.isFinite(deltaEach) || deltaEach <= 0) {
    // Paid but ungranted — surface it, never a silent no-op (mirrors credit packs).
    console.error(
      `[billing] size_pack session ${session.id} (org ${targetOrgId}) paid but ungranted ` +
        `— no usable snapshot and no resolvable size_pack_key (${sizePackKey ?? "none"})`,
    );
    const alertTo = process.env.STAFF_ALERT_EMAIL;
    if (alertTo) {
      void sendSizePackGrantFailedAlertEmail({
        to: alertTo,
        sessionId: session.id,
        targetOrgId,
        competitionId: targetCompetitionId,
        sizePackKey,
        reason: "no snapshot and no resolvable size_pack_key",
      }).catch(() => {});
    }
    return;
  }

  const stripeItemId =
    typeof session.payment_intent === "string" ? session.payment_intent : session.id;
  const walletId = await walletIdFor(targetOrgId);
  await sql`
    insert into org_addons
      (wallet_id, target_org_id, target_competition_id, feature_key, delta_each, qty,
       stripe_item_id, status)
    values (${walletId}, ${targetOrgId}, ${targetCompetitionId}, ${featureKey},
            ${deltaEach}, 1, ${stripeItemId}, 'active')
    on conflict (stripe_item_id) where stripe_item_id is not null do nothing`;
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

/** Terminal STRIPE statuses. Everything else still owns the subscription: our
 *  STATUS_MAP collapses unpaid/paused into past_due and keeps incomplete
 *  distinct (#206 — it conveys no plan), and every one of those is in
 *  LIVE_SUBSCRIPTION_STATUSES, so "not terminal" still means "live". */
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
  // Extra-seat add-ons ride the same subscription as extra items (SPEC-2 §11.3,
  // Phase 3 Task 3a); reflect their current state into org_addons. getLimit sums
  // org_addons UNCACHED (lib/entitlements.addonBonus), so no further entitlement
  // invalidation is needed for a seat change to bite on the next read.
  await syncSeatAddonsForSubscription(stripeSub, resolved.subscriptionId);
  // The extra-org rider is priced PER TIER ($9 Pro / $19 Pro Plus), so a plan
  // change makes every existing rider item wrong. This is the only convergence
  // point that catches all three ways a plan can move (in-app, Stripe
  // Dashboard, Customer Portal), and it must run BEFORE the row sync so that
  // sync sees the post-update items rather than the ones we just replaced.
  // Never throws — see its doc comment.
  await convergeOrgAddonPrices(stripeSub, resolved.subscriptionId);
  // Extra-ORGANISATION add-ons (v17 gap #293) ride the same subscription as
  // further items, but lift a GROUP-WIDE cap rather than one org's — see
  // syncOrgAddonsForSubscription's own doc comment for why this is a sibling
  // function and not a shared generalisation of the seat sync. Same
  // no-invalidation reasoning as the seat call above: getLimit sums org_addons
  // UNCACHED, so the new cap bites on the next read.
  await syncOrgAddonsForSubscription(stripeSub, resolved.subscriptionId);

  // Pass-to-Pro credit (v3/07 D12; grant timing moved 2026-07-26 — see
  // docs/superpowers/specs/2026-07-26-pass-credit-redemption-design.md §1). This
  // is one of the two arms that "learn a subscription started"; the other is
  // reconcileCheckout (lib/billing.ts), for environments where this webhook
  // never arrives. `org_id` is the buying org — stamped onto BOTH the session
  // and subscription_data.metadata by buildEmbeddedCheckoutParams, so it is
  // present on every subscription this webhook was ever going to fire for.
  //
  // Deliberately UNCONDITIONAL rather than gated to "this is a genuine
  // trialing/active transition": this handler fires on customer.subscription
  // .created AND .updated, i.e. on every seat change, dunning retry and plan
  // edit too, not just the moment the subscription first goes live. Gating on
  // a transition would need to reliably distinguish "just started" from "still
  // running" from a single event — and get the re-buy case right (a NEW
  // subscription replacing a canceled one on the same group, the
  // metadata_subscription_id branch of mayWriteGroup above) — for a saving
  // that is not worth the risk of silently skipping the one event that should
  // have minted the credit. `creditPassTowardSubscription` starts with
  // `groupAlreadyRedeemed`, a single indexed SELECT that runs before any
  // Stripe call and short-circuits on the (overwhelmingly common) case where
  // the group has already redeemed or never held a pass, so calling it on
  // every update is a cheap no-op, not a repeated Stripe round trip.
  //
  // One consequence worth naming: `mostRecentPass` inside the usecase reads
  // whatever the org's most recent pass is AT THE MOMENT this particular
  // webhook happens to succeed — not pinned to the event that started the
  // subscription. If the very first attempt is skipped (mayWriteGroup
  // refuses an out-of-order delivery, or `groupAlreadyRedeemed`'s DB read
  // fails closed on a transient error), a LATER webhook — a dunning retry, a
  // seat change — becomes the one that actually credits. That is a feature,
  // not a bug: it is what makes a skipped first attempt self-healing rather
  // than a permanently lost credit. It does mean the credit is not
  // deterministically tied to "the subscription just started" the way the
  // v3/07 window language ("bought in the last 30 days") reads — it is tied
  // to "a webhook that could write this group's redemption eventually ran",
  // bounded by `withinCreditWindow` inside the usecase either way.
  if (stripeSub.metadata?.org_id) {
    await creditPassTowardSubscription(stripeSub.metadata.org_id);
  }
}

/**
 * Reflect a subscription's extra-seat items into org_addons (v17 SPEC-2 §3,
 * §11.3, Phase 3 Task 3a). The ROUTE (setExtraSeats) mutates Stripe; THIS is
 * the SINGLE writer of the seat rows, so Stripe and the DB can never diverge.
 *
 * `subscriptionId` is the resolved billing GROUP (the wallet id for every org
 * grouped under it — coalesce(subscription_id, org_id) resolves to exactly this
 * for a member org). For each seat item present on the subscription, UPSERT its
 * org_addons row keyed on `stripe_item_id` (the V324 partial-unique key IS the
 * idempotency — a redelivered event neither duplicates a row nor double-counts
 * the cap). Any active seat row for this group whose item Stripe no longer
 * reports (removed, or quantity 0) is FLIPPED to status='canceled'
 * (freeze-not-delete, V323/V324) — never deleted, never written with qty=0
 * (the V324 CHECK forbids it).
 */
export async function syncSeatAddonsForSubscription(
  stripeSub: Stripe.Subscription,
  subscriptionId: string,
): Promise<void> {
  const seatItems = (stripeSub.items?.data ?? []).filter(isSeatAddonItem);
  const seenItemIds: string[] = [];
  for (const item of seatItems) {
    const targetOrgId = item.metadata?.target_org_id;
    if (!targetOrgId) {
      console.error(
        `[billing] seat item ${item.id} on subscription ${stripeSub.id} carries no ` +
          `target_org_id metadata — cannot resolve which org's cap to lift; skipping`,
      );
      continue;
    }
    // A seat SKU lifts members.max BY DEFINITION (isSeatAddonItem matched it by
    // lookup_key). Pin the feature_key instead of trusting item metadata: a
    // divergent metadata.feature_key would write the row on an arbitrary cap
    // that the members.max-scoped reconcile below never cancels — a stuck lift.
    const featureKey = SEAT_ADDON.featureKey;
    const qty = item.quantity ?? 0;
    if (qty <= 0) {
      // A quantity-0 seat item is a removal in disguise: never write qty=0
      // (the V324 CHECK forbids it), flip any existing row to canceled instead.
      await sql`
        update org_addons set status = 'canceled'
         where stripe_item_id = ${item.id} and status <> 'canceled'`;
      continue;
    }
    // The wallet the resolver keys on (SPEC-2 §11.1): a grouped org resolves to
    // its group's subscription id, i.e. `subscriptionId` here.
    const walletId = await walletIdFor(targetOrgId);
    await sql`
      insert into org_addons
        (wallet_id, target_org_id, target_competition_id, feature_key, delta_each, qty,
         stripe_item_id, status)
      values (${walletId}, ${targetOrgId}, null, ${featureKey}, ${SEAT_ADDON.deltaEach},
              ${qty}, ${item.id}, 'active')
      on conflict (stripe_item_id) where stripe_item_id is not null
      do update set qty = excluded.qty, status = 'active',
        wallet_id = excluded.wallet_id, target_org_id = excluded.target_org_id,
        feature_key = excluded.feature_key, delta_each = excluded.delta_each`;
    seenItemIds.push(item.id);
  }

  // Reconcile removals: an active Stripe-origin seat row (non-null
  // stripe_item_id, the seat feature_key) for THIS group whose item Stripe no
  // longer reports is gone. Scoped to SEAT_ADDON.featureKey so a future
  // size-pack add-on (Task 3b) on a different feature on the same wallet is
  // never swept here. When no seat items remain, every active seat row goes.
  if (seenItemIds.length === 0) {
    await sql`
      update org_addons set status = 'canceled'
       where wallet_id = ${subscriptionId} and feature_key = ${SEAT_ADDON.featureKey}
         and stripe_item_id is not null and status = 'active'`;
  } else {
    await sql`
      update org_addons set status = 'canceled'
       where wallet_id = ${subscriptionId} and feature_key = ${SEAT_ADDON.featureKey}
         and stripe_item_id is not null and status = 'active'
         and stripe_item_id not in ${sql(seenItemIds)}`;
  }
}

/**
 * Move this subscription's extra-ORGANISATION items onto the price of the
 * group's CURRENT plan (v17 gap #293, Task 4b).
 *
 * WHY THIS EXISTS. The rider is sold at two rates that depend on the plan
 * ($9/mo on Pro, $19/mo on Pro Plus). `setExtraOrgs` re-prices on a PURCHASE,
 * but the common case is not a purchase: a group that upgrades pro -> pro_plus
 * never calls it, and the row sync below reconciles ROWS only — it never looks
 * at an item's price. So an upgraded Pro Plus group kept paying $9/rider for
 * ever (the "Pro + riders undercuts Pro Plus" arbitrage the two rates exist to
 * close) and a downgraded Pro group kept paying $19 (the overcharge mirror).
 *
 * WHY THE WEBHOOK. It is the single convergence point: it fires for an in-app
 * plan change, a Stripe Dashboard edit and a Customer Portal change alike.
 * Fixing only the in-app path would leave the other two open.
 *
 * COMPARED BY PRICE ID, NOT LOOKUP KEY. After a drift replacement with
 * `transfer_lookup_key: true` the superseded price object reports
 * `lookup_key: null`, so a lookup-key comparison cannot tell "wrong tier" from
 * "right tier, superseded price object". Both want the SAME action — move to
 * the price the catalog resolves today — and an id comparison gives exactly
 * that, while being a clean no-op once converged. It also agrees with what
 * setExtraOrgs's survivor match does with each case, which is the property
 * that keeps the active and passive halves from fighting.
 *
 * IN-PLACE UPDATE, NOT DELETE+CREATE. `subscriptionItems.update(id, { price })`
 * is Stripe's documented way to replace the price of an item
 * (billing/subscriptions/change-price, "Update the subscription item"). It
 * preserves `stripe_item_id`, so every org_addons row keyed on it stays valid,
 * there is no window in which the group has no rider, and no row is orphaned.
 * `quantity` is passed EXPLICITLY because that doc is also explicit that
 * changing a price "automatically reverts the quantity to the default value of
 * 1" — omitting it would silently cut a 5-rider group to 1 and revoke four
 * organisations' worth of capacity it is still entitled to.
 *
 * PRORATION: the default, stated explicitly. An upgrade mid-cycle should pay
 * the higher rider rate from the moment of the change and a downgrade should
 * credit the unused remainder — which is exactly what the plan item itself
 * does on the same event, and what setExtraOrgs already does for a tier swap.
 * `create_prorations` books those adjustments onto the next invoice rather than
 * charging immediately (`always_invoice`), so a webhook can never trigger a
 * surprise off-session payment.
 *
 * CONVERGENCE, NOT A LOOP. This update itself produces another
 * `customer.subscription.updated`; on that event every id already matches and
 * nothing is written. The `no write when already correct` tests pin it.
 *
 * NEVER THROWS. The reachable failures are an unsynced catalog
 * (`resolveOrgAddonPriceId` 503) and a Stripe rejection of the item update
 * (notably a subscription in a currency the rider price does not define — the
 * #191 class of problem). A throw here would fail the whole webhook, which
 * Stripe then retries for ever and which would block every handler after it —
 * including the row sync, which is the thing the entitlement resolver actually
 * reads. So a failure is logged AND STAFF-ALERTED and processing continues:
 * rows still reconcile, only the PRICE stays stale.
 *
 * A FAILURE IS OBSERVABLE, NOT REPAIRED. There is no retry and no sweep: this
 * runs only on `customer.subscription.updated`, so "the next plan event
 * re-converges it" is worth nothing for a group that never changes plan again.
 * That group bills the wrong rate indefinitely, which is why every failure path
 * raises a staff alert rather than only a log. The daily reconciliation sweep
 * and the /admin mismatch list that would actually REPAIR it are tracked as
 * issue #332; until they land, the alert is the entire safety net.
 */
export async function convergeOrgAddonPrices(
  stripeSub: Stripe.Subscription,
  subscriptionId: string,
): Promise<void> {
  const items = stripeSub.items?.data ?? [];
  const orgItems = items.filter(isOrgAddonItem);
  // Nothing to converge: spend NO database read and NO Stripe round trip. This
  // handler runs on every dunning retry, seat change and plan edit for every
  // group we bill, and the overwhelming majority carry no rider at all — this
  // guard is what stops `subscription.updated` becoming a `prices.list`.
  if (orgItems.length === 0) return;
  // Stripe emits a final `customer.subscription.updated` carrying
  // status: "canceled" just before `deleted`. There is nothing to re-price on a
  // dead subscription — an item update against one is rejected — so skip it
  // rather than spend a round trip, fail, and alert staff about a group that is
  // leaving anyway. handleSubscriptionDeleted owns what happens next.
  if (!isLiveStripeStatus(stripeSub.status)) return;
  // Declared OUT here so the failure alert can name it. The overwhelmingly
  // common failure below is resolveOrgAddonPriceId's 503, which throws AFTER
  // this has been read — so scoping it to the try would make the alert say
  // "unknown" for the one case it was written for, and a responder could not
  // tell whether to expect the $9 or the $19 SKU. It stays "unknown" only when
  // the plan read itself is what failed, which is what the default is for.
  let planKey = "unknown";
  try {
    // The group's plan AFTER syncSubscriptionForGroup has written this event,
    // which is why this call sits downstream of it. Read from the row rather
    // than re-derived from the payload: the row is what the entitlement
    // resolver uses, and it already encodes syncSubscription's "unknown price
    // keeps the current plan" rule, so the price we bill for and the plan we
    // entitle can never disagree.
    const [row] = await sql<{ plan_key: string }[]>`
      select plan_key from subscriptions where id = ${subscriptionId}`;
    planKey = row?.plan_key ?? "community";
    // A plan with no rider SKU (community, or a future tier not yet seeded).
    // Do NOTHING — not a re-price, and deliberately not a cancel either. The
    // cancel paths own removal (handleSubscriptionDeleted for churn,
    // setExtraOrgs for a customer choosing to stop), and silently deleting a
    // paid subscription item from inside a webhook — on a plan reading we may
    // have inferred from an unknown price — is not a call this function gets
    // to make. A group that lands here keeps its rider until one of those runs.
    if (!orgAddonForPlan(planKey)) return;

    const expectedPriceId = await resolveOrgAddonPriceId(planKey);
    // Stripe will not accept two items on one subscription carrying the same
    // price, and duplicates ARE reachable (two concurrent creates — see
    // setExtraOrgs' FILTER-not-find comment). So the target price is claimed at
    // most once: if some item already holds it, no other item is moved onto it.
    // Consolidating duplicates is setExtraOrgs' job, not a webhook's — the
    // webhook's contract here is "the rate is right", not "the shape is tidy".
    // Scanned over EVERY org-addon item, including a quantity-0 one. That is
    // deliberate and is why this predicate differs from the `qty <= 0` skip
    // below: a zero-quantity subscription item still EXISTS in Stripe and still
    // occupies its price, so it still blocks another item from moving onto it.
    // The skip below is about not paying to re-rate something on its way out;
    // this is about what Stripe will accept. They are different questions.
    let targetClaimed = orgItems.some((it) => it.price?.id === expectedPriceId);
    for (const item of orgItems) {
      // Already on the current plan's price: the converged steady state, and
      // the reason a second identical event writes nothing.
      //
      // THE COMMON PAYLOAD-TRUST WINDOW, and it is deliberately open. This exit
      // never reads live state at all, so a payload whose PRICE is right but
      // whose QUANTITY is stale passes straight through to the row sync. It is
      // by far the most reachable of the two windows here, because it is the
      // steady state — every group that has already converged takes it on every
      // event. Closing it means a `subscriptionItems.retrieve` for every rider
      // on every `subscription.updated`, which is exactly the per-event round
      // trip the early return at the top of this function exists to avoid. That
      // trade belongs to #332's scheduled reconciliation, which pays it once a
      // day for every group instead of once an event for each.
      if (item.price?.id === expectedPriceId) continue;
      // A quantity-0 item is a removal in disguise; the row sync below flips
      // its row to canceled. Re-pricing it would be paying a Stripe write to
      // correct the rate of something that is on its way out.
      //
      // ONE OF THE REMAINING PAYLOAD-TRUST WINDOWS, and the rarer one. This
      // check reads the EVENT and sits before the live re-read below, so a
      // payload saying qty 0 while Stripe holds a re-bought rider skips
      // convergence and the row sync then cancels a row the customer is paying
      // for. Much less reachable than the steady-state exit above: no app path
      // produces a qty-0 rider item at all — setExtraOrgs removes via
      // `subscriptionItems.del` — so it takes a Dashboard edit AND an
      // out-of-order delivery. Same remedy, same owner: #332.
      if ((item.quantity ?? 0) <= 0) continue;
      if (targetClaimed) {
        console.error(
          `[billing] extra-org rider ${item.id} on subscription ${stripeSub.id} (group ` +
            `${subscriptionId}) is on price ${item.price?.id} but ${expectedPriceId} is already ` +
            `held by another item — leaving it for setExtraOrgs to consolidate`,
        );
        // Alerted, not just logged: this group bills the wrong rate on this
        // item until a human or a purchase consolidates the duplicate, and
        // nothing here will try again.
        await maybeAlertOrgRepriceFailed({
          subscriptionId,
          stripeSubscriptionId: stripeSub.id,
          planKey,
          itemId: item.id,
          currentPriceId: item.price?.id ?? null,
          expectedPriceId,
          reason: "another subscription item already holds the target price (duplicate rider)",
        });
        continue;
      }
      // Hoisted so the catch below can report the price Stripe ACTUALLY holds
      // rather than the payload's, which may be superseded. Null only if the
      // read itself is what threw, which is exactly when the payload is the
      // best we have.
      let live: Stripe.SubscriptionItem | null = null;
      try {
        // RE-READ THE ITEM LIVE before mutating it. The quantity we are about
        // to send back to Stripe must not come from this event's snapshot:
        // webhook deliveries are not ordered, and runEvent's lease dedupes only
        // the SAME event, so an older `updated` can be processed after a newer
        // purchase. Concretely — a Pro group with 2 riders upgrades (E1, qty 2),
        // then buys 3 more (qty 5, E2); if E1 lands after E2 it would write
        // `quantity: 2` and silently revoke three organisations of paid
        // capacity, which the row sync would then faithfully record.
        //
        // That is strictly worse than the ordinary stale-payload bug this
        // codebase already tolerates: before this function existed a stale
        // payload corrupted only ROWS, and the next event repaired them. This
        // one corrupts STRIPE, which is authoritative, and nothing repairs it.
        // Every sibling that mutates a subscription re-reads first for the same
        // reason (syncGroupQuantity, setExtraOrgs, setExtraSeats); this is the
        // mismatch branch only, which is rare and already spending a round trip.
        live = await getStripe().subscriptionItems.retrieve(item.id);
        // PUBLISH IT IMMEDIATELY, at the read rather than at each exit. From
        // here on this loop has four ways out — already converged, quantity
        // gone to zero, the update succeeded, the update was rejected — and
        // EVERY one of them must leave the row sync looking at what Stripe
        // actually holds, not at this event's snapshot. Doing it per-exit made
        // that a rule each future exit has to remember, and two of the four
        // had already forgotten: a stale payload then wrote the OLD quantity
        // into org_addons, handing out capacity nobody is paying for (or
        // withholding capacity that is). Doing it here makes the property
        // STRUCTURAL — an exit added later inherits it by construction.
        //
        // "The next event repairs it" is worth nothing here: convergence fires
        // only on a plan change, and #332's sweep does not exist yet.
        const idx = items.indexOf(item);
        if (idx >= 0) items[idx] = live;
        // Someone got there first — a purchase (setExtraOrgs re-prices AND
        // changes quantity in one go) or an earlier delivery of this same
        // convergence. No Stripe write to make, and the price is now claimed.
        if (live?.price?.id === expectedPriceId) {
          targetClaimed = true;
          continue;
        }
        const qty = live?.quantity ?? item.quantity ?? 0;
        if (qty <= 0) continue;
        const updated = await getStripe().subscriptionItems.update(item.id, {
          price: expectedPriceId,
          // NOT optional — see the doc comment. Stripe resets quantity to 1 on
          // a price change unless it is restated.
          quantity: qty,
          proration_behavior: "create_prorations",
        });
        targetClaimed = true;
        console.warn(
          `[billing] re-priced extra-org rider ${item.id} (qty ${qty}) from ` +
            `${live?.price?.id ?? item.price?.id} to ${expectedPriceId} for plan ${planKey} ` +
            `on subscription ${stripeSub.id} (group ${subscriptionId})`,
        );
        // Upgrade the published item from LIVE to POST-UPDATE. The publish at
        // the read already put a truthful item here; this replaces it with the
        // newer truth, which is the only one of the four exits that has one.
        if (updated && idx >= 0) items[idx] = updated;
      } catch (err) {
        // An item that vanished between this event being emitted and being
        // processed is a benign race, not something to page anyone about —
        // there is nothing left to re-price.
        if (isStripeResourceMissing(err)) {
          console.warn(
            `[billing] extra-org rider ${item.id} is gone from subscription ${stripeSub.id} ` +
              `(group ${subscriptionId}) — nothing to re-price`,
          );
          continue;
        }
        console.error(
          `[billing] could not re-price extra-org rider ${item.id} to ${expectedPriceId} ` +
            `(plan ${planKey}, subscription ${stripeSub.id}, group ${subscriptionId}) — ` +
            `the row still reconciles, only the rate stays stale`,
          err,
        );
        await maybeAlertOrgRepriceFailed({
          subscriptionId,
          stripeSubscriptionId: stripeSub.id,
          planKey,
          itemId: item.id,
          // What Stripe HOLDS, not what the event said — this is the field a
          // responder acts on, and the payload's may be superseded.
          currentPriceId: live?.price?.id ?? item.price?.id ?? null,
          expectedPriceId,
          reason: `Stripe rejected the item update: ${errText(err)}`,
        });
      }
    }
  } catch (err) {
    // Almost always resolveOrgAddonPriceId's 503: `stripe:sync` has not been
    // run for this account, so the catalog cannot name a price to move to.
    console.error(
      `[billing] could not resolve the extra-org rider price for group ${subscriptionId} ` +
        `(subscription ${stripeSub.id}) — rows still reconcile, rates stay stale`,
      err,
    );
    await maybeAlertOrgRepriceFailed({
      subscriptionId,
      stripeSubscriptionId: stripeSub.id,
      // Real whenever the plan read got that far — which is the 503 case, i.e.
      // nearly always. "unknown" survives only if the read itself threw.
      planKey,
      itemId: null,
      currentPriceId: null,
      expectedPriceId: null,
      reason: `could not resolve the rider price for this group's plan: ${errText(err)}`,
    });
  }
}

/** Stripe's "you asked for something that isn't there" code, read defensively —
 *  the error may be a StripeError, a plain Error, or anything a mock threw. */
function isStripeResourceMissing(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "resource_missing"
  );
}

/** A short, safe rendering of an unknown throw for an OPS-ONLY alert body.
 *  Never rendered to a customer — this file's alerts are staff email. */
function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Best-effort staff alert (v17 gap #293, Task 4b): a billing group's
 * extra-organisation rider is stuck on a price that is NOT its plan's rate.
 *
 * NEVER THROWS, and gated on STAFF_ALERT_EMAIL before anything else — the same
 * discipline as maybeAlertOrgAllowance (extra-orgs.ts), which this deliberately
 * mirrors. It sits on the webhook's failure path, so an alert that threw would
 * turn "the rate is stale" into "the whole webhook fails and retries for ever",
 * i.e. the telemetry would become a strictly worse outcome than the fault it
 * reports. Awaited rather than fire-and-forget: this path is rare, a webhook has
 * no user waiting on it, and a floating promise cannot be tested honestly.
 *
 * Exported so the never-throws contract can be tested DIRECTLY rather than
 * through the caller's own catch, which would hide a missing wrapper.
 */
export async function maybeAlertOrgRepriceFailed(opts: {
  subscriptionId: string;
  stripeSubscriptionId: string;
  planKey: string;
  itemId: string | null;
  currentPriceId: string | null;
  expectedPriceId: string | null;
  reason: string;
}): Promise<void> {
  try {
    const alertTo = process.env.STAFF_ALERT_EMAIL;
    if (!alertTo) return;
    await sendExtraOrgRepriceFailedAlertEmail({ to: alertTo, ...opts });
  } catch (err) {
    console.error(
      `[billing] extra-org re-price alert failed (group ${opts.subscriptionId})`,
      err,
    );
  }
}

/**
 * Reflect a subscription's extra-ORGANISATION items into org_addons (v17 gap
 * #293; design/v17-pricing-entitlements SPEC-2 §3, §11.3). The ROUTE
 * (setExtraOrgs) mutates Stripe; THIS is the SINGLE writer of the resulting
 * rows, so Stripe and the DB can never diverge — the same contract as
 * syncSeatAddonsForSubscription, deliberately kept as a SIBLING of it rather
 * than folded into one shared function:
 *
 *  - A seat is PER-ORG. It resolves a `target_org_id` out of item metadata and
 *    refuses the item without one, because a seat lifts exactly one club's
 *    members.max.
 *  - An extra org is GROUP-WIDE. `orgs.max_owned` is a property of the whole
 *    billing group (every member org resolves the same cap), so `target_org_id`
 *    is ALWAYS null and there is no metadata to resolve — which is also what
 *    keeps the two families apart at the filter: `isSeatAddonItem` requires
 *    `metadata.target_org_id`, which an org-addon item never carries.
 *
 * Sharing one function would mean either dropping the seat's target_org_id
 * guard-rail or growing a mode flag through the seat path for no gain; the
 * codebase already prefers siblings here (grantSizePackAddon sits beside the
 * seat sync for the same reason).
 *
 * `feature_key`/`delta_each` are PINNED from the catalog
 * (ORG_ADDON_FEATURE_KEY/ORG_ADDON_DELTA_EACH), never trusted from item
 * metadata: a divergent metadata key would write the row on an arbitrary cap
 * that the orgs.max_owned-scoped reconcile below never cancels — a stuck lift.
 *
 * UPSERT keyed on `stripe_item_id` — V324's partial unique index IS the
 * idempotency (feature-key agnostic, so it serves seats and org add-ons alike),
 * and a redelivered event therefore neither duplicates a row nor double-counts
 * the cap. Any active org-addon row for this GROUP whose item Stripe no longer
 * reports is FLIPPED to status='canceled' (freeze-not-delete, V323/V324) —
 * never deleted, never written with qty=0 (the V324 CHECK forbids it).
 */
export async function syncOrgAddonsForSubscription(
  stripeSub: Stripe.Subscription,
  subscriptionId: string,
): Promise<void> {
  const orgItems = (stripeSub.items?.data ?? []).filter(isOrgAddonItem);
  const seenItemIds: string[] = [];
  for (const item of orgItems) {
    const qty = item.quantity ?? 0;
    if (qty <= 0) {
      // A quantity-0 item is a removal in disguise: never write qty=0 (the
      // V324 CHECK forbids it), flip any existing row to canceled instead.
      await sql`
        update org_addons set status = 'canceled'
         where stripe_item_id = ${item.id} and status <> 'canceled'`;
      continue;
    }
    // `subscriptionId` IS the wallet id here: it is the resolved billing group,
    // and every member org's wallet (coalesce(subscription_id, org_id)) already
    // resolves to exactly it. No walletIdFor() lookup, unlike the per-org seat
    // write — there is no single target org to resolve one through.
    await sql`
      insert into org_addons
        (wallet_id, target_org_id, target_competition_id, feature_key, delta_each, qty,
         stripe_item_id, status)
      values (${subscriptionId}, null, null, ${ORG_ADDON_FEATURE_KEY}, ${ORG_ADDON_DELTA_EACH},
              ${qty}, ${item.id}, 'active')
      on conflict (stripe_item_id) where stripe_item_id is not null
      do update set qty = excluded.qty, status = 'active',
        wallet_id = excluded.wallet_id, target_org_id = excluded.target_org_id,
        feature_key = excluded.feature_key, delta_each = excluded.delta_each`;
    seenItemIds.push(item.id);
  }

  // Reconcile removals: an active Stripe-origin org-addon row (non-null
  // stripe_item_id) for THIS group whose item Stripe no longer reports is gone.
  // Scoped to ORG_ADDON_FEATURE_KEY so a seat or size-pack row on the same
  // wallet is never swept here, and to `stripe_item_id is not null` so an
  // ADMIN-granted comp of the same cap (SPEC-3, status='granted', null item id)
  // survives a purchased add-on's cancellation.
  if (seenItemIds.length === 0) {
    await sql`
      update org_addons set status = 'canceled'
       where wallet_id = ${subscriptionId} and feature_key = ${ORG_ADDON_FEATURE_KEY}
         and stripe_item_id is not null and status = 'active'`;
  } else {
    await sql`
      update org_addons set status = 'canceled'
       where wallet_id = ${subscriptionId} and feature_key = ${ORG_ADDON_FEATURE_KEY}
         and stripe_item_id is not null and status = 'active'
         and stripe_item_id not in ${sql(seenItemIds)}`;
  }
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
        -- Paid slots die with the subscription: a re-buy starts from the real
        -- org count, never from what the dead subscription had been billed for.
        quantity_paid = 1,
        status_changed_at = case when status is distinct from 'canceled'
                                 then now() else status_changed_at end
    where id = ${subscriptionId}`;
  // The plan is only ONE of the two axes the resolver adds up (v17 gap #293,
  // acceptance item 4). Recurring add-ons sit on TOP of the plan base, and
  // nothing here was cancelling them: syncOrgAddonsForSubscription runs only on
  // `customer.subscription.updated`, and a DELETED subscription still reports
  // its items, so its reconcile sweep never sees an empty list and never fires.
  // A churned group therefore kept `community base 1 + N` orgs.max_owned for
  // ever and unpaid — buy the rider, create org #11, cancel the subscription,
  // keep the capacity. That is V314:244-245's "silent reseller", and it is a
  // strictly bigger hole than the self-serve reduction setExtraOrgs guards,
  // which churn bypasses entirely.
  //
  // Scoped exactly like that sweep: this feature key only, and
  // `stripe_item_id is not null`, so an ADMIN-granted comp of the same cap
  // (SPEC-3, status='granted', null item id) and every seat / size-pack row on
  // the same wallet survive. FROZEN, never deleted (V323/V324) — the qty stays
  // for history and for a re-buy.
  //
  // Seats have the same hole (`members.max` add-ons also outlive a cancel).
  // That is INHERITED, not introduced here, and is tracked as issue #330.
  //
  // The reason recorded here previously — "closing it means deciding what a
  // re-buy inherits" — was WRONG, and is corrected rather than deleted so the
  // fix is never weighed against a cost that does not exist. `quantity_paid`
  // above is the PLAN item's quantity (how many organisations the group bills
  // for, maintained by syncGroupQuantity); it has nothing to do with the
  // `members.max` rows in org_addons, so resetting it decides nothing about
  // seats. And syncSeatAddonsForSubscription is cancel-what-I-do-not-see, so a
  // stale seat row is swept by the first `subscription.updated` after a re-buy
  // in any case.
  //
  // What actually keeps it out is SCOPE: this change is #293's extra-org
  // rider, the seat family has its own sweep and its own issue, and widening a
  // cancel across add-on families is not something to do in passing.
  await sql`
    update org_addons set status = 'canceled'
     where wallet_id = ${subscriptionId} and feature_key = ${ORG_ADDON_FEATURE_KEY}
       and stripe_item_id is not null and status = 'active'`;
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
 * Seats this invoice was actually cut for.
 *
 * The subscription item can have moved on by the time we handle the event —
 * `sweepStuckEvents` replays ten minutes late by design, and a detach in between
 * lowers it — so the invoice line is the only truthful record of what the period
 * was billed at. Undefined when the line carries no quantity, which the caller
 * treats as "fall back to what the item held before we touched it".
 */
function invoicedSeats(invoice: Stripe.Invoice): number | undefined {
  const q = invoice.lines?.data?.[0]?.quantity;
  return typeof q === "number" ? q : undefined;
}

/**
 * Renewal: the one moment `quantity_paid` may come back DOWN.
 *
 * "A removed org frees a paid slot you can reuse at no charge until the period
 * ends" only keeps its promise if the paid-for count is eventually released, and
 * only a renewal may release it: Stripe has just cut an invoice from the
 * subscription item, so last period's slots are spent and what the item holds is
 * by definition what has now been paid for.
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
  const [row] = await sql<{ id: string }[]>`
    select id from subscriptions where stripe_subscription_id = ${subId}`;
  if (!row) return;
  // The whole true-up, including the quantity_paid write, is syncGroupQuantity's
  // job under its lock. This must NOT set quantity_paid = count(*) itself: doing
  // that and then failing the Stripe call left the item wrong while the ledger
  // said it agreed, which is exactly the predicate reconcileGroupQuantities
  // selects on — so the drift became permanently invisible and every later
  // renewal re-billed the wrong seat count and re-armed the equality.
  //
  // `renewal: true` is what allows quantity_paid to come DOWN here: the cycle
  // invoice has just been cut from the item, so last period's paid-for slots are
  // spent. Best-effort — a webhook must still ACK — and a failure now leaves the
  // two disagreeing, which is what keeps the sweep able to see it.
  try {
    await syncGroupQuantity(row.id, { renewal: true, invoicedQuantity: invoicedSeats(invoice) });
  } catch (err) {
    console.error(`[billing] renewal quantity sync failed for group ${row.id}`, err);
  }
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
 *  included — revokes the pass and emails the org owner. The org, competition
 *  and RUNG are read BEFORE the revoke deletes the row; the email is
 *  fire-and-forget so a Resend hiccup never blocks the webhook ACK.
 *
 *  The read is no longer gated on `charge.refunded` (v17 #294). A PARTIAL refund
 *  leaves the pass row alone but still runs `reversePassCreditOnRefund` below,
 *  and that path's staff alert has to name the rung too — which is only knowable
 *  here, from the row, before it can be deleted. One extra indexed lookup by
 *  payment intent on partial refunds; the buyer email is still gated on
 *  `revoked`, so nothing customer-visible changes. */
async function revokePassForRefundedChargeAndNotify(charge: Stripe.Charge): Promise<void> {
  const intent =
    typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
  const [ctx] = intent
    ? await sql<{ org_id: string; org_name: string; comp_name: string; pass_key: string }[]>`
        select p.org_id, o.name as org_name, c.name as comp_name, p.pass_key
        from competition_passes p
        join organizations o on o.id = p.org_id
        join competitions   c on c.id = p.competition_id
        where p.stripe_payment_intent = ${intent}`
    : [];
  // isPassKey, not a cast: the column is `not null default 'event_pass'`, so a
  // row written before #294 is genuinely M, and a rung this build predates must
  // still produce a real label rather than a missing dictionary key.
  const passKey: PassKey | null = ctx
    ? isPassKey(ctx.pass_key)
      ? ctx.pass_key
      : "event_pass"
    : null;
  const revoked = await revokePassForRefundedCharge(charge);
  // Unconditional — not gated on `revoked`: a partial refund leaves the pass
  // row in place (revokePassForRefundedCharge only deletes on a full refund),
  // but the credit reversal question is about the CHARGE's refund state, not
  // the pass row's survival. `intent` is only undefined for a charge with no
  // payment_intent, which could never have a redemption row to reverse.
  if (intent) await reversePassCreditOnRefund(intent, passKey);
  if (!revoked || !ctx || !passKey) return;
  const to = await orgOwnerEmail(ctx.org_id);
  if (!to) return;
  void sendPassRevokedEmail({
    to,
    orgName: ctx.org_name,
    competitionName: ctx.comp_name,
    passKey,
  }).catch(() => {});
}

/** AI credit-pack refund (v17 SPEC-2 §5, Phase 3 Task 4): a refunded pack
 *  charge claws back only the customer's UNSPENT pack credits (`recordPackRefund`
 *  — under the wallet advisory lock, capped at the purchase, never below zero,
 *  never touching the resetting `grant` bucket, idempotent on replay).
 *
 *  A pack charge is identified by matching the charge's `payment_intent`
 *  against the stored `pack_purchase` ledger row — NOT off `charge.metadata`.
 *  Stripe does NOT copy `payment_intent_data.metadata` onto the Charge object
 *  (Charge metadata and PaymentIntent metadata are distinct fields), so
 *  `charge.metadata` is `{}` for these Checkout-created pack charges; reading it
 *  as the gate would return early on EVERY real pack refund. Instead this
 *  mirrors the sibling refund handlers (`revokePassForRefundedCharge`,
 *  registration/sponsor): match `charge.payment_intent` to a DB row.
 *  `recordPackRefund` does exactly that — a `matched === true` result proves a
 *  `pack_purchase` row exists for this PI, i.e. it WAS a pack, with no metadata
 *  and no Stripe round-trip on the common path.
 *
 *  When `recordPackRefund` returns `matched === false` the charge is EITHER a
 *  non-pack charge (registration/sponsor/pass — the common case, silent no-op)
 *  OR a pack that was paid but never granted then refunded (the T1
 *  paid-but-ungranted class — must alert). These can only be told apart off the
 *  PaymentIntent's metadata (which Part A DOES stamp), so we distinguish with a
 *  guarded PaymentIntent retrieve — only when `STRIPE_SECRET_KEY` is set, done
 *  OUTSIDE any tx (mirroring the dispute path's charge retrieve): if
 *  `pi.metadata.kind === 'credit_pack'` it was an ungranted pack → log + a
 *  best-effort staff alert; otherwise a genuine non-pack charge → silent. */
async function handlePackChargeRefunded(charge: Stripe.Charge): Promise<void> {
  if (!charge.refunded) return;
  const intent =
    typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
  if (!intent) return; // no intent to match a pack_purchase row against

  const { matched } = await recordPackRefund(intent);
  if (matched) return; // it was a pack and recordPackRefund already clawed back.

  // matched === false: `recordPackRefund`'s cheap indexed `pack_purchase`
  // lookup found no row (no wallet lock taken). Distinguish an ungranted pack
  // from a genuine non-pack charge off the PaymentIntent metadata — a guarded
  // retrieve, keyless envs skip it (a plain non-pack refund no-ops silently).
  if (!process.env.STRIPE_SECRET_KEY) return;
  let pi: Stripe.PaymentIntent;
  try {
    pi = await getStripe().paymentIntents.retrieve(intent);
  } catch {
    return; // a retrieve failure must never block the webhook ACK
  }
  if (pi.metadata?.kind !== "credit_pack") return; // a genuine non-pack charge.

  console.error(
    `[billing] credit_pack charge ${charge.id} (intent ${intent}) refunded but no ` +
      `pack_purchase ledger row found — nothing to claw back (was it ever granted?)`,
  );
  const alertTo = process.env.STAFF_ALERT_EMAIL;
  if (alertTo) {
    void sendCreditPackGrantFailedAlertEmail({
      to: alertTo,
      sessionId: charge.id,
      orgId: pi.metadata?.org_id ?? "unknown",
      packKey: pi.metadata?.pack_key,
      reason: "refunded pack charge has no pack_purchase ledger row to claw back",
    }).catch(() => {});
  }
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
  kind: StaffDisputeAlertArgs["kind"],
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

  // Pass charge? Matched by payment intent — works keyless. `pass_key` comes
  // along so the staff alert names the RUNG that was actually bought (v17 #294):
  // a disputed $59 Event Pass L labelled "Event Pass" sends whoever triages it
  // hunting for a $29 charge that never existed.
  if (intent) {
    const [pass] = await sql<{ org_id: string; pass_key: string }[]>`
      select org_id, pass_key from competition_passes where stripe_payment_intent = ${intent}`;
    if (pass) {
      if (phase === "closed" && dispute.status === "lost") {
        // Money-safety: claw back the pass's one-time credit grant (keyed on the
        // same payment intent) BEFORE the delete, so a lost dispute pulls the 25
        // credits like a refund does. Idempotent on `pass_refund:${intent}` — a
        // dispute after a refund (or a redelivered event) won't double-claw, and
        // it reads the immutable `pass_grant` ledger row, not the pass row.
        await recordPassRefund(intent);
        await sql`delete from competition_passes where stripe_payment_intent = ${intent}`;
        await invalidateOrgEntitlements(pass.org_id);
      }
      // isPassKey, not a cast: the column is `not null default 'event_pass'` and
      // a row written before #294 (or by a future rung this build predates) must
      // still produce a valid label rather than a missing i18n key.
      await notifyStaffDispute(
        isPassKey(pass.pass_key) ? pass.pass_key : "event_pass",
        pass.org_id,
        dispute,
        phase,
      );
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
      await handlePackChargeRefunded(event.data.object as Stripe.Charge);
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
  subscription_id?: string | null; // resolved group (#223)
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
 * Best-effort billing GROUP for one event, stamped durably at ingest so
 * attribution does not depend on live Stripe object metadata — which
 * invoice.* events do not carry (Stripe never copies subscription metadata
 * onto an invoice). Reuses the existing resolvers; a throw or a miss returns
 * null, which falls back to org-based attribution. (#223)
 */
async function resolveEventGroup(event: Stripe.Event): Promise<string | null> {
  try {
    const obj = event.data.object;
    if (event.type.startsWith("invoice.")) {
      const subId = invoiceSubId(obj as Stripe.Invoice);
      if (!subId) return null;
      const [g] = await sql<{ id: string }[]>`
        select id from subscriptions where stripe_subscription_id = ${subId}`;
      return g?.id ?? null;
    }
    if (event.type.startsWith("customer.subscription.")) {
      const r = await resolveGroupForStripeSub(obj as Stripe.Subscription);
      return r?.subscriptionId ?? null;
    }
    if (event.type === "checkout.session.completed") {
      const session = obj as Stripe.Checkout.Session;
      return await checkoutGroupId(session, session.metadata?.org_id ?? "");
    }
    return null;
  } catch (err) {
    console.error(`[billing] resolveEventGroup failed for ${event.id}`, err);
    return null;
  }
}

/**
 * Record + process one event exactly once, stamping processed_at only after the
 * handler ran (a throw leaves the row in the "received" state for the console).
 * Shared by the signed webhook and the staff replay.
 *
 * #229 P0-2: the claim is atomic. The webhook used to SELECT then INSERT ON
 * CONFLICT DO NOTHING but process unconditionally, so two concurrent deliveries
 * of the same event both ran the handler (a second dunning email/analytics
 * event) while only one wrote the ledger row. Now a single statement either
 * inserts a fresh row (leased now) or takes over a row that is still unprocessed
 * AND whose lease has expired (a crashed attempt); a row already processed, or
 * being processed under a live lease, matches nothing and returns no id. Only
 * the caller that gets an id back runs the handler. Returns whether it did.
 */
export async function runEvent(event: Stripe.Event): Promise<boolean> {
  const orgId =
    (event.data.object as { metadata?: { org_id?: string } }).metadata?.org_id ?? null;
  const groupId = await resolveEventGroup(event);
  const claimed = await sql<{ id: string }[]>`
    insert into billing_events
      (id, type, org_id, subscription_id, payload, processing_started_at)
    values (${event.id}, ${event.type}, ${orgId}, ${groupId},
            ${JSON.stringify(event.data.object)}, now())
    on conflict (id) do update
      set processing_started_at = now()
      where billing_events.processed_at is null
        -- Lease is shorter than the hourly stuck-event sweep, so a crash
        -- mid-handler is recovered, but long enough to cover a slow handler.
        and (billing_events.processing_started_at is null
             or billing_events.processing_started_at < now() - interval '10 minutes')
    returning id`;
  if (claimed.length === 0) return false;
  await processStripeEvent(event);
  await sql`
    update billing_events set processed_at = now() where id = ${event.id}`;
  return true;
}

/** Staff replay: skip events the ledger already saw through; heal a stuck one. */
export async function replayEvent(
  event: Stripe.Event,
): Promise<"processed" | "already_processed"> {
  const [existing] = await sql<{ processed_at: string | null }[]>`
    select processed_at from billing_events where id = ${event.id}`;
  if (existing?.processed_at) return "already_processed";
  // runEvent claims atomically; a live delivery may have taken the lease first.
  return (await runEvent(event)) ? "processed" : "already_processed";
}

/** Ledger rows for a set of live Stripe event ids (the diff read). */
export async function ledgerByIds(ids: string[]): Promise<Map<string, LedgerRow>> {
  if (ids.length === 0) return new Map();
  const rows = await sql<LedgerRow[]>`
    select b.id, b.type, b.org_id, o.name as org_name, b.subscription_id, b.received_at, b.processed_at
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
    select b.id, b.type, b.org_id, o.name as org_name, b.subscription_id, b.received_at, b.processed_at
    from billing_events b
    left join organizations o on o.id = b.org_id
    where b.processed_at is null
      ${excludeIds.length ? sql`and b.id not in ${sql(excludeIds)}` : sql``}
    order by b.received_at desc
    limit ${limit}`;
}
