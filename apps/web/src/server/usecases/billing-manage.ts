import "server-only";
import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { getActiveOrgId, requireUser } from "@/lib/auth";
import {
  syncPaymentMethodFlag,
  syncPaymentMethodFlagFromCards,
  syncSubscription,
} from "@/lib/billing";
import { invalidateEntitlementsForOrgGroup } from "@/lib/entitlements";
import { subscriptionIdForOrg } from "@/lib/billing-group";
import { logStaffAction } from "@/lib/admin";
import {
  buildAddressUpdateParams,
  buildApplyPromoParams,
  buildIntervalChangeParams,
  buildIntervalPreviewParams,
  buildSetupIntentParams,
  discountSummary,
  intervalForPrice,
  invoiceRows,
  needsRenewalResync,
  paymentMethodRows,
  summarizeIntervalPreview,
  taxIdRows,
  type BillingAddressInput,
  type BillingInterval,
  type DiscountSummary,
  type IntervalPreview,
  type InvoiceRow,
  type PaymentMethodRow,
  type TaxIdRow,
  type TaxIdType,
} from "@/lib/billing-manage";
export type { BillingInterval, IntervalPreview };
import { captureServer } from "@/lib/posthog-server";
import { EVENTS } from "@/lib/analytics-events";

/**
 * Server glue for in-app billing management (v3/11) — everything the
 * portal-replacement routes and the billing page share. Pure decisions live in
 * lib/billing-manage; this file owns the Stripe/DB round trips.
 */

interface SubRow {
  plan_key: string;
  status: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_end: string | null;
  trial_end: string | null;
  cancel_at_period_end: boolean;
  currency: string | null;
}

/** The billing GROUP behind an org (V310) — many orgs may share one row. */
async function subRow(orgId: string): Promise<SubRow | null> {
  const [sub] = await sql<SubRow[]>`
    select s.plan_key, s.status, s.stripe_customer_id, s.stripe_subscription_id,
           s.current_period_end, s.trial_end, s.cancel_at_period_end, s.currency
    from subscriptions s
    join organizations o on o.subscription_id = s.id
    where o.id = ${orgId}`;
  return sub ?? null;
}

/**
 * Payer-gated context shared by every manage route. Session auth comes FIRST so
 * an unauthenticated caller (e.g. a developer API key — these routes never read
 * Authorization) gets a clean 401, not a 400 about org state.
 *
 * Gates on `subscriptions.owner_user_id`, NOT on the active org's owner role.
 * Billing belongs to the GROUP: a county association may pay for eight member
 * clubs it is not a member of, and every one of those clubs has its own owner
 * who must not be able to cancel, re-price or re-card somebody else's
 * subscription. After an org ownership transfer the org's owner and the group's
 * payer are different people by design.
 *
 * The deliberate split: Stripe Connect stays gated on the ORG's owner (it is the
 * club's own bank account and KYC), billing gates on the GROUP's owner (it is
 * the payer's card). Neither gate implies the other.
 */
export async function requireBillingOwner(): Promise<{
  orgId: string;
  subscriptionId: string;
}> {
  const user = await requireUser();
  const orgId = await getActiveOrgId();
  if (!orgId) throw new HttpError(400, "No active organization");
  // NOT requireSubscriptionIdForOrg: that raises 500 ("no billing group"),
  // which is right for an internal invariant but wrong here — the org id comes
  // from a COOKIE, so a stale or foreign value is ordinary user-triggerable
  // input and must not page anyone. 400 with the same remedy as a missing
  // cookie: pick an organisation again.
  const subscriptionId = await subscriptionIdForOrg(orgId);
  if (!subscriptionId)
    throw new HttpError(400, "No billing account for the selected organization.");
  const [group] = await sql<{ owner_user_id: string }[]>`
    select owner_user_id from subscriptions where id = ${subscriptionId}`;
  if (!group || group.owner_user_id !== user.id) {
    throw new HttpError(
      403,
      "Only the person who pays for this billing group can manage its subscription.",
    );
  }
  return { orgId, subscriptionId };
}

async function requireCustomer(orgId: string): Promise<{ sub: SubRow; customerId: string }> {
  const sub = await subRow(orgId);
  if (!sub?.stripe_customer_id)
    throw new HttpError(400, "No billing account found. Complete checkout first.");
  return { sub, customerId: sub.stripe_customer_id };
}

/** Best-effort person id for org-scoped billing events (owner, else org). */
async function ownerDistinctId(orgId: string): Promise<string> {
  const [row] = await sql<{ created_by: string | null }[]>`
    select created_by from organizations where id = ${orgId}`;
  return row?.created_by ?? `org:${orgId}`;
}

// ---------------------------------------------------------------------------
// Page data
// ---------------------------------------------------------------------------

export interface BillingOverview {
  paymentMethods: PaymentMethodRow[];
  invoices: InvoiceRow[];
  /** Positive minor units the customer holds as credit (negative Stripe balance). */
  creditMinor: number;
  currency: string;
  interval: BillingInterval | null;
  hasOpenInvoice: boolean;
  /** Billing details (v3/11 follow-up): drive automatic_tax + invoice header. */
  billingName: string | null;
  billingAddress: {
    line1?: string | null;
    line2?: string | null;
    city?: string | null;
    state?: string | null;
    postal_code?: string | null;
    country?: string | null;
  } | null;
  taxIds: TaxIdRow[];
  discount: DiscountSummary | null;
}

/**
 * Live Stripe read for the billing page (no local mirror of payment methods
 * or invoices). Also the lazy renewal self-heal: when the DB mirror looks
 * stale — period end passed without a webhook, or past_due that may have been
 * paid off-site — re-sync from the live subscription first. Best-effort:
 * returns null when the org has no Stripe customer or Stripe is unreachable,
 * and the page hides the manage sections.
 */
export async function getBillingOverview(orgId: string): Promise<BillingOverview | null> {
  const sub = await subRow(orgId);
  if (!sub?.stripe_customer_id) return null;
  const stripe = getStripe();

  try {
    if (needsRenewalResync(sub) && sub.stripe_subscription_id) {
      const live = await stripe.subscriptions.retrieve(sub.stripe_subscription_id);
      await syncSubscription(orgId, live);
      await invalidateEntitlementsForOrgGroup(orgId);
    }

    const customerId = sub.stripe_customer_id;
    const [customer, pms, invoices, stripeSub, taxIds] = await Promise.all([
      stripe.customers.retrieve(customerId),
      stripe.customers.listPaymentMethods(customerId, { type: "card", limit: 10 }),
      stripe.invoices.list({ customer: customerId, limit: 24 }),
      sub.stripe_subscription_id
        ? stripe.subscriptions.retrieve(sub.stripe_subscription_id, {
            // dahlia moved discount.coupon under discount.source.
            expand: ["discounts.source.coupon", "discounts.promotion_code"],
          })
        : Promise.resolve(null),
      stripe.customers.listTaxIds(customerId, { limit: 10 }),
    ]);

    if (customer.deleted) return null;
    const rawDefault = customer.invoice_settings?.default_payment_method;
    const defaultId = typeof rawDefault === "string" ? rawDefault : (rawDefault?.id ?? null);

    // Self-heal the has_payment_method mirror from the card list we ALREADY
    // hold — no extra Stripe call. Orgs that added a card before V304 shipped
    // (the 2026-07-20 reporter included) have the column stuck at its `false`
    // default until some writer touches Stripe for them; their own visit to
    // /settings/billing is that writer, so no backfill is needed. The helper
    // swallows its own write error, so a mirror hiccup can never collapse this
    // whole try into `return null` and blank the billing page.
    await syncPaymentMethodFlagFromCards(orgId, {
      cardCount: pms.data.length,
      hasCustomerDefault: !!defaultId,
    });

    const [plan] = await sql<
      { stripe_price_id_monthly: string | null; stripe_price_id_annual: string | null }[]
    >`
      select stripe_price_id_monthly, stripe_price_id_annual
      from plans where key = ${sub.plan_key}`;
    const priceId = stripeSub?.items.data[0]?.price?.id ?? null;
    const rows = invoiceRows(invoices.data);

    return {
      paymentMethods: paymentMethodRows(pms.data, defaultId),
      invoices: rows,
      creditMinor: Math.max(-(customer.balance ?? 0), 0),
      currency: sub.currency ?? "usd",
      interval: plan ? intervalForPrice(priceId, plan) : null,
      hasOpenInvoice: rows.some((r) => r.isOpen),
      billingName: customer.name ?? null,
      billingAddress: customer.address ?? null,
      taxIds: taxIdRows(taxIds.data),
      discount: discountSummary(stripeSub?.discounts),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Event Pass purchases (v3/07 §3, Task 14)
// ---------------------------------------------------------------------------

export interface PassPurchaseRow {
  competitionId: string;
  competitionName: string;
  /** Slug, so the row can link at the competition the pass covers. */
  competitionSlug: string;
  purchasedIso: string;
  /**
   * Minor units off the Stripe invoice Task 13's `invoice_creation` mints, or
   * null when there is nothing to read — a staff-granted / legacy pass with no
   * payment intent, or a Stripe read that failed. Never a reason to drop the
   * row: the org holds the pass either way.
   */
  amountMinor: number | null;
  currency: string | null;
  hostedInvoiceUrl: string | null;
}

interface PassInvoice {
  amountMinor: number;
  currency: string;
  hostedInvoiceUrl: string | null;
}

/**
 * The Stripe invoice behind one pass payment.
 *
 * `competition_passes` stores no amount and no invoice id (V271 is five
 * columns), so `stripe_payment_intent` is the ONLY correlation key, and
 * invoicePayments.list is Stripe's own intent → invoice index — matching by
 * invoice description would be guessing. Swallows its own failure: an
 * unreachable Stripe costs a row its money columns, never its existence.
 */
async function passInvoiceFor(intent: string): Promise<PassInvoice | null> {
  try {
    const payments = await getStripe().invoicePayments.list({
      payment: { type: "payment_intent", payment_intent: intent },
      limit: 1,
      expand: ["data.invoice"],
    });
    const invoice = payments.data[0]?.invoice;
    if (!invoice || typeof invoice === "string" || invoice.deleted) return null;
    return {
      amountMinor: invoice.total,
      currency: invoice.currency,
      hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Event Pass purchases for the billing page: one row per pass the org holds,
 * named after the competition it covers.
 *
 * Deliberately NOT part of `BillingOverview`. That shape is a live Stripe read
 * that returns null for an org with no Stripe customer or an unreachable
 * Stripe, and the page hides every section hanging off it. Passes are LOCAL
 * rows — a staff-granted pass, or a pass bought by an org whose Stripe read
 * fails right now, must still be listed, or the page hides a competition the
 * org genuinely holds a pass for. So the rows are resolved from the database
 * first and only ENRICHED from Stripe.
 *
 * One Stripe call per pass carrying an intent — bounded by the org's pass
 * count (one pass per competition, and a passed competition can't be deleted),
 * issued in parallel, and each one independently failable.
 */
export async function getPassPurchases(orgId: string): Promise<PassPurchaseRow[]> {
  const rows = await sql<
    {
      competition_id: string;
      name: string;
      slug: string;
      purchased_at: Date | string;
      stripe_payment_intent: string | null;
    }[]
  >`
    select cp.competition_id, c.name, c.slug, cp.purchased_at, cp.stripe_payment_intent
    from competition_passes cp
    join competitions c on c.id = cp.competition_id
    where cp.org_id = ${orgId}
    order by cp.purchased_at desc, c.name`;

  const invoices = await Promise.all(
    rows.map((r) => (r.stripe_payment_intent ? passInvoiceFor(r.stripe_payment_intent) : null)),
  );

  return rows.map((r, i) => ({
    competitionId: r.competition_id,
    competitionName: r.name,
    competitionSlug: r.slug,
    purchasedIso: new Date(r.purchased_at).toISOString(),
    amountMinor: invoices[i]?.amountMinor ?? null,
    currency: invoices[i]?.currency ?? null,
    hostedInvoiceUrl: invoices[i]?.hostedInvoiceUrl ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Payment methods
// ---------------------------------------------------------------------------

export async function createCardSetupIntent(orgId: string): Promise<{ client_secret: string }> {
  const { customerId } = await requireCustomer(orgId);
  const si = await getStripe().setupIntents.create(buildSetupIntentParams(customerId));
  if (!si.client_secret) throw new HttpError(500, "Stripe returned no client secret");
  return { client_secret: si.client_secret };
}

/**
 * Make a card the customer default — either the card a just-confirmed
 * SetupIntent saved, or an already-attached card being promoted. Verifies the
 * object belongs to this org's customer before trusting the client-sent id.
 */
export async function setDefaultPaymentMethod(
  orgId: string,
  args: { setupIntentId?: string; paymentMethodId?: string },
): Promise<{ payment_method: string }> {
  const { customerId } = await requireCustomer(orgId);
  const stripe = getStripe();

  let pmId: string;
  if (args.setupIntentId) {
    const si = await stripe.setupIntents.retrieve(args.setupIntentId);
    if (si.customer !== customerId || si.status !== "succeeded")
      throw new HttpError(400, "Card setup was not completed.");
    pmId = typeof si.payment_method === "string" ? si.payment_method : (si.payment_method?.id ?? "");
  } else if (args.paymentMethodId) {
    const pm = await stripe.paymentMethods.retrieve(args.paymentMethodId);
    if (pm.customer !== customerId)
      throw new HttpError(400, "That card does not belong to this account.");
    pmId = pm.id;
  } else {
    throw new HttpError(400, "Nothing to set as default.");
  }
  if (!pmId) throw new HttpError(400, "No payment method on the setup.");

  await stripe.customers.update(customerId, {
    invoice_settings: { default_payment_method: pmId },
  });
  // The in-app add-card path the user actually hits during a trial. Stripe now
  // knows; mirror it locally or the trial banner keeps asking for a card the
  // org has just given (report 2026-07-20).
  await syncPaymentMethodFlag(orgId);
  if (args.setupIntentId) {
    await captureServer({
      event: EVENTS.BILLING_CARD_ADDED,
      distinctId: await ownerDistinctId(orgId),
      orgId,
    });
  }
  return { payment_method: pmId };
}

export async function removePaymentMethod(orgId: string, paymentMethodId: string): Promise<void> {
  const { customerId } = await requireCustomer(orgId);
  const stripe = getStripe();
  const [pm, customer] = await Promise.all([
    stripe.paymentMethods.retrieve(paymentMethodId),
    stripe.customers.retrieve(customerId),
  ]);
  if (pm.customer !== customerId)
    throw new HttpError(400, "That card does not belong to this account.");
  if (!customer.deleted) {
    const rawDefault = customer.invoice_settings?.default_payment_method;
    const defaultId = typeof rawDefault === "string" ? rawDefault : rawDefault?.id;
    if (defaultId === paymentMethodId)
      throw new HttpError(400, "Make another card the default before removing this one.");
  }
  await stripe.paymentMethods.detach(paymentMethodId);
  // Re-reads Stripe rather than assuming: other cards may remain, in which case
  // the flag stays true.
  await syncPaymentMethodFlag(orgId);
}

/**
 * Staff-only removal of an org's card, INCLUDING the default (Task 6C). The
 * customer-facing removePaymentMethod above refuses the default on purpose —
 * cutting an org's last card silently breaks billing (next invoice fails, or
 * a trialing sub with missing_payment_method: "cancel" loses the subscription
 * at trial end) — but staff sometimes need exactly that (erasure requests,
 * fraud cleanup, a card that must never be charged again). This is the
 * deliberate, audited exception; it does not touch removePaymentMethod's
 * guard.
 */
export async function staffRemovePaymentMethod(
  actorId: string,
  orgId: string,
  paymentMethodId: string,
  reason: string,
): Promise<void> {
  if (!reason.trim()) throw new HttpError(400, "A reason is required.");
  const { customerId } = await requireCustomer(orgId);
  const stripe = getStripe();
  const pm = await stripe.paymentMethods.retrieve(paymentMethodId);
  if (pm.customer !== customerId)
    throw new HttpError(400, "That card does not belong to this account.");
  await stripe.paymentMethods.detach(paymentMethodId);
  // The fifth writer of the has_payment_method mirror (Task 4C's enumerated
  // set in lib/__tests__/billing-payment-method.test.ts) — re-reads Stripe
  // rather than assuming, so this clears the flag exactly when the removed
  // card was the last one and leaves it true when others remain.
  await syncPaymentMethodFlag(orgId);
  await logStaffAction(actorId, "remove_payment_method", "org", orgId, {
    reason,
    card: { brand: pm.card?.brand ?? "card", last4: pm.card?.last4 ?? "····" },
  });
}

// ---------------------------------------------------------------------------
// Interval switch (monthly ↔ annual) + plan switch (Pro ↔ Pro Plus)
// ---------------------------------------------------------------------------

interface IntervalContext {
  customerId: string;
  subscriptionId: string;
  itemId: string;
  priceId: string;
  trialing: boolean;
  currency: string;
  /** The plan key being switched TO — same as the current plan for a plain
   *  interval switch, the target plan for a Pro ↔ Pro Plus change. Drives the
   *  renewalAmountMinor price-point lookup below. */
  planKey: string;
  trialEnd: string | null;
}

/**
 * Shared resolver behind both the interval switch and the Pro ↔ Pro Plus plan
 * switch: looks up the target plan+interval's Stripe price id, retrieves the
 * live subscription's single item, and refuses when that item is already on
 * the requested price. `resolveIntervalChange` below is a thin wrapper that
 * keeps the same plan key (existing endpoints stay untouched).
 */
async function resolvePriceChange(
  orgId: string,
  planKey: string,
  interval: BillingInterval,
  // Interval-only switches keep their existing "already billed X" wording;
  // a genuine plan change (this planKey may differ from the caller's own
  // current plan) says "Already on this plan" instead. Both routes can hit
  // this same refusal (item.price.id === priceId) so the caller picks the
  // message rather than us guessing from planKey === sub.plan_key (which is
  // also true for a plain interval switch, by construction).
  alreadyMessage = "Already on this plan",
): Promise<IntervalContext> {
  const { sub, customerId } = await requireCustomer(orgId);
  if (!sub.stripe_subscription_id)
    throw new HttpError(400, "This organization has no Stripe subscription.");
  if (sub.status === "past_due")
    throw new HttpError(400, "Fix the failed payment before changing the plan.");

  const [plan] = await sql<
    { stripe_price_id_monthly: string | null; stripe_price_id_annual: string | null }[]
  >`
    select stripe_price_id_monthly, stripe_price_id_annual
    from plans where key = ${planKey}`;
  const priceId =
    interval === "annual" ? plan?.stripe_price_id_annual : plan?.stripe_price_id_monthly;
  if (!priceId)
    throw new HttpError(503, "Billing is not yet configured. Please contact support.");

  const stripeSub = await getStripe().subscriptions.retrieve(sub.stripe_subscription_id);
  const item = stripeSub.items.data[0];
  if (!item) throw new HttpError(500, "Subscription has no items.");
  if (item.price.id === priceId) throw new HttpError(400, alreadyMessage);

  return {
    customerId,
    subscriptionId: sub.stripe_subscription_id,
    itemId: item.id,
    priceId,
    trialing: stripeSub.status === "trialing",
    currency: sub.currency ?? stripeSub.currency ?? "usd",
    planKey,
    trialEnd: sub.trial_end,
  };
}

async function resolveIntervalChange(
  orgId: string,
  target: BillingInterval,
): Promise<IntervalContext> {
  const { sub } = await requireCustomer(orgId);
  return resolvePriceChange(
    orgId,
    sub.plan_key,
    target,
    `You are already billed ${target === "annual" ? "yearly" : "monthly"}.`,
  );
}

/**
 * What the NEXT full invoice will come to, asked of Stripe instead of computed.
 *
 * This used to be `proPrice(interval, currency)` — one flat price point. Prices
 * are `tiers_mode: graduated` now, so a group of three orgs renews at
 * $19 + 2 x $9 = $37 while the flat lookup still said $19: the confirm dialog
 * quoted a number Stripe would never charge. Multiplying the tiers out here
 * would just move the arithmetic into our code where it can drift from
 * Stripe's; `preview_mode: "recurring"` returns the recurring invoice for the
 * NEW configuration, tiers, quantity, discounts and tax included, so the quote
 * is Stripe's own.
 *
 * No proration_date: this preview is deliberately not the proration invoice
 * (that is the `dueTodayMinor` call), it is the steady-state one. Returns null
 * rather than throwing — a failed quote hides one line of the dialog; it must
 * not break the whole preview.
 */
async function renewalAmountMinorFor(ctx: IntervalContext): Promise<number | null> {
  try {
    const invoice = await getStripe().invoices.createPreview({
      customer: ctx.customerId,
      subscription: ctx.subscriptionId,
      subscription_details: { items: [{ id: ctx.itemId, price: ctx.priceId }] },
      preview_mode: "recurring",
    });
    return invoice.total;
  } catch {
    return null;
  }
}

export async function previewIntervalChange(
  orgId: string,
  target: BillingInterval,
): Promise<IntervalPreview> {
  const ctx = await resolveIntervalChange(orgId, target);
  const prorationDate = Math.floor(Date.now() / 1000);
  const renewalAmountMinor = await renewalAmountMinorFor(ctx);

  // Trialing: nothing has been paid, nothing is due today — the first charge
  // is the plain new price at trial end. No PRORATION call needed (the
  // recurring quote above is still asked for, since a trialing group of three
  // must not be told it will renew at the one-org price).
  if (ctx.trialing) {
    return {
      interval: target,
      trialing: true,
      dueTodayMinor: 0,
      creditMinor: 0,
      currency: ctx.currency,
      newPeriodEnd: ctx.trialEnd,
      renewalAmountMinor,
      prorationDate,
    };
  }

  const invoice = await getStripe().invoices.createPreview(
    buildIntervalPreviewParams({ ...ctx, prorationDate }),
  );
  const s = summarizeIntervalPreview(invoice);
  return {
    interval: target,
    trialing: false,
    dueTodayMinor: s.dueTodayMinor,
    creditMinor: s.creditMinor,
    currency: s.currency,
    newPeriodEnd: s.newPeriodEnd,
    renewalAmountMinor,
    prorationDate,
  };
}

export interface IntervalChangeResult {
  requires_action: boolean;
  client_secret?: string;
}

export async function applyIntervalChange(
  orgId: string,
  target: BillingInterval,
  prorationDate: number,
): Promise<IntervalChangeResult> {
  const ctx = await resolveIntervalChange(orgId, target);
  const stripe = getStripe();

  let updated: Stripe.Subscription;
  try {
    updated = await stripe.subscriptions.update(
      ctx.subscriptionId,
      buildIntervalChangeParams({ ...ctx, prorationDate }),
    );
  } catch (err) {
    // A pinned proration_date outside the current period means a renewal (or
    // another change) raced the preview — the numbers we showed are stale.
    if ((err as Stripe.errors.StripeError)?.type === "StripeInvalidRequestError")
      throw new HttpError(400, "The preview expired — please review the change again.");
    throw err;
  }

  await syncSubscription(orgId, updated);
  await invalidateEntitlementsForOrgGroup(orgId);
  await captureServer({
    event: EVENTS.BILLING_INTERVAL_CHANGED,
    distinctId: await ownerDistinctId(orgId),
    orgId,
    properties: { interval: target },
  });

  const invoice = updated.latest_invoice;
  if (
    invoice &&
    typeof invoice !== "string" &&
    invoice.status === "open" &&
    invoice.confirmation_secret?.client_secret
  ) {
    return { requires_action: true, client_secret: invoice.confirmation_secret.client_secret };
  }
  return { requires_action: false };
}

// ---------------------------------------------------------------------------
// Plan switch (Pro ↔ Pro Plus)
// ---------------------------------------------------------------------------

export type PlanKey = "pro" | "pro_plus";

export async function previewPlanChange(
  orgId: string,
  planKey: PlanKey,
  interval: BillingInterval,
): Promise<IntervalPreview> {
  const ctx = await resolvePriceChange(orgId, planKey, interval);
  const prorationDate = Math.floor(Date.now() / 1000);
  // Stripe's own arithmetic — see renewalAmountMinorFor. The flat
  // proPrice/proPlusPrice lookup this replaced could not see the graduated
  // per-org tiers and under-quoted every multi-org group.
  const renewalAmountMinor = await renewalAmountMinorFor(ctx);

  // Trialing: nothing has been paid, nothing is due today — the first charge
  // is the plain new price at trial end. No PRORATION call needed.
  if (ctx.trialing) {
    return {
      interval,
      trialing: true,
      dueTodayMinor: 0,
      creditMinor: 0,
      currency: ctx.currency,
      newPeriodEnd: ctx.trialEnd,
      renewalAmountMinor,
      prorationDate,
    };
  }

  const invoice = await getStripe().invoices.createPreview(
    buildIntervalPreviewParams({ ...ctx, prorationDate }),
  );
  const s = summarizeIntervalPreview(invoice);
  return {
    interval,
    trialing: false,
    dueTodayMinor: s.dueTodayMinor,
    creditMinor: s.creditMinor,
    currency: s.currency,
    newPeriodEnd: s.newPeriodEnd,
    renewalAmountMinor,
    prorationDate,
  };
}

export async function applyPlanChange(
  orgId: string,
  planKey: PlanKey,
  interval: BillingInterval,
  prorationDate: number,
): Promise<IntervalChangeResult> {
  const ctx = await resolvePriceChange(orgId, planKey, interval);
  const stripe = getStripe();

  let updated: Stripe.Subscription;
  try {
    updated = await stripe.subscriptions.update(
      ctx.subscriptionId,
      buildIntervalChangeParams({ ...ctx, prorationDate }),
    );
  } catch (err) {
    // A pinned proration_date outside the current period means a renewal (or
    // another change) raced the preview — the numbers we showed are stale.
    if ((err as Stripe.errors.StripeError)?.type === "StripeInvalidRequestError")
      throw new HttpError(400, "The preview expired — please review the change again.");
    throw err;
  }

  await syncSubscription(orgId, updated);
  // Unlike a plain interval switch, plan_key itself changes here — cached
  // entitlements (limits, feature gates) go stale and must be invalidated.
  await invalidateEntitlementsForOrgGroup(orgId);
  await captureServer({
    event: EVENTS.BILLING_PLAN_CHANGED,
    distinctId: await ownerDistinctId(orgId),
    orgId,
    properties: { plan_key: planKey, interval },
  });

  const invoice = updated.latest_invoice;
  if (
    invoice &&
    typeof invoice !== "string" &&
    invoice.status === "open" &&
    invoice.confirmation_secret?.client_secret
  ) {
    return { requires_action: true, client_secret: invoice.confirmation_secret.client_secret };
  }
  return { requires_action: false };
}

// ---------------------------------------------------------------------------
// Cancel / resume + dunning retry
// ---------------------------------------------------------------------------

export async function setCancelAtPeriodEnd(
  orgId: string,
  cancel: boolean,
  reason?: string,
): Promise<{ cancel_at_period_end: boolean }> {
  const { sub } = await requireCustomer(orgId);
  if (!sub.stripe_subscription_id)
    throw new HttpError(
      400,
      "This organization has no Stripe subscription — use Downgrade instead.",
    );

  const updated = await getStripe().subscriptions.update(sub.stripe_subscription_id, {
    cancel_at_period_end: cancel,
  });
  await syncSubscription(orgId, updated);
  await invalidateEntitlementsForOrgGroup(orgId);
  await captureServer({
    event: cancel ? EVENTS.SUBSCRIPTION_CANCEL_SCHEDULED : EVENTS.SUBSCRIPTION_RESUMED,
    distinctId: await ownerDistinctId(orgId),
    orgId,
    properties: cancel && reason ? { reason } : undefined,
  });
  return { cancel_at_period_end: updated.cancel_at_period_end };
}

export interface RetryInvoiceResult {
  paid: boolean;
  requires_action?: boolean;
  client_secret?: string;
}

/** Pay the newest open invoice with the (freshly fixed) default card. */
export async function retryOpenInvoice(orgId: string): Promise<RetryInvoiceResult> {
  const { sub, customerId } = await requireCustomer(orgId);
  const stripe = getStripe();
  const open = await stripe.invoices.list({ customer: customerId, status: "open", limit: 1 });
  const invoice = open.data[0];
  if (!invoice?.id) throw new HttpError(400, "No open invoice to pay.");

  try {
    await stripe.invoices.pay(invoice.id);
  } catch (err) {
    const code = (err as Stripe.errors.StripeError)?.code;
    if (code === "invoice_payment_intent_requires_action") {
      const fresh = await stripe.invoices.retrieve(invoice.id, {
        expand: ["confirmation_secret"],
      });
      if (fresh.confirmation_secret?.client_secret)
        return {
          paid: false,
          requires_action: true,
          client_secret: fresh.confirmation_secret.client_secret,
        };
    }
    const message = (err as Error)?.message ?? "Payment failed";
    throw new HttpError(402, message);
  }

  if (sub.stripe_subscription_id) {
    const live = await stripe.subscriptions.retrieve(sub.stripe_subscription_id);
    await syncSubscription(orgId, live);
    await invalidateEntitlementsForOrgGroup(orgId);
  }
  return { paid: true };
}

// ---------------------------------------------------------------------------
// Billing details: address, tax IDs, coupons (v3/11 follow-up)
// ---------------------------------------------------------------------------

/** Update the customer's billing name/address — automatic_tax recalculates
 *  from the new location on every invoice from now on (never retroactive). */
export async function updateBillingAddress(
  orgId: string,
  input: BillingAddressInput,
): Promise<void> {
  const { customerId } = await requireCustomer(orgId);
  await getStripe().customers.update(customerId, buildAddressUpdateParams(input));
}

export async function addTaxId(
  orgId: string,
  type: TaxIdType,
  value: string,
): Promise<TaxIdRow> {
  const { customerId } = await requireCustomer(orgId);
  try {
    const created = await getStripe().customers.createTaxId(customerId, { type, value });
    return taxIdRows([created])[0];
  } catch (err) {
    // Stripe rejects malformed ids with a helpful message — surface it.
    if ((err as Stripe.errors.StripeError)?.type === "StripeInvalidRequestError")
      throw new HttpError(400, (err as Error).message);
    throw err;
  }
}

export async function removeTaxId(orgId: string, taxIdId: string): Promise<void> {
  const { customerId } = await requireCustomer(orgId);
  const stripe = getStripe();
  // Only detach ids that actually belong to this org's customer.
  const existing = await stripe.customers.listTaxIds(customerId, { limit: 10 });
  if (!existing.data.some((t) => t.id === taxIdId))
    throw new HttpError(400, "That tax ID does not belong to this account.");
  await stripe.customers.deleteTaxId(customerId, taxIdId);
}

/** Validate a customer-facing promotion code and apply it to the live
 *  subscription — the discount lands on every following invoice. */
export async function applyPromoCode(
  orgId: string,
  code: string,
): Promise<DiscountSummary | null> {
  const { sub } = await requireCustomer(orgId);
  if (!sub.stripe_subscription_id)
    throw new HttpError(400, "This organization has no Stripe subscription.");
  const stripe = getStripe();

  const found = await stripe.promotionCodes.list({ code, active: true, limit: 1 });
  const promo = found.data[0];
  if (!promo) throw new HttpError(400, "That code isn’t valid or has expired.");

  try {
    const updated = await stripe.subscriptions.update(sub.stripe_subscription_id, {
      ...buildApplyPromoParams(promo.id),
      expand: ["discounts.source.coupon", "discounts.promotion_code"],
    });
    return discountSummary(updated.discounts);
  } catch (err) {
    // Eligibility rules (first-purchase-only, minimum amount, currency…) are
    // enforced by Stripe at apply time — pass the reason through.
    if ((err as Stripe.errors.StripeError)?.type === "StripeInvalidRequestError")
      throw new HttpError(400, (err as Error).message);
    throw err;
  }
}

export async function removePromoCode(orgId: string): Promise<void> {
  const { sub } = await requireCustomer(orgId);
  if (!sub.stripe_subscription_id)
    throw new HttpError(400, "This organization has no Stripe subscription.");
  await getStripe().subscriptions.deleteDiscount(sub.stripe_subscription_id);
}
